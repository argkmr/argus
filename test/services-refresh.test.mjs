import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };
function harness(request = async () => []) {
  const state = { workspace: { repositories: [{ id: "a", path: "/a", name: "API" }], runConfigurations: [{ id: "c", repositoryId: "a", executable: "node", args: ["app.js"] }] },
    detectedRuntimes: [], processes: [], currentView: "services" };
  const calls = [], renders = [], errors = [], loading = [];
  let now = 100_000;
  const context = vm.createContext({ state, serviceOperations: new Map(), serviceProcessRevision: 0, Date: { now: () => now },
    api: (path, options) => { calls.push(path); return Promise.resolve().then(() => request(path, options)); },
    $: () => ({ classList: { toggle() {} } }), setRefreshLoading: (_button, value) => loading.push(value),
    renderServices: () => renders.push({ processes: state.processes, detections: state.detectedRuntimes }),
    acceptServiceProcesses: processes => { state.processes = processes; state.serviceProcessSignature = JSON.stringify(processes); },
    toast: error => errors.push(error),
  });
  vm.runInContext(["runtimeDetectionKey", "syncServicesRefreshState", "refreshRuntimeDetections", "refreshProcesses"].map(declaration).join("\n"), context);
  return { context, state, calls, renders, errors, loading, tick: amount => { now += amount; } };
}

test("explicit refresh paints cards synchronously and accepts process status without waiting for discovery", async () => {
  const scan = deferred(), running = [{ id: "p", configurationId: "c", status: "running" }];
  const h = harness(path => path === "/api/runtime-detections" ? scan.promise : running);
  const refresh = h.context.refreshProcesses(true);
  assert.equal(h.renders.length, 1, "saved cards render before any network result");
  await refresh;
  assert.equal(h.state.processes, running);
  assert.equal(h.state.processRefreshPromise, null);
  assert.ok(h.state.runtimeDetectionPromise);
  assert.equal(h.loading.at(-1), true, "discovery indicator does not blank the cards");
  scan.resolve([{ repositoryId: "a", detected: true }]); await flush();
  assert.equal(h.state.detectedRuntimes.length, 1);
  assert.equal(h.loading.at(-1), false);
});

test("cached empty discovery results do not rescan on every reopen, but manual refresh does", async () => {
  const h = harness();
  await h.context.refreshRuntimeDetections();
  await h.context.refreshRuntimeDetections();
  assert.equal(h.calls.length, 1);
  h.tick(29_999); await h.context.refreshRuntimeDetections(); assert.equal(h.calls.length, 1);
  h.tick(1); await h.context.refreshRuntimeDetections(); assert.equal(h.calls.length, 2);
  await h.context.refreshRuntimeDetections(true); assert.equal(h.calls.length, 3);
});

test("duplicate discovery requests coalesce and do not hold the process-operation lock", async () => {
  const scan = deferred(), h = harness(path => path.includes("detections") ? scan.promise : []);
  const first = h.context.refreshRuntimeDetections(), second = h.context.refreshRuntimeDetections(true);
  assert.equal(first, second);
  h.context.serviceOperations.set("c", { mode: "run" });
  await h.context.refreshProcesses(true);
  assert.equal(h.renders.length, 1);
  await flush(); assert.deepEqual(h.calls, ["/api/runtime-detections"]);
  scan.resolve([]); await first;
});

test("reconfigured or newly onboarded repositories reject stale discovery and queue fresh metadata", async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const h = harness(() => ++reads === 1 ? first.promise : second.promise);
  const pending = h.context.refreshRuntimeDetections(); await flush();
  h.state.workspace.runConfigurations[0] = { ...h.state.workspace.runConfigurations[0], port: 9090 };
  h.state.workspace.repositories.push({ id: "b", path: "/b", name: "New" });
  first.resolve([{ repositoryId: "a", port: 8080 }]); await pending; await flush();
  assert.equal(h.state.detectedRuntimes.length, 0);
  assert.equal(h.calls.length, 2);
  second.resolve([{ repositoryId: "a", port: 9090 }, { repositoryId: "b" }, { repositoryId: "deleted" }]); await flush();
  assert.deepEqual(Array.from(h.state.detectedRuntimes, item => item.repositoryId), ["a", "b"]);
  assert.equal(h.state.detectedRuntimes[0].port, 9090);
});

test("leaving Services prevents obsolete discovery from rescheduling scans for changed workspaces", async () => {
  const scan = deferred(), h = harness(() => scan.promise);
  const pending = h.context.refreshRuntimeDetections(); await flush();
  h.state.currentView = "repository"; h.state.workspace.repositories = [];
  scan.resolve([{ repositoryId: "a" }]); await pending; await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.state.detectedRuntimes.length, 0);
});

test("discovery errors retain cards and retry on demand without a request loop", async () => {
  const h = harness(() => { throw new Error("scan unavailable"); });
  h.state.detectedRuntimes = [{ repositoryId: "a", detected: true }];
  await h.context.refreshRuntimeDetections();
  assert.equal(h.state.detectedRuntimes.length, 1); assert.equal(h.errors.length, 1);
  assert.equal(h.state.runtimeDetectionPromise, null); assert.equal(h.loading.at(-1), false);
  await h.context.refreshRuntimeDetections(); assert.equal(h.calls.length, 1);
  await h.context.refreshRuntimeDetections(true); assert.equal(h.calls.length, 2);
});

test("an empty fresh workspace paints without a runtime scan", async () => {
  const h = harness(); h.state.workspace.repositories = []; h.state.workspace.runConfigurations = [];
  await h.context.refreshProcesses(true);
  assert.equal(h.renders.length, 1); assert.deepEqual(h.calls, ["/api/processes"]);
});

for (const route of ["/services", "/global-ai", "/global-ai/tasks/example", "/api-client", "/json-explorer", "/agents", "/ai-connections"]) {
test(`cold ${route} startup restores the page before unrelated Git and chat loading`, async () => {
  const git = deferred(), events = [], state = { currentView: "repository" };
  const workspace = { repositories: [{ id: "a" }], activeRepositoryId: "a", preferences: {} };
  const context = vm.createContext({ state, pendingPlannerOpen: false, window: { location: { pathname: route } }, localStorage: { getItem: () => null },
    aiContextHeader: undefined, document: {}, createAiContextHeader: () => ({ update() {} }),
    providerStatusPoller: { invalidate() {} },
    api: async () => [], loadWorkspaceSnapshot: async () => workspace,
    applyTheme() {}, applyFontSize() {}, nexusThemePicker: { restore() {} }, fontFamilyPicker: { restore() {} },
    renderRepositoryTabs() {}, renderProviderOptions() {}, restoreScopedComposer() {}, syncRepositoryWorkspacePresence() {},
    refreshActiveRepository: () => { events.push(["git", state.currentView]); return git.promise; },
    restoreRoute: async () => { state.currentView = "services"; events.push(["services", state.navigationReady]); },
    refreshApiClientData: async () => {}, refreshProcesses: async () => {}, $: () => ({}), toast: error => { throw Error(error); },
  });
  vm.runInContext(declaration("initialize"), context);
  await context.initialize();
  assert.deepEqual(events, [["services", true], ["git", "services"]]);
  git.resolve();
});
}
