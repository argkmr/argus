import test from "node:test";
import assert from "node:assert/strict";
import { createIdeProcessLogs } from "../public/ide-process-logs.mjs";

const repository = { id: "repo-a", name: "API" };
const configuration = { id: "config-a", repositoryId: repository.id, name: "API service" };
const process = (status = "running", overrides = {}) => ({ id: "process/a", repositoryId: repository.id, configurationId: configuration.id, status, ...overrides });
const entry = (line, stream = "stdout") => ({ timestamp: "2026-09-19T10:20:30Z", stream, line });
const response = (cursor, logs = [], status = "running", dropped = 0) => ({ cursor, logs, status, dropped });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; this.hidden = false; this.textContent = ""; this.className = ""; this.clientHeight = 40; this.offsetHeight = 20; this.scrollLeft = 0; this._scrollTop = 0; this.replacements = 0; }
  set innerHTML(_) { throw new Error("Process output must only be written as plain text"); }
  get scrollHeight() { return this.children.reduce((sum, child) => sum + child.offsetHeight, 0); }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(value) { this._scrollTop = Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight))); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.replacements++; for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name) { for (const fn of this.listeners.get(name) || []) fn({ target: this }); }
  click() { if (!this.disabled) this.emit("click"); }
}
function walk(root) { return root.children.flatMap(child => [child, ...walk(child)]); }
function harness(api = async () => response(0), onChange, options = {}) {
  const document = { createElement: tag => new Element(tag) }, container = document.createElement("div"), calls = [], copies = [];
  const controller = createIdeProcessLogs({ document, container, api: (path, options) => { calls.push({ path, options }); return api(path, options); }, onChange,
    clipboard: { writeText: async text => { copies.push(text); } }, ...options });
  const byClass = name => walk(container).find(node => node.className.split(" ").includes(`repository-ide-process-logs${name ? `-${name}` : ""}`));
  const button = label => walk(container).find(node => node.tagName === "BUTTON" && node.getAttribute("aria-label") === label);
  const activate = (extra = {}) => controller.setContext({ repository, configuration, process: process(), visible: true, ...extra });
  return { document, container, controller, calls, copies, byClass, button, activate };
}

const copyLabel = "Copy all available process logs";

test("Copy all reads all retained logs, including display-trimmed and locally cleared output", async () => {
  const logs = Array.from({ length: 2000 }, (_, i) => entry(`line ${i} ${"x".repeat(60)}`));
  const h = harness(() => response(2000, logs));
  assert.equal(h.button(copyLabel).disabled, true);
  h.activate(); await flush();
  assert.ok(h.controller.state.entries.length < 2000);
  h.controller.clear();
  assert.equal(h.button(copyLabel).disabled, false);
  h.button(copyLabel).click(); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].path, "/api/processes/process%2Fa/logs?after=0");
  assert.equal(h.calls[1].options.cache, "no-store"); assert.equal(h.calls[1].options.dedupe, false);
  assert.equal(h.calls[1].options.method, undefined);
  assert.equal(h.copies.length, 1); assert.equal(h.copies[0].split("\n").length, 2000);
  assert.ok(h.copies[0].length > 80_000);
  assert.ok(h.copies[0].startsWith("10:20:30 line 0 ")); assert.ok(h.copies[0].includes("10:20:30 line 1999 "));
  assert.equal(h.controller.state.cursor, 2000); assert.deepEqual(h.controller.state.entries, []);
  assert.equal(h.byClass("copy-feedback").textContent, "Copied 2000 log entries.");
  assert.equal(h.byClass("copy-feedback").getAttribute("role"), "status");
  h.controller.dispose();
});

test("Copy all preserves plain-text timestamp/stream order and warns about unavailable history", async () => {
  const h = harness(() => response(10, [entry("\x1b[31mred\x1b[0m"), entry("<script>plain</script>\nnext", "stderr"), entry("\x1b]52;hidden\x07started\x00", "system")], "failed", 7));
  h.activate({ process: process("failed") }); await flush(); h.button(copyLabel).click(); await flush();
  assert.equal(h.copies[0], "[Argus: 7 earlier log entries are no longer available. This is all retained output.]\n10:20:30 red\n10:20:30 ERR <script>plain</script>\nnext\n10:20:30 SYS started");
  assert.match(h.byClass("copy-feedback").textContent, /Copied 3 log entries\. 7 earlier entries were no longer available/);
  h.controller.dispose();
});

