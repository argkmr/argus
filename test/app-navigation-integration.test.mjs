import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createAppNavigationHistory } from "../public/app-navigation-history.mjs";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ previous = {} } = {}) {
  const repository = { id: "repo-a", name: "A" };
  const state = { navigationReady: true, restoringRoute: false, currentView: "repository",
    activeRepository: repository, activeTaskByRepository: {}, workspace: { repositories: [repository] } };
  const content = { file: "unsaved editor text", undo: ["prior edit"], job: { id: "job-a", status: "running" }, draft: "Unsent prompt" };
  let editor = { enabled: true, chatVisible: true, surface: "file", path: "b.java", line: 12, column: 3 };
  let permitted = true, restore = async () => true;
  const calls = [], errors = [], microtasks = [], elements = new Map(), classes = new Set();
  const history = createAppNavigationHistory(10);
  const window = { location: { pathname: "/repositories/repo-a" }, history: {
    replaceState(_state, _title, route) { calls.push(["route", route]); window.location.pathname = route; },
    pushState(_state, _title, route) { calls.push(["push", route]); window.location.pathname = route; },
  } };
  const bridge = {
    getNavigationState: () => clone(editor),
    async setEnabled(id, on) { calls.push(["enabled", id, on]); editor.enabled = on; return true; },
    setChatVisible(on) { calls.push(["chat", on]); editor.chatVisible = on; },
    async restoreLocation(id, location, isCurrent = () => true) {
      calls.push(["editor", id, location.path]);
      const restored = await restore(location);
      if (restored && isCurrent()) editor = clone(location);
      return restored && isCurrent();
    },
  };
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { disabled: false, title: "" });
    return elements.get(selector);
  };
  const forbidden = name => () => assert.fail(`Navigation invoked ${name}`);
  const context = vm.createContext({
    state, window, document: { body: { classList: { contains: name => classes.has(name) } } }, $: element,
    appNavigationHistory: history, appNavigationRestoring: false, appNavigationScheduled: false, appNavigationRevision: 0,
    repositoryIdeBridge: bridge, queueMicrotask: callback => microtasks.push(callback),
    closeOpenDialogs: () => permitted, toast: message => errors.push(message),
    activateRepository: async id => { state.activeRepository = state.workspace.repositories.find(item => item.id === id); state.currentView = "repository"; },
    taskList: () => [],
    switchPrimaryView: view => { state.currentView = view; return true; },
    setVersionControlDockOpen: on => { calls.push(["git", on]); if (on) classes.add("version-control-dock-open"); else classes.delete("version-control-dock-open"); },
    refreshProcesses: async () => { calls.push(["read-processes"]); },
    showDiff: async path => { calls.push(["diff", path]); return true; },
    api: forbidden("an unexpected API mutation"), runAgent: forbidden("runAgent"), stopAgent: forbidden("stopAgent"),
    startService: forbidden("startService"), saveDiffEdit: forbidden("saveDiffEdit"), revertDiffChanges: forbidden("revertDiffChanges"),
  });
  vm.runInContext(["pathForView", "appNavigationSnapshot", "syncAppNavigationButtons", "queueAppNavigation",
    "restoreAppNavigation", "moveAppNavigation", "cancelPendingAppNavigation", "syncViewUrl", "restoreRoute"].map(declaration).join("\n"), context);
  const snapshot = path => ({ route: "/repositories/repo-a", repositoryId: "repo-a", editor: { ...clone(editor), path }, gitOpen: false });
  history.record({ ...snapshot("a.java"), ...previous }); history.record(snapshot("b.java"));
  return { context, state, history, content, calls, errors, window, bridge, element,
    editor: () => editor, setEditor: value => { editor = { ...editor, ...value }; },
    rejectNavigation: () => { permitted = false; }, restoreWith: fn => { restore = fn; },
    flush: () => { while (microtasks.length) microtasks.shift()(); } };
}

