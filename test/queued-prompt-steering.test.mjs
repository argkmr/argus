import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { queuedSteeringState, queuedSteerButtonMarkup, acceptedSteeringMessage, createQueuedPromptSteering } from "../public/queued-prompt-steering.mjs";
import { queuedPromptButtons } from "../public/queued-prompt-editor.js";

const request = (id = "one", extra = {}) => ({ requestId: id, taskId: "task", repositoryId: "repo", providerId: "codex", status: "queued", prompt: "  Keep this exact prompt\n", promptNotes: [{ id: "note", text: "Keep note", enabled: true }], attachments: [{ id: "image" }], attachmentIds: ["image"], modelSettings: { model: "selected", effort: "high" }, ...extra });
const activeJob = (extra = {}) => ({ id: "job", taskId: "task", repositoryId: "repo", provider: "codex", status: "running", nativeTurnId: "turn", steering: { supported: true, available: true }, ...extra });
const acceptedTask = (requestId = "one", jobId = "job") => ({ id: "task", messages: [{ id: "saved-user", role: "user", status: "steered", content: "Already persisted", steering: { requestId, jobId, turnId: "turn", acceptedAt: "2026-10-13T00:00:00Z" } }] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness({ scope = "repository", api: handler, job: override, queue: items } = {}) {
  const repositoryId = scope === "global" ? "global" : "repo";
  const queue = items || [request("one", { repositoryId }), request("two", { repositoryId }), request("three", { repositoryId })];
  const job = activeJob({ repositoryId, ...override });
  const calls = [], changes = [], success = [], errors = [], held = new Set();
  let current = true;
  const api = async (url, options = {}) => {
    calls.push({ url, options: structuredClone(options) });
    if (handler) { const result = await handler(url, options); if (result !== undefined) return result; }
    if (url.endsWith("/steer")) return { accepted: true, requestId: url.split("/").at(-2), jobId: job.id, turnId: job.nativeTurnId, task: acceptedTask(url.split("/").at(-2)), queue: [] };
    if (url.endsWith("/steer/reconcile")) return { accepted: false, task: { id: "task", messages: [] }, queue: [] };
    if (url.startsWith("/api/prompt-queue?")) return queue.map(item => structuredClone(item));
    if (url.startsWith("/api/ai-tasks/")) return { id: "task", messages: [] };
    throw new Error("Unexpected request");
  };
  const controller = createQueuedPromptSteering({ api, getQueue: () => queue, getJob: () => job,
    hold: id => { if (held.has(id)) return null; held.add(id); return { release: () => held.delete(id) }; },
    isCurrent: () => current, onChange: value => changes.push(value), onSuccess: value => success.push(value), onError: value => errors.push(value) });
  return { controller, queue, job, calls, changes, success, errors, held, setCurrent: value => { current = value; }, run: id => controller.steer(scope, "task", id || "one") };
}

test("steering requires backend capability, exact chat/provider and active native turn", () => {
  assert.equal(queuedSteeringState(request(), activeJob()).available, true);
  for (const job of [null, activeJob({ taskId: "other" }), activeJob({ repositoryId: "other" }), activeJob({ steering: null })])
    assert.equal(queuedSteeringState(request(), job).visible, false);
  for (const job of [activeJob({ provider: "claude" }), activeJob({ nativeTurnId: "" }), activeJob({ status: "completed" }), activeJob({ completionPending: true }), activeJob({ steering: { supported: true, available: false, reason: "Waiting for tool" } })])
    assert.equal(queuedSteeringState(request(), job).available, false);
  for (const extra of [{ status: "interrupted" }, { recovered: true }, { pauseReason: "question" }])
    assert.equal(queuedSteeringState(request("one", extra), activeJob()).available, false);
});

test("compact accessible controls keep Edit/Delete and expose escaped availability help", () => {
  for (const scope of ["repository", "global"]) {
    const html = queuedPromptButtons(scope, 'task"<', request(), { job: activeJob() });
    assert.match(html, /Steer now/); assert.match(html, /Edit queued message/); assert.match(html, /Delete queued message/);
    assert.match(html, /data-queue-task="task&quot;&lt;"/); assert.match(html, /aria-disabled="false"/);
  }
  const disabled = queuedSteerButtonMarkup("global", "task", request(), { job: activeJob({ steering: { supported: true, available: false, reason: 'Wait <script>"' } }) });
  assert.match(disabled, /aria-disabled="true"/); assert.match(disabled, /Wait &lt;script&gt;&quot;/); assert.doesNotMatch(disabled, /<script>/);
  assert.match(queuedSteerButtonMarkup("global", "task", request(), { pending: true }), /Steering…/);
  assert.equal(queuedSteerButtonMarkup("global", "task", request()), "");
});

for (const scope of ["repository", "global"]) test(`${scope}: explicit steer sends exact CAS, preserves other queue order and does not touch composer/model`, async () => {
  const h = harness({ scope }); const originalOthers = h.queue.filter(item => item.requestId !== "two").map(item => structuredClone(item));
  await h.run("two");
  assert.equal(h.calls.length, 1); const { url, options } = h.calls[0];
  assert.equal(url, "/api/prompt-queue/two/steer"); assert.equal(options.method, "POST");
  assert.deepEqual(options.body, { taskId: "task", jobId: "job", expectedTurnId: "turn", expectedPrompt: "  Keep this exact prompt\n", expectedPromptNotes: [{ id: "note", text: "Keep note", enabled: true }] });
  assert.deepEqual(h.queue, originalOthers); assert.equal(h.success.length, 1); assert.equal(h.errors.length, 0); assert.equal(h.held.size, 0);
  assert.equal(h.changes.at(-1).task.messages.length, 1); assert.equal(h.changes.at(-1).task.messages[0].id, "saved-user");
  assert.equal(h.calls.some(call => /agents\/run|\/cancel|\/stop/.test(call.url) || call.options.method === "DELETE"), false);
});

test("the saved queue is default: rendering does not dispatch anything", () => {
  const h = harness(); queuedPromptButtons("repository", "task", h.queue[0], { job: h.job });
  assert.equal(h.calls.length, 0); assert.equal(h.queue.length, 3);
});

test("duplicate clicks and concurrent edit holds never duplicate steering", async () => {
  const pending = deferred(); const h = harness({ api: url => url.endsWith("/steer") ? pending.promise : undefined });
  const first = h.run(); await h.run(); assert.equal(h.calls.length, 1); assert.equal(h.controller.isPending("one"), true); assert.equal(h.held.has("one"), true);
  pending.resolve({ accepted: true, requestId: "one", jobId: "job", turnId: "turn", task: acceptedTask() }); await first;
  assert.equal(h.controller.isPending("one"), false); await h.run(); assert.equal(h.calls.length, 1);
  const editing = harness(); editing.held.add("one"); await editing.run(); assert.equal(editing.calls.length, 0);
});

test("unsupported or changed-chat actions keep everything untouched", async () => {
  for (const job of [{ provider: "claude" }, { nativeTurnId: "" }, { steering: { supported: true, available: false, reason: "Not ready" } }]) {
    const h = harness({ job }); const before = structuredClone(h.queue); await h.run(); assert.equal(h.calls.length, 0); assert.deepEqual(h.queue, before);
  }
  const h = harness(); h.setCurrent(false); await h.run(); assert.equal(h.calls.length, 0); assert.equal(h.queue.length, 3);
});

test("known rejection refreshes only target without overwriting a concurrent enqueue", async () => {
  const gate = deferred(); let h;
  h = harness({ api: (url, options) => {
    if (url.endsWith("/steer")) return gate.promise;
    if (url.startsWith("/api/prompt-queue?")) return [request("one", { prompt: "Edited in another window" })];
  } });
  const running = h.run(); h.queue.push(request("later")); gate.reject(new Error("Model settings differ")); await running;
  assert.deepEqual(h.queue.map(item => item.requestId), ["one", "two", "three", "later"]);
  assert.equal(h.queue[0].prompt, "Edited in another window"); assert.equal(h.queue[0].status, "queued"); assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /remains queued/); assert.equal(h.calls.filter(call => call.url.endsWith("/steer")).length, 1);
});

test("backend uncertain delivery stays interrupted with saved contents and no automatic retry", async () => {
  const h = harness({ api: url => {
    if (url.endsWith("/steer")) throw new Error("Reply timed out");
    if (url.startsWith("/api/prompt-queue?")) return [request("one", { status: "interrupted", delivery: "steer", attempted: true, error: "May already be accepted" })];
  } });
  await h.run(); assert.equal(h.queue.length, 3); assert.equal(h.queue[0].recovered, true); assert.equal(h.queue[0].status, "interrupted");
  assert.equal(h.queue[0].attachments[0].id, "image"); assert.match(h.errors[0], /May already/); await h.run();
  assert.equal(h.calls.filter(call => call.url.endsWith("/steer")).length, 1);
});

test("a missing queue item alone never proves steering acceptance", async () => {
  const h = harness({ api: url => { if (url.endsWith("/steer")) throw new Error("Lost response"); if (url.startsWith("/api/prompt-queue?")) return []; } });
  await h.run(); assert.equal(h.queue.length, 3); assert.equal(h.queue[0].status, "interrupted"); assert.equal(h.queue[0].delivery, "steer");
  assert.equal(h.success.length, 0); assert.match(h.errors[0], /may already/);
});

test("lost reply reconciles exact persisted steering metadata without duplicate history or resend", async () => {
  const h = harness({ api: url => {
    if (url.endsWith("/steer")) throw new Error("Lost response");
    if (url.startsWith("/api/prompt-queue?")) return [];
    if (url.startsWith("/api/ai-tasks/")) return acceptedTask();
  } });
  await h.run(); assert.deepEqual(h.queue.map(item => item.requestId), ["two", "three"]);
  assert.equal(h.success.length, 1); assert.equal(h.errors.length, 0); assert.equal(h.changes.at(-1).task.messages.length, 1);
  assert.equal(h.calls.filter(call => call.url.endsWith("/steer")).length, 1);
});

test("lost reply repairs accepted history through reconcile without a second native send", async () => {
  const h = harness({ api: url => {
    if (url.endsWith("/steer")) throw new Error("History persistence was interrupted");
    if (url.endsWith("/steer/reconcile")) return { accepted: true, requestId: "one", jobId: "job", turnId: "turn", task: acceptedTask(), queue: [] };
  } });
  await h.run();
  assert.deepEqual(h.calls.map(call => call.url), ["/api/prompt-queue/one/steer", "/api/prompt-queue/one/steer/reconcile"]);
  assert.deepEqual(h.calls[1].options.body, h.calls[0].options.body);
  assert.deepEqual(h.queue.map(item => item.requestId), ["two", "three"]);
  assert.equal(h.success.length, 1); assert.equal(h.errors.length, 0); assert.equal(h.changes.at(-1).task.messages.length, 1);
});

test("Check delivery inspects the original saved turn only, even after that job finishes", async () => {
  const saved = request("one", { status: "interrupted", delivery: "steer", jobId: "job", turnId: "turn", attempted: true });
  const html = queuedPromptButtons("repository", "task", saved);
  assert.match(html, /Check delivery/); assert.match(html, /data-check-steer="one"/);
  assert.doesNotMatch(html, /data-edit-queued|data-steer-queued/);
  assert.match(queuedSteerButtonMarkup("repository", "task", saved, { pending: true }), /Checking…/);
  const h = harness({ queue: [saved, request("two")], job: { id: "new-job", nativeTurnId: "new-turn", status: "completed" }, api: url => {
    if (url.endsWith("/steer/reconcile")) return { accepted: true, requestId: "one", jobId: "job", turnId: "turn", task: acceptedTask(), queue: [] };
  } });
  await h.controller.reconcile("repository", "task", "one");
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, "/api/prompt-queue/one/steer/reconcile");
  assert.equal(h.calls[0].options.body.jobId, "job"); assert.equal(h.calls[0].options.body.expectedTurnId, "turn");
  assert.deepEqual(h.queue.map(item => item.requestId), ["two"]); assert.match(h.success[0], /not sent again/);
});

