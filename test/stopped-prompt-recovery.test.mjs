import assert from "node:assert/strict";
import test from "node:test";
import { createStoppedPromptRecovery, findStoppedPromptMessage } from "../public/stopped-prompt-recovery.mjs";

// Synthetic transcript/state only: these tests never contact a running Argus or
// a provider, write user data, or submit a prompt.
const startedAt = "2026-09-20T16:08:05.000Z";
const at = (seconds) => `2026-09-20T16:08:${String(seconds).padStart(2, "0")}.000Z`;
const message = (id, content = "Explain this method", seconds = 4, extra = {}) => ({
  id, role: "user", content, createdAt: at(seconds), ...extra,
});
const sourceFor = (scope = "repository", extra = {}) => ({
  taskId: "original-task", repositoryId: scope === "global" ? "global" : "repo-one",
  prompt: "Explain this method", startedAt, ...extra,
});
const taskFor = (scope = "repository", messages = [message("stopped-message")], extra = {}) => ({
  id: "original-task", repositoryId: scope === "global" ? "global" : "repo-one", messages, ...extra,
});

for (const scope of ["global", "repository"]) {
  test(`${scope}: finds the saved stopped prompt in its exact original task`, () => {
    const sent = message("stopped-message", "  Explain this method\n", 4, {
      attachments: [{ id: "attachment-one", title: "Example.java" }],
      promptNotes: [{ id: "note-one", text: "Explain only", enabled: true }],
    });
    const task = taskFor(scope, [sent, { id: "partial", role: "assistant", content: "Working", createdAt: at(7), status: "cancelled" }]);
    const before = structuredClone(task);
    assert.equal(findStoppedPromptMessage(task, sourceFor(scope)), sent);
    assert.deepEqual(task, before, "recovery must not rewrite attachments, notes, or transcript");
  });

  test(`${scope}: never accepts a different task or repository`, () => {
    const source = sourceFor(scope);
    assert.equal(findStoppedPromptMessage(taskFor(scope, undefined, { id: "another-task" }), source), null);
    assert.equal(findStoppedPromptMessage(taskFor(scope, undefined, { repositoryId: "another-repo" }), source), null);
    assert.equal(findStoppedPromptMessage(taskFor(scope), { ...source, taskId: null }), null);
  });
}

test("normal job selects the latest saved user prompt only while no newer turn supersedes it", () => {
  const older = message("older-duplicate", undefined, 1);
  const stopped = message("stopped-message", undefined, 4);
  const newer = message("newer-request", undefined, 6);
  assert.equal(findStoppedPromptMessage(taskFor("repository", [older, stopped]), sourceFor()), stopped);
  assert.equal(findStoppedPromptMessage(taskFor("repository", [older, stopped, newer]), sourceFor()), null);
  assert.equal(findStoppedPromptMessage(taskFor("repository", [newer]), sourceFor()), null);
});

test("normal job allows a user message exactly at its start boundary", () => {
  const sent = message("boundary", undefined, 5);
  assert.equal(findStoppedPromptMessage(taskFor("repository", [sent]), sourceFor()), sent);
});

test("same-job steering does not hide the original stopped prompt, but later turns still do", () => {
  const original = message("original");
  const steer = message("steered", "Also inspect the cache", 9, { status: "steered", steering: { requestId: "queued", jobId: "job", turnId: "turn" } });
  const source = sourceFor("repository", { id: "job", nativeTurnId: "turn" });
  assert.equal(findStoppedPromptMessage(taskFor("repository", [original, steer]), source), original);
  for (const extra of [message("next", undefined, 10), { ...steer, steering: { ...steer.steering, jobId: "other" } },
    { ...steer, steering: { ...steer.steering, turnId: "other" } }, { ...steer, steering: undefined }])
    assert.equal(findStoppedPromptMessage(taskFor("repository", [original, steer, extra]), source), null);
});

