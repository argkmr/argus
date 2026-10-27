import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRepositoryIde, createIdeHistory, createIdeBufferStore, normalizeIdePath, applyIdeContentChanges } from "../public/repository-ide.mjs";
import { resolveDiffNavigationPosition } from "../public/diff-navigation.mjs";
import { IDE_SESSION_KEY } from "../public/repository-ide-session.mjs";

test("editor paths stay relative to the selected repository", () => {
  assert.equal(normalizeIdePath("src\\main\\App.java"), "src/main/App.java");
  for (const path of ["../secret", "src/../../secret", "/etc/passwd", "C:/secret", "https://host/file", "src//file", "src/./file", "bad\0name"]) assert.throws(() => normalizeIdePath(path));
});

test("incremental editor changes preserve UTF-16 offsets, multiple cursors and invalid-event fallback", () => {
  assert.equal(applyIdeContentChanges("a😀b", [{ rangeOffset: 3, rangeLength: 1, text: "c" }, { rangeOffset: 0, rangeLength: 1, text: "z" }]), "z😀c");
  assert.equal(applyIdeContentChanges("abc", [{ rangeOffset: 0, rangeLength: 3, text: "replacement" }]), "replacement");
  assert.equal(applyIdeContentChanges("abc", [{ rangeOffset: 1, rangeLength: 0, text: "x" }]), "axbc");
  for (const changes of [undefined, [], [{ rangeOffset: 8, rangeLength: 1, text: "x" }], [{ rangeOffset: -1, rangeLength: 0, text: "x" }], [{ rangeOffset: 0, rangeLength: 2, text: "x" }, { rangeOffset: 1, rangeLength: 1, text: "y" }]]) assert.equal(applyIdeContentChanges("abc", changes), null);
});

test("navigation history truncates forward entries and bounds stored positions", () => {
  const history = createIdeHistory(3);
  history.push({ path: "a.java", line: 3, column: 2 });
  history.push({ path: "b.java", line: 5, column: 1 });
  assert.equal(history.canBack, true);
  assert.deepEqual(history.move(-1), { path: "a.java", line: 3, column: 2 });
  assert.equal(history.canForward, true);
  history.push({ path: "c.java", line: 10 });
  assert.equal(history.canForward, false);
  history.push({ path: "d.java" }); history.push({ path: "e.java" });
  assert.equal(history.move(-1).path, "d.java"); assert.equal(history.move(-1).path, "c.java"); assert.equal(history.move(-1), null);
});

test("dirty buffers never get evicted and saved snapshots do not erase newer edits", () => {
  const store = createIdeBufferStore({ maxBuffers: 2, maxBytes: 1024 });
  const first = store.add("repo-a", { path: "a.java", content: "base", contentHash: "v1" });
  store.edit(first, "draft");
  const other = store.add("repo-b", { path: "a.java", content: "other", contentHash: "b1" });
  store.edit(other, "other draft");
  assert.throws(() => store.add("repo-c", { path: "c.java", content: "x" }), /preserved/);
  store.saved(first, "older draft", "v2");
  assert.equal(first.content, "draft"); assert.equal(first.dirty, true); assert.equal(first.hash, "v2");
  store.saved(first, "draft", "v3");
  assert.equal(first.dirty, false);
  store.add("repo-c", { path: "c.java", content: "x" });
  assert.equal(store.repository("repo-a").buffers.size, 0);
  assert.equal(store.repository("repo-b").buffers.get("a.java").content, "other draft");
});

class Target {
  listeners = new Map();
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatchEvent(event) { this.emit(event.type, event); return true; }
  emit(type, properties = {}) { const event = { type, key: "", target: this, preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() { this.stopped = true; }, ...properties }; for (const callback of this.listeners.get(type) || []) { callback(event); if (event.stopped) break; } return event; }
}
class Element extends Target {
  constructor(document, tag = "div") { super(); this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = { setProperty(key, value) { this[key] = value; }, getPropertyValue(key) { return this[key] || ""; }, removeProperty(key) { delete this[key]; } }; this.attributes = new Map(); this.hidden = false; this.value = ""; this.textContent = ""; this.className = ""; this.disabled = false; this.offsetWidth = this.clientWidth = 800; this.offsetHeight = this.clientHeight = 600; this.classList = { add: (name) => { this.className += ` ${name}`; }, remove: (name) => { this.className = this.className.split(" ").filter((item) => item !== name).join(" "); } }; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "class") this.className = String(value); }
  getAttribute(name) { return this.attributes.get(name); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((item) => item !== this); this.parentElement = null; }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  focus() { this.ownerDocument.activeElement = this; if (this.ownerDocument.frame) this.ownerDocument.frame.focus(); }
  click() { if (!this.disabled) this.emit("click"); }
  scrollIntoView(options) { this.scrolledIntoView = options; }
  querySelector(selector) { return walk(this).find((node) => selector === "button" ? node.tagName === "BUTTON" : node.className.split(" ").includes(selector.slice(1))); }
  get lastChild() { return this.children.at(-1); }
  getBoundingClientRect() { return { width: this.offsetWidth, height: this.offsetHeight, left: 0, top: 0 }; }
}
function walk(root) { return root.children.flatMap((child) => [child, ...walk(child)]); }
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function harness({ api: customApi, preferences = new Map(), pendingMonaco = false, onNavigationChange, ...integration } = {}) {
  const editors = [], diffEditors = [], models = [], frames = [], calls = [], saved = [], errors = [], confirmations = [];
  const localStorage = { getItem: (key) => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value), removeItem: (key) => preferences.delete(key) };
  let allowedDiscard = false;
  function document(frame) {
    const doc = new Target(), win = new Target(); doc.frame = frame; doc.defaultView = win;
    Object.assign(win, { localStorage, confirm: (text) => { confirmations.push(text); return allowedDiscard; }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, MutationObserver: class { observe() {} disconnect() {} } });
    doc.createElement = (tag) => { const element = new Element(doc, tag); if (tag === "iframe") { element.contentDocument = document(element); frames.push(element); } return element; };
    doc.createElementNS = (namespace, tag) => { const element = doc.createElement(tag); element.namespaceURI = namespace; return element; };
    doc.documentElement = new Element(doc, "html"); doc.documentElement.dataset.theme = "dark"; doc.head = new Element(doc, "head"); doc.body = new Element(doc, "body");
    doc.documentElement.append(doc.head, doc.body);
    win.monaco = {
      languages: {}, KeyCode: { F9: 9, F12: 12, KeyS: 19 }, KeyMod: { Shift: 1024, CtrlCmd: 2048 }, Uri: { from: (value) => value }, Range: class { constructor(...coordinates) { this.coordinates = coordinates; } },
      editor: {
        MouseTargetType: { GUTTER_GLYPH_MARGIN: 2, CONTENT_TEXT: 6 }, GlyphMarginLane: { Right: 3 }, TrackedRangeStickiness: {}, setTheme() {},
        create(host) {
          const actions = new Map();
          const editor = { model: null, at: { lineNumber: 1, column: 1 }, disposed: false, actions, glyphWidgets: [],
            scrollTop: 0, scrollLeft: 0, getScrollTop() { return this.scrollTop; }, getScrollLeft() { return this.scrollLeft; }, setScrollPosition(value) { Object.assign(this, value); }, onDidScrollChange(callback) { this.scroll = callback; return { dispose() {} }; },
            addGlyphMarginWidget(widget) { this.glyphWidgets.push(widget); host.append(widget.getDomNode()); }, removeGlyphMarginWidget(widget) { this.glyphWidgets = this.glyphWidgets.filter(item => item !== widget); widget.getDomNode().remove(); },
            setModel(model) { this.model = model; }, getValue() { return this.model?.getValue() || ""; }, getPosition() { return this.at; }, setPosition(at) { this.at = at; }, revealPositionInCenter() {}, saveViewState() { return { cursor: this.at }; }, restoreViewState(state) { this.at = state.cursor; }, focus() { host.focus(); }, deltaDecorations(_old, next) { this.decorations = next; return next.map((_, index) => `dec-${index}`); }, getTargetAtClientPoint() { return this.pointerTarget; }, dispose() { this.disposed = true; }, layout() {},
            addAction(action) { actions.set(action.id, action); return { dispose() { actions.delete(action.id); } }; }, onMouseDown(callback) { this.mouse = callback; return { dispose() {} }; }, onDidChangeCursorPosition(callback) { this.cursor = callback; return { dispose() {} }; },
            onMouseMove(callback) { this.mouseMove = callback; return { dispose() {} }; }, onMouseLeave(callback) { this.mouseLeave = callback; return { dispose() {} }; },
          };
          editors.push(editor); return editor;
        },
        createDiffEditor(host, options) {
          const original = this.create(host); editors.pop(); const modified = this.create(host); editors.pop();
          const diff = { original, modified, options, disposed: false, setModel(models) { this.models = models; original.setModel(models?.original || null); modified.setModel(models?.modified || null); }, updateOptions(next) { Object.assign(this.options, next); }, getModifiedEditor: () => modified, getOriginalEditor: () => original, saveViewState: () => ({ modified: modified.saveViewState() }), restoreViewState(state) { modified.restoreViewState(state.modified); }, layout() {}, dispose() { this.disposed = true; original.dispose(); modified.dispose(); } };
          diffEditors.push(diff); return diff;
        },
        createModel(content, language, uri) {
          const listeners = new Set(); const model = { content, language, uri, disposed: false,
            getValue() { return this.content; }, getLineContent(line) { return this.content.split("\n")[line - 1] || ""; }, getLineCount() { return this.content.split("\n").length; }, setValue(value) { this.content = value; for (const fn of listeners) fn(); }, validatePosition: (pos) => pos, getWordAtPosition(at) { return this.word === null ? null : { word: "method", startColumn: at.column, endColumn: at.column + 6 }; },
            change(changes, { isFlush = false, content } = {}) { this.content = content ?? applyIdeContentChanges(this.content, changes); for (const fn of listeners) fn({ changes, isFlush }); },
            onDidChangeContent(callback) { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; }, dispose() { this.disposed = true; },
          }; models.push(model); return model;
        },
      },
    };
    if (frame && pendingMonaco) delete win.monaco;
    return doc;
  }
  const doc = document(), host = new Element(doc); doc.body.append(host);
  const defaults = (path, options) => {
    if (options.method === "DELETE") return { ok: true };
    if (path.endsWith("/status")) return path.includes("/debug/") ? { adapters: [], targets: [], session: null } : { available: true, languages: [{ language: "java", label: "Java", available: false, running: false, notice: "Install a local Java language server." }] };
    if (path.includes("/tree?")) return { entries: [{ path: "src/Main.java", name: "Main.java", directory: false }] };
    if (path.includes("/file?")) { const name = new URL(path, "http://local").searchParams.get("path"); return { path: name, content: `class ${name} {}`, contentHash: `${name}-v1`, language: "java" }; }
    if (options.method === "PUT" && path.endsWith("/file")) return { contentHash: `${options.body.path}-v2` };
    if (path.endsWith("/navigate")) return { locations: [], notice: "No local server installed." };
    return { results: [] };
  };
  const controller = createRepositoryIde({ host, document: doc, api: async (path, options = {}) => { calls.push({ path, ...options }); return customApi ? customApi(path, options, defaults) : defaults(path, options); }, onError: (error) => errors.push(error), onFileSaved: (file) => saved.push(file), onNavigationChange, ...integration });
  const byClass = (className) => walk(host).find((node) => node.className.split(" ").includes(className));
  const button = (label) => walk(host).find((node) => node.tagName === "BUTTON" && node.getAttribute("aria-label") === label);
  return { controller, document: doc, host, calls, editors, diffEditors, models, frames, saved, errors, confirmations, preferences, byClass, button, setDiscard(value) { allowedDiscard = value; }, edit(text) { editors.at(-1).model.setValue(text); }, key(key, extra = {}) { return doc.emit("keydown", { key, ...extra }); } };
}

test("disabled construction has no API calls, Monaco frame, models, or scripts", () => {
  const h = harness(); assert.equal(h.calls.length, 0); assert.equal(h.frames.length, 0); assert.equal(h.models.length, 0); assert.equal(h.document.head.children.length, 0); assert.equal(h.byClass("repository-ide").hidden, true); assert.equal(h.controller.dispose(), true);
});

test("fresh IDE restores the last file per repository, cursor and scroll from current disk", async () => {
  const preferences = new Map(), first = harness({ preferences });
  await first.controller.activate({ id: "repo-a", path: "/a" });
  await first.controller.openFile("src/First.java"); await first.controller.openFile("src/Last.java", 12, 4);
  first.editors.at(-1).setScrollPosition({ scrollTop: 250, scrollLeft: 70 });
  await first.controller.activate({ id: "repo-b", path: "/b" }); await first.controller.openFile("Other.java", 9, 2);
  first.controller.dispose();
  const second = harness({ preferences, api: (path, options, fallback) => path.includes("/file?") ? { ...fallback(path, options), content: "fresh disk content", contentHash: "new" } : fallback(path, options) });
  await second.controller.activate({ id: "repo-a", path: "/a" });
  assert.deepEqual(second.controller.getNavigationState(), { surface: "file", path: "src/Last.java", line: 12, column: 4 });
  assert.equal(second.editors.at(-1).getScrollTop(), 250); assert.equal(second.editors.at(-1).getScrollLeft(), 70);
  assert.equal(second.editors.at(-1).getValue(), "fresh disk content");
  assert.equal(second.calls.filter(call => call.path.includes("/file?")).length, 1, "only last file is loaded");
  await second.controller.activate({ id: "repo-b", path: "/b" });
  assert.equal(second.controller.getNavigationState().path, "Other.java"); assert.equal(second.controller.getNavigationState().line, 9);
  assert.equal(second.calls.some(call => call.method === "PUT"), false); second.controller.dispose();
});

test("cursor/scroll debounce and immediate native exit flush metadata without saving dirty content", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1);
  editor.setPosition({ lineNumber: 42, column: 8 }); editor.setScrollPosition({ scrollTop: 200, scrollLeft: 30 }); editor.cursor({ position: editor.at, source: "keyboard" }); editor.scroll({});
  assert.equal(JSON.parse(h.preferences.get(IDE_SESSION_KEY)).repositories[0].view.line, 1);
  t.mock.timers.tick(200);
  assert.equal(JSON.parse(h.preferences.get(IDE_SESSION_KEY)).repositories[0].view.line, 42);
  h.edit("PRIVATE UNSAVED CODE"); editor.setPosition({ lineNumber: 43, column: 9 }); editor.cursor({ position: editor.at, source: "keyboard" });
  h.document.defaultView.emit("argus:before-native-exit");
  assert.equal(JSON.parse(h.preferences.get(IDE_SESSION_KEY)).repositories[0].view.line, 43);
  assert.equal(h.document.defaultView.emit("beforeunload").prevented, true);
  assert.equal(h.controller.isDirty(), true); assert.equal(h.controller.dispose(), false);
  assert.doesNotMatch(h.preferences.get(IDE_SESSION_KEY), /PRIVATE|content/);
  assert.equal(h.calls.some(call => call.method === "PUT"), false);
  h.setDiscard(true); h.button("Close src/Main.java").click(); await flush(); h.controller.dispose();
});

test("closing the last file clears recovery, preserves other repos, and cancels queued writes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const preferences = new Map(), h = harness({ preferences });
  await h.controller.activate("repo-b"); await h.controller.openFile("Other.java");
  await h.controller.activate("repo-a"); await h.controller.openFile("One.java"); await h.controller.openFile("Two.java");
  h.button("Close Two.java").click(); await flush(); assert.equal(h.controller.getNavigationState().path, "One.java");
  const editor = h.editors.at(-1); editor.cursor({ position: editor.at, source: "keyboard" });
  h.button("Close One.java").click(); await flush(); t.mock.timers.tick(300); h.controller.dispose();
  const reopened = harness({ preferences }); await reopened.controller.activate("repo-a");
  assert.equal(reopened.controller.getNavigationState(), null);
  await reopened.controller.activate("repo-b"); assert.equal(reopened.controller.getNavigationState().path, "Other.java"); reopened.controller.dispose();
});

test("missing restore is non-blocking; transient failures retain location for retry", async () => {
  for (const status of [404, 403, 503]) {
    const seed = harness(); await seed.controller.activate("repo-a"); await seed.controller.openFile("Gone.java"); seed.controller.dispose();
    const h = harness({ preferences: seed.preferences, api: (path, options, fallback) => {
      if (path.includes("/file?")) throw Object.assign(new Error("unavailable"), { status });
      return fallback(path, options);
    } });
    await h.controller.activate("repo-a"); assert.equal(h.controller.getNavigationState(), null); assert.equal(h.errors.length, 0);
    assert.equal(h.byClass("repository-ide-notice").dataset.kind, "warning"); h.controller.dispose();
    const entries = JSON.parse(seed.preferences.get(IDE_SESSION_KEY)).repositories;
    assert.equal(entries.length, status === 404 ? 0 : 1);
  }
});

test("slow automatic restoration cannot replace a newer explicit file selection", async () => {
  const seed = harness(); await seed.controller.activate("repo-a"); await seed.controller.openFile("Old.java"); seed.controller.dispose();
  const pending = deferred(); let started = false;
  const h = harness({ preferences: seed.preferences, api: (path, options, fallback) => {
    if (path.includes("/file?path=Old.java")) { started = true; return pending.promise; }
    return fallback(path, options);
  } });
  const activation = h.controller.activate("repo-a");
  for (let i = 0; i < 30 && !started; i++) await flush(); assert.equal(started, true);
  await h.controller.openFile("Chosen.java", 7, 3); pending.resolve({ content: "old", contentHash: "old", language: "java" }); await activation;
  assert.equal(h.controller.getNavigationState().path, "Chosen.java");
  assert.equal(JSON.parse(h.preferences.get(IDE_SESSION_KEY)).repositories[0].view.path, "Chosen.java"); h.controller.dispose();
});

test("diff viewing does not replace the source-file restore location", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("Source.java", 4, 2);
  h.editors.at(-1).setPosition({ lineNumber: 19, column: 6 });
  await h.controller.openDiff({ path: "Diff.java", before: "before", after: "after" });
  h.document.defaultView.emit("pagehide"); h.controller.dispose();
  const view = JSON.parse(h.preferences.get(IDE_SESSION_KEY)).repositories[0].view;
  assert.equal(view.path, "Source.java"); assert.equal(view.line, 19);
});

test("late close fallback cannot clear another repository's pending restore location", async () => {
  const preferences = new Map(), seed = harness({ preferences });
  await seed.controller.activate("repo-b"); await seed.controller.openFile("Keep.java"); seed.controller.dispose();
  const fallbackRead = deferred(), restoreRead = deferred(); let delayFallback = false, closing = false, restoring = false;
  const h = harness({ preferences, api: (path, options, fallback) => {
    if (delayFallback && path.includes("repo-a/ide/file?path=One.java")) { closing = true; return fallbackRead.promise; }
    if (path.includes("repo-b/ide/file?path=Keep.java")) { restoring = true; return restoreRead.promise; }
    return fallback(path, options);
  } });
  await h.controller.activate("repo-a"); await h.controller.openFile("One.java"); await h.controller.openFile("Two.java");
  h.controller.invalidateSavedFile("repo-a", "One.java"); delayFallback = true; h.button("Close Two.java").click();
  for (let i = 0; i < 20 && !closing; i++) await flush(); assert.equal(closing, true);
  const activation = h.controller.activate("repo-b");
  for (let i = 0; i < 20 && !restoring; i++) await flush(); assert.equal(restoring, true);
  fallbackRead.resolve({ content: "new fallback", contentHash: "new" }); await flush();
  assert.equal(JSON.parse(preferences.get(IDE_SESSION_KEY)).repositories.find(item => item.id === "repo-b").view.path, "Keep.java");
  restoreRead.reject(Object.assign(new Error("temporarily unavailable"), { status: 503 })); await activation; h.controller.dispose();
  assert.equal(JSON.parse(preferences.get(IDE_SESSION_KEY)).repositories.find(item => item.id === "repo-b").view.path, "Keep.java");
});

