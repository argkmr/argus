import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { formatProcessLogEntry, formatProcessLogSnapshot } from "../public/process-log-format.mjs";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const markup = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const entry = (line, stream = "stdout") => ({ timestamp: "2026-09-23T10:20:30Z", stream, line });
const result = (logs = [entry("displayed")], cursor = logs.length, dropped = 0) => ({ logs, cursor, dropped });
const process = (id = "process/a", configurationId = "config") => ({ id, configurationId, startedAt: "2026-09-23T10:20:30Z" });

function harness({ clipboard } = {}) {
  const elements = new Map(), calls = [], copies = [], timers = new Map(), warnings = [];
  const state = { logEpoch: 0, logCursor: 0, logTimer: null, logRequest: null, logCopyRequest: null, activeLogProcessId: null, activeLogConfigurationId: null };
  let serial = 0, respond = path => path === "/api/processes" ? [process()] : result();
  function element(key) {
    if (!elements.has(key)) {
      const classes = new Set(key === "#log-console" ? ["hidden"] : []);
      elements.set(key, { textContent: "", disabled: false, dataset: {}, scrollTop: 17, scrollLeft: 23,
        classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
          toggle(name, active) { if (active ?? !classes.has(name)) classes.add(name); else classes.delete(name); } } });
    }
    return elements.get(key);
  }
  const context = vm.createContext({ state, $: element, AbortController, formatProcessLogEntry, formatProcessLogSnapshot,
    navigator: { clipboard: clipboard === undefined ? { writeText: async text => copies.push(text) } : clipboard },
    api: (path, options) => { calls.push({ path, options }); return respond(path, options); },
    setInterval: callback => { const id = ++serial; timers.set(id, callback); return id; }, clearInterval: id => timers.delete(id),
    console: { warn: (...args) => warnings.push(args) },
    captureLiveScroll: () => ({}), restoreLiveScroll() {},
  });
  vm.runInContext(["serviceLogsVisible", "renderServiceLogCopy", "serviceLogCopyFeedback", "cancelServiceLogCopy", "closeServiceLogs", "copyAllServiceLogs", "showLogs"].map(declaration).join("\n"), context);
  return { context, state, calls, copies, timers, warnings, element, respond: callback => { respond = callback; },
    open: (id = "process/a", configuration = "config") => context.showLogs(id, "API", configuration),
    tick: () => timers.get(state.logTimer)?.(), copy: () => context.copyAllServiceLogs(), close: () => context.closeServiceLogs() };
}

test("Services exposes accessible Copy all logs and invalidates the console when navigating away", () => {
  assert.match(markup, /id="copy-service-logs"[^>]*type="button"[^>]*disabled>Copy all logs/);
  assert.match(markup, /id="log-copy-feedback"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source, /\$\("#copy-service-logs"\)\.addEventListener\("click", copyAllServiceLogs\)/);
  assert.match(source, /\$\("#close-logs"\)\.addEventListener\("click", closeServiceLogs\)/);
  assert.match(declaration("switchPrimaryView"), /view !== "services"[^\n]*closeServiceLogs\(\)/);
});

test("copy exports the complete fresh retained snapshot, not displayed text or its cursor", async () => {
  const h = harness(); await h.open();
  h.element("#log-output").textContent = "locally trimmed output";
  h.state.logCursor = 999;
  const large = "retained ".repeat(12_000);
  h.respond(() => result([entry(large), entry("\x1b[31merror\x1b[0m\nnext", "stderr"), entry("<b>system</b>\x1b]0;secret\x07", "system")], 1203, 1200));
  await h.copy();
  const copyRead = h.calls.at(-1);
  assert.equal(copyRead.path, "/api/processes/process%2Fa/logs?after=0");
  assert.equal(copyRead.options.dedupe, false); assert.equal(copyRead.options.cache, "no-store");
  assert.ok(copyRead.options.signal instanceof AbortSignal);
  assert.equal(h.copies[0], `[Argus: 1200 earlier log entries are no longer available. This is all retained output.]\n10:20:30 ${large}\n10:20:30 ERR error\nnext\n10:20:30 SYS <b>system</b>`);
  assert.match(h.element("#log-copy-feedback").textContent, /Copied 3 log entries\. 1200 earlier entries were no longer available/);
  assert.equal(h.state.logCursor, 999); assert.equal(h.element("#log-output").textContent, "locally trimmed output");
  assert.equal(h.element("#log-output").scrollTop, 17); assert.equal(h.element("#log-output").scrollLeft, 23);
  assert.equal(h.element("#copy-service-logs").disabled, false);
  assert.ok(h.calls.every(call => call.options?.method === undefined));
});

test("duplicate copy clicks coalesce and expose a busy state", async () => {
  const h = harness(); await h.open(); const pending = deferred(); h.respond(() => pending.promise);
  const copying = h.copy(); await h.copy();
  assert.equal(h.calls.length, 3); assert.equal(h.element("#copy-service-logs").textContent, "Copying…");
  assert.equal(h.element("#copy-service-logs").disabled, true);
  pending.resolve(result([entry("saved")])); await copying;
  assert.deepEqual(h.copies, ["10:20:30 saved"]); assert.equal(h.element("#copy-service-logs").textContent, "Copy all logs");
});

