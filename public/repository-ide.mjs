import { createIdeSplitter } from "./ide-splitter.mjs";
import { createIdeIcon } from "./ide-icons.mjs";
import { createIdeFileIcon } from "./ide-file-icons.mjs";
import { compactDirectoryChain } from "./compact-directory-chain.mjs";
import { createDebugConsole, describeDebugSession } from "./repository-ide-debug.mjs";
import { createIdeProcessLogs } from "./ide-process-logs.mjs";
import { createIdeCodeDiscussions } from "./ide-code-discussions.mjs";
import { navigationSymbolAt, supportsConfigurationNavigation } from "./code-navigation.mjs";
import { createIdeSessionStorage } from "./repository-ide-session.mjs";

// The editor is deliberately inert until activate(). All runtime assets stay local.
const MONACO_ROOT = "/legacy/vendor/monaco/vs";
const MAX_MODELS = 8;
const MAX_BUFFERS = 60;
const MAX_BUFFER_BYTES = 24 * 1024 * 1024;
const LANGUAGE_STATUS_INTERVAL = 2000;
const MAX_LANGUAGE_STATUS_POLLS = 150;
const OUTDATED_DIFF_NOTICE = "This diff is out of date. Close this tab and reopen it from Version Control to use its actions.";
const monacoLoads = new WeakMap();
let ideSequence = 0;

export function normalizeIdePath(value) {
  const path = String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || /^[a-z]+:/i.test(path) || path.split("/").some((part) => !part || part === ".." || part === ".") || /[\0\r\n]/.test(path)) throw new Error("Choose a file inside this repository.");
  return path;
}

export function createIdeHistory(limit = 100) {
  let entries = [], index = -1;
  const equal = (a, b) => a?.path === b?.path && a?.line === b?.line && a?.column === b?.column && a?.surface === b?.surface && a?.diffId === b?.diffId;
  return {
    push(location) {
      const next = { path: normalizeIdePath(location.path), line: Math.max(1, Number(location.line) || 1), column: Math.max(1, Number(location.column) || 1) };
      if (location.surface === "diff") { next.surface = "diff"; next.diffId = location.diffId; }
      if (equal(entries[index], next)) return;
      entries = entries.slice(0, index + 1); entries.push(next);
      if (entries.length > limit) entries.shift();
      index = entries.length - 1;
    },
    move(delta) { const next = index + delta; if (next < 0 || next >= entries.length) return null; index = next; return { ...entries[index] }; },
    remove(predicate) { const previous = entries.slice(0, index + 1).filter((entry) => !predicate(entry)); entries = entries.filter((entry) => !predicate(entry)); index = previous.length - 1; },
    get canBack() { return index > 0; },
    get canForward() { return index >= 0 && index < entries.length - 1; },
  };
}

export function createIdeBufferStore({ maxBuffers = MAX_BUFFERS, maxBytes = MAX_BUFFER_BYTES } = {}) {
  const repositories = new Map();
  function all() { return [...repositories.values()].flatMap((repo) => [...repo.buffers.values()]); }
  function repository(id) {
    id = String(id);
    if (!repositories.has(id)) repositories.set(id, { id, buffers: new Map(), active: null, history: createIdeHistory(), breakpoints: new Map() });
    return repositories.get(id);
  }
  function add(id, file) {
    const repo = repository(id), path = normalizeIdePath(file.path);
    if (repo.buffers.has(path)) return repo.buffers.get(path);
    const content = String(file.content ?? "");
    const bytes = () => all().reduce((size, buffer) => size + buffer.content.length * 2, 0);
    while (all().length >= maxBuffers || bytes() + content.length * 2 > maxBytes) {
      const oldest = all().filter((buffer) => !buffer.dirty && !buffer.model).sort((a, b) => a.touched - b.touched)[0];
      if (!oldest) throw new Error("Editor buffer limit reached. Save or close open files before opening another file. Unsaved edits have been preserved.");
      const owner = repository(oldest.repositoryId); owner.buffers.delete(oldest.path); if (owner.active === oldest.path) owner.active = null;
    }
    const buffer = { repositoryId: repo.id, path, content, savedContent: content, hash: file.contentHash, language: file.language || "plaintext", dirty: false, conflict: false, model: null, viewState: null, touched: Date.now() };
    repo.buffers.set(path, buffer); return buffer;
  }
  return {
    repository, add, all,
    edit(buffer, content) { buffer.content = content; buffer.dirty = content !== buffer.savedContent; buffer.touched = Date.now(); },
    saved(buffer, content, hash) { buffer.savedContent = content; buffer.hash = hash; buffer.dirty = buffer.content !== content; buffer.conflict = false; buffer.externallyChanged = false; },
    get dirty() { return all().some((buffer) => buffer.dirty); },
  };
}

// Monaco supplies offsets against the pre-edit document. Apply those small edits
// directly instead of materializing its entire text model for every keystroke.
export function applyIdeContentChanges(content, changes) {
  if (!Array.isArray(changes) || !changes.length) return null;
  const ordered = changes.slice().sort((a, b) => b.rangeOffset - a.rangeOffset);
  let end = content.length, result = content;
  for (const change of ordered) {
    const { rangeOffset: start, rangeLength: length, text } = change;
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 || start + length > end || typeof text !== "string") return null;
    result = result.slice(0, start) + text + result.slice(start + length); end = start;
  }
  return result;
}

async function loadMonaco(doc, signal) {
  const win = doc.defaultView;
  if (signal?.aborted) throw Object.assign(new Error("Editor loading was cancelled."), { name: "AbortError" });
  if (win.monaco?.editor) return win.monaco;
  if (!monacoLoads.has(doc)) monacoLoads.set(doc, new Promise((resolve, reject) => {
    let settled = false, script;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener("abort", abort);
      if (script) { script.onload = null; script.onerror = null; }
      callback(value);
    };
    const fail = (error) => { script?.remove(); finish(reject, error); };
    const abort = () => fail(Object.assign(new Error("Editor loading was cancelled."), { name: "AbortError" }));
    signal?.addEventListener("abort", abort, { once: true });
    const loadEditor = () => {
      if (settled) return;
      if (typeof win.require !== "function" || !win.require.config) { fail(new Error("The local Monaco loader is unavailable.")); return; }
      try {
        win.require.config({ paths: { vs: MONACO_ROOT } });
        win.require(["vs/editor/editor.main"], () => finish(resolve, win.monaco), fail);
      } catch (error) { fail(error); }
    };
    if (typeof win.require === "function" && win.require.config) loadEditor();
    else {
      script = doc.createElement("script"); script.src = `${MONACO_ROOT}/loader.js`; script.async = true;
      script.onload = loadEditor; script.onerror = () => fail(new Error("Could not load the bundled editor. Check the local Monaco installation."));
      doc.head.append(script);
    }
  }).catch((error) => { monacoLoads.delete(doc); throw error; }));
  return monacoLoads.get(doc);
}

const languageId = (language, path = "") => {
  const value = String(language || "").toLowerCase();
  if (value === "typescriptreact" || /\.tsx$/.test(path)) return "typescript";
  if (value === "javascriptreact" || /\.jsx$/.test(path)) return "javascript";
  if (value === "c++" || value === "c") return "cpp";
  return value || "plaintext";
};
const serverLanguage = (language) => language === "javascript" ? "typescript" : language;
const position = (location) => ({ lineNumber: Math.max(1, Number(location.line) || 1), column: Math.max(1, Number(location.column) || 1) });
const navigationLabel = kind => kind === "typeDefinition" ? "type definition" : kind;
const navigationTitle = kind => ({ references: "References", implementation: "Implementations", declaration: "Declarations", typeDefinition: "Type definitions" })[kind] || "Definitions";

