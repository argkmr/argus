import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { renderRepositoryContextSummary } from "../public/repository-context-bar.mjs";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(write = async () => {}) {
  const state = { activeRepository: { id: "repo-a" }, gitStatus: null };
  const elements = new Map(), writes = [], notices = [], timers = [];
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        dataset: {}, attributes: {}, disabled: true, title: "", textContent: "",
        classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
        setAttribute(name, value) { this.attributes[name] = value; },
      });
    }
    return elements.get(selector);
  };
  const context = vm.createContext({
    state, $: element, document: { querySelector: element }, renderRepositoryContextSummary, renderGitSyncState() {},
    navigator: { clipboard: { writeText: async value => { writes.push(value); await write(value); } } },
    toast: (message, type) => notices.push({ message, type }),
    setTimeout: callback => timers.push(callback),
  });
  vm.runInContext(["renderBranchCopyButton", "copyCurrentBranchName", "renderGitHeader"].map(declaration).join("\n"), context);
  const render = branch => {
    state.gitStatus = { branch, files: [] };
    context.renderGitHeader(state.gitStatus);
  };
  return { state, context, element, render, writes, notices, timers, button: element("#copy-branch-button"), feedback: element("#branch-copy-status") };
}

test("branch copy is a separate named keyboard button with live feedback, not a branch-switch action", () => {
  assert.match(html, /id="branch-selector"[^]*?<\/button>\s*<button id="copy-branch-button" type="button" title="Copy branch name" aria-label="Copy branch name" disabled>/);
  assert.match(html, /id="branch-copy-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source, /\$\("#copy-branch-button"\)\.addEventListener\("click", copyCurrentBranchName\)/);
  assert.doesNotMatch(declaration("copyCurrentBranchName"), /gitAction|openBranchSelector|\bapi\(/);
  for (const name of ["resetTabSurface", "refreshActiveRepository"]) {
    assert.match(declaration(name), /\$\("#branch-name"\)\.textContent = "Loading…";\s*renderBranchCopyButton\(\)/);
  }
});

test("copies full literal branch name, confirms only after success, and resets without layout text", async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  const branch = "feat/very-long-branch-that-is-visually-truncated-<&>-日本語";
  h.render(branch);
  h.element("#branch-name").textContent = "feat/very-long…";
  const copying = h.context.copyCurrentBranchName();
  assert.deepEqual(h.writes, [branch]);
  assert.equal(h.button.disabled, true);
  assert.equal(h.button.classList.contains("copied"), false);
  await h.context.copyCurrentBranchName();
  assert.equal(h.writes.length, 1, "pending writes are not duplicated");
  pending.resolve(); await copying;
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.classList.contains("copied"), true);
  assert.equal(h.button.title, "Copied");
  assert.equal(h.button.attributes["aria-label"], "Branch name copied");
  assert.equal(h.feedback.textContent, "Branch name copied");
  h.render(branch);
  assert.equal(h.button.classList.contains("copied"), true, "status polling must not erase confirmation");
  h.timers[0]();
  assert.equal(h.button.classList.contains("copied"), false);
  assert.equal(h.button.title, "Copy branch name");
  assert.equal(h.feedback.textContent, "");
});

test("loading, missing status and stale repository state never copy a placeholder or previous repo", async () => {
  const h = harness();
  h.context.renderBranchCopyButton();
  await h.context.copyCurrentBranchName();
  assert.equal(h.button.disabled, true);
  h.render("main");
  h.state.activeRepository = { id: "repo-b" };
  await h.context.copyCurrentBranchName();
  h.context.renderBranchCopyButton();
  await h.context.copyCurrentBranchName();
  h.render("develop");
  h.state.gitStatus = null;
  await h.context.copyCurrentBranchName();
  assert.deepEqual(h.writes, []);
});

test("failed or unavailable clipboard shows an error, stays retryable and never claims success", async () => {
  for (const missing of [false, true]) {
    let fails = true;
    const h = harness(async () => { if (fails) throw Error("denied"); });
    h.render("main");
    const clipboard = h.context.navigator.clipboard;
    if (missing) h.context.navigator.clipboard = undefined;
    await h.context.copyCurrentBranchName();
    assert.equal(h.button.disabled, false);
    assert.equal(h.button.classList.contains("copied"), false);
    assert.equal(h.button.title, "Copy branch name");
    assert.match(h.feedback.textContent, /Could not copy/);
    assert.equal(h.notices[0].type, "error");
    assert.equal(h.timers.length, 0);
    fails = false; h.context.navigator.clipboard = clipboard;
    await h.context.copyCurrentBranchName();
    assert.equal(h.button.classList.contains("copied"), true);
  }
});

test("late clipboard completion cannot change the new repository or branch feedback", async () => {
  for (const reject of [false, true]) {
    const pending = deferred(), h = harness(() => pending.promise);
    h.render("main");
    const copying = h.context.copyCurrentBranchName();
    h.state.activeRepository = { id: "repo-b" };
    h.context.renderBranchCopyButton();
    h.render("main");
    if (reject) pending.reject(Error("denied")); else pending.resolve();
    await copying;
    assert.equal(h.button.classList.contains("copied"), false);
    assert.equal(h.button.title, "Copy branch name");
    assert.equal(h.button.disabled, false);
    assert.equal(h.feedback.textContent, "");
    assert.equal(h.notices.length, 0);
  }
});

test("old confirmation timers do not erase feedback from a newer copy or branch", async () => {
  const h = harness();
  h.render("main"); await h.context.copyCurrentBranchName();
  h.render("feature/new"); await h.context.copyCurrentBranchName();
  h.timers[0]();
  assert.equal(h.button.classList.contains("copied"), true);
  assert.equal(h.feedback.textContent, "Branch name copied");
  h.timers[1]();
  assert.equal(h.button.title, "Copy branch name");
  assert.deepEqual(h.writes, ["main", "feature/new"]);
});

test("a repeated copy resets success labels while the new clipboard write is pending", async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness(() => ++calls === 1 ? Promise.resolve() : pending.promise);
  h.render("main"); await h.context.copyCurrentBranchName();
  const copying = h.context.copyCurrentBranchName();
  assert.equal(h.button.title, "Copying branch name…");
  assert.equal(h.button.attributes["aria-label"], "Copying branch name…");
  h.timers[0]();
  assert.equal(h.button.title, "Copying branch name…");
  pending.resolve(); await copying;
  assert.equal(h.button.title, "Copied");
});

test("detached HEAD cannot copy a placeholder but a real branch named detached can", async () => {
  const h = harness();
  h.state.gitStatus = { branch: "detached", detached: true, files: [] };
  h.context.renderGitHeader(h.state.gitStatus);
  await h.context.copyCurrentBranchName();
  assert.equal(h.button.disabled, true);
  assert.deepEqual(h.writes, []);
  h.state.gitStatus.detached = false;
  h.context.renderGitHeader(h.state.gitStatus);
  await h.context.copyCurrentBranchName();
  assert.deepEqual(h.writes, ["detached"]);
});