test("app Back/Forward restores editor positions without undoing edits or restarting jobs", async () => {
  const h = harness(), before = clone(h.content);
  h.setEditor({ line: 99, column: 7 });
  await h.context.moveAppNavigation(-1);
  assert.equal(h.editor().path, "a.java");
  assert.equal(h.history.backCount, 0); assert.equal(h.history.forwardCount, 1);
  await h.context.moveAppNavigation(1);
  assert.equal(h.editor().path, "b.java");
  assert.equal(h.editor().line, 99); assert.equal(h.editor().column, 7);
  assert.deepEqual(h.content, before);
  assert.equal(h.errors.length, 0);
});

test("a declined editor enable does not consume Back or attempt a file restore", async () => {
  const h = harness(); h.bridge.setEnabled = async () => false;
  await h.context.moveAppNavigation(-1);
  assert.equal(h.history.backCount, 1); assert.equal(h.history.forwardCount, 0);
  assert.equal(h.calls.some(call => call[0] === "editor"), false);
  assert.match(h.errors[0], /editor could not restore/);
});

test("newer user navigation wins over a deferred editor restore without stale rollback", async () => {
  for (const lateFailure of [false, true]) {
    const h = harness(), gate = deferred(), started = deferred();
    h.restoreWith(async () => { started.resolve(); await gate.promise; if (lateFailure) throw new Error("late failure"); return true; });
    const moving = h.context.moveAppNavigation(-1);
    await started.promise;
    h.context.cancelPendingAppNavigation({ type: "pointerdown", target: { closest: () => null } });
    h.state.currentView = "services"; h.context.syncViewUrl("services"); h.flush();
    gate.resolve(); await moving;
    assert.equal(h.state.currentView, "services"); assert.equal(h.window.location.pathname, "/services");
    assert.equal(h.history.current.route, "/services"); assert.equal(h.history.backCount, 2);
    assert.equal(h.history.forwardCount, 0); assert.equal(h.editor().path, "b.java");
    assert.equal(h.calls.filter(call => call[0] === "editor").length, 1, "a superseded restore must not roll back the newer view");
    assert.deepEqual(h.errors, []);
  }
});

test("newer navigation cancels a delayed route before it can select the old task", async () => {
  const h = harness({ previous: { route: "/repositories/repo-a/tasks/task-a" } }), gate = deferred(), started = deferred();
  h.context.activateRepository = async () => { h.state.currentView = "repository"; started.resolve(); await gate.promise; };
  h.context.taskList = () => [{ id: "task-a" }];
  h.context.selectTask = async () => assert.fail("The cancelled route selected its old task");
  const moving = h.context.moveAppNavigation(-1);
  await started.promise;
  h.context.cancelPendingAppNavigation({ type: "keydown", key: "Enter", target: { closest: () => null } });
  h.state.currentView = "services"; h.context.syncViewUrl("services"); h.flush();
  gate.resolve(); await moving;
  assert.equal(h.state.currentView, "services"); assert.equal(h.history.current.route, "/services");
  assert.equal(h.state.restoringRoute, false); assert.equal(h.history.backCount, 2);
  assert.equal(h.calls.some(call => call[0] === "editor"), false);
});

test("the deferred global workspace loader cannot reopen Nexus after navigation cancellation", async () => {
  const h = harness({ previous: { route: "/global-ai/tasks/global-task", repositoryId: null, editor: null } });
  const gate = deferred(), started = deferred();
  Object.assign(h.state, { globalJobs: [], globalTasks: [], activeGlobalTaskId: "global-task" });
  Object.assign(h.context, {
    api: async path => { started.resolve(); await gate.promise; return path.includes("ai-tasks") ? [{ id: "global-task", messages: [] }] : []; },
    isChatAgentJob: () => true, renderTaskList() {}, renderAgentTabs() {},
    taskList: () => h.state.globalTasks,
    selectTask: async (_scope, _task, { isCurrent = () => true } = {}) => {
      if (isCurrent()) { h.calls.push(["select-global"]); h.state.currentView = "global"; }
    },
  });
  vm.runInContext(declaration("openGlobalCodex"), h.context);
  const moving = h.context.moveAppNavigation(-1);
  await started.promise;
  h.context.cancelPendingAppNavigation({ type: "pointerdown", target: { closest: () => null } });
  h.state.currentView = "services"; h.context.syncViewUrl("services"); h.flush();
  gate.resolve(); await moving;
  assert.equal(h.state.currentView, "services");
  assert.equal(h.calls.some(call => call[0] === "select-global"), false);
  assert.equal(h.history.current.route, "/services"); assert.deepEqual(h.errors, []);
});

