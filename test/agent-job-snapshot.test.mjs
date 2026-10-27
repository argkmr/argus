import test from "node:test";
import assert from "node:assert/strict";
import { mergeAgentJob, reconcileAgentJob } from "../public/agent-job-snapshot.mjs";

const job = (overrides = {}) => ({ id: "job-a", status: "running", cliSessionFallback: false,
  output: "first", outputCursor: 5, error: "", errorCursor: 0, displayOutput: "First answer", ...overrides });

test("fresh full snapshots and intentionally empty safe projections replace old output", () => {
  const before = job(), after = job({ output: "firstmore", outputCursor: 9, displayOutput: "" });
  assert.deepEqual(reconcileAgentJob(before, after), after);
  assert.equal(reconcileAgentJob(before, after).displayOutput, "");
});

test("delayed full lists cannot rewind either output stream", () => {
  const newer = job({ output: "firstmore", outputCursor: 9, displayOutput: "New answer" });
  assert.equal(reconcileAgentJob(newer, job()), newer);
  const errors = job({ error: "warning", errorCursor: 7 });
  assert.equal(reconcileAgentJob(errors, job()), errors);
});

test("a completed job cannot go back to running, starting or finalizing at the same cursors", () => {
  const done = job({ status: "completed", completionPending: false });
  for (const status of ["starting", "running", "paused"])
    assert.equal(reconcileAgentJob(done, job({ status })), done);
  assert.equal(reconcileAgentJob(done, job({ status: "completed", completionPending: true })), done);
  const finishing = job({ status: "completed", completionPending: true });
  assert.equal(reconcileAgentJob(finishing, job()), finishing);
  assert.equal(reconcileAgentJob(finishing, done).completionPending, false);
});

test("cancellation remains irreversible while accepting its drained stdout", () => {
  const stopped = job({ status: "cancelled", stopRequested: true, completionPending: true });
  assert.equal(reconcileAgentJob(stopped, job({ status: "completed", completionPending: false })), stopped);
  const drained = { ...stopped, output: "first!", outputCursor: 6, completionPending: false };
  assert.deepEqual(reconcileAgentJob(stopped, drained), drained);
  assert.equal(reconcileAgentJob(stopped, job({ cliSessionFallback: true })), stopped);
  const finished = job({ status: "completed", completionPending: false });
  assert.equal(reconcileAgentJob(finished, job({ cliSessionFallback: true })), finished);
});

test("delta responses append against the captured base without duplicating overlapping output", () => {
  const base = job();
  const current = job({ output: "firstAB", outputCursor: 7, displayOutput: "Intermediate" });
  const update = job({ output: "ABCD", outputCursor: 9, outputReset: false, errorReset: false, displayOutput: "Latest" });
  const merged = mergeAgentJob(current, update, base);
  assert.equal(merged.output, "firstABCD");
  assert.equal(merged.outputCursor, 9);
  assert.equal(merged.displayOutput, "Latest");
  assert.equal(mergeAgentJob(merged, update).output, "firstABCD");
});

test("a delayed delta cannot roll back a newer full snapshot or terminal status", () => {
  const base = job();
  const current = job({ output: "firstABCD", outputCursor: 9, displayOutput: "Latest" });
  const oldDelta = job({ output: "AB", outputCursor: 7, outputReset: false, displayOutput: "Old" });
  assert.equal(mergeAgentJob(current, oldDelta, base), current);
  const done = { ...base, status: "completed", completionPending: false };
  assert.equal(mergeAgentJob(done, { ...base, output: "", outputReset: false }, base), done);
});

test("reset responses replace bounded tails instead of duplicating them", () => {
  const base = job();
  const update = job({ output: "tail", outputCursor: 99, outputReset: true,
    error: "errtail", errorCursor: 51, errorReset: true });
  const merged = mergeAgentJob(base, update);
  assert.equal(merged.output, "tail");
  assert.equal(merged.error, "errtail");
});

test("missing-session fallback starts a new attempt even when its cursors go backwards", () => {
  const first = job({ output: "failed resume", outputCursor: 13, error: "missing session", errorCursor: 15 });
  const retry = job({ cliSessionFallback: true, status: "starting", output: "", outputCursor: 0,
    error: "", errorCursor: 0, outputReset: true, errorReset: true, displayOutput: "" });
  const merged = mergeAgentJob(first, retry, first);
  assert.equal(merged.output, "");
  assert.equal(merged.error, "");
  assert.equal(merged.displayOutput, "");
  assert.equal(merged.status, "starting");
  assert.equal(reconcileAgentJob(merged, first), merged);
  assert.equal(mergeAgentJob(merged, first, first), merged);
  assert.equal(reconcileAgentJob(first, retry).cliSessionFallback, true);
});

test("fallback stream never receives a prefix from the failed attempt", () => {
  const first = job();
  const retry = job({ cliSessionFallback: true, output: "new", outputCursor: 3, displayOutput: "New attempt" });
  assert.equal(mergeAgentJob(first, retry, first).output, "new");
});

test("jobs remain independent and missing optional snapshots are harmless", () => {
  const before = job(), other = job({ id: "job-b" });
  assert.equal(reconcileAgentJob(before, other), other);
  assert.equal(mergeAgentJob(before, other, before), other);
  assert.equal(reconcileAgentJob(null, before), before);
  assert.equal(mergeAgentJob(null, before), before);
  assert.equal(reconcileAgentJob(before, null), before);
});

test("tails remain bounded, gaps are not filled with duplicated or invented text", () => {
  const base = job({ output: "a".repeat(500_000), outputCursor: 500_000 });
  const result = mergeAgentJob(base, job({ output: "xyz", outputCursor: 500_003, outputReset: false }));
  assert.equal(result.output.length, 500_000);
  assert.ok(result.output.endsWith("xyz"));
  const gap = mergeAgentJob(job(), job({ output: "xyz", outputCursor: 20, outputReset: false }));
  assert.equal(gap.output, "xyz");
});

test("equal-cursor newer completion metadata is applied without requiring more output", () => {
  const base = job();
  const update = job({ output: "", error: "", outputReset: false, errorReset: false,
    status: "completed", completionPending: true, displayOutput: "Final without newline", tokenUsage: { reported: true } });
  const result = mergeAgentJob(base, update, base);
  assert.equal(result.output, "first");
  assert.equal(result.displayOutput, "Final without newline");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.tokenUsage, { reported: true });
});