test("unconfirmed recovery remains paused and cannot fall through to a native resend", async () => {
  const saved = request("one", { status: "interrupted", delivery: "steer", jobId: "job", turnId: "turn", attempted: true });
  const h = harness({ queue: [saved] });
  await h.controller.reconcile("repository", "task", "one");
  await h.run();
  assert.equal(h.calls.some(call => call.url.endsWith("/steer")), false);
  assert.equal(h.calls.filter(call => call.url.endsWith("/steer/reconcile")).length, 1);
  assert.equal(h.queue.length, 1); assert.equal(h.queue[0].status, "interrupted"); assert.equal(h.success.length, 0);
});

test("wrong-job or wrong-request history cannot reconcile an uncertain steering request", () => {
  assert.equal(acceptedSteeringMessage(acceptedTask("other"), "one", "job"), undefined);
  assert.equal(acceptedSteeringMessage(acceptedTask("one", "other"), "one", "job"), undefined);
  assert.equal(acceptedSteeringMessage(acceptedTask(), "one", "job", "other-turn"), undefined);
  const task = acceptedTask(); task.messages[0].status = "queued"; assert.equal(acceptedSteeringMessage(task, "one", "job"), undefined);
});

test("malformed acceptance response is not trusted", async () => {
  const h = harness({ api: url => url.endsWith("/steer") ? { accepted: true, requestId: "other", jobId: "job", turnId: "turn" } : undefined });
  await h.run(); assert.equal(h.queue.length, 3); assert.equal(h.success.length, 0); assert.equal(h.errors.length, 1);
});

