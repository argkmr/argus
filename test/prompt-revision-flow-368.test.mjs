import test from "node:test";
import assert from "node:assert/strict";
import { createPromptRevisionFlow } from "../public/prompt-revision-flow.mjs";

const copy = value => structuredClone(value);
const note = { id: "saved-note", text: "Retain the original instruction", enabled: true };
const attachment = { id: "saved-file", title: "evidence.txt", kind: "file" };
const pendingTask = () => ({
  id: "task", scope: "global", repositoryId: "global", repositoryIds: ["repo-a"],
  provider: "codex", mode: "edit", model: "saved-model", effort: "high", speed: "standard",
  contextMode: "fresh", revisionCount: 1,
  revisionOf: { taskId: "task", revisionId: "revision", pending: true },
  revisionDraft: { prompt: "Saved draft", runRequestId: "run-original", attachments: [attachment], promptNotes: [note] },
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(options = {}) {
  let current = pendingTask(), receipt, nextId = 0;
  let losePatch = Boolean(options.losePatch), failedReads = 0;
  const calls = [], patches = [], dispatches = [], presentations = [], coordinates = [];
  const input = { scope: "global", task: copy(current),
    message: { id: "revision-draft", content: "Saved draft", pendingRevision: true,
      attachments: [attachment], promptNotes: [note] },
    prompt: options.prompt || "Saved draft", requestId: "stable-edit" };
  const flow = createPromptRevisionFlow({
    createRequestId: () => `edit-${++nextId}`,
    isCurrent: () => true, validate: () => {}, accept: () => true,
    chooseScope: options.chooseScope || (async () => ({})),
    coordinate: async operation => { coordinates.push(operation); return operation.mutate(); },
    api: async (path, request) => {
      calls.push({ path, request: copy(request) });
      if (!request?.method) {
        if (failedReads) { failedReads--; throw new Error("Recovery read disconnected"); }
        await options.beforeRead?.(calls.filter(call => !call.request?.method).length);
        return copy(current);
      }
      assert.equal(request.method, "PATCH");
      assert.match(path, /\/revision-draft$/);
      patches.push(copy(request.body));
      const body = request.body;
      if (options.blockPatchAfterDispatch && dispatches.length)
        throw Object.assign(new Error("Wait for the task's response to finish before changing or sending a prompt"), { status: 409 });
      if (receipt && JSON.stringify(body) === receipt.fingerprint)
        return { task: copy(current), attachments: copy(current.revisionDraft.attachments) };
      if (!current.revisionDraft || body.expectedRunRequestId !== current.revisionDraft.runRequestId
        || body.expectedPrompt !== current.revisionDraft.prompt
        || body.expectedRevisionCount !== current.revisionCount)
        throw Object.assign(new Error("The revision draft changed; reload it before saving"), { status: 409 });
      if (body.repositoryIds && JSON.stringify(body.expectedRepositoryIds) !== JSON.stringify(current.repositoryIds))
        throw Object.assign(new Error("This revision's repository selection changed"), { status: 409 });
      const changed = body.prompt !== current.revisionDraft.prompt
        || (body.promptNotes !== undefined && JSON.stringify(body.promptNotes) !== JSON.stringify(current.revisionDraft.promptNotes))
        || (body.repositoryIds && JSON.stringify(body.repositoryIds) !== JSON.stringify(current.repositoryIds));
      current.revisionDraft.prompt = body.prompt;
      if (body.promptNotes !== undefined) current.revisionDraft.promptNotes = copy(body.promptNotes);
      if (body.repositoryIds) current.repositoryIds = copy(body.repositoryIds);
      if (changed) current.revisionDraft.runRequestId = `run-updated-${++nextId}`;
      receipt = { fingerprint: JSON.stringify(body) };
      if (losePatch) {
        losePatch = false; failedReads = options.failedRecoveryReads || 0;
        throw new Error("Save response disconnected");
      }
      return { task: copy(current), attachments: copy(current.revisionDraft.attachments) };
    },
    dispatch: async request => {
      dispatches.push(copy(request));
      if (options.consumeRun) {
        current.revisionOf = { ...current.revisionOf, pending: false, runRequestId: current.revisionDraft.runRequestId };
        delete current.revisionDraft;
      }
      if (options.runError) throw new Error("Run response disconnected");
      return { id: "started-job" };
    },
    present: async result => { presentations.push(copy(result)); },
  });
  return { flow, input, calls, patches, dispatches, presentations, coordinates,
    current: () => current, submit: changes => flow.submit({ ...input, ...changes }) };
}

test("pending draft uses its persisted run identity without cancelling and preserves saved context", async () => {
  const h = harness();
  const result = await h.submit();
  assert.equal(result.status, "started");
  assert.equal(h.coordinates.length, 0);
  assert.equal(h.patches.length, 1);
  assert.equal(h.patches[0].expectedRunRequestId, "run-original");
  assert.equal(h.dispatches[0].requestId, "run-original");
  assert.equal(h.dispatches[0].expectedRevisionCount, 1);
  assert.deepEqual(h.dispatches[0].repositoryIds, ["repo-a"]);
  assert.deepEqual(h.dispatches[0].attachments, [attachment]);
  assert.deepEqual(h.dispatches[0].attachmentIds, ["saved-file"]);
  assert.deepEqual(h.dispatches[0].promptNotes, [note]);
  assert.deepEqual(h.dispatches[0].modelSettings, { model: "saved-model", effort: "high", speed: "standard" });
});

test("accepted run with a lost response is recovered without cancellation or another dispatch", async () => {
  const h = harness({ prompt: "Updated draft", consumeRun: true, runError: true });
  assert.equal((await h.submit()).status, "saved");
  const acceptedId = h.dispatches[0].requestId;
  assert.notEqual(acceptedId, "run-original");
  assert.equal(h.current().revisionOf.runRequestId, acceptedId);
  const recovered = await h.submit();
  assert.equal(recovered.status, "started");
  assert.equal(recovered.alreadySubmitted, true);
  assert.equal(h.coordinates.length, 0);
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.patches.length, 1);
});

test("an uncertain run still preparing its saved draft is never cancelled on retry", async () => {
  const h = harness({ runError: true, blockPatchAfterDispatch: true });
  assert.equal((await h.submit()).status, "saved");
  assert.ok(h.current().revisionDraft, "the accepted run has not appended its user message yet");
  await assert.rejects(h.submit(), /response to finish/);
  assert.equal(h.coordinates.length, 0);
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.flow.isBusy("task"), false);
  assert.equal(h.current().revisionDraft.runRequestId, "run-original");
});

