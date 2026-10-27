import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { renderRepositoryContextSummary } from "../public/repository-context-bar.mjs";

function harness() {
  const ids = ["context-repo", "context-branch", "context-change-count", "context-repository-item", "context-branch-item", "context-changes-item"];
  const nodes = Object.fromEntries(ids.map(id => [id, { textContent: "", attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); } }]));
  return { nodes, document: { querySelector: selector => nodes[selector.slice(1)] || null } };
}

test("compact context keeps complete branch and repository identity in hover and accessible descriptions", () => {
  const h = harness(), repository = { name: "A long repository name", path: "/synthetic/customer-facing-web" };
  const branch = "feature/a-long-branch-name-that-can-be-visually-truncated";
  renderRepositoryContextSummary(h.document, { repository, branch, changeCount: 12 });
  assert.equal(h.nodes["context-repo"].textContent, repository.name);
  assert.equal(h.nodes["context-branch"].textContent, branch);
  assert.equal(h.nodes["context-branch-item"].title, `Current branch: ${branch}`);
  assert.equal(h.nodes["context-branch-item"].attributes.get("aria-label"), `Current branch: ${branch}`);
  assert.equal(h.nodes["context-repository-item"].title, `${repository.name} · isolated chat context\n${repository.path}`);
  assert.equal(h.nodes["context-change-count"].textContent, "12");
  assert.equal(h.nodes["context-changes-item"].title, "12 changed files");
  assert.equal(h.nodes["context-changes-item"].attributes.get("data-change-state"), "changed");
});

test("loading, detached HEAD, and zero changes have truthful descriptions", () => {
  const h = harness();
  renderRepositoryContextSummary(h.document);
  assert.equal(h.nodes["context-branch"].textContent, "Loading…");
  assert.equal(h.nodes["context-change-count"].textContent, "—");
  assert.equal(h.nodes["context-changes-item"].title, "Checking changed files…");
  assert.equal(h.nodes["context-changes-item"].attributes.get("data-change-state"), "unknown");
  renderRepositoryContextSummary(h.document, { branch: "abc1234", changeCount: 0, detached: true });
  assert.equal(h.nodes["context-branch-item"].title, "Detached HEAD: abc1234");
  assert.equal(h.nodes["context-changes-item"].title, "0 changed files");
  assert.equal(h.nodes["context-changes-item"].attributes.get("data-change-state"), "clean");
  renderRepositoryContextSummary(h.document, { changeCount: 1 });
  assert.equal(h.nodes["context-changes-item"].title, "1 changed file");
  renderRepositoryContextSummary(h.document, { changeCount: Number.NaN });
  assert.equal(h.nodes["context-change-count"].textContent, "—");
});

test("untrusted names remain text and partial shells are supported", () => {
  const h = harness(), name = '<img src=x onerror="bad()">';
  renderRepositoryContextSummary(h.document, { repository: { name }, branch: "<script>bad()</script>", changeCount: 3 });
  assert.equal(h.nodes["context-repo"].textContent, name);
  assert.equal(h.nodes["context-repo"].innerHTML, undefined);
  assert.doesNotThrow(() => renderRepositoryContextSummary({ querySelector: () => null }));
});

test("context overrides load after responsive shell styles and preserve compact actions", async () => {
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../public/repository-context-bar.css", import.meta.url), "utf8");
  assert.ok(html.indexOf('/repository-context-bar.css') > html.indexOf('/repository-ports.css'));
  assert.match(css, /--repository-context-height:\s*38px/);
  assert.match(css, /\.context-strip > div:is\(\.context-repository, \.context-stat\)/);
  assert.match(html, /id="context-branch-item"[^>]*>[\s\S]*?aria-hidden="true"/);
  assert.match(html, /id="repository-chat-toggle"[^>]*aria-label="Hide AI chat"[^>]*aria-controls="repository-ai-chat"[^>]*><svg/);
  assert.match(html, /id="repository-ai-chat" class="ai-main-content"/);
  assert.doesNotMatch(html, /id="repository-ide-toggle"/);
});