test("source and both read-only diff panes expose code questions without changing text", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  assert.equal(h.editors[0].actions.get("argus.codeDiscussion.source")?.label, "Ask AI about this code");
  await h.controller.openDiff({ path: "src/Main.java", before: "class Before {}", after: "class After {}", staged: true });
  const diff = h.diffEditors.at(-1);
  assert.equal(diff.original.actions.get("argus.codeDiscussion.before")?.label, "Ask AI about this code");
  assert.equal(diff.modified.actions.get("argus.codeDiscussion.after")?.label, "Ask AI about this code");
  assert.equal(diff.models.original.getValue(), "class Before {}");
  assert.equal(diff.models.modified.getValue(), "class After {}");
  assert.equal(h.controller.isDirty(), false);
  h.controller.dispose();
});

test("inline chat inputs retain typing and navigation shortcuts instead of editor commands", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const input = new Element(h.document, "textarea"); input.closest = selector => selector === ".ide-code-chat" ? input : null;
  h.host.append(input); input.focus();
  for (const [key, extra] of [["s", { ctrlKey: true }], ["p", { metaKey: true }], ["F9", {}], ["ArrowLeft", { altKey: true }], ["Shift", {}], ["Shift", {}]]) {
    assert.equal(h.key(key, { target: input, ...extra }).prevented, undefined);
  }
  assert.equal(h.byClass("repository-ide-search").hidden, true);
  assert.equal(h.calls.some(call => call.method === "PUT"), false);
  h.controller.dispose();
});

test("IDE run controls select only this repository’s Services configurations and follow shared process state", async () => {
  const configurations = [{ id: "c1", repositoryId: "repo-a", name: "API" }, { id: "c2", repositoryId: "repo-a", name: "Worker" }, { id: "other", repositoryId: "repo-b", name: "Other repo" }];
  let state = { repository: { id: "repo-a" }, configurations, selectedConfiguration: configurations[0], canRun: true, canDebug: true, canStop: false, label: "Stopped" };
  const actions = [], selected = [], configured = [];
  const h = harness({ getRunState: () => state, onRunSelect: (id, repositoryId) => { selected.push([id, repositoryId]); state.selectedConfiguration = configurations.find(item => item.id === id); }, onRunAction: (mode, id) => { actions.push([mode, id]); state = { ...state, currentProcess: { id: "p1", status: "starting" }, canRun: false, canDebug: false, canStop: true, label: "Starting" }; }, onRunConfigure: id => configured.push(id) });
  await h.controller.activate("repo-a");
  const picker = h.byClass("repository-ide-run-select");
  assert.deepEqual(picker.children.map(option => option.value), ["c1", "c2"]);
  picker.value = "c2"; picker.emit("change"); await flush();
  assert.deepEqual(selected, [["c2", "repo-a"]]); assert.equal(picker.value, "c2");
  h.button("Run selected Services configuration").click(); await flush();
  assert.deepEqual(actions, [["run", "repo-a"]]); assert.equal(h.button("Run selected Services configuration").disabled, true);
  assert.equal(h.button("Stop selected Services configuration").hidden, false); assert.equal(h.byClass("repository-ide-run-status").dataset.state, "starting");
  state = { ...state, currentProcess: null, canRun: true, canDebug: true, canStop: false }; h.controller.syncRunState();
  assert.equal(h.button("Run selected Services configuration").disabled, false); assert.equal(h.button("Stop selected Services configuration").hidden, true);
  state = { ...state, configurations: [], selectedConfiguration: null }; h.controller.syncRunState();
  assert.equal(picker.hidden, true); h.button("Configure this repository in Services").click(); await flush(); assert.deepEqual(configured, ["repo-a"]);
  await h.controller.activate("repo-b"); assert.equal(h.byClass("repository-ide-runtime").hidden, true, "stale A state must not appear in B");
  h.controller.dispose();
});

test("Run and Debug never silently execute an unsaved editor draft or save it automatically", async () => {
  const configurations = [{ id: "c1", repositoryId: "repo-a", name: "API" }], actions = [];
  const h = harness({ getRunState: () => ({ configurations, selectedConfiguration: configurations[0], canRun: true, canDebug: true, canStop: false }), onRunAction: (...args) => actions.push(args) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Unsaved.java"); h.edit("unsaved draft"); await h.controller.openFile("src/Clean.java");
  const run = h.button("Run selected Services configuration"), debug = h.button("Debug selected Services configuration");
  assert.equal(run.disabled, true); assert.equal(debug.disabled, true); assert.match(run.title, /Save all modified files/);
  run.click(); debug.click(); await flush(); assert.deepEqual(actions, []); assert.equal(h.calls.some(call => call.method === "PUT"), false);
  // Callback guards also protect a stale-enabled button from launching a newer draft.
  run.emit("click"); await flush(); assert.match(h.errors.at(-1).message, /No files were saved automatically/); assert.deepEqual(actions, []);
  await h.controller.deactivate();
});

test("IDE dependency Sync is compact, scoped, reports shared progress and never saves dirty files", async () => {
  const configurations = [{ id: "gradle-api", repositoryId: "repo-a", name: "Gradle API" }], actions = [];
  let state = { repository: { id: "repo-a" }, configurations, selectedConfiguration: configurations[0], canRun: true, canDebug: true, canSync: true, canStop: false, label: "Stopped" };
  const h = harness({ getRunState: () => state, onRunAction: (mode, id) => { actions.push([mode, id]); state = { ...state, canSync: false, canRun: false, canDebug: false, canStop: true, currentProcess: { status: "syncing" }, label: "Syncing" }; } });
  await h.controller.activate("repo-a");
  const sync = h.button("Sync project dependencies");
  assert.equal(sync.hidden, false); assert.equal(sync.disabled, false); assert.match(sync.title, /Gradle, Maven/);
  sync.click(); await flush();
  assert.deepEqual(actions, [["sync", "repo-a"]]); assert.equal(sync.getAttribute("aria-busy"), "true"); assert.equal(sync.disabled, true);
  assert.equal(h.byClass("repository-ide-run-status").dataset.state, "syncing");
  assert.equal(h.button("Stop selected Services configuration").hidden, false);
  state = { ...state, canSync: true, canRun: true, canDebug: true, canStop: false, currentProcess: null }; h.controller.syncRunState();
  await h.controller.openFile("build.gradle"); h.edit("unsaved build change");
  assert.equal(sync.disabled, true); assert.match(sync.title, /Save all modified files/);
  sync.emit("click"); await flush(); assert.match(h.errors.at(-1).message, /before syncing dependencies/); assert.equal(actions.length, 1);
  assert.equal(h.calls.some(call => call.method === "PUT"), false);
  await h.controller.activate("repo-b"); sync.emit("click"); await flush(); assert.equal(actions.length, 1);
  h.controller.dispose();
});

test("an IDE repository without a Services configuration can Sync while Run and Debug stay hidden", async () => {
  const actions = [], configured = [];
  const h = harness({ getRunState: () => ({ repository: { id: "repo-a" }, configurations: [], selectedConfiguration: null, canRun: false, canDebug: false, canSync: true, canStop: false }),
    onRunAction: (mode, id) => actions.push([mode, id]), onRunConfigure: id => configured.push(id) });
  await h.controller.activate("repo-a");
  const sync = h.button("Sync project dependencies");
  assert.equal(sync.hidden, false); assert.equal(sync.disabled, false);
  assert.equal(h.button("Run selected Services configuration").hidden, true); assert.equal(h.button("Debug selected Services configuration").hidden, true);
  sync.click(); await flush(); assert.deepEqual(actions, [["sync", "repo-a"]]);
  h.button("Configure this repository in Services").click(); await flush(); assert.deepEqual(configured, ["repo-a"]);
  h.controller.dispose();
});

test("terminal opens only from the bottom dock or shortcut, follows its repository, and restores tab focus", async () => {
  const mounted = [], toggles = []; let h;
  h = harness({ onTerminalMount: (slot, context) => mounted.push({ slot, ...context }),
    onTerminalToggle: context => { toggles.push(context); h.controller.syncTerminalState({ visible: true, repositoryId: context.repositoryId }); },
    onTerminalHide: () => h.controller.syncTerminalState({ visible: false, repositoryId: "repo-a" }) });
  await h.controller.activate("repo-a"); const slot = h.byClass("repository-ide-terminal-slot"), terminal = h.button("Show terminal");
  assert.equal(walk(h.byClass("repository-ide-toolbar")).some(node => /terminal/i.test(node.getAttribute("aria-label") || "")), false, "no duplicate terminal control in the top toolbar");
  assert.equal(walk(h.host).filter(node => node.dataset.tool === "terminal").length, 1);
  assert.equal(terminal.getAttribute("role"), "tab"); assert.equal(terminal.getAttribute("aria-controls"), slot.id);
  assert.equal(terminal.hidden, false); assert.equal(terminal.getAttribute("aria-selected"), "false");
  assert.match(terminal.title, /Ctrl\+`/);
  assert.equal(mounted[0].slot, slot); assert.equal(mounted[0].repositoryId, "repo-a"); assert.equal(slot.parentElement.className, "repository-ide-tool-content"); assert.equal(slot.parentElement.parentElement.parentElement.className, "repository-ide-main"); assert.equal(slot.hidden, true);
  terminal.click(); await flush(); assert.equal(toggles[0].repositoryId, "repo-a"); assert.equal(slot.hidden, false); assert.equal(terminal.getAttribute("aria-selected"), "true");
  toggles[0].returnFocus(); assert.equal(h.document.activeElement, terminal);
  const shellInput = h.document.createElement("textarea"); slot.append(shellInput); shellInput.focus();
  assert.equal(h.key("p", { ctrlKey: true, target: shellInput }).prevented, undefined, "terminal history shortcut must reach the PTY");
  assert.equal(h.key("s", { ctrlKey: true, target: shellInput }).prevented, undefined, "terminal flow-control shortcut must not save code");
  assert.equal(h.key("F9", { target: shellInput }).prevented, undefined);
  assert.equal(h.byClass("repository-ide-search").hidden, true);
  h.controller.syncTerminalState({ visible: true, repositoryId: "repo-b" }); assert.equal(slot.hidden, true);
  terminal.focus(); h.key("`", { ctrlKey: true, code: "Backquote" }); await flush(); assert.equal(toggles.length, 2);
  h.key("`", { metaKey: true, code: "Backquote" }); await flush(); assert.equal(slot.hidden, true); assert.equal(terminal.hidden, false); assert.equal(h.document.activeElement, terminal);
  h.key("`", { metaKey: true, code: "Backquote" }); await flush(); assert.equal(toggles.length, 3); assert.equal(slot.hidden, false);
  await h.controller.activate("repo-b"); assert.deepEqual(mounted.slice(1).map(({ slot, repositoryId }) => [Boolean(slot), repositoryId]), [[false, "repo-a"], [true, "repo-b"]]); assert.equal(slot.hidden, true);
  h.controller.dispose(); assert.deepEqual(mounted.at(-1), { slot: null, repositoryId: "repo-b" });
});

test("shared tools select one pane, preserve terminal/debug sessions, and stream only visible process logs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let h, hidden = 0, terminalStarts = 0;
  const state = { repository: { id: "repo-a", name: "Fixture" }, selectedConfiguration: { id: "c1", repositoryId: "repo-a" }, latestProcess: { id: "p1", configurationId: "c1", repositoryId: "repo-a", status: "running" } };
  h = harness({ getRunState: () => state,
    onTerminalToggle: context => { terminalStarts++; h.controller.syncTerminalState({ visible: true, repositoryId: context.repositoryId }); },
    onTerminalHide: () => { hidden++; h.controller.syncTerminalState({ visible: false, repositoryId: "repo-a" }); },
    api: (path, options, fallback) => path.includes("/processes/p1/logs?") ? { cursor: 1, logs: path.endsWith("after=0") ? [{ line: "Application started", stream: "stdout" }] : [], status: "running" } : fallback(path, options) });
  t.after(() => h.controller.dispose());
  await h.controller.activate("repo-a");
  const dock = h.byClass("repository-ide-tool-dock"), logs = h.byClass("repository-ide-run-logs"), terminal = h.byClass("repository-ide-terminal-slot"), debug = h.byClass("repository-ide-debug");
  assert.equal(dock.dataset.open, "false"); assert.equal(h.calls.some(call => call.path.includes("/logs?")), false);
  h.button("Show terminal").click(); await flush(); assert.equal(terminalStarts, 1); assert.equal(terminal.hidden, false);
  h.controller.showRunLogs(); await flush(); assert.equal(hidden, 1); assert.equal(terminal.hidden, true); assert.equal(logs.hidden, false); assert.equal(debug.hidden, true);
  assert.match(walk(logs).map(node => node.textContent).join(" "), /Application started/);
  h.button("Maximize tool panel").click(); await flush(); assert.equal(h.byClass("repository-ide-main").dataset.toolMaximized, "true");
  h.button("Hide tool panel (sessions keep running)").click(); await flush();
  assert.equal(dock.dataset.open, "false"); assert.equal(h.byClass("repository-ide-main").dataset.toolMaximized, "false");
  const count = h.calls.filter(call => call.path.includes("/logs?")).length; t.mock.timers.tick(5000); await flush(); assert.equal(h.calls.filter(call => call.path.includes("/logs?")).length, count);
  h.button("Show debugger").click(); await flush(); assert.equal(debug.hidden, false); assert.equal(logs.hidden, true); assert.equal(terminal.hidden, true);
  const tab = h.button("Show debugger"); tab.emit("keydown", { key: "ArrowLeft" }); await flush();
  assert.equal(h.document.activeElement, h.button("Show run logs")); assert.equal(logs.hidden, false);
  assert.equal(h.calls.some(call => call.method === "DELETE" || call.path.includes("/stop")), false, "tool switching never stops a session");
});

test("a breakpoint reveals the debugger from a hidden dock without losing editor content", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let stopped = false;
  const h = harness({ api: (path, options, fallback) => {
    const session = { id: "d1", state: stopped ? "stopped" : "attached", threadId: 1 };
    if (path.endsWith("/debug/status")) return { session, targets: [], adapters: [] };
    if (path.includes("/debug/events?")) return { session, cursor: 1, events: stopped ? [{ event: "stopped", body: { threadId: 1, reason: "breakpoint" } }] : [] };
    if (path.endsWith("/debug/command")) return options.body.command === "threads" ? { threads: [{ id: 1, name: "main" }] } : options.body.command === "stackTrace" ? { stackFrames: [{ id: 1, name: "Main.run", source: { path: "src/Main.java" }, line: 3, column: 1 }] } : { scopes: [] };
    return fallback(path, options);
  } });
  t.after(() => h.controller.dispose()); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); await h.controller.refreshDebug();
  h.button("Hide tool panel (sessions keep running)").click(); await flush();
  stopped = true; t.mock.timers.tick(1000); await flush(); await flush();
  assert.equal(h.byClass("repository-ide-tool-dock").dataset.open, "true"); assert.equal(h.byClass("repository-ide-debug").hidden, false);
  assert.equal(h.byClass("repository-ide-terminal-slot").hidden, true); assert.equal(h.byClass("repository-ide-run-logs").hidden, true);
  assert.match(walk(h.byClass("repository-ide-debug-stack")).map(node => node.textContent).join(" "), /Main.run/); assert.equal(h.editors.at(-1).getValue(), "class src/Main.java {}");
});

test("Debug launched from the toolbar attaches only the exact process and config and configures saved breakpoints", async (t) => {
  let session = null;
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/debug/status")) return { session, adapters: [{ id: "java-jdi", runtime: "java", available: true }], targets: [{ name: "Other", processId: "other", configurationId: "c1", runtime: "java", port: 5004, state: "listening" }, { name: "Requested", processId: "p1", configurationId: "c1", runtime: "java", port: 5005, state: "listening" }] };
    if (path.endsWith("/debug/attach")) { session = { id: "session-1", processId: "p1", port: options.body.port, state: "attached" }; return { session }; }
    if (path.endsWith("/debug/command")) return options.body.command === "setBreakpoints" ? { breakpoints: [{ verified: true, line: 4 }] } : {};
    return fallback(path, options);
  } });
  t.after(() => h.controller.dispose());
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 4, 1); h.key("F9"); await flush();
  assert.equal(await h.controller.attachLaunchedDebug({ id: "p1", configurationId: "c1", repositoryId: "repo-a", debug: { port: 5005 } }), true);
  assert.deepEqual(h.calls.find(call => call.path.endsWith("/debug/attach")).body, { adapterId: "java-jdi", port: 5005 });
  const commands = h.calls.filter(call => call.path.endsWith("/debug/command")).map(call => call.body.command);
  assert.ok(commands.indexOf("setBreakpoints") < commands.indexOf("configurationDone")); assert.equal(h.byClass("repository-ide-run-logs").hidden, false, "launch output stays visible until a breakpoint is hit"); assert.equal(h.byClass("repository-ide-debug").hidden, true);
  assert.equal(await h.controller.attachLaunchedDebug({ id: "p1", configurationId: "c1", repositoryId: "repo-a" }), true, "existing exact process session is reused");
  assert.equal(h.calls.filter(call => call.path.endsWith("/debug/attach")).length, 1);
  h.controller.dispose();
});

test("automatic debug attachment preserves another session and cancels a pending listener wait on repo switch", async () => {
  let waiting = false;
  const h = harness({ api: (path, options, fallback) => path.endsWith("/debug/status") ? { session: waiting ? null : { id: "existing", processId: "other", state: "attached" }, adapters: [], targets: [] } : fallback(path, options) });
  await h.controller.activate("repo-a");
  await assert.rejects(h.controller.attachLaunchedDebug({ id: "p1", configurationId: "c1", repositoryId: "repo-a" }), /another debugger is already attached/);
  assert.equal(h.calls.some(call => call.path.endsWith("/debug/attach")), false);
  waiting = true; const pending = h.controller.attachLaunchedDebug({ id: "p1", configurationId: "c1", repositoryId: "repo-a" }); await flush();
  await h.controller.activate("repo-b"); assert.equal(await pending, false); assert.equal(h.calls.some(call => call.path.endsWith("/debug/attach")), false);
  h.controller.dispose();
});

