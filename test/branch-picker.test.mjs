import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";
import { branchPickerGroups, branchPickerMarkup, createBranchPickerLoader } from "../public/branch-picker.mjs";

const local = (name, current = false) => ({ name, ref: `refs/heads/${name}`, type: "local", selectable: true, current });
const remote = name => ({ name, ref: `refs/remotes/${name}`, type: "remote", selectable: true });
const branches = [local("main", true), ...["one", "two", "three", "four", "five", "other"].map(name => local(name)), remote("origin/main")];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };

test("four recent existing local branches precede normal groups without duplicate rows", () => {
  const recent = [branches[0], branches.at(-1), local("deleted"), local("three"), local("one"), local("three"), local("two"), local("four"), local("five")];
  const groups = branchPickerGroups(branches, recent);
  assert.deepEqual(groups.map(group => group.label), ["RECENT BRANCHES", "LOCAL BRANCHES", "REMOTE BRANCHES"]);
  assert.deepEqual(groups[0].branches.map(branch => branch.name), ["three", "one", "two", "four"]);
  assert.deepEqual(groups[1].branches.map(branch => branch.name), ["main", "five", "other"]);
  assert.equal(new Set(groups.flatMap(group => group.branches.map(branch => branch.ref))).size, branches.length);
});

test("search includes recent, local and remote names and retains recency order", () => {
  const values = [local("work-B"), local("work-A"), local("work-C"), remote("origin/work-A")];
  const groups = branchPickerGroups(values, [values[1], values[0]], " WORK ");
  assert.deepEqual(groups.flatMap(group => group.branches.map(branch => branch.name)), ["work-A", "work-B", "work-C", "origin/work-A"]);
  assert.deepEqual(branchPickerGroups(values, [], "no matches"), []);
  assert.equal(branchPickerGroups(values, [local("renamed")])[0].label, "LOCAL BRANCHES");
  assert.deepEqual(branchPickerGroups([], []), []);
});

