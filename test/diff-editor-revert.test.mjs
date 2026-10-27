import test from "node:test";
import assert from "node:assert/strict";
import { renderDiffNavigationCode } from "../public/diff-navigation.mjs";
import fs from "node:fs";
import vm from "node:vm";
import { parseUnifiedDiff, expandToFullFile } from "../public/diff-parser.js";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  const remaining = source.slice(start + 1);
  const end = remaining.search(/\n(?:async )?function \w+\(/);
  return source.slice(start, end < 0 ? undefined : start + 1 + end);
}

function harness({ staged = false, dirty = false, allowed = true, confirm = true } = {}) {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      disabled: false, readOnly: false, textContent: "", title: "", open: true,
      value: dirty ? "unsaved editor work" : "working bytes",
      classList: { contains: name => name === "hidden" && !dirty },
      close() { this.open = false; },
    });
    return elements.get(selector);
  };
  const editor = { repositoryId: "repo-a", repositoryName: "Repo A", file: "client/build.gradle", staged, busy: false,
    snapshot: { content: "working bytes", contentHash: "file-hash" }, changes: [{ id: "block-one", beforeStart: 2, beforeCount: 1, afterStart: 2, afterCount: 2 }, { id: "block-two", beforeStart: 8, beforeCount: 1, afterStart: 9, afterCount: 1 }], revert: { allowed, reason: allowed ? "" : "Untracked files cannot be reverted", revision: "view-revision" } };
  const calls = [], pending = [], messages = [], confirmations = [], refreshes = [], diffLoads = [];
  const controls = [{ disabled: false }, { disabled: false }];
  const state = { activeRepository: { id: "repo-a" }, diffEditor: editor };
  const context = vm.createContext({ state, $, renderDiffNavigationCode, document: { querySelectorAll: () => controls }, confirm: message => { confirmations.push(message); return confirm; },
    api: (url, options) => { calls.push({ url, options }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    toast: (...args) => messages.push(args), refreshActiveRepository: async () => refreshes.push(state.activeRepository.id),
    showDiff: async (...args) => { diffLoads.push(args); }, escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;") });
  vm.runInContext(["diffEditIsDirty", "setDiffBusy", "revertDiffChanges", "revertDiffChange", "renderDiffSide", "closeDiffDialog"].map(declaration).join("\n"), context);
  return { context, state, editor, $, calls, pending, messages, confirmations, refreshes, controls, diffLoads };
}

test("revert requires confirmation and server eligibility", async () => {
  for (const options of [{ confirm: false }, { allowed: false }]) {
    const h = harness(options); await h.context.revertDiffChanges();
    assert.equal(h.calls.length, 0); assert.equal(h.state.diffEditor, h.editor);
  }
});

test("unstaged revert submits only the captured file/view revision and refreshes after success", async () => {
  const h = harness(); const request = h.context.revertDiffChanges();
  assert.match(h.confirmations[0], /Already-staged changes will be kept/);
  assert.match(h.confirmations[0], /local recovery copy/);
  assert.equal(h.calls[0].url, "/api/repositories/repo-a/git/revert");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].options)), { method: "POST", body: { file: "client/build.gradle", staged: false, expectedRevision: "view-revision" } });
  assert.equal(h.$("#diff-editor-text").readOnly, true);
  assert.equal(h.$("#diff-save-file").disabled, true);
  h.pending[0].resolve({ ok: true }); await request;
  assert.equal(h.$("#diff-dialog").open, false);
  assert.equal(h.state.diffEditor, null); assert.deepEqual(h.refreshes, ["repo-a"]);
});

test("staged revert is labelled as unstage and explicitly preserves the working file", async () => {
  const h = harness({ staged: true, dirty: true }); h.context.setDiffBusy(false);
  assert.equal(h.$("#diff-revert-file").textContent, "Unstage changes");
  const request = h.context.revertDiffChanges();
  assert.match(h.confirmations[0], /staged index entry to HEAD/);
  assert.match(h.confirmations[0], /working file will be kept unchanged/);
  assert.match(h.confirmations[0], /unsaved editor text will also be discarded/);
  assert.equal(h.calls[0].options.body.staged, true);
  h.pending[0].resolve({ ok: true }); await request;
});

