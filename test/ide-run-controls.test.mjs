import test from "node:test";
import assert from "node:assert/strict";
import { createIdeRunControls, describeIdeRunState } from "../public/ide-run-controls.mjs";

const repository = { id: "repo-a", name: "Review", path: "/synthetic/review" };
const otherRepository = { id: "repo-b", name: "Other", path: "/synthetic/other" };
const configuration = { id: "run/a", repositoryId: repository.id, name: "Review API", executable: "node", args: ["app.js"], cwd: ".", port: 3000 };
const otherConfiguration = { ...configuration, id: "run-b", repositoryId: otherRepository.id };
const process = (status = "running", extras = {}) => ({ id: "process-a", configurationId: configuration.id, repositoryId: repository.id, status, startedAt: "2026-09-18T12:00:00Z", running: status === "running", ...extras });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const context = (controls, overrides = {}) => controls.setContext({ repository, configurations: [configuration, otherConfiguration], processes: [], ...overrides });

test("IDE actions use only the active repository's saved Services configurations", () => {
  const state = describeIdeRunState({ repository, configurations: [otherConfiguration, configuration], known: true });
  assert.deepEqual(state.configurations, [configuration]);
  assert.equal(state.selectedConfiguration, configuration);
  assert.equal(state.canRun, true); assert.equal(state.canDebug, true); assert.equal(state.canSync, true); assert.equal(state.canStop, false);
  const missing = describeIdeRunState({ repository: { id: "missing" }, configurations: [configuration], known: true });
  assert.equal(missing.label, "Configure in Services"); assert.equal(missing.canRun, false);
  assert.equal(describeIdeRunState({ repository, configurations: [configuration] }).canRun, false);
});

test("active and transitional Services states block duplicate launches and only stopping blocks Stop", () => {
  for (const status of ["installing", "starting", "running", "syncing", "testing", "stopping"]) {
    const state = describeIdeRunState({ repository, configurations: [configuration], processes: [process(status)], known: true });
    assert.equal(state.canRun, false, status); assert.equal(state.canDebug, false, status); assert.equal(state.canSync, false, status);
    assert.equal(state.canStop, status !== "stopping", status);
    assert.equal(state.currentProcess.status, status);
  }
  const failed = describeIdeRunState({ repository, configurations: [configuration], processes: [process("failed")], known: true });
  assert.equal(failed.canRun, true); assert.equal(failed.label, "Failed");
  const stopping = describeIdeRunState({ repository, configurations: [configuration], known: true, busy: "stop" });
  assert.equal(stopping.canRun, false); assert.equal(stopping.label, "Stopping…");
});

test("the active process wins over more recent finished history; latest logs are preserved", () => {
  const active = process("starting", { startedAt: "2026-09-18T10:00:00Z" });
  const finished = process("failed", { id: "newer-history", startedAt: "2026-09-18T13:00:00Z" });
  const state = describeIdeRunState({ repository, configurations: [configuration], processes: [finished, active], known: true });
  assert.equal(state.currentProcess, active); assert.equal(state.latestProcess, active);
  const terminal = describeIdeRunState({ repository, configurations: [configuration], processes: [finished], known: true });
  assert.equal(terminal.latestProcess, finished); assert.equal(terminal.currentProcess, null);
});

test("finished repository maintenance retains its logs after a configuration is added without changing Run or Stop targets", () => {
  for (const status of ["completed", "failed", "stopped"]) {
    const controls = createIdeRunControls({ api: async () => [] });
    const maintenance = process("syncing", { configurationId: "repository:repo-a", task: "sync" });
    context(controls, { configurations: [], processes: [maintenance] });
    assert.equal(controls.state.latestLogProcess, maintenance);
    controls.setContext({ configurations: [configuration] });
    assert.equal(controls.state.controlId, "repository:repo-a");
    const finished = { ...maintenance, status };
    controls.setContext({ processes: [finished] });
    assert.equal(controls.state.latestLogProcess, finished);
    assert.equal(controls.state.controlId, configuration.id);
    assert.equal(controls.state.currentProcess, null); assert.equal(controls.state.latestProcess, null);
    assert.equal(controls.state.canRun, true); assert.equal(controls.state.canSync, true); assert.equal(controls.state.canStop, false);
    assert.equal(controls.state.label, "Stopped");
    controls.dispose();
  }
});

