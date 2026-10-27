import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import vm from "node:vm";
import { createDailyPlannerReminders, isTrustedPlannerSender } from "../desktop/daily-planner-reminders.mjs";

const reminder = { id: "2026-09-22:start", date: "2026-09-22", kind: "start", title: "Time to plan today", body: "Add today's tasks in Argus." };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function harness(overrides = {}) {
  const calls = [], notifications = [], errors = [], intervals = new Map(), timeouts = new Map();
  let nextTimer = 1, opened = 0;
  const state = { supported: true, enabled: true, reminders: [reminder], delivery: "show", ackFailures: 0 };
  const worker = createDailyPlannerReminders({
    baseUrl: "http://127.0.0.1:4173",
    isSupported: () => state.supported,
    getHeaders: () => ({ authorization: "Bearer fixture-only" }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST") {
        if (state.ackFailures-- > 0) return { ok: false, status: 503 };
        return { ok: true };
      }
      return { ok: true, json: async () => ({ settings: { remindersEnabled: state.enabled }, notifications: state.reminders }) };
    },
    createNotification: options => {
      const notification = new EventEmitter();
      notification.options = options;
      notification.show = () => { if (state.delivery !== "pending") notification.emit(state.delivery); };
      notification.close = () => { notification.closed = true; notification.emit("close"); };
      notifications.push(notification);
      return notification;
    },
    onOpenPlanner: () => { opened++; },
    onError: error => errors.push(error.message),
    setIntervalImpl: callback => { const id = nextTimer++; intervals.set(id, callback); return id; },
    clearIntervalImpl: id => intervals.delete(id),
    setTimeoutImpl: callback => { const id = nextTimer++; timeouts.set(id, callback); return id; },
    clearTimeoutImpl: id => timeouts.delete(id),
    ...overrides,
  });
  return { worker, state, calls, notifications, errors, intervals, timeouts, opened: () => opened };
}

test("native planner requires explicit reminder opt-in and a supported operating system", async () => {
  for (const enabled of [false, undefined, "true"]) {
    const h = harness(); h.state.enabled = enabled;
    h.worker.start(); await h.worker.poll(); h.worker.stop();
    assert.equal(h.notifications.length, 0);
    assert.equal(h.calls.filter(call => call.options.method === "POST").length, 0);
  }
  const h = harness(); h.state.supported = false;
  h.worker.start(); await h.worker.poll(); h.worker.stop();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.worker.status(), { supported: false, appMustBeRunning: true, permission: "system-controlled", lastDeliveryError: null });
});

test("a delivered native notification is acknowledged once and clicks open only the planner", async () => {
  const h = harness(); h.worker.start(); h.worker.start(); await h.worker.poll();
  assert.equal(h.intervals.size, 1);
  assert.equal(h.notifications.length, 1);
  assert.deepEqual(h.notifications[0].options, { title: reminder.title, body: reminder.body });
  assert.equal(h.calls[1].url, "http://127.0.0.1:4173/api/daily-planner/reminders/2026-09-22%3Astart/ack");
  assert.equal(h.calls[1].options.headers.authorization, "Bearer fixture-only");
  assert.equal(h.calls[1].options.redirect, "error");
  await h.worker.poll();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.calls.filter(call => call.options.method === "POST").length, 1);
  h.notifications[0].emit("click"); assert.equal(h.opened(), 1);
  h.worker.stop(); h.notifications[0].emit("click"); assert.equal(h.opened(), 1);
  assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 0);
});

test("unconfirmed or failed delivery never acknowledges a reminder and can retry", async () => {
  const h = harness(); h.state.delivery = "failed";
  h.worker.start(); await h.worker.poll();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].closed, true);
  assert.equal(h.calls.filter(call => call.options.method === "POST").length, 0);
  assert.match(h.worker.status().lastDeliveryError, /notification settings/);
  h.state.delivery = "show"; await h.worker.poll();
  assert.equal(h.notifications.length, 2);
  assert.equal(h.calls.filter(call => call.options.method === "POST").length, 1);
  assert.equal(h.worker.status().lastDeliveryError, null);
  h.worker.stop();
});