test("finder ignores assistant text, optimistic messages, and messages without stable IDs", () => {
  for (const extra of [{ role: "assistant" }, { optimistic: true }, { id: "" }, { id: undefined }]) {
    const task = taskFor("repository", [message("not-saved", undefined, 4, extra)]);
    assert.equal(findStoppedPromptMessage(task, sourceFor()), null);
  }
});

test("finder requires exact prompt content apart from outer whitespace", () => {
  for (const content of ["Explain this method please", "explain this method", "Explain  this method", ""]) {
    assert.equal(findStoppedPromptMessage(taskFor("repository", [message("other", content)]), sourceFor()), null);
  }
  assert.equal(findStoppedPromptMessage(taskFor(), { ...sourceFor(), prompt: " \n " }), null);
});

test("invalid or absent source/message timestamps fail closed instead of choosing a duplicate", () => {
  for (const invalid of [undefined, "not-a-date", ""]) {
    assert.equal(findStoppedPromptMessage(taskFor(), sourceFor("repository", { startedAt: invalid })), null);
    assert.equal(findStoppedPromptMessage(taskFor("repository", [message("ambiguous", undefined, 4, { createdAt: invalid })]), sourceFor()), null);
  }
  assert.equal(findStoppedPromptMessage(taskFor(), sourceFor("repository", { startedAt: Number.NaN })), null);
});

test("preparation can find a prompt saved after the client started preparing", () => {
  const source = sourceFor("repository", { kind: "preparation", startedAt: Date.parse(startedAt) });
  const saved = message("prepared-message", undefined, 8);
  assert.equal(findStoppedPromptMessage(taskFor("repository", [message("old-duplicate", undefined, 1), saved]), source), saved);
});

test("preparation timestamp lower bound allows two seconds of skew, not an old identical turn", () => {
  const source = sourceFor("repository", { kind: "preparation", startedAt: Date.parse(startedAt) });
  const boundary = message("skew-boundary", undefined, 3);
  assert.equal(findStoppedPromptMessage(taskFor("repository", [boundary]), source), boundary);
  assert.equal(findStoppedPromptMessage(taskFor("repository", [message("old-duplicate", undefined, 2)]), source), null);
});

test("preparation rejects a known earlier identical prompt even inside the timestamp-skew window", () => {
  const previous = message("previous-message", undefined, 4);
  const source = sourceFor("repository", { kind: "preparation", startedAt: Date.parse(startedAt), previousMessageIds: [previous.id] });
  assert.equal(findStoppedPromptMessage(taskFor("repository", [previous]), source), null);
});

test("preparation can recover its newly persisted turn without confusing a known prior duplicate", () => {
  const previous = message("previous-message", undefined, 4);
  const saved = message("newly-saved-message", undefined, 5);
  const source = sourceFor("repository", { kind: "preparation", startedAt: Date.parse(startedAt), previousMessageIds: [previous.id] });
  assert.equal(findStoppedPromptMessage(taskFor("repository", [previous, saved]), source), saved);
});

test("finder tolerates missing or malformed transcript without inventing a user message", () => {
  for (const task of [null, undefined, taskFor("repository", []), taskFor("repository", null)]) {
    assert.equal(findStoppedPromptMessage(task, sourceFor()), null);
  }
});

function harness({ scope = "repository", source = sourceFor(scope), task = taskFor(scope) } = {}) {
  const h = { scope, source, task, current: true, loads: [], editors: [], drafts: [], errors: [] };
  h.recover = createStoppedPromptRecovery({
    isCurrent: () => h.current,
    loadTask: async (taskId) => {
      h.loads.push(taskId);
      if (h.onLoad) return h.onLoad(taskId);
      return h.task;
    },
    openEditor: async (selection) => {
      h.editors.push(selection);
      if (h.onOpen) return h.onOpen(selection);
    },
    restoreDraft: async (draft) => { h.drafts.push(draft); },
    onError: (error) => { h.errors.push(error); },
  });
  h.run = () => h.recover(h.scope, h.source);
  return h;
}