test("log selection prioritizes active configured work and otherwise the active repository maintenance", () => {
  const service = process("running", { startedAt: "2026-09-18T10:00:00Z" });
  const maintenance = process("completed", { id: "sync", configurationId: "repository:repo-a", task: "sync", startedAt: "2026-09-18T11:00:00Z" });
  const state = describeIdeRunState({ repository, configurations: [configuration], processes: [maintenance, service], known: true });
  assert.equal(state.latestLogProcess, service); assert.equal(state.latestProcess, service);
  assert.equal(state.controlId, configuration.id); assert.equal(state.canStop, true);
  const activeMaintenance = { ...maintenance, status: "syncing" };
  const finishedService = { ...service, status: "stopped", startedAt: "2026-09-18T12:00:00Z" };
  assert.equal(describeIdeRunState({ repository, configurations: [configuration], processes: [finishedService, activeMaintenance] }).latestLogProcess, activeMaintenance);
  assert.equal(describeIdeRunState({ repository, configurations: [configuration], processes: [service, activeMaintenance] }).latestLogProcess, service);
});

test("finished log selection compares relevant service and maintenance history and excludes other scopes", () => {
  const service = process("stopped", { startedAt: "2026-09-18T10:00:00Z" });
  const maintenance = process("failed", { id: "sync", configurationId: "repository:repo-a", task: "sync", startedAt: "2026-09-18T11:00:00Z" });
  const unrelated = [
    process("running", { id: "other-config", configurationId: "unselected-config" }),
    process("running", { id: "other-repository", configurationId: "repository:repo-b", repositoryId: otherRepository.id }),
  ];
  const state = describeIdeRunState({ repository, configurations: [configuration], processes: [service, maintenance, ...unrelated], known: true });
  assert.equal(state.latestLogProcess, maintenance); assert.equal(state.latestProcess, service);
  assert.equal(state.label, "Stopped"); assert.equal(state.canRun, true); assert.equal(state.canStop, false);
  const newerService = { ...service, startedAt: "2026-09-18T12:00:00Z" };
  assert.equal(describeIdeRunState({ repository, configurations: [configuration], processes: [newerService, maintenance, ...unrelated] }).latestLogProcess, newerService);
  assert.equal(describeIdeRunState({ repository, configurations: [configuration], processes: unrelated }).latestLogProcess, null);
  assert.equal(describeIdeRunState({ configurations: [configuration], processes: [service, maintenance] }).latestLogProcess, null);
});

test("Run delegates the original id to Services and broadcasts actual process state", async () => {
  const calls = [], shared = [], started = [];
  let running = [];
  const controls = createIdeRunControls({ api: async (path, options) => {
    calls.push([path, options]);
    if (options?.method === "POST") { running = [process("starting")]; return running[0]; }
    return running;
  }, onProcesses: list => shared.push(list), onStarted: (...args) => started.push(args) });
  context(controls);
  assert.equal(await controls.run("run"), running[0]);
  assert.deepEqual(calls, [["/api/processes", undefined], ["/api/run-configurations/run%2Fa/start", { method: "POST" }], ["/api/processes", undefined]]);
  assert.equal(shared.at(-1)[0].status, "starting"); assert.equal(controls.state.canRun, false);
  assert.equal(started[0][1].configuration, configuration); assert.equal(started[0][1].repository, repository);
  assert.equal(started[0][1].mode, "run"); assert.equal(controls.state.busy, "");
  controls.dispose();
});

test("Debug uses the same service endpoint with debug:true, never a second runner", async () => {
  const calls = [], started = [];
  let running = [];
  const controls = createIdeRunControls({ api: async (path, options) => {
    calls.push([path, options]);
    if (options?.method === "POST") { running = [process("starting", { debug: { runtime: "node", host: "127.0.0.1", port: 9229, state: "starting" } })]; return running[0]; }
    return running;
  }, onStarted: (result, source) => started.push([result, source]) });
  context(controls); await controls.run("debug");
  assert.deepEqual(calls[1], ["/api/run-configurations/run%2Fa/start", { method: "POST", body: { debug: true } }]);
  assert.equal(started[0][1].mode, "debug");
  assert.equal(controls.state.debug.state, "starting", "launch acceptance must not imply debugger attachment");
  controls.dispose();
});

