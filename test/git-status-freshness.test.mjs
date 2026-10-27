import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createApiClient } from "../public/api-client.mjs";
import { renderRepositoryContextSummary } from "../public/repository-context-bar.mjs";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
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
const status = (behind = 2) => ({ branch: "main", remote: "", ahead: 0, behind, files: [] });
function harness(handler = async () => status(0)) {
  const elements = new Map(), calls = [], messages = [], renders = [], refreshes = [];
  const state = {
    activeRepository: { id: "repo-a", path: "/synthetic/repo-a" },
    gitStatus: status(), gitStatusVersion: 0, gitStatusLoading: false,
    gitStatusPolling: null, gitActionRepositories: new Set(),
    selectedGitChanges: new Set(["changed:local.txt"]),
    currentView: "global", activeGlobalTaskId: "ongoing-chat", globalJob: { id: "review-job", status: "running" },
  };
  let visible = true;
  const document = { hidden: false, querySelector: selector => element(selector), body: { classList: { contains: () => visible } } };
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: "", innerHTML: "", title: "", scrollTop: 120, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    state, document, $: element, renderRepositoryContextSummary,
    api: async (url, options = {}) => { calls.push({ url, ...options }); return handler(url, options); },
    renderGitStatus: () => { renders.push(state.gitStatus); element("#change-list").scrollTop = 0; },
    refreshActiveRepository: async () => refreshes.push(state.activeRepository?.id),
    toast: message => messages.push(message), toastAction() {}, setRefreshLoading() {}, skeletonRows: () => "", renderBranchCopyButton() {},
  });
  vm.runInContext(["refreshVisibleGitStatus", "renderGitSyncState", "renderGitHeader", "gitAction"].map(declaration).join("\n"), context);
  return { context, state, document, calls, messages, renders, refreshes, element, hideDock: () => { visible = false; } };
}

test("visible Git refresh reads local status only and leaves Nexus/agent state alone", async () => {
  const h = harness();
  await h.context.refreshVisibleGitStatus();
  assert.equal(h.state.gitStatus.behind, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/api/repositories/repo-a/git/status");
  assert.equal(h.calls[0].dedupe, false);
  assert.equal(h.calls[0].cache, "no-store");
  assert.ok(!h.calls[0].method);
  assert.equal(h.element("#change-list").scrollTop, 120);
  assert.equal(h.state.activeGlobalTaskId, "ongoing-chat");
  assert.equal(h.state.globalJob.status, "running");
  assert.deepEqual([...h.state.selectedGitChanges], ["changed:local.txt"]);
  assert.deepEqual(h.refreshes, []);
});

test("hidden, closed, loading or mutating Git panels do not start background work", async () => {
  for (const change of [h => { h.document.hidden = true; }, h => h.hideDock(), h => { h.state.gitStatusLoading = true; }, h => h.state.gitActionRepositories.add("repo-a")]) {
    const h = harness(); change(h);
    await h.context.refreshVisibleGitStatus();
    assert.deepEqual(h.calls, []);
  }
});

test("an explicit port save refreshes the repository header with Source Control closed without changing chats", async () => {
  const h = harness(); h.hideDock();
  await h.context.refreshVisibleGitStatus({ force: true });
  assert.equal(h.calls.length, 1); assert.equal(h.state.gitStatus.behind, 0);
  assert.equal(h.element("#context-branch").textContent, "main");
  assert.equal(h.state.activeGlobalTaskId, "ongoing-chat"); assert.deepEqual(h.refreshes, []);
});

test("overlapping focus and timer events share one in-flight status read", async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  const first = h.context.refreshVisibleGitStatus();
  await h.context.refreshVisibleGitStatus();
  assert.equal(h.calls.length, 1);
  pending.resolve(status(0)); await first;
  assert.equal(h.state.gitStatusPolling, null);
});

test("late status cannot overwrite another repository, full refresh, or Git operation", async () => {
  for (const change of [h => { h.state.activeRepository = { id: "repo-b" }; }, h => { h.state.gitStatusVersion++; }, h => { h.state.gitStatusLoading = true; }, h => h.state.gitActionRepositories.add("repo-a"), h => h.hideDock()]) {
    const pending = deferred(), h = harness(() => pending.promise);
    const read = h.context.refreshVisibleGitStatus(); change(h);
    pending.resolve(status(0)); await read;
    assert.equal(h.state.gitStatus.behind, 2);
    assert.deepEqual(h.renders, []);
    assert.equal(h.state.gitStatusPolling, null);
  }
});

test("unchanged status preserves the file list while updating accessible explanation", async () => {
  const h = harness(async () => status(2));
  h.element("#change-list").innerHTML = "existing focused row";
  await h.context.refreshVisibleGitStatus();
  assert.deepEqual(h.renders, []);
  assert.equal(h.element("#change-list").innerHTML, "existing focused row");
  assert.equal(h.element("#sync-state").textContent, "↓2");
  assert.match(h.element("#sync-state").title, /2 commits behind the tracked upstream/);
  assert.match(h.element("#sync-state").attributes["aria-label"], /Fetch updates remote-tracking refs only/);
  assert.match(h.element("#sync-state").title, /\/synthetic\/repo-a/);
});

test("ahead/behind-only changes update the indicator without replacing focused file rows", async () => {
  const h = harness(async () => status(0));
  h.element("#change-list").innerHTML = "focused file checkbox";
  await h.context.refreshVisibleGitStatus();
  assert.equal(h.element("#sync-state").textContent, "");
  assert.equal(h.element("#branch-name").textContent, "main");
  assert.equal(h.element("#change-list").innerHTML, "focused file checkbox");
  assert.deepEqual(h.renders, []);
});