test("a deferred diff restore cannot replace the user's newer file in the same repository", async () => {
  const h = harness({ previous: { editor: { enabled: true, chatVisible: true, surface: "diff", path: "a.java", staged: true, line: 17, column: 4 } } });
  const gate = deferred(), started = deferred();
  Object.assign(h.context, {
    api: async () => { started.resolve(); await gate.promise; return { diff: "fixture diff", beforeContent: "old", afterContent: "new" }; },
    parseUnifiedDiff: () => ({}), expandToFullFile: () => ({ rows: [] }), setTaskPanelCollapsed() {},
  });
  h.bridge.isVisible = () => true;
  h.bridge.openDiff = async (_id, payload, isCurrent = () => true) => {
    if (!isCurrent()) return false;
    h.calls.push(["opened-diff", payload]); h.setEditor({ ...payload, surface: "diff" }); return true;
  };
  vm.runInContext(declaration("showDiff"), h.context);
  const moving = h.context.moveAppNavigation(-1);
  await started.promise;
  h.context.cancelPendingAppNavigation({ type: "pointerdown", target: { closest: () => null } });
  h.setEditor({ path: "newer.java", line: 2 }); h.context.queueAppNavigation(); h.flush();
  gate.resolve(); await moving; h.flush();
  assert.equal(h.editor().path, "newer.java");
  assert.equal(h.calls.some(call => call[0] === "opened-diff"), false);
  assert.equal(h.history.current.editor.path, "newer.java"); assert.deepEqual(h.errors, []);
});

test("a deferred orchestration selection cannot rewrite the newer route", async () => {
  const h = harness({ previous: { route: "/agents/runs/run-a", repositoryId: null, editor: null } });
  const gate = deferred(), started = deferred();
  Object.assign(h.context, {
    openOrchestration: async () => { h.state.currentView = "orchestration"; },
    api: async () => { started.resolve(); await gate.promise; return { id: "run-a" }; },
    renderOrchestrationRun: run => { h.state.activeOrchestrationRun = run; h.context.syncViewUrl("orchestration", true); h.calls.push(["render-run"]); },
  });
  vm.runInContext(declaration("selectOrchestrationRun"), h.context);
  const moving = h.context.moveAppNavigation(-1);
  await started.promise;
  h.context.cancelPendingAppNavigation({ type: "pointerdown", target: { closest: () => null } });
  h.state.currentView = "services"; h.context.syncViewUrl("services"); h.flush();
  gate.resolve(); await moving; h.flush();
  assert.equal(h.window.location.pathname, "/services");
  assert.equal(h.calls.some(call => call[0] === "render-run"), false);
  assert.equal(h.history.current.route, "/services"); assert.deepEqual(h.errors, []);
});

test("browser Back cancels a pending app restore before accepting its late editor result", async () => {
  const h = harness(), gate = deferred(), started = deferred();
  h.restoreWith(async () => { started.resolve(); await gate.promise; return true; });
  let onPopState;
  h.window.addEventListener = (_name, handler) => { onPopState = handler; };
  const listener = app.split("\n").find(line => line.includes('window.addEventListener("popstate"'));
  assert.ok(listener, "The browser history listener must be registered");
  vm.runInContext(listener, h.context);
  const moving = h.context.moveAppNavigation(-1);
  await started.promise;
  h.window.location.pathname = "/services";
  await onPopState({ type: "popstate" }); h.flush();
  gate.resolve(); await moving; h.flush();
  assert.equal(h.state.currentView, "services"); assert.equal(h.editor().path, "b.java");
  assert.equal(h.history.current.route, "/services"); assert.equal(h.history.backCount, 2);
  assert.equal(h.history.forwardCount, 0); assert.deepEqual(h.errors, []);
});