test("Sync reuses Services dependency maintenance and shares the returned process and logs identity", async () => {
  const calls = [], started = [], shared = [], locks = new Map();
  let current = [];
  const controls = createIdeRunControls({ api: async (path, options) => {
    calls.push([path, options]);
    if (options?.method === "POST") {
      assert.equal(locks.get(configuration.id).mode, "sync");
      current = [process("syncing", { task: "sync", command: "./gradlew --refresh-dependencies help" })];
      return current[0];
    }
    return current;
  }, operations: locks, onStarted: (value, source) => started.push({ value, source }), onProcesses: value => shared.push(value) });
  context(controls);
  const result = await controls.run("sync");
  assert.deepEqual(calls, [["/api/processes", undefined], ["/api/repositories/repo-a/project-structure/maintenance", { method: "POST", body: { action: "sync", configurationId: configuration.id } }], ["/api/processes", undefined]]);
  assert.equal(result, current[0]); assert.equal(started[0].source.mode, "sync"); assert.equal(started[0].source.configuration, configuration);
  assert.equal(shared.at(-1)[0].task, "sync"); assert.equal(controls.state.label, "Syncing"); assert.equal(controls.state.canSync, false); assert.equal(controls.state.canStop, true);
  assert.equal(locks.size, 0);
  current = [process("completed", { task: "sync" })]; await controls.refresh();
  assert.equal(controls.state.canSync, true); assert.equal(controls.state.latestProcess.status, "completed");
  controls.dispose();
});

test("Sync cannot race a Services launch, change selected configuration or cross repositories", async () => {
  const pending = defer(), calls = [], locks = new Map();
  const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return pending.promise; }, operations: locks });
  context(controls);
  const sync = controls.run("sync"); await Promise.resolve();
  assert.equal(controls.state.busy, "sync"); assert.equal(controls.state.label, "Syncing…");
  assert.equal(await controls.run("sync"), null); assert.equal(await controls.run("run"), null);
  controls.setContext({ repository: otherRepository }); pending.resolve([]); await sync;
  assert.deepEqual(calls, [["/api/processes"]]); assert.equal(locks.size, 0);
  controls.dispose();
});

test("Sync observes newer Services state and never overwrites an active process", async () => {
  const calls = [];
  const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return [process("running")]; } });
  context(controls); assert.equal(await controls.run("sync"), null);
  assert.deepEqual(calls, [["/api/processes"]]); assert.equal(controls.state.canSync, false);
  controls.dispose();
});

test("Sync reports unsupported-project errors and never invents a completed dependency refresh", async () => {
  const errors = [], started = [];
  const controls = createIdeRunControls({ api: async (_path, options) => {
    if (options?.method === "POST") throw new Error("Dependency sync is unavailable for this project");
    return [];
  }, onError: error => errors.push(error.message), onStarted: value => started.push(value) });
  context(controls); assert.equal(await controls.run("sync"), null);
  assert.match(errors[0], /unavailable/); assert.deepEqual(started, []); assert.equal(controls.state.currentProcess, null); assert.equal(controls.state.canSync, true);
  controls.dispose();
});

test("Sync uses the unsaved-buffer guard before any process request and releases its lock", async () => {
  const calls = [], gated = [], operations = new Map();
  const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return []; }, operations,
    beforeStart: input => { gated.push(input); return false; } });
  context(controls); assert.equal(await controls.run("sync"), null);
  assert.deepEqual(gated, [{ repository, configuration, mode: "sync" }]); assert.equal(calls.length, 0); assert.equal(operations.size, 0);
  controls.dispose();
});

