import test from "node:test";
import assert from "node:assert/strict";
import { createIdeCodeDiscussions } from "../public/ide-code-discussions.mjs";
import { captureCodeAnchor } from "../public/ide-code-anchors.mjs";

const code = ["package sample;", "", "class ReviewService {", "  // Creates a review", "  Review createReview(Request input) {", "    return save(input);", "  }", "}", ""].join("\n");
const path = "src/ReviewService.java";
const selection = { startLineNumber: 5, startColumn: 10, endLineNumber: 5, endColumn: 22 };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function anchor(options = {}) { return captureCodeAnchor({ path, content: code, line: 5, column: 10, endLine: 5, endColumn: 22, ...options }); }

class Element {
  constructor(ownerDocument, tag = "div") { this.ownerDocument = ownerDocument; this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.rect = { left: 10, top: 20 }; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  getBoundingClientRect() { return this.rect; }
  emit(name, options = {}) { const event = { target: this, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...options }; for (const callback of this.listeners.get(name) || []) callback(event); return event; }
}
function document() { const doc = { defaultView: {} }; doc.createElement = tag => new Element(doc, tag); doc.head = doc.createElement("head"); return doc; }
const monaco = { Range: class { constructor(startLineNumber, startColumn, endLineNumber, endColumn) { Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn }); } }, editor: { GlyphMarginLane: { Left: 1 } } };
function surface({ doc = document(), content = code, side = "source", staged = false, ...options } = {}) {
  const node = doc.createElement("div"), contentListeners = new Set(), focusListeners = new Set();
  const model = {
    content, disposed: false, reads: 0,
    getValue() { this.reads++; return this.content; },
    getWordAtPosition() { return { word: "createReview" }; },
    isDisposed() { return this.disposed; },
    onDidChangeContent(callback) { contentListeners.add(callback); return { dispose: () => contentListeners.delete(callback) }; },
    change(next) { this.content = next; for (const callback of contentListeners) callback(); },
  };
  const editor = {
    glyphs: [], focused: false, at: { lineNumber: 5, column: 10 }, selection: { ...selection },
    getDomNode: () => node, getPosition() { return this.at; }, getSelection() { return this.selection; },
    hasTextFocus() { return this.focused; }, getScrolledVisiblePosition: () => ({ left: 100, top: 40, height: 18 }),
    addGlyphMarginWidget(widget) { this.glyphs.push(widget); node.append(widget.getDomNode()); },
    removeGlyphMarginWidget(widget) { this.glyphs = this.glyphs.filter(item => item !== widget); widget.getDomNode().remove(); },
    onDidFocusEditorText(callback) { focusListeners.add(callback); return { dispose: () => focusListeners.delete(callback) }; },
    focus() { this.focused = true; for (const callback of focusListeners) callback(); },
  };
  return { editor, model, path, side, staged, ...options, contentListeners, focusListeners, node, doc };
}
function harness({ api: customApi, data = { discussions: [] }, loadChat: customLoadChat } = {}) {
  const doc = document(), host = doc.createElement("div"), calls = [], opens = [], errors = [], changes = [];
  let loads = 0, creates = 0, deactivations = 0, disposals = 0, popupOptions;
  const popup = { async open(options) { opens.push(options); }, deactivate() { deactivations++; }, dispose() { disposals++; } };
  const module = { createIdeCodeChat(options) { creates++; popupOptions = options; return popup; } };
  const api = async (url, options = {}) => { calls.push({ url, ...options }); return customApi ? customApi(url, options) : data; };
  const modelSettings = () => ({ provider: "codex", model: "configured-model" });
  const onOpenTask = () => {};
  const controller = createIdeCodeDiscussions({ host, document: doc, api, getModelSettings: modelSettings, onOpenTask,
    onChanged: value => changes.push(value), onError: error => errors.push(error),
    loadChat: () => { loads++; return customLoadChat ? customLoadChat(module) : Promise.resolve(module); } });
  return { controller, doc, host, calls, opens, errors, changes, modelSettings, onOpenTask, module, popup,
    get loads() { return loads; }, get creates() { return creates; }, get deactivations() { return deactivations; }, get disposals() { return disposals; }, get popupOptions() { return popupOptions; } };
}