for (const scope of ["global", "repository"]) {
  test(`${scope}: recovering a saved prompt opens only its existing editor, with no synthetic draft`, async () => {
    const h = harness({ scope });
    const before = structuredClone(h.task);
    await h.run();
    assert.deepEqual(h.loads, [h.source.taskId]);
    assert.equal(h.editors.length, 1);
    assert.equal(h.editors[0].scope, scope);
    assert.equal(h.editors[0].taskId, h.source.taskId);
    assert.equal(h.editors[0].messageId, "stopped-message");
    assert.deepEqual(h.drafts, []);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.task, before);
  });

  test(`${scope}: navigation before recovery produces no reads, editing, or draft restoration`, async () => {
    const h = harness({ scope }); h.current = false;
    await h.run();
    assert.deepEqual([h.loads, h.editors, h.drafts, h.errors], [[], [], [], []]);
  });

  test(`${scope}: navigation during the transcript read never opens the new chat's editor`, async () => {
    const h = harness({ scope });
    h.onLoad = async () => { h.current = false; return h.task; };
    await h.run();
    assert.deepEqual(h.loads, [h.source.taskId]);
    assert.deepEqual([h.editors, h.drafts], [[], []]);
  });

  test(`${scope}: taskless cancelled preparation restores original draft without guessing a new task`, async () => {
    const source = sourceFor(scope, { taskId: null, kind: "preparation", draft: "  Explain this method\n" });
    const h = harness({ scope, source });
    await h.run();
    assert.deepEqual(h.loads, []);
    assert.deepEqual(h.editors, []);
    assert.equal(h.drafts.length, 1);
    assert.equal(h.drafts[0], source);
  });
}

test("preparation not yet saved restores its captured draft, not an older identical user turn", async () => {
  const source = sourceFor("repository", { kind: "preparation", startedAt: Date.parse(startedAt), draft: "Explain this method" });
  const h = harness({ source, task: taskFor("repository", [message("old-duplicate", undefined, 1)]) });
  await h.run();
  assert.deepEqual(h.editors, []);
  assert.equal(h.drafts[0], source);
});

test("a saved preparation opens Edit instead of adding a duplicate request to the composer", async () => {
  const source = sourceFor("repository", { kind: "preparation", startedAt: Date.parse(startedAt), draft: "Explain this method" });
  const h = harness({ source, task: taskFor("repository", [message("prepared", undefined, 8)]) });
  await h.run();
  assert.equal(h.editors[0]?.messageId, "prepared");
  assert.deepEqual(h.drafts, []);
});

test("newer post-job duplicate is never selected for the stopped active job", async () => {
  const h = harness({ task: taskFor("repository", [message("newer", undefined, 6)]) });
  await h.run();
  assert.deepEqual([h.editors, h.drafts], [[], []]);
});

test("navigation while loading an unmatched preparation suppresses draft restoration", async () => {
  const h = harness({ source: sourceFor("repository", { kind: "preparation", draft: "keep this" }), task: taskFor("repository", []) });
  h.onLoad = async () => { h.current = false; return h.task; };
  await h.run();
  assert.deepEqual([h.editors, h.drafts], [[], []]);
});

test("read errors are reported without appending, sending, or restoring a potentially saved duplicate", async () => {
  for (const kind of [undefined, "preparation"]) {
    const h = harness({ source: sourceFor("repository", { kind }) });
    const failure = new Error("Could not read the original chat");
    h.onLoad = async () => { throw failure; };
    await h.run();
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0], failure);
    assert.deepEqual([h.editors, h.drafts], [[], []]);
  }
});

test("editor errors do not fall back to a duplicate synthetic composer prompt", async () => {
  const h = harness();
  const failure = new Error("The active chat changed");
  h.onOpen = async () => { throw failure; };
  await h.run();
  assert.equal(h.errors[0], failure);
  assert.deepEqual(h.drafts, []);
});

test("late read failure after navigation does not show an unrelated-chat error", async () => {
  const h = harness();
  h.onLoad = async () => { h.current = false; throw new Error("Original chat unavailable"); };
  await h.run();
  assert.deepEqual([h.editors, h.drafts, h.errors], [[], [], []]);
});