test("an unconfigured repository syncs and stops through repository maintenance without creating a run configuration", async () => {
  const calls = [], shared = [], started = [], operations = new Map();
  let current = [];
  const controls = createIdeRunControls({ api: async (path, options) => {
    calls.push([path, options]);
    if (path.endsWith("/maintenance/stop")) { current = [{ ...current[0], status: "stopping" }]; return { ok: true }; }
    if (options?.method === "POST") {
      assert.equal(operations.get("repository:repo-a").mode, "sync");
      current = [process("syncing", { configurationId: "repository:repo-a", task: "sync" })]; return current[0];
    }
    return current;
  }, operations, onStarted: (value, source) => started.push({ value, source }), onProcesses: value => shared.push(value) });
  context(controls, { configurations: [] });
  assert.equal(controls.state.canRun, false); assert.equal(controls.state.canDebug, false); assert.equal(controls.state.canSync, true);
  assert.equal(controls.state.selectedConfiguration, null); assert.equal(controls.state.controlId, "repository:repo-a");
  assert.equal(await controls.run("run"), null); await controls.run("sync");
  assert.deepEqual(calls[1], ["/api/repositories/repo-a/project-structure/maintenance", { method: "POST", body: { action: "sync" } }]);
  assert.equal(started[0].source.configuration, null); assert.equal(shared.at(-1)[0].configurationId, "repository:repo-a");
  assert.equal(controls.state.canStop, true); assert.equal(controls.state.canSync, false);
  await controls.run("stop");
  assert(calls.some(([path, options]) => path === "/api/repositories/repo-a/project-structure/maintenance/stop" && options.method === "POST"));
  assert.equal(controls.state.currentProcess.status, "stopping"); assert.equal(controls.state.canStop, false); assert.equal(operations.size, 0);
  controls.dispose();
});

test("no-config sync sees Services synthetic maintenance and respects its operation lock", async () => {
  const operations = new Map([["repository:repo-a", { mode: "sync", repositoryId: repository.id }]]), calls = [];
  const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return []; }, operations });
  context(controls, { configurations: [] }); assert.equal(controls.state.canSync, false); assert.equal(await controls.run("sync"), null);
  operations.clear(); controls.setContext({ processes: [process("syncing", { configurationId: "repository:repo-a" })] });
  assert.equal(controls.state.label, "Syncing"); assert.equal(controls.state.canSync, false); assert.equal(controls.state.canStop, true);
  assert.equal(calls.length, 0); controls.dispose();
});

test("adding a Services configuration during no-config preflight cannot redirect the sync", async () => {
  const pending = defer(), calls = [];
  const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return pending.promise; } });
  context(controls, { configurations: [] });
  const sync = controls.run("sync"); await Promise.resolve(); controls.setContext({ configurations: [configuration] });
  pending.resolve([]); await sync;
  assert.deepEqual(calls, [["/api/processes"]]); assert.equal(controls.state.controlId, configuration.id); controls.dispose();
});

test("saved configurations do not hide active repository maintenance or enable a conflicting launch", () => {
  for (const status of ["starting", "syncing", "testing", "stopping"]) {
    const maintenance = process(status, { configurationId: "repository:repo-a", task: "sync" });
    const state = describeIdeRunState({ repository, configurations: [configuration], processes: [maintenance], known: true });
    assert.equal(state.selectedConfiguration, configuration, "the new Services configuration remains selected");
    assert.equal(state.controlId, "repository:repo-a"); assert.equal(state.currentProcess, maintenance);
    assert.equal(state.canRun, false); assert.equal(state.canDebug, false); assert.equal(state.canSync, false);
    assert.equal(state.canStop, status !== "stopping");
  }
  const finished = describeIdeRunState({ repository, configurations: [configuration], processes: [process("completed", { configurationId: "repository:repo-a" })], known: true });
  assert.equal(finished.controlId, configuration.id); assert.equal(finished.canRun, true); assert.equal(finished.canSync, true);
  const other = describeIdeRunState({ repository, configurations: [configuration], processes: [process("syncing", { configurationId: "repository:repo-b", repositoryId: otherRepository.id })], known: true });
  assert.equal(other.controlId, configuration.id); assert.equal(other.canRun, true, "another repository's maintenance is unrelated");
});

test("configured IDE controls honor a pending repository-wide Services operation before its process exists", async () => {
  const calls = [], operations = new Map([["repository:repo-a", { mode: "sync", repositoryId: repository.id }]]);
  const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return []; }, operations });
  context(controls);
  assert.equal(controls.state.label, "Syncing…");
  for (const mode of ["run", "debug", "sync", "stop"]) assert.equal(await controls.run(mode), null);
  assert.deepEqual(calls, []);
  operations.clear(); assert.equal(controls.state.canRun, true); controls.dispose();
});