test("notification display timeout cleans listeners and leaves the backend reminder pending", async () => {
  const h = harness(); h.state.delivery = "pending";
  h.worker.start(); const pending = h.worker.poll(); await flush();
  assert.equal(h.timeouts.size, 1);
  [...h.timeouts.values()][0](); await pending;
  assert.equal(h.notifications[0].closed, true);
  assert.equal(h.notifications[0].listenerCount("show"), 0);
  assert.equal(h.calls.filter(call => call.options.method === "POST").length, 0);
  assert.match(h.worker.status().lastDeliveryError, /not confirmed/);
  h.worker.stop();
});

test("failed durable acknowledgment retries the acknowledgment without displaying again", async () => {
  const h = harness(); h.state.ackFailures = 2;
  h.worker.start(); await h.worker.poll(); await h.worker.poll(); await h.worker.poll(); await h.worker.poll();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.calls.filter(call => call.options.method === "POST").length, 3);
  assert.equal(h.errors.length, 2);
  h.worker.stop();
});

test("concurrent timer and resume polls share an in-flight fetch", async () => {
  const response = deferred(); let requests = 0;
  const h = harness({ fetchImpl: () => { requests++; return response.promise; } });
  h.worker.start(); const first = h.worker.poll(), second = h.worker.poll();
  [...h.intervals.values()][0]();
  assert.equal(first, second); assert.equal(requests, 1);
  response.resolve({ ok: true, json: async () => ({ settings: { remindersEnabled: false } }) });
  await first; h.worker.stop();
});

test("stopping aborts a pending fetch and never displays a late response", async () => {
  const response = deferred(); let signal;
  const h = harness({ fetchImpl: async (_url, options) => { signal = options.signal; return response.promise; } });
  h.worker.start(); const pending = h.worker.poll(); h.worker.stop();
  assert.equal(signal.aborted, true);
  response.resolve({ ok: true, json: async () => ({ settings: { remindersEnabled: true }, notifications: [reminder] }) });
  await pending;
  assert.equal(h.notifications.length, 0); assert.equal(h.intervals.size, 0);
  await h.worker.poll(); assert.equal(h.notifications.length, 0);
});

test("stopping while native delivery is pending closes it without acknowledging", async () => {
  const h = harness(); h.state.delivery = "pending";
  h.worker.start(); const pending = h.worker.poll(); await flush(); h.worker.stop(); await pending;
  assert.equal(h.notifications[0].closed, true);
  assert.equal(h.calls.filter(call => call.options.method === "POST").length, 0);
  assert.equal(h.timeouts.size, 0); assert.equal(h.errors.length, 0);
  h.state.delivery = "show"; h.worker.start(); await h.worker.poll();
  assert.equal(h.notifications.length, 2); h.worker.stop();
});

test("delivered reminder stays deduplicated after a cancelled quit restarts polling", async () => {
  const h = harness(); h.state.ackFailures = 1;
  h.worker.start(); await h.worker.poll(); h.worker.stop(); h.worker.start(); await h.worker.poll();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.calls.filter(call => call.options.method === "POST").length, 2);
  h.worker.stop();
});

test("malformed notification entries and payloads cannot trigger native content or arbitrary ACK paths", async () => {
  const h = harness(); h.state.reminders = [null, {}, { ...reminder, id: "../../reset" }, { ...reminder, id: "2026-09-22:unknown" },
    { ...reminder, title: "x".repeat(257) }, { ...reminder, body: "x".repeat(2_001) }, { ...reminder, title: "" }];
  h.worker.start(); await h.worker.poll(); assert.equal(h.notifications.length, 0);
  h.state.reminders = { bad: reminder }; await h.worker.poll(); assert.equal(h.notifications.length, 0);
  h.worker.stop();
});

test("backend outages and native constructor failures do not acknowledge or terminate polling", async () => {
  const h = harness({ fetchImpl: async () => { throw new Error("offline"); } });
  h.worker.start(); await h.worker.poll(); await h.worker.poll(); h.worker.stop();
  assert.equal(h.notifications.length, 0); assert.deepEqual(h.errors, ["offline", "offline"]);
  const broken = harness({ createNotification: () => { throw new Error("notification unavailable"); } });
  broken.worker.start(); await broken.worker.poll(); broken.worker.stop();
  assert.equal(broken.calls.filter(call => call.options.method === "POST").length, 0);
  assert.deepEqual(broken.errors, ["notification unavailable"]);
});

