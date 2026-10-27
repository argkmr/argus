import test from "node:test";
import assert from "node:assert/strict";
import { createChatCheckpointActions, checkpointButtonMarkup } from "../public/chat-checkpoint-actions.mjs";

const saved = (id = "one") => ({ id, role: "user", content: "Keep this decision", createdAt: "2026-09-08T10:00:00Z" });
const task = (id = "task-a") => ({ id, messages: [saved()], checkpoints: [], checkpointRevision: 0 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness() {
  const tasks = { repository: task(), global: task("nexus") }, responses = [], calls = [], changes = [], errors = [];
  const active = { repository: "task-a", global: "nexus" };
  const actions = createChatCheckpointActions({
    api: async (...args) => { calls.push(args); return responses.shift(); },
    getTask: (scope) => tasks[scope], isActive: (scope, id) => active[scope] === id,
    onChange: (...args) => changes.push(args), onError: (error) => errors.push(error),
  });
  return { actions, tasks, active, responses, calls, changes, errors };
}

test("marks old saved messages in either chat scope without starting a run or changing messages", async () => {
  for (const scope of ["repository", "global"]) {
    const h = harness(), original = h.tasks[scope];
    h.responses.push({ ...original, checkpointRevision: 1, checkpoints: [{ messageId: "one", markedAt: "today", message: saved() }] });
    await h.actions.toggle(scope, original.id, "one");
    assert.deepEqual(h.calls, [[`/api/ai-tasks/${original.id}/checkpoints/one`, { method: "PUT" }]]);
    assert.equal(h.actions.ingest(original).checkpoints.length, 1);
    assert.equal(h.actions.ingest(original).messages, original.messages);
    assert.equal(original.checkpoints.length, 0);
    assert.equal(h.actions.isPending(original.id), false);
    assert.deepEqual(h.errors, []);
  }
});

test("new checkpoint revision protects against stale reads and never replaces newer live messages", async () => {
  const h = harness(), pending = deferred(), original = h.tasks.repository;
  h.responses.push(pending.promise);
  const saving = h.actions.toggle("repository", original.id, "one");
  h.tasks.repository = { ...original, messages: [...original.messages, saved("new response")] };
  pending.resolve({ ...original, checkpointRevision: 1, checkpoints: [{ messageId: "one", message: saved() }] });
  await saving;
  assert.equal(h.actions.ingest(h.tasks.repository).messages.length, 2);
  h.responses.push({ ...original, checkpointRevision: 2, checkpoints: [] });
  await h.actions.toggle("repository", original.id, "one");
  assert.equal(h.calls[1][1].method, "DELETE");
  assert.deepEqual(h.actions.ingest({ ...original, checkpointRevision: 1, checkpoints: [{ messageId: "one" }] }).checkpoints, []);
});

test("serializes toggles per chat and ignores mismatched active chat without consuming drafts", async () => {
  const h = harness(), pending = deferred();
  h.responses.push(pending.promise);
  const saving = h.actions.toggle("repository", "task-a", "one");
  assert.equal(h.actions.isPending("task-a"), true);
  await h.actions.toggle("repository", "task-a", "one");
  assert.equal(h.calls.length, 1);
  h.active.repository = "different";
  await h.actions.toggle("repository", "task-a", "one");
  pending.resolve({ ...task(), checkpointRevision: 1, checkpoints: [{ messageId: "one", message: saved() }] });
  await saving;
  assert.equal(h.active.repository, "different");
  assert.equal(h.actions.ingest(task("different")).checkpoints.length, 0);
});

test("rejects optimistic, queued, pending revision, missing and non-chat messages", async () => {
  for (const message of [{ ...saved(), optimistic: true }, { ...saved(), queued: true }, { ...saved(), pendingRevision: true }, { ...saved(), role: "tool" }]) {
    const h = harness(); h.tasks.repository.messages = [message];
    await h.actions.toggle("repository", "task-a", "one");
    assert.deepEqual(h.calls, []);
  }
  const h = harness(); await h.actions.toggle("repository", "task-a", "missing"); assert.deepEqual(h.calls, []);
});

test("can remove archived checkpoint snapshots without putting them back in working messages", async () => {
  const h = harness();
  h.tasks.repository = { ...task(), messages: [], checkpointRevision: 4, checkpoints: [{ messageId: "one", message: saved() }] };
  h.responses.push({ ...h.tasks.repository, checkpointRevision: 5, checkpoints: [] });
  await h.actions.toggle("repository", "task-a", "one");
  assert.equal(h.calls[0][1].method, "DELETE");
  assert.deepEqual(h.actions.ingest(h.tasks.repository).messages, []);
  assert.deepEqual(h.actions.ingest(h.tasks.repository).checkpoints, []);
});

test("failure keeps existing markers, clears busy state, and reports a recoverable error", async () => {
  const h = harness(), pending = deferred(); h.responses.push(pending.promise);
  const saving = h.actions.toggle("global", "nexus", "one");
  pending.reject(new Error("Offline — please retry")); await saving;
  assert.deepEqual(h.errors, ["Offline — please retry"]);
  assert.equal(h.actions.isPending("nexus"), false);
  assert.deepEqual(h.actions.ingest(h.tasks.global).checkpoints, []);
});

test("button has accessible toggle state and escapes identifiers", () => {
  const escapeHtml = (value) => String(value).replaceAll('"', "&quot;");
  const html = checkpointButtonMarkup({ taskId: 'task"id', messageId: 'msg"id', marked: true, pending: true, escapeHtml });
  assert.match(html, /data-checkpoint-task="task&quot;id"/);
  assert.match(html, /data-checkpoint-message="msg&quot;id"/);
  assert.match(html, /aria-pressed="true"/); assert.match(html, /aria-label="Remove checkpoint"/); assert.match(html, / disabled/);
});