test("construction is idle; activation only reads this repository's metadata without loading AI or popup", async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.equal(h.loads, 0);
  assert.equal(await h.controller.ask(), false);
  h.controller.activate("repo/with space"); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/api/repositories/repo%2Fwith%20space/code-discussions");
  assert.equal(h.calls[0].method, undefined);
  assert.equal(h.calls[0].dedupe, false);
  assert.ok(h.calls[0].signal instanceof AbortSignal);
  assert.equal(h.loads, 0);
  assert.equal(h.creates, 0);
  h.controller.dispose();
});

test("source selection opens the lazy popup with bounded code context and configured AI settings", async () => {
  const h = harness(), source = surface();
  h.controller.activate("repo-a"); await flush(); h.controller.setSurfaces([source], monaco);
  assert.equal(await h.controller.ask(source.editor), true);
  assert.equal(h.loads, 1);
  assert.equal(h.creates, 1);
  assert.equal(h.opens[0].repositoryId, "repo-a");
  assert.equal(h.opens[0].anchor.selection, "createReview");
  assert.equal(h.opens[0].anchor.side, "source");
  assert.deepEqual(h.opens[0].position, { left: 122, top: 66 });
  assert.equal(h.popupOptions.getModelSettings, h.modelSettings);
  assert.equal(h.popupOptions.onOpenTask, h.onOpenTask);
  assert.equal(h.calls.length, 1, "opening a popup does not send a model request");
  await h.controller.ask(source.editor);
  assert.equal(h.loads, 1); assert.equal(h.creates, 1);
  assert.equal(source.model.content, code, "annotations never alter source text");
  h.controller.dispose();
});

test("both diff panes capture their own snapshots, side, staged flag and current selection", async () => {
  const h = harness(), before = surface({ side: "before", staged: true }), after = surface({ side: "after", staged: true, content: code.replace("createReview", "updateReview") });
  h.controller.activate("repo-a"); await flush(); h.controller.setSurfaces([before, after], monaco);
  await h.controller.ask(before.editor); await h.controller.ask(after.editor);
  assert.deepEqual(h.opens.map(item => [item.anchor.side, item.anchor.staged, item.anchor.selection]), [["before", true, "createReview"], ["after", true, "updateReview"]]);
  assert.equal(before.model.content, code); assert.equal(after.model.content, code.replace("createReview", "updateReview"));
  h.controller.dispose();
});

test("toolbar ask follows focused diff pane and falls back to last focused pane", async () => {
  const h = harness(), before = surface({ side: "before" }), after = surface({ side: "after" });
  h.controller.activate("repo-a"); await flush(); h.controller.setSurfaces([before, after], monaco);
  before.editor.focus(); await h.controller.ask();
  assert.equal(h.opens.at(-1).anchor.side, "before");
  before.editor.focused = false; await h.controller.ask();
  assert.equal(h.opens.at(-1).anchor.side, "before");
  after.editor.focus(); await h.controller.ask();
  assert.equal(h.opens.at(-1).anchor.side, "after");
  h.controller.dispose();
});

test("cursor-only and dirty-buffer actions snapshot the actual editor text, never stale disk content", async () => {
  const h = harness(), source = surface({ getState: () => ({ content: code.replace("createReview", "draftReview"), contentHash: "saved-sha", unsaved: true }) });
  source.editor.selection = undefined;
  h.controller.activate("repo-a"); await flush(); h.controller.setSurfaces([source], monaco); await h.controller.ask();
  const saved = h.opens[0].anchor;
  assert.equal(saved.unsaved, true);
  assert.equal(saved.contentHash, "saved-sha");
  assert.equal(saved.selection, "  Review draftReview(Request input) {");
  assert.equal(saved.column, 1);
  assert.equal(source.model.content, code);
  assert.equal(h.calls.every(call => !call.method || call.method === "GET"), true);
  h.controller.dispose();
});

