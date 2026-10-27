import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = app.indexOf("async function revertIdeDiffChange(");
const source = app.slice(start, app.indexOf("\nfunction diffEditIsDirty", start));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness({ staged = false, dirty = false, confirmed = true, allowed = true } = {}) {
  const pending = deferred(), calls = [], messages = [], confirmations = [], invalidated = [], diffLoads = [], refreshes = [];
  let current = true, refreshError = false;
  const context = { repositoryId: "repo-a", file: "src/Review.java", staged, changes: [{ id: "a".repeat(64), afterStart: 40, afterCount: 3 }],
    revert: { allowed, revision: "b".repeat(64) }, busy: false };
  const state = { activeRepository: { id: "repo-a" }, currentView: "repository", gitActionRepositories: new Set(), gitStatusVersion: 1 };
  const bridge = { isFileDirty: () => dirty, invalidateSavedFile: (...args) => invalidated.push(args),
    getNavigationState: () => ({ surface: "diff", path: context.file, line: 41, column: 5 }) };
  const environment = vm.createContext({ state, repositoryIdeBridge: bridge,
    confirm: text => { confirmations.push(text); return confirmed; }, toast: (...args) => messages.push(args),
    api: (url, options) => { calls.push({ url, options }); return pending.promise; },
    showDiff: async (...args) => { diffLoads.push(args); if (refreshError) throw Error("Refresh failed"); return true; },
    refreshActiveRepository: async () => refreshes.push(state.activeRepository.id),
  });
  vm.runInContext(source, environment);
  return { state, context, calls, pending, messages, confirmations, invalidated, diffLoads, refreshes, bridge,
    run: (id = context.changes[0].id) => environment.revertIdeDiffChange(context, id, () => current),
    navigateAway() { current = false; state.activeRepository = { id: "repo-b" }; },
    replaceDiff() { current = false; }, failRefresh() { refreshError = true; }, };
}