test("Copy all takes a fresh snapshot without advancing cursor or changing scroll/follow state", async () => {
  let reads = 0;
  const h = harness(() => ++reads === 1 ? response(10, Array.from({ length: 10 }, (_, i) => entry(String(i)))) : response(11, [entry("fresh snapshot")]));
  h.activate(); await flush();
  const output = h.byClass("output"); output.scrollTop = 20; output.scrollLeft = 40; output.emit("scroll");
  const before = h.controller.state;
  h.button(copyLabel).click(); await flush();
  assert.deepEqual(h.controller.state, before); assert.equal(output.scrollTop, 20); assert.equal(output.scrollLeft, 40);
  assert.equal(h.copies[0], "10:20:30 fresh snapshot");
  h.controller.dispose();
});

test("copy requests are deduplicated and copying shows a busy state", async () => {
  const pending = deferred(); let reads = 0;
  const h = harness(() => ++reads === 1 ? response(1, [entry("ready")]) : pending.promise);
  h.activate(); await flush(); h.button(copyLabel).click(); h.button(copyLabel).click();
  assert.equal(h.button(copyLabel).disabled, true); assert.equal(h.button(copyLabel).textContent, "Copying…");
  assert.equal(h.calls.length, 2);
  pending.resolve(response(1, [entry("ready")])); await flush();
  assert.equal(h.copies.length, 1); assert.equal(h.button(copyLabel).disabled, false);
  h.controller.dispose();
});

test("stale copies are aborted before clipboard writes on repo/process change, hide or disposal", async () => {
  for (const change of [h => h.controller.setContext({ process: process("running", { id: "new-process" }) }),
    h => h.controller.setContext({ repository: { id: "repo-b" } }),
    h => h.controller.setContext({ visible: false }), h => h.controller.dispose()]) {
    const pending = deferred(); let reads = 0;
    const h = harness(() => ++reads === 2 ? pending.promise : response(1, [entry("ready")]));
    h.activate(); await flush(); h.button(copyLabel).click(); change(h);
    assert.equal(h.calls[1].options.signal.aborted, true);
    pending.resolve(response(1, [entry("stale copy")])); await flush();
    assert.deepEqual(h.copies, []);
    if (h.container.children.length) assert.equal(h.byClass("copy-feedback").textContent, "");
    h.controller.dispose();
  }
});

test("copy failures are independent of polling and can be retried", async () => {
  let reads = 0;
  const h = harness(() => { if (++reads === 2) throw new Error("offline"); return response(1, [entry("saved")]); });
  h.activate(); await flush(); h.button(copyLabel).click(); await flush();
  assert.deepEqual(h.copies, []); assert.equal(h.controller.state.error, "");
  assert.equal(h.byClass("copy-feedback").dataset.state, "error");
  assert.match(h.byClass("copy-feedback").textContent, /Could not copy logs/);
  h.button(copyLabel).click(); await flush();
  assert.equal(h.copies[0], "10:20:30 saved"); assert.equal(h.byClass("copy-feedback").textContent, "Copied 1 log entry.");
  h.controller.dispose();
});

test("clipboard rejection or absence never reports a successful copy", async () => {
  for (const clipboard of [null, { writeText: async () => { throw new Error("denied"); } }]) {
    const h = harness(() => response(1, [entry("saved")]), undefined, { clipboard });
    h.activate(); await flush(); h.button(copyLabel).click(); await flush();
    assert.deepEqual(h.copies, []); assert.match(h.byClass("copy-feedback").textContent, /Could not copy logs/);
    assert.equal(h.button(copyLabel).disabled, false); assert.equal(h.controller.state.entries[0].line, "saved");
    h.controller.dispose();
  }
});

test("empty or invalid exports leave clipboard intact", async () => {
  for (const result of [response(1), { cursor: -1, logs: [entry("invalid")] }, { cursor: 1, logs: null }, response(1, [entry("invalid")], "running", -1)]) {
    let reads = 0; const h = harness(() => ++reads === 1 ? response(1, [entry("saved")]) : result);
    h.activate(); await flush(); h.button(copyLabel).click(); await flush();
    assert.deepEqual(h.copies, []);
    assert.match(h.byClass("copy-feedback").textContent, result.logs?.length === 0 ? /No logs available/ : /Could not copy logs/);
    h.controller.dispose();
  }
});