test("markup safely escapes names, remains selectable-only and exposes full long names", () => {
  const branch = local('fix/<img src=x onerror="bad">&\'');
  const html = branchPickerMarkup({ branches: [branch], recentBranches: [branch], selected: branch.name, branchIcon: '<svg aria-hidden="true"></svg>' });
  assert.doesNotMatch(html, /<img|type="submit"/);
  assert.match(html, /data-branch-candidate="fix\//);
  assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;&amp;&#39;/);
  assert.match(html, /type="button"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /<strong title=/);
  assert.equal((html.match(/data-branch-candidate=/g) || []).length, 1);
});

test("picker refresh is nonblocking, parallel, repository-scoped and explicitly uncached", async () => {
  const requests = [], changes = [];
  const loader = createBranchPickerLoader({ api: (url, options) => { const pending = deferred(); requests.push({ url, options, ...pending }); return pending.promise; }, onChange: value => changes.push(value) });
  assert.equal(requests.length, 0);
  const open = loader.open("repo/a", branches);
  assert.equal(requests.length, 2);
  assert.equal(changes[0].loading, true);
  assert.equal(changes[0].branches, branches);
  assert.equal(requests[0].url, "/api/repositories/repo%2Fa/git/branches");
  assert.equal(requests[1].url, "/api/repositories/repo%2Fa/git/branches/recent");
  for (const { options } of requests) { assert.equal(options.cache, "no-store"); assert.equal(options.dedupe, false); assert.equal(options.timeout, 10_000); }
  requests[0].resolve(branches); requests[1].resolve([branches[2], branches[1]]); await open;
  assert.equal(loader.snapshot().loading, false);
  assert.deepEqual(loader.snapshot().recentBranches.map(branch => branch.name), ["two", "one"]);
  assert.equal(changes.length, 2);
});

test("closed and previous-repository responses cannot overwrite a newer open", async () => {
  for (const closeFirst of [true, false]) {
    const requests = [];
    const loader = createBranchPickerLoader({ api: (_url, options) => { const pending = deferred(); requests.push({ ...pending, options }); return pending.promise; } });
    const old = loader.open("old", branches);
    if (closeFirst) loader.close();
    const latest = loader.open("new", []);
    assert.equal(requests[0].options.signal.aborted, true);
    requests[2].resolve([local("new")]); requests[3].resolve([]); await latest;
    requests[0].resolve(branches); requests[1].resolve([branches[1]]); await old;
    assert.equal(loader.snapshot().repositoryId, "new");
    assert.deepEqual(loader.snapshot().branches.map(branch => branch.name), ["new"]);
  }
});

test("optional history failures do not block branches, and empty or failed history clears old shortcuts", async () => {
  let recent = [branches[1]], failRecent = false, failList = false;
  const loader = createBranchPickerLoader({ api: async url => {
    if (url.endsWith("/recent")) { if (failRecent) throw Error("history unavailable"); return recent; }
    if (failList) throw Error("branches unavailable"); return branches;
  } });
  await loader.open("repo", branches);
  failRecent = true; await loader.open("repo", branches);
  assert.deepEqual(loader.snapshot().recentBranches, []);
  assert.equal(loader.snapshot().branches, branches);
  assert.match(loader.snapshot().notice, /Recent branches are unavailable/);
  failRecent = false; recent = []; await loader.open("repo", branches);
  assert.equal(loader.snapshot().notice, "");
  failList = true; await loader.open("repo", branches);
  assert.equal(loader.snapshot().branches, branches);
  assert.match(loader.snapshot().notice, /Branches could not refresh/);
});

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
function integration(handler = async () => ({ output: "Switched" })) {
  const state = { activeRepository: { id: "repo-a" }, gitActionRepositories: new Set(), gitStatusVersion: 0, globalDraft: "Keep unrelated draft" };
  let snapshot = { repositoryId: "repo-a", branches };
  const calls = [], refreshes = [], messages = [], closes = [];
  const elements = { "#branch-form": { elements: { branch: { value: "" } } }, "#branch-search-input": { value: "" }, "#branch-dialog": { close: () => closes.push(snapshot.repositoryId) } };
  const context = vm.createContext({ state, branchPicker: { snapshot: () => snapshot }, $: selector => elements[selector],
    FormData: class { constructor(value) { this.value = value; } get(name) { return this.value[name] || ""; } },
    api: async (url, options) => { calls.push({ url, ...options }); return handler(url, options); },
    renderBranchPicker() {}, updateBranchConfirmation() {}, toast: message => messages.push(message),
    refreshActiveRepository: async () => refreshes.push(state.activeRepository.id),
  });
  vm.runInContext(["selectBranchCandidate", "switchBranch"].map(declaration).join("\n"), context);
  return { context, state, calls, messages, closes, refreshes, elements, snapshot: value => { snapshot = value; },
    submit: (values = {}) => context.switchBranch({ preventDefault() {}, currentTarget: { operation: "switch", branch: "one", ...values } }) };
}

test("recent row selection never switches, and explicit confirmation posts only once", async () => {
  const pending = deferred(), h = integration(() => pending.promise);
  h.context.selectBranchCandidate("one");
  assert.equal(h.elements["#branch-form"].elements.branch.value, "one");
  assert.equal(h.calls.length, 0);
  const first = h.submit(); await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/api/repositories/repo-a/git/switch");
  assert.equal(h.calls[0].body.branch, "one");
  pending.resolve({ output: "Switched" }); await first;
  assert.deepEqual(h.refreshes, ["repo-a"]);
  assert.equal(h.state.gitActionRepositories.size, 0);
  assert.equal(h.state.globalDraft, "Keep unrelated draft");
});

test("repository changes, unavailable branches and another Git mutation cannot submit", async () => {
  for (const prepare of [h => { h.state.activeRepository.id = "repo-b"; }, h => h.state.gitActionRepositories.add("repo-a")]) {
    const h = integration(); prepare(h); await h.submit(); assert.equal(h.calls.length, 0);
  }
  const h = integration(); await h.submit({ branch: "deleted" }); await h.submit({ branch: "main" });
  assert.equal(h.calls.length, 0);
});

test("completion cannot close or refresh a different repository's picker", async () => {
  const pending = deferred(), h = integration(() => pending.promise);
  const operation = h.submit();
  h.state.activeRepository.id = "repo-b";
  h.snapshot({ repositoryId: "repo-b", branches: [local("other")] });
  pending.resolve({ output: "Switched" }); await operation;
  assert.deepEqual(h.closes, []); assert.deepEqual(h.refreshes, []);
  assert.equal(h.state.gitActionRepositories.size, 0);
});

test("existing create-branch flow still submits a selected base and recovers after a Git failure", async () => {
  const h = integration(async () => { throw Error("Working tree changes would be overwritten"); });
  await h.submit({ operation: "create", newBranch: "feature/new", createStartPoint: "main" });
  assert.equal(h.calls[0].url, "/api/repositories/repo-a/git/branch");
  assert.equal(h.calls[0].body.name, "feature/new");
  assert.equal(h.calls[0].body.startPoint, "main");
  assert.equal(h.state.gitActionRepositories.size, 0);
  assert.match(h.messages[0], /Working tree changes/);
  assert.deepEqual(h.closes, []);
});

test("rerendering selection or recent results retains keyboard focus and list position", () => {
  const document = { activeElement: null }, before = { closest: () => ({ dataset: { branchCandidate: "one" } }) };
  const focused = [];
  const list = { scrollTop: 120, querySelectorAll: () => branches.map(branch => ({ dataset: { branchCandidate: branch.name }, focus: options => focused.push({ name: branch.name, options }) })),
    set innerHTML(value) { this.html = value; this.scrollTop = 0; document.activeElement = null; } };
  const status = {};
  document.activeElement = before;
  const elements = { "#branch-form": { elements: { branch: { value: "one" } } }, "#branch-picker-list": list, "#branch-picker-status": status };
  const context = vm.createContext({ document, branchIcon: "", branchPickerMarkup, branchPicker: { snapshot: () => ({ branches, recentBranches: [branches[1]], loading: false, notice: "Recent" }) }, $: selector => elements[selector] });
  vm.runInContext(declaration("renderBranchPicker"), context);
  context.renderBranchPicker();
  assert.equal(focused[0].name, "one"); assert.equal(focused[0].options.preventScroll, true);
  assert.equal(list.scrollTop, 120); assert.equal(status.textContent, "Recent");
});

test("async create-branch loading chooses a default before enabling confirmation", () => {
  const order = [], state = { activeRepository: { id: "repo" } };
  let callback;
  const elements = { "#branch-dialog": { open: true }, "#branch-search-input": { value: "" }, "#branch-form": { elements: { operation: { value: "create" } } } };
  const context = vm.createContext({ state, $: selector => elements[selector], api() {},
    createBranchPickerLoader: options => { callback = options.onChange; return {}; },
    renderBranchPicker: () => order.push("render"), renderCreateBranchOptions: () => order.push("base"), updateBranchConfirmation: () => order.push("confirm"),
  });
  const start = source.indexOf("const branchPicker = createBranchPickerLoader(");
  vm.runInContext(source.slice(start, source.indexOf("\nfunction renderBranchPicker", start)), context);
  callback({ repositoryId: "repo" }); assert.deepEqual(order, ["render", "base", "confirm"]);
  order.length = 0; callback({ repositoryId: "another" }); assert.deepEqual(order, []);
  elements["#branch-dialog"].open = false; callback({ repositoryId: "repo" }); assert.deepEqual(order, []);
});
