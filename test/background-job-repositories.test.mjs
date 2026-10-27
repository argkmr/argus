import assert from "node:assert/strict";
import test from "node:test";
import { kitJob, renderJob, renderRepositories } from "./helpers/background-job-markup.mjs";

test("completed AI-kit cards show every prepared repository outside collapsed logs", () => {
  const job = kitJob(), html = renderJob(job);
  for (const { name } of job.items) assert.ok(html.indexOf(name) < html.indexOf('<details class="background-job-logs"'));
  assert.equal((html.match(/class="background-job-repository-status ready">Ready/g) || []).length, 3);
  assert.match(html, /<section class="background-job-repositories" aria-label="Repository AI kits">/);
  assert.doesNotMatch(html, /data-background-job-logs="fixture-kit" open/);
});

test("mixed outcomes do not label failed, pending, or unknown repositories as ready", () => {
  const statuses = ["completed", "running", "queued", "failed", "paused", "cancelled", "interrupted", "constructor", "<script>"];
  const html = renderRepositories(kitJob({ status: "running", items: statuses.map((status, index) => ({ name: `Repository ${index}`, status })) }));
  for (const label of ["Ready", "Preparing", "Queued", "Failed", "Paused", "Cancelled", "Interrupted", "Status unavailable"]) assert.ok(html.includes(`>${label}</span>`), label);
  assert.equal((html.match(/>Ready<\/span>/g) || []).length, 1);
  assert.doesNotMatch(html, /<script>|native code/);
});

test("paused and terminated batches retain finished results without phantom active work", () => {
  for (const [status, expected] of [
    ["paused", ["Ready", "Paused", "Queued", "Failed"]],
    ["failed", ["Ready", "Interrupted", "Not started", "Failed"]],
    ["interrupted", ["Ready", "Interrupted", "Not started", "Failed"]],
    ["cancelled", ["Ready", "Cancelled", "Cancelled", "Failed"]],
    ["completed-with-errors", ["Ready", "Interrupted", "Not started", "Failed"]],
  ]) {
    const html = renderRepositories(kitJob({ status, items: ["completed", "running", "queued", "failed"].map((status, index) => ({ name: `Repo ${index}`, status })) }));
    assert.deepEqual([...html.matchAll(/class="background-job-repository-status \w+">([^<]+)/g)].map(match => match[1]), expected);
  }
});

test("names are escaped, never truncated or dependent on the current connected repository list", () => {
  const longName = "a-long-repository-name-".repeat(12);
  const html = renderRepositories(kitJob({ items: [
    { name: '<img src=x onerror="alert(1)"> & repo', status: "completed" },
    { name: longName, status: "completed" },
    { repositoryId: "offboarded-repo-id", status: "completed" },
    null, {}, { name: " ", repositoryId: "" },
  ] }));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; repo/);
  assert.ok(html.includes(longName));
  assert.ok(html.includes("offboarded-repo-id"));
  assert.doesNotMatch(html, /<img/);
  assert.equal((html.match(/<li>/g) || []).length, 3);
});

test("missing legacy data and unrelated background jobs never invent prepared repositories", () => {
  for (const items of [undefined, null, {}, []]) assert.equal(renderRepositories(kitJob({ items })), "");
  for (const type of ["backup-sync", "repository-onboarding", "repository-offboarding", "embedding-runtime-install"]) assert.equal(renderRepositories(kitJob({ type })), "");
  for (const type of ["knowledge-rebuild", "repository-knowledge-rebuild"]) assert.match(renderRepositories(kitJob({ type })), /checkout-api/);
});