test("accepted delivery stays accepted when transcript refresh fails", async () => {
  const h = harness({ api: url => {
    if (url.endsWith("/steer")) return { accepted: true, requestId: "one", jobId: "job", turnId: "turn" };
    if (url.startsWith("/api/ai-tasks/")) throw new Error("Offline");
  } });
  await h.run(); assert.equal(h.queue.length, 2); assert.equal(h.success.length, 1); assert.equal(h.errors.length, 0); assert.match(h.success[0], /Refresh this chat/);
});

test("navigation during delivery does not redraw another chat or drop its queue", async () => {
  const gate = deferred(); const h = harness({ api: url => url.endsWith("/steer") ? gate.promise : undefined });
  const run = h.run(); assert.equal(h.changes.length, 1); h.setCurrent(false);
  gate.resolve({ accepted: true, requestId: "one", jobId: "job", turnId: "turn", task: acceptedTask() }); await run;
  assert.equal(h.changes.length, 1); assert.equal(h.queue.length, 2); assert.equal(h.held.size, 0);
});

test("both transcripts bind the shared action, with no replacement composer send behavior", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /for \(const scope of \["repository", "global"\]\)[\s\S]*?data-steer-queued/);
  assert.match(app, /queuedPromptSteering\.steer\(scope, steer\.dataset\.queueTask, steer\.dataset\.steerQueued\)/);
  assert.match(app, /queuedPromptSteering\.reconcile\(scope, checkSteer\.dataset\.queueTask, checkSteer\.dataset\.checkSteer\)/);
  assert.match(app, /if \(runningAgentJob\(scope\)\) \{\s*return queueCurrentPrompt\(scope\);/);
  assert.match(app, /refreshQueuedSteeringControls\("repository"\)/); assert.match(app, /refreshQueuedSteeringControls\("global"\)/);
});

