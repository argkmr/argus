import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function source(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(app);
  assert(match, name);
  return app.slice(match.index, app.indexOf("\n}", match.index) + 2);
}
function harness(extra = {}) {
  const context = vm.createContext({ ...extra });
  vm.runInContext(["cancellationSummary", "cancellationDetail", "mergeCancellationLogs", "orchestrationMessageActivity"].map(source).join("\n"), context);
  return context;
}
const audit = { id: "b5267e47-8a4c-41b5-8e9d-f09ed0e9a260", cause: "job_stop_request", reportedControl: "global-composer-stop", attribution: "reported_ui_context", requestedAt: "2026-09-07T09:00:00Z", route: "DELETE /api/agents/jobs/{id}", jobId: "job-one", runId: "run-one" };

test("cancellation labels identify a reported control without inventing a person", () => {
  const h = harness();
  assert.match(h.cancellationSummary(audit), /Nexus chat Stop button/);
  assert.match(h.cancellationSummary(audit), /person not verified/);
  assert.match(h.cancellationDetail(audit), /not an authenticated person/);
  assert.match(h.cancellationSummary(null), /not recorded/);
  assert.match(h.cancellationSummary({ cause: "application_shutdown", attribution: "internal" }), /^Argus shutdown\.$/);
});

test("diagnostics retain durable audit and don't hide a failed audit write", () => {
  const h = harness();
  const session = [
    { id: "mirror", category: "agents", operation: "cancellation", status: "requested", output: `id=${audit.id}`, timestamp: audit.requestedAt },
    { id: "failed-write", category: "agents", operation: "cancellation", status: "audit-write-failed", error: "Cancellation audit persistence failed", timestamp: "2026-09-07T09:00:01Z" },
    { id: "unpersisted", category: "agents", operation: "cancellation", status: "requested", output: "older-than-requested-audit-page", timestamp: "2026-09-07T08:00:00Z" },
  ];
  const result = h.mergeCancellationLogs(session, [audit]);
  assert.equal(result.length, 3);
  assert.equal(result[0].id, "failed-write");
  assert.equal(result[0].category, "cancellation");
  assert.equal(result.find(item => item.id === audit.id).persistedCancellation, true);
  assert.equal(result.some(item => item.id === "mirror"), false);
  assert.equal(result.some(item => item.id === "unpersisted"), true);
});

test("cancelled and legacy incomplete output is never labelled a completed handoff", () => {
  const h = harness();
  const message = { id: "m1", from: "prboi", content: "I am now reviewing the changed files." };
  for (const status of ["cancelled", "failed", "running"]) {
    const result = h.orchestrationMessageActivity(message, [{ id: "n1", handle: "prboi", status }]);
    assert.equal(result.kind, "partial_output");
    assert.equal(result.status, status);
    assert.match(result.detail, /not a completed review/);
  }
  assert.equal(h.orchestrationMessageActivity(message, []).kind, "partial_output");
  assert.equal(h.orchestrationMessageActivity({ ...message, status: "completed" }, []).kind, "handoff");
});

test("composer stop carries scope attribution; no person or prompt is sent", async () => {
  for (const scope of ["global", "repository"]) {
    const calls = [];
    const h = harness({
      composerSubmission: () => null, runningAgentJob: () => ({ id: "job-one" }),
      $: () => ({ classList: { add() {}, remove() {} } }),
      api: async (url, options) => calls.push({ url, options }),
      pollGlobalAgent: async () => {}, pollAgent: async () => {}, toast() {},
    });
    vm.runInContext(source("stopAgent"), h);
    await h.stopAgent(scope);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "DELETE");
    assert.equal(calls[0].options.headers["X-Argus-Cancel-Control"], `${scope === "global" ? "global" : "repository"}-composer-stop`);
    assert.equal(calls[0].options.body, undefined);
  }
  assert.match(app, /\/cancel`[^\n]+"X-Argus-Cancel-Control": "orchestration-stop-run"/);
});

test("clearing session diagnostics preserves retained cancellation records", async () => {
  const state = { diagnosticLogs: [{ id: "retained", persistedCancellation: true }, { id: "session" }] };
  const calls = [];
  const h = harness({ state, api: async (...args) => calls.push(args), renderDiagnostics() {}, toast() {} });
  vm.runInContext(source("clearDiagnostics"), h);
  await h.clearDiagnostics();
  assert.equal(state.diagnosticLogs.length, 1);
  assert.equal(state.diagnosticLogs[0].id, "retained");
  assert.equal(calls[0][0], "/api/activity/logs");
});
