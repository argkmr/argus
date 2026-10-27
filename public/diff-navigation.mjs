// Diff coordinates describe Git snapshots, while language servers read saved files.
// Never guess a method by name or send a historical line number to the current file.
import { configurationNavigationSymbols, supportsConfigurationNavigation } from "./code-navigation.mjs";
const identifiers = /[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*/gu;
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const lines = content => String(content).replaceAll("\r\n", "\n").split("\n");

export function renderDiffNavigationCode(text, path = "") {
  text = String(text ?? "");
  let html = "", offset = 0;
  const configuration = supportsConfigurationNavigation(path) ? configurationNavigationSymbols(text, path) : [];
  const symbols = [...configuration, ...Array.from(text.matchAll(identifiers), match => ({
    word: match[0], startColumn: match.index + 1, endColumn: match.index + match[0].length + 1,
  })).filter(symbol => !configuration.some(key => symbol.startColumn < key.endColumn && symbol.endColumn > key.startColumn))]
    .sort((a, b) => a.startColumn - b.startColumn);
  for (const symbol of symbols) {
    html += escape(text.slice(offset, symbol.startColumn - 1));
    html += `<span data-diff-symbol data-column="${symbol.startColumn}">${escape(symbol.word)}</span>`;
    offset = symbol.endColumn - 1;
  }
  return html + escape(text.slice(offset));
}

export function resolveDiffNavigationPosition(context, { side, line, column, word }, workingContent, workingDiff = null) {
  if (!["before", "after"].includes(side) || !Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1 || !word) return null;
  const displayed = side === "before" ? context.beforeContent : context.afterContent;
  if (typeof displayed !== "string" || typeof workingContent !== "string") return null;
  const source = lines(displayed), working = lines(workingContent), text = source[line - 1];
  if (typeof text !== "string" || text.slice(column - 1, column - 1 + word.length) !== word) return null;
  let targetLine, afterLine = side === "after" ? line : null;
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");
  if (same(displayed, workingContent)) targetLine = line;
  else if (side === "before") {
    const row = context.rows?.find(row => row.oldLine === line);
    if (row?.newLine && row.oldText === text && row.newText === text) afterLine = row.newLine;
  }
  if (!targetLine && afterLine) {
    if (same(context.afterContent, workingContent)) targetLine = afterLine;
    else if (same(context.afterContent, workingDiff?.beforeContent) && same(workingContent, workingDiff?.afterContent)) {
      const row = workingDiff.rows?.find(row => row.oldLine === afterLine);
      if (row?.newLine && row.oldText === text && row.newText === text) targetLine = row.newLine;
    }
  }
  return targetLine && working[targetLine - 1] === text ? { path: context.file, line: targetLine, column } : null;
}

export function createDiffNavigation({ dialog, document, getContext, readFile, navigate, reveal, onStatus }) {
  let sequence = 0, controller, lastMouseDown = null;
  const win = document.defaultView;
  const modifier = event => Boolean((event.metaKey || event.ctrlKey) && !event.altKey);
  const target = event => {
    const symbol = event.target?.closest?.("[data-diff-symbol]");
    const code = symbol?.closest?.("[data-diff-line]");
    if (!symbol || !code || !dialog.contains(symbol)) return null;
    return { side: code.dataset.diffSide, line: Number(code.dataset.diffLine), column: Number(symbol.dataset.column), word: symbol.textContent };
  };
  function invalidate() { sequence++; controller?.abort(); controller = null; }
  async function follow(hit) {
    const context = getContext(); if (!context || !hit) return;
    invalidate(); const ticket = sequence; controller = new AbortController();
    const signal = controller.signal;
    const current = () => ticket === sequence && !signal.aborted && getContext() === context;
    onStatus("Finding definition in the saved working file…", "loading");
    try {
      const disk = await readFile(context, signal);
      if (!current()) return;
      if (!disk?.contentHash || typeof disk.content !== "string") throw new Error("This file is not available for language navigation.");
      const position = resolveDiffNavigationPosition(context, hit, disk.content, disk.workingDiff);
      if (!position) {
        onStatus("This older or changed line cannot be mapped safely to the current file. Navigate from the current After version, or reopen the diff.", "warning"); return;
      }
      const result = await navigate(context, { ...position, kind: "definition", expectedHash: disk.contentHash }, signal);
      if (!current()) return;
      if (!result?.locations?.length) { onStatus(result?.notice || "No definition found. Check this repository’s Language tools.", "warning"); return; }
      const shown = await reveal(context, { ...position, expectedHash: disk.contentHash }, result, current);
      if (current() && !shown) onStatus("Navigation was cancelled; your diff and editor drafts are unchanged.", "warning");
    } catch (error) { if (current() && error?.name !== "AbortError") onStatus(error.message || "Definition lookup failed.", "error"); }
  }
  const updateModifier = event => dialog.classList.toggle("diff-definition-modifier", event.type !== "blur" && modifier(event));
  const onMouseDown = event => {
    const hit = modifier(event) && event.button === 0 && target(event); if (!hit || !getContext()) return;
    event.preventDefault(); event.stopPropagation();
    lastMouseDown = { time: Date.now(), x: event.clientX, y: event.clientY };
    void follow(hit);
  };
  const isTrailing = event => lastMouseDown && Date.now() - lastMouseDown.time < 1200
    && event.clientX === lastMouseDown.x && event.clientY === lastMouseDown.y;
  const onClick = event => {
    if (isTrailing(event)) { event.preventDefault(); event.stopPropagation(); return; }
    const hit = modifier(event) && target(event); if (!hit || !getContext()) return;
    event.preventDefault(); event.stopPropagation(); void follow(hit);
  };
  const onContextMenu = event => {
    if (isTrailing(event)) { event.preventDefault(); event.stopPropagation(); return; }
    const hit = event.ctrlKey && !event.altKey && target(event); if (!hit || !getContext()) return;
    event.preventDefault(); event.stopPropagation(); void follow(hit);
  };
  const close = () => { invalidate(); dialog.classList.remove("diff-definition-modifier"); };
  // Focusing Monaco's iframe also blurs its parent window. That is still an
  // in-app focus transfer, not a reason to cancel an in-flight reveal.
  const onWindowBlur = () => {
    dialog.classList.remove("diff-definition-modifier");
    if (!document.hasFocus?.()) invalidate();
  };
  dialog.addEventListener("mousedown", onMouseDown, true);
  dialog.addEventListener("click", onClick, true);
  dialog.addEventListener("contextmenu", onContextMenu, true);
  dialog.addEventListener("mousemove", updateModifier);
  dialog.addEventListener("close", close);
  document.addEventListener("keydown", updateModifier);
  document.addEventListener("keyup", updateModifier);
  win?.addEventListener("blur", onWindowBlur);
  return { invalidate, follow, dispose() {
    close(); dialog.removeEventListener("mousedown", onMouseDown, true); dialog.removeEventListener("click", onClick, true);
    dialog.removeEventListener("contextmenu", onContextMenu, true); dialog.removeEventListener("mousemove", updateModifier); dialog.removeEventListener("close", close);
    document.removeEventListener("keydown", updateModifier); document.removeEventListener("keyup", updateModifier); win?.removeEventListener("blur", onWindowBlur);
  } };
}
