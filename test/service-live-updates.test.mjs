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
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const running = (id = "agent-process") => ({ id, configurationId: "service", repositoryId: "repo", status: "running", running: true });

function harness(request = async () => []) {
  const state = { processes: [], currentView: "global", workspace: { repositories: [{ id: "repo" }], runConfigurations: [{ id: "service", repositoryId: "repo" }] } };
  const calls = [], errors = [], elements = new Map(), document = { hidden: false };
  let renders = 0, controls = 0, discoveries = 0;
  const element = key => {
    if (!elements.has(key)) { const classes = new Set(); elements.set(key, { textContent: "", open: false,
      querySelector: () => ({ focus() {} }), classList: { toggle(name, value) { value ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) } }); }
    return elements.get(key);
  };
  const context = vm.createContext({ state, document, serviceOperations: new Map(), serviceProcessRevision: 0,
    api: (path, options) => { calls.push({ path, options }); return request(path, options); },
    $: element, setRefreshLoading() {}, syncServicePendingControls() {}, syncWorkspaceToolsOverlay() {},
    renderServices: () => { renders++; controls++; }, syncIdeRunControls: () => { controls++; },
    refreshRuntimeDetections: () => { discoveries++; }, projectSyncLifecycle: { observe() {} }, toast: error => errors.push(error),
  });
  vm.runInContext(["syncServicesRefreshState", "pollServiceProcesses", "refreshProcesses", "acceptServiceProcesses", "acceptServiceProcess", "withServiceOperation", "serviceAction", "setWorkspaceToolsOpen"].map(declaration).join("\n"), context);
  return { context, state, document, calls, errors, element, renders: () => renders, controls: () => controls, discoveries: () => discoveries };
}

test("the global status poll discovers an agent-started first service while chatting, then its stop", async () => {
  let current = [];
  const h = harness(async () => current);
  for (const view of ["global", "repository"]) {
    h.state.currentView = view;
    await h.context.pollServiceProcesses();
    current = [running()]; await h.context.pollServiceProcesses();
    assert.equal(h.element("#running-count").textContent, 1);
    assert.equal(h.element("#services-toggle").classList.contains("has-running"), true);
    current = [{ ...running(), status: "stopped", running: false }]; await h.context.pollServiceProcesses();
    assert.equal(h.element("#running-count").textContent, 0);
    assert.equal(h.element("#services-toggle").classList.contains("no-running"), true);
    current = [];
  }
  assert.equal(h.discoveries(), 0);
  assert.ok(h.calls.every(({ path, options }) => path === "/api/processes" && options.cache === "no-store" && options.timeout === 5_000));
});