test("Stop targets synthetic maintenance even after a saved configuration has been added", async () => {
  const calls = [], operations = new Map();
  let current = [process("syncing", { configurationId: "repository:repo-a", task: "sync" })];
  const controls = createIdeRunControls({ api: async (path, options) => {
    calls.push([path, options]);
    if (options?.method === "POST") {
      assert.equal(operations.get("repository:repo-a")?.mode, "stop"); assert.equal(operations.has(configuration.id), false);
      current = [{ ...current[0], status: "stopping" }]; return { ok: true };
    }
    return current;
  }, operations });
  context(controls, { configurations: [], processes: current });
  controls.setContext({ configurations: [configuration] });
  assert.equal(controls.state.canStop, true); await controls.run("stop");
  assert.deepEqual(calls[1], ["/api/repositories/repo-a/project-structure/maintenance/stop", { method: "POST" }]);
  assert.equal(controls.state.currentProcess.status, "stopping"); assert.equal(controls.state.canStop, false);
  current = [{ ...current[0], status: "stopped" }]; await controls.refresh();
  assert.equal(controls.state.controlId, configuration.id); assert.equal(controls.state.canRun, true); assert.equal(operations.size, 0);
  controls.dispose();
});

test("configured launch preflight sees newly accepted repository maintenance and sends no conflicting mutation", async () => {
  for (const mode of ["run", "debug", "sync"]) {
    const calls = [];
    const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return [process("syncing", { configurationId: "repository:repo-a" })]; } });
    context(controls); assert.equal(await controls.run(mode), null);
    assert.deepEqual(calls, [["/api/processes"]]); assert.equal(controls.state.label, "Syncing"); assert.equal(controls.state.canStop, true);
    controls.dispose();
  }
});

test("a repository-wide Services lock arriving during configured preflight blocks the launch before its process exists", async () => {
  for (const stage of ["gate", "processes"]) {
    const pending = defer(), entered = defer(), calls = [], operations = new Map();
    const controls = createIdeRunControls({ operations,
      beforeStart: () => { if (stage === "gate") { entered.resolve(); return pending.promise; } return true; },
      api: async (...args) => { calls.push(args); entered.resolve(); return pending.promise; } });
    context(controls); const running = controls.run("run"); await entered.promise;
    const maintenance = { mode: "sync", repositoryId: repository.id }; operations.set("repository:repo-a", maintenance);
    pending.resolve(stage === "gate" ? true : []); assert.equal(await running, null);
    assert.equal(calls.some(([, options]) => options?.method === "POST"), false);
    assert.equal(operations.has(configuration.id), false); assert.equal(operations.get("repository:repo-a"), maintenance);
    assert.equal(controls.state.label, "Syncing…"); controls.dispose();
  }
});

test("a synthetic sync accepted while a configuration is created remains visible and blocked until completion", async () => {
  const pending = defer(), entered = defer(), accepted = [], calls = [];
  let current = [];
  const controls = createIdeRunControls({ api: async (path, options) => {
    calls.push([path, options]);
    if (options?.method === "POST") { entered.resolve(); return pending.promise; }
    return current;
  }, onStarted: (value, source) => accepted.push({ value, source }) });
  context(controls, { configurations: [] }); const syncing = controls.run("sync"); await entered.promise;
  controls.setContext({ configurations: [configuration] });
  assert.equal(controls.state.label, "Syncing…"); assert.equal(controls.state.canRun, false);
  current = [process("syncing", { configurationId: "repository:repo-a", task: "sync" })]; pending.resolve(current[0]); await syncing;
  assert.equal(controls.state.currentProcess, current[0]); assert.equal(controls.state.controlId, "repository:repo-a");
  assert.equal(controls.state.canDebug, false); assert.equal(controls.state.canSync, false); assert.equal(controls.state.canStop, true);
  assert.equal(accepted.length, 1); assert.equal(accepted[0].source.configuration, null);
  assert.deepEqual(calls.find(([, options]) => options?.method === "POST")[1].body, { action: "sync" });
  current = [{ ...current[0], status: "completed" }]; await controls.refresh();
  assert.equal(controls.state.controlId, configuration.id); assert.equal(controls.state.canRun, true); controls.dispose();
});