test("deactivation preserves drafts and tears down the editor; repositories retain separate buffers", async () => {
  const h = harness(); await h.controller.activate({ id: "repo-a" }); await h.controller.openFile("src/Main.java", 4, 2);
  h.edit("unsaved repository A"); assert.equal(h.controller.isDirty(), true);
  const previous = h.editors.at(-1), model = previous.model, frame = h.frames.at(-1);
  await h.controller.deactivate(); assert.equal(previous.disposed, true); assert.equal(model.disposed, true); assert.equal(frame.parentElement, null); assert.equal(h.controller.isDirty(), true);
  await h.controller.activate({ id: "repo-b" }); await h.controller.openFile("src/Main.java"); h.edit("unsaved repository B");
  await h.controller.activate({ id: "repo-a" }); assert.equal(h.editors.at(-1).getValue(), "unsaved repository A"); assert.deepEqual(h.editors.at(-1).getPosition(), { lineNumber: 4, column: 2 });
  assert.equal(h.controller.dispose(), false, "disposing must not silently discard drafts");
  assert.equal(h.document.defaultView.emit("beforeunload").prevented, true);
  await h.controller.deactivate();
});

test("diff navigation opens definitions and Back returns to the exact source position", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  const focusedBeforeReveal = h.document.activeElement;
  assert.equal(await h.controller.revealNavigation({ path: "src/Caller.java", line: 4, column: 7 }, { locations: [{ path: "src/Service.java", line: 8, column: 3 }] }), true);
  assert.equal(h.document.activeElement, focusedBeforeReveal, "reveal must not steal modal focus before the caller closes it");
  assert.equal(h.editors.at(-1).getValue(), "class src/Service.java {}");
  assert.deepEqual(h.editors.at(-1).getPosition(), { lineNumber: 8, column: 3 });
  h.button("Navigate back (Alt+Left)").click(); await flush();
  assert.equal(h.editors.at(-1).getValue(), "class src/Caller.java {}");
  assert.deepEqual(h.editors.at(-1).getPosition(), { lineNumber: 4, column: 7 });
  h.controller.dispose();
});

test("diff navigation keeps incomplete single matches and references in the result picker", async () => {
  for (const [kind, selectionRequired, title] of [["definition", true, "Definitions"], ["references", false, "References"], ["typeDefinition", true, "Type definitions"]]) {
    const h = harness(); await h.controller.activate("repo-a");
    await h.controller.openFile("src/Target.java"); h.edit("retained target draft");
    await h.controller.openDiff({ path: "src/Caller.java", before: "old", after: "current" });
    const count = h.calls.length;
    const result = { kind, selectionRequired, locations: [{ path: "src/Target.java", line: 3, column: 5 }], notice: "Some configuration files could not be checked." };
    assert.equal(await h.controller.revealNavigation({ path: "src/Caller.java", line: 4, column: 7, expectedHash: "src/Caller.java-v1" }, result), true);
    assert.equal(h.controller.getNavigationState().path, "src/Caller.java");
    assert.equal(h.byClass("repository-ide-results").children[0].children[0].textContent, `${title} (1)`);
    assert.equal(h.byClass("repository-ide-results").hidden, false);
    assert.equal(h.calls.slice(count).some(call => call.path.includes("path=src%2FTarget.java")), false, "unselected target is never refreshed");
    assert.equal(h.controller.isDirty(), true);
    h.setDiscard(true); h.controller.dispose();
  }
});

test("diff navigation preserves dirty IDE buffers and rejects a closed diff during a file load", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Service.java"); h.edit("my unsaved service");
  await assert.rejects(h.controller.revealNavigation({ path: "src/Caller.java", line: 4, column: 7 }, { locations: [{ path: "src/Service.java", line: 8, column: 3 }] }), /unsaved IDE edits/);
  assert.equal(h.editors.at(-1).getValue(), "my unsaved service"); await h.controller.deactivate();
  const file = deferred(); let valid = true;
  const pending = harness({ api: (path, options, fallback) => path.includes("/file?") ? file.promise : fallback(path, options) });
  await pending.controller.activate("repo-a");
  const reveal = pending.controller.revealNavigation({ path: "src/Caller.java", line: 4, column: 7 }, { locations: [{ path: "src/Service.java", line: 8, column: 3 }] }, () => valid);
  valid = false; file.resolve({ path: "src/Caller.java", content: "caller", contentHash: "hash" });
  assert.equal(await reveal, false); assert.equal(pending.editors.at(-1).model, null); pending.controller.dispose();
});

test("diff navigation rechecks the original saved hash after lazy editor loading", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  await assert.rejects(h.controller.revealNavigation({ path: "src/Caller.java", line: 4, column: 7, expectedHash: "outdated" }, { locations: [{ path: "src/Service.java", line: 8, column: 3 }] }), /changed while opening/);
  assert.equal(h.editors.at(-1).model, null); h.controller.dispose();
});

test("lazy diff activation restores retained tabs without stealing dialog focus", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Caller.java");
  await h.controller.deactivate();
  const dialog = new Element(h.document, "dialog"); dialog.focus();
  await h.controller.activate("repo-a", { focus: false });
  assert.equal(h.document.activeElement, dialog);
  assert.equal(await h.controller.revealNavigation({ path: "src/Caller.java", line: 4, column: 7 }, { locations: [{ path: "src/Service.java", line: 8, column: 3 }] }), true);
  assert.equal(h.document.activeElement, dialog);
  h.controller.focus(); assert.notEqual(h.document.activeElement, dialog);
  h.controller.dispose();
});

test("embedded diff uses read-only snapshot models and Back restores the unsaved source buffer", async () => {
  const navigation = [], h = harness({ onNavigationChange: (at) => navigation.push(at) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 7, 4); h.edit("unsaved source");
  const sourceModel = h.editors.at(-1).model;
  await h.controller.openDiff({ path: "src/Main.java", before: "old source", after: "new source", beforeLabel: "HEAD", afterLabel: "Working tree", staged: false });
  const diff = h.diffEditors.at(-1);
  assert.equal(diff.options.readOnly, true); assert.equal(diff.options.originalEditable, false);
  assert.equal(diff.models.original.getValue(), "old source"); assert.equal(diff.models.modified.getValue(), "new source");
  assert.equal(sourceModel.getValue(), "unsaved source"); assert.equal(h.controller.isDirty(), true);
  assert.equal(h.button("Save file (⌘S / Ctrl+S)").disabled, true);
  h.key("s", { metaKey: true }); await flush(); assert.equal(h.calls.some((call) => call.method === "PUT"), false);
  assert.deepEqual(h.controller.getNavigationState(), { surface: "diff", path: "src/Main.java", line: 1, column: 1, staged: false });
  assert.equal(navigation.at(-1).surface, "diff");
  h.button("Return to the file open before this diff").click(); await flush();
  assert.equal(h.editors.at(-1).model, sourceModel); assert.equal(sourceModel.getValue(), "unsaved source");
  assert.deepEqual(h.editors.at(-1).getPosition(), { lineNumber: 7, column: 4 });
  assert.equal(h.byClass("repository-ide-position").textContent, "Ln 7, Col 4");
  assert.equal(h.button("Save file (⌘S / Ctrl+S)").disabled, false);
  await h.controller.deactivate(); assert.equal(diff.disposed, true); assert.equal(diff.models.original.disposed, true); assert.equal(diff.models.modified.disposed, true);
});

const verifiedDiffChange = (id = "a", options = {}) => ({ id: id.repeat(64), beforeStart: 1, beforeCount: 1, afterStart: 1, afterCount: 1, ...options });
const verifiedDiff = (options = {}) => ({ path: "src/Main.java", before: "old\nsecond\nthird", after: "new\nsecond\nthird", changes: [verifiedDiffChange()], revert: { allowed: true, revision: "f".repeat(64) }, ...options });

test("embedded diffs render only server-issued change controls in the modified gutter, including EOF and empty-file deletions", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  await h.controller.openDiff(verifiedDiff({ changes: [verifiedDiffChange(), verifiedDiffChange("b", { afterStart: 4, afterCount: 0 }), verifiedDiffChange("a"), verifiedDiffChange("not-an-id"), verifiedDiffChange("c", { afterStart: 0 }), verifiedDiffChange("d", { beforeCount: 0, afterCount: 0 })], onRevertChange() {} }));
  const diff = h.diffEditors.at(-1), widgets = diff.modified.glyphWidgets;
  assert.equal(diff.options.glyphMargin, true); assert.equal(diff.options.renderMarginRevertIcon, false); assert.equal(diff.options.renderGutterMenu, false); assert.equal(diff.options.ignoreTrimWhitespace, false);
  assert.equal(diff.original.glyphWidgets.length, 0); assert.equal(widgets.length, 2);
  assert.deepEqual(widgets.map(widget => widget.getPosition().range.coordinates), [[1, 1, 1, 1], [3, 1, 3, 1]]);
  assert.ok(widgets.every(widget => widget.getPosition().lane === 3));
  assert.match(widgets[1].getDomNode().getAttribute("aria-label"), /Revert this change near line 4/);
  await h.controller.openDiff(verifiedDiff({ after: "", staged: true, changes: [verifiedDiffChange("e", { afterCount: 0 })], onRevertChange() {} }));
  assert.ok(widgets.every(widget => !diff.modified.glyphWidgets.includes(widget)), "replacing a diff unregisters every old gutter widget");
  const stagedWidget = h.diffEditors.at(-1).modified.glyphWidgets[0];
  assert.deepEqual(stagedWidget.getPosition().range.coordinates, [1, 1, 1, 1]); assert.match(stagedWidget.getDomNode().title, /Unstage this change near line 1/);
  const latest = h.diffEditors.at(-1); await h.controller.deactivate(); assert.equal(latest.modified.glyphWidgets.length, 0); h.controller.dispose();
});

test("inline change controls refuse unavailable or unverified revert metadata and explain why", async () => {
  const h = harness(); await h.controller.activate("repo-a"); const attempts = [];
  for (const revert of [{ allowed: false, reason: "File is a symbolic link", revision: "f".repeat(64) }, { allowed: true, revision: "not-verified" }, undefined]) {
    await h.controller.openDiff(verifiedDiff({ revert, onRevertChange: id => attempts.push(id) }));
    const button = h.diffEditors.at(-1).modified.glyphWidgets[0].getDomNode();
    assert.equal(button.disabled, true); assert.match(button.title, /symbolic link|verified disk revision|cannot be changed safely/); button.click();
  }
  await h.controller.openDiff(verifiedDiff()); assert.equal(h.diffEditors.at(-1).modified.glyphWidgets[0].getDomNode().disabled, true);
  await flush(); assert.deepEqual(attempts, []); h.controller.dispose();
});

test("inline revert serializes clicks, keeps snapshots immutable, allows cancellation and invalidates an applied snapshot", async () => {
  const h = harness(), pending = deferred(), attempts = []; let current, applied = false;
  await h.controller.activate("repo-a"); await h.controller.openDiff(verifiedDiff({ changes: [verifiedDiffChange(), verifiedDiffChange("b", { afterStart: 3 })], onRevertChange: async (id, valid) => { attempts.push(id); current = valid; await pending.promise; return applied ? { applied: true } : false; } }));
  const diff = h.diffEditors.at(-1), buttons = diff.modified.glyphWidgets.map(widget => widget.getDomNode());
  buttons[0].click(); await flush(); assert.equal(current(), true); assert.ok(buttons.every(button => button.disabled)); assert.equal(buttons[0].getAttribute("aria-busy"), "true");
  buttons[0].click(); buttons[1].click(); await flush(); assert.deepEqual(attempts, ["a".repeat(64)]);
  pending.resolve(); await flush(); assert.ok(buttons.every(button => !button.disabled), "cancelled confirmation leaves the verified snapshot reusable");
  applied = true; buttons[1].click(); await flush(); assert.deepEqual(attempts, ["a".repeat(64), "b".repeat(64)]);
  assert.ok(buttons.every(button => button.disabled)); assert.match(buttons[0].title, /out of date/);
  assert.equal(diff.models.original.getValue(), "old\nsecond\nthird"); assert.equal(diff.models.modified.getValue(), "new\nsecond\nthird");
  assert.equal(h.calls.some(call => call.method === "PUT"), false); h.controller.dispose();
});

test("uncertain change outcomes disable old widgets and navigation invalidates a pending action even after returning", async () => {
  const h = harness(), pending = deferred(); let valid;
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  await h.controller.openDiff(verifiedDiff({ onRevertChange: async (_id, current) => { valid = current; await pending.promise; return { invalidated: true, reason: "Refresh before retrying this uncertain request." }; } }));
  const diff = h.diffEditors.at(-1), button = diff.modified.glyphWidgets[0].getDomNode(); button.click(); await flush(); assert.equal(valid(), true);
  await h.controller.openFile("src/Main.java"); assert.equal(valid(), false);
  h.button("src/Main.java changes").click(); await flush(); assert.equal(valid(), false, "leaving and returning cannot revive the old in-flight action");
  pending.resolve(); await flush(); assert.equal(button.disabled, true); assert.match(button.title, /uncertain request/);
  h.button("Close changes for src/Main.java").click(); await flush(); assert.equal(diff.modified.glyphWidgets.length, 0); h.controller.dispose();
});

test("late failures from disposed diff actions cannot affect the replacement diff", async () => {
  const h = harness(), pending = deferred(); let valid;
  await h.controller.activate("repo-a"); await h.controller.openDiff(verifiedDiff({ onRevertChange: async (_id, current) => { valid = current; await pending.promise; throw new Error("Old failed request"); } }));
  const previous = h.diffEditors.at(-1), oldWidget = previous.modified.glyphWidgets[0]; oldWidget.getDomNode().click(); await flush();
  await h.controller.openDiff(verifiedDiff({ path: "src/Other.java", onRevertChange() {} })); const next = h.diffEditors.at(-1);
  assert.equal(valid(), false); assert.equal(previous.modified.glyphWidgets.includes(oldWidget), false);
  pending.resolve(); await flush(); assert.equal(next.modified.glyphWidgets[0].getDomNode().disabled, false); assert.deepEqual(h.errors, []); h.controller.dispose();
});

test("invalidating a clean saved file defers its disk reread until opened and preserves the caret", async () => {
  let content = "old content", hash = "old-hash";
  const h = harness({ api: (path, options, fallback) => path.includes("/file?") ? { path: "src/Main.java", content, contentHash: hash, language: "java" } : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 7, 4); const model = h.editors.at(-1).model;
  await h.controller.openDiff(verifiedDiff()); const reads = h.calls.filter(call => call.path.includes("/file?")).length;
  content = "new disk content"; hash = "new-hash";
  assert.equal(h.controller.invalidateSavedFile("repo-a", "src/Main.java"), true); assert.equal(model.getValue(), "old content");
  assert.equal(h.calls.filter(call => call.path.includes("/file?")).length, reads, "invalidation performs no IO");
  h.button("Return to the file open before this diff").click(); await flush();
  assert.equal(model.getValue(), content); assert.equal(h.controller.isFileDirty("repo-a", "src/Main.java"), false); assert.deepEqual(h.editors.at(-1).getPosition(), { lineNumber: 7, column: 4 });
  assert.equal(h.controller.invalidateSavedFile("repo-b", "src/Main.java"), false); assert.equal(h.controller.invalidateSavedFile("repo-a", "not-open.java"), false);
  h.edit("unsaved draft"); assert.equal(h.controller.isFileDirty("repo-a", "src/Main.java"), true); assert.equal(h.controller.isFileDirty("repo-b", "src/Main.java"), false);
  assert.equal(h.controller.invalidateSavedFile("repo-a", "src/Main.java"), false); assert.equal(model.getValue(), "unsaved draft");
  h.edit(content); h.controller.dispose();
});

test("a delayed disk reread cannot overwrite newer unsaved edits or a newer invalidation", async () => {
  for (const edit of [true, false]) {
    const pending = deferred(); let read = 0;
    const h = harness({ api: (path, options, fallback) => path.includes("/file?") && ++read === 2 ? pending.promise : fallback(path, options) });
    await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); const model = h.editors.at(-1).model;
    h.controller.invalidateSavedFile("repo-a", "src/Main.java"); const opening = h.controller.openFile("src/Main.java"); await flush();
    if (edit) h.edit("new unsaved draft"); else h.controller.invalidateSavedFile("repo-a", "src/Main.java");
    pending.resolve({ content: "stale disk read", contentHash: "stale-hash" });
    if (edit) { await assert.rejects(opening, /unsaved draft has been preserved/); assert.equal(model.getValue(), "new unsaved draft"); h.edit("class src/Main.java {}"); }
    else { assert.equal(await opening, false); assert.equal(model.getValue(), "class src/Main.java {}"); }
    h.controller.dispose();
  }
});

test("embedded diff navigation validates through the supplied callback and Back returns to the clicked diff position", async () => {
  const h = harness(), received = [];
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Initial.java", 9, 2);
  await h.controller.openDiff({ path: "src/Caller.java", before: "old", after: "current", staged: true, onNavigate: async (at, valid) => {
    received.push(at); assert.equal(valid(), true);
    assert.equal(await h.controller.revealNavigation({ path: at.path, line: at.line, column: at.column, expectedHash: "src/Caller.java-v1" }, { locations: [{ path: "src/Target.java", line: 12, column: 6 }] }, valid), true);
  } });
  const diff = h.diffEditors.at(-1); diff.modified.setPosition({ lineNumber: 4, column: 3 });
  await diff.modified.actions.get("argus.diff.definition").run();
  assert.deepEqual(received, [{ side: "after", path: "src/Caller.java", line: 4, column: 3, word: "method", kind: "definition" }]);
  assert.deepEqual(h.controller.getNavigationState(), { surface: "file", path: "src/Target.java", line: 12, column: 6 });
  h.button("Navigate back (Alt+Left)").click(); await flush();
  assert.deepEqual(h.controller.getNavigationState(), { surface: "diff", path: "src/Caller.java", line: 4, column: 3, staged: true });
  h.button("Navigate forward (Alt+Right)").click(); await flush(); assert.equal(h.controller.getNavigationState().path, "src/Target.java");
  h.controller.dispose();
});

test("Cmd/Ctrl clicks inside a diff word send its start column so the saved-file resolver accepts the symbol", async () => {
  const h = harness(), content = `${" ".repeat(29)}greet(user);`, hits = [], resolved = [];
  await h.controller.activate("repo-a");
  await h.controller.openDiff({ path: "src/Caller.ts", before: "", after: content, onNavigate: (hit) => {
    hits.push(hit); resolved.push(resolveDiffNavigationPosition({ file: "src/Caller.ts", beforeContent: "", afterContent: content }, hit, content));
  } });
  const diff = h.diffEditors.at(-1);
  diff.models.modified.getWordAtPosition = at => at.lineNumber === 1 && at.column >= 30 && at.column <= 35 ? { word: "greet", startColumn: 30, endColumn: 35 } : null;
  for (const modifier of ["metaKey", "ctrlKey"]) {
    diff.modified.mouse({ target: { type: 6, position: { lineNumber: 1, column: 34 } }, event: { [modifier]: true } }); await flush();
  }
  for (const kind of ["references", "implementation", "declaration", "typeDefinition"]) await diff.modified.actions.get(`argus.diff.${kind}`).run();
  assert.deepEqual(hits.map(hit => hit.kind), ["definition", "definition", "references", "implementation", "declaration", "typeDefinition"]);
  for (const hit of hits) assert.deepEqual({ ...hit, kind: undefined }, { side: "after", path: "src/Caller.ts", line: 1, column: 30, word: "greet", kind: undefined });
  for (const location of resolved) assert.deepEqual(location, { path: "src/Caller.ts", line: 1, column: 30 });
  assert.equal(h.controller.getNavigationState().column, 34, "the diff caret still remembers the user's actual click position");
  assert.deepEqual(h.errors, []); h.controller.dispose();
});