export function createRepositoryIde({ host, api, onError = () => {}, onFileSaved = () => {}, onNavigationChange = () => {}, getVersionControlOpen = () => false, onVersionControlToggle, onVersionControlMount, getRunState = () => null, onRunAction, onRunSelect, onRunConfigure, onTerminalToggle, onTerminalHide, onTerminalMount, getCodeChatSettings, onCodeChatOpenTask, onCodeDiscussionChanged, document: doc = host?.ownerDocument || globalThis.document }) {
  if (!host || !doc || typeof api !== "function") throw new Error("The repository editor requires a host, document, and API client.");
  const win = doc.defaultView, instance = ++ideSequence, store = createIdeBufferStore();
  const sessions = createIdeSessionStorage(() => treeStorage());
  let sessionOwner = null, sessionTimer = null;
  let active = false, disposed = false, generation = 0, repo = null, editor = null, monaco = null, status = null;
  let tabSignature = "", breakpointListSignature = "", debugTargetsSignature = "", stackRequest = 0;
  let statusTimer, statusRefresh = null, statusPolls = 0, statusRevision = 0, languageWork = 0, languageCards = [];
  let searchTimer, searchController, searchGeneration = 0, lastShift = 0, debugTimer, debugState = null, eventCursor = 0, debugThread = null, debugFrame = null, debugBusy = false;
  let cleanup = Promise.resolve(), opened = 0, navGeneration = 0, themeObserver, frameDocument, editorLoadController, cursorNavigationTimer;
  let treeSplitter, hoverTarget = null, hoverTimer, hoverController, hoverGeneration = 0, hoverDecorations = [], hoverDefinition = null, hoverChecked = false, lastDefinitionClick = null, definitionNavigation = null;
  let treeRevision = 0, treeReveal = 0, treeLoad = null, diffTab = null, activeDiff = null, diffEditor = null, diffSequence = 0, diffNavigationRevision = 0, debugLocation = null, debugStopRevision = 0, breakpointSequence = 0;
  let terminalState = null, runOptionsSignature = "", versionControlSignature = "", debugLaunch = null;
  let toolTab = "logs", toolOpen = false, toolMaximized = false, toolSplitter, processLogs;
  const treeNodes = new Map(), breakpointStatus = new Map(), breakpointRequests = new Map();
  const controllers = new Set(), workers = new Set(), subscriptions = [], ui = {};
  let codeDiscussions;
  const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, title, action, className = "") => { const node = element("button", className, text); node.type = "button"; node.title = title || text; node.setAttribute("aria-label", title || text); node.addEventListener("click", () => run(action)); return node; };
  const iconButton = (icon, title, action, className = "") => { const node = button("", title, action, `repository-ide-icon-button ${className}`); node.append(createIdeIcon(doc, icon)); return node; };
  const current = () => repo?.buffers.get(repo.active);
  const fileBuffer = (repositoryId, path) => store.all().find(buffer => buffer.repositoryId === String(repositoryId) && buffer.path === normalizeIdePath(path));
  const isFileDirty = (repositoryId, path) => Boolean(fileBuffer(repositoryId, path)?.dirty);
  function invalidateSavedFile(repositoryId, path) {
    const buffer = fileBuffer(repositoryId, path);
    if (!buffer || buffer.dirty || buffer.saving || buffer.reloading) return false;
    buffer.externallyChanged = true; buffer.diskRevision = (buffer.diskRevision || 0) + 1;
    return true;
  }
  async function refreshAfterExternalChange(repositoryId, { paths = [] } = {}) {
    const id = String(repositoryId), affected = new Set(paths.map(normalizeIdePath));
    const result = { reloaded: [], closed: [], preserved: [], failed: [] };
    if (disposed || !affected.size) return result;
    const token = generation, owner = store.repository(id);
    if (isCurrent(token, id) && diffTab && affected.has(diffTab.path)) {
      diffTab.externallyChanged = true; diffTab.revertInvalidated = OUTDATED_DIFF_NOTICE;
      diffNavigationRevision++; renderDiffRevertWidgets(diffTab); syncCodeDiscussionSurface(); syncToolbar();
      if (activeDiff) notice(OUTDATED_DIFF_NOTICE, "warning");
    }
    const buffers = [...owner.buffers.values()].filter(buffer => affected.has(buffer.path));
    const snapshots = buffers.map(buffer => {
      buffer.externallyChanged = true; buffer.diskRevision = (buffer.diskRevision || 0) + 1;
      return { buffer, revision: buffer.diskRevision, content: buffer.content, hash: buffer.hash };
    });
    // Inactive repositories refresh lazily when their tabs reopen. Never switch
    // views, steal focus, or let a late disk read replace a newer local edit/save.
    const currentRepository = () => isCurrent(token, id);
    const untouched = ({ buffer, revision, content, hash }) => currentRepository()
      && owner.buffers.get(buffer.path) === buffer && buffer.diskRevision === revision
      && !buffer.dirty && !buffer.saving && !buffer.reloading && buffer.content === content && buffer.hash === hash;
    await Promise.all(snapshots.map(async snapshot => {
      const { buffer } = snapshot;
      if (!untouched(snapshot)) { result.preserved.push(buffer.path); return; }
      let disk;
      try { disk = await request(id, `/file?path=${encodeURIComponent(buffer.path)}`); }
      catch (error) {
        if (!untouched(snapshot)) { result.preserved.push(buffer.path); return; }
        if (error.status !== 404) { result.failed.push({ path: buffer.path, message: error.message || String(error) }); return; }
        // A delete request may race with a recreated file. Only an actual 404
        // closes the clean buffer; the caller's Git action is not sufficient.
        if (owner.active === buffer.path) { editor?.setModel(null); owner.active = null; }
        disposeModel(buffer); owner.buffers.delete(buffer.path);
        owner.history.remove(entry => entry.path === buffer.path && entry.surface !== "diff");
        result.closed.push(buffer.path); return;
      }
      if (!untouched(snapshot)) { result.preserved.push(buffer.path); return; }
      if (!disk.contentHash || typeof disk.content !== "string") {
        result.failed.push({ path: buffer.path, message: "The disk response did not include file contents and a version hash. The retained buffer was preserved." }); return;
      }
      const visible = current() === buffer && !activeDiff;
      const viewState = visible ? editor.saveViewState() : buffer.viewState;
      buffer.content = disk.content; store.saved(buffer, disk.content, disk.contentHash);
      if (buffer.model && buffer.model.getValue() !== disk.content) buffer.model.setValue(disk.content);
      buffer.viewState = viewState;
      if (visible && viewState) editor.restoreViewState(viewState);
      result.reloaded.push(buffer.path);
    }));
    if (currentRepository()) {
      if (result.closed.length) { if (!current()) sessions.save(sessionOwner, null); else persistSession(); }
      ui.empty.hidden = Boolean(current() || activeDiff);
      syncCodeDiscussionSurface(); syncToolbar(); renderBreakpoints();
      if (activeDiff?.externallyChanged) notice(OUTDATED_DIFF_NOTICE, "warning");
      else if (current()?.externallyChanged) notice("This file changed on disk. Your editor draft is preserved; compare it before saving.", "warning");
      else if (result.failed.length) notice("Some changed files could not be refreshed. Their editor contents were preserved; reopen them to retry.", "warning");
      await refreshTree();
    }
    return result;
  }
  const visibleEditor = () => activeDiff ? diffEditor?.getModifiedEditor() : editor;
  const layoutEditors = () => { editor?.layout?.(); diffEditor?.layout?.(); };
  const isCurrent = (token, id) => active && generation === token && repo?.id === id;
  const versionControlOpen = () => active && typeof onVersionControlToggle === "function" && Boolean(getVersionControlOpen(repo.id));
  function treeStorage() { try { return win.localStorage; } catch { return null; } }
  function syncTreeVisibility() {
    const visible = !ui.treePane.hidden && !versionControlOpen();
    ui.treeToggle.setAttribute("aria-expanded", String(visible));
    ui.treeToggle.title = visible ? "Hide files" : "Show files";
    ui.treeToggle.setAttribute("aria-pressed", String(visible));
    treeSplitter?.setContext(repo?.id, active && visible);
  }
  function setTreeHidden(hidden, persist = true) {
    ui.treePane.hidden = hidden; ui.treeDivider.hidden = hidden; ui.root.dataset.treeHidden = String(hidden);
    syncTreeVisibility();
    if (persist && repo) { try { treeStorage()?.setItem(`argus-ide-tree-hidden:${repo.id}`, String(hidden)); } catch {} }
    layoutEditors();
    if (!hidden && active) run(() => revealTree(activeDiff?.path || repo?.active));
  }
  async function toggleTree() {
    if (!active) return;
    if (!versionControlOpen()) { setTreeHidden(!ui.treePane.hidden); return; }
    const token = generation, id = repo.id;
    await onVersionControlToggle(id);
    if (!isCurrent(token, id)) return;
    setTreeHidden(false); syncVersionControlState();
  }
  function syncVersionControlState() {
    const open = versionControlOpen();
    const signature = `${active}:${repo?.id}:${open}:${ui.treePane.hidden}`;
    if (signature === versionControlSignature) return;
    versionControlSignature = signature;
    ui.versionControlToggle.hidden = typeof onVersionControlToggle !== "function";
    ui.versionControlToggle.disabled = !active;
    ui.versionControlToggle.title = open ? "Close version control" : "Open version control";
    ui.versionControlToggle.setAttribute("aria-label", ui.versionControlToggle.title);
    ui.versionControlToggle.setAttribute("aria-expanded", String(open));
    ui.versionControlToggle.setAttribute("aria-pressed", String(open));
    ui.versionControlSlot.hidden = !open;
    ui.root.dataset.versionControlOpen = String(open);
    syncTreeVisibility(); layoutEditors();
  }
  async function toggleVersionControl() {
    if (!active || typeof onVersionControlToggle !== "function") return;
    const token = generation, id = repo.id;
    await onVersionControlToggle(id);
    if (isCurrent(token, id)) syncVersionControlState();
  }
  function syncChatVisibility() {
    // The single chat disclosure lives in the repository header. Reflow code
    // when that shell-level panel changes without remounting editor models.
    layoutEditors();
  }
  function syncTerminalState(next = terminalState) {
    terminalState = next;
    const visible = Boolean(active && next?.visible && String(next.repositoryId) === repo?.id);
    if (visible) { toolTab = "terminal"; toolOpen = true; }
    else if (toolTab === "terminal") { toolOpen = false; toolMaximized = false; }
    syncToolDock();
  }
  function toggleTerminal() {
    if (!active || typeof onTerminalToggle !== "function") return;
    if (toolOpen && toolTab === "terminal") return collapseTools();
    return showTool("terminal");
  }
  function syncProcessLogs() {
    const state = active ? getRunState(repo.id) : null;
    const valid = state && String(state.repositoryId || state.repository?.id || repo?.id) === repo?.id;
    const process = valid ? state.latestLogProcess ?? state.latestProcess : null;
    processLogs?.setContext({ repository: active ? { ...(valid ? state?.repository : null), id: repo.id } : null,
      configuration: valid ? state.selectedConfiguration : null, process,
      visible: active && toolOpen && toolTab === "logs" });
    if (ui.toolStatus) {
      ui.toolStatus.textContent = toolTab === "debug" ? describeDebugSession(debugState?.session, debugBusy || debugAttach).label
        : toolTab === "logs" && process?.status ? process.status[0].toUpperCase() + process.status.slice(1) : "";
      ui.toolStatus.dataset.state = toolTab === "debug" ? debugState?.session?.state || "detached" : process?.status || "stopped";
    }
  }
  function syncToolDock() {
    if (!ui.toolDock) return;
    const open = active && toolOpen;
    ui.toolDock.dataset.open = String(open); ui.toolDock.dataset.maximized = String(open && toolMaximized);
    ui.main.dataset.toolMaximized = String(open && toolMaximized); ui.toolContent.hidden = !open;
    for (const tab of ui.toolTabs) { tab.setAttribute("aria-selected", String(open && tab.dataset.tool === toolTab)); tab.tabIndex = tab.dataset.tool === toolTab ? 0 : -1; }
    ui.terminalSlot.hidden = !open || toolTab !== "terminal";
    ui.runLogs.hidden = !open || toolTab !== "logs"; ui.debug.hidden = !open || toolTab !== "debug";
    ui.toolMaximize.hidden = ui.toolMinimize.hidden = !open;
    ui.toolMaximize.setAttribute("aria-pressed", String(toolMaximized));
    ui.toolMaximize.title = toolMaximized ? "Restore code and tool panel" : "Maximize tool panel";
    ui.toolMaximize.setAttribute("aria-label", ui.toolMaximize.title);
    toolSplitter?.setContext(repo?.id, open && !toolMaximized);
    syncProcessLogs(); layoutEditors();
  }
  function collapseTools() {
    toolOpen = false; toolMaximized = false; syncToolDock();
    onTerminalHide?.();
    ui.toolTabs.find(tab => tab.dataset.tool === toolTab)?.focus({ preventScroll: true });
  }
  function showTool(name, { focus = false } = {}) {
    if (!active || !["terminal", "logs", "debug"].includes(name)) return;
    // Set the selection first: minimizing a terminal synchronously publishes
    // its hidden state, which must not collapse the newly selected tool.
    toolTab = name; toolOpen = true; syncToolDock();
    if (focus) ui.toolTabs.find(tab => tab.dataset.tool === name)?.focus({ preventScroll: true });
    if (name !== "terminal") { onTerminalHide?.(); return; }
    if (terminalState?.visible && terminalState.repositoryId === repo.id) return;
    const id = repo.id;
    return onTerminalToggle?.({ repositoryId: id, returnFocus: () => { if (active && repo?.id === id) ui.toolTabs.find(tab => tab.dataset.tool === "terminal")?.focus({ preventScroll: true }); } });
  }
  function showRunLogs() {
    return showTool("logs");
  }
  function syncRunState() {
    syncProcessLogs();
    const state = active ? getRunState(repo.id) : null;
    const stateRepository = state?.repositoryId || state?.repository?.id;
    const valid = state && (!stateRepository || String(stateRepository) === repo.id);
    ui.runtime.hidden = !valid || typeof onRunAction !== "function";
    ui.runConfigure.hidden = !valid || typeof onRunConfigure !== "function";
    if (!valid) return;
    const configurations = (state.configurations || []).filter(item => !item.repositoryId || String(item.repositoryId) === repo.id);
    const selected = configurations.find(item => item.id === state.selectedConfiguration?.id);
    const signature = JSON.stringify(configurations.map(item => [item.id, item.name]));
    if (runOptionsSignature !== signature) {
      runOptionsSignature = signature;
      ui.runSelect.replaceChildren(...configurations.map(item => { const option = element("option", "", item.name || item.id); option.value = item.id; return option; }));
    }
    ui.runSelect.value = selected?.id || "";
    ui.runSelect.hidden = !configurations.length;
    ui.runSelect.disabled = Boolean(state.busy || state.loading) || typeof onRunSelect !== "function";
    ui.runSelect.title = selected ? `${selected.name || selected.id} · ${state.label || "Services configuration"}` : "Choose a Services configuration";
    const dirty = [...repo.buffers.values()].some(buffer => buffer.dirty || buffer.saving || buffer.reloading);
    const savingHint = "Save all modified files in this repository before starting the project.";
    ui.run.disabled = !state.canRun || dirty;
    ui.runDebug.disabled = !state.canDebug || dirty;
    ui.runSync.disabled = !state.canSync || dirty;
    ui.runStop.disabled = !state.canStop;
    ui.run.hidden = ui.runDebug.hidden = !configurations.length;
    ui.runSync.hidden = false;
    ui.runStop.hidden = !state.currentProcess && !state.canStop;
    ui.run.title = dirty ? savingHint : `Run ${selected?.name || "selected configuration"} using Services`;
    ui.runDebug.title = dirty ? savingHint : `Debug ${selected?.name || "selected configuration"} using Services`;
    const syncing = state.busy === "sync" || state.currentProcess?.status === "syncing";
    ui.runSync.title = dirty ? "Save all modified files before syncing project dependencies. No files are saved automatically."
      : syncing ? "Syncing project dependencies. Progress and logs are shared with Services."
        : state.currentProcess ? "Stop the active service before syncing project dependencies."
          : "Sync project dependencies using Services (Gradle, Maven or the detected package manager)";
    ui.runSync.setAttribute("aria-busy", String(syncing));
    ui.runStop.title = `Stop ${state.currentProcess?.name || (state.controlId?.startsWith("repository:") ? "repository maintenance" : selected?.name) || "selected configuration"} in Services`;
    ui.runEmpty.hidden = Boolean(configurations.length);
    ui.runEmpty.disabled = Boolean(state.loading || state.busy) || typeof onRunConfigure !== "function";
    ui.runEmpty.textContent = state.loading ? "Loading services…" : "Configure service";
    ui.runStatus.dataset.state = state.error ? "error" : state.currentProcess?.status || (state.busy || state.loading ? "starting" : "stopped");
    ui.runStatus.title = state.error || state.label || "Stopped";
    ui.runStatus.setAttribute("aria-label", state.error || state.label || "Stopped");
    ui.runtime.setAttribute("aria-busy", String(Boolean(state.busy || state.loading)));
  }
  async function runProject(mode) {
    if (!active || typeof onRunAction !== "function") return;
    const id = repo.id;
    const state = getRunState(id);
    const stateRepository = state?.repositoryId || state?.repository?.id;
    if (!state || stateRepository && String(stateRepository) !== id) return;
    if (mode !== "stop" && [...repo.buffers.values()].some(buffer => buffer.dirty || buffer.saving || buffer.reloading)) throw new Error(`Save all modified files in this repository before ${mode === "sync" ? "syncing dependencies" : "starting the project"}. No files were saved automatically.`);
    if (!(mode === "run" ? state.canRun : mode === "debug" ? state.canDebug : mode === "sync" ? state.canSync : state.canStop)) return;
    if (mode === "stop" && debugLaunch?.configurationId === state.selectedConfiguration?.id) cancelDebugLaunch();
    try { return await onRunAction(mode, id); }
    finally { if (active && repo?.id === id) syncRunState(); }
  }
  function closeActions(restoreFocus = false) {
    if (!ui.actions || ui.actions.hidden) return;
    ui.actions.hidden = true; ui.more.setAttribute("aria-expanded", "false");
    if (restoreFocus) ui.more.focus();
  }
  function toggleActions() {
    if (!ui.actions.hidden) { closeActions(true); return; }
    ui.actions.hidden = false; ui.more.setAttribute("aria-expanded", "true");
    ui.actionsButtons.find((item) => !item.disabled && !item.hidden)?.focus();
  }
  function onActionsOutside(event) {
    if (!ui.actions?.hidden && !ui.actions.contains(event.target) && !ui.more.contains(event.target)) closeActions();
  }
  function updateDirtySignal() { doc.documentElement.dataset.argusIdeDirty = String(store.dirty); }
  function notice(text, kind = "") { ui.notice.textContent = text || ""; ui.notice.dataset.kind = kind; }
  function report(error) { if (error?.name === "AbortError") return; notice(error?.message || String(error), "error"); onError(error); }
  function run(action) { const token = generation, id = repo?.id; return Promise.resolve().then(action).catch((error) => { if (isCurrent(token, id)) report(error); }); }
  async function request(id, path, options = {}, cancellable = true) {
    const controller = cancellable && !options.signal ? new AbortController() : null;
    if (controller) controllers.add(controller);
    try { return await api(`/api/repositories/${encodeURIComponent(id)}/ide${path}`, { dedupe: false, ...options, ...(controller ? { signal: controller.signal } : {}) }); }
    finally { if (controller) controllers.delete(controller); }
  }
  async function requestLanguageWork(id, path, options) {
    const token = generation; languageWork++; statusRevision++; statusPolls = 0; scheduleStatusRefresh();
    try { return await request(id, path, options); }
    finally { if (isCurrent(token, id)) { languageWork--; statusRevision++; run(refreshStatus); } }
  }
  function disposeModel(buffer) { buffer.changeListener?.dispose(); buffer.changeListener = null; buffer.model?.dispose(); buffer.model = null; buffer.decorations = []; buffer.decorationSignature = null; }
  function rememberView() { if (activeDiff) { activeDiff.viewState = diffEditor?.saveViewState?.(); return; } const buffer = current(); if (editor && buffer?.model) { buffer.viewState = editor.saveViewState(); store.edit(buffer, editor.getValue()); updateDirtySignal(); } }
  function persistSession() {
    clearTimeout(sessionTimer); sessionTimer = null;
    if (!active || !sessionOwner || !editor || activeDiff) return;
    const buffer = current(), at = editor.getPosition();
    if (!buffer?.model) return; // Loading/failed restore must not erase its retry location.
    sessions.save(sessionOwner, { path: buffer.path, line: at?.lineNumber, column: at?.column,
      scrollTop: editor.getScrollTop?.() || 0, scrollLeft: editor.getScrollLeft?.() || 0 });
  }
  function queueSession() {
    if (!active || activeDiff || !current()?.model) return;
    clearTimeout(sessionTimer); sessionTimer = setTimeout(persistSession, 200);
  }
  function onSessionVisibility() { if (doc.visibilityState === "hidden") persistSession(); }
  function location() { const buffer = activeDiff || current(), pos = visibleEditor()?.getPosition(); return buffer && (activeDiff || buffer.model) ? { path: buffer.path, line: pos?.lineNumber || 1, column: pos?.column || 1, ...(activeDiff ? { surface: "diff", diffId: activeDiff.id } : {}) } : null; }
  function getNavigationState() { const at = location(); return at ? { surface: activeDiff ? "diff" : "file", path: at.path, line: at.line, column: at.column, ...(activeDiff ? { staged: activeDiff.staged } : {}) } : null; }
  function queueCursorNavigation(event) {
    clearTimeout(cursorNavigationTimer); cursorNavigationTimer = null;
    if (event.source === "api" || !active) return;
    const token = generation, id = repo.id, before = getNavigationState();
    if (!before) return;
    cursorNavigationTimer = setTimeout(() => {
      cursorNavigationTimer = null; const now = getNavigationState();
      if (isCurrent(token, id) && now?.surface === before.surface && now?.path === before.path) onNavigationChange(now, { replace: true });
    }, 100);
  }
  function languageState(language) {
    if (language?.initializing) return "initializing…";
    if (language?.importing) return "importing project…";
    if (!language?.running) return language?.available ? "installed · stopped" : "not installed";
    if (language.language === "java" && !language.trustedProject) return "restricted · indexing needs trust";
    return (language.ready ?? !language.initializing) ? "server ready" : "server running";
  }
  function needsJavaTrust(language) { return language?.language === "java" && language.available && !language.trustedProject; }
  function syncToolbar() {
    updateDirtySignal();
    const buffer = current();
    ui.back.disabled = !repo?.history.canBack; ui.forward.disabled = !repo?.history.canForward;
    ui.navigation.hidden = ui.back.disabled && ui.forward.disabled;
    ui.save.disabled = Boolean(activeDiff) || !buffer?.dirty || Boolean(buffer?.saving || buffer?.reloading); ui.saveLabel.textContent = buffer?.saving ? "Saving…" : "Save";
    ui.save.hidden = Boolean(activeDiff) || !buffer?.dirty;
    ui.symbols.disabled = !buffer && !activeDiff;
    ui.askCode.disabled = !buffer && !activeDiff || Boolean(activeDiff?.externallyChanged);
    ui.reload.disabled = Boolean(activeDiff) || !buffer || Boolean(buffer.saving || buffer.reloading); ui.reload.textContent = buffer?.reloading ? "Reloading…" : "Reload from disk";
    ui.breakpoint.disabled = Boolean(activeDiff) || !buffer;
    ui.diffBack.hidden = !activeDiff; ui.diffLabels.hidden = !activeDiff;
    ui.path.textContent = activeDiff ? `${activeDiff.path} · ${activeDiff.title || "Changes"}${activeDiff.externallyChanged ? " · Out of date" : ""} · Read only` : buffer ? `${buffer.path}${buffer.dirty ? " • Unsaved" : ""}` : "Open a file from the tree or press ⌘P / Ctrl+P";
    ui.path.title = activeDiff?.path || buffer?.path || "";
    const caret = visibleEditor()?.getPosition(); ui.position.textContent = caret ? `${activeDiff ? "After · " : ""}Ln ${caret.lineNumber}, Col ${caret.column}` : "";
    ui.conflict.hidden = Boolean(activeDiff) || !buffer?.conflict;
    const language = status?.languages?.find((item) => item.language === serverLanguage(languageId(buffer?.language, buffer?.path)));
    ui.language.textContent = !buffer ? "Language tools" : language ? `${language.label || language.language} · ${languageState(language)}` : `${buffer.language} · syntax only`;
    ui.language.title = language?.notice || status?.notice || "Configure a local language server for definitions, references, implementations, and symbols.";
    ui.javaIndexing.hidden = !needsJavaTrust(language);
    renderTabs(); syncRunState();
  }
  function renderTabs() {
    const signature = JSON.stringify([repo?.id, repo?.active, [...(repo?.buffers.values() || [])].map(buffer => [buffer.path, buffer.dirty]), diffTab?.id, diffTab?.path, diffTab?.externallyChanged, activeDiff?.id]);
    if (signature === tabSignature) return; tabSignature = signature;
    ui.tabs.replaceChildren();
    for (const buffer of repo?.buffers.values() || []) {
      const tab = element("div", "repository-ide-tab"); tab.dataset.active = String(!activeDiff && buffer.path === repo.active);
      const select = button(`${buffer.dirty ? "● " : ""}${buffer.path.split("/").pop()}`, buffer.path, () => openFile(buffer.path), "repository-ide-tab-name");
      select.setAttribute("role", "tab"); select.setAttribute("aria-selected", String(!activeDiff && buffer.path === repo.active));
      const close = button("×", `Close ${buffer.path}`, () => closeFile(buffer), "repository-ide-tab-close"); tab.append(select, close); ui.tabs.append(tab);
    }
    if (diffTab) {
      const tab = element("div", "repository-ide-tab repository-ide-diff-tab"); tab.dataset.active = String(activeDiff === diffTab);
      const select = button(`${diffTab.path.split("/").pop()} · ${diffTab.externallyChanged ? "Out of date" : "Changes"}`, `${diffTab.path} changes`, () => showDiff(diffTab), "repository-ide-tab-name"); select.setAttribute("role", "tab"); select.setAttribute("aria-selected", String(activeDiff === diffTab));
      tab.append(select, button("×", `Close changes for ${diffTab.path}`, closeDiff, "repository-ide-tab-close")); ui.tabs.append(tab);
    }
  }
  async function closeFile(buffer) {
    if (!active || buffer.repositoryId !== repo?.id || repo.buffers.get(buffer.path) !== buffer) return;
    if (buffer.saving) { notice("Wait for this file to finish saving before closing it."); return; }
    if (buffer.dirty && !win.confirm(`Discard unsaved edits to ${buffer.path}? Your disk file will not change.`)) return;
    const token = generation, id = repo.id;
    const wasActive = !activeDiff && repo.active === buffer.path;
    if (wasActive) { editor?.setModel(null); repo.active = null; }
    else if (repo.active === buffer.path) { editor?.setModel(null); repo.active = null; }
    disposeModel(buffer); repo.buffers.delete(buffer.path); updateDirtySignal();
    // Clear a deliberately closed location before loading its replacement. A
    // slow fallback may finish after the user has switched to another repo.
    persistSession(); if (!repo.active) sessions.save(sessionOwner, null);
    if (wasActive && repo.buffers.size) await openFile([...repo.buffers.keys()].at(-1));
    else if (wasActive) ui.empty.hidden = false;
    if (!isCurrent(token, id)) return;
    syncToolbar();
  }
  function markTreeSelection(path = activeDiff?.path || repo?.active) {
    for (const [entryPath, entry] of treeNodes) {
      const selected = !entry.directory && entryPath === path;
      entry.row.dataset.active = String(selected); entry.row.setAttribute("aria-current", selected ? "true" : "false");
    }
  }
  async function expandTree(entry) {
    entry.row.setAttribute("aria-expanded", "true"); entry.children.hidden = false;
    if (!entry.loaded) {
      entry.row.setAttribute("aria-busy", "true");
      entry.loading ||= loadTree(entry.contentPath, entry.children, entry);
      try { entry.loaded = await entry.loading; } finally { entry.loading = null; entry.row.setAttribute("aria-busy", "false"); }
    }
  }
  async function revealTree(path, isValid = () => true) {
    if (!active || !path || !isValid()) return;
    const token = generation, id = repo.id, count = ++treeReveal;
    if (treeLoad) await treeLoad;
    const valid = () => isCurrent(token, id) && count === treeReveal && isValid();
    if (!valid()) return;
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = treeNodes.get(parts.slice(0, index).join("/"));
      if (parent?.directory) await expandTree(parent);
      if (!valid()) return;
    }
    markTreeSelection(path);
    if (!ui.treePane.hidden) treeNodes.get(path)?.row.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
  async function refreshTree() {
    const loading = loadTree(); treeLoad = loading;
    try { await loading; } finally { if (treeLoad === loading) treeLoad = null; }
    if (active) await revealTree(activeDiff?.path || repo?.active);
  }
  async function loadTree(path = "", parent = ui.tree, owner = null) {
    const token = generation, id = repo.id;
    if (!path) { treeRevision++; treeNodes.clear(); }
    const revision = treeRevision;
    const valid = () => isCurrent(token, id) && revision === treeRevision && (!owner || owner.row.getAttribute("aria-expanded") === "true");
    parent.replaceChildren(element("div", "repository-ide-empty", "Loading files…"));
    try {
      let result = await request(id, `/tree?path=${encodeURIComponent(path)}`);
      if (!valid()) return false;
      if (owner) {
        // Probe only an opened folder, never every folder in the root listing.
        const compact = await compactDirectoryChain({ path, listing: result, isCurrent: valid,
          read: (next, timeout) => request(id, `/tree?path=${encodeURIComponent(next)}`, { timeout }),
        });
        if (!compact) return false;
        result = compact.listing;
        if (compact.chain.length) {
          owner.contentPath = compact.path;
          owner.names.push(...compact.chain.map((entry) => entry.name || entry.path.split("/").pop()));
          for (const entry of compact.chain) treeNodes.set(entry.path, owner);
          owner.row.dataset.path = compact.path;
          owner.row.title = compact.path; owner.row.setAttribute("aria-label", compact.path);
          owner.label.dataset.compact = "true";
          owner.label.replaceChildren(
            element("span", "repository-ide-tree-prefix", `${owner.names.slice(0, -1).join("/")}/`),
            element("span", "repository-ide-tree-leaf", owner.names.at(-1)),
          );
        }
      }
      parent.replaceChildren();
      for (const entry of result.entries || []) {
        const entryPath = normalizeIdePath(entry.path), item = element("div", "repository-ide-tree-item");
        const depth = owner ? owner.depth + 1 : 0;
        const name = entry.name || entryPath.split("/").pop();
        const row = button("", entryPath, async () => {
          if (!entry.directory) return openFile(entryPath);
          const node = treeNodes.get(entryPath);
          if (row.getAttribute("aria-expanded") === "true") { row.setAttribute("aria-expanded", "false"); children.hidden = true; }
          else await expandTree(node);
        }, "repository-ide-tree-row");
        if (entry.directory) {
          const chevron = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
          chevron.setAttribute("class", "disclosure-chevron repository-ide-tree-chevron"); chevron.setAttribute("viewBox", "0 0 16 16");
          chevron.setAttribute("aria-hidden", "true"); chevron.setAttribute("focusable", "false");
          const path = doc.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "m4 6 4 4 4-4");
          chevron.append(path); row.append(chevron);
        }
        const label = element("span", "repository-ide-tree-name", name);
        label.style.setProperty("--ide-tree-depth", String(depth));
        row.append(createIdeFileIcon(doc, { ...entry, name }), label);
        const children = element("div", "repository-ide-tree-children"); children.hidden = true;
        row.dataset.path = entryPath;
        treeNodes.set(entryPath, { path: entryPath, contentPath: entryPath, names: [name], name, depth, directory: entry.directory, row, label, children, loaded: false, loading: null });
        if (entry.directory) row.setAttribute("aria-expanded", "false"); item.append(row); if (entry.directory) item.append(children); parent.append(item);
      }
      if (!result.entries?.length) parent.append(element("div", "repository-ide-empty", "No files"));
      if (result.truncated) parent.append(element("div", "repository-ide-empty", "More files available through search."));
      markTreeSelection(); return true;
    } catch (error) { if (valid()) { parent.replaceChildren(element("p", "repository-ide-empty", error.message)); } return false; }
  }
  function scheduleStatusRefresh() {
    clearTimeout(statusTimer); statusTimer = null;
    if (!active || statusPolls >= MAX_LANGUAGE_STATUS_POLLS || !languageWork && !status?.languages?.some((language) => language.initializing || language.importing)) return;
    statusTimer = setTimeout(() => {
      statusTimer = null; statusPolls++;
      refreshStatus({ poll: true }).catch(() => {});
    }, LANGUAGE_STATUS_INTERVAL);
  }
  async function refreshStatus({ poll = false } = {}) {
    if (!active) return;
    if (!poll) statusPolls = 0;
    if (statusRefresh) return statusRefresh;
    const token = generation, id = repo.id;
    const refresh = (async () => {
      while (isCurrent(token, id)) {
        const revision = statusRevision, result = await request(id, "/status");
        if (!isCurrent(token, id)) return;
        // A coalesced read begun before language work completed cannot describe
        // the new server/trust state. Keep callers waiting for a fresh snapshot.
        if (revision !== statusRevision) continue;
        status = result; syncToolbar();
        for (const update of languageCards) update();
        scheduleStatusRefresh();
        return;
      }
    })();
    statusRefresh = refresh;
    try { await refresh; } finally { if (statusRefresh === refresh) statusRefresh = null; }
  }
  function applyTheme() {
    if (!monaco || !active) return;
    monaco.editor.setTheme(doc.documentElement.dataset.theme === "light" ? "vs" : "vs-dark");
  }
  function initializeEditor() {
    const editorWindow = frameDocument.defaultView;
    const workerFactory = editorWindow.MonacoEnvironment?.getWorker;
    if (workerFactory) editorWindow.MonacoEnvironment.getWorker = (...args) => {
      if (!active) throw new Error("Editor workers are disabled.");
      const worker = workerFactory(...args); workers.add(worker); return worker;
    };
    editor = monaco.editor.create(ui.frameEditor, { automaticLayout: true, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace', fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, glyphMargin: true, folding: true, renderWhitespace: "selection", wordWrap: "off", tabSize: 2, fixedOverflowWidgets: true, ariaLabel: "Repository source editor" });
    // Semantic actions below use the repository language servers, not Monaco's unrelated browser workspace.
    for (const defaults of [monaco.languages.typescript?.typescriptDefaults, monaco.languages.typescript?.javascriptDefaults]) {
      defaults?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
      defaults?.setModeConfiguration?.({ ...defaults.modeConfiguration, definitions: false, references: false, documentSymbols: false, diagnostics: false });
    }
    applyTheme();
    subscriptions.push(...navigationActions(editor, "argus", navigate));
    subscriptions.push(editor.addAction({ id: "argus.save", label: "Save File", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => run(saveFile) }));
    subscriptions.push(editor.addAction({ id: "argus.breakpoint", label: "Toggle Breakpoint", keybindings: [monaco.KeyCode.F9], contextMenuGroupId: "navigation", contextMenuOrder: 2, run: () => run(() => toggleBreakpoint(editor.getPosition()?.lineNumber)) }));
    subscriptions.push(codeChatAction(editor, "source"));
    subscriptions.push(editor.onMouseDown((event) => {
      if (event.target.element?.closest?.(".argus-code-discussion-glyph")) return;
      if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) run(() => toggleBreakpoint(event.target.position.lineNumber));
      else if ((event.event.metaKey || event.event.ctrlKey) && definitionTarget(event.target)) { event.event.preventDefault?.(); event.event.stopPropagation?.(); followDefinition(event.target); }
    }));
    subscriptions.push(editor.onMouseMove((event) => updateDefinitionHover(event.target, event.event.metaKey || event.event.ctrlKey)));
    subscriptions.push(editor.onMouseLeave(() => clearDefinitionHover()));
    subscriptions.push(editor.onDidChangeCursorPosition((event) => { if (activeDiff) return; ui.position.textContent = `Ln ${event.position.lineNumber}, Col ${event.position.column}`; queueCursorNavigation(event); queueSession(); }));
    if (editor.onDidScrollChange) subscriptions.push(editor.onDidScrollChange(queueSession));
    if (win.MutationObserver) { themeObserver = new win.MutationObserver(applyTheme); themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); }
  }
  function navigationActions(target, prefix, follow) {
    const actions = [
      ["definition", "Go to Definition", monaco.KeyCode.F12],
      ["declaration", "Go to Declaration"],
      ["typeDefinition", "Go to Type Definition"],
      ["implementation", "Go to Implementation", monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12],
      ["references", "Find References", monaco.KeyMod.Shift | monaco.KeyCode.F12],
    ];
    return actions.map(([kind, label, keybinding], index) => target.addAction({ id: `${prefix}.${kind}`, label,
      ...(keybinding ? { keybindings: [keybinding] } : {}), contextMenuGroupId: "navigation", contextMenuOrder: 1 + index / 10,
      run: () => run(() => follow(kind)) }));
  }
  function codeChatAction(target, side) {
    return target.addAction({ id: `argus.codeDiscussion.${side}`, label: "Ask AI about this code",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyA],
      contextMenuGroupId: "navigation", contextMenuOrder: 0,
      run: () => run(() => askAboutCode(target)) });
  }
  function askAboutCode(target) {
    if (activeDiff?.externallyChanged) { notice(OUTDATED_DIFF_NOTICE, "warning"); return false; }
    return codeDiscussions.ask(target);
  }
  function syncCodeDiscussionSurface() {
    if (!codeDiscussions || !active || !monaco) return;
    if (activeDiff?.externallyChanged) codeDiscussions.clearSurfaces();
    else if (activeDiff && diffEditor) {
      codeDiscussions.setSurfaces([
        { editor: diffEditor.getOriginalEditor(), model: activeDiff.original, path: activeDiff.path, side: "before", staged: activeDiff.staged },
        { editor: diffEditor.getModifiedEditor(), model: activeDiff.modified, path: activeDiff.path, side: "after", staged: activeDiff.staged },
      ], monaco);
    } else {
      const buffer = current();
      codeDiscussions.setSurfaces(buffer?.model ? [{ editor, model: buffer.model, path: buffer.path, side: "source", staged: false,
        getState: () => ({ content: buffer.content, contentHash: buffer.hash, unsaved: buffer.dirty }) }] : [], monaco);
    }
  }
  function definitionTarget(target) {
    if (target?.type !== monaco?.editor.MouseTargetType.CONTENT_TEXT || !target.position) return null;
    const buffer = current(), word = symbolAt(buffer?.model, target.position);
    if (!word?.word) return null;
    return { buffer, model: buffer.model, position: { ...target.position }, word };
  }
  function symbolAt(model, at) {
    if (!model || !at) return null;
    const word = model.getWordAtPosition(at);
    return supportsConfigurationNavigation(model.uri?.path) ? navigationSymbolAt(model.getLineContent?.(at.lineNumber), at.column, word, model.uri.path) : word;
  }
  function clearDefinitionHover(keepTarget = false) {
    hoverGeneration++; clearTimeout(hoverTimer); hoverTimer = null; hoverController?.abort(); hoverController = null; hoverDefinition = null; hoverChecked = false;
    if (editor && hoverDecorations.length) editor.deltaDecorations(hoverDecorations, []);
    hoverDecorations = []; if (!keepTarget) hoverTarget = null;
  }
  function paintDefinitionHover(target, message, ready = false) {
    if (!editor || current() !== target.buffer) return;
    hoverDecorations = editor.deltaDecorations(hoverDecorations, [{ range: new monaco.Range(target.position.lineNumber, target.word.startColumn, target.position.lineNumber, target.word.endColumn), options: { inlineClassName: ready ? "repository-ide-definition-link" : "repository-ide-definition-pending", hoverMessage: { value: message, isTrusted: false }, stickiness: monaco.editor.TrackedRangeStickiness?.NeverGrowsWhenTypingAtEdges } }]);
  }
  function updateDefinitionHover(target, modified) {
    const next = definitionTarget(target);
    if (modified && next && hoverTarget?.buffer === next.buffer && hoverTarget.position.lineNumber === next.position.lineNumber && hoverTarget.word.startColumn === next.word.startColumn && (hoverTimer || hoverController || hoverChecked)) return;
    clearDefinitionHover(); hoverTarget = next;
    if (!modified || !next || !active) return;
    if (next.buffer.dirty) { paintDefinitionHover(next, "Save this file before navigating to its definition."); return; }
    paintDefinitionHover(next, "Ctrl/Cmd+click to go to definition. Checking the local language server…");
    const token = generation, id = repo.id, count = hoverGeneration, content = next.buffer.content;
    hoverTimer = setTimeout(async () => {
      hoverTimer = null; const controller = new AbortController(); hoverController = controller;
      const lookup = { target: next, content, hash: next.buffer.hash, diskRevision: next.buffer.diskRevision, controller, pending: true };
      hoverDefinition = lookup;
      try {
        lookup.promise = requestLanguageWork(id, "/navigate", { method: "POST", signal: controller.signal, body: { path: next.buffer.path, line: next.position.lineNumber, column: next.position.column, kind: "definition" } });
        const result = await lookup.promise;
        lookup.result = result;
        if (!isCurrent(token, id) || count !== hoverGeneration || controller.signal.aborted || current() !== next.buffer || next.buffer.content !== content) return;
        const locations = result.locations || [];
        hoverChecked = true;
        const message = result.selectionRequired ? `Ctrl/Cmd+click to choose a definition. ${result.notice || "Some configuration locations could not be checked."}` : locations.length ? `Ctrl/Cmd+click to go to definition${locations.length > 1 ? ` (${locations.length} locations)` : ""}.` : result.notice || "No definition is available at this position.";
        paintDefinitionHover(next, message, locations.length > 0);
      } catch (error) {
        if (isCurrent(token, id) && count === hoverGeneration && !controller.signal.aborted) paintDefinitionHover(next, "Ctrl/Cmd+click to retry definition lookup. Check Language tools if the server is unavailable.");
      } finally { lookup.pending = false; if (hoverController === controller) hoverController = null; }
    }, 180);
  }
  function matchesDefinitionLookup(lookup, next) {
    return lookup?.target.buffer === next.buffer && lookup.target.model === next.model
      && lookup.target.position.lineNumber === next.position.lineNumber && lookup.target.word.startColumn === next.word.startColumn
      && lookup.content === next.buffer.content && lookup.hash === next.buffer.hash && lookup.diskRevision === next.buffer.diskRevision
      && !next.buffer.dirty && !next.buffer.externallyChanged;
  }
  function followDefinition(target) {
    const next = definitionTarget(target); if (!next) return;
    if (matchesDefinitionLookup(definitionNavigation, next) && definitionNavigation.generation === generation && definitionNavigation.revision === navGeneration) { editor.setPosition(definitionNavigation.target.position); editor.focus(); return; }
    const lookup = matchesDefinitionLookup(hoverDefinition, next) ? hoverDefinition : null;
    let cached = lookup?.result?.locations?.length ? lookup.result : null;
    if (lookup?.pending && !lookup.controller.signal.aborted) {
      // Hover has already started the language server. Hand that request to the
      // click instead of aborting it and queuing the same lookup behind it.
      hoverController = null; controllers.add(lookup.controller);
      cached = lookup.promise.finally(() => controllers.delete(lookup.controller));
    }
    clearDefinitionHover(); editor.setPosition(next.position); editor.focus();
    lastDefinitionClick = { path: next.buffer.path, line: next.position.lineNumber, column: next.position.column, time: Date.now() };
    const navigation = { target: next, content: next.buffer.content, hash: next.buffer.hash, diskRevision: next.buffer.diskRevision, generation };
    definitionNavigation = navigation;
    // Capture the clicked symbol now, before any later pointer/cursor event.
    const work = navigate("definition", cached);
    navigation.revision = navGeneration;
    run(() => work).finally(() => { if (definitionNavigation === navigation) definitionNavigation = null; });
  }
  function onDefinitionMouseDown(event) {
    if (!active || !(event.ctrlKey || event.metaKey) || event.button !== 0) return;
    if (activeDiff) {
      const target = diffEditor?.getModifiedEditor().getTargetAtClientPoint(event.clientX, event.clientY);
      if (target?.type === monaco.editor.MouseTargetType.CONTENT_TEXT && target.position) { event.preventDefault(); event.stopImmediatePropagation(); followDiffDefinition(target); }
      return;
    }
    const target = editor?.getTargetAtClientPoint(event.clientX, event.clientY); if (!definitionTarget(target)) return;
    // Capture before Monaco / macOS can turn Control-click into a context menu.
    event.preventDefault(); event.stopImmediatePropagation(); followDefinition(target);
  }
  function onDefinitionContextMenu(event) {
    if (!active || !event.ctrlKey) return;
    // The definition may already have opened another file before macOS emits the
    // contextmenu half of the same gesture. Do not navigate a second symbol.
    if (lastDefinitionClick && Date.now() - lastDefinitionClick.time <= 500) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (activeDiff) {
      const target = diffEditor?.getModifiedEditor().getTargetAtClientPoint(event.clientX, event.clientY);
      if (target?.type === monaco.editor.MouseTargetType.CONTENT_TEXT && target.position) { event.preventDefault(); event.stopImmediatePropagation(); followDiffDefinition(target); }
      return;
    }
    const target = editor?.getTargetAtClientPoint(event.clientX, event.clientY), next = definitionTarget(target); if (!next) return;
    event.preventDefault(); event.stopImmediatePropagation();
    followDefinition(target);
  }
  function onDefinitionModifier(event) {
    if (!active || !hoverTarget || !["Control", "Meta"].includes(event.key)) return;
    const modified = event.ctrlKey || event.metaKey || event.type === "keydown";
    const target = { type: monaco.editor.MouseTargetType.CONTENT_TEXT, position: hoverTarget.position };
    updateDefinitionHover(target, modified);
  }
  function onDefinitionBlur() { clearDefinitionHover(); }
  function onFrameUserActivity(event) {
    if (!active || !event.isTrusted || event.type === "keydown" && ["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
    closeActions();
    doc.dispatchEvent(new win.CustomEvent("argus-ide-user-activity", { detail: { type: event.type, key: event.key || "" } }));
  }
  function loadEditorFrame() {
    // An isolated document owns Monaco's language services and worker caches. Removing
    // it on disable releases the complete runtime, while plain-text drafts stay here.
    ui.frame = element("iframe", "repository-ide-editor-frame"); ui.frame.title = "Repository source editor"; ui.editor.replaceChildren(ui.frame);
    frameDocument = ui.frame.contentDocument;
    if (!frameDocument) throw new Error("Could not initialize the local editor frame.");
    frameDocument.documentElement.style.height = "100%";
    frameDocument.body.style.cssText = "margin:0;height:100%;overflow:hidden";
    const style = frameDocument.createElement("style"); style.textContent = ".repository-ide-breakpoint{background:radial-gradient(circle,#e05a69 0 35%,transparent 40%)}.repository-ide-breakpoint-pending{background:radial-gradient(circle,transparent 0 23%,#e05a69 26% 35%,transparent 40%)}.repository-ide-execution-line{background:#e8b03a28!important}.repository-ide-execution-glyph:before{content:'▶';color:#e8b03a}.repository-ide-definition-link{cursor:pointer;text-decoration:underline;text-underline-offset:3px;color:var(--vscode-textLink-foreground)!important}.repository-ide-definition-pending{cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px}.repository-ide-diff-revert{display:flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:1px solid transparent;border-radius:3px;background:var(--vscode-editor-background);color:var(--vscode-textLink-foreground,#68a4e8);font:16px/1 sans-serif;cursor:pointer}.repository-ide-diff-revert:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,#8883);border-color:var(--vscode-focusBorder,#68a4e8)}.repository-ide-diff-revert:focus-visible{outline:2px solid var(--vscode-focusBorder,#68a4e8);outline-offset:-2px}.repository-ide-diff-revert:disabled{opacity:.45;cursor:not-allowed}"; frameDocument.head.append(style);
    ui.frameEditor = frameDocument.createElement("div"); ui.frameEditor.style.cssText = "position:absolute;inset:0"; frameDocument.body.append(ui.frameEditor);
    ui.frameDiff = frameDocument.createElement("div"); ui.frameDiff.style.cssText = "position:absolute;inset:0;display:none"; frameDocument.body.append(ui.frameDiff);
    frameDocument.addEventListener("pointerdown", onFrameUserActivity, true); frameDocument.addEventListener("keydown", onFrameUserActivity, true);
    frameDocument.addEventListener("keydown", onKeyDown, true);
    frameDocument.addEventListener("keydown", onDefinitionModifier, true); frameDocument.addEventListener("keyup", onDefinitionModifier, true);
    frameDocument.addEventListener("mousedown", onDefinitionMouseDown, true); frameDocument.addEventListener("contextmenu", onDefinitionContextMenu, true);
    frameDocument.defaultView.addEventListener("blur", onDefinitionBlur);
    editorLoadController = new AbortController();
    return loadMonaco(frameDocument, editorLoadController.signal);
  }
  function disposeDiff({ keepEditor = false } = {}) {
    if (!diffTab) { if (!keepEditor) { diffEditor?.dispose(); diffEditor = null; } return; }
    codeDiscussions?.clearSurfaces();
    diffNavigationRevision++;
    repo?.history.remove((entry) => entry.surface === "diff" && entry.diffId === diffTab.id);
    for (const subscription of diffTab.subscriptions) subscription.dispose();
    for (const widget of diffTab.revertWidgets || []) diffEditor?.getModifiedEditor().removeGlyphMarginWidget(widget);
    // Reuse Monaco's expensive control when switching files, never its stale
    // snapshots/actions. Detach models before disposing their buffers.
    if (keepEditor) diffEditor?.setModel(null);
    else { diffEditor?.dispose(); diffEditor = null; }
    diffTab.original.dispose(); diffTab.modified.dispose(); diffTab = null; activeDiff = null;
    if (ui.frameDiff) ui.frameDiff.style.display = "none";
    if (ui.frameEditor) ui.frameEditor.style.display = "block";
  }
  async function closeDiff() {
    const wasActive = Boolean(activeDiff), restore = diffTab?.returnLocation;
    disposeDiff();
    if (wasActive && restore && repo.buffers.has(restore.path)) await openFile(restore.path, restore.line, restore.column);
    else if (wasActive && repo.active && repo.buffers.has(repo.active)) await openFile(repo.active);
    else { ui.empty.hidden = Boolean(current()); syncCodeDiscussionSurface(); syncToolbar(); }
  }
  async function returnFromDiff() {
    const restore = activeDiff?.returnLocation;
    if (restore && repo.buffers.has(restore.path)) return openFile(restore.path, restore.line, restore.column);
    if (repo.active && repo.buffers.has(repo.active)) return openFile(repo.active);
    return closeDiff();
  }
  async function showDiff(tab, { history = true, line, column, focus = true } = {}) {
    if (!active || !tab || tab !== diffTab) return false;
    clearTimeout(cursorNavigationTimer); cursorNavigationTimer = null;
    diffNavigationRevision++; navGeneration++; opened++; clearDefinitionHover();
    const previous = location(); rememberView(); persistSession();
    if (history && previous) repo.history.push(previous);
    activeDiff = tab; ui.frameEditor.style.display = "none"; ui.frameDiff.style.display = "block";
    syncCodeDiscussionSurface();
    ui.diffBefore.textContent = tab.beforeLabel; ui.diffAfter.textContent = tab.afterLabel;
    if (tab.viewState) diffEditor.restoreViewState?.(tab.viewState);
    if (line) { const at = tab.modified.validatePosition(position({ line, column })); visibleEditor().setPosition(at); visibleEditor().revealPositionInCenter(at); }
    if (history) repo.history.push(location());
    ui.empty.hidden = true; syncToolbar(); layoutEditors();
    notice(tab.externallyChanged ? OUTDATED_DIFF_NOTICE : "Read-only changes. Ctrl/Cmd+click or F12 on the right side opens a definition when it matches the current file.", tab.externallyChanged ? "warning" : "");
    if (focus) visibleEditor()?.focus();
    onNavigationChange(getNavigationState());
    // Ancestor folder reads enrich the tree; they do not gate the visible diff.
    const token = generation, id = repo.id;
    void revealTree(tab.path, () => isCurrent(token, id) && activeDiff === tab)
      .catch(error => { if (isCurrent(token, id) && activeDiff === tab) notice(error.message, "warning"); });
    return true;
  }
  async function openDiff(payload) {
    if (!active || !editor) return false;
    const path = normalizeIdePath(payload.path);
    const returnLocation = activeDiff?.returnLocation || location(); rememberView(); disposeDiff({ keepEditor: true });
    const extension = path.split(".").at(-1), inferredLanguage = ({ java: "java", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", json: "json", css: "css", html: "html", xml: "xml", md: "markdown", yml: "yaml", yaml: "yaml", sh: "shell" })[extension];
    const id = ++diffSequence, language = languageId(payload.language || inferredLanguage, path);
    const original = monaco.editor.createModel(String(payload.before ?? ""), language, monaco.Uri.from({ scheme: "argus-diff", authority: `${instance}-${repo.id}-${id}`, path: `/before/${path}` }));
    const modified = monaco.editor.createModel(String(payload.after ?? ""), language, monaco.Uri.from({ scheme: "argus-diff", authority: `${instance}-${repo.id}-${id}`, path: `/after/${path}` }));
    diffEditor ||= monaco.editor.createDiffEditor(ui.frameDiff, { automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false, ignoreTrimWhitespace: false, renderMarginRevertIcon: false, renderGutterMenu: false, glyphMargin: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, renderOverviewRuler: true, ariaLabel: `Changes for ${path}` });
    diffEditor.updateOptions?.({ ariaLabel: `Changes for ${path}` });
    diffEditor.setModel({ original, modified });
    diffTab = { id, path, original, modified, returnLocation, staged: Boolean(payload.staged), title: payload.title, beforeLabel: payload.beforeLabel || "Before", afterLabel: payload.afterLabel || "After", onNavigate: payload.onNavigate, onRevertChange: payload.onRevertChange, revert: payload.revert, revertWidgets: [], revertBusy: false, subscriptions: [] };
    const right = diffEditor.getModifiedEditor();
    diffTab.subscriptions.push(codeChatAction(diffEditor.getOriginalEditor(), "before"), codeChatAction(right, "after"));
    addDiffRevertWidgets(diffTab, right, payload.changes);
    diffTab.subscriptions.push(...navigationActions(right, "argus.diff", navigateDiff));
    diffTab.subscriptions.push(right.onMouseDown((event) => { if ((event.event.ctrlKey || event.event.metaKey) && event.target.position && event.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) { event.event.preventDefault?.(); event.event.stopPropagation?.(); followDiffDefinition(event.target); } }));
    diffTab.subscriptions.push(right.onDidChangeCursorPosition((event) => { if (!activeDiff) return; ui.position.textContent = `After · Ln ${event.position.lineNumber}, Col ${event.position.column}`; queueCursorNavigation(event); }));
    return showDiff(diffTab, { line: payload.line, column: payload.column });
  }
  function diffRevertReason(tab) {
    if (tab.revertInvalidated) return tab.revertInvalidated;
    if (tab.revertBusy) return "Another change is being processed.";
    if (typeof tab.onRevertChange !== "function") return "Change actions are unavailable for this view.";
    if (tab.revert?.allowed !== true) return tab.revert?.reason || "This diff cannot be changed safely.";
    if (!/^[a-f0-9]{64}$/.test(tab.revert.revision || "")) return "Reopen the diff to load its verified disk revision.";
    return "";
  }
  function renderDiffRevertWidgets(tab) {
    const reason = diffRevertReason(tab), action = tab.staged ? "Unstage this change" : "Revert this change";
    for (const widget of tab.revertWidgets) {
      const node = widget.getDomNode(); node.disabled = Boolean(reason);
      node.title = `${action} near line ${widget.sourceLine}; ${reason || "keep other edits"}`;
      node.setAttribute("aria-label", node.title); node.setAttribute("aria-busy", String(tab.revertBusy));
    }
  }
  function addDiffRevertWidgets(tab, right, changes) {
    if (!Array.isArray(changes)) return;
    const ids = new Set(), maximum = tab.modified.getLineCount();
    for (const change of changes) {
      if (!change || !/^[a-f0-9]{64}$/.test(change.id || "") || ids.has(change.id)
        || ![change.beforeStart, change.afterStart].every(value => Number.isSafeInteger(value) && value >= 1)
        || ![change.beforeCount, change.afterCount].every(value => Number.isSafeInteger(value) && value >= 0)
        || change.beforeCount + change.afterCount === 0) continue;
      ids.add(change.id);
      const line = Math.max(1, Math.min(maximum, change.afterStart));
      const node = frameDocument.createElement("button"); node.type = "button"; node.className = "repository-ide-diff-revert"; node.textContent = "↶";
      const widget = { sourceLine: change.afterStart, getId: () => `argus.diff.revert.${instance}.${tab.id}.${change.id}`, getDomNode: () => node,
        getPosition: () => ({ lane: monaco.editor.GlyphMarginLane.Right, zIndex: 20, range: new monaco.Range(line, 1, line, 1) }) };
      node.addEventListener("mousedown", event => event.stopPropagation());
      node.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); run(() => revertDiffWidget(tab, change.id)); });
      right.addGlyphMarginWidget(widget); tab.revertWidgets.push(widget);
    }
    renderDiffRevertWidgets(tab);
  }
  async function revertDiffWidget(tab, changeId) {
    if (!active || activeDiff !== tab || diffTab !== tab || diffRevertReason(tab)) return;
    const token = generation, id = repo.id, revision = diffNavigationRevision;
    const valid = () => isCurrent(token, id) && diffTab === tab && activeDiff === tab && diffNavigationRevision === revision;
    tab.revertBusy = true; renderDiffRevertWidgets(tab);
    try {
      const result = await tab.onRevertChange(changeId, valid);
      if (result?.applied || result?.invalidated) tab.revertInvalidated = result.reason || "This diff is out of date. Reopen it before changing another block.";
    } catch (error) {
      tab.revertInvalidated = "The change outcome could not be verified. Reopen this diff before trying again.";
      if (valid()) throw error;
    } finally {
      tab.revertBusy = false;
      if (diffTab === tab) renderDiffRevertWidgets(tab);
    }
  }
  function followDiffDefinition(target) {
    visibleEditor()?.setPosition(target.position);
    lastDefinitionClick = { time: Date.now() };
    run(() => navigateDiff("definition"));
  }
  async function navigateDiff(kind) {
    const tab = activeDiff; if (!tab) return;
    if (tab.externallyChanged) { notice(OUTDATED_DIFF_NOTICE, "warning"); return; }
    if (typeof tab.onNavigate !== "function") { notice("Source navigation is unavailable for this snapshot. Open the current file to navigate its code.", "warning"); return; }
    const at = visibleEditor().getPosition(), symbol = symbolAt(tab.modified, at);
    if (!symbol?.word) { notice("Choose a symbol on the right side of the diff."); return; }
    const token = generation, id = repo.id, revision = ++diffNavigationRevision;
    const valid = () => isCurrent(token, id) && diffTab === tab && diffNavigationRevision === revision;
    await tab.onNavigate({ side: "after", path: tab.path, line: at.lineNumber, column: symbol.startColumn, word: symbol.word, kind }, valid);
  }
  async function openFile(path, line, column, { history = true, isValid = () => true, expectedHash, focus = true, preserveDiffRequest = false, notifyNavigation = true, sessionView } = {}) {
    if (!isValid()) return false;
    if (!active || !editor) return false;
    clearTimeout(cursorNavigationTimer); cursorNavigationTimer = null;
    if (!preserveDiffRequest) diffNavigationRevision++;
    clearDefinitionHover(); navGeneration++;
    path = normalizeIdePath(path);
    const token = generation, id = repo.id, requestNumber = ++opened;
    let buffer = repo.buffers.get(path);
    const diskRevision = buffer?.diskRevision;
    if (expectedHash) {
      const file = await request(id, `/file?path=${encodeURIComponent(path)}`);
      if (!isCurrent(token, id) || requestNumber !== opened || !isValid()) return false;
      if (buffer && buffer.diskRevision !== diskRevision) return false;
      if (file.contentHash !== expectedHash) throw new Error("This file changed while opening its definition. Reopen the diff and try again.");
      if (buffer?.dirty) throw new Error("Your IDE file has unsaved edits. The draft is preserved.");
      if (buffer && buffer.hash !== file.contentHash) { buffer.content = file.content; store.saved(buffer, file.content, file.contentHash); buffer.model?.setValue(file.content); }
      else if (buffer) buffer.externallyChanged = false;
      buffer ||= store.add(id, { ...file, path });
    }
    if (!buffer || buffer.externallyChanged && !buffer.dirty) {
      const file = await request(id, `/file?path=${encodeURIComponent(path)}`);
      if (!isCurrent(token, id) || requestNumber !== opened || !isValid()) return false;
      if (buffer && buffer.diskRevision !== diskRevision) return false;
      if (buffer?.dirty) throw new Error("Your file was edited while its disk changes were loading. The unsaved draft has been preserved.");
      if (buffer) {
        if (!file.contentHash) throw new Error("The disk response did not include a version hash. The retained file has not been replaced.");
        const viewState = current() === buffer && !activeDiff ? editor.saveViewState() : buffer.viewState;
        buffer.content = file.content; store.saved(buffer, file.content, file.contentHash); buffer.model?.setValue(file.content); buffer.viewState = viewState;
        if (current() === buffer && !activeDiff && viewState) editor.restoreViewState(viewState);
      } else buffer = store.add(id, { ...file, path });
    }
    if (!isCurrent(token, id) || requestNumber !== opened || !isValid()) return false;
    const previous = location(); rememberView();
    persistSession();
    if (history && previous && (previous.path !== path || line)) repo.history.push(previous);
    repo.active = path; buffer.touched = Date.now();
    activeDiff = null; ui.frameDiff.style.display = "none"; ui.frameEditor.style.display = "block";
    if (!buffer.model) {
      const models = store.all().filter((item) => item.model).sort((a, b) => a.touched - b.touched);
      while (models.length >= MAX_MODELS) { const oldest = models.shift(); if (oldest === buffer) continue; disposeModel(oldest); }
      const uri = monaco.Uri.from({ scheme: "argus", authority: `${instance}-${encodeURIComponent(id)}`, path: `/${path}` });
      buffer.model = monaco.editor.createModel(buffer.content, languageId(buffer.language, path), uri);
      buffer.changeListener = buffer.model.onDidChangeContent(event => { store.edit(buffer, (event?.isFlush ? null : applyIdeContentChanges(buffer.content, event?.changes)) ?? buffer.model.getValue()); buffer.decorationSignature = null; updateDirtySignal(); if (active && repo?.id === id) { navGeneration++; clearDefinitionHover(); syncToolbar(); renderBreakpoints(); } });
    }
    editor.setModel(buffer.model);
    syncCodeDiscussionSurface();
    if (buffer.viewState) editor.restoreViewState(buffer.viewState);
    if (!line && sessionView?.path === path) editor.setPosition(buffer.model.validatePosition(position(sessionView)));
    if (line) { const target = buffer.model.validatePosition(position({ line, column })); editor.setPosition(target); editor.revealPositionInCenter(target); }
    if (history) repo.history.push(location());
    ui.empty.hidden = true; syncToolbar(); renderBreakpoints(); editor.layout?.(); if (focus) editor.focus();
    if (!line && sessionView?.path === path) editor.setScrollPosition?.({ scrollTop: sessionView.scrollTop, scrollLeft: sessionView.scrollLeft });
    persistSession();
    notice(buffer.conflict || buffer.externallyChanged ? "This file changed on disk. Compare it before saving your retained edits." : "");
    await revealTree(path); if (!isCurrent(token, id) || requestNumber !== opened || !isValid()) return false; if (notifyNavigation) onNavigationChange(getNavigationState()); return true;
  }
  async function revealNavigation(source, result, isValid = () => true) {
    if (!active || !editor || !isValid()) return false;
    const token = generation, id = repo.id;
    const valid = () => isCurrent(token, id) && isValid();
    const locations = result.locations || [], kind = result.kind || "definition";
    const openSingle = locations.length === 1 && kind !== "references" && !result.selectionRequired;
    if (!locations.length) return false;
    for (const path of new Set([source.path, ...(openSingle ? [locations[0].path] : [])])) {
      const buffer = repo.buffers.get(normalizeIdePath(path));
      if (buffer?.dirty) throw new Error("Save or compare your unsaved IDE edits before navigating from this diff. Your draft is preserved.");
      // A clean previously opened buffer may be older than the diff/current disk.
      if (buffer) {
        const disk = await request(id, `/file?path=${encodeURIComponent(path)}`);
        if (!valid()) return false;
        if (buffer.dirty) throw new Error("Your IDE file was edited during navigation. The draft is preserved.");
        if (buffer.hash !== disk.contentHash) { buffer.content = disk.content; store.saved(buffer, disk.content, disk.contentHash); buffer.model?.setValue(disk.content); }
      }
    }
    const embedded = Boolean(activeDiff);
    if (embedded) repo.history.push(location());
    if (!valid() || !await openFile(source.path, source.line, source.column, { isValid: valid, expectedHash: source.expectedHash, focus: false, preserveDiffRequest: true, history: !embedded, notifyNavigation: false })) return false;
    if (!valid()) return false;
    if (openSingle) {
      const item = locations[0];
      if (!await openFile(item.path, item.line, item.column, { isValid: valid, focus: false, preserveDiffRequest: true, history: !embedded, notifyNavigation: false })) return false;
      if (embedded) repo.history.push(location());
    } else showResults(navigationTitle(kind), locations, result.notice);
    if (!valid()) return false;
    onNavigationChange(getNavigationState());
    syncToolbar();
    notice(result.notice || `${locations.length} ${navigationLabel(kind)} result${locations.length === 1 ? "" : "s"}. Back returns to ${embedded ? "the diff" : "the diff’s source line"}.`);
    return true;
  }
  async function saveFile() {
    if (activeDiff) return;
    const buffer = current(); if (!buffer || !buffer.dirty || buffer.saving || buffer.reloading) return;
    if (!buffer.hash) throw new Error("This file has no disk version hash. Reopen it before saving.");
    const id = repo.id, content = buffer.content, expectedHash = buffer.hash;
    buffer.saving = true; syncToolbar();
    try {
      const result = await request(id, "/file", { method: "PUT", body: { path: buffer.path, content, expectedHash } }, false);
      if (!result.contentHash) throw new Error("The save response did not include a version hash. Recheck the disk file before saving again.");
      store.saved(buffer, content, result.contentHash); updateDirtySignal(); if (active && repo?.id === id) renderBreakpoints();
      onFileSaved({ repositoryId: id, path: buffer.path });
      if (active && repo?.id === id) notice(buffer.dirty ? "Saved. Newer edits are still unsaved." : "Saved to disk.");
    } catch (error) {
      if (error.status === 409) buffer.conflict = true;
      if (active && repo?.id === id) report(error.status === 409 ? new Error("The file changed on disk. Your edits are preserved; compare the disk version before saving.") : error);
    } finally { buffer.saving = false; if (active && repo?.id === id) syncToolbar(); }
  }
  async function reloadFile() {
    if (activeDiff) return;
    const buffer = current(); if (!buffer || buffer.saving || buffer.reloading) return;
    const token = generation, id = repo.id; buffer.reloading = true; syncToolbar();
    try {
      const disk = await request(id, `/file?path=${encodeURIComponent(buffer.path)}`);
      if (!isCurrent(token, id) || current() !== buffer) return;
      if (!disk.contentHash) throw new Error("The disk response did not include a version hash. Your editor draft has been preserved.");
      if (buffer.dirty && buffer.content !== disk.content && !win.confirm(`Reload ${buffer.path} from disk and discard its unsaved editor edits?`)) return;
      const viewState = editor.saveViewState();
      buffer.content = disk.content; store.saved(buffer, disk.content, disk.contentHash); buffer.model?.setValue(disk.content); editor.restoreViewState(viewState);
      notice(`Reloaded ${buffer.path} from disk.`);
    } finally { buffer.reloading = false; if (isCurrent(token, id)) syncToolbar(); }
  }
  async function compareDisk() {
    const buffer = current(); if (!buffer) return;
    const token = generation, id = repo.id;
    const disk = await request(id, `/file?path=${encodeURIComponent(buffer.path)}`);
    if (!isCurrent(token, id) || current() !== buffer) return;
    showResults("Disk conflict", []);
    const help = element("p", "repository-ide-empty", "Your editor draft is preserved above. Review the disk content below. Copy any edits you need before reloading.");
    const preview = element("textarea", "repository-ide-disk-preview"); preview.readOnly = true; preview.value = disk.content; preview.setAttribute("aria-label", "Current disk content");
    const reload = button("Reload disk and discard this draft", "Replace the editor buffer with the disk version shown here", () => {
      if (!win.confirm(`Discard your unsaved editor draft for ${buffer.path} and load this disk version?`)) return;
      buffer.content = disk.content; store.saved(buffer, disk.content, disk.contentHash); buffer.model?.setValue(disk.content); ui.results.hidden = true; syncToolbar(); notice("Disk version loaded.");
    });
    ui.resultItems.append(help, preview, reload);
  }
  async function moveHistory(delta) { const next = repo?.history.move(delta); if (next?.surface === "diff" && diffTab?.id === next.diffId) await showDiff(diffTab, { history: false, line: next.line, column: next.column }); else if (next) await openFile(next.path, next.line, next.column, { history: false }); syncToolbar(); }
  async function navigate(kind, cached = null) {
    if (activeDiff) return navigateDiff(kind);
    const buffer = current(); if (!buffer) return;
    if (buffer.dirty) { notice("Save this file before language navigation. Language servers currently read the disk version.", "warning"); return; }
    const token = generation, id = repo.id, count = ++navGeneration, at = location(), content = buffer.content;
    const valid = () => {
      const now = location();
      return isCurrent(token, id) && count === navGeneration && current() === buffer && buffer.content === content && now?.line === at.line && now?.column === at.column;
    };
    const label = navigationLabel(kind);
    notice(`Finding ${label}…`);
    let result = cached ? await cached : null;
    if (!valid()) return;
    // A speculative lookup can finish while indexing is still catching up. An
    // explicit click gets one fresh lookup rather than requiring another click.
    if (!result?.locations?.length) result = await requestLanguageWork(id, "/navigate", { method: "POST", body: { ...at, kind } });
    if (!valid()) return;
    const locations = result.locations || [];
    if (locations.length === 1 && kind !== "references" && !result.selectionRequired) await openFile(locations[0].path, locations[0].line, locations[0].column);
    else {
      showResults(navigationTitle(kind), locations, result.notice);
      if (!locations.length && languageId(buffer.language, buffer.path) === "java" && needsJavaTrust(status?.languages?.find((language) => language.language === "java"))) {
        ui.resultItems.append(element("p", "repository-ide-empty", "Java project indexing needs your trust before Maven or Gradle can import dependencies for this repository."), button("Enable Java indexing…", "Review Java project trust and indexing", showLanguages));
      }
    }
    notice(result.notice || (!locations.length ? `No ${label} found.` : `${locations.length} ${label} result${locations.length === 1 ? "" : "s"}.`));
    run(refreshStatus);
  }
  function resultButton(item) {
    const row = button("", `${item.path}:${item.line || 1}`, () => { closeSearch(); return openFile(item.path, item.line, item.column); }, "repository-ide-result");
    row.append(element("strong", "", item.name || item.path), element("span", "", `${item.path}${item.line ? `:${item.line}` : ""}`));
    if (item.preview) row.append(element("small", "", String(item.preview).slice(0, 400))); return row;
  }
  function showResults(title, results, explanation = "") {
    ui.results.hidden = false; ui.resultsTitle.textContent = `${title}${results.length ? ` (${results.length})` : ""}`; ui.resultItems.replaceChildren();
    if (explanation) ui.resultItems.append(element("p", "repository-ide-empty", explanation));
    for (const item of results.slice(0, 200)) ui.resultItems.append(resultButton(item));
    if (!results.length && !explanation) ui.resultItems.append(element("p", "repository-ide-empty", "No results."));
  }
  function openSearch(kind = "all") {
    closeActions();
    if (!active) return;
    ui.search.hidden = false; ui.searchKind.value = kind; ui.searchInput.value = ""; ui.searchResults.replaceChildren(element("p", "repository-ide-empty", "Type to search this repository. Esc closes search.")); ui.searchInput.focus();
  }
  function closeSearch() { ui.search.hidden = true; searchGeneration++; clearTimeout(searchTimer); searchController?.abort(); visibleEditor()?.focus(); }
  function scheduleSearch() {
    clearTimeout(searchTimer); searchController?.abort();
    const query = ui.searchInput.value.trim(), count = ++searchGeneration;
    if (!query) { ui.searchResults.replaceChildren(element("p", "repository-ide-empty", "Type a file name, text, or symbol.")); return; }
    ui.searchResults.replaceChildren(element("p", "repository-ide-empty", "Searching…"));
    searchTimer = setTimeout(() => run(async () => {
      const token = generation, id = repo.id; searchController = new AbortController(); const signal = searchController.signal;
      const kinds = ui.searchKind.value === "all" ? ["files", "text", "symbols"] : [ui.searchKind.value];
      const responses = await Promise.allSettled(kinds.map((kind) => request(id, `/search?q=${encodeURIComponent(query)}&kind=${kind}`, { signal })));
      if (!isCurrent(token, id) || count !== searchGeneration || signal.aborted) return;
      ui.searchResults.replaceChildren();
      for (let index = 0; index < responses.length; index++) {
        const response = responses[index]; ui.searchResults.append(element("h4", "", kinds[index]));
        if (response.status === "rejected") { ui.searchResults.append(element("p", "repository-ide-empty", response.reason.message)); continue; }
        const result = response.value;
        for (const item of (result.results || []).slice(0, 100)) ui.searchResults.append(resultButton(item));
        if (result.notice || !result.results?.length) ui.searchResults.append(element("p", "repository-ide-empty", result.notice || "No results."));
        if (result.truncated) ui.searchResults.append(element("p", "repository-ide-empty", "Results limited. Narrow your search."));
      }
    }), 180);
  }
  async function showOutline() {
    if (activeDiff) { notice("Open the current source file to list its symbols."); return; }
    const buffer = current(); if (!buffer) return;
    if (buffer.dirty) { notice("Save this file before requesting symbols. Language servers currently read the disk version.", "warning"); return; }
    const token = generation, id = repo.id; const result = await request(id, `/symbols?path=${encodeURIComponent(buffer.path)}`);
    if (!isCurrent(token, id)) return;
    showResults("File symbols", result.results || result.symbols || [], result.notice);
  }
  function renderLanguages() {
    languageCards = [];
    ui.languageList.replaceChildren();
    ui.languageList.append(element("p", "repository-ide-empty", "Language tools run local processes with access to this repository. Configure only executables you trust. Saving configuration does not start it; Start runs the selected server. File navigation also starts an available server on demand."));
    const refreshId = repo.id, refreshToken = generation;
    ui.languageList.append(button("Reload project index", "Restart language indexing on next navigation without changing project trust", async () => {
      await requestLanguageWork(refreshId, "/language/refresh", { method: "POST" });
      if (isCurrent(refreshToken, refreshId)) { await refreshStatus(); renderLanguages(); notice("Project index will reload on your next code navigation. Existing project trust is unchanged."); }
    }));
    for (const initialLanguage of status?.languages || []) {
      let language = initialLanguage;
      const section = element("section", "repository-ide-language-card");
      const heading = element("strong"), explanation = element("p", "repository-ide-empty");
      section.append(heading, explanation);
      const executable = element("input"); executable.value = language.executable || ""; executable.placeholder = "Executable path or command"; executable.setAttribute("aria-label", `${language.label} executable`);
      const args = element("input"); args.value = JSON.stringify(language.args || []); args.placeholder = '["--stdio"]'; args.setAttribute("aria-label", `${language.label} arguments as JSON`);
      const id = repo.id, token = generation;
      const save = button("Save configuration", "Save trusted local language server configuration", async () => {
        let parsed; try { parsed = JSON.parse(args.value); } catch { throw new Error("Language-server arguments must be a JSON array of strings."); }
        if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) throw new Error("Language-server arguments must be a JSON array of strings.");
        await request(id, "/language/config", { method: "PUT", body: { language: language.language, executable: executable.value.trim(), args: parsed } });
        if (isCurrent(token, id)) { await refreshStatus(); renderLanguages(); notice("Language server configuration saved."); }
      });
      const trust = element("input"); trust.type = "checkbox"; trust.checked = Boolean(language.trustedProject);
      if (language.language === "java") {
        trust.setAttribute("aria-label", "Trust this repository for Java project indexing");
        const label = element("label", "repository-ide-project-trust"); label.append(trust, element("span", "", "I trust this repository. Enable Java project indexing by importing Maven/Gradle build logic and downloading dependencies. This choice applies only to this repository.")); section.append(label);
      }
      let starting = false, trustEdited = false;
      const syncStart = () => {
        trust.disabled = starting;
        start.disabled = starting || !language.available || Boolean(language.running) && trust.checked === Boolean(language.trustedProject);
        start.textContent = starting ? "Starting…" : language.running && !start.disabled ? "Restart with this trust setting" : language.running ? "Running" : "Start";
      };
      const start = button(language.running ? "Running" : "Start", `Start ${language.label || language.language} language server`, async () => {
        starting = true; syncStart();
        try { notice(`Starting ${language.label || language.language} language server${language.language === "java" ? "; initial project import may take a few minutes" : ""}…`); await requestLanguageWork(id, "/language/start", { method: "POST", body: { language: language.language, trustProject: trust.checked } }); if (isCurrent(token, id)) { trustEdited = false; await refreshStatus(); notice("Language server started. Project indexing may continue in the background."); } }
        catch (error) { if (isCurrent(token, id)) await refreshStatus().catch(() => {}); throw error; }
        finally { if (isCurrent(token, id)) { starting = false; syncStart(); } }
      });
      trust.addEventListener("change", () => { trustEdited = true; syncStart(); });
      const update = () => {
        language = status?.languages?.find((item) => item.language === initialLanguage.language) || language;
        heading.textContent = `${language.label || language.language} · ${languageState(language)}`;
        explanation.textContent = language.notice || "";
        if (!trustEdited && !starting) trust.checked = Boolean(language.trustedProject);
        syncStart();
      };
      languageCards.push(update); update();
      section.append(executable, args, save, start);
      if (language.logDirectory) section.append(element("p", "repository-ide-empty", `Local startup logs: ${language.logDirectory}`));
      ui.languageList.append(section);
    }
    if (!status?.languages?.length) ui.languageList.append(element("p", "repository-ide-empty", status?.notice || "Language server status is unavailable."));
  }
  async function showLanguages() { ui.settings.hidden = false; await refreshStatus(); renderLanguages(); }

  const debugConsole = createDebugConsole();
  let debugConsoleRepository = null, debugTab = "inspect", debugRefresh = null, debugAttach = false, debugEpoch = 0;
  function selectDebugTab(name, focus = false) {
    debugTab = name;
    for (const tab of ui.debugTabs) { const selected = tab.dataset.tab === name; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; if (selected && focus) tab.focus(); }
    ui.debugInspectors.hidden = name !== "inspect"; ui.debugConsolePanel.hidden = name !== "console";
    ui.debugBreakpointPanel.hidden = name !== "breakpoints"; layoutEditors();
  }
  function renderDebugConsole() {
    const nearBottom = ui.debugOutput.scrollHeight - ui.debugOutput.scrollTop - ui.debugOutput.clientHeight < 40;
    ui.debugOutput.replaceChildren();
    if (debugConsole.discarded) ui.debugOutput.append(element("p", "repository-ide-debug-log-limit", "Earlier output removed. Showing the most recent debugger output."));
    for (const entry of debugConsole.entries) { const line = element("div", "repository-ide-debug-log-entry", entry.text); line.dataset.category = entry.category; ui.debugOutput.append(line); }
    ui.debugConsoleEmpty.hidden = debugConsole.entries.length > 0;
    ui.debugClear.disabled = !debugConsole.entries.length;
    if (nearBottom) ui.debugOutput.scrollTop = ui.debugOutput.scrollHeight;
  }
  function debugEmptyStates() {
    const paused = debugState?.session?.state === "stopped", attached = Boolean(debugState?.session);
    ui.debugStackEmpty.hidden = ui.debugStack.children.length > 0;
    ui.debugVariablesEmpty.hidden = ui.debugVariables.children.length > 0;
    ui.debugStackEmpty.textContent = paused ? "No stack frames reported for this thread." : attached ? "Pause execution or hit a breakpoint to inspect the call stack." : "Attach to a debug target to inspect its call stack.";
    ui.debugVariablesEmpty.textContent = paused ? "No variables reported for this frame." : attached ? "Variables are available while execution is paused." : "Local variables appear here after a breakpoint is hit.";
  }
  async function debugCommand(command, args = {}, id = repo?.id) {
    if (!id) return;
    return request(id, "/debug/command", { method: "POST", body: { command, arguments: args } });
  }
  function renderBreakpoints() {
    renderBreakpointList();
    const buffer = current(); if (!editor || !buffer?.model) return;
    const lines = repo.breakpoints.get(buffer.path) || [];
    const signature = JSON.stringify([lines.map(line => [line, breakpointStatus.get(buffer.path)?.get(line)]), debugState?.session?.id, debugState?.session?.state, debugLocation, buffer.dirty]);
    if (buffer.decorationSignature === signature) return; buffer.decorationSignature = signature;
    const decorations = lines.map((line) => {
      const point = breakpointStatus.get(buffer.path)?.get(line), verified = Boolean(debugState?.session && point?.verified), at = point?.line || line;
      return { range: new monaco.Range(at, 1, at, 1), options: { isWholeLine: false, glyphMarginClassName: verified ? "repository-ide-breakpoint" : "repository-ide-breakpoint-pending", glyphMarginHoverMessage: { value: `${verified ? "Verified breakpoint" : debugState?.session ? "Pending breakpoint" : "Saved breakpoint · attach a debugger to activate"}${point?.message ? ` — ${point.message}` : ""}. Click the gutter or press F9 to remove.` }, stickiness: monaco.editor.TrackedRangeStickiness?.NeverGrowsWhenTypingAtEdges } };
    });
    if (!buffer.dirty && debugState?.session?.state === "stopped" && debugLocation?.path === buffer.path) decorations.push({ range: new monaco.Range(debugLocation.line, 1, debugLocation.line, 1), options: { isWholeLine: true, className: "repository-ide-execution-line", glyphMarginClassName: "repository-ide-execution-glyph", glyphMarginHoverMessage: { value: "Paused here · next statement to execute" } } });
    buffer.decorations = editor.deltaDecorations(buffer.decorations || [], decorations);
  }
  function renderBreakpointList() {
    const signature = JSON.stringify([repo?.id, Boolean(debugState?.session), [...(repo?.breakpoints || [])].map(([path, lines]) => [path, lines.map(line => [line, breakpointStatus.get(path)?.get(line)])])]);
    if (signature === breakpointListSignature) return; breakpointListSignature = signature;
    ui.debugBreakpoints.replaceChildren();
    for (const [path, lines] of repo?.breakpoints || []) for (const line of lines) {
      const point = breakpointStatus.get(path)?.get(line), state = !debugState?.session ? "saved · attach to activate" : point?.verified ? "verified" : "pending";
      const row = element("div", "repository-ide-breakpoint-row"); row.dataset.state = point?.verified && debugState?.session ? "verified" : "pending";
      row.append(button(`${path}:${point?.line || line}`, `Open breakpoint ${path}:${line}`, () => openFile(path, point?.line || line)), element("span", "", `${state}${point?.message ? ` · ${point.message}` : ""}`), button("×", `Remove breakpoint ${path}:${line}`, () => setBreakpoint(path, line, false)));
      ui.debugBreakpoints.append(row);
    }
    const count = [...(repo?.breakpoints?.values() || [])].reduce((sum, lines) => sum + lines.length, 0);
    ui.debugBreakpointCount.textContent = String(count); ui.debugBreakpointCount.hidden = count === 0;
    if (!ui.debugBreakpoints.children.length) ui.debugBreakpoints.append(element("p", "repository-ide-empty", "No breakpoints yet. Click the gutter beside a line number or press F9. Saved breakpoints become active when a debugger is attached."));
  }
  async function setBreakpoint(path, line, enabled) {
    const lines = new Set(repo.breakpoints.get(path) || []); enabled ? lines.add(line) : lines.delete(line);
    repo.breakpoints.set(path, [...lines].sort((a, b) => a - b)); breakpointStatus.get(path)?.delete(line); renderBreakpoints();
    showTool("debug"); selectDebugTab("breakpoints");
    if (debugState?.session) await sendBreakpoints(path);
    else { notice(enabled ? `Breakpoint saved at ${path}:${line}. Attach a debugger, then trigger this code to stop here.` : `Breakpoint removed at ${path}:${line}.`); run(refreshDebug); }
  }
  async function toggleBreakpoint(line) {
    const buffer = current(); if (activeDiff || !buffer || !Number.isInteger(line) || line < 1) return;
    const requested = [...(breakpointStatus.get(buffer.path) || [])].find(([_, point]) => point.line === line)?.[0] || line;
    await setBreakpoint(buffer.path, requested, !(repo.breakpoints.get(buffer.path) || []).includes(requested));
  }
  async function sendBreakpoints(path, id = repo.id, token = generation) {
    if (!isCurrent(token, id)) return;
    const sessionId = debugState?.session?.id, revision = ++breakpointSequence; breakpointRequests.set(path, revision);
    const requested = repo.breakpoints.get(path) || [];
    const result = await debugCommand("setBreakpoints", { source: { path }, breakpoints: requested.map((line) => ({ line })) }, id);
    if (!isCurrent(token, id) || debugState?.session?.id !== sessionId || breakpointRequests.get(path) !== revision) return;
    const breakpoints = result?.breakpoints || [];
    breakpointStatus.set(path, new Map(requested.map((line, index) => [line, breakpoints[index] || { line, verified: false }]))); renderBreakpoints();
    ui.debugNotice.textContent = breakpoints.length ? breakpoints.map((item) => `${path}:${item.line || "?"} ${item.verified ? "verified" : "pending / unverified"}${item.message ? ` — ${item.message}` : ""}`).join(" · ") : "Breakpoints cleared.";
  }
  async function refreshDebug({ timeout } = {}) {
    if (!active) return;
    const token = generation, id = repo.id, epoch = debugEpoch;
    if (debugRefresh?.id === id && debugRefresh?.token === token && debugRefresh?.epoch === epoch) return debugRefresh.promise;
    const refresh = { id, token, epoch }; debugRefresh = refresh;
    ui.debugRefresh.disabled = true;
    refresh.promise = (async () => {
    const result = await request(id, "/debug/status", timeout ? { timeout } : {});
    if (!isCurrent(token, id) || epoch !== debugEpoch) return;
    if (debugConsoleRepository !== id) { debugConsole.clear(); debugConsoleRepository = id; renderDebugConsole(); }
    const previousSession = debugState?.session, previousState = previousSession?.state;
    debugState = result; if (["terminated", "detached"].includes(result.session?.state)) { debugState.session = null; ui.debugNotice.textContent = "Debug session ended."; }
    if (previousSession?.id !== debugState.session?.id) { breakpointStatus.clear(); debugLocation = null; debugStopRevision++; }
    if (debugState.session?.state !== "stopped" && (previousState === "stopped" || previousSession?.id !== debugState.session?.id)) { debugLocation = null; debugStopRevision++; ui.debugStack.replaceChildren(); ui.debugVariables.replaceChildren(); }
    if (result.session?.threadId != null) debugThread = result.session.threadId;
    renderDebug(); renderBreakpoints();
    if (debugState.session?.state === "stopped" && previousState !== "stopped") { showTool("debug"); selectDebugTab("inspect"); await loadStack(); }
    if (isCurrent(token, id) && epoch === debugEpoch && debugState?.session) scheduleDebugEvents();
    })();
    try { await refresh.promise; }
    catch (error) { if (isCurrent(token, id) && epoch === debugEpoch) ui.debugNotice.textContent = `Unable to refresh debug targets: ${error.message}`; throw error; }
    finally { if (debugRefresh === refresh) { debugRefresh = null; ui.debugRefresh.disabled = false; } }
  }
  function cancelDebugLaunch() {
    const pending = debugLaunch; debugLaunch = null;
    if (!pending) return;
    clearTimeout(pending.timer); pending.wake?.();
  }
  async function attachDebugTarget(target, launch = null) {
    if (!active || debugAttach || !target || target.state !== "listening") return false;
    if (launch && debugLaunch !== launch) return false;
    if (!launch) cancelDebugLaunch();
    if (debugState?.session) throw new Error("A debugger is already attached. Detach it explicitly before attaching another service.");
    const adapter = debugState?.adapters?.find(item => item.runtime === target.runtime && item.available);
    if (!adapter) throw new Error(`No available ${target.runtime || "local"} debugger adapter. The service is still running; configure its adapter in the debugger panel.`);
    const token = generation, id = repo.id, epoch = ++debugEpoch; debugAttach = true; clearTimeout(debugTimer); renderDebug();
    let attached = false;
    try {
      const session = await request(id, "/debug/attach", { method: "POST", body: { adapterId: adapter.id, port: target.port } });
      if (!isCurrent(token, id) || epoch !== debugEpoch) return false;
      attached = true; debugConsole.clear(); debugConsoleRepository = id; renderDebugConsole();
      debugState.session = session.session || session; eventCursor = 0; debugThread = null; debugFrame = null; debugLocation = null; breakpointStatus.clear(); debugStopRevision++;
      for (const path of repo.breakpoints.keys()) await sendBreakpoints(path, id, token);
      if (!isCurrent(token, id) || epoch !== debugEpoch) return false;
      await debugCommand("configurationDone", {}, id); if (isCurrent(token, id)) await refreshDebug();
      if (isCurrent(token, id) && epoch === debugEpoch && !repo.breakpoints.size && debugState?.session?.state !== "stopped") ui.debugNotice.textContent = "Debugger attached. Add breakpoints beside executable line numbers; verified breakpoints pause the service when reached.";
      return isCurrent(token, id) && epoch === debugEpoch;
    } catch (error) { if (isCurrent(token, id) && epoch === debugEpoch) { ui.debugNotice.textContent = `${attached ? "Attached, but debugger setup did not finish" : "Could not attach"}: ${error.message}`; if (attached) scheduleDebugEvents(); } throw error; }
    finally { if (isCurrent(token, id) && epoch === debugEpoch) { debugAttach = false; renderDebug(); } }
  }
  async function attachLaunchedDebug(process) {
    if (!active || !process?.id || !process.configurationId || process.repositoryId && String(process.repositoryId) !== repo.id) return false;
    cancelDebugLaunch();
    const token = generation, id = repo.id, launch = { processId: process.id, configurationId: process.configurationId, timer: null, wake: null, deadline: Date.now() + 30_000 };
    debugLaunch = launch; showRunLogs();
    const valid = () => isCurrent(token, id) && debugLaunch === launch;
    try {
      for (let attempt = 0; attempt < 40 && valid() && Date.now() < launch.deadline; attempt++) {
        await refreshDebug({ timeout: Math.max(1, Math.min(5000, launch.deadline - Date.now())) });
        if (!valid()) return false;
        const runState = getRunState(id);
        if (runState?.selectedConfiguration?.id === launch.configurationId && (runState.busy === "stop" || runState.latestProcess?.id === launch.processId && ["stopped", "failed", "exited", "cancelled", "stopping"].includes(runState.latestProcess.status))) {
          ui.debugNotice.textContent = "The service stopped before the debugger attached.";
          return false;
        }
        // Never replace an attached session, even when another launch finishes.
        if (debugState?.session) {
          if (debugState.session.processId === process.id) return true;
          throw new Error("The service started in Debug mode, but another debugger is already attached. Detach it explicitly before attaching this service.");
        }
        const target = debugState?.targets?.find(item => item.processId === launch.processId && item.configurationId === launch.configurationId);
        if (target?.state === "listening") return await attachDebugTarget(target, launch);
        if (target && ["failed", "stopped", "terminated"].includes(target.state)) throw new Error(`The debug listener ${target.state}. Check Run logs in the editor’s bottom panel.`);
        ui.debugNotice.textContent = "Service started in Debug mode. Waiting for its local debugger listener…";
        if (attempt < 39) await new Promise(resolve => { launch.wake = resolve; launch.timer = setTimeout(() => { launch.wake = null; resolve(); }, 750); });
      }
      if (valid()) throw new Error("The service has not exposed its debug listener yet. Check Run logs, then refresh debugger targets and attach when it is ready. The service was not stopped.");
      return false;
    } catch (error) { if (valid()) { ui.debugNotice.textContent = error.message; throw error; } return false; }
    finally { if (debugLaunch === launch) cancelDebugLaunch(); }
  }
  function renderDebug() {
    const session = debugState?.session;
    const view = describeDebugSession(session, debugBusy || debugAttach);
    ui.debugTitle.textContent = "Debugger"; ui.debugSessionState.textContent = view.label;
    ui.debugSessionState.dataset.state = view.state;
    ui.debugSessionDetail.textContent = session ? `${session.adapterId === "java-jdi" ? "Java" : session.adapterId === "node-js-debug" ? "Node.js" : "Local debugger"}${session.port ? ` · 127.0.0.1:${session.port}` : ""}` : "Local debug session";
    ui.debug.dataset.state = session?.state || "detached";
    for (const control of ui.debugControls) control.disabled = !session || debugBusy || (control.dataset.command === "pause" ? session.state !== "attached" : session.state !== "stopped");
    ui.detach.disabled = !session || debugBusy; ui.debugTransport.hidden = !session;
    ui.debugTargets.hidden = Boolean(session);
    const signature = JSON.stringify([repo?.id, Boolean(session), debugAttach, debugState?.targets, debugState?.adapters, debugState?.configurationError]);
    const changed = signature !== debugTargetsSignature; debugTargetsSignature = signature;
    if (changed) ui.debugTargets.replaceChildren();
    if (!session && changed) {
      ui.debugStack.replaceChildren(); ui.debugVariables.replaceChildren();
      for (const target of debugState?.targets || []) {
        const adapter = debugState.adapters?.find((item) => item.runtime === target.runtime && item.available);
        const targetRow = element("div", "repository-ide-debug-target");
        const targetInfo = element("div", "repository-ide-debug-target-info");
        targetInfo.append(element("strong", "", target.name || target.runtime), element("span", "", `${target.runtime === "java" ? "Java" : target.runtime === "node" ? "Node.js" : target.runtime} · 127.0.0.1:${target.port}`));
        const readiness = element("span", "repository-ide-debug-target-state", !adapter ? "Adapter unavailable" : target.state === "listening" ? "Ready to attach" : target.state || "Starting");
        readiness.dataset.ready = String(Boolean(adapter) && target.state === "listening");
        const attach = button(debugAttach ? "Attaching…" : "Attach", `Attach debugger to ${target.name || target.runtime}`, () => attachDebugTarget(target)); attach.disabled = debugAttach || !adapter || target.state !== "listening"; if (target.state !== "listening") attach.title = `Debug target is ${target.state || "starting"}; refresh when it is listening.`;
        targetRow.append(targetInfo, readiness, attach); ui.debugTargets.append(targetRow);
      }
      if (!debugState?.targets?.length) { const empty = element("div", "repository-ide-debug-start"); empty.append(element("strong", "", "No debug target running"), element("p", "", "Choose a Services configuration in the editor toolbar and start Debug, or start it from Services and refresh targets here.")); ui.debugTargets.append(empty); }
      const unavailable = (debugState?.adapters || []).filter((adapter) => !adapter.available);
      if (unavailable.length) { const details = element("details", "repository-ide-debug-adapters"); details.append(element("summary", "", "Unavailable adapters")); for (const adapter of unavailable) details.append(element("p", "repository-ide-empty", `${adapter.name}: ${adapter.reason || "Not configured locally."}`)); ui.debugTargets.append(details); }
      if (debugState?.configurationError) ui.debugTargets.append(element("p", "repository-ide-empty", debugState.configurationError));
    }
    renderBreakpointList(); debugEmptyStates(); syncProcessLogs();
  }
  function scheduleDebugEvents() {
    clearTimeout(debugTimer);
    if (!active || !debugState?.session) return;
    debugTimer = setTimeout(() => run(async () => {
      const token = generation, id = repo.id, epoch = debugEpoch;
      try {
        const result = await request(id, `/debug/events?after=${eventCursor}`);
        if (!isCurrent(token, id) || epoch !== debugEpoch) return;
        eventCursor = result.cursor ?? eventCursor; if ("session" in result) debugState.session = result.session;
        let consoleChanged = false;
        for (const event of result.events || []) {
          if (!isCurrent(token, id) || epoch !== debugEpoch) return;
          if (event.event === "stopped" && debugState.session?.state === "stopped") { debugStopRevision++; debugThread = event.body?.threadId ?? debugThread; showTool("debug"); selectDebugTab("inspect"); ui.debugNotice.textContent = `Paused: ${event.body?.reason || "debug event"}`; try { await loadStack(); } catch (error) { if (isCurrent(token, id)) ui.debugNotice.textContent = `Paused · ${error.message}`; } }
          if (event.event === "continued") { debugStopRevision++; debugLocation = null; ui.debugStack.replaceChildren(); ui.debugVariables.replaceChildren(); }
          consoleChanged = debugConsole.append(event) || consoleChanged;
          if (event.event === "breakpoint") {
            const point = event.body?.breakpoint;
            if (point) {
              for (const [path, points] of breakpointStatus) for (const [line, known] of points) if (point.id != null && known.id === point.id || point.source?.path === path && (point.line === line || point.line === known.line)) points.set(line, { ...known, ...point });
              if (debugState.session?.state !== "stopped") ui.debugNotice.textContent = `Breakpoint ${point.line || ""}: ${point.verified ? "verified" : "pending / unverified"}${point.message ? ` — ${point.message}` : ""}`;
            }
          }
          if (event.event === "terminated" || event.event === "exited") { debugStopRevision++; debugLocation = null; debugState.session = null; breakpointStatus.clear(); ui.debugNotice.textContent = "Debug session ended."; }
        }
        if (!isCurrent(token, id) || epoch !== debugEpoch) return;
        if (consoleChanged) renderDebugConsole();
        if (["terminated", "detached"].includes(debugState.session?.state)) { debugState.session = null; debugStopRevision++; debugLocation = null; breakpointStatus.clear(); ui.debugNotice.textContent = "Debug session ended."; }
        renderDebug(); renderBreakpoints();
      } catch (error) { if (isCurrent(token, id) && epoch === debugEpoch) { ui.debugNotice.textContent = `Debug updates paused: ${error.message}. Refresh targets to retry.`; renderDebug(); } return; }
      if (isCurrent(token, id) && epoch === debugEpoch) scheduleDebugEvents();
    }), 1000);
  }
  async function runDebugControl(command) {
    const state = describeDebugSession(debugState?.session, debugBusy);
    if (command === "pause" ? !state.canPause : !state.canStep) return;
    const token = generation, id = repo.id, epoch = ++debugEpoch; debugBusy = true; clearTimeout(debugTimer); renderDebug();
    try {
      if (debugThread == null) {
        const result = await debugCommand("threads", {}, id);
        if (!isCurrent(token, id) || epoch !== debugEpoch) return;
        debugThread = result.threads?.find((thread) => thread.name === "main")?.id ?? result.threads?.[0]?.id;
      }
      if (debugThread == null) throw new Error("No debug thread is available yet. Refresh the debug target and try again.");
      if (command !== "pause") { debugStopRevision++; debugLocation = null; renderBreakpoints(); }
      await debugCommand(command, { threadId: debugThread }, id);
      if (isCurrent(token, id) && epoch === debugEpoch) { if (command !== "pause") { ui.debugStack.replaceChildren(); ui.debugVariables.replaceChildren(); } await refreshDebug(); }
    } finally { if (isCurrent(token, id) && epoch === debugEpoch) { debugBusy = false; renderDebug(); if (debugState?.session) scheduleDebugEvents(); } }
  }
  async function loadStack() {
    const token = generation, id = repo.id, revision = debugStopRevision, request = ++stackRequest;
    const valid = () => isCurrent(token, id) && request === stackRequest && revision === debugStopRevision && debugState?.session?.state === "stopped";
    const threads = await debugCommand("threads");
    if (!valid()) return;
    if (debugThread == null || !(threads.threads || []).some((item) => item.id === debugThread)) debugThread = threads.threads?.[0]?.id;
    ui.debugStack.replaceChildren(); ui.debugVariables.replaceChildren();
    for (const thread of threads.threads || []) { const item = button(thread.name, `Inspect thread ${thread.name}`, async () => { debugThread = thread.id; await loadStack(); }, "repository-ide-debug-thread"); item.dataset.selected = String(thread.id === debugThread); item.setAttribute("aria-pressed", String(thread.id === debugThread)); ui.debugStack.append(item); }
    if (debugThread == null) { debugEmptyStates(); return; }
    const trace = await debugCommand("stackTrace", { threadId: debugThread });
    if (!valid()) return;
    for (const frame of trace.stackFrames || []) { const item = button("", "Open stack frame and variables", async () => {
      if (!valid()) return;
      debugFrame = frame.id; for (const node of ui.debugStack.children) if (node.dataset.frame !== undefined) node.dataset.selected = String(node.dataset.frame === String(frame.id));
      const frameValid = () => valid() && debugFrame === frame.id;
      await Promise.all([revealDebugFrame(frame, frameValid), loadVariables(frame.id)]);
    }, "repository-ide-stack-frame"); item.dataset.frame = String(frame.id); item.dataset.selected = String(frame === trace.stackFrames[0]); item.title = `${frame.name} · ${frame.source?.path || "source unavailable"}:${frame.line || 1}`; item.append(element("strong", "", frame.name), element("span", "", `${frame.source?.path || "source unavailable"}:${frame.line || 1}`)); ui.debugStack.append(item); }
    if (trace.stackFrames?.[0]) { const frame = trace.stackFrames[0]; debugFrame = frame.id; await Promise.all([revealDebugFrame(frame, () => valid() && debugFrame === frame.id), loadVariables(frame.id)]); }
    if (valid()) debugEmptyStates();
  }
  async function revealDebugFrame(frame, valid) {
    if (!frame.source?.path || !valid()) return;
    debugLocation = { path: normalizeIdePath(frame.source.path), line: Math.max(1, frame.line || 1) };
    await openFile(debugLocation.path, debugLocation.line, frame.column, { focus: false, isValid: valid });
    if (!valid()) return;
    renderBreakpoints();
    if (current()?.dirty) notice("Paused in the disk version of this file. Your unsaved draft is preserved; execution highlighting is hidden until it matches disk.", "warning");
  }
  async function loadVariables(frameId) {
    const token = generation, id = repo.id, revision = debugStopRevision; const scopes = await debugCommand("scopes", { frameId });
    const valid = () => isCurrent(token, id) && debugFrame === frameId && revision === debugStopRevision && debugState?.session?.state === "stopped";
    if (!valid()) return;
    ui.debugVariables.replaceChildren();
    const work = [];
    for (const scope of scopes.scopes || []) {
      const group = element("div", "repository-ide-scope"); group.append(element("strong", "", scope.name)); ui.debugVariables.append(group);
      if (scope.expensive) group.append(button("Load variables", `Load ${scope.name}`, () => expandVariables(scope.variablesReference, group, token, id, 0, valid)));
      else work.push(() => expandVariables(scope.variablesReference, group, token, id, 0, valid));
    }
    let next = 0;
    const worker = async () => { while (valid() && next < work.length) await work[next++](); };
    await Promise.all(Array.from({ length: Math.min(3, work.length) }, worker));
    if (valid()) debugEmptyStates();
  }
  async function expandVariables(reference, parent, token, id, depth = 0, valid = () => true) {
    if (depth > 8) { parent.append(element("p", "repository-ide-empty", "Variable expansion depth limited.")); return; }
    const revision = debugStopRevision;
    if (!valid() || !isCurrent(token, id) || debugState?.session?.state !== "stopped") return;
    const result = await debugCommand("variables", { variablesReference: reference }, id);
    if (!valid() || !isCurrent(token, id) || revision !== debugStopRevision || debugState?.session?.state !== "stopped") return;
    const list = element("div", "repository-ide-variable-list");
    for (const variable of (result.variables || []).slice(0, 200)) {
      const row = element("div", "repository-ide-variable");
      row.append(element("code", "", `${variable.name}: ${String(variable.value ?? "").slice(0, 4000)}`));
      if (variable.variablesReference) { const expand = button("▸", `Expand ${variable.name}`, async () => { expand.disabled = true; try { await expandVariables(variable.variablesReference, row, token, id, depth + 1, valid); expand.setAttribute("aria-expanded", "true"); } catch (error) { expand.disabled = false; throw error; } }); expand.setAttribute("aria-expanded", "false"); row.append(expand); }
      list.append(row);
    }
    if (!list.children.length) list.append(element("p", "repository-ide-empty", "No variables in this scope."));
    parent.append(list);
  }
  async function detachDebug() {
    if (!repo || !debugState?.session || debugBusy) return;
    cancelDebugLaunch();
    const token = generation, id = repo.id, epoch = ++debugEpoch; debugBusy = true; clearTimeout(debugTimer); renderDebug();
    try { await request(id, "/debug/session", { method: "DELETE" }); if (isCurrent(token, id)) { debugState.session = null; debugStopRevision++; debugLocation = null; breakpointStatus.clear(); clearTimeout(debugTimer); ui.debugNotice.textContent = "Debugger detached. The application keeps running."; renderDebug(); renderBreakpoints(); } }
    finally { if (isCurrent(token, id) && epoch === debugEpoch) { debugBusy = false; renderDebug(); if (debugState?.session) scheduleDebugEvents(); } }
  }

  function buildUi() {
    ui.root = element("section", "repository-ide"); ui.root.setAttribute("aria-label", "Repository code editor"); ui.root.tabIndex = -1;
    const toolbar = element("header", "repository-ide-toolbar");
    toolbar.setAttribute("aria-label", "Editor toolbar");
    const views = element("div", "repository-ide-toolbar-group"); views.setAttribute("role", "group"); views.setAttribute("aria-label", "Editor panels");
    ui.treeToggle = iconButton("files", "Show or hide repository files", toggleTree, "repository-ide-visibility-toggle"); ui.treeToggle.setAttribute("aria-expanded", "true");
    ui.versionControlToggle = iconButton("branch", "Open version control", toggleVersionControl, "repository-ide-visibility-toggle"); ui.versionControlToggle.id = "repository-ide-version-control-toggle"; ui.versionControlToggle.setAttribute("aria-controls", "repository-version-control-panel");
    views.append(ui.treeToggle, ui.versionControlToggle);
    ui.navigation = element("div", "repository-ide-toolbar-group repository-ide-navigation"); ui.navigation.setAttribute("role", "group"); ui.navigation.setAttribute("aria-label", "Code navigation");
    ui.back = iconButton("left", "Navigate back (Alt+Left)", () => moveHistory(-1)); ui.forward = iconButton("right", "Navigate forward (Alt+Right)", () => moveHistory(1)); ui.navigation.append(ui.back, ui.forward);
    ui.diffBack = iconButton("left", "Return to the file open before this diff", returnFromDiff);
    ui.searchButton = button("", "Search everywhere (double Shift); files (⌘P / Ctrl+P)", () => openSearch(), "repository-ide-search-launcher");
    ui.searchButton.append(createIdeIcon(doc, "search"), element("span", "repository-ide-search-label", "Search code"), element("kbd", "repository-ide-search-shortcut", "⌘P / Ctrl+P"));
    ui.save = button("", "Save file (⌘S / Ctrl+S)", saveFile, "repository-ide-save-action"); ui.saveLabel = element("span", "", "Save"); ui.save.append(createIdeIcon(doc, "save"), ui.saveLabel);
    ui.runtime = element("div", "repository-ide-toolbar-group repository-ide-runtime"); ui.runtime.setAttribute("role", "group"); ui.runtime.setAttribute("aria-label", "Project run controls from Services");
    ui.runStatus = element("span", "repository-ide-run-status"); ui.runStatus.setAttribute("role", "status");
    ui.runSelect = element("select", "repository-ide-run-select"); ui.runSelect.setAttribute("aria-label", "Services run configuration for this repository");
    ui.runSelect.addEventListener("change", () => { if (active && typeof onRunSelect === "function") { const id = repo.id, selected = ui.runSelect.value; run(async () => { await onRunSelect(selected, id); if (active && repo?.id === id) syncRunState(); }); } });
    ui.run = iconButton("play", "Run selected Services configuration", () => runProject("run"), "repository-ide-run-action");
    ui.runDebug = iconButton("bug", "Debug selected Services configuration", () => runProject("debug"), "repository-ide-run-debug-action");
    ui.runSync = iconButton("refresh", "Sync project dependencies", () => runProject("sync"), "repository-ide-run-sync-action");
    ui.runStop = iconButton("stop", "Stop selected Services configuration", () => runProject("stop"), "repository-ide-run-stop-action");
    ui.runEmpty = button("Configure service", "Configure this repository in Services", () => active && onRunConfigure?.(repo.id), "repository-ide-run-empty");
    ui.runtime.append(ui.runStatus, ui.runSelect, ui.runEmpty, ui.runSync, ui.run, ui.runDebug, ui.runStop);
    ui.more = iconButton("more", "More editor actions", toggleActions); ui.more.setAttribute("aria-expanded", "false");
    ui.actions = element("section", "repository-ide-actions"); ui.actions.id = `repository-ide-actions-${instance}`; ui.actions.hidden = true; ui.actions.setAttribute("role", "group"); ui.actions.setAttribute("aria-label", "More editor actions"); ui.more.setAttribute("aria-controls", ui.actions.id);
    const secondary = (label, title, action, shortcut = "") => {
      const control = button("", title, () => { closeActions(true); return action(); }, "repository-ide-secondary-action");
      control.append(element("span", "", label)); if (shortcut) control.append(element("kbd", "", shortcut)); return control;
    };
    ui.symbols = secondary("File symbols", "Symbols in the current file", showOutline);
    ui.askCode = secondary("Ask AI about this code", "Ask about selected code or the current line (⌘⌥A / Ctrl+Alt+A)", () => askAboutCode(), "⌘⌥A");
    ui.codeDiscussionHistory = secondary("Code discussions", "Reopen this repository’s saved code discussions", () => codeDiscussions.open());
    ui.reload = secondary("Reload from disk", "Reload current file from disk; asks before discarding unsaved edits", reloadFile);
    ui.breakpoint = secondary("Toggle breakpoint", "Toggle breakpoint at the current line (F9); or click beside a line number", () => toggleBreakpoint(editor?.getPosition()?.lineNumber), "F9");
    ui.language = secondary("Language tools", "Language server availability and configuration", showLanguages); ui.language.className += " repository-ide-language-status";
    ui.javaIndexing = secondary("Enable Java indexing…", "Review Java project trust and indexing", showLanguages); ui.javaIndexing.hidden = true;
    ui.runConfigure = secondary("Configure service…", "Edit this repository’s Services configuration", () => active && onRunConfigure?.(repo.id)); ui.runConfigure.hidden = typeof onRunConfigure !== "function";
    ui.actionsButtons = [ui.askCode, ui.codeDiscussionHistory, ui.symbols, ui.reload, ui.breakpoint, ui.language, ui.javaIndexing, ui.runConfigure];
    ui.actions.append(element("div", "repository-ide-actions-heading", "Editor actions"), ...ui.actionsButtons);
    ui.actions.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const available = ui.actionsButtons.filter((item) => !item.disabled && !item.hidden); if (!available.length) return;
      event.preventDefault(); event.stopPropagation(); const at = available.indexOf(doc.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length; available[next].focus();
    });
    toolbar.append(views, ui.navigation, ui.diffBack, ui.searchButton, ui.save, ui.runtime, ui.more);
    const body = element("div", "repository-ide-body"); ui.versionControlSlot = element("div", "repository-ide-version-control-slot"); ui.versionControlSlot.hidden = true;
    ui.treePane = element("aside", "repository-ide-tree-pane"); ui.treePane.id = `repository-ide-files-${instance}`; ui.treeToggle.setAttribute("aria-controls", ui.treePane.id);
    ui.treeDivider = element("div", "repository-ide-tree-divider ide-splitter"); ui.treeDivider.setAttribute("aria-label", "Resize repository files and editor"); ui.treeDivider.setAttribute("aria-controls", ui.treePane.id);
    const treeHeader = element("header", "repository-ide-section-header");
    const treeHeading = element("strong", "repository-ide-tree-heading"); treeHeading.append(createIdeFileIcon(doc, { directory: true, name: "src" }), element("span", "", "Project"));
    const treeActions = element("div", "repository-ide-tree-actions");
    treeActions.append(iconButton("collapse", "Collapse all folders", () => {
      treeReveal++;
      for (const entry of treeNodes.values()) if (entry.directory) { entry.row.setAttribute("aria-expanded", "false"); entry.children.hidden = true; }
    }), iconButton("refresh", "Refresh file tree", refreshTree));
    treeHeader.append(treeHeading, treeActions);
    ui.tree = element("div", "repository-ide-tree"); ui.tree.tabIndex = 0; ui.tree.setAttribute("aria-label", "Repository files; scroll horizontally to see long names"); ui.treePane.append(treeHeader, ui.tree);
    const main = ui.main = element("div", "repository-ide-main"); ui.tabs = element("div", "repository-ide-tabs"); ui.tabs.setAttribute("role", "tablist");
    ui.path = element("div", "repository-ide-path"); const editorWrap = element("div", "repository-ide-editor-wrap"); ui.editor = element("div", "repository-ide-editor");
    ui.diffLabels = element("div", "repository-ide-diff-labels"); ui.diffBefore = element("span"); ui.diffAfter = element("span"); ui.diffLabels.append(ui.diffBefore, ui.diffAfter);
    ui.empty = element("div", "repository-ide-editor-empty", "Open a file to start editing. Use ⌘P / Ctrl+P to find files, or double Shift to search everywhere."); editorWrap.append(ui.editor, ui.empty);
    ui.conflict = element("div", "repository-ide-conflict"); ui.conflict.hidden = true; ui.conflict.append(element("span", "", "Disk conflict — your draft is preserved."), button("Compare disk", "Review the current disk version", compareDisk));
    ui.results = element("section", "repository-ide-results"); ui.results.hidden = true; const resultHeader = element("header", "repository-ide-section-header"); ui.resultsTitle = element("strong"); resultHeader.append(ui.resultsTitle, button("×", "Close results", () => { ui.results.hidden = true; })); ui.resultItems = element("div", "repository-ide-result-items"); ui.results.append(resultHeader, ui.resultItems);
    ui.terminalSlot = element("section", "repository-ide-terminal-slot"); ui.terminalSlot.id = `repository-ide-terminal-${instance}`; ui.terminalSlot.hidden = true; ui.terminalSlot.setAttribute("aria-label", "Repository terminal dock");
    main.append(ui.tabs, ui.path, ui.diffLabels, ui.conflict, editorWrap, ui.results); body.append(ui.versionControlSlot, ui.treePane, ui.treeDivider, main);
    treeSplitter = createIdeSplitter({ document: doc, container: body, handle: ui.treeDivider, property: "--ide-tree-width", storage: treeStorage(), storageKey: "argus-ide-tree-width", getLayout: () => {
      if (!active || ui.treePane.hidden || versionControlOpen()) return null;
      const width = body.clientWidth || body.offsetWidth;
      if (!(width > 0)) return null;
      const maximum = Math.min(480, Math.max(80, width - 226)), minimum = Math.min(120, maximum);
      return { axis: "x", minimum, maximum, initial: Math.max(minimum, Math.min(maximum, width * .21)) };
    }, onResize: layoutEditors });
    ui.debug = element("section", "repository-ide-debug"); ui.debugTitle = element("span", "", "Debugger"); ui.debugSessionState = element("span", "repository-ide-debug-session-state", "Not attached"); ui.debugSessionState.dataset.state = "detached";
    const debugToolbar = element("div", "repository-ide-debug-toolbar"); ui.debugSessionDetail = element("span", "repository-ide-debug-session-detail", "Local debug session");
    ui.debugRefresh = button("", "Find local Argus debug targets", refreshDebug, "repository-ide-debug-icon"); ui.debugRefresh.append(createIdeIcon(doc, "refresh"));
    ui.debugTransport = element("div", "repository-ide-debug-transport"); ui.debugTransport.setAttribute("role", "group"); ui.debugTransport.setAttribute("aria-label", "Debugger execution controls"); ui.debugTransport.hidden = true; ui.debugControls = [];
    for (const [command, label, icon] of [["continue", "Continue", "play"], ["pause", "Pause", "pause"], ["next", "Step over", "step-over"], ["stepIn", "Step into", "step-into"], ["stepOut", "Step out", "step-out"]]) {
      const control = button("", label, () => runDebugControl(command), "repository-ide-debug-icon"); control.append(createIdeIcon(doc, icon)); control.dataset.command = command; control.disabled = true; ui.debugControls.push(control); ui.debugTransport.append(control);
    }
    ui.detach = button("", "Detach debugger and leave the service running", detachDebug, "repository-ide-debug-icon repository-ide-debug-detach"); ui.detach.append(createIdeIcon(doc, "stop")); ui.detach.disabled = true; ui.debugTransport.append(ui.detach); debugToolbar.append(ui.debugSessionState, ui.debugSessionDetail, ui.debugTransport, ui.debugRefresh);
    ui.debugTargets = element("div", "repository-ide-debug-targets"); ui.debugNotice = element("div", "repository-ide-debug-notice");
    ui.debugNotice.setAttribute("role", "status"); ui.debugBreakpoints = element("div", "repository-ide-debug-breakpoints"); ui.debugBreakpoints.setAttribute("aria-label", "Breakpoints");
    const debugTabs = element("div", "repository-ide-debug-tabs"); debugTabs.setAttribute("role", "tablist"); debugTabs.setAttribute("aria-label", "Debugger views"); ui.debugTabs = [];
    for (const [name, label] of [["inspect", "Variables & stack"], ["console", "Console"], ["breakpoints", "Breakpoints"]]) {
      const tab = button(label, `Show debug ${label.toLowerCase()}`, () => selectDebugTab(name), "repository-ide-debug-tab"); tab.dataset.tab = name; tab.id = `repository-ide-debug-tab-${instance}-${name}`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `repository-ide-debug-panel-${instance}-${name}`);
      tab.addEventListener("keydown", (event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const index = ui.debugTabs.indexOf(tab), next = event.key === "Home" ? 0 : event.key === "End" ? ui.debugTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + ui.debugTabs.length) % ui.debugTabs.length; selectDebugTab(ui.debugTabs[next].dataset.tab, true); });
      if (name === "breakpoints") { ui.debugBreakpointCount = element("span", "repository-ide-debug-count", "0"); ui.debugBreakpointCount.hidden = true; tab.append(ui.debugBreakpointCount); }
      ui.debugTabs.push(tab); debugTabs.append(tab);
    }
    ui.debugInspectors = element("div", "repository-ide-debug-inspectors"); ui.debugStack = element("div", "repository-ide-debug-stack"); ui.debugStack.setAttribute("aria-label", "Debug call stack"); ui.debugVariables = element("div", "repository-ide-debug-variables"); ui.debugVariables.setAttribute("aria-label", "Debug variables");
    const stackPanel = element("section", "repository-ide-debug-inspector"), variablesPanel = element("section", "repository-ide-debug-inspector"); ui.debugStackEmpty = element("p", "repository-ide-empty"); ui.debugVariablesEmpty = element("p", "repository-ide-empty"); stackPanel.append(element("h4", "", "Call stack"), ui.debugStackEmpty, ui.debugStack); variablesPanel.append(element("h4", "", "Variables"), ui.debugVariablesEmpty, ui.debugVariables); ui.debugInspectors.append(stackPanel, variablesPanel);
    ui.debugConsolePanel = element("section", "repository-ide-debug-console-panel"); const consoleHeader = element("div", "repository-ide-debug-console-header"); ui.debugClear = button("Clear", "Clear debugger output", () => { debugConsole.clear(); renderDebugConsole(); }); ui.debugClear.disabled = true; consoleHeader.append(element("span", "", "Debugger output · read only"), ui.debugClear);
    ui.debugOutput = element("div", "repository-ide-debug-output"); ui.debugOutput.tabIndex = 0; ui.debugOutput.setAttribute("aria-label", "Debugger output log");
    ui.debugConsoleEmpty = element("p", "repository-ide-empty", "No debugger output yet. Adapter messages appear here; application stdout and stderr are in Run logs."); ui.debugConsolePanel.append(consoleHeader, ui.debugConsoleEmpty, ui.debugOutput);
    ui.debugBreakpointPanel = element("section", "repository-ide-debug-breakpoint-panel"); ui.debugBreakpointPanel.append(ui.debugBreakpoints, element("p", "repository-ide-debug-help", "Filled red = verified by the debugger. Hollow = saved or pending. Only executable lines can stop execution."));
    for (const [name, panel] of [["inspect", ui.debugInspectors], ["console", ui.debugConsolePanel], ["breakpoints", ui.debugBreakpointPanel]]) { panel.id = `repository-ide-debug-panel-${instance}-${name}`; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `repository-ide-debug-tab-${instance}-${name}`); }
    ui.debug.append(debugToolbar, ui.debugTargets, debugTabs, ui.debugInspectors, ui.debugConsolePanel, ui.debugBreakpointPanel, ui.debugNotice); selectDebugTab(debugTab); debugEmptyStates();
    ui.toolDock = element("section", "repository-ide-tool-dock"); ui.toolDock.setAttribute("aria-label", "Repository tools");
    ui.toolResizer = element("div", "repository-ide-tool-resizer ide-splitter"); ui.toolResizer.setAttribute("aria-label", "Resize editor tools");
    const toolHeader = element("header", "repository-ide-tool-header"), toolTabs = element("div", "repository-ide-tool-tabs"); toolTabs.setAttribute("role", "tablist"); toolTabs.setAttribute("aria-label", "Editor tools"); ui.toolTabs = [];
    ui.runLogs = element("section", "repository-ide-run-logs");
    for (const [name, label, icon, panel] of [["terminal", "Terminal", "terminal", ui.terminalSlot], ["logs", "Run logs", "logs", ui.runLogs], ["debug", "Debugger", "bug", ui.debug]]) {
      const tab = button("", `Show ${label.toLowerCase()}`, async () => { await showTool(name); if (name === "debug") await refreshDebug(); }, "repository-ide-tool-tab");
      tab.append(createIdeIcon(doc, icon), element("span", "", label)); tab.dataset.tool = name; tab.id = `repository-ide-tool-tab-${instance}-${name}`; tab.setAttribute("role", "tab");
      if (name === "terminal") tab.title = "Open repository terminal (⌘` / Ctrl+`)";
      panel.id = `repository-ide-tool-panel-${instance}-${name}`; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", tab.id); tab.setAttribute("aria-controls", panel.id);
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); const index = ui.toolTabs.indexOf(tab), next = event.key === "Home" ? 0 : event.key === "End" ? ui.toolTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + ui.toolTabs.length) % ui.toolTabs.length;
        ui.toolTabs[next].focus(); ui.toolTabs[next].click();
      });
      ui.toolTabs.push(tab); toolTabs.append(tab);
    }
    ui.toolStatus = element("span", "repository-ide-tool-status"); ui.toolStatus.setAttribute("role", "status");
    ui.toolMaximize = iconButton("maximize", "Maximize tool panel", () => { toolMaximized = !toolMaximized; syncToolDock(); });
    ui.toolMinimize = iconButton("minimize", "Hide tool panel (sessions keep running)", collapseTools);
    toolHeader.append(toolTabs, ui.toolStatus, ui.toolMaximize, ui.toolMinimize);
    ui.toolContent = element("div", "repository-ide-tool-content"); ui.toolContent.append(ui.terminalSlot, ui.runLogs, ui.debug); ui.toolDock.append(ui.toolResizer, toolHeader, ui.toolContent); main.append(ui.toolDock);
    processLogs = createIdeProcessLogs({ document: doc, api, container: ui.runLogs });
    toolSplitter = createIdeSplitter({ document: doc, container: main, handle: ui.toolResizer, property: "--ide-tool-height", storage: treeStorage(), storageKey: "argus-ide-tool-height", getLayout: () => {
      if (!active || !toolOpen || toolMaximized) return null;
      const height = main.clientHeight || main.offsetHeight; if (!(height > 0)) return null;
      const maximum = Math.max(42, height - 160), minimum = Math.min(160, maximum);
      return { axis: "y", reverse: true, minimum, maximum, initial: Math.max(minimum, Math.min(280, maximum, height * .4)) };
    }, onResize: layoutEditors });
    syncToolDock();
    const footer = element("footer", "repository-ide-footer"); ui.notice = element("span", "repository-ide-notice"); ui.notice.setAttribute("role", "status"); ui.position = element("span", "repository-ide-position"); footer.append(ui.notice, ui.position);
    ui.search = element("section", "repository-ide-search"); ui.search.hidden = true; ui.search.setAttribute("role", "dialog"); ui.search.setAttribute("aria-label", "Search everywhere");
    const searchHeader = element("div", "repository-ide-search-header"); ui.searchInput = element("input"); ui.searchInput.placeholder = "Search everywhere…"; ui.searchInput.setAttribute("aria-label", "Search repository"); ui.searchInput.type = "search";
    ui.searchKind = element("select"); ui.searchKind.setAttribute("aria-label", "Search type"); for (const [value, text] of [["all", "Everywhere"], ["files", "Files"], ["text", "Text"], ["symbols", "Symbols"]]) { const option = element("option", "", text); option.value = value; ui.searchKind.append(option); }
    ui.searchInput.addEventListener("input", scheduleSearch); ui.searchKind.addEventListener("change", scheduleSearch);
    ui.searchInput.addEventListener("keydown", (event) => { if (event.key === "ArrowDown") { event.preventDefault(); ui.searchResults.querySelector("button")?.focus(); } else if (event.key === "Enter") { event.preventDefault(); ui.searchResults.querySelector("button")?.click(); } });
    searchHeader.append(ui.searchInput, ui.searchKind, button("×", "Close search (Escape)", closeSearch)); ui.searchResults = element("div", "repository-ide-search-results"); ui.search.append(searchHeader, ui.searchResults);
    ui.settings = element("section", "repository-ide-settings"); ui.settings.hidden = true; ui.settings.setAttribute("role", "dialog"); ui.settings.setAttribute("aria-label", "Local language servers");
    const settingsHeader = element("header", "repository-ide-section-header"); settingsHeader.append(element("strong", "", "Local language servers"), button("×", "Close language server settings", () => { ui.settings.hidden = true; editor?.focus(); })); ui.languageList = element("div", "repository-ide-language-list"); ui.settings.append(settingsHeader, ui.languageList);
    ui.root.append(toolbar, body, footer, ui.search, ui.settings, ui.actions); host.append(ui.root); ui.root.hidden = true; syncToolbar(); syncVersionControlState(); onVersionControlMount?.(ui.versionControlSlot);
    codeDiscussions = createIdeCodeDiscussions({ host: ui.root, document: doc, api, getModelSettings: getCodeChatSettings,
      onOpenTask: onCodeChatOpenTask, onChanged: onCodeDiscussionChanged, onError });
  }
  function onKeyDown(event) {
    if (!active || !host.contains(doc.activeElement) || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.code === "Backquote" && typeof onTerminalToggle === "function") { event.preventDefault(); event.stopPropagation(); run(toggleTerminal); return; }
    // The dock hosts a real shell: Ctrl+P, Ctrl+S, arrows and Escape belong to
    // zsh/readline or the running program, not Monaco's capture-phase shortcuts.
    if (ui.terminalSlot.contains(event.target) || ui.terminalSlot.contains(doc.activeElement)) return;
    // Git's inputs and controls keep their own keyboard behavior; typing a
    // commit message must not search code, save a file, or toggle a breakpoint.
    if (ui.versionControlSlot.contains(event.target) || ui.versionControlSlot.contains(doc.activeElement)) return;
    // Inline conversations own their editing shortcuts, including Escape.
    if (event.target?.closest?.(".ide-code-chat") || doc.activeElement?.closest?.(".ide-code-chat")) return;
    if (event.key === "Escape") { if (!ui.actions.hidden) { event.preventDefault(); closeActions(true); } else if (!ui.search.hidden) { event.preventDefault(); closeSearch(); } else if (!ui.settings.hidden) { event.preventDefault(); ui.settings.hidden = true; editor?.focus(); } return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") { event.preventDefault(); event.stopPropagation(); openSearch("files"); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); run(saveFile); return; }
    if (event.key === "F9" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); run(() => toggleBreakpoint(editor?.getPosition()?.lineNumber)); return; }
    if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); run(() => moveHistory(event.key === "ArrowLeft" ? -1 : 1)); return; }
    if (event.key === "Shift" && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) { const now = Date.now(); if (lastShift && now - lastShift < 400) { event.preventDefault(); openSearch(); lastShift = 0; } else lastShift = now; }
    else if (event.key !== "Shift") lastShift = 0;
  }
  function beforeUnload(event) { persistSession(); if (store.dirty) { event.preventDefault(); event.returnValue = ""; } }
  win.addEventListener("argus:before-native-exit", persistSession); win.addEventListener("pagehide", persistSession); win.addEventListener("blur", persistSession); doc.addEventListener("visibilitychange", onSessionVisibility);
  buildUi(); doc.addEventListener("pointerdown", onActionsOutside, true); doc.addEventListener("focusin", onActionsOutside, true); doc.addEventListener("keydown", onKeyDown, true); doc.addEventListener("keydown", onDefinitionModifier, true); doc.addEventListener("keyup", onDefinitionModifier, true); win.addEventListener("blur", onDefinitionBlur); win.addEventListener("beforeunload", beforeUnload);

  async function deactivate() {
    generation++;
    codeDiscussions?.deactivate();
    cancelDebugLaunch();
    closeActions();
    if (!active) return cleanup;
    rememberView(); persistSession(); clearDefinitionHover(); disposeDiff(); const id = repo.id; active = false; sessionOwner = null; opened++; searchGeneration++; navGeneration++; treeRevision++; treeReveal++; treeLoad = null; treeNodes.clear(); lastDefinitionClick = null; treeSplitter?.setContext(id, false);
    toolOpen = false; toolMaximized = false; onTerminalMount?.(null, { repositoryId: id }); syncTerminalState(null); syncRunState(); syncVersionControlState();
    clearTimeout(searchTimer); searchController?.abort(); clearTimeout(debugTimer); lastShift = 0;
    clearTimeout(cursorNavigationTimer); cursorNavigationTimer = null;
    clearTimeout(statusTimer); statusTimer = null; statusRefresh = null; statusPolls = 0; languageWork = 0; languageCards = [];
    editorLoadController?.abort(); editorLoadController = null;
    for (const controller of controllers) controller.abort(); controllers.clear();
    themeObserver?.disconnect(); themeObserver = null;
    for (const subscription of subscriptions.splice(0)) subscription.dispose(); editor?.dispose(); editor = null;
    for (const buffer of store.all()) disposeModel(buffer);
    for (const worker of workers) worker.terminate(); workers.clear();
    frameDocument?.removeEventListener("pointerdown", onFrameUserActivity, true); frameDocument?.removeEventListener("keydown", onFrameUserActivity, true);
    frameDocument?.removeEventListener("keydown", onKeyDown, true); frameDocument?.removeEventListener("keydown", onDefinitionModifier, true); frameDocument?.removeEventListener("keyup", onDefinitionModifier, true); frameDocument?.removeEventListener("mousedown", onDefinitionMouseDown, true); frameDocument?.removeEventListener("contextmenu", onDefinitionContextMenu, true); frameDocument?.defaultView.removeEventListener("blur", onDefinitionBlur); frameDocument = null; ui.frame?.remove(); ui.frame = null; monaco = null;
    ui.root.hidden = true; ui.search.hidden = true; ui.settings.hidden = true; debugState = null; debugThread = null; debugFrame = null; debugLocation = null; debugStopRevision++; breakpointStatus.clear(); debugBusy = false; debugAttach = false; debugEpoch++; debugRefresh = null; ui.debugRefresh.disabled = false; debugConsole.clear(); debugConsoleRepository = null; eventCursor = 0; status = null; repo = null; renderDebug(); renderDebugConsole();
    cleanup = Promise.allSettled([request(id, "/session", { method: "DELETE" }, false), request(id, "/debug/session", { method: "DELETE" }, false)]).then(() => {});
    return cleanup;
  }
  async function activate(repository, { focus = true } = {}) {
    if (disposed) throw new Error("This editor workspace has been disposed.");
    const id = String(repository?.id || repository || ""); if (!id) throw new Error("Select a repository before opening the editor.");
    if (active && repo?.id === id) return;
    const pendingCleanup = deactivate(); const token = ++generation; await pendingCleanup; if (token !== generation || disposed) return;
    active = true; repo = store.repository(id); ui.root.hidden = false; ui.results.hidden = true; ui.resultItems.replaceChildren(); ui.empty.hidden = false; ui.empty.textContent = "Loading local code editor…"; ui.debugNotice.textContent = ""; ui.position.textContent = ""; notice("Loading editor…"); syncToolbar(); syncVersionControlState(); syncTerminalState();
    sessionOwner = { id, path: typeof repository === "object" ? repository.path || "" : "" };
    onTerminalMount?.(ui.terminalSlot, { repositoryId: id });
    let treeHidden = false; try { treeHidden = treeStorage()?.getItem(`argus-ide-tree-hidden:${id}`) === "true"; } catch {} setTreeHidden(treeHidden, false);
    try {
      const results = await Promise.allSettled([loadEditorFrame(), refreshStatus(), refreshTree()]);
      if (!isCurrent(token, id)) return;
      if (results[0].status === "rejected") throw results[0].reason;
      monaco = results[0].value; initializeEditor();
      codeDiscussions.activate(id);
      ui.empty.textContent = "Open a file from the tree. ⌘P / Ctrl+P finds files; double Shift searches everything.";
      notice(results[1].status === "rejected" ? `Language tools unavailable: ${results[1].reason.message}` : "Language navigation uses local servers; files are saved only on request.");
      if (repo.active && repo.buffers.has(repo.active)) await openFile(repo.active, undefined, undefined, { focus });
      else {
        const lastFile = sessions.load(sessionOwner), restoreRequest = opened;
        if (lastFile) {
          try { await openFile(lastFile.path, undefined, undefined, { focus, history: false, notifyNavigation: false, sessionView: lastFile }); }
          catch (error) {
            if (!isCurrent(token, id) || opened !== restoreRequest + 1 || error.name === "AbortError") return;
            if (error.status === 404) { sessions.save(sessionOwner, null); notice("Your last file is no longer available. Choose another file from the tree.", "warning"); }
            else notice("Could not reopen your last file. Its location is kept so you can retry when the repository is available.", "warning");
          }
        } else if (focus) ui.root.focus();
      }
      if (toolOpen && toolTab === "debug") run(refreshDebug);
    } catch (error) { if (isCurrent(token, id)) { ui.empty.textContent = error.message; report(error); } }
  }
  function dispose() {
    if (store.dirty) { notice("Unsaved editor drafts are still open. Save or explicitly close them before disposing the workspace.", "warning"); return false; }
    win.removeEventListener("argus:before-native-exit", persistSession); win.removeEventListener("pagehide", persistSession); win.removeEventListener("blur", persistSession); doc.removeEventListener("visibilitychange", onSessionVisibility);
    deactivate(); codeDiscussions?.dispose(); processLogs?.dispose(); disposed = true; treeSplitter?.dispose(); toolSplitter?.dispose(); doc.removeEventListener("pointerdown", onActionsOutside, true); doc.removeEventListener("focusin", onActionsOutside, true); doc.removeEventListener("keydown", onKeyDown, true); doc.removeEventListener("keydown", onDefinitionModifier, true); doc.removeEventListener("keyup", onDefinitionModifier, true); win.removeEventListener("blur", onDefinitionBlur); win.removeEventListener("beforeunload", beforeUnload); ui.root.remove(); return true;
  }
  return { activate, deactivate, dispose, openCodeDiscussions: () => codeDiscussions.open(), focus: () => visibleEditor()?.focus(), isDirty: (repositoryId) => repositoryId === undefined ? store.dirty : store.all().some((buffer) => buffer.repositoryId === String(repositoryId) && buffer.dirty), isFileDirty, invalidateSavedFile, refreshAfterExternalChange, openFile, openDiff, revealNavigation, getNavigationState, restoreLocation: (at, isValid = () => true) => openFile(at.path, at.line, at.column, { history: false, notifyNavigation: false, isValid }), syncChatVisibility, syncVersionControlState, syncRunState, syncTerminalState, showRunLogs, attachLaunchedDebug, refreshDebug: () => { showTool("debug"); return refreshDebug(); } };
}