test("Stop shares Services stop endpoint and waits for actual stopping/stopped state", async () => {
  const calls = [];
  let running = [process()];
  const controls = createIdeRunControls({ api: async (path, options) => {
    calls.push([path, options]);
    if (options?.method === "POST") { running = [process("stopping")]; return { ok: true }; }
    return running;
  } });
  context(controls, { processes: running }); await controls.run("stop");
  assert.deepEqual(calls[1], ["/api/run-configurations/run%2Fa/stop", { method: "POST" }]);
  assert.equal(controls.state.currentProcess.status, "stopping"); assert.equal(controls.state.canStop, false);
  running = [process("stopped")]; await controls.refresh();
  assert.equal(controls.state.canRun, true); assert.equal(controls.state.latestProcess.id, "process-a");
  controls.dispose();
});

test("fresh process preflight prevents launching a service started in Services meanwhile", async () => {
  const calls = [];
  const controls = createIdeRunControls({ api: async (path, options) => { calls.push([path, options]); return [process("starting")]; } });
  context(controls);
  assert.equal(controls.state.canRun, true);
  assert.equal(await controls.run("run"), null);
  assert.deepEqual(calls, [["/api/processes", undefined]]);
  assert.equal(controls.state.canRun, false); assert.equal(controls.state.busy, "");
  controls.dispose();
});

test("duplicate clicks and changes of configuration are blocked while a launch is in flight", async () => {
  const preflight = defer(), calls = [];
  let running = [];
  const controls = createIdeRunControls({ api: async (path, options) => {
    calls.push([path, options]);
    if (calls.length === 1) return preflight.promise;
    if (options?.method === "POST") { running = [process("starting")]; return running[0]; }
    return running;
  } });
  context(controls, { configurations: [configuration, { ...configuration, id: "second" }] });
  const first = controls.run("run");
  assert.equal(controls.state.busy, "run"); assert.equal(controls.select("second"), false);
  assert.equal(await controls.run("debug"), null);
  preflight.resolve([]); await first;
  assert.equal(calls.filter(([, options]) => options?.method === "POST").length, 1);
  controls.dispose();
});

test("repository switch before preflight finishes prevents a stale launch", async () => {
  const pending = defer(), calls = [];
  const controls = createIdeRunControls({ api: async (path, options) => { calls.push([path, options]); return pending.promise; } });
  context(controls); const launch = controls.run("debug"); await Promise.resolve();
  controls.setContext({ repository: otherRepository }); pending.resolve([]); await launch;
  assert.deepEqual(calls, [["/api/processes", undefined]]);
  assert.equal(controls.state.selectedId, otherConfiguration.id); assert.equal(controls.state.busy, "");
  controls.dispose();
});

test("repository switch during accepted launch updates shared Services but never opens a debugger in the wrong repo", async () => {
  const pending = defer(), entered = defer(), started = [], shared = [];
  let running = [];
  const controls = createIdeRunControls({ api: async (path, options) => {
    if (options?.method === "POST") { entered.resolve(); return pending.promise; }
    return running;
  }, onStarted: (...args) => started.push(args), onProcesses: list => shared.push(list) });
  context(controls); const launch = controls.run("debug"); await entered.promise;
  controls.setContext({ repository: otherRepository });
  running = [process("starting")]; pending.resolve(running[0]); await launch;
  assert.equal(started.length, 0); assert.equal(shared.at(-1)[0].configurationId, configuration.id);
  assert.equal(controls.state.selectedId, otherConfiguration.id); assert.equal(controls.state.currentProcess, null);
  controls.dispose();
});

test("selection is remembered per repository; removed configs cannot be launched", async () => {
  const calls = [];
  const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return []; } });
  const second = { ...configuration, id: "second" };
  context(controls, { configurations: [configuration, second, otherConfiguration] });
  assert.equal(controls.select(otherConfiguration.id), false); assert.equal(controls.select(second.id), true);
  controls.setContext({ repository: otherRepository }); assert.equal(controls.state.selectedId, otherConfiguration.id);
  controls.setContext({ repository }); assert.equal(controls.state.selectedId, second.id);
  controls.setContext({ configurations: [otherConfiguration] });
  assert.equal(controls.state.canRun, false); assert.equal(await controls.run("run"), null); assert.equal(calls.length, 0);
  controls.dispose();
});