test("diff configuration references retain the full key when clicked on dots and hyphens", async () => {
  const h = harness(), content = '@Value("${orders.timeout-ms:30}") int timeout;', hits = [];
  await h.controller.activate("repo-a");
  await h.controller.openDiff({ path: "src/Config.java", before: "", after: content, onNavigate: hit => hits.push(hit) });
  const diff = h.diffEditors.at(-1); diff.models.modified.word = null;
  for (const separator of [".", "-"]) {
    diff.modified.mouse({ target: { type: 6, position: { lineNumber: 1, column: content.indexOf(separator) + 1 } }, event: { metaKey: true } }); await flush();
  }
  assert.equal(hits.length, 2);
  for (const hit of hits) {
    assert.deepEqual(hit, { side: "after", path: "src/Config.java", line: 1, column: 11, word: "orders.timeout-ms", kind: "definition" });
    assert.deepEqual(resolveDiffNavigationPosition({ file: "src/Config.java", afterContent: content }, hit, content), { path: "src/Config.java", line: 1, column: 11 });
  }
  h.controller.dispose();
});

test("JavaScript template members remain ordinary language-server targets, not Spring property keys", async () => {
  const h = harness(), content = 'const label = `${customer.name}`;', hits = [];
  await h.controller.activate("repo-a");
  await h.controller.openDiff({ path: "src/Caller.ts", before: "", after: content, onNavigate: hit => hits.push(hit) });
  const diff = h.diffEditors.at(-1), column = content.indexOf("name") + 1;
  diff.models.modified.getWordAtPosition = () => ({ word: "name", startColumn: column, endColumn: column + 4 });
  diff.modified.mouse({ target: { type: 6, position: { lineNumber: 1, column: column + 1 } }, event: { metaKey: true } }); await flush();
  assert.deepEqual(hits, [{ side: "after", path: "src/Caller.ts", line: 1, column, word: "name", kind: "definition" }]);
  h.controller.dispose();
});

test("closing or leaving an embedded diff invalidates pending navigation without replacing the selected file", async () => {
  const pending = deferred(), h = harness(); let valid;
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  await h.controller.openDiff({ path: "src/Main.java", before: "old", after: "current", onNavigate: async (_at, isCurrent) => { valid = isCurrent; await pending.promise; if (isCurrent()) await h.controller.openFile("src/Wrong.java"); } });
  const diff = h.diffEditors.at(-1), navigation = diff.modified.actions.get("argus.diff.definition").run(); await flush();
  assert.equal(valid(), true);
  await h.controller.openFile("src/Chosen.java"); assert.equal(valid(), false); pending.resolve(); await navigation;
  assert.equal(h.controller.getNavigationState().path, "src/Chosen.java");
  h.button("Close changes for src/Main.java").click(); await flush(); assert.equal(diff.disposed, true);
  assert.equal(h.byClass("repository-ide-diff-tab"), undefined);
  await h.controller.openDiff({ path: "src/Reopened.java", before: "old", after: "fresh" });
  const reopened = h.diffEditors.at(-1);
  assert.notEqual(reopened, diff); assert.equal(reopened.disposed, false);
  assert.equal(reopened.models.modified.getValue(), "fresh");
  await h.controller.openFile("src/Chosen.java"); await h.controller.deactivate();
  assert.equal(reopened.disposed, true, "a hidden diff control is released when the IDE is disabled");
  assert.equal(reopened.models.original.disposed, true); assert.equal(reopened.models.modified.disposed, true);
  h.controller.dispose();
});

test("diff snapshots without a resolver do not send historical coordinates to language servers", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  await h.controller.openDiff({ path: "src/Main.java", before: "old", after: "historical" });
  await h.diffEditors.at(-1).modified.actions.get("argus.diff.definition").run();
  assert.match(h.byClass("repository-ide-notice").textContent, /unavailable for this snapshot/);
  assert.equal(h.calls.some((call) => call.path.endsWith("/navigate")), false);
  h.controller.dispose();
});

test("opening a second diff reuses Monaco while releasing old models and history entries", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 6, 1);
  await h.controller.openDiff({ path: "src/First.java", before: "a", after: "b" }); const first = h.diffEditors.at(-1), oldModels = first.models;
  await h.controller.openDiff({ path: "src/Second.java", before: "c", after: "d" });
  assert.equal(h.diffEditors.length, 1); assert.equal(h.diffEditors.at(-1), first); assert.equal(first.disposed, false);
  assert.equal(oldModels.original.disposed, true); assert.equal(oldModels.modified.disposed, true);
  assert.equal(first.models.modified.getValue(), "d"); assert.equal(first.options.ariaLabel, "Changes for src/Second.java");
  h.button("Navigate back (Alt+Left)").click(); await flush();
  assert.deepEqual(h.controller.getNavigationState(), { surface: "file", path: "src/Main.java", line: 6, column: 1 });
  h.controller.dispose();
});

test("a visible diff does not wait for ancestor folders to load", async () => {
  const folder = deferred();
  const h = harness({ api: (path, options, fallback) => {
    if (path.includes("/tree?")) {
      const directory = new URL(path, "http://local").searchParams.get("path");
      return directory === "src" ? folder.promise : { entries: [{ path: "src", name: "src", directory: true }] };
    }
    return fallback(path, options);
  } });
  await h.controller.activate("repo-a");
  assert.equal(await h.controller.openDiff({ path: "src/A.java", before: "a", after: "b" }), true);
  assert.equal(h.controller.getNavigationState().path, "src/A.java");
  assert.ok(h.calls.some(call => call.path.endsWith("/tree?path=src")));
  folder.resolve({ entries: [{ path: "src/A.java", name: "A.java", directory: false }] });
  await flush(); h.controller.dispose();
});

test("restoring file and diff locations keeps saved caret positions and rejects invalidated restores", async () => {
  const h = harness(); assert.equal(await h.controller.restoreLocation({ path: "src/Main.java" }), false);
  await h.controller.activate("repo-a");
  assert.equal(await h.controller.restoreLocation({ path: "src/Main.java", line: 8, column: 4 }), true);
  assert.deepEqual(h.controller.getNavigationState(), { surface: "file", path: "src/Main.java", line: 8, column: 4 });
  assert.equal(await h.controller.restoreLocation({ path: "src/Other.java" }, () => false), false);
  assert.equal(h.controller.getNavigationState().path, "src/Main.java");
  assert.equal(await h.controller.openDiff({ path: "src/Main.java", before: "old", after: "new", line: 6, column: 2 }), true);
  assert.deepEqual(h.controller.getNavigationState(), { surface: "diff", path: "src/Main.java", line: 6, column: 2, staged: false });
  h.controller.dispose();
});

test("user cursor movement replaces its navigation state after a debounce and is cancelled on deactivation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes = [], h = harness({ onNavigationChange: (...args) => changes.push(args) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); changes.length = 0;
  const editor = h.editors.at(-1);
  for (const line of [3, 6]) { editor.setPosition({ lineNumber: line, column: 2 }); editor.cursor({ position: editor.getPosition(), source: "mouse" }); }
  t.mock.timers.tick(100); await flush();
  assert.deepEqual(changes, [[{ surface: "file", path: "src/Main.java", line: 6, column: 2 }, { replace: true }]]);
  editor.setPosition({ lineNumber: 9, column: 2 }); editor.cursor({ position: editor.getPosition(), source: "mouse" });
  await h.controller.deactivate(); t.mock.timers.tick(100); await flush(); assert.equal(changes.length, 1); h.controller.dispose();
});

test("trusted editor iframe input forwards user activity while synthetic input and modifier-only presses do not", async () => {
  const h = harness(), activity = []; h.document.addEventListener("argus-ide-user-activity", event => activity.push(event.detail));
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); const frame = h.frames.at(-1).contentDocument;
  frame.emit("pointerdown"); frame.emit("keydown", { key: "x" }); frame.emit("keydown", { key: "Shift", isTrusted: true }); assert.equal(activity.length, 0);
  frame.emit("pointerdown", { isTrusted: true }); frame.emit("keydown", { key: "ArrowRight", isTrusted: true });
  assert.deepEqual(activity, [{ type: "pointerdown", key: "" }, { type: "keydown", key: "ArrowRight" }]);
  await h.controller.deactivate(); frame.emit("pointerdown", { isTrusted: true }); assert.equal(activity.length, 2); h.controller.dispose();
});

test("save uses the disk hash and edits made during an in-flight save remain dirty", async () => {
  const save = deferred();
  const h = harness({ api: (path, options, fallback) => path.endsWith("/file") && options.method === "PUT" ? save.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); h.edit("submitted version");
  h.key("s", { metaKey: true }); await flush();
  const write = h.calls.find((item) => item.method === "PUT"); assert.deepEqual(write.body, { path: "src/Main.java", content: "submitted version", expectedHash: "src/Main.java-v1" });
  h.edit("newer version"); save.resolve({ contentHash: "saved-v2" }); await flush();
  assert.equal(h.controller.isDirty(), true); assert.equal(h.editors.at(-1).getValue(), "newer version"); assert.deepEqual(h.saved, [{ repositoryId: "repo-a", path: "src/Main.java" }]);
  await h.controller.deactivate();
});

test("repository-scoped dirty checks include retained drafts in hidden repositories", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); h.edit("unsaved A");
  await h.controller.activate("repo-b"); await h.controller.openFile("src/Main.java");
  assert.equal(h.controller.isDirty(), true); assert.equal(h.controller.isDirty("repo-a"), true); assert.equal(h.controller.isDirty("repo-b"), false); assert.equal(h.controller.isDirty("missing-repository"), false);
  await h.controller.deactivate(); assert.equal(h.controller.isDirty("repo-a"), true); assert.equal(h.controller.isDirty("repo-b"), false);
  await h.controller.activate("repo-a"); h.key("s", { metaKey: true }); await flush();
  assert.equal(h.controller.isDirty("repo-a"), false); assert.equal(h.controller.isDirty(), false); h.controller.dispose();
});

test("native dirty signal stays accurate when a save finishes after the editor is hidden", async () => {
  const save = deferred();
  const h = harness({ api: (path, options, fallback) => path.endsWith("/file") && options.method === "PUT" ? save.promise : fallback(path, options) });
  assert.equal(h.document.documentElement.dataset.argusIdeDirty, "false");
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); h.edit("draft");
  assert.equal(h.document.documentElement.dataset.argusIdeDirty, "true");
  h.key("s", { metaKey: true }); await flush(); await h.controller.deactivate();
  assert.equal(h.document.documentElement.dataset.argusIdeDirty, "true");
  save.resolve({ contentHash: "saved-v2" }); await flush();
  assert.equal(h.document.documentElement.dataset.argusIdeDirty, "false"); h.controller.dispose();
});

test("external Git changes reload clean tabs without focus/history changes and refresh the tree", async () => {
  let version = 1;
  const navigation = [];
  const h = harness({ onNavigationChange: value => navigation.push(value), api: (path, options, fallback) => path.includes("/file?")
    ? { content: `disk version ${version}`, contentHash: `v${version}`, language: "java" } : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 3, 4);
  const editor = h.editors.at(-1), priorPosition = editor.getPosition(), navigationCount = navigation.length;
  const focus = new Element(h.document, "textarea"); h.host.append(focus); focus.focus();
  const trees = h.calls.filter(call => call.path.includes("/tree?")).length;
  version++;
  const result = await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java", "src/Main.java", "not-open.java"] });
  assert.deepEqual(result, { reloaded: ["src/Main.java"], closed: [], preserved: [], failed: [] });
  assert.equal(editor.getValue(), "disk version 2"); assert.equal(h.controller.isDirty(), false);
  assert.deepEqual(editor.getPosition(), priorPosition); assert.equal(h.document.activeElement, focus);
  assert.equal(navigation.length, navigationCount, "refresh is not a new navigation entry");
  assert.ok(h.calls.filter(call => call.path.includes("/tree?")).length > trees);
  assert.equal(h.calls.some(call => call.method === "PUT"), false);
  h.controller.dispose();
});

test("external delete closes only clean buffers confirmed absent and keeps concurrently recreated files", async () => {
  const missing = new Set(); let version = 1;
  const h = harness({ api: (path, options, fallback) => {
    if (!path.includes("/file?")) return fallback(path, options);
    const name = new URL(path, "http://local").searchParams.get("path");
    if (missing.has(name)) throw Object.assign(new Error("Not found"), { status: 404 });
    return { content: `${name} disk ${version}`, contentHash: `${name}-v${version}`, language: "java" };
  } });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Deleted.java"); await h.controller.openFile("src/Recreated.java");
  missing.add("src/Deleted.java"); version++;
  const result = await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Deleted.java", "src/Recreated.java"] });
  assert.deepEqual(result.closed, ["src/Deleted.java"]); assert.deepEqual(result.reloaded, ["src/Recreated.java"]);
  assert.equal(h.button("src/Deleted.java"), undefined); assert.equal(h.editors.at(-1).getValue(), "src/Recreated.java disk 2");
  missing.add("src/Recreated.java");
  await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Recreated.java"] });
  assert.equal(h.button("src/Recreated.java"), undefined); assert.equal(h.editors.at(-1).model, null);
  assert.equal(h.byClass("repository-ide-editor-empty").hidden, false); assert.equal(h.controller.isDirty(), false);
  h.controller.dispose();
});

test("external changes explicitly invalidate affected diffs without moving focus/history or discarding source drafts", async () => {
  const navigations = [], changed = [], jumped = [];
  const h = harness({ onNavigationChange: value => navigations.push(value) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 4, 3);
  const source = h.editors.at(-1); h.edit("retained source draft");
  await h.controller.openDiff(verifiedDiff({ onRevertChange: id => changed.push(id), onNavigate: at => jumped.push(at) }));
  const diff = h.diffEditors.at(-1), widget = diff.modified.glyphWidgets[0].getDomNode();
  const focus = new Element(h.document, "textarea"); h.host.append(focus); focus.focus();
  const before = h.controller.getNavigationState(), count = navigations.length;
  const backDisabled = h.button("Navigate back (Alt+Left)").disabled, forwardDisabled = h.button("Navigate forward (Alt+Right)").disabled;
  const result = await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] });
  assert.deepEqual(result.preserved, ["src/Main.java"]); assert.equal(source.getValue(), "retained source draft");
  assert.deepEqual(h.controller.getNavigationState(), before); assert.equal(navigations.length, count); assert.equal(h.document.activeElement, focus);
  assert.equal(h.button("Navigate back (Alt+Left)").disabled, backDisabled); assert.equal(h.button("Navigate forward (Alt+Right)").disabled, forwardDisabled);
  assert.match(h.button("src/Main.java changes").textContent, /Out of date/); assert.match(h.byClass("repository-ide-path").textContent, /Out of date/);
  assert.match(h.byClass("repository-ide-notice").textContent, /Close this tab and reopen it from Version Control/);
  assert.equal(widget.disabled, true); widget.click();
  for (const kind of ["definition", "references", "implementation", "declaration", "typeDefinition"]) await diff.modified.actions.get(`argus.diff.${kind}`).run();
  for (const [side, editor] of [["before", diff.original], ["after", diff.modified]]) await editor.actions.get(`argus.codeDiscussion.${side}`).run();
  await flush(); assert.deepEqual(changed, []); assert.deepEqual(jumped, []);
  assert.equal(h.calls.some(call => call.method === "PUT" || call.path.endsWith("/code-discussions/ask")), false);
  assert.equal(diff.models.original.getValue(), "old\nsecond\nthird"); assert.equal(diff.models.modified.getValue(), "new\nsecond\nthird");
  assert.ok(h.button("Close changes for src/Main.java"), "the stale snapshot has a direct Close action");
  await h.controller.openDiff(verifiedDiff({ after: "fresh disk", onRevertChange: id => changed.push(id) }));
  assert.doesNotMatch(h.byClass("repository-ide-path").textContent, /Out of date/);
  assert.equal(h.diffEditors.at(-1).modified.glyphWidgets[0].getDomNode().disabled, false, "reopening with a new snapshot restores verified actions");
  h.setDiscard(true); h.controller.dispose();
});

test("diff invalidation is scoped to the affected path and repository and persists when returning to a hidden diff", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  await h.controller.openDiff(verifiedDiff({ onRevertChange() {} }));
  const diff = h.diffEditors.at(-1), widget = diff.modified.glyphWidgets[0].getDomNode();
  await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Other.java"] });
  await h.controller.refreshAfterExternalChange("repo-b", { paths: ["src/Main.java"] });
  assert.equal(widget.disabled, false); assert.doesNotMatch(h.button("src/Main.java changes").textContent, /Out of date/);
  await h.controller.openFile("src/Other.java"); const before = h.controller.getNavigationState();
  await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] });
  assert.deepEqual(h.controller.getNavigationState(), before); assert.equal(widget.disabled, true);
  h.button("src/Main.java changes").click(); await flush();
  assert.match(h.byClass("repository-ide-path").textContent, /Out of date/); assert.match(h.byClass("repository-ide-notice").textContent, /reopen it from Version Control/);
  await h.controller.activate("repo-b"); await h.controller.openDiff(verifiedDiff({ onRevertChange() {} }));
  await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] });
  assert.equal(h.diffEditors.at(-1).modified.glyphWidgets[0].getDomNode().disabled, false, "late old-repository refresh cannot invalidate the replacement diff");
  h.controller.dispose();
});

test("external invalidation cancels validity of pending diff actions before any disk read finishes", async () => {
  const pending = deferred(), action = deferred(); let reading = false, valid;
  const h = harness({ api: (path, options, fallback) => reading && path.includes("/file?") ? pending.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  await h.controller.openDiff(verifiedDiff({ onRevertChange: async (_id, isValid) => { valid = isValid; await action.promise; return false; } }));
  const diff = h.diffEditors.at(-1); diff.modified.glyphWidgets[0].getDomNode().click(); await flush(); assert.equal(valid(), true);
  reading = true; const refresh = h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] });
  assert.equal(valid(), false); assert.match(h.byClass("repository-ide-path").textContent, /Out of date/);
  await h.controller.activate("repo-b"); await h.controller.openDiff(verifiedDiff({ onRevertChange() {} }));
  pending.resolve({ content: "old repository disk", contentHash: "v2" }); action.resolve(); await refresh; await flush();
  assert.doesNotMatch(h.byClass("repository-ide-path").textContent, /Out of date/); assert.equal(h.diffEditors.at(-1).modified.glyphWidgets[0].getDomNode().disabled, false);
  h.controller.dispose();
});