test("embedded working diff reverts exactly one server-issued block and refreshes its location", async () => {
  const h = harness(), request = h.run();
  assert.equal(h.calls.length, 1); assert.equal(h.context.busy, true);
  assert.equal(h.state.gitActionRepositories.has("repo-a"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { url: "/api/repositories/repo-a/git/revert", options: { method: "POST", body: {
    file: "src/Review.java", staged: false, expectedRevision: "b".repeat(64), changeId: "a".repeat(64),
  } } });
  assert.match(h.confirmations[0], /Other edits and staged changes will be kept/);
  assert.match(h.confirmations[0], /local recovery copy/);
  h.pending.resolve({ ok: true }); assert.equal((await request).applied, true);
  assert.deepEqual(h.invalidated, [["repo-a", "src/Review.java"]]);
  assert.equal(h.diffLoads[0][2].line, 41); assert.deepEqual(h.refreshes, ["repo-a"]);
  assert.equal(h.context.revert.allowed, false); assert.equal(h.context.busy, false);
  assert.equal(h.state.gitActionRepositories.size, 0);
  await h.run(); assert.equal(h.calls.length, 1, "the consumed snapshot cannot be replayed");
});

test("staged block actions explicitly unstage and do not invalidate the working draft", async () => {
  const h = harness({ staged: true, dirty: true }), request = h.run();
  assert.match(h.confirmations[0], /Unstage only this change/); assert.match(h.confirmations[0], /working file will be kept/);
  assert.equal(h.calls[0].options.body.staged, true);
  h.pending.resolve({ ok: true, refreshRequired: true }); assert.equal((await request).applied, true);
  assert.deepEqual(h.invalidated, []); assert.equal(h.diffLoads.length, 1);
});

test("dirty buffers, denied confirmation, unknown blocks and unsupported diffs never mutate", async () => {
  for (const options of [{ dirty: true }, { confirmed: false }, { allowed: false }]) {
    const h = harness(options); assert.equal(await h.run(), false); assert.equal(h.calls.length, 0); assert.deepEqual(h.invalidated, []);
  }
  const h = harness(); assert.equal(await h.run("forged"), false); assert.equal(h.calls.length, 0);
  h.replaceDiff(); assert.equal(await h.run(), false); assert.equal(h.calls.length, 0);
});

test("pending block reverts serialize with all other repository Git actions", async () => {
  const h = harness(), first = h.run(); await h.run(); assert.equal(h.calls.length, 1);
  h.pending.resolve({ ok: true }); await first;
  const other = harness(); other.state.gitActionRepositories.add("repo-a"); await other.run(); assert.equal(other.calls.length, 0);
});

test("late revert completion cannot replace another repository or a newer diff", async () => {
  for (const changeView of ["navigateAway", "replaceDiff"]) {
    const h = harness(), first = h.run(); h[changeView](); h.pending.resolve({ ok: true });
    assert.equal((await first).applied, true); assert.equal(h.diffLoads.length, 0);
    if (changeView === "navigateAway") assert.deepEqual(h.refreshes, []);
    assert.deepEqual(h.invalidated, [["repo-a", "src/Review.java"]]);
  }
});

test("stale or uncertain writes invalidate old actions and never retry automatically", async () => {
  const h = harness(), previousStatusVersion = h.state.gitStatusVersion, first = h.run();
  assert.ok(h.state.gitStatusVersion > previousStatusVersion, "pre-write Git status polls expire before the request is sent");
  h.pending.reject(new Error("Diff revision changed"));
  const result = await first; assert.equal(result.applied, false); assert.equal(result.invalidated, true);
  assert.match(h.messages[0][0], /Reopen this diff/); assert.equal(h.context.busy, false);
  assert.equal(h.state.gitActionRepositories.size, 0);
  assert.ok(h.state.gitStatusVersion > previousStatusVersion, "uncertain failures cannot revive pre-write status polls");
  await h.run(); assert.equal(h.calls.length, 1); assert.equal(h.diffLoads.length, 0);
});

test("a refresh failure after success never implies the revert failed or permits replay", async () => {
  const h = harness(); h.failRefresh(); const first = h.run(); h.pending.resolve({ ok: true });
  assert.equal((await first).applied, true); assert.equal(h.context.revert.allowed, false);
  assert.match(h.messages.at(-1)[0], /change was applied/);
  await h.run(); assert.equal(h.calls.length, 1);
});

test("embedded diff receives the exact server capability, blocks and guarded action callback", () => {
  const embedded = app.slice(app.indexOf("async function showDiff("), app.indexOf('let dialog = $("#diff-dialog")', app.indexOf("async function showDiff(")));
  assert.match(embedded, /changes: result\.changes \|\| \[\], revert: result\.revert/);
  assert.match(embedded, /changes: context\.changes, revert: context\.revert/);
  assert.match(embedded, /onRevertChange: \(changeId, editorCurrent\) => revertIdeDiffChange\(context, changeId, \(\) => isCurrent\(\) && editorCurrent\(\), editorCurrent\)/);
});

test("the real showDiff refresh advances ownership and permits a second distinct block revert", async () => {
  const changes = ["a", "c"].map((letter, index) => ({ id: letter.repeat(64), beforeStart: index * 10 + 1, beforeCount: 1, afterStart: index * 10 + 1, afterCount: 1 }));
  const writes = [], failures = []; let currentTab;
  const state = { activeRepository: { id: "repo-a", name: "Repo A" }, currentView: "repository", gitActionRepositories: new Set(), gitStatusVersion: 1 };
  const bridge = { isVisible: () => true, isFileDirty: () => false, invalidateSavedFile() {}, getNavigationState: () => ({ line: 10, column: 1 }),
    openDiff: async (_id, payload, isCurrent) => { assert.equal(isCurrent(), true); currentTab = payload; return true; } };
  const environment = vm.createContext({ state, repositoryIdeBridge: bridge, confirm: () => true,
    api: async (url, options) => {
      if (options?.method === "POST") { writes.push(options.body); changes.shift(); return { ok: true }; }
      if (url.includes("/git/diff?")) return { diff: "fixture", beforeContent: "before", afterContent: "after", changes: [...changes], revert: { allowed: true, revision: (changes.length ? "b" : "d").repeat(64) } };
      return { content: "after", contentHash: "hash" };
    },
    parseUnifiedDiff: () => ({ rows: [] }), expandToFullFile: parsed => parsed,
    closeOpenDialogs: () => true, setTaskPanelCollapsed() {}, queueAppNavigation() {}, refreshActiveRepository: async () => {},
    toast: (text, type) => { if (type === "error") failures.push(text); },
  });
  const diffStart = app.indexOf("async function showDiff(");
  vm.runInContext(app.slice(diffStart, start) + source, environment);
  assert.equal(await environment.showDiff("src/Review.java", false), true);
  for (const id of ["a", "c"]) {
    const previous = currentTab;
    assert.equal((await previous.onRevertChange(id.repeat(64), () => currentTab === previous)).applied, true);
    assert.notEqual(currentTab, previous, "the refreshed diff must replace the consumed snapshot");
  }
  assert.deepEqual(writes.map(write => write.changeId), ["a".repeat(64), "c".repeat(64)]);
  assert.equal(currentTab.changes.length, 0); assert.deepEqual(failures, []);
});
