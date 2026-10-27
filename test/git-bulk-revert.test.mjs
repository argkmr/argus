import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { gitBulkRevertSelection, validateGitBulkRevertPreview, confirmGitBulkRevert, renderGitBulkRevertNotice } from "../public/git-bulk-revert.mjs";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  const next = app.slice(start + 1).search(/\n(?:async )?function \w+\(/);
  return app.slice(start, next < 0 ? undefined : start + next + 1);
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
function harness({ dirty = [], confirmed = true, selection = ["changed:src/A.java", "staged:src/B.java"] } = {}) {
  const inspection = deferred(), mutation = deferred(), confirmation = deferred();
  const calls = [], notices = [], invalidated = [], refreshed = [], synced = [], dialogs = [];
  const state = { activeRepository: { id: "repo-a", name: "Repository A", path: "/synthetic/repo-a" }, currentView: "repository", gitActionRepositories: new Set(), gitBulkRevertReports: new Map(), gitStatusVersion: 4, gitStatus: { files: [] }, selectedGitChanges: new Set(selection) };
  const bridge = { isFileDirty: (_id, path) => dirty.includes(path), invalidateSavedFile: (...args) => invalidated.push(args), refreshAfterExternalChange: async (...args) => { synced.push(args); return {}; } };
  const context = vm.createContext({ state, document: {}, repositoryIdeBridge: bridge,
    gitBulkRevertSelection, validateGitBulkRevertPreview,
    confirmGitBulkRevert: args => { dialogs.push(args); return confirmed === "deferred" ? confirmation.promise : Promise.resolve(confirmed); },
    diffEditIsDirty: () => false, closeDiffDialog() {}, renderGitStatus() {}, renderGitSelectionToolbar() {},
    api: (url, options) => { calls.push({ url, ...clone(options) }); return url.endsWith("/preview") ? inspection.promise : mutation.promise; },
    toast: (...args) => notices.push(args), refreshActiveRepository: async options => refreshed.push({ id: state.activeRepository?.id, options }),
  });
  vm.runInContext(declaration("runSelectedGitRevert"), context);
  return { context, state, bridge, calls, inspection, mutation, confirmation, notices, invalidated, refreshed, synced, dialogs,
    run: () => context.runSelectedGitRevert(),
    inspect(overrides = {}) { const files = gitBulkRevertSelection(selection); inspection.resolve({ allowed: true, files: files.map((file, index) => ({ ...file, allowed: true, revision: `revision-${index}` })), recoveryDirectory: "/synthetic/recovery", ...overrides }); },
    apply(overrides = {}) { mutation.resolve({ ok: true, refreshRequired: true, results: gitBulkRevertSelection(selection).map(file => ({ ...file, status: "reverted" })), recoveryPaths: ["/synthetic/recovery/batch"], ...overrides }); },
  };
}

test("bulk selection preserves section, exact path and rejects ambiguous double-selection or excess count", () => {
  assert.deepEqual(gitBulkRevertSelection(["changed:path:with colon.txt", "staged:dir/B.java"]), [{ file: "dir/B.java", staged: true }, { file: "path:with colon.txt", staged: false }]);
  assert.throws(() => gitBulkRevertSelection(["changed:a", "staged:a"]), /only one section/);
  assert.throws(() => gitBulkRevertSelection(["bad:a"]), /no longer valid/);
  assert.throws(() => gitBulkRevertSelection(Array.from({ length: 26 }, (_, i) => `changed:${i}`)), /25/);
});

test("preview must cover every exact file and view, with revision and permission", () => {
  const files = [{ file: "a", staged: false }, { file: "b", staged: true }];
  const preview = { allowed: true, files: files.map(file => ({ ...file, allowed: true, revision: "exact" })) };
  assert.deepEqual(validateGitBulkRevertPreview(preview, files), files.map(file => ({ ...file, expectedRevision: "exact" })));
  for (const broken of [{ ...preview, files: preview.files.slice(0, 1) }, { ...preview, files: [preview.files[0], preview.files[0]] }, { ...preview, files: preview.files.map(file => ({ ...file, staged: false })) }, { ...preview, files: preview.files.map(file => ({ ...file, revision: "" })) }]) assert.throws(() => validateGitBulkRevertPreview(broken, files));
  assert.throws(() => validateGitBulkRevertPreview({ allowed: false, reason: "Unsupported", files: [{ file: "new.js", allowed: false, reason: "Untracked files are not reverted" }] }, files), /new.js: Untracked/);
});

test("one batch preview and one revision-bound mutation preserve staged/worktree distinction", async () => {
  const h = harness(), operation = h.run();
  assert.equal(h.state.gitActionRepositories.has("repo-a"), true);
  assert.deepEqual(h.calls[0], { url: "/api/repositories/repo-a/git/bulk-revert/preview", method: "POST", body: { files: [{ file: "src/A.java", staged: false }, { file: "src/B.java", staged: true }] }, dedupe: false });
  h.inspect(); await settle();
  assert.equal(h.dialogs[0].repository.path, "/synthetic/repo-a");
  assert.deepEqual(h.calls[1].body.files, [{ file: "src/A.java", staged: false, expectedRevision: "revision-0" }, { file: "src/B.java", staged: true, expectedRevision: "revision-1" }]);
  h.apply(); await operation;
  assert.equal(h.state.selectedGitChanges.size, 0);
  assert.deepEqual(h.invalidated, [["repo-a", "src/A.java"], ["repo-a", "src/B.java"]]);
  assert.deepEqual(clone(h.synced), [["repo-a", { paths: ["src/A.java", "src/B.java"] }]]);
  assert.deepEqual(clone(h.refreshed), [{ id: "repo-a", options: { refreshConversation: false } }]);
  assert.equal(h.state.gitBulkRevertReports.get("repo-a").error, false);
  assert.equal(h.state.gitActionRepositories.size, 0);
});

test("dirty selected files and duplicate clicks never submit destructive work", async () => {
  const dirty = harness({ dirty: ["src/B.java"] }); await dirty.run(); assert.equal(dirty.calls.length, 0); assert.match(dirty.notices[0][0], /drafts have been kept/);
  const busy = harness(); const operation = busy.run(); await busy.run(); assert.equal(busy.calls.length, 1);
  busy.inspect(); await settle(); await busy.run(); assert.equal(busy.calls.length, 2); busy.apply(); await operation;
});

test("unsupported preview and declined confirmation leave files and selection unchanged", async () => {
  for (const options of [{ confirmed: false }, {}]) {
    const h = harness(options), operation = h.run();
    h.inspect(options.confirmed === false ? {} : { allowed: false, reason: "Untracked files are not reverted" });
    await operation; assert.equal(h.calls.length, 1); assert.equal(h.invalidated.length, 0); assert.equal(h.state.selectedGitChanges.size, 2); assert.equal(h.state.gitActionRepositories.size, 0);
  }
});

test("late preview after navigation, refresh or selection change cannot show confirmation", async () => {
  for (const mutate of [h => h.state.activeRepository = { id: "repo-b" }, h => h.state.currentView = "global", h => h.state.gitStatusVersion++, h => h.state.selectedGitChanges.delete("changed:src/A.java")]) {
    const h = harness(), operation = h.run(); mutate(h); h.inspect(); await operation;
    assert.equal(h.calls.length, 1); assert.equal(h.dialogs.length, 0); assert.equal(h.state.gitActionRepositories.size, 0);
  }
});

test("navigation or newly dirty editor during confirmation prevents the batch", async () => {
  for (const mutate of [h => h.state.activeRepository = { id: "repo-b" }, h => h.bridge.isFileDirty = () => true, h => h.state.gitStatusVersion++]) {
    const h = harness({ confirmed: "deferred" }), operation = h.run(); h.inspect(); await settle();
    mutate(h); h.confirmation.resolve(true); await operation; assert.equal(h.calls.length, 1); assert.equal(h.invalidated.length, 0);
  }
});

test("late mutation completion remains scoped to original repo and does not disturb new selection", async () => {
  const h = harness(), operation = h.run(); h.inspect(); await settle();
  h.state.activeRepository = { id: "repo-b" }; h.state.selectedGitChanges = new Set(["changed:elsewhere"]);
  h.apply(); await operation;
  assert.deepEqual(h.refreshed, []); assert.deepEqual([...h.state.selectedGitChanges], ["changed:elsewhere"]);
  assert.equal(h.invalidated[0][0], "repo-a"); assert.equal(h.state.gitBulkRevertReports.has("repo-b"), false);
});

test("partial failure retains per-file outcomes and recovery paths without claiming full success", async () => {
  const h = harness(), operation = h.run(); h.inspect(); await settle();
  h.apply({ ok: false, partial: true, refreshRequired: true, message: "One reverted; one changed externally.", results: [{ file: "src/A.java", staged: false, status: "reverted" }, { file: "src/B.java", staged: true, status: "failed", message: "Stale revision" }] });
  await operation; assert.equal(h.state.selectedGitChanges.size, 2);
  assert.equal(h.state.gitBulkRevertReports.get("repo-a").error, true);
  assert.deepEqual(h.state.gitBulkRevertReports.get("repo-a").recoveryPaths, ["/synthetic/recovery/batch"]);
  assert.equal(h.calls.length, 2); assert.equal(h.notices[0][1], "error");
});

test("unknown outcome is never retried automatically and still refreshes clean editor views", async () => {
  const h = harness(), operation = h.run(); h.inspect(); await settle(); h.mutation.reject(new Error("Connection lost")); await operation;
  assert.equal(h.calls.length, 2); assert.match(h.notices[0][0], /not retried automatically/); assert.equal(h.invalidated.length, 2); assert.equal(h.state.selectedGitChanges.size, 2);
  assert.deepEqual(clone(h.state.gitBulkRevertReports.get("repo-a").recoveryPaths), ["/synthetic/recovery"]);
});

test("incomplete successful-looking response never claims success or clears selection", async () => {
  const h = harness(), operation = h.run(); h.inspect(); await settle();
  h.apply({ ok: true, message: "All files reverted", results: [{ file: "src/A.java", staged: false, status: "reverted" }] });
  await operation;
  assert.equal(h.state.selectedGitChanges.size, 2);
  assert.equal(h.state.gitBulkRevertReports.get("repo-a").error, true);
  assert.match(h.notices[0][0], /success has not been confirmed/);
  assert.doesNotMatch(h.notices[0][0], /All files reverted/);
});

test("dirty legacy diff editor blocks both views before preview and after confirmation", async () => {
  for (const afterPreview of [false, true]) {
    const h = harness({ confirmed: "deferred" });
    h.state.diffEditor = { repositoryId: "repo-a", file: "src/B.java" };
    h.context.diffEditIsDirty = () => !afterPreview;
    const operation = h.run();
    if (afterPreview) { h.inspect(); await settle(); h.context.diffEditIsDirty = () => true; h.confirmation.resolve(true); }
    await operation; assert.equal(h.calls.length, afterPreview ? 1 : 0); assert.equal(h.invalidated.length, 0);
  }
});

function element(tag) {
  const listeners = new Map();
  return { tag, children: [], attributes: {}, open: false, hidden: false, removed: false,
    set textContent(value) { this.value = String(value); this.children = []; }, get textContent() { return (this.value || "") + this.children.map(child => child.textContent).join(""); },
    set innerHTML(_) { throw Error("Do not interpolate HTML"); },
    classList: { toggle() {} }, setAttribute(key, value) { this.attributes[key] = value; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    addEventListener(name, fn) { listeners.set(name, fn); }, trigger(name) { listeners.get(name)?.({ preventDefault() {} }); },
    showModal() { this.open = true; }, close() { this.open = false; this.trigger("close"); }, remove() { this.removed = true; }, focus() { this.focused = true; },
  };
}

test("dialog lists exact escaped paths, both restore scopes and recovery; cancel is default", async () => {
  const body = element("body"), document = { body, createElement: element, querySelector: () => null };
  const args = { document, repository: { id: "a", name: "Repo", path: "/synthetic/repo" }, files: [{ file: '<img src=x onerror="bad">.txt', staged: false }, { file: "staged.java", staged: true }], preview: { recoveryDirectory: "/synthetic/recovery" } };
  const result = confirmGitBulkRevert(args), dialog = body.children[0], footer = dialog.children[2];
  assert.match(dialog.textContent, /restore working files from the Git index/); assert.match(dialog.textContent, /restore the Git index from HEAD/); assert.match(dialog.textContent, /Nothing is committed, pushed, or deleted/);
  assert.match(dialog.textContent, /<img src=x/); assert.equal(footer.children[0].focused, true); assert.equal(footer.children[0].autofocus, true);
  footer.children[0].trigger("click"); assert.equal(await result, false); assert.equal(dialog.removed, true);
  const approved = confirmGitBulkRevert(args); body.children[1].children[2].children[1].trigger("click"); assert.equal(await approved, true);
  const stale = confirmGitBulkRevert({ ...args, isCurrent: () => false }); assert.equal(await stale, false);
});

test("result notice renders per-file errors and recovery as text, not executable markup", () => {
  const node = element("div"), document = { createElement: element };
  renderGitBulkRevertNotice(node, { error: true, message: "Partial", results: [{ file: "<script>bad</script>", staged: false, status: "failed", message: "Check again" }], recoveryPaths: ["/synthetic/recovery"] }, document);
  assert.match(node.textContent, /<script>bad<\/script>/); assert.match(node.textContent, /failed/); assert.match(node.textContent, /\/synthetic\/recovery/);
});