test("external refresh preserves dirty buffers, newer edits and failures without confirming a discard", async () => {
  const pending = deferred(); let deferRead = false;
  const h = harness({ api: (path, options, fallback) => path.includes("/file?") && deferRead ? pending.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  h.edit("retained draft");
  const before = h.calls.length;
  let result = await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] });
  assert.deepEqual(result.preserved, ["src/Main.java"]); assert.equal(h.editors.at(-1).getValue(), "retained draft");
  assert.equal(h.calls.slice(before).some(call => call.path.includes("/file?")), false, "dirty buffers do not reload");
  h.edit("class src/Main.java {}"); deferRead = true;
  const refreshing = h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] }); await flush();
  h.edit("newer unsaved draft"); pending.resolve({ content: "older disk response", contentHash: "older" });
  result = await refreshing;
  assert.deepEqual(result.preserved, ["src/Main.java"]); assert.equal(h.editors.at(-1).getValue(), "newer unsaved draft");
  assert.equal(h.controller.isDirty(), true); assert.deepEqual(h.confirmations, []); assert.equal(h.calls.some(call => call.method === "PUT"), false);
  h.setDiscard(true); h.controller.dispose();
});

test("external refresh cannot replace a newer refresh or a newly selected repository", async () => {
  for (const switchRepository of [false, true]) {
    const pending = deferred(); let updates = 0, updating = false;
    const h = harness({ api: (path, options, fallback) => {
      if (updating && path.includes("repo-a") && path.includes("/file?")) return ++updates === 1 ? pending.promise : { content: "newer disk", contentHash: "v3" };
      return fallback(path, options);
    } });
    await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); updating = true;
    const refreshing = h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] }); await flush();
    if (switchRepository) { await h.controller.activate("repo-b"); await h.controller.openFile("src/Other.java"); }
    else await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] });
    pending.resolve({ content: "stale disk", contentHash: "v2" });
    assert.deepEqual((await refreshing).preserved, ["src/Main.java"]);
    assert.equal(h.editors.at(-1).getValue(), switchRepository ? "class src/Other.java {}" : "newer disk");
    h.controller.dispose();
  }
});

test("inactive external refresh is lazy and uncertain failures never remove clean buffers", async () => {
  let failed = false;
  const h = harness({ api: (path, options, fallback) => {
    if (failed && path.includes("/file?")) throw Object.assign(new Error("Disk read unavailable"), { status: 503 });
    return fallback(path, options);
  } });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  failed = true;
  const result = await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] });
  assert.deepEqual(result.failed, [{ path: "src/Main.java", message: "Disk read unavailable" }]);
  assert.ok(h.button("src/Main.java")); assert.equal(h.editors.at(-1).getValue(), "class src/Main.java {}");
  await h.controller.deactivate();
  const before = h.calls.length;
  assert.deepEqual((await h.controller.refreshAfterExternalChange("repo-a", { paths: ["src/Main.java"] })).preserved, ["src/Main.java"]);
  assert.equal(h.calls.length, before, "hidden repositories make no disk requests");
  await assert.rejects(h.controller.refreshAfterExternalChange("repo-a", { paths: ["../outside"] }), /inside this repository/);
  failed = false; await h.controller.activate("repo-a");
  assert.ok(h.calls.slice(before).some(call => call.path.includes("/file?")), "reactivation loads the invalidated clean buffer");
  h.controller.dispose();
});

test("hash conflict keeps the editor draft and requires explicit discard before reloading disk", async () => {
  const h = harness({ api: (path, options, fallback) => { if (options.method === "PUT") throw Object.assign(new Error("disk changed"), { status: 409 }); return fallback(path, options); } });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); h.edit("my draft"); h.key("s", { ctrlKey: true }); await flush();
  assert.equal(h.editors.at(-1).getValue(), "my draft"); assert.equal(h.controller.isDirty(), true); assert.equal(h.byClass("repository-ide-conflict").hidden, false);
  h.button("Review the current disk version").click(); await flush();
  h.button("Replace the editor buffer with the disk version shown here").click(); await flush(); assert.equal(h.editors.at(-1).getValue(), "my draft");
  h.setDiscard(true); h.button("Replace the editor buffer with the disk version shown here").click(); await flush();
  assert.equal(h.controller.isDirty(), false); assert.equal(h.editors.at(-1).getValue(), "class src/Main.java {}"); h.controller.dispose();
});

test("a file response from the previous repository cannot open in the new repository", async () => {
  const oldFile = deferred();
  const h = harness({ api: (path, options, fallback) => path.includes("repo-a/ide/file?") ? oldFile.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); const opening = h.controller.openFile("src/Old.java");
  await h.controller.activate("repo-b"); await h.controller.openFile("src/New.java");
  oldFile.resolve({ content: "old repository data", contentHash: "a1", language: "java" }); await opening;
  assert.equal(h.editors.at(-1).getValue(), "class src/New.java {}"); h.controller.dispose();
});

test("turning the editor off while repository cleanup is pending cancels reactivation", async () => {
  const cleanup = deferred();
  const h = harness({ api: (path, options, fallback) => options.method === "DELETE" ? cleanup.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); const switching = h.controller.activate("repo-b"); const off = h.controller.deactivate(); cleanup.resolve({ ok: true }); await Promise.all([switching, off]);
  assert.equal(h.byClass("repository-ide").hidden, true); assert.equal(h.frames.length, 1); assert.equal(h.calls.some((item) => item.path.includes("repo-b")), false); h.controller.dispose();
});

test("turning the editor off cancels an unresolved Monaco script and releases queued activation", async () => {
  const h = harness({ pendingMonaco: true });
  const activation = h.controller.activate("repo-a"); await flush();
  const frame = h.frames.at(-1), script = frame.contentDocument.head.children.find((node) => node.tagName === "SCRIPT");
  assert.match(script.src, /\/legacy\/vendor\/monaco\/vs\/loader\.js$/);
  let completed = false; activation.then(() => { completed = true; });
  await h.controller.deactivate(); await flush();
  assert.equal(completed, true, "removing the iframe must settle the activation even if its script never loads");
  assert.equal(script.onload, null); assert.equal(script.onerror, null); assert.equal(script.parentElement, null); assert.equal(frame.parentElement, null);
  assert.equal(h.editors.length, 0); assert.equal(h.errors.length, 0); h.controller.dispose();
});

test("Reload refreshes a clean file and keeps unsaved edits unless discard is explicitly accepted", async () => {
  let content = "original disk", contentHash = "v1";
  const h = harness({ api: (path, options, fallback) => path.includes("/file?") ? { content, contentHash, language: "java" } : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  content = "updated disk"; contentHash = "v2";
  h.button("Reload current file from disk; asks before discarding unsaved edits").click(); await flush();
  assert.equal(h.editors.at(-1).getValue(), "updated disk"); assert.equal(h.confirmations.length, 0);
  h.edit("local draft"); content = "new external edit"; contentHash = "v3";
  h.button("Reload current file from disk; asks before discarding unsaved edits").click(); await flush();
  assert.equal(h.editors.at(-1).getValue(), "local draft"); assert.equal(h.controller.isDirty(), true);
  h.setDiscard(true); h.button("Reload current file from disk; asks before discarding unsaved edits").click(); await flush();
  assert.equal(h.editors.at(-1).getValue(), "new external edit"); assert.equal(h.controller.isDirty(), false);
  h.edit("next local edit"); h.key("s", { metaKey: true }); await flush();
  assert.equal(h.calls.find((item) => item.method === "PUT").body.expectedHash, "v3"); h.controller.dispose();
});

test("Reload protects edits made after its disk request starts", async () => {
  const reload = deferred(); let fileRequests = 0;
  const h = harness({ api: (path, options, fallback) => path.includes("/file?") && ++fileRequests > 1 ? reload.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  h.button("Reload current file from disk; asks before discarding unsaved edits").click(); await flush(); h.edit("typed while loading disk");
  reload.resolve({ content: "external disk", contentHash: "external-v2", language: "java" }); await flush();
  assert.equal(h.editors.at(-1).getValue(), "typed while loading disk"); assert.equal(h.confirmations.length, 1); assert.equal(h.controller.isDirty(), true); await h.controller.deactivate();
});

test("semantic navigation sends real backend requests and refuses unsaved disk positions", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 8, 3);
  await h.editors.at(-1).actions.get("argus.definition").run();
  assert.deepEqual(h.calls.find((item) => item.path.endsWith("/navigate")).body, { path: "src/Main.java", line: 8, column: 3, kind: "definition" });
  assert.match(h.byClass("repository-ide-notice").textContent, /No local server/);
  h.edit("dirty"); await h.editors.at(-1).actions.get("argus.references").run();
  assert.equal(h.calls.filter((item) => item.path.endsWith("/navigate")).length, 1); assert.match(h.byClass("repository-ide-notice").textContent, /Save this file/); await h.controller.deactivate();
});

test("source navigation offers declaration and type definition without overriding existing shortcuts", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 3, 15);
  const actions = h.editors.at(-1).actions;
  for (const [kind, label] of [["declaration", "Go to Declaration"], ["typeDefinition", "Go to Type Definition"]]) {
    assert.equal(actions.get(`argus.${kind}`).label, label);
    assert.equal(actions.get(`argus.${kind}`).contextMenuGroupId, "navigation");
    assert.equal(actions.get(`argus.${kind}`).keybindings, undefined);
    await actions.get(`argus.${kind}`).run();
  }
  assert.deepEqual(h.calls.filter(call => call.path.endsWith("/navigate")).map(call => call.body), [
    { path: "src/Main.java", line: 3, column: 15, kind: "declaration" },
    { path: "src/Main.java", line: 3, column: 15, kind: "typeDefinition" },
  ]);
  assert.deepEqual(actions.get("argus.definition").keybindings, [12]);
  h.edit("unsaved"); await actions.get("argus.declaration").run(); await actions.get("argus.typeDefinition").run();
  assert.equal(h.calls.filter(call => call.path.endsWith("/navigate")).length, 2);
  h.setDiscard(true); h.controller.dispose();
});

test("an incomplete single configuration match requires selection instead of an automatic source jump", async () => {
  const result = { selectionRequired: true, locations: [{ path: "application.yml", line: 3, column: 3 }], notice: "Some configuration files could not be checked." };
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? result : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 4, 2);
  await h.editors.at(-1).actions.get("argus.definition").run();
  assert.equal(h.controller.getNavigationState().path, "src/Main.java");
  assert.equal(h.byClass("repository-ide-results").hidden, false);
  assert.equal(h.byClass("repository-ide-results").children[0].children[0].textContent, "Definitions (1)");
  assert.equal(h.calls.some(call => call.path.includes("path=application.yml")), false);
  h.controller.dispose();
});

test("source Cmd-click navigates variables, fields, constants and classes without a method-call requirement", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1);
  for (const word of ["count", "customer", "MAX_RETRIES", "Customer", "ACTIVE"]) {
    editor.model.getWordAtPosition = at => ({ word, startColumn: at.column, endColumn: at.column + word.length });
    editor.mouse({ target: { type: 6, position: { lineNumber: 1, column: 7 } }, event: { metaKey: true } }); await flush();
  }
  assert.equal(h.calls.filter(call => call.path.endsWith("/navigate")).length, 5);
  assert.deepEqual(h.errors, []); h.controller.dispose();
});

test("configuration-key hover and click share one full-key lookup across punctuation", async () => {
  const content = '@Value("${orders.timeout-ms:30}") int timeout;', pending = deferred();
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? pending.promise : path.includes("/file?") ? { ...fallback(path, options), content } : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1); editor.model.word = null;
  const target = column => ({ type: 6, position: { lineNumber: 1, column } });
  editor.mouseMove({ target: target(content.indexOf(".") + 1), event: { metaKey: true } });
  await new Promise(resolve => setTimeout(resolve, 205));
  assert.deepEqual(editor.decorations[0].range.coordinates, [1, 11, 1, 28]);
  editor.mouse({ target: target(content.indexOf("-") + 1), event: { metaKey: true } }); await flush();
  const queries = h.calls.filter(call => call.path.endsWith("/navigate"));
  assert.equal(queries.length, 1); assert.equal(queries[0].signal.aborted, false);
  pending.resolve({ locations: [{ path: "src/application.yml", line: 2, column: 3 }] }); await flush(); await flush();
  assert.equal(h.controller.getNavigationState().path, "src/application.yml");
  assert.deepEqual(h.errors, []); h.controller.dispose();
});

test("Ctrl and Cmd click navigate only source words, not whitespace or ordinary clicks", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 6, column: 12 } };
  editor.mouse({ target, event: {} }); await flush(); assert.equal(h.calls.filter((call) => call.path.endsWith("/navigate")).length, 0);
  for (const modifier of ["ctrlKey", "metaKey"]) { editor.mouse({ target, event: { [modifier]: true } }); await flush(); }
  assert.equal(h.calls.filter((call) => call.path.endsWith("/navigate")).length, 2);
  assert.deepEqual(h.calls.filter((call) => call.path.endsWith("/navigate"))[0].body, { path: "src/Main.java", line: 6, column: 12, kind: "definition" });
  editor.model.word = null; editor.mouse({ target, event: { ctrlKey: true } }); await flush();
  assert.equal(h.calls.filter((call) => call.path.endsWith("/navigate")).length, 2); h.controller.dispose();
});

test("native mac Control click suppresses its context menu and navigates once", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), frame = h.frames.at(-1).contentDocument;
  editor.pointerTarget = { type: 6, position: { lineNumber: 3, column: 7 } };
  const down = frame.emit("mousedown", { button: 0, ctrlKey: true, clientX: 20, clientY: 20 });
  const menu = frame.emit("contextmenu", { ctrlKey: true, clientX: 20, clientY: 20 }); await flush();
  assert.equal(down.prevented, true); assert.equal(down.stopped, true); assert.equal(menu.prevented, true);
  assert.equal(h.calls.filter((call) => call.path.endsWith("/navigate")).length, 1);
  assert.equal(frame.emit("contextmenu", { ctrlKey: false }).prevented, undefined, "ordinary context menus remain available");
  editor.pointerTarget = { type: 3 }; assert.equal(frame.emit("contextmenu", { ctrlKey: true }).prevented, true, "the trailing event is suppressed even when navigation leaves the pointer over whitespace"); h.controller.dispose();
});

test("a Control-click contextmenu arriving after navigation cannot navigate again in the new file", async () => {
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? { locations: [{ path: "src/Service.java", line: 2, column: 2 }] } : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), frame = h.frames.at(-1).contentDocument;
  editor.pointerTarget = { type: 6, position: { lineNumber: 3, column: 7 } };
  frame.emit("mousedown", { button: 0, ctrlKey: true, clientX: 20, clientY: 20 }); await flush();
  assert.match(editor.getValue(), /src\/Service.java/);
  editor.pointerTarget = { type: 6, position: { lineNumber: 2, column: 2 } };
  const menu = frame.emit("contextmenu", { ctrlKey: true, clientX: 20, clientY: 20 }); await flush();
  assert.equal(menu.prevented, true); assert.equal(h.calls.filter((call) => call.path.endsWith("/navigate")).length, 1); h.controller.dispose();
});

test("holding Control over a method offers semantic link feedback and reuses the bounded lookup on click", async () => {
  const preview = deferred();
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? preview.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
  editor.mouseMove({ target, event: {} }); await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.calls.filter((call) => call.path.endsWith("/navigate")).length, 0, "ordinary hovering must not start language work");
  h.frames.at(-1).contentDocument.emit("keydown", { key: "Control", ctrlKey: true });
  assert.equal(editor.decorations[0].options.inlineClassName, "repository-ide-definition-pending");
  await new Promise((resolve) => setTimeout(resolve, 200));
  preview.resolve({ locations: [{ path: "src/Service.java", line: 20, column: 3 }] }); await flush();
  assert.equal(editor.decorations[0].options.inlineClassName, "repository-ide-definition-link");
  editor.mouse({ target, event: { ctrlKey: true } }); await flush();
  assert.equal(h.calls.filter((call) => call.path.endsWith("/navigate")).length, 1);
  assert.match(editor.getValue(), /src\/Service.java/); assert.deepEqual(editor.getPosition(), { lineNumber: 20, column: 3 });
  h.button("Navigate back (Alt+Left)").click(); await flush(); assert.match(editor.getValue(), /src\/Main.java/); h.controller.dispose();
});

test("an empty hover lookup is retried on click after Java indexing advances", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let lookups = 0;
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? (++lookups === 1 ? { locations: [], notice: "Project importing." } : { locations: [{ path: "src/Service.java", line: 20, column: 3 }] }) : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
  editor.mouseMove({ target, event: { metaKey: true } }); t.mock.timers.tick(200); await flush();
  assert.equal(lookups, 1); assert.match(editor.decorations[0].options.hoverMessage.value, /importing/);
  editor.mouseMove({ target, event: { metaKey: true } }); t.mock.timers.tick(200); await flush();
  assert.equal(lookups, 1, "moving within a checked word does not repeatedly query the server");
  editor.mouse({ target, event: { metaKey: true } }); await flush();
  assert.equal(lookups, 2); assert.match(editor.getValue(), /src\/Service.java/);
  assert.deepEqual(editor.getPosition(), { lineNumber: 20, column: 3 }); h.controller.dispose();
});

test("first Cmd-click adopts an in-flight hover lookup without aborting or duplicating language startup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? pending.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
  editor.mouseMove({ target, event: { metaKey: true } }); t.mock.timers.tick(200); await flush();
  const request = h.calls.find(call => call.path.endsWith("/navigate"));
  editor.mouse({ target, event: { metaKey: true } }); await flush();
  h.frames.at(-1).contentDocument.emit("keyup", { key: "Meta", metaKey: false });
  editor.mouseLeave();
  assert.equal(request.signal.aborted, false, "the click owns the pending work even after modifier release");
  assert.equal(h.calls.filter(call => call.path.endsWith("/navigate")).length, 1);
  pending.resolve({ locations: [{ path: "src/Service.java", line: 20, column: 3 }] }); await flush();
  assert.match(editor.getValue(), /src\/Service.java/);
  assert.deepEqual(editor.getPosition(), { lineNumber: 20, column: 3 });
  h.button("Navigate back (Alt+Left)").click(); await flush();
  assert.match(editor.getValue(), /src\/Main.java/); assert.deepEqual(editor.getPosition(), target.position);
  assert.deepEqual(h.errors, []); h.controller.dispose();
});

test("a clicked pending hover gets one fresh lookup when its speculative result is empty", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(); let lookups = 0;
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? (++lookups === 1 ? pending.promise : { locations: [{ path: "src/Service.java", line: 9, column: 2 }] }) : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
  editor.mouseMove({ target, event: { ctrlKey: true } }); t.mock.timers.tick(200); await flush();
  editor.mouse({ target, event: { ctrlKey: true } }); await flush();
  pending.resolve({ locations: [], notice: "Project importing." }); await flush();
  assert.equal(lookups, 2); assert.match(editor.getValue(), /src\/Service.java/);
  assert.deepEqual(editor.getPosition(), { lineNumber: 9, column: 2 }); h.controller.dispose();
});

test("repeated clicks on a pending symbol share the request but a different symbol wins", async () => {
  const first = deferred(), second = deferred(); let lookups = 0;
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? (++lookups === 1 ? first.promise : second.promise) : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
  editor.mouse({ target, event: { metaKey: true } }); editor.mouse({ target, event: { metaKey: true } }); await flush();
  assert.equal(lookups, 1, "a second click must not queue another request behind the first");
  editor.mouse({ target: { type: 6, position: { lineNumber: 5, column: 9 } }, event: { metaKey: true } }); await flush();
  assert.equal(lookups, 2);
  second.resolve({ locations: [{ path: "src/Right.java", line: 2, column: 3 }] }); await flush();
  first.resolve({ locations: [{ path: "src/Obsolete.java", line: 1, column: 1 }] }); await flush();
  assert.match(editor.getValue(), /src\/Right.java/); h.controller.dispose();
});