test("out-of-order polling cannot overwrite newer authoritative process state", async () => {
  const old = defer(), latest = defer(), shared = [];
  let count = 0;
  const controls = createIdeRunControls({ api: async () => (++count === 1 ? old.promise : latest.promise), onProcesses: list => shared.push(list) });
  context(controls); const first = controls.refresh();
  await Promise.resolve(); controls.setContext({ repository: otherRepository }); const second = controls.refresh();
  await Promise.resolve(); latest.resolve([process()]); await second;
  old.resolve([]); await first;
  assert.deepEqual(shared, [[process()]]);
  controls.setContext({ repository }); assert.equal(controls.state.currentProcess.status, "running");
  controls.dispose();
});

test("API errors restore controls with honest errors and do not report a successful start", async () => {
  const errors = [], started = [];
  const controls = createIdeRunControls({ api: async (_path, options) => {
    if (options?.method === "POST") throw new Error("Debug service supports direct java and node commands");
    return [];
  }, onError: reason => errors.push(reason.message), onStarted: result => started.push(result) });
  context(controls); assert.equal(await controls.run("debug"), null);
  assert.equal(errors.length, 1); assert.equal(controls.state.error, errors[0]); assert.equal(started.length, 0);
  assert.equal(controls.state.busy, ""); assert.equal(controls.state.canRun, true);
  controls.dispose();
});

test("stale launch failures do not show errors in another repository", async () => {
  const pending = defer(), entered = defer(), errors = [];
  const controls = createIdeRunControls({ api: async (_path, options) => {
    if (options?.method === "POST") { entered.resolve(); return pending.promise; }
    return [];
  }, onError: reason => errors.push(reason) });
  context(controls); const launch = controls.run("run"); await entered.promise;
  controls.setContext({ repository: otherRepository }); pending.reject(new Error("Original launch failed")); await launch;
  assert.equal(errors.length, 0); assert.equal(controls.state.error, "");
  controls.dispose();
});

test("a failed status refresh after successful launch preserves its actual returned process", async () => {
  const started = [], errors = [];
  let reads = 0;
  const controls = createIdeRunControls({ api: async (_path, options) => {
    if (options?.method === "POST") return process("starting");
    if (++reads > 1) throw new Error("Unable to refresh Services");
    return [];
  }, onStarted: result => started.push(result), onError: reason => errors.push(reason) });
  context(controls); const result = await controls.run("run");
  assert.equal(result.id, "process-a"); assert.equal(started.length, 1); assert.equal(errors.length, 1);
  assert.equal(controls.state.currentProcess.status, "starting"); assert.equal(controls.state.canRun, false);
  controls.dispose();
});

test("disposal suppresses callbacks and prevents stale preflight writes", async () => {
  const pending = defer(), calls = [], callbacks = [];
  const controls = createIdeRunControls({ api: async (path, options) => { calls.push([path, options]); return pending.promise; },
    onChange: value => callbacks.push(value), onProcesses: value => callbacks.push(value) });
  context(controls); const launch = controls.run("run"); await Promise.resolve(); controls.dispose(); const before = callbacks.length;
  pending.resolve([]); await launch;
  assert.equal(callbacks.length, before); assert.equal(calls.length, 1);
  assert.equal(await controls.run("run"), null); assert.equal(await controls.refresh(), null);
});

test("observer failures do not turn an accepted service launch into an execution error", async () => {
  const errors = [];
  let running = [];
  const controls = createIdeRunControls({ api: async (_path, options) => {
    if (options?.method === "POST") { running = [process("starting")]; return running[0]; }
    return running;
  }, onChange: () => { throw new Error("render failed"); }, onStarted: async () => { throw new Error("attach failed"); }, onError: error => errors.push(error) });
  context(controls); assert.equal((await controls.run("run")).id, "process-a");
  assert.equal(errors.length, 0); assert.equal(controls.state.currentProcess.status, "starting");
  controls.dispose();
});

test("unsaved-buffer gate can cancel before any process request and releases the shared lock", async () => {
  const calls = [], gated = [], locks = new Map();
  const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return []; }, operations: locks,
    beforeStart: async source => { gated.push(source); return false; } });
  context(controls); assert.equal(await controls.run("debug"), null);
  assert.deepEqual(gated, [{ repository, configuration, mode: "debug" }]);
  assert.equal(calls.length, 0); assert.equal(locks.size, 0); assert.equal(controls.state.canRun, true);
  controls.dispose();
});

