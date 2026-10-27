import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  const next = app.slice(start + 1).search(/\n(?:async )?function \w+\(/);
  return app.slice(start, next < 0 ? undefined : start + next + 1);
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness({ action = "revert", dirty = false, confirmed = true, allowed = true } = {}) {
  const preview = deferred(), mutation = deferred(), calls = [], notices = [], confirms = [], invalidated = [], refreshed = [], synced = [];
  const state = { activeRepository: { id: "repo-a", name: "Repository A" }, currentView: "repository", gitActionRepositories: new Set(), gitStatusVersion: 3, selectedGitChanges: new Set() };
  const bridge = { isFileDirty: () => dirty, invalidateSavedFile: (...args) => invalidated.push(args), refreshAfterExternalChange: async (...args) => synced.push(args) };
  const context = vm.createContext({ state, repositoryIdeBridge: bridge, diffEditIsDirty: () => false, closeDiffDialog() {}, renderGitStatus() {},
    api: (url, opts = {}) => { calls.push({ url, ...opts }); return opts.method === "POST" ? mutation.promise : preview.promise; },
    toast: (...args) => notices.push(args), confirm: message => { confirms.push(message); return confirmed; },
    refreshActiveRepository: async () => refreshed.push(state.activeRepository.id),
    escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  });
  vm.runInContext(["gitSelectionKey", "changeRow", "runGitFileAction"].map(declaration).join("\n"), context);
  return { context, state, bridge, calls, preview, mutation, notices, confirms, invalidated, refreshed, synced,
    run: () => context.runGitFileAction("src/File.java", action),
    inspect(values = {}) { preview.resolve({ file: "src/File.java", action, allowed, reason: allowed ? "" : "Not a regular source file", revision: "a".repeat(64), staged: true, recoveryDirectory: "/private/argus/git-recovery", ...values }); },
    apply(values = {}) { mutation.resolve({ ok: true, file: "src/File.java", action, message: "File action completed.", recoveryIds: ["receipt"], recoveryPaths: ["/private/argus/git-recovery/receipt"], ...values }); },
  };
}

test("source control exposes explicit per-file Revert on tracked changes and Delete on new or staged-added files", () => {
  const h = harness();
  for (const staged of [false, true]) {
    const html = h.context.changeRow({ file: "src/Review.java", status: "modified", index: "M", untracked: false }, staged);
    assert.match(html, /data-git-file-action="revert"/); assert.match(html, />Revert<\/button>/); assert.doesNotMatch(html, /data-git-action="discard"|↶/);
    assert.match(html, /staged and working changes to HEAD/);
  }
  for (const file of [{ file: "new.js", status: "untracked", untracked: true }, { file: "new.java", status: "added", index: "A" }]) {
    for (const staged of [false, true]) {
      const html = h.context.changeRow(file, staged); assert.match(html, /data-git-file-action="delete"/); assert.match(html, />Delete<\/button>/);
    }
  }
  assert.match(h.context.changeRow({ file: '<bad name>.js', status: "modified" }, false), /&lt;bad name&gt;/);
});

test("whole tracked-file revert confirms HEAD, exact path and recovery location then submits one revision-bound action", async () => {
  const h = harness(), operation = h.run();
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /file-action-preview\?file=src%2FFile.java&action=revert$/);
  assert.equal(h.state.gitActionRepositories.has("repo-a"), true);
  h.inspect(); await settle(); assert.match(h.confirms[0], /Repository A · src\/File.java/); assert.match(h.confirms[0], /ALL staged and working changes.*HEAD/);
  assert.match(h.confirms[0], /Only this file/); assert.match(h.confirms[0], /\/private\/argus\/git-recovery/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), { url: "/api/repositories/repo-a/git/file-action?action=revert", method: "POST", body: { file: "src/File.java", expectedRevision: "a".repeat(64) } });
  h.apply(); await operation;
  assert.deepEqual(h.invalidated, [["repo-a", "src/File.java"]]); assert.equal(h.synced[0][0], "repo-a"); assert.deepEqual(h.refreshed, ["repo-a"]);
  assert.match(h.notices[0][0], /Recovery: \/private\/argus\/git-recovery\/receipt/); assert.equal(h.state.gitActionRepositories.size, 0);
});