test("cancelled adopted hover cannot retry or navigate after the cursor, file or draft changes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const change of ["cursor", "file", "edit"]) {
    const pending = deferred();
    const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? pending.promise : fallback(path, options) });
    await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
    const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
    editor.mouseMove({ target, event: { metaKey: true } }); t.mock.timers.tick(200); await flush();
    editor.mouse({ target, event: { metaKey: true } }); await flush();
    if (change === "cursor") editor.setPosition({ lineNumber: 4, column: 1 });
    if (change === "file") await h.controller.openFile("src/Other.java");
    if (change === "edit") h.edit("unsaved draft");
    pending.resolve({ locations: [] }); await flush();
    assert.equal(h.calls.filter(call => call.path.endsWith("/navigate")).length, 1, `${change}: no obsolete retry`);
    assert.match(editor.getValue(), change === "file" ? /src\/Other.java/ : change === "edit" ? /unsaved draft/ : /src\/Main.java/);
    h.controller.dispose();
  }
});

test("switching repositories aborts an adopted hover request without rendering its old result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? pending.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
  editor.mouseMove({ target, event: { ctrlKey: true } }); t.mock.timers.tick(200); await flush();
  editor.mouse({ target, event: { ctrlKey: true } }); await flush();
  const request = h.calls.find(call => call.path.endsWith("/navigate"));
  await h.controller.activate("repo-b"); assert.equal(request.signal.aborted, true);
  pending.resolve({ locations: [{ path: "src/Old.java", line: 1 }] }); await flush();
  assert.equal(h.editors.at(-1).model, null); assert.deepEqual(h.errors, []); h.controller.dispose();
});

test("reopening a file invalidates pending click deduplication so the next click can navigate", async () => {
  const first = deferred(); let lookups = 0;
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? (++lookups === 1 ? first.promise : { locations: [{ path: "src/Current.java", line: 1, column: 1 }] }) : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
  editor.mouse({ target, event: { metaKey: true } }); await flush();
  await h.controller.openFile("src/Main.java");
  editor.mouse({ target, event: { metaKey: true } }); await flush();
  assert.equal(lookups, 2); assert.match(editor.getValue(), /src\/Current.java/);
  first.resolve({ locations: [{ path: "src/Stale.java", line: 1 }] }); await flush();
  assert.match(editor.getValue(), /src\/Current.java/); h.controller.dispose();
});

test("modifier release, movement, and repository changes cancel stale definition hover requests", async () => {
  const first = deferred(), second = deferred(); let queries = 0;
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? (++queries === 1 ? first.promise : second.promise) : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
  editor.mouseMove({ target, event: { metaKey: true } }); await new Promise((resolve) => setTimeout(resolve, 200));
  const request = h.calls.find((call) => call.path.endsWith("/navigate"));
  h.frames.at(-1).contentDocument.emit("keyup", { key: "Meta", metaKey: false });
  assert.equal(request.signal.aborted, true); assert.deepEqual(editor.decorations, []);
  first.resolve({ locations: [{ path: "src/Obsolete.java", line: 1 }] }); await flush(); assert.deepEqual(editor.decorations, []);
  editor.mouseMove({ target, event: { ctrlKey: true } }); await new Promise((resolve) => setTimeout(resolve, 200));
  await h.controller.activate("repo-b"); second.resolve({ locations: [{ path: "src/Other.java", line: 1 }] }); await flush();
  assert.equal(h.calls.filter((call) => call.path.endsWith("/navigate"))[1].signal.aborted, true);
  assert.equal(h.editors.at(-1).model, null); h.controller.dispose();
});

test("dirty-file hover remains syntax-only and a pending navigation cannot steal focus after edits or file changes", async () => {
  const pending = deferred();
  const h = harness({ api: (path, options, fallback) => path.endsWith("/navigate") ? pending.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const editor = h.editors.at(-1), target = { type: 6, position: { lineNumber: 3, column: 7 } };
  h.edit("local draft"); editor.mouseMove({ target, event: { ctrlKey: true } }); await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match(editor.decorations[0].options.hoverMessage.value, /Save this file/);
  assert.equal(h.calls.filter((call) => call.path.endsWith("/navigate")).length, 0);
  await h.controller.openFile("src/Second.java"); const navigation = editor.actions.get("argus.definition").run(); await flush();
  await h.controller.openFile("src/Third.java"); pending.resolve({ locations: [{ path: "src/Wrong.java", line: 1 }] }); await navigation;
  assert.match(editor.getValue(), /src\/Third.java/); await h.controller.deactivate();
});

test("file tree splitter bounds and per-repository width and collapse preferences are retained", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  const divider = h.byClass("repository-ide-tree-divider"), body = h.byClass("repository-ide-body"), toggle = h.button("Show or hide repository files");
  assert.equal(divider.getAttribute("role"), "separator"); assert.equal(divider.getAttribute("aria-orientation"), "vertical");
  assert.equal(body.style["--ide-tree-width"], "168px"); divider.emit("keydown", { key: "ArrowRight" }); assert.equal(body.style["--ide-tree-width"], "178px");
  divider.emit("keydown", { key: "End" }); assert.equal(body.style["--ide-tree-width"], "480px");
  assert.equal(h.preferences.get("argus-ide-tree-width:repo-a:x"), "480");
  toggle.click(); await flush(); assert.equal(divider.hidden, true); assert.equal(h.byClass("repository-ide-tree-pane").hidden, true); assert.equal(toggle.getAttribute("aria-expanded"), "false");
  await h.controller.activate("repo-b"); assert.equal(divider.hidden, false); assert.equal(body.style["--ide-tree-width"], "168px");
  await h.controller.activate("repo-a"); assert.equal(divider.hidden, true); toggle.click(); await flush(); assert.equal(body.style["--ide-tree-width"], "480px");
  h.controller.dispose();
});

test("file-tree SVG disclosures preserve plain-text names across expansion and collapse", async () => {
  const folderName = "src <safe> & code", fileName = "<Example>.java";
  const h = harness({ api: (path, options, fallback) => path.includes("/tree?")
    ? { entries: new URL(path, "http://local").searchParams.get("path") ? [{ path: "src/Example.java", name: fileName, directory: false }] : [{ path: "src", name: folderName, directory: true }] }
    : fallback(path, options) });
  await h.controller.activate("repo-a");
  const folder = h.button("src"), chevron = folder.children[0], icon = folder.children[1], label = folder.children[2];
  assert.equal(chevron.tagName, "SVG"); assert.equal(chevron.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(chevron.getAttribute("viewBox"), "0 0 16 16"); assert.equal(chevron.getAttribute("aria-hidden"), "true");
  assert.equal(chevron.getAttribute("focusable"), "false"); assert.equal(chevron.children[0].getAttribute("d"), "m4 6 4 4 4-4");
  assert.equal(label.className, "repository-ide-tree-name"); assert.equal(label.textContent, folderName);
  folder.click(); await flush(); assert.equal(folder.getAttribute("aria-expanded"), "true");
  assert.equal(icon.className, "repository-ide-file-icon"); assert.equal(icon.dataset.kind, "folder"); assert.equal(icon.getAttribute("aria-hidden"), "true");
  assert.equal(folder.children[0], chevron); assert.equal(folder.children[1], icon); assert.equal(folder.children[2], label);
  const file = h.button("src/Example.java"); assert.equal(file.children.length, 2); assert.equal(file.children[0].dataset.kind, "java"); assert.equal(file.children[1].textContent, fileName);
  folder.click(); await flush(); assert.equal(folder.getAttribute("aria-expanded"), "false");
  assert.equal(folder.children[0], chevron); assert.equal(folder.children[1], icon); assert.equal(folder.children[2], label); assert.equal(label.textContent, folderName);
  await h.controller.openFile("src/Example.java"); assert.equal(folder.getAttribute("aria-expanded"), "true");
  assert.equal(file.dataset.active, "true"); assert.equal(folder.children[0], chevron); h.controller.dispose();
});

test("opening and restoring a nested source expands its ancestors, selects it, and reveals it after tree refresh", async () => {
  const tree = { "": [{ path: "src", name: "src", directory: true }], src: [{ path: "src/main", name: "main", directory: true }], "src/main": [{ path: "src/main/App.java", name: "App.java", directory: false }, { path: "src/main/Other.java", name: "Other.java", directory: false }] };
  const h = harness({ api: (path, options, fallback) => path.includes("/tree?") ? { entries: tree[new URL(path, "http://local").searchParams.get("path")] || [] } : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/main/App.java");
  assert.equal(h.button("src"), undefined); assert.equal(h.button("src/main").getAttribute("aria-expanded"), "true");
  assert.equal(h.button("src/main/App.java").dataset.active, "true"); assert.deepEqual(h.button("src/main/App.java").scrolledIntoView, { block: "nearest", inline: "nearest" });
  await h.controller.openFile("src/main/Other.java"); assert.equal(h.button("src/main/App.java").dataset.active, "false"); assert.equal(h.button("src/main/Other.java").getAttribute("aria-current"), "true");
  h.button("Refresh file tree").click(); await flush();
  assert.equal(h.button("src/main/Other.java").dataset.active, "true"); assert.equal(h.button("src/main").getAttribute("aria-expanded"), "true");
  await h.controller.deactivate(); await h.controller.activate("repo-a"); assert.equal(h.button("src/main/Other.java").dataset.active, "true"); h.controller.dispose();
});

test("collapse all folders keeps the active source and reuses loaded children without network writes", async () => {
  const tree = { "": [{ path: "src", name: "src", directory: true }], src: [{ path: "src/main", name: "main", directory: true }], "src/main": [{ path: "src/main/App.java", name: "App.java", directory: false }] };
  const h = harness({ api: (path, options, fallback) => path.includes("/tree?") ? { entries: tree[new URL(path, "http://local").searchParams.get("path")] || [] } : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/main/App.java");
  const count = h.calls.length, file = h.button("src/main/App.java"), source = h.editors.at(-1).model;
  h.button("Collapse all folders").click(); await flush();
  assert.equal(h.button("src"), undefined); assert.equal(h.button("src/main").getAttribute("aria-expanded"), "false");
  assert.equal(h.calls.length, count); assert.equal(h.editors.at(-1).model, source); assert.equal(file.dataset.active, "true");
  h.button("src/main").click(); await flush();
  assert.equal(h.calls.length, count); assert.equal(h.button("src/main/App.java"), file); h.controller.dispose();
});

test("one expansion compacts a generic directory chain and exposes its files without opening one", async () => {
  const paths = ["<source>", "<source>/entry points", "<source>/entry points/日本語", "<source>/entry points/日本語/handlers"], tree = Object.fromEntries(paths.map((path, index) => [path, index < paths.length - 1
    ? [{ path: paths[index + 1], directory: true }]
    : [{ path: `${path}/README.md`, directory: false }, { path: `${path}/worker.py`, directory: false }, { path: `${path}/nested`, directory: true }]]));
  tree[""] = [{ path: paths[0], directory: true }, { path: "unopened", directory: true }];
  const h = harness({ api: (path, options, fallback) => path.includes("/tree?") ? { entries: tree[new URL(path, "http://local").searchParams.get("path")] || [] } : fallback(path, options) });
  try {
    await h.controller.activate("repo-a");
    assert.equal(h.calls.filter(call => call.path.includes("/tree?")).length, 1, "root must not probe unopened folders");
    const row = h.button(paths[0]); row.click(); await flush();
    assert.equal(h.button(paths.at(-1)), row); assert.equal(row.title, paths.at(-1));
    assert.equal(row.dataset.path, paths.at(-1)); assert.equal(row.getAttribute("aria-busy"), "false");
    assert.equal(row.children[2].dataset.compact, "true");
    assert.equal(row.children[2].style.getPropertyValue("--ide-tree-depth"), "0");
    assert.deepEqual(row.children[2].children.map(node => node.textContent), ["<source>/entry points/日本語/", "handlers"]);
    assert.ok(h.button(`${paths.at(-1)}/worker.py`)); assert.ok(h.button(`${paths.at(-1)}/README.md`));
    assert.equal(h.button(`${paths.at(-1)}/nested`).getAttribute("aria-expanded"), "false");
    assert.equal(h.button(`${paths.at(-1)}/nested`).children[2].style.getPropertyValue("--ide-tree-depth"), "1");
    assert.equal(h.button("unopened").getAttribute("aria-expanded"), "false");
    assert.equal(h.calls.filter(call => call.path.includes("/file?")).length, 0);
    const reads = h.calls.filter(call => call.path.includes("/tree?")); assert.equal(reads.length, 5);
    assert.ok(reads.slice(2).every(call => call.timeout > 0 && call.timeout <= 1500));
    assert.ok(reads.every(call => !call.method || call.method === "GET"));
  } finally { h.controller.dispose(); }
});

test("refresh splits a compact chain when an intermediate directory gains real content without touching a dirty editor", async () => {
  const tree = { "": [{ path: "src", directory: true }], src: [{ path: "src/pkg", directory: true }], "src/pkg": [{ path: "src/pkg/app.rb", directory: false }] };
  const h = harness({ api: (path, options, fallback) => path.includes("/tree?") ? { entries: tree[new URL(path, "http://local").searchParams.get("path")] || [] } : fallback(path, options) });
  try {
    await h.controller.activate("repo-a"); await h.controller.openFile("src/pkg/app.rb"); h.edit("unsaved edits");
    assert.equal(h.button("src"), undefined); const model = h.editors.at(-1).model;
    tree.src.push({ path: "src/README.md", directory: false });
    h.button("Refresh file tree").click(); await flush();
    assert.equal(h.button("src").getAttribute("aria-expanded"), "true");
    assert.equal(h.button("src/pkg").getAttribute("aria-expanded"), "true"); assert.ok(h.button("src/README.md"));
    assert.equal(h.button("src/pkg/app.rb").dataset.active, "true"); assert.equal(h.editors.at(-1).model, model);
    assert.equal(model.getValue(), "unsaved edits"); assert.equal(h.calls.some(call => call.method === "PUT"), false);
  } finally { h.setDiscard(true); h.controller.dispose(); }
});

test("failed chain lookahead leaves the child visible and expandable for a normal retry", async () => {
  let attempts = 0;
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/tree?path=")) return { entries: [{ path: "lib", directory: true }] };
    if (path.endsWith("/tree?path=lib")) return { entries: [{ path: "lib/nested", directory: true }] };
    if (path.endsWith("/tree?path=lib%2Fnested")) { if (!attempts++) throw new Error("Temporary read error"); return { entries: [{ path: "lib/nested/main.rs", directory: false }] }; }
    return fallback(path, options);
  } });
  try {
    await h.controller.activate("repo-a"); h.button("lib").click(); await flush();
    assert.equal(h.button("lib").getAttribute("aria-expanded"), "true"); assert.equal(h.button("lib/nested").getAttribute("aria-expanded"), "false");
    h.button("lib/nested").click(); await flush(); assert.ok(h.button("lib/nested/main.rs")); assert.equal(attempts, 2);
    assert.deepEqual(h.errors, []);
  } finally { h.controller.dispose(); }
});

test("collapse-all during a chain probe stays collapsed and a later expansion can retry", async () => {
  const probe = deferred(); let attempts = 0;
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/tree?path=")) return { entries: [{ path: "lib", directory: true }] };
    if (path.endsWith("/tree?path=lib")) return { entries: [{ path: "lib/nested", directory: true }] };
    if (path.endsWith("/tree?path=lib%2Fnested")) return attempts++ ? { entries: [{ path: "lib/nested/main.rs", directory: false }] } : probe.promise;
    return fallback(path, options);
  } });
  try {
    await h.controller.activate("repo-a"); const row = h.button("lib"); row.click(); await flush();
    assert.equal(row.getAttribute("aria-busy"), "true"); h.button("Collapse all folders").click(); await flush();
    probe.resolve({ entries: [{ path: "lib/nested/main.rs", directory: false }] }); await flush();
    assert.equal(row.getAttribute("aria-expanded"), "false"); assert.equal(row.parentElement.children[1].hidden, true);
    assert.equal(h.button("lib/nested/main.rs"), undefined); assert.equal(row.getAttribute("aria-busy"), "false");
    row.click(); await flush(); assert.equal(h.button("lib/nested"), row); assert.ok(h.button("lib/nested/main.rs"));
  } finally { h.controller.dispose(); }
});

test("late compact-chain probes cannot replace a refreshed tree or another repository", async () => {
  for (const change of ["refresh", "repository"]) {
    const probe = deferred(); let fresh = false;
    const h = harness({ api: (path, options, fallback) => {
      if (path.includes("/tree?")) {
        if (fresh) return { entries: [{ path: "fresh.txt", directory: false }] };
        if (path.endsWith("path=")) return { entries: [{ path: "lib", directory: true }] };
        if (path.endsWith("path=lib")) return { entries: [{ path: "lib/nested", directory: true }] };
        return probe.promise;
      }
      return fallback(path, options);
    } });
    try {
      await h.controller.activate("repo-a"); h.button("lib").click(); await flush(); fresh = true;
      if (change === "refresh") { h.button("Refresh file tree").click(); await flush(); }
      else await h.controller.activate("repo-b");
      probe.resolve({ entries: [{ path: "lib/nested/stale.txt", directory: false }] }); await flush();
      assert.ok(h.button("fresh.txt")); assert.equal(h.button("lib/nested"), undefined); assert.equal(h.button("lib/nested/stale.txt"), undefined);
      assert.deepEqual(h.errors, []);
    } finally { h.controller.dispose(); }
  }
});

test("a slow tree expansion cannot select the previous file after navigation changes", async () => {
  const nested = deferred();
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/tree?path=")) return { entries: [{ path: "src", name: "src", directory: true }, { path: "Current.java", name: "Current.java", directory: false }] };
    if (path.endsWith("/tree?path=src")) return nested.promise;
    return fallback(path, options);
  } });
  await h.controller.activate("repo-a"); const old = h.controller.openFile("src/Old.java"); await flush();
  await h.controller.openFile("Current.java"); nested.resolve({ entries: [{ path: "src/Old.java", name: "Old.java", directory: false }] });
  assert.equal(await old, false); assert.equal(h.button("Current.java").dataset.active, "true"); assert.equal(h.button("src/Old.java").dataset.active, "false"); h.controller.dispose();
});

test("editor toolbar keeps its file control but leaves AI chat disclosure to the repository header", async () => {
  const h = harness();
  await h.controller.activate("repo-a");
  await h.controller.openFile("src/Main.java"); h.edit("unsaved code");
  const files = h.button("Show or hide repository files"), model = h.editors.at(-1).model, editor = h.editors.at(-1);
  assert.equal(files.title, "Hide files"); assert.equal(files.getAttribute("aria-pressed"), "true"); files.click(); await flush(); assert.equal(files.title, "Show files"); assert.equal(files.getAttribute("aria-pressed"), "false");
  assert.equal(h.button("Show or hide AI chat beside the editor"), undefined);
  assert.equal(walk(h.host).filter(node => node.tagName === "BUTTON" && /^(Show|Hide) AI chat$/.test(node.getAttribute("aria-label") || "")).length, 0);
  h.controller.syncChatVisibility();
  assert.equal(h.editors.at(-1), editor); assert.equal(editor.model, model); assert.equal(model.getValue(), "unsaved code");
  assert.equal(h.controller.isDirty("repo-a"), true); assert.equal(model.disposed, false); h.controller.dispose();
});