test("closed, hidden and changed process panels cannot copy stale snapshots", async () => {
  for (const change of [h => h.close(), h => h.element("#services-drawer").classList.add("hidden"), h => { h.state.activeLogProcessId = "other-process"; }]) {
    const h = harness(); await h.open(); const pending = deferred(); h.respond(() => pending.promise);
    const copying = h.copy(); change(h); pending.resolve(result([entry("stale")])); await copying;
    assert.deepEqual(h.copies, []); assert.equal(h.element("#log-copy-feedback").textContent, "");
  }
  const h = harness(); await h.open(); const pending = deferred(); h.respond(() => pending.promise);
  const copying = h.copy(), oldSignal = h.calls.at(-1).options.signal;
  h.close(); h.respond(path => path === "/api/processes" ? [process()] : result()); await h.open();
  assert.equal(oldSignal.aborted, true); pending.resolve(result([entry("old same-process copy")])); await copying;
  assert.deepEqual(h.copies, []); assert.equal(h.element("#copy-service-logs").disabled, false);
});

test("automatic newest-process selection cancels an old copy and resets feedback", async () => {
  const h = harness(); await h.open(); const pending = deferred();
  h.respond(path => path === "/api/processes" ? [process("new-process")] : path.includes("process%2Fa") ? pending.promise : result([entry("new run")]));
  const copying = h.copy(), signal = h.calls.at(-1).options.signal;
  await h.tick(); assert.equal(signal.aborted, true); assert.equal(h.state.activeLogProcessId, "new-process");
  pending.resolve(result([entry("old run")])); await copying;
  assert.deepEqual(h.copies, []); assert.equal(h.element("#log-copy-feedback").textContent, "");
  await h.copy(); assert.deepEqual(h.copies, ["10:20:30 new run"]);
});

test("a late clipboard settlement cannot overwrite a reopened console's feedback", async () => {
  const pending = deferred();
  const h = harness({ clipboard: { writeText: () => pending.promise } }); await h.open();
  const copying = h.copy(); await flush(); h.close(); await h.open();
  pending.reject(new Error("late denial")); await copying;
  assert.equal(h.element("#log-copy-feedback").textContent, ""); assert.equal(h.element("#copy-service-logs").disabled, false);
});

test("API and clipboard failures are recoverable and leave the displayed output intact", async () => {
  for (const clipboard of [null, { writeText: async () => { throw new Error("denied"); } }]) {
    const h = harness({ clipboard }); await h.open(); const before = h.element("#log-output").textContent;
    await h.copy(); assert.match(h.element("#log-copy-feedback").textContent, /Could not copy logs/);
    assert.equal(h.element("#log-copy-feedback").dataset.state, "error");
    assert.equal(h.element("#copy-service-logs").disabled, false); assert.equal(h.element("#log-output").textContent, before);
  }
  const h = harness(); await h.open(); h.respond(() => { throw new Error("offline"); }); await h.copy();
  assert.match(h.element("#log-copy-feedback").textContent, /Could not copy logs/);
  h.respond(() => result([entry("recovered")])); await h.copy();
  assert.equal(h.element("#log-copy-feedback").textContent, "Copied 1 log entry.");
});

test("empty and malformed snapshots do not replace clipboard contents", async () => {
  for (const snapshot of [result([], 0), { cursor: -1, logs: [entry("bad")] }, { cursor: 1, logs: null }, result([entry("bad")], 1, -1)]) {
    const h = harness(); await h.open(); h.respond(() => snapshot); await h.copy();
    assert.deepEqual(h.copies, []); assert.equal(h.element("#copy-service-logs").disabled, false);
    assert.match(h.element("#log-copy-feedback").textContent, snapshot.logs?.length === 0 ? /No logs available/ : /Could not copy logs/);
  }
  const h = harness(); await h.copy(); assert.equal(h.calls.length, 0);
});

test("closing during the first poll never resurrects the console or its interval", async () => {
  const h = harness(), pending = deferred(); h.respond(() => pending.promise);
  const opening = h.open(), signal = h.calls[0].options.signal;
  h.close(); pending.resolve([process()]); await opening;
  assert.equal(signal.aborted, true); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  assert.equal(h.element("#log-console").classList.contains("hidden"), true);
  assert.equal(h.state.activeLogProcessId, null);
});

test("stale incremental log reads do not overwrite a newer panel, and polls do not overlap", async () => {
  const h = harness(), pending = deferred();
  h.respond(path => path === "/api/processes" ? [process()] : pending.promise);
  const oldOpening = h.open(); await flush(); const oldSignal = h.calls.at(-1).options.signal;
  h.respond(path => path === "/api/processes" ? [process("new-process", "new-config")] : result([entry("new process")]));
  await h.open("new-process", "new-config"); pending.resolve(result([entry("old response")], 99)); await oldOpening;
  assert.equal(oldSignal.aborted, true); assert.equal(h.state.logCursor, 1); assert.equal(h.timers.size, 1);
  assert.equal(h.element("#log-output").textContent, "10:20:30 new process\n");
  const busy = deferred(); h.respond(() => busy.promise); const polling = h.tick(); const count = h.calls.length;
  await h.tick(); assert.equal(h.calls.length, count); h.close(); busy.resolve([]); await polling;
  assert.equal(h.timers.size, 0); assert.equal(h.warnings.length, 0);
});

test("a process-list request from before a service action cannot restore its old process", async () => {
  const h = harness(); await h.open(); const pending = deferred(); h.respond(() => pending.promise);
  const polling = h.tick();
  h.context.cancelServiceLogCopy(); h.state.activeLogProcessId = null; h.state.logCursor = 0;
  const count = h.calls.length;
  pending.resolve([process()]); await polling;
  assert.equal(h.state.activeLogProcessId, null); assert.equal(h.calls.length, count);
  h.respond(path => path === "/api/processes" ? [process("restarted")] : result([entry("restarted output")]));
  await h.tick(); assert.equal(h.state.activeLogProcessId, "restarted");
  await h.copy(); assert.deepEqual(h.copies, ["10:20:30 restarted output"]);
});