test("status errors preserve last-known counts, explain staleness and allow retry", async () => {
  let failed = true;
  const h = harness(async () => { if (failed) throw Error("temporary failure"); return status(0); });
  h.context.renderGitSyncState(h.state.gitStatus);
  await h.context.refreshVisibleGitStatus();
  assert.equal(h.element("#sync-state").textContent, "↓2");
  assert.match(h.element("#sync-state").title, /last known count/);
  assert.deepEqual(h.messages, []);
  failed = false;
  await h.context.refreshVisibleGitStatus();
  assert.equal(h.state.gitStatus.behind, 0);
});

test("zero counts do not falsely claim a remote fetch or configured upstream", () => {
  const h = harness();
  h.context.renderGitSyncState(status(0));
  assert.equal(h.element("#sync-state").textContent, "");
  assert.doesNotMatch(h.element("#sync-state").title, /up to date|latest remote/i);
  h.context.renderGitSyncState(null);
  assert.equal(h.element("#sync-state").textContent, "");
  assert.match(h.element("#sync-state").title, /Checking/);
});

test("Git action remains bound to its starting repository and does not refresh another chat", async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  const action = h.context.gitAction("pull");
  assert.equal(h.calls[0].url, "/api/repositories/repo-a/git/pull");
  assert.equal(h.state.gitStatusVersion, 1);
  await h.context.gitAction("pull");
  assert.equal(h.calls.length, 1);
  h.state.activeRepository = { id: "repo-b" };
  pending.resolve({ output: "Already up to date" }); await action;
  assert.deepEqual(h.refreshes, []);
  assert.equal(h.state.gitActionRepositories.size, 0);
});

test("successful and failed Git actions refresh local status only for the original active repository", async () => {
  for (const failure of [false, true]) {
    const h = harness(async () => { if (failure) throw Error("Local changes prevent fast-forward"); return { output: "Fast-forward" }; });
    await h.context.gitAction("pull");
    assert.deepEqual(h.refreshes, ["repo-a"]);
    assert.equal(h.state.gitActionRepositories.size, 0);
    assert.match(h.messages[0], failure ? /Local changes/ : /Fast-forward/);
  }
});

test("full refresh bypasses pre-pull GET sharing and UI hooks use the local-only refresher", () => {
  assert.match(declaration("refreshActiveRepository"), /gitStatusVersion[\s\S]*dedupe: false, cache: "no-store"/);
  assert.match(declaration("setVersionControlDockOpen"), /if \(nextOpen\) void refreshVisibleGitStatus/);
  assert.match(source, /setInterval\(refreshVisibleGitStatus, 10_000\)/);
  assert.match(source, /window\.addEventListener\("focus", refreshVisibleGitStatus\)/);
  assert.match(source, /visibilitychange[\s\S]*if \(!document\.hidden\) void refreshVisibleGitStatus/);
});

test("fresh GET opt-out does not share a pending pre-mutation response", async () => {
  const pending = [deferred(), deferred()], requests = [];
  const context = { api: createApiClient(async (url, options) => { const index = requests.length; requests.push({ url, options }); await pending[index].promise; return { ok: true, json: async () => ({ version: index }) }; }) };
  const old = context.api("/status");
  const shared = context.api("/status");
  const fresh = context.api("/status", { dedupe: false, cache: "no-store" });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.cache, "no-store");
  assert.ok(!("dedupe" in requests[1].options));
  pending[1].resolve(); assert.equal((await fresh).version, 1);
  pending[0].resolve(); assert.equal((await old).version, 0); assert.equal((await shared).version, 0);
});

test("a failed full refresh can recover through passive status without leaving skeletons", async () => {
  const statusRead = deferred();
  let recovery = false;
  const h = harness(async url => {
    if (url.endsWith("/git/status")) return recovery ? status(2) : statusRead.promise;
    if (url.endsWith("/git/history")) throw Error("History failed before status");
    return [];
  });
  h.state.refreshToken = 0;
  h.state.repositoryJobs = [];
  const lastKnownStatus = h.state.gitStatus;
  h.context.renderContextTray = () => {};
  vm.runInContext(declaration("refreshActiveRepository"), h.context);
  const refresh = h.context.refreshActiveRepository();
  // Let the earlier detail rejection settle while the status call is pending.
  // An unhandled details promise would fail this test through node:test.
  await new Promise(resolve => setImmediate(resolve));
  statusRead.reject(Error("Status unavailable"));
  await refresh;
  assert.equal(h.state.gitStatus, lastKnownStatus, "an unavailable refresh must retain the readable last-known status");
  assert.equal(h.state.gitStatusLoading, false);
  assert.deepEqual(h.messages, ["Status unavailable"]);
  recovery = true;
  await h.context.refreshVisibleGitStatus();
  assert.equal(h.renders.length, 0, "unchanged recovery status must not replace the readable file list");
  assert.equal(h.state.gitStatus.behind, 2);
});

test("a superseded full refresh safely consumes detail errors without a wrong-repository toast", async () => {
  const pending = deferred();
  const h = harness(async url => {
    if (url.endsWith("/git/status")) return pending.promise;
    throw Error("Stale detail error");
  });
  h.state.refreshToken = 0;
  h.state.repositoryJobs = [];
  h.context.renderContextTray = () => {};
  vm.runInContext(declaration("refreshActiveRepository"), h.context);
  const refresh = h.context.refreshActiveRepository();
  h.state.activeRepository = { id: "repo-b" };
  await new Promise(resolve => setImmediate(resolve));
  pending.resolve(status(2));
  await refresh;
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.renders, []);
});
