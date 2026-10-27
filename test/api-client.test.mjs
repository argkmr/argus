import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../public/api-client.mjs";

test("mutation observers cover successful and failed writes without changing request results", async () => {
  const events = [];
  const api = createApiClient(async path => { if (path === "/failure") throw Error("offline"); return { ok: true, json: async () => ({ ok: true }) }; },
    { onMutation: event => { events.push(event); if (event.phase === "settled") throw Error("observer failure"); } });
  await api("/read"); await api("/save", { method: "POST" });
  await assert.rejects(api("/failure", { method: "DELETE" }), /offline/);
  assert.deepEqual(events.map(event => [event.path, event.phase]), [["/save", "started"], ["/save", "settled"], ["/failure", "started"], ["/failure", "settled"]]);
});
const response = data => ({ ok: true, json: async () => data });
test("coalesces concurrent safe GETs and clears them after completion", async () => {
  let calls = 0, resolve;
  const api = createApiClient(() => { calls++; return new Promise(done => { resolve = done; }); });
  const first = api("/status"), second = api("/status");
  assert.equal(calls, 1); resolve(response({ ready: true }));
  assert.deepEqual(await first, await second);
  const next = api("/status"); assert.equal(calls, 2); resolve(response({ ready: false })); await next;
});
test("caller cancellation and timeout both work, with no cross-cancellation", async () => {
  const signals = [];
  const api = createApiClient((_path, { signal }) => new Promise((_resolve, reject) => {
    signals.push(signal); signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  }));
  const controller = new AbortController();
  const one = api("/same", { signal: controller.signal, timeout: 1000 });
  const two = api("/same", { signal: new AbortController().signal, timeout: 10 });
  assert.equal(signals.length, 2); controller.abort();
  await assert.rejects(one, { name: "AbortError" }); assert.equal(signals[1].aborted, false);
  await assert.rejects(two, /too long/);
});
test("request-only options do not reach fetch and errors preserve status", async () => {
  const api = createApiClient(async (_path, options) => {
    assert.equal(options.dedupe, undefined); assert.equal(options.timeout, undefined);
    assert.equal(options.body, '{"example":1}');
    return { ok: false, status: 409, json: async () => ({ error: "Busy" }) };
  });
  await assert.rejects(api("/save", { method: "PATCH", timeout: 1000, dedupe: false, body: { example: 1 } }), { message: "Busy", status: 409 });
});
test("timeout and cancellation during body streaming never resolve as an empty success", async () => {
  for (const external of [false, true]) {
    const controller = new AbortController();
    const api = createApiClient(async (_path, { signal }) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Body aborted", "AbortError")), { once: true });
      if (external) controller.abort();
    }) }));
    await assert.rejects(api("/stream", { timeout: external ? 1000 : 5, signal: controller.signal }), external ? { name: "AbortError" } : /too long/);
  }
});