test("saved selection reopens its discussion after lines move, rather than making duplicate threads", async () => {
  const h = harness({ data: { discussions: [{ id: "discussion-1", anchor: anchor() }] } });
  const source = surface({ content: "// new header\n" + code });
  source.editor.selection = { ...selection, startLineNumber: 6, endLineNumber: 6 };
  source.editor.at.lineNumber = 6;
  h.controller.activate("repo-a"); await flush(); h.controller.setSurfaces([source], monaco); await h.controller.ask();
  assert.equal(h.opens[0].discussionId, "discussion-1");
  assert.equal(h.opens[0].anchor.line, 6);
  assert.equal(source.editor.glyphs[0].getPosition().range.startLineNumber, 6);
  h.controller.dispose();
});

test("unrelated, ambiguous, outdated and different-side anchors never receive misleading markers", async () => {
  const existing = anchor();
  const h = harness({ data: { discussions: [
    { id: "original", anchor: existing },
    { id: "elsewhere", anchor: { ...existing, path: "src/Elsewhere.java" } },
    { id: "before", anchor: { ...existing, side: "before" } },
  ] } });
  const source = surface({ content: code + code });
  h.controller.activate("repo-a"); await flush(); h.controller.setSurfaces([source], monaco);
  assert.equal(source.editor.glyphs.length, 0);
  await h.controller.ask(source.editor); assert.equal(h.opens[0].discussionId, undefined);
  const changed = surface({ content: code.replace("return save(input)", "return reject(input)") });
  h.controller.setSurfaces([changed], monaco); assert.equal(changed.editor.glyphs.length, 0);
  h.controller.dispose();
});

test("glyph clicks reopen discussions and consume mouse events instead of toggling breakpoints", async () => {
  const h = harness({ data: { discussions: [{ id: "d1", anchor: anchor() }, { id: "d2", anchor: anchor() }] } }), source = surface();
  h.controller.activate("repo-a"); await flush(); h.controller.setSurfaces([source], monaco);
  assert.equal(source.editor.glyphs.length, 1, "same-line discussions share a compact marker");
  const widget = source.editor.glyphs[0], node = widget.getDomNode();
  assert.equal(widget.getPosition().lane, monaco.editor.GlyphMarginLane.Left);
  assert.match(node.getAttribute("aria-label"), /2 code discussions/);
  assert.equal(source.doc.head.children.length, 1);
  for (const type of ["mousedown", "click"]) {
    const event = node.emit(type); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  }
  await flush(); assert.equal(h.opens[0].discussionId, "d1");
  await h.controller.refresh(); assert.equal(source.doc.head.children.length, 1, "iframe styles are installed only once");
  h.controller.dispose();
});

test("markers disappear immediately during edits and resolve once after a typing pause", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ data: { discussions: [{ id: "d1", anchor: anchor() }] } }), source = surface();
  h.controller.activate("repo-a"); await flush(); h.controller.setSurfaces([source], monaco);
  assert.equal(source.editor.glyphs.length, 1);
  source.model.change("// first\n" + code); assert.equal(source.editor.glyphs.length, 0);
  t.mock.timers.tick(200);
  source.model.change("// first\n// second\n" + code); t.mock.timers.tick(299);
  assert.equal(source.editor.glyphs.length, 0);
  t.mock.timers.tick(1);
  assert.equal(source.editor.glyphs.length, 1);
  assert.equal(source.editor.glyphs[0].getPosition().range.startLineNumber, 7);
  assert.equal(h.calls.length, 1, "typing triggers no requests or AI calls");
  h.controller.dispose();
});

test("an old repository index response cannot decorate the next repository", async () => {
  const first = deferred(), second = deferred();
  const h = harness({ api: url => url.includes("repo-a") ? first.promise : second.promise }), source = surface();
  h.controller.activate("repo-a"); h.controller.setSurfaces([source], monaco);
  const oldSignal = h.calls[0].signal;
  h.controller.activate("repo-b"); h.controller.setSurfaces([source], monaco);
  assert.equal(oldSignal.aborted, true);
  second.resolve({ discussions: [] }); await flush();
  first.resolve({ discussions: [{ id: "wrong-repo", anchor: anchor() }] }); await flush();
  assert.equal(source.editor.glyphs.length, 0);
  await h.controller.ask(); assert.equal(h.opens[0].repositoryId, "repo-b"); assert.equal(h.opens[0].discussionId, undefined);
  h.controller.dispose();
});