test("late clipboard completion cannot change the new process feedback", async () => {
  const pending = deferred();
  const h = harness(() => response(1, [entry("saved")]), undefined, { clipboard: { writeText: () => pending.promise } });
  h.activate(); await flush(); h.button(copyLabel).click(); await flush();
  h.controller.setContext({ process: process("running", { id: "new-process" }) }); await flush();
  pending.resolve(); await flush();
  assert.equal(h.byClass("copy-feedback").textContent, ""); assert.equal(h.button(copyLabel).textContent, "Copy all");
  h.controller.dispose();
});

test("logs are idle until visible and read only the selected Services process", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(async () => response(2, [entry("build started", "system"), entry("listening")]));
  h.activate({ visible: false }); await h.controller.refresh(); t.mock.timers.tick(10_000); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.byClass("").hidden, true);
  h.controller.setContext({ visible: true }); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, "/api/processes/process%2Fa/logs?after=0");
  assert.equal(h.calls[0].options.method, undefined); assert.equal(h.calls[0].options.dedupe, false); assert.equal(h.calls[0].options.cache, "no-store");
  assert.ok(h.calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["build started", "listening"]);
  assert.equal(h.byClass("output").getAttribute("role"), "log");
  assert.equal(h.byClass("output").getAttribute("aria-live"), "off");
  h.controller.dispose();
});

test("visible polling and manual refresh never overlap, and hidden contexts stop immediately", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(); const h = harness(() => pending.promise);
  h.activate(); await flush();
  const first = h.controller.refresh(), second = h.controller.refresh(); assert.equal(first, second);
  t.mock.timers.tick(10_000); await flush(); assert.equal(h.calls.length, 1);
  h.controller.setContext({ visible: false }); assert.equal(h.calls[0].options.signal.aborted, true);
  pending.resolve(response(1, [entry("hidden stale output")])); await first;
  t.mock.timers.tick(10_000); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.controller.state.cursor, 0); assert.deepEqual(h.controller.state.entries, []);
  h.controller.dispose();
});

test("repository and process changes discard stale reads and serialize even abort-ignoring APIs", async () => {
  const pending = deferred(); const h = harness(path => path.includes("process%2Fa") ? pending.promise : response(1, [entry("other process")]));
  h.activate(); await flush();
  const otherRepository = { id: "repo-b", name: "Other" }, otherConfiguration = { id: "config-b", repositoryId: "repo-b", name: "Worker" };
  h.activate({ repository: otherRepository, configuration: otherConfiguration, process: process("running", { id: "process-b", repositoryId: "repo-b", configurationId: "config-b" }) });
  await flush(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.signal.aborted, true);
  pending.resolve(response(90, [entry("wrong repository")])); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].path, "/api/processes/process-b/logs?after=0");
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["other process"]); assert.equal(h.controller.state.cursor, 1);
  assert.match(h.byClass("identity").textContent, /^Worker · process-b$/);
  h.controller.dispose();
});

test("an unrelated process never leaks across configuration/repository boundaries; maintenance is supported", async () => {
  const h = harness();
  h.activate({ process: process("running", { configurationId: "some-other-configuration" }) }); await flush(); assert.equal(h.calls.length, 0);
  h.activate({ process: process("running", { repositoryId: "repo-b" }) }); await flush(); assert.equal(h.calls.length, 0);
  h.activate({ process: process("syncing", { configurationId: "repository:repo-a" }) }); await flush(); assert.equal(h.calls.length, 1);
  h.controller.setContext({ repository: { id: "repo-b" } }); await flush();
  assert.equal(h.controller.state.process, null); assert.equal(h.controller.state.configuration, null); assert.deepEqual(h.controller.state.entries, []);
  h.controller.dispose();
});

test("output is available before debugger attachment and newest failed process resets the cursor", async () => {
  const h = harness(path => path.includes("failed") ? response(1, [entry("Build failed", "stderr")], "failed") : response(2, [entry("Compiling", "system"), entry("Debugger listening")]));
  h.activate({ process: process("starting", { debug: { state: "starting" } }) }); await flush();
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["Compiling", "Debugger listening"]);
  h.controller.setContext({ process: process("failed", { id: "failed", exitCode: 1 }) }); await flush();
  assert.equal(h.calls[1].path, "/api/processes/failed/logs?after=0");
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["Build failed"]);
  assert.equal(h.byClass("status").textContent, "Failed · exit 1");
  assert.equal(h.byClass("output").children[0].dataset.stream, "stderr");
  h.controller.dispose();
});