test("lost PATCH response and lost recovery read retry the exact durable save operation", async () => {
  const h = harness({ prompt: "Updated draft", losePatch: true, failedRecoveryReads: 1 });
  await assert.rejects(h.submit(), /Save response disconnected/);
  const savedId = h.current().revisionDraft.runRequestId;
  assert.equal(h.dispatches.length, 0);
  assert.equal((await h.submit()).status, "started");
  assert.equal(h.coordinates.length, 0);
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.dispatches[0].requestId, savedId);
  assert.equal(h.patches.length, 2);
  assert.deepEqual(h.patches[1], h.patches[0]);
});

test("a lost PATCH response recovers exact prompt, notes, attachments and repository selection", async () => {
  const h = harness({ prompt: "Updated draft", losePatch: true });
  assert.equal((await h.submit()).status, "started");
  assert.equal(h.patches.length, 1);
  assert.deepEqual(h.dispatches[0].promptNotes, [note]);
  assert.deepEqual(h.dispatches[0].attachments, [attachment]);
  assert.equal(h.dispatches[0].requestId, h.current().revisionDraft.runRequestId);
});

test("a stale same-text draft identity cannot overwrite another client's notes", async () => {
  const h = harness();
  h.current().revisionDraft.runRequestId = "other-client-run";
  h.current().revisionDraft.promptNotes = [{ ...note, text: "New instruction" }];
  await assert.rejects(h.submit(), /draft changed/);
  assert.equal(h.patches.length, 0);
  assert.equal(h.dispatches.length, 0);
  assert.equal(h.coordinates.length, 0);
});

test("cancelling repository selection releases the task lock without changing the draft", async () => {
  const h = harness({ chooseScope: async () => null });
  assert.equal((await h.submit()).status, "cancelled");
  assert.equal(h.flow.isBusy("task"), false);
  assert.equal(h.patches.length, 0);
  assert.equal(h.dispatches.length, 0);
  assert.equal(h.current().revisionDraft.runRequestId, "run-original");
});

test("confirmed repository replacement carries the scope captured when editing began", async () => {
  let selectedFrom;
  const h = harness({ chooseScope: async task => {
    selectedFrom = copy(task.repositoryIds);
    return { expectedRepositoryIds: copy(task.repositoryIds), repositoryIds: ["repo-b"] };
  } });
  assert.equal((await h.submit()).status, "started");
  assert.deepEqual(selectedFrom, ["repo-a"]);
  assert.deepEqual(h.patches[0].expectedRepositoryIds, ["repo-a"]);
  assert.deepEqual(h.dispatches[0].repositoryIds, ["repo-b"]);
  assert.notEqual(h.dispatches[0].requestId, "run-original");
});

test("the per-task lock rejects duplicate submission while the first read is pending", async () => {
  const gate = deferred();
  const h = harness({ beforeRead: number => number === 1 ? gate.promise : undefined });
  const first = h.submit();
  assert.equal(h.flow.isBusy("task"), true);
  assert.equal((await h.submit()).status, "busy");
  gate.resolve();
  assert.equal((await first).status, "started");
  assert.equal(h.flow.isBusy("task"), false);
  assert.equal(h.patches.length, 1);
  assert.equal(h.dispatches.length, 1);
});

test("an explicit empty note edit clears notes while retaining saved attachments", async () => {
  const h = harness();
  assert.equal((await h.submit({ promptNotes: [] })).status, "started");
  assert.deepEqual(h.patches[0].promptNotes, []);
  assert.deepEqual(h.dispatches[0].promptNotes, []);
  assert.deepEqual(h.dispatches[0].attachments, [attachment]);
  assert.notEqual(h.dispatches[0].requestId, "run-original");
});