test("shared Services lock prevents IDE actions and IDE locks persist through asynchronous gates", async () => {
  const locks = new Map([[configuration.id, { mode: "restart", repositoryId: repository.id }]]), gate = defer(), calls = [];
  const controls = createIdeRunControls({ api: async (...args) => { calls.push(args); return []; }, operations: locks,
    beforeStart: () => gate.promise });
  context(controls); assert.equal(controls.state.busy, "restart"); assert.equal(controls.state.label, "Restarting…");
  assert.equal(await controls.run("run"), null); assert.equal(calls.length, 0);
  locks.delete(configuration.id); const launch = controls.run("run");
  assert.equal(locks.has(configuration.id), true); assert.equal(controls.state.busy, "run");
  controls.setContext({ repository: otherRepository }); gate.resolve(true); await launch;
  assert.equal(calls.length, 0); assert.equal(locks.size, 0);
  controls.dispose();
});

test("stopping an active service never invokes the unsaved-buffer launch gate", async () => {
  let gated = false;
  const controls = createIdeRunControls({ api: async (_path, options) => options?.method === "POST" ? { ok: true } : [process()],
    beforeStart: () => { gated = true; return false; } });
  context(controls, { processes: [process()] }); assert.deepEqual(await controls.run("stop"), { ok: true });
  assert.equal(gated, false); controls.dispose();
});

test("a newer Services snapshot supersedes an in-flight IDE preflight", async () => {
  const old = defer(), calls = [], shared = [];
  const controls = createIdeRunControls({ api: async (path, options) => { calls.push([path, options]); return old.promise; }, onProcesses: list => shared.push(list) });
  context(controls); const launch = controls.run("run"); await Promise.resolve();
  controls.setContext({ processes: [process("starting")] });
  old.resolve([]); await launch;
  assert.equal(calls.length, 1); assert.equal(shared.length, 0);
  assert.equal(controls.state.currentProcess.status, "starting");
  controls.dispose();
});

test("shared snapshot feedback does not invalidate its own launch or later fresh polls", async () => {
  let running = [], writes = 0, controls;
  controls = createIdeRunControls({ api: async (_path, options) => {
    if (options?.method === "POST") { writes++; running = [process("starting")]; return running[0]; }
    return running;
  }, onProcesses: list => controls.setContext({ processes: list }) });
  context(controls); await controls.run("run");
  assert.equal(writes, 1); assert.equal(controls.state.currentProcess.status, "starting");
  running = [process("running")]; await controls.refresh();
  assert.equal(controls.state.currentProcess.status, "running");
  controls.dispose();
});

test("unchanged app renders do not discard a fresh in-flight IDE snapshot", async () => {
  const pending = defer(), initial = [];
  const controls = createIdeRunControls({ api: async () => pending.promise });
  context(controls, { processes: initial }); const refresh = controls.refresh(); await Promise.resolve();
  controls.setContext({ processes: initial });
  pending.resolve([process()]); await refresh;
  assert.equal(controls.state.currentProcess.status, "running"); controls.dispose();
});

test("a configuration removed during preflight never falls back to launching a different service", async () => {
  const pending = defer(), calls = [], replacement = { ...configuration, id: "replacement" };
  const controls = createIdeRunControls({ api: async (path, options) => { calls.push([path, options]); return pending.promise; } });
  context(controls, { configurations: [configuration, replacement] }); const launch = controls.run("run"); await Promise.resolve();
  controls.setContext({ configurations: [replacement] }); pending.resolve([]); await launch;
  assert.equal(calls.length, 1); assert.equal(controls.state.selectedId, replacement.id);
  controls.dispose();
});

test("an old polling failure cannot replace a newer valid Services state with an error", async () => {
  const pending = defer(), errors = [];
  const controls = createIdeRunControls({ api: async () => pending.promise, onError: reason => errors.push(reason) });
  context(controls); const refresh = controls.refresh(); await Promise.resolve();
  controls.setContext({ processes: [process()] }); pending.reject(new Error("Old timeout")); await refresh;
  assert.equal(controls.state.currentProcess.status, "running"); assert.equal(errors.length, 0); assert.equal(controls.state.error, "");
  controls.dispose();
});
