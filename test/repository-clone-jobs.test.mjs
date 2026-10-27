import assert from "node:assert/strict";
import test from "node:test";
import { createRepositoryCloneJobs } from "../public/repository-clone-jobs.mjs";

test("long clones use short status reads and preserve final branch selection", async () => {
  const calls = [], updates = [];
  const result = { repository: { path: "/fixture/repo", branches: ["main"] } };
  let ticks = 0;
  const client = createRepositoryCloneJobs({ api: async (path, options) => {
    calls.push({ path, options });
    return { id: "one", status: ++ticks < 140 ? "running" : "completed", result };
  }, delay: async () => {} });
  assert.equal(await client.wait({ id: "one", status: "queued" }, job => updates.push(job.status)), result);
  assert.equal(calls.length, 140);
  assert.ok(calls.every(call => call.path.endsWith("/one") && !call.options.method));
  assert.equal(updates.at(-1), "completed");
});

test("lost create response retries the same request id", async () => {
  const ids = []; let sequence = 0;
  const client = createRepositoryCloneJobs({ randomId: () => String(++sequence), api: async (_path, options) => {
    ids.push(options.body.requestId);
    if (ids.length === 1) throw new Error("network lost");
    return { id: "saved" };
  } });
  const input = { remoteUrl: "https://example.test/repo.git", destinationPath: "/fixture" };
  await assert.rejects(client.start(input), /network lost/);
  await client.start(input);
  await client.start(input);
  assert.deepEqual(ids, ["1", "1", "2"]);
});

test("status network failure retains the backend job id for recovery without cloning again", async () => {
  const client = createRepositoryCloneJobs({ delay: async () => {}, api: async () => { throw new Error("offline"); } });
  await assert.rejects(client.wait({ id: "saved", status: "running" }), error => error.jobId === "saved" && /Resume status/.test(error.message));
});

test("failed/cancelled/interrupted jobs stop polling and completed jobs resume immediately", async () => {
  const client = createRepositoryCloneJobs({ api: () => { throw new Error("unexpected poll"); } });
  for (const status of ["failed", "cancelled", "interrupted"]) {
    await assert.rejects(client.wait({ id: "saved", status, error: "Actionable reason" }), error => error.terminal && error.message === "Actionable reason");
  }
  const result = { repository: { path: "/fixture/repo" } };
  assert.equal(await client.wait({ id: "saved", status: "completed", result }), result);
});
