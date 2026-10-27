import { captureCodeAnchor, resolveCodeAnchor } from "./ide-code-anchors.mjs";

// Orchestrates annotations without loading the popup or any model until requested.
// Discussions are Argus metadata; source text and Monaco decorations are not edited.
export function createIdeCodeDiscussions({ host, document: doc = host.ownerDocument, api,
  getModelSettings, onOpenTask, onChanged, onError = () => {},
  loadChat = () => import("./ide-code-chat.mjs") }) {
  let repositoryId = null, epoch = 0, loadRevision = 0, controller, popup, loading;
  let discussions = [], surfaces = [], monaco, timer, lastSurface;
  const widgets = [], listeners = [], styledDocuments = new WeakSet();
  const current = (id, revision) => repositoryId === id && epoch === revision;
  const report = error => { if (error?.name !== "AbortError") onError(error); };
  function removeWidgets() {
    for (const { editor, widget } of widgets.splice(0)) editor.removeGlyphMarginWidget(widget);
  }
  function clearSurfaces() {
    clearTimeout(timer); timer = null;
    removeWidgets(); for (const listener of listeners.splice(0)) listener.dispose();
    surfaces = []; lastSurface = null;
  }
  function styleGlyphs(frame) {
    if (styledDocuments.has(frame)) return;
    styledDocuments.add(frame);
    const style = frame.createElement("style");
    style.textContent = ".argus-code-discussion-glyph{display:flex;align-items:center;justify-content:center;width:18px;height:18px;padding:1px;border:1px solid transparent;border-radius:4px;background:var(--vscode-editor-background);color:var(--vscode-textLink-foreground,#68a4e8);cursor:pointer}.argus-code-discussion-glyph:hover{background:var(--vscode-toolbar-hoverBackground,#8883)}.argus-code-discussion-glyph:focus-visible{outline:2px solid var(--vscode-focusBorder,#68a4e8);outline-offset:-2px}.argus-code-discussion-glyph svg{width:14px;height:14px;pointer-events:none}";
    frame.head.append(style);
  }
  function renderMarkers() {
    removeWidgets();
    if (!repositoryId || !monaco) return;
    for (const surface of surfaces) {
      const { editor, model } = surface;
      if (model.isDisposed?.()) continue;
      const state = surface.getState?.() || {}, content = state.content ?? model.getValue();
      const groups = new Map();
      for (const discussion of discussions) {
        const anchor = discussion.anchor;
        if (!anchor || anchor.path !== surface.path || anchor.side !== surface.side || Boolean(anchor.staged) !== Boolean(surface.staged)) continue;
        const location = resolveCodeAnchor(anchor, { ...surface, content });
        if (!location || location.status === "outdated") continue;
        if (!groups.has(location.line)) groups.set(location.line, []);
        groups.get(location.line).push(discussion);
      }
      for (const [line, entries] of groups) {
        const frame = editor.getDomNode?.()?.ownerDocument || model.__document;
        if (!frame) continue;
        styleGlyphs(frame);
        const node = frame.createElement("button"); node.type = "button"; node.className = "argus-code-discussion-glyph";
        node.title = entries.length > 1 ? `${entries.length} code discussions · click to reopen` : "Reopen code discussion";
        node.setAttribute("aria-label", node.title);
        // Fixed decorative SVG only. Never interpolate code, titles, or model text.
        node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h6"/></svg>';
        const id = repositoryId, revision = epoch;
        node.addEventListener("mousedown", event => { event.preventDefault(); event.stopPropagation(); });
        node.addEventListener("click", event => {
          event.preventDefault(); event.stopPropagation();
          if (current(id, revision) && surfaces.includes(surface)) void open({ discussionId: entries[0].id }, surface).catch(report);
        });
        const widget = { getId: () => `argus.code-discussion.${id}.${surface.side}.${line}`,
          getDomNode: () => node,
          getPosition: () => ({ lane: monaco.editor.GlyphMarginLane.Left, zIndex: 25, range: new monaco.Range(line, 1, line, 1) }) };
        editor.addGlyphMarginWidget(widget); widgets.push({ editor, widget });
      }
    }
  }
  function scheduleMarkers() {
    // Hide old anchors immediately while typing. Re-resolve after a pause, never
    // keep an old line-number marker on unrelated code after an edit.
    removeWidgets(); clearTimeout(timer);
    timer = setTimeout(renderMarkers, 300);
  }
  function setSurfaces(next, runtime) {
    clearSurfaces(); surfaces = next; monaco = runtime;
    for (const surface of surfaces) {
      if (surface.model.onDidChangeContent) listeners.push(surface.model.onDidChangeContent(scheduleMarkers));
      if (surface.editor.onDidFocusEditorText) listeners.push(surface.editor.onDidFocusEditorText(() => { lastSurface = surface; }));
    }
    renderMarkers();
  }
  async function refresh() {
    if (!repositoryId) return;
    const id = repositoryId, revision = epoch, request = ++loadRevision;
    controller?.abort(); controller = new AbortController();
    try {
      const data = await api(`/api/repositories/${encodeURIComponent(id)}/code-discussions`, { signal: controller.signal, dedupe: false });
      if (!current(id, revision) || request !== loadRevision) return;
      discussions = Array.isArray(data.discussions) ? data.discussions : [];
      renderMarkers();
    } catch (error) { if (current(id, revision) && request === loadRevision) report(error); }
  }
  function position(surface) {
    const editor = surface?.editor, at = editor?.getPosition?.();
    const editorRect = editor?.getDomNode?.()?.getBoundingClientRect?.(), hostRect = host.getBoundingClientRect?.();
    const frameRect = editor?.getDomNode?.()?.ownerDocument?.defaultView?.frameElement?.getBoundingClientRect?.();
    const point = at && editor?.getScrolledVisiblePosition?.(at);
    if (!point || !editorRect || !hostRect) return undefined;
    return { left: (frameRect?.left || 0) + editorRect.left + point.left - hostRect.left + 22,
      top: (frameRect?.top || 0) + editorRect.top + point.top - hostRect.top + point.height + 8 };
  }
  async function open(options = {}, surface) {
    const id = repositoryId, revision = epoch;
    if (!id) return false;
    loading ||= loadChat().catch(error => { loading = null; throw error; });
    const module = await loading;
    if (!current(id, revision)) return false;
    popup ||= module.createIdeCodeChat({ host, document: doc, api, getModelSettings, onOpenTask,
      onError,
      onChanged: change => {
        if (change.repositoryId === repositoryId) void refresh();
        onChanged?.(change);
      } });
    await popup.open({ repositoryId: id, ...options, position: position(surface) });
    return true;
  }
  function ask(editor) {
    const surface = (editor && surfaces.find(item => item.editor === editor))
      || surfaces.find(item => item.editor.hasTextFocus?.()) || lastSurface || surfaces.at(-1);
    if (!surface) return open();
    const at = surface.editor.getPosition?.() || { lineNumber: 1, column: 1 };
    const range = surface.editor.getSelection?.();
    const state = surface.getState?.() || {};
    const content = state.content ?? surface.model.getValue();
    const anchor = captureCodeAnchor({ path: surface.path, side: surface.side, staged: Boolean(surface.staged),
      content, line: range?.startLineNumber || at.lineNumber,
      column: range?.startColumn || at.column, endLine: range?.endLineNumber, endColumn: range?.endColumn,
      symbol: surface.model.getWordAtPosition?.(at)?.word || "", contentHash: state.contentHash, unsaved: Boolean(state.unsaved) });
    // Reuse an existing matching anchor rather than create a new popup thread for
    // every click. Distinct questions about other locations still share one task.
    const existing = discussions.find(item => {
      if (item.anchor?.selection !== anchor.selection) return false;
      const found = resolveCodeAnchor(item.anchor, { ...surface, content });
      return found && found.status !== "outdated" && found.line === anchor.line && found.column === anchor.column;
    });
    return open({ anchor, ...(existing ? { discussionId: existing.id } : {}) }, surface);
  }
  function deactivate() {
    epoch++; repositoryId = null; controller?.abort(); clearSurfaces(); discussions = []; popup?.deactivate();
  }
  function activate(id) {
    deactivate(); repositoryId = String(id); void refresh();
  }
  return { activate, deactivate, setSurfaces, clearSurfaces, refresh, ask, open: () => open(),
    dispose() { deactivate(); popup?.dispose(); } };
}