test("a cancelled dialog guard neither restores a destination nor consumes history", async () => {
  const h = harness(); h.rejectNavigation();
  const before = h.history.current;
  await h.context.moveAppNavigation(-1);
  assert.deepEqual(h.history.current, before);
  assert.equal(h.history.backCount, 1); assert.equal(h.history.forwardCount, 0);
  assert.deepEqual(h.calls, []);
});

test("failed restoration rolls back the current editor without consuming Back", async () => {
  const h = harness();
  h.restoreWith(async location => { if (location.path === "a.java") throw new Error("file unavailable"); return true; });
  await h.context.moveAppNavigation(-1);
  assert.equal(h.editor().path, "b.java");
  assert.equal(h.history.backCount, 1); assert.equal(h.history.forwardCount, 0);
  assert.match(h.errors[0], /file unavailable/);
});

test("a declined editor restoration is failure rather than a consumed history entry", async () => {
  const h = harness(); h.restoreWith(async location => location.path !== "a.java");
  await h.context.moveAppNavigation(-1);
  assert.equal(h.editor().path, "b.java");
  assert.equal(h.history.backCount, 1); assert.equal(h.history.forwardCount, 0);
});

test("repeated Back clicks during an async restore execute only one navigation", async () => {
  const h = harness(), gate = deferred();
  h.restoreWith(() => gate.promise);
  const first = h.context.moveAppNavigation(-1);
  await h.context.moveAppNavigation(-1);
  gate.resolve(true); await first;
  assert.equal(h.calls.filter(call => call[0] === "editor").length, 1);
  assert.equal(h.history.backCount, 0); assert.equal(h.history.forwardCount, 1);
  assert.equal(h.element("#app-navigation-back").disabled, true);
  assert.equal(h.element("#app-navigation-forward").disabled, false);
});

test("queued view paints record the final destination once and deduplicate repeats", () => {
  const h = harness();
  h.context.queueAppNavigation(); h.setEditor({ path: "c.java" }); h.context.queueAppNavigation(); h.flush();
  assert.equal(h.history.current.editor.path, "c.java"); assert.equal(h.history.backCount, 2);
  h.context.queueAppNavigation(); h.flush(); assert.equal(h.history.backCount, 2);
});

test("same-route cursor replacement updates the current state and retains Forward", () => {
  const h = harness();
  h.history.move(-1); h.setEditor({ path: "a.java", line: 48, column: 6 });
  h.context.queueAppNavigation({ replace: true }); h.flush();
  assert.equal(h.history.current.editor.line, 48); assert.equal(h.history.current.editor.column, 6);
  assert.equal(h.history.backCount, 0); assert.equal(h.history.forwardCount, 1);
  assert.equal(h.history.peek(1).editor.path, "b.java");
});

test("a replacement URL update for a distinct route creates a new Back entry", () => {
  const h = harness();
  h.state.currentView = "orchestration"; h.state.activeOrchestrationRun = { id: "run-a" };
  h.context.syncViewUrl("orchestration"); h.flush();
  h.state.activeOrchestrationRun = { id: "run-b" };
  h.context.syncViewUrl("orchestration", true); h.flush();
  assert.equal(h.history.current.route, "/agents/runs/run-b");
  assert.equal(h.history.peek(-1).route, "/agents/runs/run-a");
  assert.equal(h.history.backCount, 3); assert.equal(h.history.forwardCount, 0);
});

test("coalesced replacement paints preserve the final distinct route as one navigation", () => {
  const h = harness();
  h.context.queueAppNavigation({ replace: true });
  h.state.currentView = "services"; h.context.syncViewUrl("services", true);
  h.state.currentView = "orchestration"; h.state.activeOrchestrationRun = { id: "run-final" };
  h.context.syncViewUrl("orchestration"); h.flush();
  assert.equal(h.history.current.route, "/agents/runs/run-final");
  assert.equal(h.history.peek(-1).route, "/repositories/repo-a");
  assert.equal(h.history.backCount, 2, "intermediate route paints must not create extra entries");
  assert.equal(h.history.forwardCount, 0);
});
