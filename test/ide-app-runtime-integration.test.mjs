import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createIdeRunControls } from "../public/ide-run-controls.mjs";
import { createProjectSyncLifecycle } from "../public/project-sync-lifecycle.mjs";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const shellCss = await fs.readFile(new URL("../public/repository-ide-shell.css", import.meta.url), "utf8");
const contextCss = await fs.readFile(new URL("../public/repository-context-bar.css", import.meta.url), "utf8");
const bridge = await fs.readFile(new URL("../public/repository-ide-bridge.mjs", import.meta.url), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function button(dataset = {}, disabled = false) {
  const attrs = new Map(), classes = new Set();
  return { dataset, disabled, textContent: "", innerHTML: "",
    setAttribute: (key, value) => attrs.set(key, String(value)), removeAttribute: key => attrs.delete(key), getAttribute: key => attrs.get(key),
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
  };
}
function harness({ request = async () => [] } = {}) {
  const repository = { id: "repo-a", name: "A", path: "/synthetic/a" };
  const configuration = { id: "config-a", repositoryId: repository.id, executable: "node", args: ["app.js"] };
  const state = { currentView: "repository", activeRepository: repository, processes: [], detectedRuntimes: [],
    workspace: { repositories: [repository], runConfigurations: [configuration] }, processRefreshPromise: null };
  const elements = new Map(), storage = new Map(), calls = [], errors = [], pendingButtons = [button({ configId: configuration.id }), button({ serviceDebug: configuration.id })];
  let dirty = false, ideVisible = true, renders = 0;
  const element = selector => { if (!elements.has(selector)) elements.set(selector, button()); return elements.get(selector); };
  const terminal = { getState: () => ({ visible: false }), open: options => { calls.push(["terminal-open", options]); },
    minimize: options => calls.push(["terminal-minimize", options]), mount: host => calls.push(["terminal-mount", host]) };
  const repositoryIdeBridge = { isVisible: id => ideVisible && id === state.activeRepository?.id, isDirty: () => dirty,
    syncRunState: () => calls.push(["ide-sync"]), syncTerminalState: snapshot => calls.push(["terminal-sync", snapshot]),
    showRunLogs: id => calls.push(["ide-logs", id]),
    attachLaunchedDebug: async (id, process) => calls.push(["debug-attach", id, process.id]) };
  const context = vm.createContext({ state, repositoryIdeBridge, serviceOperations: new Map(), serviceProcessRevision: 0, ideRunControls: undefined,
    api: async (...args) => { calls.push(["api", ...args]); return request(...args); },
    $: element, $$: () => pendingButtons, createIdeRunControls, createProjectSyncLifecycle, repositoryTerminal: terminal,
    showLogs: async (...args) => calls.push(["logs", ...args]),
    document: { body: {} }, getRepositoryTerminal: () => terminal, syncRepositoryPorts() {}, syncStopAllServicesControl() {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    loadWorkspaceSnapshot: async () => state.workspace,
    toast: (message, type) => errors.push([message, type]), setRefreshLoading: () => {}, skeletonCards: () => "Loading…",
    setTimeout: callback => { callback(); },
    renderServices: () => { renders++; context.syncIdeRunControls(); context.syncServicePendingControls(); },
  });
  const syncStart = app.indexOf("const projectSyncLifecycle = createProjectSyncLifecycle({");
  vm.runInContext(app.slice(syncStart, app.indexOf("\n});", syncStart) + 4), context);
  vm.runInContext(["runtimeDetectionKey", "syncServicesRefreshState", "refreshRuntimeDetections", "refreshProcesses", "syncIdeRunControls", "acceptServiceProcesses", "acceptServiceProcess", "syncServicePendingControls", "withServiceOperation",
    "serviceAction", "startServiceDebug", "rememberServiceConfiguration", "startDetectedRuntime", "openTerminal", "mountIdeTerminal", "toggleIdeTerminal", "bindTerminalResizer"].map(declaration).join("\n"), context);
  const initialization = app.slice(app.indexOf("ideRunControls = createIdeRunControls({"), app.indexOf("\nconst repositoryIdeBridge =", app.indexOf("ideRunControls = createIdeRunControls({")));
  vm.runInContext(initialization, context);
  context.syncIdeRunControls();
  return { context, state, repository, configuration, calls, errors, elements, element, pendingButtons, terminal, storage,
    controls: context.ideRunControls, renders: () => renders, dirty: value => { dirty = value; }, visible: value => { ideVisible = value; } };
}
const running = (status = "running") => ({ id: "process-a", configurationId: "config-a", repositoryId: "repo-a", status,
  running: status === "running", startedAt: "2026-09-18T14:00:00Z" });

test("completed sync refreshes only its repository language index and opens the IDE process output", async () => {
  const process = { ...running("syncing"), task: "sync", exitCode: null };
  const h = harness({ request: async path => path === "/api/processes" ? [] : process });
  h.context.acceptServiceProcesses([]);
  await h.controls.run("sync");
  assert.deepEqual(h.calls.find(call => call[0] === "ide-logs"), ["ide-logs", "repo-a"]);
  assert.equal(h.calls.some(call => call[0] === "logs"), false, "IDE Sync must not open the floating Services log console");
  h.context.acceptServiceProcesses([process]);
  h.context.acceptServiceProcesses([{ ...process, status: "completed", exitCode: 0 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call[0] === "api" && call[1] === "/api/repositories/repo-a/ide/language/refresh").length, 1);
  h.controls.dispose();
});

test("Run, Debug and Sync reveal shared process output before mode-specific feedback or attachment", async () => {
  for (const mode of ["run", "debug", "sync"]) {
    let current = [];
    const h = harness({ request: async (_path, options) => {
      if (options?.method === "POST") { current = [{ ...running(mode === "sync" ? "syncing" : "starting"), ...(mode === "sync" ? { task: "sync" } : {}) }]; return current[0]; }
      return current;
    } });
    h.context.toast = message => h.calls.push(["toast", message]);
    h.context.acceptServiceProcesses([]); await h.controls.run(mode);
    const revealed = h.calls.findIndex(call => call[0] === "ide-logs");
    const feedback = h.calls.findIndex(call => call[0] === (mode === "debug" ? "debug-attach" : "toast"));
    assert.ok(revealed >= 0, mode); assert.ok(feedback > revealed, mode);
    assert.equal(h.calls.some(call => call[0] === "logs"), false, mode);
    h.controls.dispose();
  }
});

test("an output rendering failure still attaches an accepted debugger and reports the panel error", async () => {
  let current = [];
  const h = harness({ request: async (_path, options) => {
    if (options?.method === "POST") { current = [running("starting")]; return current[0]; }
    return current;
  } });
  h.context.repositoryIdeBridge.showRunLogs = () => { throw new Error("Panel unavailable"); };
  h.context.acceptServiceProcesses([]); await h.controls.run("debug");
  assert.ok(h.calls.some(call => call[0] === "debug-attach"));
  assert.ok(h.errors.some(([message]) => message === "Process output could not open: Panel unavailable")); h.controls.dispose();
});

test("app supplies only repository context and waits for an authoritative Services snapshot", () => {
  const h = harness();
  assert.equal(h.controls.state.selectedId, "config-a"); assert.equal(h.controls.state.known, false); assert.equal(h.controls.state.canRun, false);
  h.context.acceptServiceProcesses([]);
  assert.equal(h.controls.state.known, true); assert.equal(h.controls.state.canRun, true);
  h.state.currentView = "agents"; h.context.syncIdeRunControls();
  assert.equal(h.controls.state.repository, null); assert.equal(h.controls.state.canRun, false);
  h.controls.dispose();
});

test("accepted process state updates Services counters, IDE controls and configuration state together", () => {
  const h = harness(); h.context.acceptServiceProcesses([running()]);
  assert.equal(h.state.processes[0].status, "running"); assert.equal(h.element("#running-count").textContent, 1);
  assert.equal(h.element("#services-toggle").classList.contains("has-running"), true);
  assert.equal(h.controls.state.currentProcess.id, "process-a"); assert.equal(h.controls.state.canStop, true);
  assert.equal(h.renders(), 1);
  h.context.acceptServiceProcesses([running()]);
  assert.equal(h.renders(), 1, "unchanged process snapshots do not redraw Services");
  h.context.acceptServiceProcesses([running("stopped")]);
  assert.equal(h.element("#running-count").textContent, 0); assert.equal(h.controls.state.canRun, true);
  h.controls.dispose();
});

test("a Services operation holds the shared configuration lock and prevents an IDE launch", async () => {
  const h = harness(), gate = deferred(); h.context.acceptServiceProcesses([]);
  const service = h.context.withServiceOperation("config-a", "start", () => gate.promise);
  assert.equal(h.controls.state.busy, "start"); assert.equal(h.pendingButtons.every(item => item.disabled), true);
  assert.equal(await h.controls.run("debug"), null);
  assert.equal(h.calls.some(call => call[0] === "api" && call[2]?.method === "POST"), false);
  gate.resolve(); await service;
  assert.equal(h.context.serviceOperations.size, 0); assert.equal(h.controls.state.busy, "");
  assert.equal(h.pendingButtons.every(item => !item.disabled), true);
  h.controls.dispose();
});

test("Services keeps its shared lock until authoritative post-operation state arrives", async () => {
  const poll = deferred(), entered = deferred();
  const h = harness({ request: async () => { entered.resolve(); return poll.promise; } });
  h.context.acceptServiceProcesses([]);
  const operation = h.context.withServiceOperation("config-a", "start", async () => running("starting"));
  await entered.promise;
  assert.equal(h.context.serviceOperations.has("config-a"), true);
  assert.equal(h.controls.state.canRun, false); assert.equal(h.pendingButtons.every(item => item.disabled), true);
  let duplicated = false;
  await h.context.withServiceOperation("config-a", "debug", () => { duplicated = true; });
  assert.equal(duplicated, false); assert.equal(await h.controls.run("run"), null);
  poll.resolve([running("starting")]); await operation;
  assert.equal(h.context.serviceOperations.size, 0); assert.equal(h.controls.state.currentProcess.status, "starting");
  assert.equal(h.controls.state.canRun, false); assert.equal(h.controls.state.canStop, true);
  h.controls.dispose();
});

test("detected Services setup locks repository creation and then its exact new configuration", async () => {
  const created = deferred(), starting = deferred(), startEntered = deferred(); let current = [];
  const h = harness({ request: async (path, options) => {
    if (options?.method === "POST" && path === "/api/run-configurations") return created.promise;
    if (options?.method === "POST") { startEntered.resolve(); await starting.promise; current = [running("starting")]; return current[0]; }
    return current;
  } });
  h.state.workspace.runConfigurations = [];
  const detectedButton = button({ startDetectedRuntime: "repo-a" }); h.pendingButtons.push(detectedButton);
  h.context.acceptServiceProcesses([]);
  const setup = h.context.startDetectedRuntime("repo-a");
  assert.equal(h.context.serviceOperations.has("repository:repo-a"), true); assert.equal(detectedButton.disabled, true);
  await h.context.startDetectedRuntime("repo-a");
  assert.equal(h.calls.filter(call => call[0] === "api" && call[1] === "/api/run-configurations").length, 1);
  h.state.workspace.runConfigurations = [h.configuration]; created.resolve(h.configuration); await startEntered.promise;
  assert.equal(h.context.serviceOperations.has("repository:repo-a"), true); assert.equal(h.context.serviceOperations.has("config-a"), true);
  assert.equal(h.controls.state.selectedId, "config-a"); assert.equal(h.controls.state.busy, "start");
  assert.equal(await h.controls.run("debug"), null);
  starting.resolve(); await setup;
  const writes = h.calls.filter(call => call[0] === "api" && call[2]?.method === "POST");
  assert.deepEqual(writes.map(call => call[1]), ["/api/run-configurations", "/api/run-configurations/config-a/start"]);
  assert.deepEqual(clone(writes[0][2].body), { simpleSetup: true, repositoryId: "repo-a" });
  assert.equal(h.context.serviceOperations.size, 0); assert.equal(h.controls.state.currentProcess.id, "process-a");
  h.controls.dispose();
});

test("IDE launch takes the same lock and rejects simultaneous Services clicks", async () => {
  const gate = deferred(), entered = deferred(); let current = [];
  const h = harness({ request: async (_path, options) => {
    if (options?.method === "POST") { entered.resolve(); await gate.promise; current = [running("starting")]; return current[0]; }
    return current;
  } });
  h.context.acceptServiceProcesses([]);
  const launch = h.controls.run("run"); await entered.promise;
  let duplicate = false;
  await h.context.withServiceOperation("config-a", "debug", () => { duplicate = true; });
  assert.equal(duplicate, false); assert.equal(h.pendingButtons.every(item => item.disabled), true);
  gate.resolve(); await launch;
  assert.equal(h.state.processes[0].status, "starting"); assert.equal(h.controls.state.canRun, false);
  assert.equal(h.context.serviceOperations.size, 0); h.controls.dispose();
});

test("a stale shared poll cannot erase a service launched from the IDE", async () => {
  const oldPoll = deferred(); let reads = 0, current = [];
  const h = harness({ request: async (_path, options) => {
    if (options?.method === "POST") { current = [running("starting")]; return current[0]; }
    if (++reads === 1) return oldPoll.promise;
    return current;
  } });
  h.context.acceptServiceProcesses([]); const refresh = h.context.refreshProcesses();
  await h.controls.run("run");
  oldPoll.resolve([]); await refresh;
  assert.equal(h.state.processes[0].id, "process-a"); assert.equal(h.controls.state.currentProcess.id, "process-a");
  h.controls.dispose();
});

test("shared polling skips writes in flight and coalesces reads", async () => {
  const gate = deferred(), h = harness({ request: () => gate.promise });
  h.context.serviceOperations.set("config-a", { mode: "run", repositoryId: "repo-a" });
  await h.context.refreshProcesses(); assert.equal(h.calls.filter(call => call[0] === "api").length, 0);
  h.context.serviceOperations.clear();
  const first = h.context.refreshProcesses(), second = h.context.refreshProcesses();
  assert.equal(h.calls.filter(call => call[0] === "api").length, 1);
  gate.resolve([]); await Promise.all([first, second]);
  assert.equal(h.state.processRefreshPromise, null); h.controls.dispose();
});

test("IDE Run refuses unsaved files and Debug attaches only the accepted repository's process", async () => {
  let current = [];
  const h = harness({ request: async (_path, options) => {
    if (options?.method === "POST") { current = [{ ...running("starting"), debug: { runtime: "node", port: 9230 } }]; return current[0]; }
    return current;
  } });
  h.context.acceptServiceProcesses([]); h.dirty(true);
  assert.equal(await h.controls.run("run"), null);
  assert.equal(h.calls.filter(call => call[0] === "api").length, 0); assert.match(h.errors[0][0], /Save.*unsaved files/);
  h.dirty(false); await h.controls.run("debug");
  assert.deepEqual(h.calls.find(call => call[0] === "debug-attach"), ["debug-attach", "repo-a", "process-a"]);
  const post = h.calls.find(call => call[0] === "api" && call[2]?.method === "POST");
  assert.equal(post[1], "/api/run-configurations/config-a/start"); assert.deepEqual(clone(post[2].body), { debug: true });
  h.controls.dispose();
});

test("Services actions still call their original configuration endpoints under the shared lock", async () => {
  for (const mode of ["start", "stop", "restart"]) {
    const h = harness({ request: async (_path, options) => options?.method === "POST" ? { ok: true } : [] });
    h.context.acceptServiceProcesses([]); await h.context.serviceAction("config-a", mode);
    const post = h.calls.find(call => call[0] === "api" && call[2]?.method === "POST");
    assert.equal(post[1], `/api/run-configurations/config-a/${mode}`);
    assert.equal(h.context.serviceOperations.size, 0); h.controls.dispose();
  }
});

test("pending Services buttons restore their previous disabled state rather than enabling forbidden actions", () => {
  const h = harness(); h.pendingButtons[1].disabled = true;
  h.context.serviceOperations.set("config-a", { mode: "debug" }); h.context.syncServicePendingControls();
  assert.equal(h.pendingButtons[0].getAttribute("aria-busy"), "true");
  h.context.serviceOperations.clear(); h.context.syncServicePendingControls();
  assert.equal(h.pendingButtons[0].disabled, false); assert.equal(h.pendingButtons[1].disabled, true);
  assert.equal(h.pendingButtons[0].getAttribute("aria-busy"), undefined); h.controls.dispose();
});

test("terminal only opens for the active visible IDE repository, never Nexus or an old repository", async () => {
  const h = harness();
  await h.context.openTerminal({ repositoryId: "repo-a" });
  const opened = h.calls.find(call => call[0] === "terminal-open")[1];
  assert.equal(opened.repositoryId, "repo-a");
  assert.equal(opened.returnFocus(), h.element('.repository-ide-tool-tab[data-tool="terminal"]'));
  h.calls.length = 0; await h.context.openTerminal({ repositoryId: "repo-b" });
  h.state.currentView = "global"; await h.context.openTerminal({ repositoryId: "repo-a" });
  h.state.currentView = "repository"; h.visible(false); await h.context.openTerminal({ repositoryId: "repo-a" });
  assert.equal(h.calls.length, 0); h.controls.dispose();
});

test("terminal mount rejects stale repository callbacks and preserves its singleton on IDE disposal", () => {
  const h = harness(), host = {};
  h.calls.length = 0; h.context.mountIdeTerminal(host, { repositoryId: "repo-b" }); assert.equal(h.calls.length, 0);
  h.calls.length = 0; h.context.mountIdeTerminal(host, { repositoryId: "repo-a" });
  assert.equal(h.calls[0][0], "terminal-mount"); assert.equal(h.calls[0][1], host);
  h.calls.length = 0; h.context.mountIdeTerminal(null);
  assert.equal(h.calls[0][0], "terminal-minimize"); assert.equal(h.calls[1][0], "terminal-mount");
  assert.equal(h.calls[1][1], h.context.document.body); h.controls.dispose();
});

test("terminal mount leaves the shared tool dock in control of height", () => {
  const h = harness(), host = { style: { flexBasis: "" } }; h.storage.set("argus-terminal-height", "320");
  h.context.mountIdeTerminal(host, { repositoryId: "repo-a" }); assert.equal(host.style.flexBasis, "");
  assert.equal(h.storage.get("argus-terminal-height"), "320");
  h.controls.dispose();
});

test("tool switching hides the existing terminal without restoring focus or creating a shell", () => {
  const h = harness();
  const callback = app.match(/onTerminalHide:\s*([^\n]+)/)?.[1].replace(/,$/, ""); assert.ok(callback);
  vm.runInContext(`(${callback})()`, h.context);
  assert.deepEqual(clone(h.calls.find(call => call[0] === "terminal-minimize")), ["terminal-minimize", { restoreFocus: false }]);
  assert.equal(h.calls.some(call => call[0] === "terminal-open"), false);
  h.context.repositoryTerminal = undefined; assert.doesNotThrow(() => vm.runInContext(`(${callback})()`, h.context)); h.controls.dispose();
});

test("the legacy terminal resizer cannot capture or resize the shared tool dock", () => {
  const h = harness(), listeners = new Map(); let captured = false, prevented = false, measured = false;
  const resizer = h.element("#terminal-resizer"), panel = h.element("#terminal-panel");
  resizer.addEventListener = (name, callback) => listeners.set(name, callback);
  resizer.setPointerCapture = () => { captured = true; };
  panel.closest = selector => selector === ".repository-ide-tool-dock" ? {} : null;
  panel.getBoundingClientRect = () => { measured = true; return { height: 300 }; };
  h.context.bindTerminalResizer(); listeners.get("pointerdown")({ pointerId: 1, clientY: 100, preventDefault() { prevented = true; } });
  assert.equal(captured, false); assert.equal(prevented, false); assert.equal(measured, false);
  assert.equal(listeners.has("pointermove"), false); assert.equal(h.storage.has("argus-terminal-height"), false); h.controls.dispose();
});

test("terminal lives in the editor integration, not the Workspace Tools entry or click binding", () => {
  assert.doesNotMatch(html, /id="terminal-toggle"/);
  assert.doesNotMatch(app, /\$\(["']#terminal-toggle["']\)\??\.addEventListener/);
  assert.match(app, /onTerminalMount:\s*mountIdeTerminal/); assert.match(app, /onTerminalToggle:\s*toggleIdeTerminal/);
  assert.match(bridge, /getRunState, onRunAction, onRunSelect, onRunConfigure, onTerminalToggle, onTerminalHide, onTerminalMount,/);
});

test("AI chat disclosure leads the compact accessible repository header actions", () => {
  assert.match(html, /<nav class="repository-context-actions" aria-label="Repository tools">[\s\S]*?id="repository-chat-toggle"[\s\S]*?id="project-structure-toggle"[\s\S]*?<\/nav>/);
  assert.match(shellCss, /\.repository-context-actions\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*8px/);
  assert.match(contextCss, /:is\(#project-structure-toggle, #repository-chat-toggle\)\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*min-height:\s*30px/);
  assert.match(html, /id="project-structure-toggle"[^>]*aria-label="Project structure"[^>]*><svg/);
  assert.match(html, /id="repository-chat-toggle"[^>]*aria-label="Hide AI chat"[^>]*><svg/);
  assert.doesNotMatch(html, /id="repository-ide-toggle"/);
  assert.doesNotMatch(bridge, /button\.textContent\s*=/);
});