test("pending revert blocks duplicate actions and closing the editor", async () => {
  const h = harness(); const request = h.context.revertDiffChanges();
  await h.context.revertDiffChanges(); h.context.closeDiffDialog();
  assert.equal(h.calls.length, 1); assert.equal(h.$("#diff-dialog").open, true);
  h.pending[0].resolve({ ok: true }); await request;
});

test("stale revision keeps the editor buffer and does not retry the destructive request", async () => {
  const h = harness({ dirty: true }); const request = h.context.revertDiffChanges();
  h.pending[0].reject(new Error("File changed; reopen the diff before reverting")); await request;
  assert.equal(h.calls.length, 1); assert.equal(h.state.diffEditor, h.editor);
  assert.equal(h.$("#diff-editor-text").value, "unsaved editor work");
  assert.equal(h.$("#diff-dialog").open, true); assert.equal(h.editor.busy, false);
  assert.equal(h.$("#diff-editor-text").readOnly, false);
  assert.match(h.messages[0][0], /File changed/);
});

test("completion cannot close or refresh a different repository's editor", async () => {
  const h = harness(); const request = h.context.revertDiffChanges();
  const other = { repositoryId: "repo-b", busy: false };
  h.state.diffEditor = other; h.state.activeRepository = { id: "repo-b" };
  h.pending[0].resolve({ ok: true }); await request;
  assert.equal(h.state.diffEditor, other); assert.equal(h.$("#diff-dialog").open, true);
  assert.deepEqual(h.refreshes, []);
});

test("unsafe or outdated diff capability keeps revert visibly disabled with a reason", () => {
  const h = harness({ allowed: false }); h.context.setDiffBusy(false);
  assert.equal(h.$("#diff-revert-file").disabled, true);
  assert.match(h.$("#diff-revert-file").title, /Untracked/);
  delete h.editor.revert; h.context.setDiffBusy(false);
  assert.equal(h.$("#diff-revert-file").disabled, true);
  assert.match(h.$("#diff-revert-file").title, /Reopen/);
});

test("diff toolbar wiring retains compact controls and rejects stale diff loads", () => {
  assert.match(source, /id="diff-revert-file" class="diff-edit-button diff-revert-button"/);
  assert.match(source, /event\.target\.matches\("#diff-revert-file"\)\) revertDiffChanges\(\)/);
  assert.match(source, /state\.diffLoadSequence !== loadSequence \|\| state\.activeRepository\?\.id !== repository\.id/);
  const { argusBuild } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(source.includes(`from "./diff-parser.js?v=${argusBuild}"`));
  assert.ok(source.includes(`from "./backup-form.js?v=${argusBuild}"`));
});

test("inline revert submits only the chosen server block and keeps the diff open", async () => {
  const h = harness(); const request = h.context.revertDiffChange("block-two");
  assert.match(h.confirmations[0], /Revert only this change/);
  assert.match(h.confirmations[0], /Other edits and staged changes will be kept/);
  assert.equal(h.calls[0].options.body.changeId, "block-two");
  assert.equal(h.calls[0].options.body.expectedRevision, "view-revision");
  assert.ok(h.controls.every(button => button.disabled));
  await h.context.revertDiffChange("block-one");
  assert.equal(h.calls.length, 1);
  h.pending[0].resolve({ ok: true }); await request;
  assert.equal(h.$("#diff-dialog").open, true);
  assert.deepEqual(h.diffLoads, [["client/build.gradle", false]]);
  // Simulated failed refresh retains the old disabled snapshot, never reusable IDs.
  assert.equal(h.editor.revert.allowed, false);
  await h.context.revertDiffChange("block-one");
  assert.equal(h.calls.length, 1);
});

