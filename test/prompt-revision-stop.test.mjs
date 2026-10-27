import test from "node:test";
import assert from "node:assert/strict";
import { createPromptRevisionCoordinator, revisionJobIsBusy } from "../public/prompt-revision-stop.mjs";

function harness({ scope = "repository", status = "running" } = {}) {
  const task = { id: "task", repositoryId: scope === "global" ? "global" : "repo" };
  const h = { task, calls: [], progress: [], mutations: 0, time: 0, current: true, queue: [], queuedWork: false,
    submission: null, ticks: 0, jobs: [{ id: "old", taskId: "task", repositoryId: task.repositoryId, status, completionPending: false }] };
  h.api = async (url, options) => {
    h.calls.push({ url, options });
    if (h.onApi) { const result = await h.onApi(url, options); if (result !== undefined) return result; }
    if (url.startsWith("/api/prompt-queue?")) return structuredClone(h.queue);
    if (url.startsWith("/api/agents/jobs?")) return structuredClone(h.jobs);
    if (options.method === "DELETE") {
      const job = h.jobs.find((item) => url === `/api/agents/jobs/${item.id}`);
      if (job) { job.status = "cancelled"; job.completionPending = true; }
      return { ok: true };
    }
    throw new Error(`Unexpected call ${url}`);
  };
  h.coordinator = createPromptRevisionCoordinator({ api: (...args) => h.api(...args),
    isCurrent: () => h.current, hasQueuedWork: () => h.queuedWork, getSubmission: () => h.submission,
    now: () => h.time, timeoutMs: 1500, pollMs: 100,
    sleep: async (ms) => {
      h.time += ms; h.ticks++;
      if (h.onTick) await h.onTick();
      else h.jobs.forEach((job) => { if (job.status === "cancelled") job.completionPending = false; });
    },
  });
  h.run = () => h.coordinator({ scope, task, onProgress: (label) => h.progress.push(label), mutate: async () => {
    h.mutations++; if (h.onMutate) return h.onMutate(); return { task: { id: "revised" } };
  } });
  h.stops = () => h.calls.filter(({ options }) => options.method === "DELETE");
  return h;
}

for (const scope of ["global", "repository"]) test(`${scope}: auto-stop only the edited chat, wait for persisted completion, then revise once`, async () => {
  const h = harness({ scope });
  h.jobs.push({ ...h.jobs[0], id: "other-chat", taskId: "elsewhere" },
    { ...h.jobs[0], id: "other-repo", repositoryId: "elsewhere" },
    { ...h.jobs[0], id: "system", systemJob: true }, { ...h.jobs[0], id: "orchestration", orchestrationRunId: "run" });
  h.onTick = () => { if (h.ticks === 3) h.jobs[0].completionPending = false; assert.equal(h.mutations, 0); };
  await h.run();
  assert.equal(h.ticks, 3); assert.equal(h.mutations, 1);
  assert.deepEqual(h.stops().map(({ url }) => url), ["/api/agents/jobs/old"]);
  assert.equal(h.stops()[0].options.headers["X-Argus-Cancel-Control"], scope === "global" ? "global-prompt-edit" : "repository-prompt-edit");
  assert.deepEqual(h.progress, ["Stopping current response…", "Updating this chat…"]);
});

test("paused jobs are active; unknown status or missing completion flag never implies idle", async () => {
  const h = harness({ status: "paused" }); await h.run(); assert.equal(h.stops().length, 1);
  for (const job of [{ status: "mystery", completionPending: false }, { status: "cancelled" }, { status: "completed", completionPending: true }]) assert.equal(revisionJobIsBusy(job), true);
  assert.equal(revisionJobIsBusy({ status: "completed", completionPending: false }), false);
});

test("idle chats revise without any stop", async () => {
  const h = harness({ status: "completed" }); await h.run();
  assert.equal(h.stops().length, 0); assert.equal(h.mutations, 1);
});

test("durable queued prompts and in-flight queue work reject before any cancellation", async () => {
  for (const kind of ["durable", "local", "enqueue-race"]) {
    const h = harness();
    if (kind === "durable") h.queue = [{ requestId: "queued" }];
    if (kind === "local") h.queuedWork = true;
    if (kind === "enqueue-race") h.onApi = async (url) => { if (url.startsWith("/api/agents/jobs?")) h.queuedWork = true; };
    await assert.rejects(h.run(), /queued prompts/); assert.equal(h.stops().length, 0); assert.equal(h.mutations, 0);
  }
});