test("new-file Delete explicitly includes removing the staged addition and never calls discard", async () => {
  const h = harness({ action: "delete" }), operation = h.run(); h.inspect(); await settle();
  assert.match(h.confirms[0], /Delete this NEW file.*working folder and remove its staged addition/);
  assert.match(h.calls[1].url, /file-action\?action=delete$/); assert.doesNotMatch(h.calls[1].url, /discard/);
  h.apply(); await operation;
});

test("dirty editor buffers, pending Git work, unsupported files and declined confirmations never write", async () => {
  const dirty = harness({ dirty: true }); await dirty.run(); assert.equal(dirty.calls.length, 0);
  const busy = harness(); busy.state.gitActionRepositories.add("repo-a"); await busy.run(); assert.equal(busy.calls.length, 0);
  for (const options of [{ allowed: false }, { confirmed: false }]) {
    const h = harness(options), operation = h.run(); h.inspect(); await operation;
    assert.equal(h.calls.filter(call => call.method === "POST").length, 0); assert.equal(h.invalidated.length, 0); assert.equal(h.state.gitActionRepositories.size, 0);
  }
});

test("repository navigation or newly dirty buffers during inspection prevent the mutation", async () => {
  for (const change of ["repository", "dirty"]) {
    const h = harness(), operation = h.run();
    if (change === "repository") h.state.activeRepository = { id: "repo-b" }; else h.bridge.isFileDirty = () => true;
    h.inspect(); await operation; assert.equal(h.calls.length, 1); assert.equal(h.state.gitActionRepositories.size, 0);
  }
});

test("duplicate clicks serialize while preview or mutation is pending", async () => {
  const h = harness(), operation = h.run(); await h.run(); assert.equal(h.calls.length, 1);
  h.inspect(); await settle(); await h.run(); assert.equal(h.calls.length, 2);
  h.apply(); await operation;
});

test("late completions remain scoped to their repository without refreshing the newly selected repository", async () => {
  const h = harness(), operation = h.run(); h.inspect(); await settle(); h.state.activeRepository = { id: "repo-b" };
  h.apply(); await operation; assert.deepEqual(h.refreshed, []); assert.deepEqual(h.invalidated, [["repo-a", "src/File.java"]]); assert.equal(h.synced[0][0], "repo-a");
});

test("stale or uncertain responses refresh inspection but never replay the destructive request", async () => {
  const h = harness(), version = h.state.gitStatusVersion, operation = h.run(); h.inspect(); await settle();
  h.mutation.reject(new Error("Revision changed")); await operation;
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1); assert.ok(h.state.gitStatusVersion > version);
  assert.match(h.notices[0][0], /not retried automatically/); assert.deepEqual(h.refreshed, ["repo-a"]);
});

test("partial success retains the backend explanation and recovery locations instead of claiming total rollback", async () => {
  const h = harness(), operation = h.run(); h.inspect(); await settle();
  h.apply({ refreshRequired: true, message: "Staging reverted; newer working changes were kept." }); await operation;
  assert.match(h.notices[0][0], /newer working changes were kept/); assert.equal(h.notices[0][1], "error"); assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
});

test("file actions have a dedicated click path and narrow docks retain readable labelled controls", async () => {
  assert.match(app, /closest\("\[data-git-file-action\]"\)/); assert.match(app, /await runGitFileAction\(row.dataset.file, fileAction\)/);
  const css = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /@container ide-git \(max-width: 340px\)/); assert.match(css, /\.git-panel \.change-actions \{ grid-column: 3;/);
});