test("inline actions reject unknown IDs, cancel, and unavailable server capability", async () => {
  for (const options of [{ confirm: false }, { allowed: false }, {}]) {
    const h = harness(options);
    await h.context.revertDiffChange(Object.keys(options).length ? "block-one" : "forged-block");
    assert.equal(h.calls.length, 0);
  }
});

test("inline staged action explicitly preserves worktree and unrelated staged edits", async () => {
  const h = harness({ staged: true }); const request = h.context.revertDiffChange("block-one");
  assert.match(h.confirmations[0], /Unstage only this change/);
  assert.match(h.confirmations[0], /Other staged changes and the working file will be kept/);
  assert.equal(h.calls[0].options.body.staged, true);
  h.pending[0].resolve({ ok: true }); await request;
  assert.deepEqual(h.diffLoads, [["client/build.gradle", true]]);
});

test("stale inline revert preserves editor contents and does not refresh or retry", async () => {
  const h = harness({ dirty: true }); const request = h.context.revertDiffChange("block-one");
  h.pending[0].reject(new Error("File changed; reopen the diff")); await request;
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.diffLoads, []);
  assert.equal(h.$("#diff-editor-text").value, "unsaved editor work");
  assert.equal(h.editor.busy, false);
});

test("inline completion cannot touch a different repository editor", async () => {
  const h = harness(); const request = h.context.revertDiffChange("block-one");
  const other = { repositoryId: "repo-b", busy: false };
  h.state.diffEditor = other; h.state.activeRepository = { id: "repo-b" };
  h.pending[0].resolve({ ok: true }); await request;
  assert.equal(h.state.diffEditor, other);
  assert.deepEqual(h.diffLoads, []); assert.deepEqual(h.refreshes, []);
});

test("inline controls align with each change, including pure deletion, not unchanged context", () => {
  const h = harness();
  const rows = [
    { type: "context", oldLine: 1, newLine: 1, oldText: "same", newText: "same" },
    { type: "changed", oldLine: 2, newLine: 2, oldText: "old", newText: "new" },
    { type: "added", newLine: 3, newText: "more" },
    { type: "context", oldLine: 3, newLine: 4, oldText: "same", newText: "same" },
    { type: "deleted", oldLine: 4, oldText: "gone" },
  ];
  const changes = [h.editor.changes[0], { id: "deletion", beforeStart: 4, beforeCount: 1, afterStart: 5, afterCount: 0 }];
  const html = h.context.renderDiffSide({ rows }, "after", changes);
  assert.equal((html.match(/data-revert-change=/g) || []).length, 2);
  assert.match(html, /data-revert-change="deletion"/);
  assert.match(html, /aria-label="Revert this change near line 5"/);
  assert.doesNotMatch(h.context.renderDiffSide({ rows }, "before", changes), /data-revert-change/);
  assert.doesNotMatch(h.context.renderDiffSide({ rows }, "after"), /data-revert-change/);
});

test("diff parser pairs no-final-newline replacements and does not invent trailing context", () => {
  const parsed = parseUnifiedDiff("@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
  const expanded = expandToFullFile(parsed, "old", "new");
  assert.deepEqual(expanded.rows, [{ oldLine: 1, newLine: 1, oldText: "old", newText: "new", type: "changed" }]);
});

test("diff parser keeps insertion and deletion gaps aligned at the start of a file", () => {
  const added = expandToFullFile(parseUnifiedDiff("@@ -0,0 +1,2 @@\n+one\n+two\n"), "", "one\ntwo\n");
  const removed = expandToFullFile(parseUnifiedDiff("@@ -1,2 +0,0 @@\n-one\n-two\n"), "one\ntwo\n", "");
  assert.equal(added.rows.length, 2); assert.equal(removed.rows.length, 2);
  assert.deepEqual(added.rows.map(row => [row.oldLine, row.newLine]), [[null, 1], [null, 2]]);
  assert.deepEqual(removed.rows.map(row => [row.oldLine, row.newLine]), [[1, null], [2, null]]);
});