test("pre-registration preparation cancellation is repeated through launch handoff and drain", async () => {
  const h = harness(); h.jobs = [];
  const submission = h.submission = { taskId: "task", requestId: "preparing" };
  let cancellations = 0;
  h.onApi = async (url) => {
    if (url === "/api/agents/preparations/preparing") {
      cancellations++;
      if (cancellations >= 3) {
        h.submission = null;
        if (!h.jobs.length) h.jobs = [{ id: "handoff", taskId: "task", repositoryId: "repo", status: "cancelled", completionPending: true }];
      }
      return { ok: true, cancellation: cancellations < 3 ? {} : { preparationId: "preparing" } };
    }
  };
  await h.run();
  assert.equal(submission.cancelled, true); assert.ok(cancellations >= 3);
  assert.ok(h.stops().every(({ url }) => url === "/api/agents/preparations/preparing"));
  assert.equal(h.mutations, 1); assert.equal(h.jobs[0].completionPending, false);
});

test("stop failure and timeout never fork, and cancellation does not touch unrelated submissions", async () => {
  const failed = harness();
  const unrelated = failed.submission = { taskId: "different", requestId: "unrelated" };
  failed.onApi = async (_url, options) => { if (options.method === "DELETE") throw new Error("Cannot stop"); };
  await assert.rejects(failed.run(), /Cannot stop/); assert.equal(failed.mutations, 0); assert.equal(unrelated.cancelled, undefined);
  const timeout = harness(); timeout.onTick = () => {};
  await assert.rejects(timeout.run(), /still stopping/); assert.equal(timeout.mutations, 0);
});

test("a disappearing unacknowledged preparation cannot race a delayed POST into a revision", async () => {
  const h = harness(); h.jobs = []; h.submission = { taskId: "task", requestId: "delayed" };
  h.onApi = async (url) => {
    if (url === "/api/agents/preparations/delayed") { h.submission = null; return { ok: true, cancellation: {} }; }
  };
  await assert.rejects(h.run(), /still stopping/); assert.equal(h.mutations, 0);
});

test("missing captured jobs and a new response cannot be mistaken for successful stop", async () => {
  for (const kind of ["missing", "new-response"]) {
    const h = harness(); h.onTick = () => {
      h.jobs = kind === "missing" ? [] : [{ ...h.jobs[0], status: "cancelled", completionPending: false },
        { id: "new-job", taskId: "task", repositoryId: "repo", status: "running", completionPending: false }];
    };
    await assert.rejects(h.run(), /still stopping/);
    assert.equal(h.mutations, 0); assert.ok(h.stops().every(({ url }) => url.endsWith("/old")));
  }
});

test("navigation during a stop never cancels the new chat or forks in it", async () => {
  const h = harness(); h.onTick = () => { h.current = false; h.jobs[0].completionPending = false; };
  await assert.rejects(h.run(), /original chat/); assert.equal(h.mutations, 0); assert.equal(h.stops().length, 1);
});

test("new durable queue found after stopping blocks revision without deleting queued prompts", async () => {
  const h = harness(); h.onTick = () => { h.queue = [{ requestId: "new" }]; h.jobs[0].completionPending = false; };
  await assert.rejects(h.run(), /queued prompts/); assert.equal(h.mutations, 0);
  assert.equal(h.queue.length, 1);
});

test("only the known pre-mutation activity-lease 409 is retried", async () => {
  const h = harness({ status: "completed" });
  h.onMutate = () => { if (h.mutations < 3) throw Object.assign(new Error("Wait for the task's response to finish before changing or sending a prompt"), { status: 409 }); return {}; };
  await h.run(); assert.equal(h.mutations, 3); assert.equal(h.stops().length, 0);
  for (const error of [new Error("Connection lost"), Object.assign(new Error("Request content changed"), { status: 409 })]) {
    const rejected = harness({ status: "completed" }); rejected.onMutate = () => { throw error; };
    await assert.rejects(rejected.run(), error); assert.equal(rejected.mutations, 1);
  }
});

test("invalid job/queue responses fail closed before any mutation", async () => {
  for (const endpoint of ["/api/prompt-queue?", "/api/agents/jobs?"]) {
    const h = harness(); h.onApi = async (url) => url.startsWith(endpoint) ? {} : undefined;
    await assert.rejects(h.run(), /Could not check/); assert.equal(h.mutations, 0); assert.equal(h.stops().length, 0);
  }
});