test("a superseded refresh in the same repository cannot replace a newer metadata result", async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const h = harness({ api: () => ++reads === 1 ? first.promise : second.promise }), source = surface();
  h.controller.activate("repo-a"); h.controller.setSurfaces([source], monaco);
  const latest = h.controller.refresh();
  second.resolve({ discussions: [{ id: "new-discussion", anchor: anchor() }] }); await latest;
  first.resolve({ discussions: [{ id: "old-discussion", anchor: anchor() }] }); await flush();
  await h.controller.ask(); assert.equal(h.opens[0].discussionId, "new-discussion");
  assert.equal(h.calls[0].signal.aborted, true);
  h.controller.dispose();
});

test("lazy popup load completion from an old repository does not open a stale conversation", async () => {
  const loading = deferred(), h = harness({ loadChat: () => loading.promise }), source = surface();
  h.controller.activate("repo-a"); await flush(); h.controller.setSurfaces([source], monaco);
  const old = h.controller.ask();
  h.controller.activate("repo-b"); await flush();
  loading.resolve(h.module);
  assert.equal(await old, false);
  assert.equal(h.opens.length, 0);
  assert.equal(h.creates, 0);
  await h.controller.open(); assert.equal(h.opens[0].repositoryId, "repo-b");
  assert.equal(h.opens[0].anchor, undefined);
  assert.equal(h.loads, 1);
  h.controller.dispose();
});

test("repository discussion history opens without any file, and closing leaves no listeners or markers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ data: { discussions: [{ id: "d1", anchor: anchor() }] } }), source = surface();
  h.controller.activate("repo-a"); await flush();
  assert.equal(await h.controller.open(), true);
  assert.equal(h.opens[0].anchor, undefined); assert.equal(h.opens[0].position, undefined);
  h.controller.setSurfaces([source], monaco);
  const oldButton = source.editor.glyphs[0].getDomNode();
  assert.equal(source.contentListeners.size, 1); assert.equal(source.focusListeners.size, 1);
  source.model.change("// header\n" + code);
  h.controller.deactivate(); t.mock.timers.tick(1000);
  assert.equal(source.editor.glyphs.length, 0);
  assert.equal(source.contentListeners.size, 0); assert.equal(source.focusListeners.size, 0);
  assert.equal(h.deactivations, 1);
  oldButton.emit("click"); await flush(); assert.equal(h.opens.length, 1);
  assert.equal(await h.controller.open(), false);
  h.controller.dispose(); assert.equal(h.disposals, 1);
});

test("popup changes refresh only the currently visible repository index", async () => {
  const h = harness(); h.controller.activate("repo-a"); await flush(); await h.controller.open();
  h.popupOptions.onChanged({ repositoryId: "repo-b", discussionId: "foreign" }); await flush();
  assert.equal(h.calls.length, 1);
  h.popupOptions.onChanged({ repositoryId: "repo-a", discussionId: "local" }); await flush();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.changes.map(change => change.discussionId), ["foreign", "local"]);
  h.controller.dispose();
});

test("API errors are reported, aborts ignored, and failed lazy imports are retryable", async () => {
  const failure = new Error("index unavailable"), h = harness({ api: async () => { throw failure; } });
  h.controller.activate("repo-a"); await flush(); assert.deepEqual(h.errors, [failure]);
  const aborted = harness({ api: async () => { throw new DOMException("cancelled", "AbortError"); } });
  aborted.controller.activate("repo-a"); await flush(); assert.deepEqual(aborted.errors, []);
  let attempts = 0;
  const retry = harness({ loadChat: module => ++attempts === 1 ? Promise.reject(new Error("chunk missing")) : Promise.resolve(module) });
  retry.controller.activate("repo-a"); await flush();
  await assert.rejects(retry.controller.open(), /chunk missing/);
  assert.equal(await retry.controller.open(), true);
  assert.equal(retry.loads, 2);
  assert.equal(retry.calls.every(call => !call.method || call.method === "GET"), true);
  h.controller.dispose(); aborted.controller.dispose(); retry.controller.dispose();
});
