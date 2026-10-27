import test from "node:test";
import assert from "node:assert/strict";
import { createEditorExitGuard } from "../desktop/editor-exit-guard.mjs";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("native exit flushes location synchronously before reading the unchanged dirty guards", async () => {
  const source = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const probe = JSON.parse(source.match(/executeJavaScript\(("[^\n]+argus:before-native-exit[^\n]+")\)/)[1]);
  for (const dirty of ["true", "false"]) {
    const events = [];
    const result = vm.runInNewContext(probe, { Event: class { constructor(type) { this.type = type; } },
      window: { dispatchEvent: event => events.push(event.type) }, document: { documentElement: { dataset: {
        get argusIdeDirty() { assert.deepEqual(events, ["argus:before-native-exit"]); return dirty; }, argusDiagramDirty: "false",
      } } } });
    assert.equal(result, dirty === "true");
  }
});

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(overrides = {}) {
  const calls = [];
  const guard = createEditorExitGuard({
    readDirty: async () => true,
    confirmDiscard: async ({ action, checkFailed }) => { calls.push(["prompt", action, checkFailed]); return false; },
    confirmPreventedUnload: () => false,
    setQuitting: value => calls.push(["quitting", value]),
    setWindowEnabled: value => calls.push(["enabled", value]),
    drain: async () => calls.push(["drain"]),
    exit: options => calls.push(["exit", options]),
    onFailure: error => calls.push(["failure", error.message]),
    ...overrides,
  });
  return { guard, calls };
}

test("cancelled native quit preserves the window and never drains its backend", async () => {
  const { guard, calls } = harness();
  assert.equal(await guard.requestQuit(), false);
  assert.deepEqual(calls, [["prompt", "quit", false]]);
});

test("duplicate quit requests share consent and drain, then exit in order", async () => {
  const consent = deferred(), drain = deferred();
  let prompts = 0, drains = 0;
  const { guard, calls } = harness({
    confirmDiscard: () => { prompts++; return consent.promise; },
    drain: () => { drains++; return drain.promise; },
  });
  const first = guard.requestQuit({ restart: true }), second = guard.requestQuit();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(prompts, 1); assert.equal(drains, 0);
  consent.resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drains, 1);
  assert.deepEqual(calls, [["quitting", true], ["enabled", false]]);
  drain.resolve();
  assert.equal(await first, true);
  assert.deepEqual(calls.at(-1), ["exit", { restart: true }]);
});

test("clean quit needs no prompt, while failed draft checks require explicit consent", async () => {
  const clean = harness({ readDirty: async () => false, confirmDiscard: () => assert.fail("clean editor should not prompt") });
  assert.equal(await clean.guard.requestQuit(), true);
  assert.equal(clean.calls.filter(call => call[0] === "drain").length, 1);
  const unavailable = harness({ readDirty: async () => { throw new Error("renderer unresponsive"); } });
  assert.equal(await unavailable.guard.requestQuit(), false);
  assert.deepEqual(unavailable.calls, [["prompt", "quit", true]]);
});

test("drain failure restores editing and permits a later safe quit", async () => {
  let fail = true;
  const { guard, calls } = harness({ readDirty: async () => false, drain: async () => { if (fail) throw new Error("busy"); } });
  assert.equal(await guard.requestQuit(), false);
  assert.deepEqual(calls, [["quitting", true], ["enabled", false], ["quitting", false], ["enabled", true], ["failure", "busy"]]);
  fail = false;
  assert.equal(await guard.requestQuit(), true);
});

test("window close honors Cancel and only overrides renderer veto after discard", () => {
  let override = 0;
  const event = { preventDefault: () => { override++; } };
  assert.equal(harness().guard.handlePreventedUnload(event), false);
  assert.equal(override, 0);
  const accept = harness({ confirmPreventedUnload: () => true });
  assert.equal(accept.guard.handlePreventedUnload(event), true);
  assert.equal(override, 1);
  assert.deepEqual(accept.calls, [], "Closing a macOS window does not drain the service");
});

test("a pending quit cannot open a second close prompt and reset consent never drains", async () => {
  const consent = deferred();
  const { guard, calls } = harness({ confirmDiscard: () => consent.promise, confirmPreventedUnload: () => assert.fail("duplicate prompt") });
  const quitting = guard.requestQuit();
  assert.equal(guard.handlePreventedUnload({ preventDefault: () => assert.fail("unload during consent") }), false);
  consent.resolve(false);
  await quitting;
  assert.deepEqual(calls, []);
  const reset = harness();
  assert.equal(await reset.guard.confirmDraftLoss("reset"), false);
  assert.deepEqual(reset.calls, [["prompt", "reset", false]]);
});