test("terminal processes drain through quiet reads, retaining final output and stopping idle polls", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const results = [response(1, [entry("last stdout")], "exited"), response(2, [entry("last stderr", "stderr")], "exited"), response(2, [], "exited"), response(2, [], "exited")];
  const h = harness(() => results.shift()); h.activate({ process: process("exited", { exitCode: 0 }) }); await flush();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.equal(h.controller.state.complete, true); assert.equal(h.calls.length, 4);
  t.mock.timers.tick(10_000); await flush(); assert.equal(h.calls.length, 4);
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["last stdout", "last stderr"]);
  h.controller.dispose();
});

test("a process exit arriving during an active request forces a final read without waiting for the timer", async () => {
  const pending = deferred(); let reads = 0;
  const h = harness(() => ++reads === 1 ? pending.promise : response(2, [entry("final stderr", "stderr")], "stopped"));
  h.activate(); await flush();
  h.controller.setContext({ process: process("stopped", { exitCode: 0 }) });
  pending.resolve(response(1, [entry("older stdout")], "running")); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].path, "/api/processes/process%2Fa/logs?after=1");
  assert.equal(h.controller.state.status, "stopped");
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["older stdout", "final stderr"]);
  h.controller.dispose();
});

test("monotonic cursors continue beyond backend retention and explain missing history", async () => {
  const results = [response(2100, [entry("retained")], "running", 2099), response(2101, [entry("new output")])];
  const h = harness(() => results.shift()); h.activate(); await flush(); await h.controller.refresh();
  assert.equal(h.calls[1].path, "/api/processes/process%2Fa/logs?after=2100");
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["retained", "new output"]);
  assert.equal(h.controller.state.dropped, 2099); assert.match(h.byClass("notice").textContent, /2099 earlier log entries/);
  h.controller.dispose();
});

test("errors preserve output, retry at the same cursor, and never issue process mutations", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const h = harness(() => { if (++reads === 2) throw new Error("network unavailable"); return reads === 1 ? response(1, [entry("saved")]) : response(2, [entry("recovered")]); });
  h.activate(); await flush(); t.mock.timers.tick(1000); await flush();
  assert.equal(h.controller.state.error, "network unavailable"); assert.equal(h.byClass("error").hidden, false);
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["saved"]);
  h.button("Retry loading process output").click(); await flush();
  assert.equal(h.calls[1].path, h.calls[2].path); assert.equal(h.controller.state.error, ""); assert.equal(h.byClass("error").hidden, true);
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["saved", "recovered"]);
  assert.ok(h.calls.every(call => call.path.startsWith("/api/processes/") && call.path.includes("/logs?") && !call.options.method));
  h.controller.dispose();
});

test("automatic retries keep terminal log failures recoverable", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let reads = 0;
  const h = harness(() => { if (++reads === 1) throw new Error("offline"); return response(1, [entry("failure details", "stderr")], "failed"); });
  h.activate({ process: process("failed") }); await flush(); t.mock.timers.tick(1000); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.controller.state.error, ""); assert.equal(h.controller.state.entries[0].line, "failure details"); h.controller.dispose();
});

test("clearing is local, retains the cursor, and consumes old in-flight output without repopulating it", async () => {
  const pending = deferred(); let reads = 0;
  const h = harness(() => ++reads === 1 ? response(1, [entry("old")]) : reads === 2 ? pending.promise : response(3, [entry("new after clear")]));
  h.activate(); await flush(); const refreshing = h.controller.refresh(); await flush();
  h.button("Clear displayed process output locally").click(); assert.deepEqual(h.controller.state.entries, []);
  pending.resolve(response(2, [entry("old in flight")])); await refreshing;
  assert.deepEqual(h.controller.state.entries, []); assert.equal(h.controller.state.cursor, 2); assert.match(h.byClass("notice").textContent, /cleared locally/);
  await h.controller.refresh(); assert.equal(h.calls[2].path, "/api/processes/process%2Fa/logs?after=2");
  assert.deepEqual(h.controller.state.entries.map(item => item.line), ["new after clear"]); assert.ok(h.calls.every(call => !call.options.method)); h.controller.dispose();
});