test("version control is an accessible IDE panel icon that follows external state and preserves the file-tree preference", async () => {
  let open = false; const toggles = [], mounts = [];
  const h = harness({ getVersionControlOpen: id => id === "repo-a" && open, onVersionControlToggle: id => { toggles.push(id); open = !open; }, onVersionControlMount: slot => mounts.push(slot) });
  const git = h.button("Open version control"), slot = h.byClass("repository-ide-version-control-slot"), files = h.button("Show or hide repository files");
  assert.equal(git.id, "repository-ide-version-control-toggle"); assert.equal(git.getAttribute("aria-controls"), "repository-version-control-panel");
  assert.equal(git.parentElement.children[1], git, "version control follows files in the editor panel group");
  assert.equal(git.hidden, false); assert.equal(git.disabled, true); assert.equal(slot.hidden, true); assert.deepEqual(mounts, [slot]);
  git.click(); await flush(); assert.deepEqual(toggles, []);
  await h.controller.activate("repo-a"); assert.equal(git.disabled, false);
  git.click(); await flush();
  assert.deepEqual(toggles, ["repo-a"]); assert.equal(slot.hidden, false); assert.equal(git.title, "Close version control");
  assert.equal(git.getAttribute("aria-label"), "Close version control"); assert.equal(git.getAttribute("aria-expanded"), "true"); assert.equal(git.getAttribute("aria-pressed"), "true");
  assert.equal(h.byClass("repository-ide").dataset.versionControlOpen, "true");
  assert.equal(files.title, "Show files"); assert.equal(files.getAttribute("aria-expanded"), "false"); assert.equal(files.getAttribute("aria-pressed"), "false");
  assert.equal(h.preferences.has("argus-ide-tree-hidden:repo-a"), false, "opening Git does not overwrite the saved tree preference");
  files.click(); await flush(); assert.deepEqual(toggles, ["repo-a", "repo-a"]); assert.equal(slot.hidden, true); assert.equal(files.title, "Hide files");
  files.click(); await flush(); assert.equal(h.preferences.get("argus-ide-tree-hidden:repo-a"), "true");
  open = true; h.controller.syncVersionControlState(); assert.equal(slot.hidden, false);
  open = false; h.controller.syncVersionControlState(); assert.equal(slot.hidden, true); assert.equal(h.byClass("repository-ide-tree-pane").hidden, true, "closing Git keeps a previously hidden tree hidden");
  assert.equal(git.getAttribute("aria-label"), "Open version control"); assert.equal(git.getAttribute("aria-expanded"), "false"); assert.equal(git.getAttribute("aria-pressed"), "false");
  await h.controller.deactivate(); assert.equal(git.disabled, true); assert.equal(slot.hidden, true); assert.equal(mounts.length, 1, "singleton panel remains mounted when the IDE hides");
  git.click(); await flush(); assert.equal(toggles.length, 2); h.controller.dispose();
});

test("the version-control icon stays hidden without host support and stale toggles cannot alter another repository", async () => {
  const standalone = harness(); assert.equal(standalone.button("Open version control").hidden, true); standalone.controller.dispose();
  const pending = deferred(); let open = true;
  const h = harness({ getVersionControlOpen: id => id === "repo-a" && open, onVersionControlToggle: async () => { await pending.promise; open = false; } });
  await h.controller.activate("repo-a"); h.button("Show or hide repository files").click(); await flush();
  await h.controller.activate("repo-b"); h.button("Show or hide repository files").click(); await flush();
  assert.equal(h.byClass("repository-ide-tree-pane").hidden, true);
  pending.resolve(); await flush();
  assert.equal(h.byClass("repository-ide-tree-pane").hidden, true, "an old Git-to-files action must not reveal another repository's tree");
  assert.equal(h.preferences.has("argus-ide-tree-hidden:repo-a"), false); h.controller.dispose();
});

test("unchanged Git state does not relayout Monaco during background rail refreshes", async () => {
  let open = false;
  const h = harness({ getVersionControlOpen: () => open, onVersionControlToggle: () => { open = !open; } });
  await h.controller.activate("repo-a"); let layouts = 0; h.editors.at(-1).layout = () => { layouts++; };
  for (let refresh = 0; refresh < 20; refresh++) h.controller.syncVersionControlState();
  assert.equal(layouts, 0);
  open = true; h.controller.syncVersionControlState(); assert.ok(layouts > 0);
  const openedLayouts = layouts; for (let refresh = 0; refresh < 20; refresh++) h.controller.syncVersionControlState();
  assert.equal(layouts, openedLayouts); h.controller.dispose();
});

test("keyboard input in the embedded Git panel cannot trigger code-editor actions", async () => {
  let slot; const terminals = [];
  const h = harness({ getVersionControlOpen: () => true, onVersionControlToggle() {}, onVersionControlMount: value => { slot = value; }, onTerminalToggle: ({ repositoryId }) => terminals.push(repositoryId) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); h.edit("unsaved source");
  const commit = h.document.createElement("textarea"); slot.append(commit); commit.focus();
  const before = h.calls.length;
  for (const [key, extra] of [["s", { metaKey: true }], ["p", { ctrlKey: true }], ["F9", {}], ["ArrowLeft", { altKey: true }], ["Shift", {}], ["Shift", {}]]) {
    assert.equal(h.key(key, { target: commit, ...extra }).prevented, undefined, key);
  }
  await flush(); assert.equal(h.calls.length, before); assert.equal(h.byClass("repository-ide-search").hidden, true); assert.equal(h.saved.length, 0);
  assert.equal(h.key("`", { code: "Backquote", metaKey: true, target: commit }).prevented, true); await flush(); assert.deepEqual(terminals, ["repo-a"]);
  h.setDiscard(true); h.edit("class src/Main.java {}"); h.controller.dispose();
});

test("compact toolbar keeps secondary actions in one keyboard-accessible dismissible panel", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  const menu = h.byClass("repository-ide-actions"), more = h.button("More editor actions"), symbols = h.button("Symbols in the current file");
  assert.equal(menu.hidden, true); assert.equal(more.getAttribute("aria-expanded"), "false");
  assert.equal(menu.contains(symbols), true); assert.equal(symbols.disabled, true);
  assert.equal(menu.contains(h.button("Reload current file from disk; asks before discarding unsaved edits")), true);
  assert.equal(menu.contains(h.button("Toggle breakpoint at the current line (F9); or click beside a line number")), true);
  more.click(); await flush(); assert.equal(menu.hidden, false); assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.equal(h.document.activeElement, h.button("Reopen this repository’s saved code discussions"), "focus skips unavailable code actions but lets saved discussions reopen without a file");
  h.key("Escape"); assert.equal(menu.hidden, true); assert.equal(h.document.activeElement, more);
  const ask = h.button("Ask about selected code or the current line (⌘⌥A / Ctrl+Alt+A)");
  await h.controller.openFile("src/Main.java"); more.click(); await flush(); assert.equal(h.document.activeElement, ask);
  menu.emit("keydown", { key: "End" }); assert.equal(h.document.activeElement, h.button("Language server availability and configuration"));
  menu.emit("keydown", { key: "ArrowDown" }); assert.equal(h.document.activeElement, ask);
  h.document.emit("pointerdown", { target: h.host }); assert.equal(menu.hidden, true);
  more.click(); await flush(); h.document.emit("focusin", { target: h.host }); assert.equal(menu.hidden, true);
  more.click(); await flush(); await h.controller.deactivate(); assert.equal(menu.hidden, true); h.controller.dispose();
});

test("Save and code history appear only when relevant without removing their shortcuts", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  const save = h.button("Save file (⌘S / Ctrl+S)"), navigation = h.byClass("repository-ide-navigation");
  assert.equal(save.hidden, true); assert.equal(navigation.hidden, true);
  await h.controller.openFile("src/Main.java"); assert.equal(save.hidden, true);
  h.edit("changed"); assert.equal(save.hidden, false); assert.equal(save.disabled, false);
  h.host.focus(); h.key("s", { ctrlKey: true }); await flush(); assert.equal(save.hidden, true); assert.equal(h.controller.isDirty(), false);
  await h.controller.openFile("src/Other.java"); assert.equal(navigation.hidden, false); assert.equal(h.button("Navigate back (Alt+Left)").disabled, false);
  const more = h.button("More editor actions"); more.click(); await flush();
  h.button("Reload current file from disk; asks before discarding unsaved edits").click(); await flush(); assert.equal(h.byClass("repository-ide-actions").hidden, true);
  h.controller.dispose();
});

test("F9 and the breakpoint toolbar action toggle a saved breakpoint at the cursor", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 8, 2);
  const key = h.key("F9"); await flush(); assert.equal(key.prevented, true);
  assert.equal(h.byClass("repository-ide-breakpoint-row").dataset.state, "pending"); assert.ok(h.button("Open breakpoint src/Main.java:8"));
  h.button("Toggle breakpoint at the current line (F9); or click beside a line number").click(); await flush();
  assert.equal(h.button("Open breakpoint src/Main.java:8"), undefined); assert.equal(h.editors.at(-1).decorations.length, 0); h.controller.dispose();
});

test("deep file names retain intrinsic width and the file pane scrolls horizontally without ellipsis", async () => {
  const css = await readFile(new URL("../public/repository-ide.css", import.meta.url), "utf8");
  assert.match(css, /\.repository-ide-tree \{[^}]*overflow: auto/);
  assert.match(css, /\.repository-ide-tree-item \{[^}]*width: max-content/);
  const row = css.match(/\.repository-ide \.repository-ide-tree-row \{([^}]+)\}/)[1];
  assert.match(row, /width: max-content/); assert.match(row, /white-space: nowrap/); assert.doesNotMatch(row, /ellipsis|overflow: hidden/);
  assert.match(row, /display: flex/); assert.match(row, /align-items: center/);
  assert.match(css, /\.repository-ide-tree-chevron \{[^}]*width: 14px;[^}]*height: 14px;[^}]*transform: rotate\(-90deg\)/);
  assert.match(css, /\.repository-ide-tree-row\[aria-expanded="true"\] > \.repository-ide-tree-chevron \{ transform: none; \}/);
});

test("open model count stays bounded while plain-text buffers remain available", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  for (let index = 0; index < 12; index++) await h.controller.openFile(`File${index}.java`);
  assert.equal(h.models.filter((model) => !model.disposed).length, 8);
  await h.controller.openFile("File0.java"); assert.equal(h.editors.at(-1).getValue(), "class File0.java {}"); assert.equal(h.models.filter((model) => !model.disposed).length, 8); h.controller.dispose();
});

test("keyboard search is limited to the editor and closes on deactivation", async () => {
  const h = harness(); await h.controller.activate("repo-a");
  h.document.activeElement = h.document.body; assert.equal(h.key("p", { metaKey: true }).prevented, undefined);
  h.host.focus(); assert.equal(h.key("p", { metaKey: true }).prevented, true); assert.equal(h.byClass("repository-ide-search").hidden, false);
  h.key("Escape"); assert.equal(h.byClass("repository-ide-search").hidden, true);
  h.key("Shift"); h.key("Shift"); assert.equal(h.byClass("repository-ide-search").hidden, false);
  await h.controller.deactivate(); assert.equal(h.byClass("repository-ide-search").hidden, true); h.controller.dispose();
});

test("search debounces, cancels superseded queries, and renders only the latest repository response", async () => {
  const first = deferred(), second = deferred();
  const h = harness({ api: (path, options, fallback) => path.includes("/search?") ? path.includes("q=first") ? first.promise : second.promise : fallback(path, options) });
  await h.controller.activate("repo-a"); h.host.focus(); h.key("p", { metaKey: true });
  const input = h.byClass("repository-ide-search-header").children[0];
  input.value = "first"; input.emit("input"); await new Promise((resolve) => setTimeout(resolve, 200));
  input.value = "second"; input.emit("input"); await new Promise((resolve) => setTimeout(resolve, 200));
  const calls = h.calls.filter((item) => item.path.includes("/search?")); assert.equal(calls.length, 2); assert.equal(calls[0].signal.aborted, true);
  second.resolve({ results: [{ path: "Second.java", name: "Second" }] }); await flush(); first.resolve({ results: [{ path: "First.java", name: "First" }] }); await flush();
  const resultText = walk(h.byClass("repository-ide-search-results")).map((node) => node.textContent).join(" "); assert.match(resultText, /Second/); assert.doesNotMatch(resultText, /First/); h.controller.dispose();
});

test("Java project trust is explicit and passed only by the selected Start action", async () => {
  const h = harness({ api: (path, options, fallback) => path.endsWith("/status") && !path.includes("/debug/") ? { languages: [{ language: "java", label: "Java", available: true, running: false, trustedProject: false, executable: "/jdk/bin/java", args: [] }] } : fallback(path, options) });
  await h.controller.activate("repo-a"); h.button("Language server availability and configuration").click(); await flush();
  const trust = walk(h.host).find((node) => node.type === "checkbox"); assert.equal(trust.checked, false);
  assert.equal(h.calls.some((item) => item.path.endsWith("/language/start")), false);
  trust.checked = true; trust.emit("change"); h.button("Start Java language server").click(); await flush();
  assert.deepEqual(h.calls.find((item) => item.path.endsWith("/language/start")).body, { language: "java", trustProject: true }); h.controller.dispose();
});

test("Java indexing is discoverable from stopped status and empty definitions without granting trust", async () => {
  let java = { language: "java", label: "Java", available: true, running: false, ready: false, trustedProject: false };
  const h = harness({ api: (path, options, fallback) => path.endsWith("/status") && !path.includes("/debug/") ? { languages: [{ ...java }] } : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · installed · stopped");
  assert.equal(h.button("Review Java project trust and indexing").hidden, false);
  await h.editors.at(-1).actions.get("argus.definition").run(); await flush();
  const action = walk(h.byClass("repository-ide-result-items")).find((node) => node.getAttribute("aria-label") === "Review Java project trust and indexing");
  assert.ok(action); action.click(); await flush();
  assert.equal(h.byClass("repository-ide-settings").hidden, false);
  let trust = walk(h.host).find((node) => node.type === "checkbox"); assert.equal(trust.checked, false);
  assert.equal(h.calls.some((item) => item.path.endsWith("/language/start")), false);
  java = { ...java, running: true, ready: true };
  h.button("Language server availability and configuration").click(); await flush();
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · restricted · indexing needs trust");
  trust = walk(h.host).find((node) => node.type === "checkbox"); trust.checked = true; trust.emit("change");
  h.button("Start Java language server").click(); await flush();
  const start = h.calls.find((item) => item.path.endsWith("/language/start"));
  assert.match(start.path, /repositories\/repo-a\/ide\/language\/start$/); assert.deepEqual(start.body, { language: "java", trustProject: true });
  java = { ...java, running: false, ready: false, trustedProject: true };
  await h.controller.activate("repo-b"); await h.controller.openFile("src/Main.java");
  assert.equal(h.button("Review Java project trust and indexing").hidden, true);
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · installed · stopped"); h.controller.dispose();
});

test("Java status follows initialization through import to ready and preserves settings drafts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let java = { language: "java", label: "Java", available: true, running: true, initializing: true, ready: false, trustedProject: true, executable: "/jdk/bin/java", args: [] };
  const h = harness({ api: (path, options, fallback) => path.endsWith("/status") && !path.includes("/debug/") ? { languages: [{ ...java }] } : fallback(path, options) });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · initializing…");
  h.button("Language server availability and configuration").click(); await flush();
  const executable = walk(h.host).find((node) => node.getAttribute("aria-label") === "Java executable"); executable.value = "/edited/java";
  const trust = walk(h.host).find((node) => node.type === "checkbox"); trust.checked = false; trust.emit("change");
  java = { ...java, initializing: false, importing: true };
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · importing project…");
  assert.equal(executable.value, "/edited/java"); assert.equal(trust.checked, false); assert.equal(h.host.contains(executable), true);
  java = { ...java, importing: false, ready: true };
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · server ready");
  assert.equal(walk(h.byClass("repository-ide-language-list")).find((node) => node.tagName === "STRONG").textContent, "Java · server ready");
  const reads = h.calls.filter((item) => item.path.endsWith("/status")).length;
  t.mock.timers.tick(10000); await flush(); assert.equal(h.calls.filter((item) => item.path.endsWith("/status")).length, reads);
  assert.equal(h.calls.some((item) => item.path.endsWith("/language/start")), false); h.controller.dispose();
});

test("initializing status polling is bounded and stops when the editor is deactivated", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ api: (path, options, fallback) => path.endsWith("/status") && !path.includes("/debug/") ? { languages: [{ language: "java", available: true, running: true, initializing: true }] } : fallback(path, options) });
  await h.controller.activate("repo-a");
  for (let poll = 0; poll < 151; poll++) { t.mock.timers.tick(2000); await flush(); }
  assert.equal(h.calls.filter((item) => item.path.endsWith("/status")).length, 151);
  h.button("Language server availability and configuration").click(); await flush();
  assert.equal(h.calls.filter((item) => item.path.endsWith("/status")).length, 152);
  await h.controller.deactivate(); t.mock.timers.tick(10000); await flush();
  assert.equal(h.calls.filter((item) => item.path.endsWith("/status")).length, 152); h.controller.dispose();
});

test("a pending definition lookup refreshes stopped Java status as startup proceeds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(); let java = { language: "java", label: "Java", available: true, running: false, ready: false, trustedProject: true };
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/navigate")) return pending.promise;
    return path.endsWith("/status") && !path.includes("/debug/") ? { languages: [{ ...java }] } : fallback(path, options);
  } });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  const lookup = h.editors.at(-1).actions.get("argus.definition").run(); await flush();
  java = { ...java, running: true, initializing: true };
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · initializing…");
  java = { ...java, initializing: false, ready: true };
  pending.resolve({ locations: [] }); await lookup; await flush();
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · server ready");
  const reads = h.calls.filter((item) => item.path.endsWith("/status")).length;
  t.mock.timers.tick(10000); await flush(); assert.equal(h.calls.filter((item) => item.path.endsWith("/status")).length, reads); h.controller.dispose();
});

test("trust startup refreshes a coalesced status read that predates the new trust state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stale = deferred(), starting = deferred(); let reads = 0;
  let java = { language: "java", label: "Java", available: true, running: true, ready: true, trustedProject: false };
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/status") && !path.includes("/debug/")) return ++reads === 3 ? stale.promise : { languages: [{ ...java }] };
    if (path.endsWith("/language/start")) return starting.promise;
    return fallback(path, options);
  } });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  h.button("Language server availability and configuration").click(); await flush();
  h.button("Language server availability and configuration").click(); await flush();
  const trust = walk(h.host).find((node) => node.type === "checkbox"); trust.checked = true; trust.emit("change");
  h.button("Start Java language server").click(); await flush();
  const oldStatus = { languages: [{ ...java }] };
  java = { ...java, trustedProject: true }; starting.resolve({}); await flush();
  stale.resolve(oldStatus); await flush(); await flush();
  assert.equal(reads, 4, "post-start status must not reuse a snapshot from before trust was granted");
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · server ready");
  assert.equal(h.button("Review Java project trust and indexing").hidden, true);
  assert.equal(walk(h.host).find((node) => node.type === "checkbox").checked, true);
  t.mock.timers.tick(10000); await flush(); assert.equal(reads, 4); h.controller.dispose();
});