test("polling pauses before workspace initialization and while hidden, then opening Tools refreshes immediately", async () => {
  const h = harness(async () => [running()]);
  const workspace = h.state.workspace; h.state.workspace = null;
  await h.context.pollServiceProcesses();
  h.state.workspace = workspace; h.document.hidden = true;
  await h.context.pollServiceProcesses(); assert.equal(h.calls.length, 0);
  h.document.hidden = false; h.context.setWorkspaceToolsOpen(true); await flush();
  assert.equal(h.element("#running-count").textContent, 1); assert.equal(h.calls.length, 1);
  h.context.setWorkspaceToolsOpen(false); assert.equal(h.calls.length, 1);
  assert.match(source, /setInterval\(pollServiceProcesses, 1_000\)/);
  assert.match(source, /window\.addEventListener\("focus", pollServiceProcesses\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange",[\s\S]*?void pollServiceProcesses\(\)/);
});

test("unchanged status polls do not redraw controls or scan repositories", async () => {
  const h = harness(async () => [{ ...running() }]);
  let badgeText = "", badgeWrites = 0;
  Object.defineProperty(h.element("#running-count"), "textContent", {
    get: () => badgeText, set: value => { badgeText = String(value); badgeWrites++; },
  });
  await h.context.pollServiceProcesses(); const renders = h.renders(), controls = h.controls();
  await h.context.pollServiceProcesses(); await h.context.pollServiceProcesses();
  assert.equal(h.renders(), renders); assert.equal(h.controls(), controls); assert.equal(h.discoveries(), 0);
  assert.equal(badgeWrites, 1, "a stable count keeps its existing text node");
});

test("concurrent refresh triggers coalesce and a failed background check retries quietly", async () => {
  const pending = deferred(); let result = pending.promise;
  const h = harness(() => result);
  const first = h.context.pollServiceProcesses(), second = h.context.pollServiceProcesses();
  assert.equal(h.calls.length, 1); pending.reject(new Error("temporary backend restart")); await Promise.all([first, second]);
  assert.equal(h.errors.length, 0); assert.equal(h.state.processRefreshPromise, null);
  result = Promise.resolve([running()]); await h.context.pollServiceProcesses();
  assert.equal(h.element("#running-count").textContent, 1);
  result = Promise.reject(new Error("explicit refresh failed")); await h.context.refreshProcesses(true);
  assert.deepEqual(h.errors, ["explicit refresh failed"]); assert.equal(h.state.processes[0].running, true);
});

test("a stale read cannot delay or overwrite a confirmed start or its authoritative follow-up", async () => {
  const old = deferred(), fresh = deferred(); let reads = 0;
  const h = harness((_path, options) => options?.method === "POST" ? Promise.resolve({ ...running(), logs: [{ line: "started" }] }) : ++reads === 1 ? old.promise : fresh.promise);
  const poll = h.context.pollServiceProcesses();
  const mutation = h.context.serviceAction("service", "start"); await flush();
  assert.equal(reads, 2, "post-mutation refresh starts without waiting for the stale read");
  assert.equal(h.element("#running-count").textContent, 1, "confirmed launch is visible before a follow-up GET completes");
  assert.equal("logs" in h.state.processes[0], false);
  assert.equal(h.calls.at(-1).options.dedupe, false, "post-mutation read cannot reuse a pre-mutation API promise");
  fresh.resolve([running()]); await mutation;
  old.resolve([]); await poll;
  assert.equal(h.state.processes[0].id, "agent-process"); assert.equal(h.element("#running-count").textContent, 1);
  assert.equal(h.context.serviceOperations.size, 0);
});

test("stale read cleanup cannot start overlapping polls while an operation's authoritative refresh is pending", async () => {
  const old = deferred(), fresh = deferred(); let reads = 0;
  const h = harness((_path, options) => options?.method === "POST" ? Promise.resolve(running()) : ++reads === 1 ? old.promise : fresh.promise);
  const poll = h.context.pollServiceProcesses();
  const mutation = h.context.serviceAction("service", "start"); await flush();
  assert.equal(reads, 2);
  old.resolve([]); await poll;
  assert.equal(h.state.processRefreshPromise, null);
  assert.equal(h.context.serviceOperations.size, 1, "the operation owns its independent follow-up read until completion");
  await Promise.all([h.context.pollServiceProcesses(), h.context.pollServiceProcesses()]);
  assert.equal(reads, 2, "periodic polls cannot overlap the authoritative refresh after stale cleanup");
  assert.equal(h.element("#running-count").textContent, 1);
  fresh.resolve([running()]); await mutation;
  assert.equal(h.context.serviceOperations.size, 0);
  await h.context.pollServiceProcesses();
  assert.equal(reads, 3, "polling resumes after the operation has released its lock");
});

test("restart response never double-counts its replaced process and stop refresh clears the count", async () => {
  let current = [running("replacement")];
  const h = harness(async (_path, options) => options?.method === "POST" ? { ok: true } : current);
  h.context.acceptServiceProcesses([running("old"), { ...running("other"), configurationId: "other" }]);
  h.context.acceptServiceProcess(running("replacement"));
  assert.equal(h.element("#running-count").textContent, 2);
  assert.equal(h.state.processes.find(item => item.id === "old").running, false);
  assert.equal(h.state.processes.find(item => item.id === "other").running, true);
  current = current.map(item => ({ ...item, running: false, status: "stopped" }));
  await h.context.serviceAction("service", "stop");
  assert.equal(h.element("#running-count").textContent, 0);
});
