// Anchors are deliberately conservative: an outdated discussion stays in its
// thread instead of acquiring a convincing, but incorrect, gutter location.
const MAX_SELECTION = 8_000;
const MAX_CONTEXT = 800;
const CONTEXT_LINES = 3;
const MAX_CANDIDATES = 1_000;
const SIDES = new Set(["source", "before", "after"]);

function relativePath(value) {
  const path = String(value ?? "").replaceAll("\\", "/");
  if (!path || path.length > 4_096 || path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path)
      || /[\u0000-\u001f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("A code discussion must belong to a repository-relative file.");
  }
  return path;
}

const text = value => String(value ?? "").replaceAll("\r\n", "\n");
const positive = value => Number.isFinite(Number(value)) ? Math.max(1, Math.floor(Number(value))) : 1;
const insidePair = (value, index) => index > 0 && index < value.length
  && value.charCodeAt(index - 1) >= 0xd800 && value.charCodeAt(index - 1) <= 0xdbff
  && value.charCodeAt(index) >= 0xdc00 && value.charCodeAt(index) <= 0xdfff;
const safeStart = (value, index) => insidePair(value, index) ? index - 1 : index;
const safeEnd = (value, index) => insidePair(value, index) ? index + 1 : index;
const bounded = (value, limit) => {
  value = String(value ?? "");
  const end = Math.min(value.length, limit);
  return value.slice(0, insidePair(value, end) ? end - 1 : end);
};

function positionOffset(content, line, column, end = false) {
  let offset = 0, currentLine = 1;
  while (currentLine < positive(line)) {
    const next = content.indexOf("\n", offset);
    if (next < 0) break;
    offset = next + 1;
    currentLine++;
  }
  const next = content.indexOf("\n", offset), lineEnd = next < 0 ? content.length : next;
  const index = Math.min(lineEnd, offset + positive(column) - 1);
  const adjusted = end ? safeEnd(content, index) : safeStart(content, index);
  return { offset: adjusted, line: currentLine, column: adjusted - offset + 1, lineStart: offset, lineEnd };
}

function offsetPosition(content, offset) {
  let start = 0, line = 1;
  for (;;) {
    const next = content.indexOf("\n", start);
    if (next < 0 || next >= offset) break;
    start = next + 1;
    line++;
  }
  return { line, column: offset - start + 1 };
}

function context(content, start, end) {
  let beforeStart = start, afterEnd = end, count = 0;
  while (beforeStart > 0 && start - beforeStart < MAX_CONTEXT) {
    if (content[--beforeStart] === "\n" && ++count > CONTEXT_LINES) { beforeStart++; break; }
  }
  count = 0;
  while (afterEnd < content.length && afterEnd - end < MAX_CONTEXT) {
    if (content[afterEnd++] === "\n" && ++count > CONTEXT_LINES) { afterEnd--; break; }
  }
  // Stay inside the budget without cutting an astral character in half.
  beforeStart = safeEnd(content, beforeStart);
  afterEnd = safeStart(content, afterEnd);
  return { contextBefore: content.slice(beforeStart, start), contextAfter: content.slice(end, afterEnd) };
}

function fingerprint(value) {
  // A small local context fingerprint, NOT a file hash or integrity/security check.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return `context-fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function captureCodeAnchor({ path, side = "source", staged = false, content, line = 1, column = 1, endLine, endColumn, symbol, contentHash, unsaved = false }) {
  path = relativePath(path);
  if (!SIDES.has(side)) throw new Error("Unknown code discussion snapshot side.");
  content = text(content);
  let start = positionOffset(content, line, column);
  let end = positionOffset(content, endLine ?? line, endColumn ?? column, true);
  if (end.offset < start.offset) [start, end] = [end, start];
  if (start.offset === end.offset) {
    // A cursor-only action discusses the line rather than an invisible range.
    start = { ...start, offset: start.lineStart, column: 1 };
    end = { ...end, offset: end.lineEnd, column: end.lineEnd - end.lineStart + 1 };
  }
  const selectedLength = end.offset - start.offset;
  const selection = bounded(content.slice(start.offset, start.offset + Math.min(selectedLength, MAX_SELECTION + 1)), MAX_SELECTION);
  const anchor = {
    version: 1, path, side, staged: side === "source" ? false : Boolean(staged),
    line: start.line, column: start.column, endLine: end.line, endColumn: end.column,
    selection, selectedLength, selectionTruncated: selection.length < selectedLength,
    ...context(content, start.offset, end.offset),
    symbol: bounded(typeof symbol === "object" ? symbol?.name : symbol, 240),
    unsaved: Boolean(unsaved),
  };
  if (typeof contentHash === "string" && contentHash.length <= 256) anchor.contentHash = contentHash;
  anchor.snapshotHash = fingerprint(JSON.stringify(anchor));
  return anchor;
}

const range = (anchor, status) => ({ line: anchor.line, column: anchor.column, endLine: anchor.endLine, endColumn: anchor.endColumn, status });

export function resolveCodeAnchor(anchor, { path, side = "source", staged = false, content } = {}) {
  try { path = relativePath(path); } catch { return null; }
  if (!anchor || anchor.version !== 1 || anchor.path !== path || anchor.side !== side || !SIDES.has(side)
      || Boolean(anchor.staged) !== (side === "source" ? false : Boolean(staged))) return null;
  if (![anchor.line, anchor.column, anchor.endLine, anchor.endColumn].every(value => Number.isInteger(value) && value > 0)
      || typeof anchor.selection !== "string" || anchor.selection.length > MAX_SELECTION
      || typeof anchor.contextBefore !== "string" || anchor.contextBefore.length > MAX_CONTEXT
      || typeof anchor.contextAfter !== "string" || anchor.contextAfter.length > MAX_CONTEXT) return null;
  if (anchor.selectionTruncated || anchor.selectedLength !== anchor.selection.length) return range(anchor, "outdated");
  content = text(content);
  const before = anchor.contextBefore, after = anchor.contextAfter, selection = anchor.selection;
  // Including both surrounding contexts avoids name-based guesses and makes
  // blank-line discussions searchable without iterating every empty substring.
  const needle = before + selection + after;
  if (!needle) return content.length ? range(anchor, "outdated") : range(anchor, "exact");
  let match = -1, matches = 0, offset = 0, candidates = 0;
  while (offset <= content.length) {
    const found = content.indexOf(needle, offset);
    if (found < 0) break;
    if (++candidates > MAX_CANDIDATES) return range(anchor, "outdated");
    const start = found + before.length, end = start + selection.length;
    // Empty context means an actual file boundary, not a wildcard.
    if ((before || start === 0) && (after || end === content.length)) {
      match = start;
      if (++matches > 1) return range(anchor, "outdated");
    }
    offset = found + 1;
  }
  if (matches !== 1) return range(anchor, "outdated");
  const start = offsetPosition(content, match), end = offsetPosition(content, match + selection.length);
  return { line: start.line, column: start.column, endLine: end.line, endColumn: end.column,
    status: start.line === anchor.line && start.column === anchor.column && end.line === anchor.endLine && end.column === anchor.endColumn ? "exact" : "moved" };
}