test("the buffer is bounded by entries and characters, strips terminal escapes, and renders HTML as text", async () => {
  const logs = Array.from({ length: 1201 }, (_, i) => entry(`line ${i}`));
  let reads = 0; const h = harness(() => ++reads === 1 ? response(logs.length, logs) : response(logs.length + 1, [entry("\x1b]8;;https://example.invalid\x07<script>plain text</script>\x1b]8;;\x07\x1b[31m" + "x".repeat(90_000) + "\x1b[0m\x00", "stderr")]));
  h.activate(); await flush(); assert.equal(h.controller.state.entries.length, 1200); assert.equal(h.controller.state.entries[0].line, "line 1");
  assert.equal(h.byClass("output").children.length, 1200); assert.equal(h.controller.state.discarded, true);
  await h.controller.refresh(); assert.equal(h.controller.state.entries.length, 1); assert.equal(h.controller.state.entries[0].line.length, 80_000);
  assert.equal(h.controller.state.entries[0].line, "x".repeat(80_000)); assert.match(h.byClass("notice").textContent, /trimmed/);
  h.controller.dispose();
  const safe = harness(() => response(1, [entry("\x1b]8;;https://example.invalid\x1b\\<script>plain text</script>\x1b]8;;\x1b\\\x1b[31m red\x1b[0m\x1bPsecret\x1b\\\x00")]));
  safe.activate(); await flush(); assert.equal(safe.controller.state.entries[0].line, "<script>plain text</script> red");
  assert.equal(safe.byClass("output").children[0].textContent, "10:20:30 <script>plain text</script> red"); safe.controller.dispose();
});

test("polling appends rows without resetting older reading positions or horizontal scroll", async () => {
  let reads = 0; const h = harness(() => ++reads === 1 ? response(10, Array.from({ length: 10 }, (_, i) => entry(String(i)))) : response(10 + reads - 1, [entry(`new ${reads}`)]));
  h.activate(); await flush(); const output = h.byClass("output"), firstRow = output.children[0], replacements = output.replacements;
  assert.equal(output.scrollTop, 160); assert.equal(h.controller.state.following, true);
  output.scrollTop = 40; output.scrollLeft = 18; output.emit("scroll"); assert.equal(h.controller.state.following, false);
  await h.controller.refresh(); assert.equal(output.scrollTop, 40); assert.equal(output.scrollLeft, 18); assert.equal(output.children[0], firstRow); assert.equal(output.replacements, replacements);
  h.button("Follow process output").click(); assert.equal(output.scrollTop, 180); assert.equal(h.controller.state.following, true);
  await h.controller.refresh(); assert.equal(output.scrollTop, 200); h.controller.dispose();
});

test("trimming rows preserves the same older reading position when it is still retained", async () => {
  let reads = 0; const h = harness(() => ++reads === 1 ? response(1200, Array.from({ length: 1200 }, (_, i) => entry(String(i)))) : response(1201, [entry("latest")]));
  h.activate(); await flush(); const output = h.byClass("output"); output.scrollTop = 200; output.emit("scroll");
  const anchoredRow = output.children[10]; await h.controller.refresh();
  assert.equal(output.scrollTop, 180); assert.equal(output.children[9], anchoredRow); assert.equal(h.controller.state.following, false); h.controller.dispose();
});

test("invalid responses retain cursor/output; observer errors cannot break polling", async () => {
  let reads = 0; const h = harness(() => ++reads === 1 ? response(2, [entry("retained")]) : response(1, [entry("invalid rollback")]), () => { throw new Error("observer failed"); });
  h.activate(); await flush(); await h.controller.refresh();
  assert.equal(h.controller.state.cursor, 2); assert.deepEqual(h.controller.state.entries.map(item => item.line), ["retained"]); assert.match(h.controller.state.error, /invalid process log response/); h.controller.dispose();
});

test("dispose aborts requests, removes handlers, and blocks all future work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const pending = deferred(), h = harness(() => pending.promise);
  h.activate(); await flush(); const output = h.byClass("output"), follow = h.button("Follow process output"); h.controller.dispose(); h.controller.dispose();
  assert.equal(h.calls[0].options.signal.aborted, true); assert.equal(output.listeners.get("scroll").size, 0); assert.equal(follow.listeners.get("click").size, 0); assert.equal(h.container.children.length, 0);
  pending.resolve(response(1, [entry("late")])); await flush(); h.activate(); await h.controller.refresh(); t.mock.timers.tick(10_000); await flush(); assert.equal(h.calls.length, 1);
});
