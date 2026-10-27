import test from "node:test";
import assert from "node:assert/strict";
import { createProjectSyncLifecycle } from "../public/project-sync-lifecycle.mjs";
const tick = () => new Promise(resolve => setImmediate(resolve));
const sync = (status, extra = {}) => ({ id: "job", repositoryId: "repo", task: "sync", status, exitCode: status === "completed" ? 0 : null, ...extra });

test("only a successful observed dependency sync invalidates the index, once", async () => {
  const refreshed = [], flow = createProjectSyncLifecycle({ refresh: id => refreshed.push(id) });
  flow.observe([sync("completed")]); // historical jobs at app startup
  await tick(); assert.deepEqual(refreshed, []);
  flow.observe([sync("syncing")]); flow.observe([sync("completed")]); flow.observe([sync("completed")]);
  await tick(); assert.deepEqual(refreshed, ["repo"]);
});

test("fast explicit completion works; failed/stopped/test tasks never reload", async () => {
  const refreshed = [], flow = createProjectSyncLifecycle({ refresh: id => refreshed.push(id) });
  flow.track(sync("completed"));
  for (const status of ["failed", "stopped"]) { flow.track(sync("syncing", { id: status })); flow.observe([sync(status, { id: status })]); }
  flow.track(sync("completed", { id: "tests", task: "test" }));
  flow.track(sync("completed", { id: "nonzero", exitCode: 1 }));
  await tick(); assert.deepEqual(refreshed, ["repo"]);
});

test("refresh errors are reported without retrying or changing process state", async () => {
  let calls = 0; const errors = [];
  const flow = createProjectSyncLifecycle({ refresh: () => { calls++; throw new Error("offline"); }, onError: error => errors.push(error.message) });
  flow.track(sync("completed")); await tick(); flow.track(sync("completed")); await tick();
  assert.equal(calls, 1); assert.deepEqual(errors, ["offline"]);
});
