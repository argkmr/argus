import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeStateSync } from "../public/runtime-state-sync.mjs";
const snapshot = port => ({ repositories: [{ id: "repo" }], runConfigurations: [{ id: "run", port }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
test("all observers receive one authoritative snapshot without concurrent reads", async () => {
  const pending = deferred(), results = []; let reads = 0;
  const sync = createRuntimeStateSync({ read: () => { reads++; return pending.promise; }, apply: result => results.push(result), schedule: () => {} });
  const first = sync.refresh(), second = sync.refresh();
  assert.equal(first, second); await flush(); assert.equal(reads, 1);
  pending.resolve(snapshot(3000)); await first; assert.deepEqual(results, [snapshot(3000)]);
});
test("a pre-save read cannot replace a newer edit and all settled writes trigger refresh", async () => {
  const old = deferred(), fresh = deferred(), applied = [], scheduled = []; let reads = 0;
  const sync = createRuntimeStateSync({ read: () => ++reads === 1 ? old.promise : fresh.promise,
    apply: result => applied.push(result), schedule: callback => scheduled.push(callback) });
  const first = sync.refresh(); await flush();
  sync.observe({ path: "/api/run-configurations/run/ports", phase: "started" });
  await sync.refresh();
  sync.observe({ path: "/api/run-configurations/run/ports", phase: "settled" });
  scheduled.shift()();
  old.resolve(snapshot(3000)); await first; assert.deepEqual(applied, []);
  scheduled.shift()(); await flush(); fresh.resolve(snapshot(4000)); await flush();
  assert.deepEqual(applied, [snapshot(4000)]);
});
test("hidden views, failures and unrelated requests preserve last good state", async () => {
  let visible = false, fail = true, reads = 0; const applied = [];
  const sync = createRuntimeStateSync({ enabled: () => visible, read: () => { reads++; if (fail) throw Error("offline"); return snapshot(3001); }, apply: value => applied.push(value) });
  await sync.refresh(); assert.equal(reads, 0);
  sync.observe({ path: "/api/preferences", phase: "started" }); assert.equal(sync.revision, 0);
  visible = true; await sync.refresh(); assert.deepEqual(applied, []);
  fail = false; await sync.refresh(); assert.deepEqual(applied, [snapshot(3001)]);
});
