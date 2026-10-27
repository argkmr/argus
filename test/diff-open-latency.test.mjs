import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = app.indexOf("async function showDiff(");
const source = app.slice(start, app.indexOf("\n}", start) + 2);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const snapshot = () => ({ diff: "synthetic", beforeContent: "before", afterContent: "after", changes: [], revert: { allowed: false } });

function harness() {
  const calls = [], shown = [], pending = new Map(); let parses = 0, expansions = 0;
  const state = { activeRepository: { id: "repo-a" }, currentView: "repository" };
  const context = vm.createContext({
    state, repositoryIdeBridge: { isVisible: () => true,
      openDiff: async (id, payload, valid) => { assert.equal(valid(), true); shown.push({ id, payload }); return true; } },
    api: url => { calls.push(url); const request = deferred(); pending.set(url, request); return request.promise; },
    closeOpenDialogs: () => true, setTaskPanelCollapsed() {}, queueAppNavigation() {},
    parseUnifiedDiff: () => { parses++; return { rows: ["mapped"] }; },
    expandToFullFile: parsed => { expansions++; return parsed; },
    navigateEmbeddedDiff: value => value.rows,
    toast: message => assert.fail(message),
  });
  vm.runInContext(source, context);
  return { context, state, calls, shown, pending, counts: () => ({ parses, expansions }),
    open: file => context.showDiff(file, false),
    resolve: file => pending.get(`/api/repositories/repo-a/git/diff?file=${encodeURIComponent(file)}&staged=false`).resolve(snapshot()) };
}

test("embedded diff opens from one verified response without a working-file read or duplicate legacy diff parse", async () => {
  const h = harness(), opening = h.open("src/A.java");
  assert.equal(h.calls.length, 1); assert.match(h.calls[0], /\/git\/diff\?/);
  h.resolve("src/A.java"); assert.equal(await opening, true);
  assert.equal(h.shown.length, 1); assert.deepEqual(h.counts(), { parses: 0, expansions: 0 });
  const navigate = h.shown[0].payload.onNavigate;
  assert.deepEqual(navigate({}, () => true), ["mapped"]);
  assert.deepEqual(navigate({}, () => true), ["mapped"]);
  assert.deepEqual(h.counts(), { parses: 1, expansions: 1 }, "mapping is built only once, on demand");
});

test("a late diff response cannot replace the most recently selected file", async () => {
  const h = harness(), first = h.open("src/A.java"), second = h.open("src/B.java");
  h.resolve("src/B.java"); assert.equal(await second, true);
  h.resolve("src/A.java"); assert.equal(await first, false);
  assert.deepEqual(h.shown.map(item => item.payload.path), ["src/B.java"]);
  assert.deepEqual(h.counts(), { parses: 0, expansions: 0 });
});

test("switching repositories discards an in-flight diff without parsing or mounting it", async () => {
  const h = harness(), opening = h.open("src/A.java"); h.state.activeRepository = { id: "repo-b" };
  h.resolve("src/A.java"); assert.equal(await opening, false);
  assert.equal(h.shown.length, 0); assert.deepEqual(h.counts(), { parses: 0, expansions: 0 });
});
