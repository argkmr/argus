import test from "node:test";
import assert from "node:assert/strict";
import { createRepositoryIdeBridge } from "../public/repository-ide-bridge.mjs";
import { validateArchiveEntries, JDTLS } from "../scripts/build-ide-tools.mjs";
import fs from "node:fs/promises";

function harness({ load: loading = async () => {}, values = new Map(), ...callbacks } = {}) {
  const listeners = {}, calls = [], errors = [], visibility = [], activationOptions = [], classes = new Set(), navigation = [];
  let editorOptions, chatSyncs = 0;
  let repository = { id: "a" }, dirty = false;
  const attributes = new Map();
  const button = { disabled: true, setAttribute: (name, value) => attributes.set(name, value), addEventListener: (name, fn) => { listeners[name] = fn; } };
  const host = { hidden: true };
  const document = { querySelector: selector => selector.endsWith("toggle") ? button : selector === "#repository-ide-host" ? host : null, body: { classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) } }, defaultView: { addEventListener: (name, fn) => { listeners[name] = fn; } } };
  const instance = { activate: async (repo, options) => { activationOptions.push(options); calls.push(["activate", repo.id]); }, deactivate: async () => calls.push(["deactivate"]), revealNavigation: async (source, result, current) => { if (!current()) return false; calls.push(["reveal", source, result]); return true; }, openDiff: async payload => { calls.push(["diff", payload]); return true; }, restoreLocation: async (location, current) => { if (!current()) return false; calls.push(["restore", location]); return true; }, getNavigationState: () => ({ surface: "file", path: "main.ts", line: 5, column: 2 }), syncChatVisibility: () => { chatSyncs++; }, isDirty: () => dirty, dispose() {} };
  const bridge = createRepositoryIdeBridge({ document, storage: { getItem: k => values.get(k), setItem: (k,v) => values.set(k,v) }, api() {}, getRepository: () => repository, onError: e => errors.push(e), onVisibilityChange: value => visibility.push(value), onNavigationChange: (...args) => navigation.push(args), ...callbacks, load: async () => { calls.push(["load"]); await loading(); return { createRepositoryIde: options => { editorOptions = options; return instance; } }; } });
  return { bridge, instance, calls, values, host, button, attributes, listeners, errors, visibility, activationOptions, classes, navigation, get editorOptions() { return editorOptions; }, get chatSyncs() { return chatSyncs; }, repo: value => { repository = value; }, dirty: value => { dirty = value; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("repository code is the default surface even with a legacy disabled preference", async () => {
  for (const preference of [undefined, "disabled"]) {
    const h = harness(); if (preference) h.values.set("argus-ide:a", preference);
    assert.deepEqual(h.calls, [], "construction remains lazy until a repository is shown");
    await h.bridge.sync();
    assert.deepEqual(h.calls, [["load"], ["activate", "a"]]); assert.equal(h.host.hidden, false);
    assert.equal(h.values.get("argus-ide:a"), preference, "obsolete preferences are ignored without rewriting user storage");
  }
});

test("header chat toggle names the next action without disabling code or losing buffers", async () => {
  const h = harness();
  assert.equal(h.attributes.get("aria-label"), "Show AI chat");
  assert.equal(h.attributes.get("aria-pressed"), "false");
  assert.equal(h.button.disabled, true);
  await h.bridge.sync();
  assert.equal(h.attributes.get("aria-label"), "Hide AI chat");
  assert.equal(h.attributes.get("aria-pressed"), "true");
  assert.equal(h.attributes.get("aria-expanded"), "true");
  assert.equal(h.button.disabled, false);
  h.dirty(true);
  h.listeners.click();
  assert.equal(h.attributes.get("aria-label"), "Show AI chat");
  assert.equal(h.attributes.get("aria-pressed"), "false");
  assert.equal(h.attributes.get("aria-expanded"), "false");
  assert.equal(h.values.get("argus-ide-chat:a"), "hidden");
  assert.equal(h.values.get("argus-ide:a"), undefined);
  assert.equal(h.bridge.isDirty("a"), true);
  assert.equal(h.host.hidden, false);
  assert.deepEqual(h.calls, [["load"], ["activate", "a"]], "chat disclosure never remounts or deactivates code");
  assert.deepEqual(h.visibility, [true], "chat disclosure must not trigger repository surface transitions");
  h.listeners.click();
  assert.equal(h.attributes.get("aria-label"), "Hide AI chat");
  assert.equal(h.values.get("argus-ide-chat:a"), "visible");
  h.repo(null); await h.bridge.sync();
  assert.equal(h.button.disabled, true);
  assert.equal(h.attributes.get("aria-label"), "Show AI chat");
  assert.equal(h.button.textContent, undefined, "State changes must not replace the icon-only button contents");
});

test("old navigation snapshots cannot disable default code and absent repositories remain lazy", async () => {
  const h = harness(); h.repo(null); await h.bridge.sync(); assert.deepEqual(h.calls, []);
  h.repo({ id: "a" });
  assert.equal(await h.bridge.setEnabled("a", false), true);
  assert.equal(h.host.hidden, false); assert.deepEqual(h.activationOptions, [{ focus: false }]);
  h.dirty(true); assert.equal(await h.bridge.setEnabled("a", false), true);
  assert.equal(h.bridge.isDirty("a"), true); assert.deepEqual(h.calls, [["load"], ["activate", "a"]]);
  assert.equal(await h.bridge.setEnabled("b", false), false);
});

test("source citations reveal the selected editor without discarding existing buffers", async () => {
  const h = harness(), opened = [];
  h.instance.openFile = async (...args) => { opened.push(args); return true; };
  h.dirty(true);
  const source = { repositoryId: "a", kind: "text", file: "package.json", line: 11, column: 3 };
  assert.equal(await h.bridge.openSourceReference("a", source), true);
  assert.deepEqual(opened[0].slice(0, 3), ["package.json", 11, 3]);
  assert.equal(opened[0][3].isValid(), true);
  assert.equal(h.bridge.isDirty("a"), true);
  h.repo({ id: "b" });
  assert.equal(opened[0][3].isValid(), false);
  assert.equal(await h.bridge.openSourceReference("a", source), false);
  assert.equal(await h.bridge.openSourceReference("b", source), false);
  assert.equal(opened.length, 1);
});

test("bridge forwards Services and terminal integration without loading either before IDE enable", async () => {
  const callbacks = Object.fromEntries(["getRunState", "onRunAction", "onRunSelect", "onRunConfigure", "onTerminalToggle", "onTerminalHide", "onTerminalMount"].map(name => [name, () => name]));
  const h = harness(callbacks); assert.deepEqual(h.calls, []);
  await h.bridge.enable("a");
  for (const [name, callback] of Object.entries(callbacks)) assert.equal(h.editorOptions[name], callback);
  let runs = 0, terminal;
  h.instance.syncRunState = () => runs++;
  h.instance.syncTerminalState = value => { terminal = value; };
  h.bridge.syncRunState(); h.bridge.syncTerminalState({ visible: true, repositoryId: "a" });
  assert.equal(runs, 1); assert.equal(terminal.repositoryId, "a");
});

test("code chat callbacks stay lazy and saved discussions open only in the selected repository", async () => {
  const callbacks = Object.fromEntries(["getCodeChatSettings", "onCodeChatOpenTask", "onCodeDiscussionChanged"].map(name => [name, () => name]));
  const h = harness(callbacks), opened = [];
  h.instance.openCodeDiscussions = () => { opened.push("opened"); return true; };
  assert.deepEqual(h.calls, []);
  assert.equal(await h.bridge.openCodeDiscussions("b"), false);
  assert.equal(await h.bridge.openCodeDiscussions("a"), true);
  for (const [name, callback] of Object.entries(callbacks)) assert.equal(h.editorOptions[name], callback);
  assert.deepEqual(opened, ["opened"]);
  h.repo({ id: "b" }); assert.equal(await h.bridge.openCodeDiscussions("a"), false);
});

test("version control callbacks and synchronization are scoped to the visible current IDE", async () => {
  const toggles = [], mounts = []; let open = false, syncs = 0;
  const h = harness({ getVersionControlOpen: id => id === "a" && open, onVersionControlToggle: id => { toggles.push(id); open = !open; return open; }, onVersionControlMount: slot => mounts.push(slot) });
  h.instance.syncVersionControlState = () => { syncs++; };
  assert.deepEqual(h.calls, []); h.bridge.syncVersionControlState(); assert.equal(syncs, 0);
  await h.bridge.enable("a"); const options = h.editorOptions;
  options.onVersionControlMount("git-slot"); assert.deepEqual(mounts, ["git-slot"]);
  assert.equal(options.getVersionControlOpen("a"), false);
  assert.equal(options.onVersionControlToggle("a"), true); assert.equal(options.getVersionControlOpen("a"), true);
  assert.equal(options.onVersionControlToggle("b"), false); assert.equal(options.getVersionControlOpen("b"), false);
  h.bridge.syncVersionControlState(); assert.ok(syncs > 0);
  h.repo({ id: "b" }); assert.equal(options.onVersionControlToggle("a"), false); assert.equal(options.getVersionControlOpen("a"), false);
  h.repo({ id: "a" }); await h.bridge.sync(false); const afterHide = syncs;
  assert.ok(afterHide > 1); assert.equal(options.onVersionControlToggle("a"), false); assert.equal(options.getVersionControlOpen("a"), false);
  assert.deepEqual(toggles, ["a"]);
});

test("bridge leaves unsupported version control absent so standalone IDE toolbars hide the control", async () => {
  const h = harness(); await h.bridge.enable("a");
  assert.equal(h.editorOptions.onVersionControlToggle, undefined); assert.equal(h.editorOptions.onVersionControlMount, undefined); assert.equal(h.editorOptions.getVersionControlOpen("a"), false);
});

test("automatic debugger attachment is accepted only for the visible current IDE repository", async () => {
  const h = harness(), attached = [];
  h.instance.attachLaunchedDebug = async process => { attached.push(process.id); return true; };
  const process = { id: "process-a", configurationId: "config-a" };
  assert.equal(h.bridge.attachLaunchedDebug("a", process), false);
  await h.bridge.enable("a");
  assert.equal(await h.bridge.attachLaunchedDebug("a", process), true);
  assert.equal(h.bridge.attachLaunchedDebug("b", process), false);
  h.repo({ id: "b" });
  assert.equal(h.bridge.attachLaunchedDebug("a", process), false);
  await h.bridge.sync(false);
  assert.equal(h.bridge.attachLaunchedDebug("b", process), false);
  assert.deepEqual(attached, ["process-a"]);
});
test("launch output opens only in the visible current IDE without enabling or switching repositories", async () => {
  const h = harness(), opened = [];
  h.instance.showRunLogs = () => { opened.push("output"); return true; };
  assert.equal(h.bridge.showRunLogs("a"), false); assert.deepEqual(h.calls, []);
  await h.bridge.enable("a");
  assert.equal(h.bridge.showRunLogs("a"), true); assert.equal(h.bridge.showRunLogs("b"), false);
  h.repo({ id: "b" }); assert.equal(h.bridge.showRunLogs("a"), false); assert.equal(h.bridge.showRunLogs("b"), false);
  h.repo({ id: "a" }); await h.bridge.sync(false); assert.equal(h.bridge.showRunLogs("a"), false);
  assert.deepEqual(opened, ["output"]);
});
test("default code is scoped per repository and imports once; returning keeps buffers", async () => {
  const h = harness(); await h.bridge.enable("a"); await h.bridge.sync();
  assert.deepEqual(h.calls, [["load"], ["activate", "a"]]);
  h.repo({ id: "b" }); await h.bridge.sync(); assert.equal(h.host.hidden, false);
  h.repo({ id: "a" }); await h.bridge.sync();
  assert.deepEqual(h.calls, [["load"], ["activate", "a"], ["deactivate"], ["activate", "b"], ["deactivate"], ["activate", "a"]]);
});
test("Nexus or tools deactivate IDE without changing the saved repo preference", async () => {
  const h = harness(); await h.bridge.enable("a"); await h.bridge.sync(false);
  assert.equal(h.host.hidden, true); assert.equal(h.values.get("argus-ide:a"), undefined);
  await h.bridge.sync(true); assert.deepEqual(h.calls.at(-1), ["activate", "a"]);
});
test("IDE presentation changes only once per transition so chat remains unobstructed", async () => {
  const h = harness(); await h.bridge.enable("a"); await h.bridge.sync(); await h.bridge.sync(false);
  assert.deepEqual(h.visibility, [true, false]);
});
test("unsaved buffers protect window close even when the IDE is hidden", async () => {
  const h = harness(); await h.bridge.enable("a"); h.dirty(true); await h.bridge.sync(false);
  let prevented = false; const event = { preventDefault() { prevented = true; } };
  h.listeners.beforeunload(event); assert.equal(prevented, true); assert.equal(event.returnValue, "");
});
test("diff mutation helpers stay lazy and target the retained repository buffer after navigation", async () => {
  const h = harness(), invalidations = [];
  assert.equal(h.bridge.isFileDirty("a", "main.ts"), false);
  assert.equal(h.bridge.invalidateSavedFile("a", "main.ts"), undefined);
  assert.deepEqual(h.calls, [], "checking absent buffers must not load the editor");
  await h.bridge.enable("a");
  h.instance.isFileDirty = (id, path) => id === "a" && path === "draft.ts";
  h.instance.invalidateSavedFile = (...args) => { invalidations.push(args); return true; };
  h.repo({ id: "b" }); await h.bridge.sync(false);
  assert.equal(h.bridge.isFileDirty("a", "draft.ts"), true);
  assert.equal(h.bridge.isFileDirty("b", "draft.ts"), false);
  assert.equal(h.bridge.invalidateSavedFile("a", "main.ts"), true);
  assert.deepEqual(invalidations, [["a", "main.ts"]]);
});
test("external file actions forward scoped refresh without loading or reopening the IDE", async () => {
  const h = harness(), options = { paths: ["src/Changed.java", "src/Deleted.java"] }, refreshed = [];
  assert.equal(await h.bridge.refreshAfterExternalChange("a", options), undefined);
  assert.deepEqual(h.calls, [], "a Git refresh must not load the IDE before it has been enabled");
  await h.bridge.enable("a");
  const result = { reloaded: ["src/Changed.java"], closed: ["src/Deleted.java"], preserved: [], failed: [] };
  h.instance.refreshAfterExternalChange = async (...args) => { refreshed.push(args); return result; };
  assert.equal(await h.bridge.refreshAfterExternalChange("a", options), result);
  h.repo({ id: "b" }); await h.bridge.sync(false);
  const callsBeforeRefresh = [...h.calls];
  assert.equal(await h.bridge.refreshAfterExternalChange("a", options), result);
  assert.deepEqual(refreshed, [["a", options], ["a", options]], "late completion must retain its captured repository and exact paths");
  assert.equal(refreshed[0][1], options);
  assert.deepEqual(h.calls, callsBeforeRefresh, "refreshing retained buffers must not reactivate or steal focus from another repository");
  assert.equal(h.host.hidden, true);
});
test("external file refresh failures reach the caller for a truthful refresh warning", async () => {
  const h = harness(); await h.bridge.enable("a");
  const failure = new Error("Cannot refresh the retained buffer");
  h.instance.refreshAfterExternalChange = async () => { throw failure; };
  await assert.rejects(h.bridge.refreshAfterExternalChange("a", { paths: ["main.ts"] }), error => error === failure);
});
test("superseded enable cannot activate a stale repository", async () => {
  const h = harness(); const first = h.bridge.enable("a"); h.repo({ id: "b" }); const second = h.bridge.sync(); await Promise.all([first, second]);
  assert.deepEqual(h.calls, [["load"], ["activate", "b"]]); assert.equal(h.host.hidden, false);
});
test("bundled Java language server is checksum-pinned and rejects traversal archives", () => {
  assert.match(JDTLS.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => validateArchiveEntries("plugins/a.jar\nconfig_mac_arm/config.ini\n"));
  for (const entry of ["/etc/passwd", "../outside", "plugins/../../outside", "a\rb"]) assert.throws(() => validateArchiveEntries(entry), /Invalid/);
});
test("normal chat keeps full height when the context strip is hidden", async () => {
  const css = await fs.readFile(new URL("../public/repository-ide-shell.css", import.meta.url), "utf8");
  assert.match(css, /body:not\(\.task-context-visible\) #repository-workbench\s*\{\s*height:\s*100%/);
});

test("diff definition can enable the selected IDE lazily, but never another repository", async () => {
  const h = harness(), source = { path: "main.ts", line: 3, column: 2 }, result = { locations: [{ path: "service.ts" }] };
  assert.equal(await h.bridge.revealNavigation("a", source, result), true);
  assert.deepEqual(h.activationOptions, [{ focus: false }]);
  assert.deepEqual(h.calls.at(-1), ["reveal", source, result]);
  h.repo({ id: "b" }); assert.equal(await h.bridge.revealNavigation("a", source, result), false);
  assert.equal(h.values.get("argus-ide:b"), undefined);
});

test("closed diff during editor enable cannot reveal stale locations", async () => {
  const h = harness(); let valid = true;
  const revealing = h.bridge.revealNavigation("a", { path: "main.ts" }, { locations: [{ path: "service.ts" }] }, () => valid);
  valid = false; assert.equal(await revealing, false); assert.equal(h.calls.some(call => call[0] === "reveal"), false);
});

test("chat visibility persists per repository and becomes normal chat when the IDE is hidden", async () => {
  const h = harness(); await h.bridge.enable("a");
  assert.equal(h.bridge.getNavigationState().chatVisible, true);
  h.bridge.setChatVisible(false);
  assert.equal(h.values.get("argus-ide-chat:a"), "hidden"); assert.equal(h.classes.has("repository-ide-chat-hidden"), true);
  assert.equal(h.bridge.getNavigationState().chatVisible, false); assert.ok(h.chatSyncs > 0);
  assert.deepEqual(h.bridge.getNavigationState(), { enabled: true, chatVisible: false, surface: "file", path: "main.ts", line: 5, column: 2 });
  h.repo({ id: "b" }); await h.bridge.sync(); assert.equal(h.bridge.getNavigationState().chatVisible, true); assert.equal(h.classes.has("repository-ide-chat-hidden"), false);
  h.repo({ id: "a" }); await h.bridge.sync(); assert.equal(h.classes.has("repository-ide-chat-hidden"), true);
  await h.bridge.sync(false); assert.equal(h.classes.has("repository-ide-chat-hidden"), false); assert.equal(h.values.get("argus-ide-chat:a"), "hidden");
  assert.deepEqual(h.bridge.getNavigationState(), { enabled: false, chatVisible: false });
});

test("fresh repository shells restore independent AI chat preferences without old IDE opt-in", async () => {
  const values = new Map(), first = harness({ values }); await first.bridge.sync();
  first.listeners.click(); first.repo({ id: "b" }); await first.bridge.sync(); first.bridge.setChatVisible(true);
  first.bridge.dispose();
  const reopened = harness({ values }); await reopened.bridge.sync();
  assert.equal(reopened.host.hidden, false); assert.equal(reopened.attributes.get("aria-label"), "Show AI chat");
  assert.equal(reopened.classes.has("repository-ide-chat-hidden"), true);
  reopened.repo({ id: "b" }); await reopened.bridge.sync();
  assert.equal(reopened.host.hidden, false); assert.equal(reopened.attributes.get("aria-label"), "Hide AI chat");
  assert.equal(reopened.classes.has("repository-ide-chat-hidden"), false);
});

test("only explicit chat visibility actions notify the shell to dismiss transient history", async () => {
  const changes = [], h = harness({ onChatVisibilityChange: visible => changes.push(visible) });
  await h.bridge.enable("a"); await h.bridge.sync();
  assert.deepEqual(changes, [], "rendering or refreshing the editor must not dismiss a manually opened history picker");
  h.listeners.click();
  h.listeners.click();
  h.bridge.setChatVisible(true);
  assert.deepEqual(changes, [false, true, true]);
  assert.equal(h.values.get("argus-ide-chat:a"), "visible");
  await h.bridge.sync(false); await h.bridge.sync();
  assert.deepEqual(changes, [false, true, true], "layout synchronization is not a chat disclosure action");
  h.repo(null); h.bridge.setChatVisible(false);
  assert.deepEqual(changes, [false, true, true], "no repository means no visibility mutation");
});

test("unchanged shell refreshes do not relayout code while a chat disclosure relayouts once", async () => {
  const h = harness(); await h.bridge.sync(); const initial = h.chatSyncs;
  await h.bridge.sync(); await h.bridge.sync();
  assert.equal(h.chatSyncs, initial);
  h.listeners.click(); assert.equal(h.chatSyncs, initial + 1);
  await h.bridge.sync(); h.bridge.setChatVisible(false);
  assert.equal(h.chatSyncs, initial + 1, "an already applied visibility state needs no repeated editor layout");
});

test("embedded diffs route only to the already enabled current IDE and preserve the payload", async () => {
  const h = harness(), payload = { path: "main.ts", before: "old", after: "new", staged: true, line: 4, column: 3, onNavigate() {} };
  assert.equal(await h.bridge.openDiff("a", payload), false); assert.deepEqual(h.calls, []);
  await h.bridge.enable("a"); assert.equal(await h.bridge.openDiff("a", payload), true); assert.deepEqual(h.calls.at(-1), ["diff", payload]);
  assert.equal(await h.bridge.openDiff("a", payload, () => false), false);
  h.repo({ id: "b" }); assert.equal(await h.bridge.openDiff("a", payload), false); assert.equal(h.values.get("argus-ide:b"), undefined);
  h.repo({ id: "a" }); await h.bridge.sync(false); assert.equal(await h.bridge.openDiff("a", payload), false);
  assert.equal(h.calls.filter(call => call[0] === "diff").length, 1);
});

test("embedded diff waits for lazy activation and rejects a repository switch during loading", async () => {
  const loading = deferred(), h = harness({ load: () => loading.promise });
  const enabled = h.bridge.enable("a"); await flush();
  const diff = h.bridge.openDiff("a", { path: "main.ts", before: "old", after: "new" });
  assert.equal(h.calls.some(call => call[0] === "diff"), false);
  h.repo({ id: "b" }); const switched = h.bridge.sync(); loading.resolve(); await Promise.all([enabled, switched]);
  assert.equal(await diff, false); assert.equal(h.calls.some(call => call[0] === "diff"), false);
});

test("embedded diff waits for current activation and propagates a declined surface open", async () => {
  const loading = deferred(), h = harness({ load: () => loading.promise });
  const enabled = h.bridge.enable("a"); await flush(); const diff = h.bridge.openDiff("a", { path: "main.ts" });
  loading.resolve(); await enabled; assert.equal(await diff, true);
  h.instance.openDiff = async () => false; assert.equal(await h.bridge.openDiff("a", { path: "missing.ts" }), false);
});

test("failed lazy activation declines a waiting diff without dereferencing a missing editor", async () => {
  const loading = deferred(), h = harness({ load: async () => { await loading.promise; throw new Error("editor unavailable"); } });
  const enabled = h.bridge.enable("a"); await flush(); const diff = h.bridge.openDiff("a", { path: "main.ts" });
  loading.resolve(); assert.equal(await enabled, false); assert.equal(await diff, false); assert.equal(h.errors[0].message, "editor unavailable");
});

test("navigation restoration preserves caret and forwards cancellation without enabling another repository", async () => {
  const h = harness(), at = { surface: "file", path: "main.ts", line: 11, column: 6 };
  assert.equal(await h.bridge.restoreLocation("b", at), false); assert.deepEqual(h.calls, []);
  assert.equal(await h.bridge.restoreLocation("a", at, () => false), false); assert.deepEqual(h.calls, []);
  assert.equal(await h.bridge.restoreLocation("a", at), true); assert.deepEqual(h.calls.at(-1), ["restore", at]); assert.deepEqual(h.activationOptions, [{ focus: false }]);
  h.instance.restoreLocation = async (_at, current) => { assert.equal(current(), true); return false; };
  assert.equal(await h.bridge.restoreLocation("a", at), false);
});

test("a cancelled restoration cannot cross the asynchronous editor enable boundary", async () => {
  const loading = deferred(), h = harness({ load: () => loading.promise }); let current = true;
  const restoring = h.bridge.restoreLocation("a", { path: "main.ts" }, () => current); await flush();
  current = false; loading.resolve(); assert.equal(await restoring, false); assert.equal(h.calls.some(call => call[0] === "restore"), false);
});

test("restoration validity ends when the selected repository changes during a file load", async () => {
  const pending = deferred(), h = harness(); await h.bridge.enable("a");
  let valid;
  h.instance.restoreLocation = async (_at, current) => { valid = current; await pending.promise; return current(); };
  const restoring = h.bridge.restoreLocation("a", { path: "main.ts" }); await flush(); assert.equal(valid(), true);
  h.repo({ id: "b" }); await h.bridge.sync(); assert.equal(valid(), false); pending.resolve(); assert.equal(await restoring, false);
});

test("cursor replacement callbacks pass through only while the selected IDE is visible", async () => {
  const h = harness(); await h.bridge.enable("a"); const at = { surface: "file", path: "main.ts", line: 9, column: 2 };
  h.editorOptions.onNavigationChange(at, { replace: true }); assert.deepEqual(h.navigation.at(-1), [at, { replace: true }]);
  await h.bridge.sync(false); const count = h.navigation.length; h.editorOptions.onNavigationChange(at, { replace: true }); assert.equal(h.navigation.length, count);
});