test("native delivery replay memory is bounded while newest IDs remain deduplicated", async () => {
  const h = harness({ maxRemembered: 2 });
  h.worker.start(); await h.worker.poll();
  for (const date of ["2026-09-23", "2026-09-24"]) {
    h.state.reminders = [{ ...reminder, id: `${date}:start` }]; await h.worker.poll();
  }
  await h.worker.poll(); assert.equal(h.notifications.length, 3);
  h.state.reminders = [reminder]; await h.worker.poll(); assert.equal(h.notifications.length, 4);
  h.worker.stop();
});

test("native status IPC trusts only the exact live main frame at the exact local origin", () => {
  const frame = { url: "http://127.0.0.1:4173/?argusBuild=fixture" };
  const contents = { mainFrame: frame }, window = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame }, origin = "http://127.0.0.1:4173";
  assert.equal(isTrustedPlannerSender(event, window, origin), true);
  assert.equal(isTrustedPlannerSender({ ...event, senderFrame: { ...frame } }, window, origin), false);
  assert.equal(isTrustedPlannerSender({ ...event, sender: {} }, window, origin), false);
  assert.equal(isTrustedPlannerSender(event, { ...window, isDestroyed: () => true }, origin), false);
  assert.equal(isTrustedPlannerSender(event, null, origin), false);
  for (const url of ["http://127.0.0.1:41730/", "http://127.0.0.1:4173.attacker.invalid/", "https://127.0.0.1:4173/", "file:///tmp/index.html", "invalid"]) {
    frame.url = url; assert.equal(isTrustedPlannerSender(event, window, origin), false);
  }
});

test("preload exposes no arbitrary native notification API and queues planner navigation until app subscribes", async () => {
  const ipc = new EventEmitter(), invocations = [];
  ipc.invoke = (...args) => { invocations.push(args); return Promise.resolve({ supported: true }); };
  let bridge;
  vm.runInNewContext(fs.readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "argusDesktop"); bridge = value; } }, ipcRenderer: ipc }),
    queueMicrotask,
  });
  assert.equal(bridge.showNotification, undefined);
  assert.equal((await bridge.getPlannerNotificationStatus()).supported, true);
  assert.deepEqual(invocations, [["argus:planner-notification-status"]]);
  ipc.emit("argus:open-daily-planner", {}, { path: "https://attacker.invalid" });
  const received = [], unsubscribe = bridge.onPlannerOpen(value => received.push(value.path));
  await flush(); assert.deepEqual(received, ["/daily-tasks"]);
  ipc.emit("argus:open-daily-planner"); assert.deepEqual(received, ["/daily-tasks", "/daily-tasks"]);
  unsubscribe(); ipc.emit("argus:open-daily-planner"); assert.equal(received.length, 2);
});

test("notification clicks focus existing windows without reloading draft-bearing editor state", () => {
  const source = fs.readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function openDailyPlanner() {");
  const functionSource = source.slice(start, source.indexOf("\n}", start) + 2);
  const calls = [], context = {
    quitting: false, resetScheduled: false, pendingPlannerOpen: false,
    mainWindow: { isDestroyed: () => false, isMinimized: () => true, restore: () => calls.push("restore"),
      show: () => calls.push("show"), focus: () => calls.push("focus"),
      webContents: { isLoadingMainFrame: () => false, send: (channel, payload) => calls.push([channel, payload.path]), loadURL: () => assert.fail("must not reload drafts") } },
    createWindow: () => calls.push("create"),
  };
  vm.createContext(context); vm.runInContext(functionSource, context); context.openDailyPlanner();
  assert.deepEqual(calls, ["restore", "show", "focus", ["argus:open-daily-planner", "/daily-tasks"]]);
  calls.length = 0; context.mainWindow = undefined; context.openDailyPlanner();
  assert.deepEqual(calls, ["create"]); assert.equal(context.pendingPlannerOpen, true);
  calls.length = 0; context.quitting = true; context.openDailyPlanner(); assert.deepEqual(calls, []);
  assert.match(source, /pendingPlannerOpen \? "&openDailyPlanner=1"/);
  assert.match(source, /powerMonitor\.on\("resume"/);
  assert.match(source, /async function drainBackend\(\) \{\s*plannerReminders\?\.stop\(\);/);
});
