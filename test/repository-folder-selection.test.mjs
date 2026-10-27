import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const render = source.slice(source.indexOf("function renderProductionBranchSelection()"), source.indexOf("async function refreshCloneHistory()"));
const handlers = source.slice(source.indexOf('  $("#choose-repo-folder").addEventListener'), source.indexOf("  const updateCloneButton ="));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const valid = path => ({ name: path.split("/").at(-1), path, branches: ["main"], productionBranch: "main" });
function harness() {
  const nodes = new Map(), responses = [], requests = [], notices = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", disabled: false, innerHTML: "", listeners: {}, classList: { toggle() {} }, addEventListener(event, callback) { this.listeners[event] = callback; } });
    return nodes.get(id);
  };
  const state = { pendingOnboardingRepositories: [valid("/A")], folderDiscoveryRevision: 0, folderDiscoveryBusy: false };
  $("#repo-path").value = '["/A"]'; $("#chosen-repo-path").textContent = "1 repository found — review below";
  const context = vm.createContext({ state, $, escapeHtml: value => String(value || ""), toast: message => notices.push(message), api: async (path, options) => { requests.push({ path, options }); return await responses.shift(); } });
  vm.runInContext(render + handlers, context);
  return { state, $, responses, requests, notices, context, run: () => $("#choose-repo-folder").listeners.click(), render: () => vm.runInContext("renderProductionBranchSelection()", context) };
}
test("cancelling the picker preserves the previous selection and its matching label", async () => {
  const h = harness(), pick = deferred(); h.responses.push(pick.promise);
  const promise = h.run(); assert.equal(h.$("#confirm-repo").disabled, true);
  pick.resolve({ cancelled: true }); await promise;
  assert.equal(h.$("#chosen-repo-path").textContent, "1 repository found — review below");
  assert.equal(h.state.pendingOnboardingRepositories[0].path, "/A");
  assert.equal(h.$("#repo-path").value, '["/A"]');
  assert.equal(h.$("#confirm-repo").disabled, false);
});
test("changing folders clears old records and gates submission until discovery completes", async () => {
  const h = harness(), discovery = deferred(); h.responses.push({ paths: ["/B"] }, discovery.promise);
  const promise = h.run(); await new Promise(r => setImmediate(r));
  assert.equal(h.$("#confirm-repo").disabled, true);
  assert.equal(h.state.pendingOnboardingRepositories.length, 0);
  await h.run(); assert.equal(h.requests.length, 2, "double click cannot start another picker");
  discovery.resolve({ repositories: [valid("/B")] }); await promise;
  assert.equal(h.state.pendingOnboardingRepositories[0].path, "/B");
  assert.equal(h.$("#confirm-repo").disabled, false);
});
test("closing or switching mode invalidates late discovery success and errors", async () => {
  const h = harness(), discovery = deferred(); h.responses.push({ paths: ["/B"] }, discovery.promise);
  const promise = h.run(); await new Promise(r => setImmediate(r));
  h.$("#repo-dialog").listeners.close();
  h.state.pendingOnboardingRepositories = []; h.$("#repo-path").value = "";
  discovery.resolve({ repositories: [valid("/B")] }); await promise;
  assert.equal(h.state.pendingOnboardingRepositories.length, 0);
  assert.equal(h.$("#repo-path").value, "");
  assert.equal(h.state.folderDiscoveryBusy, false);
  assert.match(source, /state\.folderDiscoveryRevision\+\+/);
});
test("failed discovery cannot silently leave old repositories selected", async () => {
  const h = harness(); h.responses.push({ paths: ["/B"] }, Promise.reject(new Error("discovery failed")));
  await h.run();
  assert.equal(h.state.pendingOnboardingRepositories.length, 0);
  assert.equal(h.$("#confirm-repo").disabled, true);
  assert.match(h.$("#chosen-repo-path").textContent, /discovery failed/);
});
test("empty/broken/excluded repositories do not block healthy siblings", () => {
  const h = harness();
  h.state.pendingOnboardingRepositories = [valid("/good"), { ...valid("/empty"), branches: [] }, { ...valid("/broken"), eligible: false, error: "Git metadata missing" }, { ...valid("/skip"), excluded: true }, { ...valid("/busy"), onboarding: true }];
  h.render(); assert.equal(h.$("#confirm-repo").disabled, false);
  assert.match(h.$("#repo-production-branches").innerHTML, /Git metadata missing/);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("selectedOnboardingRepositories().map(r => r.path)", h.context))), ["/good"]);
  h.state.pendingOnboardingRepositories[0].excluded = true; h.render();
  assert.equal(h.$("#confirm-repo").disabled, true);
});