test("only a canonical user steering receipt gets the compact Steered label", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const label = app.split("\n").find(line => line.includes("const queueLabel ="));
  const render = message => vm.runInNewContext(`${label}; queueLabel`, { message });
  const message = acceptedTask().messages[0];
  assert.match(render(message), /queued-prompt-label.*Steered/);
  for (const invalid of [{ ...message, role: "assistant" }, { ...message, status: "sent" }, { ...message, steering: {} },
    { ...message, steering: { ...message.steering, turnId: "" } }]) assert.equal(render(invalid), "");
  assert.match(render({ ...message, queued: true, queuePosition: 2 }), /Queued.*2/);
});

test("job polling updates only changed small controls and preserves transcript DOM", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function refreshQueuedSteeringControls(");
  const source = app.slice(start, app.indexOf("\n}", start) + 2);
  const actions = [{ disabled: false }, { disabled: false }], painted = [];
  const control = { dataset: { queueTask: "task", queuedSteering: "one" }, parentElement: { querySelectorAll: () => actions } };
  const job = activeJob(); let pending = false;
  const context = { $: () => ({ querySelectorAll: () => [control] }), runningAgentJob: () => job,
    queuedPrompts: () => [request()], queuedPromptSteering: { isPending: () => pending }, queuedSteerButtonMarkup,
    renderChatMarkup: (element, markup) => { assert.equal(element, control); painted.push(markup); } };
  vm.createContext(context); vm.runInContext(source, context);
  context.refreshQueuedSteeringControls("repository"); context.refreshQueuedSteeringControls("repository");
  assert.equal(painted.length, 1); assert.match(painted[0], /Steer now/);
  pending = true; context.refreshQueuedSteeringControls("repository");
  assert.equal(painted.length, 2); assert.match(painted[1], /Steering…/); assert.equal(actions.every(button => button.disabled), true);
  pending = false; job.steering.available = false; job.steering.reason = "Finishing tool";
  context.refreshQueuedSteeringControls("repository"); assert.equal(painted.length, 3); assert.match(painted[2], /Finishing tool/);
  assert.equal(actions.some(button => button.disabled), false);
});