test("a delayed status poll cannot overwrite the next repository status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(); let reads = 0;
  const h = harness({ api: (path, options, fallback) => {
    if (!path.endsWith("/status") || path.includes("/debug/")) return fallback(path, options);
    if (path.includes("/repo-a/") && ++reads === 2) return pending.promise;
    return { languages: [{ language: "java", label: "Java", available: true, running: true, initializing: path.includes("/repo-a/"), ready: path.includes("/repo-b/"), trustedProject: true }] };
  } });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  t.mock.timers.tick(2000); await flush();
  const poll = h.calls.filter((item) => item.path.endsWith("/status"))[1];
  await h.controller.activate("repo-b"); await h.controller.openFile("src/Main.java");
  assert.equal(poll.signal.aborted, true);
  pending.resolve({ languages: [{ language: "java", label: "Obsolete", initializing: true }] }); await flush();
  assert.equal(h.byClass("repository-ide-language-status").textContent, "Java · server ready");
  t.mock.timers.tick(10000); await flush(); assert.equal(h.calls.filter((item) => item.path.endsWith("/status")).length, 3); h.controller.dispose();
});

for (const threadId of [4, 0]) test(`debug UI attaches, pauses thread ${threadId}, and loads its frames and variables`, async (t) => {
  let session = null, paused = false;
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/debug/status")) return { adapters: [{ id: "java-jdi", runtime: "java", available: true }], targets: [{ name: "Fixture", runtime: "java", port: 5010, state: "listening" }], session: session && { ...session } };
    if (path.endsWith("/debug/attach")) { session = { id: "debug-1", state: "attached" }; return { ...session }; }
    if (path.includes("/debug/events?")) return { cursor: 2, session: session && { ...session }, events: paused ? [{ seq: 1, event: "stopped", body: { threadId, reason: "pause" } }, { seq: 2, event: "output", body: { category: "telemetry", output: "js-debug/dap/operation" } }] : [] };
    if (path.endsWith("/debug/command")) {
      const { command } = options.body;
      if (command === "setBreakpoints") return { breakpoints: [{ line: 3, verified: true }] };
      if (command === "threads") return { threads: [{ id: threadId, name: threadId === 0 ? "Remote Process [0]" : "main" }] };
      if (command === "pause") { paused = true; session.state = "stopped"; session.threadId = threadId; return {}; }
      if (command === "stackTrace") return { stackFrames: [{ id: threadId, name: "Fixture.main", source: { path: "src/Main.java" }, line: 3, column: 1 }] };
      if (command === "scopes") return { scopes: [{ name: "Locals", variablesReference: 12, expensive: false }] };
      if (command === "variables") return { variables: [{ name: "answer", value: "42", variablesReference: 0 }] };
      return {};
    }
    return fallback(path, options);
  } });
  t.after(() => h.controller.dispose());
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  h.editors.at(-1).mouse({ target: { type: 2, position: { lineNumber: 3 } }, event: {} }); await flush();
  assert.equal(h.byClass("repository-ide-debug").hidden, false, "setting a breakpoint reveals its status and attachment controls");
  assert.match(h.editors.at(-1).decorations[0].options.glyphMarginClassName, /pending/);
  await h.controller.refreshDebug(); assert.equal(h.byClass("repository-ide-debug").hidden, false, "opening Debugger from Processes reveals the controls");
  h.button("Attach debugger to Fixture").click(); await flush();
  assert.deepEqual(h.calls.find((item) => item.path.endsWith("/debug/attach")).body, { adapterId: "java-jdi", port: 5010 });
  assert.deepEqual(h.calls.find((item) => item.body?.command === "setBreakpoints").body.arguments, { source: { path: "src/Main.java" }, breakpoints: [{ line: 3 }] });
  assert.match(h.byClass("repository-ide-debug-notice").textContent, /verified/);
  assert.equal(h.editors.at(-1).decorations[0].options.glyphMarginClassName, "repository-ide-breakpoint");
  h.button("Pause").click(); await flush();
  assert.deepEqual(h.calls.find((item) => item.body?.command === "pause").body.arguments, { threadId });
  await new Promise((resolve) => setTimeout(resolve, 1050)); await flush();
  assert.match(walk(h.byClass("repository-ide-debug-stack")).map((node) => node.textContent).join(" "), /Fixture.main/);
  assert.match(walk(h.byClass("repository-ide-debug-variables")).map((node) => node.textContent).join(" "), /answer: 42/);
  assert.equal(h.byClass("repository-ide-debug-notice").textContent, "Paused: pause", "adapter telemetry must not replace user-facing debug state");
  assert.deepEqual(h.calls.find((item) => item.body?.command === "stackTrace").body.arguments, { threadId });
  assert.deepEqual(h.calls.find((item) => item.body?.command === "scopes").body.arguments, { frameId: threadId });
  assert.equal(h.button("Step over").disabled, false);
  assert.deepEqual(h.editors.at(-1).getPosition(), { lineNumber: 3, column: 1 });
  assert.equal(h.editors.at(-1).decorations.some((decoration) => decoration.options.className === "repository-ide-execution-line"), true);
  h.button("Detach debugger and leave the service running").click(); await flush(); assert.equal(h.button("Step over").disabled, true);
  assert.equal(h.editors.at(-1).decorations.some((decoration) => decoration.options.className === "repository-ide-execution-line"), false);
  const threadQueries = h.calls.filter((item) => item.body?.command === "threads").length;
  h.button("Attach debugger to Fixture").click(); await flush();
  h.button("Pause").click(); await flush();
  assert.equal(h.calls.filter((item) => item.body?.command === "threads").length, threadQueries + 2, "a new attachment discovers its own thread and immediately loads the paused stack");
});

test("breakpoint verification events update the gutter and resuming rejects late paused variables", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let session = { id: "attached", state: "attached", threadId: 0 }, verification = true;
  const scopes = deferred();
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/debug/status")) return { adapters: [], targets: [], session: { ...session } };
    if (path.includes("/debug/events?")) { const events = verification ? [{ event: "breakpoint", body: { breakpoint: { id: 7, line: 8, verified: true, source: { path: "src/Main.java" } } } }] : []; verification = false; return { cursor: 1, session: { ...session }, events }; }
    if (path.endsWith("/debug/command")) {
      const command = options.body.command;
      if (command === "setBreakpoints") return { breakpoints: [{ id: 7, line: 8, verified: false }] };
      if (command === "threads") return { threads: [{ id: 0, name: "main" }] };
      if (command === "stackTrace") return { stackFrames: [{ id: 0, name: "Main.run", source: { path: "src/Paused.java" }, line: 8 }] };
      if (command === "scopes") return scopes.promise;
      if (command === "continue") { session.state = "attached"; return {}; }
      return {};
    }
    return fallback(path, options);
  } });
  t.after(() => h.controller.dispose());
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java", 8, 1); await h.controller.refreshDebug();
  h.key("F9"); await flush(); assert.equal(h.byClass("repository-ide-breakpoint-row").dataset.state, "pending");
  t.mock.timers.tick(1000); await flush(); assert.equal(h.byClass("repository-ide-breakpoint-row").dataset.state, "verified");
  assert.equal(h.editors.at(-1).decorations[0].options.glyphMarginClassName, "repository-ide-breakpoint");
  session.state = "stopped"; const pauseRefresh = h.controller.refreshDebug(); await flush();
  assert.equal(h.controller.getNavigationState().path, "src/Paused.java", "paused source is revealed without waiting for slow scopes");
  h.button("Continue").click(); await flush(); await h.controller.openFile("src/Main.java");
  scopes.resolve({ scopes: [{ name: "Stale paused locals", variablesReference: 9 }] }); await pauseRefresh; await flush();
  assert.equal(h.controller.getNavigationState().path, "src/Main.java");
  assert.equal(h.byClass("repository-ide-debug-variables").children.length, 0);
  assert.equal(h.calls.some((call) => call.body?.command === "variables"), false);
});

test("debugger has keyboard-accessible views, honest empty states, and hidden idle transport", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.refreshDebug();
  assert.equal(h.byClass("repository-ide-debug-session-state").textContent, "Not attached");
  assert.equal(h.byClass("repository-ide-debug-transport").hidden, true);
  assert.equal(h.button("Continue").disabled, true); assert.equal(h.button("Pause").disabled, true);
  assert.match(h.byClass("repository-ide-debug-start").children.at(-1).textContent, /Services configuration in the editor toolbar/);
  const inspect = h.button("Show debug variables & stack"), consoleTab = h.button("Show debug console");
  assert.equal(inspect.getAttribute("aria-selected"), "true");
  inspect.emit("keydown", { key: "ArrowRight" });
  assert.equal(h.document.activeElement, consoleTab); assert.equal(consoleTab.getAttribute("aria-selected"), "true");
  assert.equal(h.byClass("repository-ide-debug-inspectors").hidden, true);
  assert.equal(h.byClass("repository-ide-debug-console-panel").hidden, false);
  consoleTab.emit("keydown", { key: "End" });
  assert.equal(h.button("Show debug breakpoints").getAttribute("aria-selected"), "true");
  assert.equal(h.byClass("repository-ide-debug-breakpoint-panel").hidden, false);
  assert.equal(h.button("Clear debugger output").disabled, true);
  h.controller.dispose();
});

test("debug console retains output while paused, never overwrites pause status, and clears per repository", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let polled = false;
  const h = harness({ api: (path, options, fallback) => {
    if (path.includes("repo-b")) return fallback(path, options);
    if (path.endsWith("/debug/status")) return { adapters: [], targets: [], session: { id: "a", state: "stopped", threadId: 0 } };
    if (path.includes("/debug/events?")) { const events = polled ? [] : [{ event: "stopped", body: { reason: "breakpoint", threadId: 0 } }, { event: "output", body: { output: "First line\n", category: "stdout" } }, { event: "output", body: { output: "Second line\n", category: "stderr" } }, { event: "output", body: { output: "Hidden telemetry", category: "telemetry" } }]; polled = true; return { session: { id: "a", state: "stopped", threadId: 0 }, cursor: 4, events }; }
    return fallback(path, options);
  } });
  t.after(() => h.controller.dispose());
  await h.controller.activate("repo-a"); await h.controller.refreshDebug();
  t.mock.timers.tick(1000); await flush();
  assert.equal(h.byClass("repository-ide-debug-notice").textContent, "Paused: breakpoint");
  assert.deepEqual(h.byClass("repository-ide-debug-output").children.map(node => node.textContent), ["First line\n", "Second line\n"]);
  assert.equal(h.byClass("repository-ide-debug-output").children[1].dataset.category, "stderr");
  h.button("Show debug console").click(); await flush();
  assert.equal(h.byClass("repository-ide-debug-console-panel").hidden, false);
  t.mock.timers.tick(1000); await flush();
  assert.equal(h.byClass("repository-ide-debug-output").children.length, 2);
  await h.controller.activate("repo-b"); await flush();
  assert.equal(h.byClass("repository-ide-debug-output").children.length, 0);
  assert.equal(h.byClass("repository-ide-debug-session-state").textContent, "Not attached");
});

test("pending debugger target refresh cannot populate the next repository", async (t) => {
  const stale = deferred();
  const h = harness({ api: (path, options, fallback) => path.includes("repo-a") && path.endsWith("/debug/status") ? stale.promise : fallback(path, options) });
  t.after(() => h.controller.dispose());
  await h.controller.activate("repo-a"); const refresh = h.controller.refreshDebug();
  await h.controller.activate("repo-b"); await flush();
  stale.resolve({ adapters: [], targets: [], session: { id: "stale", state: "attached" } }); await refresh;
  assert.equal(h.byClass("repository-ide-debug-session-state").textContent, "Not attached");
  assert.equal(h.byClass("repository-ide-debug-transport").hidden, true);
  assert.equal(h.button("Find local Argus debug targets").disabled, false);
});

test("switching repositories during attachment resets busy controls and rejects the old session", async (t) => {
  const pending = deferred();
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/debug/status")) return { adapters: [{ id: "java-jdi", runtime: "java", available: true }], targets: [{ name: path.includes("repo-a") ? "Service A" : "Service B", runtime: "java", port: 5010, state: "listening" }], session: null };
    if (path.endsWith("/debug/attach")) return pending.promise;
    return fallback(path, options);
  } });
  t.after(() => h.controller.dispose());
  await h.controller.activate("repo-a"); await h.controller.refreshDebug();
  h.button("Attach debugger to Service A").click(); await flush();
  assert.equal(h.button("Attach debugger to Service A").disabled, true);
  await h.controller.activate("repo-b"); await flush();
  assert.equal(h.byClass("repository-ide-tool-dock").dataset.open, "false", "new repositories start with a collapsed dock");
  await h.controller.refreshDebug();
  assert.equal(h.button("Attach debugger to Service B").disabled, false);
  pending.resolve({ id: "stale-a", state: "attached" }); await flush();
  assert.equal(h.byClass("repository-ide-debug-session-state").textContent, "Not attached");
  assert.equal(h.calls.some(call => call.body?.command === "configurationDone"), false);
});

for (const source of ["events", "status"]) test(`late debug ${source} cannot resurrect a detached session`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(); let statusReads = 0;
  const session = { id: "live", state: "attached", threadId: 0 };
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/debug/status")) return source === "status" && ++statusReads > 1 ? pending.promise : { adapters: [], targets: [], session: { ...session } };
    if (path.includes("/debug/events?")) return pending.promise;
    return fallback(path, options);
  } });
  t.after(() => h.controller.dispose());
  await h.controller.activate("repo-a"); await h.controller.refreshDebug();
  let refreshing;
  if (source === "events") { t.mock.timers.tick(1000); await flush(); } else refreshing = h.controller.refreshDebug();
  h.button("Detach debugger and leave the service running").click(); await flush();
  pending.resolve({ adapters: [], targets: [], session, cursor: 1, events: [{ event: "output", body: { output: "Stale output" } }] }); await refreshing; await flush();
  assert.equal(h.byClass("repository-ide-debug-session-state").textContent, "Not attached");
  assert.equal(h.button("Pause").disabled, true);
  assert.equal(h.byClass("repository-ide-debug-output").children.length, 0);
  assert.match(h.byClass("repository-ide-debug-notice").textContent, /application keeps running/);
  const detach = h.calls.find(call => call.path.endsWith("/debug/session") && call.method === "DELETE");
  assert.equal(detach.body, undefined, "detach never requests process termination");
});

test("unavailable adapters and unready targets disable attach without starting a debugger", async (t) => {
  const h = harness({ api: (path, options, fallback) => path.endsWith("/debug/status") ? { session: null, adapters: [{ id: "java-jdi", runtime: "java", available: true }, { id: "node", runtime: "node", available: false, reason: "Missing adapter" }], targets: [{ name: "Starting Java", runtime: "java", port: 5005, state: "starting" }, { name: "Unavailable Node", runtime: "node", port: 9229, state: "listening" }] } : fallback(path, options) });
  t.after(() => h.controller.dispose());
  await h.controller.activate("repo-a"); await h.controller.refreshDebug();
  for (const name of ["Starting Java", "Unavailable Node"]) { assert.equal(h.button(`Attach debugger to ${name}`).disabled, true); h.button(`Attach debugger to ${name}`).click(); }
  await flush(); assert.equal(h.calls.some(call => call.path.endsWith("/debug/attach")), false);
});

test("typing applies model deltas without full model reads and preserves stable tabs and breakpoint rows", async () => {
  const h = harness(); await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java");
  h.key("F9"); await flush();
  const model = h.models.at(-1), originalGet = model.getValue; let reads = 0;
  model.getValue = function () { reads++; return originalGet.call(this); };
  const point = h.byClass("repository-ide-breakpoint-row");
  model.change([{ rangeOffset: model.content.length, rangeLength: 0, text: "a" }]);
  const tab = h.byClass("repository-ide-tab");
  model.change([{ rangeOffset: model.content.length, rangeLength: 0, text: "b" }]);
  assert.equal(reads, 0); assert.equal(h.controller.isDirty(), true);
  assert.equal(h.byClass("repository-ide-tab"), tab); assert.equal(h.byClass("repository-ide-breakpoint-row"), point);
  h.key("s", { ctrlKey: true }); await flush();
  assert.equal(h.calls.find(call => call.method === "PUT" && call.path.endsWith("/file")).body.content, "class src/Main.java {}ab");
  model.change([{ rangeOffset: 0, rangeLength: model.content.length, text: "new disk" }], { isFlush: true, content: "new disk" });
  assert.ok(reads > 0); await h.controller.deactivate();
});

test("idle debug polls retain breakpoint DOM and unchanged gutter decorations", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = { id: "session", state: "attached", adapterId: "java-jdi" };
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/debug/status")) return { session, targets: [], adapters: [] };
    if (path.includes("/debug/events?")) return { session, cursor: 0, events: [] };
    return fallback(path, options);
  } });
  await h.controller.activate("repo-a"); await h.controller.openFile("src/Main.java"); await h.controller.refreshDebug();
  h.key("F9"); await flush();
  const row = h.byClass("repository-ide-breakpoint-row"), editor = h.editors.at(-1), originalDecorations = editor.deltaDecorations;
  let updates = 0; editor.deltaDecorations = function (...args) { updates++; return originalDecorations.apply(this, args); };
  t.mock.timers.tick(1000); await flush();
  assert.equal(h.byClass("repository-ide-breakpoint-row"), row); assert.equal(updates, 0);
  h.controller.dispose();
});

test("paused source loads while variable scopes fetch in parallel with a concurrency limit of three", async () => {
  const pending = new Map(); let active = 0, peak = 0;
  const h = harness({ api: (path, options, fallback) => {
    if (path.endsWith("/debug/status")) return { session: { id: "session", state: "stopped", adapterId: "java-jdi", threadId: 1 }, targets: [], adapters: [] };
    if (path.endsWith("/debug/command")) {
      const { command, arguments: args } = options.body;
      if (command === "threads") return { threads: [{ id: 1, name: "main" }] };
      if (command === "stackTrace") return { stackFrames: [{ id: 1, name: "Main.work", source: { path: "src/Paused.java" }, line: 7 }] };
      if (command === "scopes") return { scopes: Array.from({ length: 5 }, (_, index) => ({ name: `Scope ${index}`, variablesReference: index + 1 })) };
      if (command === "variables") { const request = deferred(); pending.set(args.variablesReference, request); peak = Math.max(peak, ++active); return request.promise.finally(() => { active--; }); }
      return {};
    }
    return fallback(path, options);
  } });
  await h.controller.activate("repo-a"); const refresh = h.controller.refreshDebug(); await flush();
  assert.equal(h.controller.getNavigationState().path, "src/Paused.java"); assert.equal(pending.size, 3); assert.equal(active, 3);
  pending.get(1).resolve({ variables: [] }); pending.get(2).resolve({ variables: [] }); await flush();
  assert.equal(pending.size, 5); assert.equal(peak, 3);
  for (const request of pending.values()) request.resolve({ variables: [] });
  await refresh; assert.equal(h.byClass("repository-ide-debug-variables").children.length, 5); h.controller.dispose();
});
