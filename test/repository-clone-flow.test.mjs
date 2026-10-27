import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createRepositoryCloneJobs } from "../public/repository-clone-jobs.mjs";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("  const updateCloneButton = () => {");
const end = source.indexOf('  $("#repo-production-branches").addEventListener', start);
assert.ok(start > 0 && end > start);

test("onboarding cannot submit stale selection while cloning or choosing a destination", async () => {
  const submitStart = source.indexOf('$("#repo-form").addEventListener("submit"');
  const submitEnd = source.indexOf('$("#refresh-git").addEventListener', submitStart);
  assert.ok(submitStart > 0 && submitEnd > submitStart);
  let submit, prevented = 0;
  for (const busyKey of ['repositoryCloneBusy', 'cloneDestinationChoosing', 'folderDiscoveryBusy', 'onboardingSubmitting']) {
    const context = vm.createContext({
      state: { [busyKey]: true },
      $: (id) => {
        assert.equal(id, '#repo-form', 'busy submission must not inspect or submit stale repositories');
        return { addEventListener: (event, handler) => { submit = handler; } };
      },
    });
    vm.runInContext(source.slice(submitStart, submitEnd), context);
    await submit({ preventDefault() { prevented++; } });
  }
  assert.equal(prevented, 4);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const elements = new Map(), requests = [], responses = [], notices = [];
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(), listeners = new Map();
      elements.set(id, {
        value: "", textContent: "", disabled: false, attributes: {}, listeners,
        setAttribute(key, value) { this.attributes[key] = value; },
        addEventListener(event, callback) { listeners.set(event, callback); },
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      });
    }
    return elements.get(id);
  };
  const modes = [element("local-mode"), element("clone-mode")];
  const state = { pendingOnboardingRepositories: [], globalDraft: "keep Nexus draft", repositoryDrafts: { repo: "keep local draft" } };
  let renders = 0;
  const api = (path, options) => {
    requests.push(JSON.parse(JSON.stringify({ path, ...options })));
    assert.ok(responses.length, "Unexpected API request");
    return Promise.resolve(responses.shift()).then(result => result.repository ? { id: "clone-1", status: "completed", result } : result);
  };
  const context = vm.createContext({
    state, $: element, $$: () => modes,
    renderProductionBranchSelection() { renders++; element("#confirm-repo").disabled = !state.pendingOnboardingRepositories.length; },
    toast: (...args) => notices.push(args),
    api, repositoryCloneJobs: createRepositoryCloneJobs({ api, randomId: () => "request-1", delay: async () => {} }),
    refreshCloneHistory() {}, refreshOnboardingPrerequisites() {},
  });
  vm.runInContext(source.slice(start, end), context);
  element("#repo-clone-url").value = "https://person@bitbucket.org/team/service.git";
  element("#clone-destination").value = "/fixture/clones";
  element("#clone-repository").textContent = "Clone repository";
  const fire = (id, event = "click") => element(id).listeners.get(event)();
  return { state, element, modes, requests, responses, notices, fire, renders: () => renders };
}

test("clone uses one captured request, locks inputs, and shows a busy button until completion", async () => {
  const h = harness(), pending = deferred();
  h.responses.push(pending.promise);
  const request = h.fire("#clone-repository");
  assert.equal(h.requests.length, 1);
  assert.equal(h.element("#clone-repository").attributes["aria-busy"], "true");
  assert.equal(h.element("#clone-repository").textContent, "Cloning…");
  for (const id of ["#clone-repository", "#repo-clone-url", "#choose-clone-destination"]) assert.equal(h.element(id).disabled, true);
  assert.ok(h.modes.every((mode) => mode.disabled));
  await h.fire("#clone-repository");
  await h.fire("#choose-clone-destination");
  await h.fire("#repo-clone-url", "input");
  assert.equal(h.requests.length, 1);
  assert.equal(h.element("#clone-repository").disabled, true);
  pending.resolve({ repository: { name: "service", path: "/fixture/clones/service" }, transport: "ssh", fallbackUsed: true });
  await request;
  assert.match(h.element("#clone-repository-status").textContent, /using SSH.*future Git operations will also use SSH/);
  assert.equal(h.element("#clone-repository").attributes["aria-busy"], "false");
  assert.equal(h.element("#clone-repository").textContent, "Clone repository");
  for (const id of ["#clone-repository", "#repo-clone-url", "#choose-clone-destination"]) assert.equal(h.element(id).disabled, false);
  assert.ok(h.modes.every((mode) => !mode.disabled));
  assert.deepEqual(h.requests[0].body, { remoteUrl: "https://person@bitbucket.org/team/service.git", destinationPath: "/fixture/clones", requestId: "request-1" });
  assert.equal(h.element("#repo-path").value, '["/fixture/clones/service"]');
  assert.equal(h.state.globalDraft, "keep Nexus draft");
  assert.equal(h.state.repositoryDrafts.repo, "keep local draft");
});

test("failed clone has actionable text, clears stale onboarding, and can be retried", async () => {
  const h = harness();
  h.state.pendingOnboardingRepositories = [{ path: "/old/repo" }];
  h.element("#repo-path").value = '["/old/repo"]';
  h.responses.push(Promise.reject(new Error("Sign-in needed. Configure your SSH key or saved HTTPS Git credentials.")));
  await h.fire("#clone-repository");
  assert.equal(h.state.repositoryCloneBusy, false);
  assert.match(h.element("#clone-repository-status").textContent, /Sign-in needed/);
  assert.equal(h.element("#clone-repository-status").classList.contains("error"), true);
  assert.equal(h.element("#clone-repository").disabled, false);
  assert.equal(h.element("#repo-path").value, "");
  assert.equal(h.state.pendingOnboardingRepositories.length, 0);
  assert.equal(h.element("#confirm-repo").disabled, true);
  h.responses.push(Promise.resolve({ repository: { name: "service", path: "/fixture/clones/service" }, transport: "https", fallbackUsed: false }));
  await h.fire("#clone-repository");
  assert.equal(h.requests.length, 2);
  assert.equal(h.element("#clone-repository-status").classList.contains("error"), false);
  assert.doesNotMatch(h.element("#clone-repository-status").textContent, /using SSH|sign-in/);
});

test("editing the URL invalidates a completed clone selection without deleting its files", async () => {
  const h = harness();
  h.state.pendingOnboardingRepositories = [{ path: "/fixture/old" }];
  h.element("#repo-path").value = '["/fixture/old"]';
  h.element("#repo-clone-url").value = "https://example.test/another.git";
  await h.fire("#repo-clone-url", "input");
  assert.equal(h.element("#repo-path").value, "");
  assert.equal(h.state.pendingOnboardingRepositories.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.element("#confirm-repo").disabled, true);
});

test("destination picker blocks clone races and cancellation preserves the existing destination", async () => {
  const h = harness(), pending = deferred();
  h.responses.push(pending.promise);
  const picker = h.fire("#choose-clone-destination");
  assert.equal(h.element("#clone-repository").disabled, true);
  await h.fire("#clone-repository");
  await h.fire("#choose-clone-destination");
  assert.equal(h.requests.length, 1);
  pending.resolve({ cancelled: true });
  await picker;
  assert.equal(h.element("#clone-destination").value, "/fixture/clones");
  assert.equal(h.element("#clone-destination-path").textContent, "/fixture/clones");
  assert.equal(h.element("#clone-repository").disabled, false);
  assert.equal(h.state.cloneDestinationChoosing, false);
});

test("empty fields do not submit clone requests", async () => {
  const h = harness();
  h.element("#repo-clone-url").value = " ";
  await h.fire("#clone-repository");
  assert.equal(h.requests.length, 0);
  assert.equal(h.element("#clone-repository").disabled, true);
});

test("an interrupted clone resumes its saved job rather than issuing a new clone", async () => {
  const h = harness();
  h.state.repositoryCloneJobId = "saved-clone";
  h.responses.push(Promise.resolve({ repository: { name: "service", path: "/fixture/clones/service" } }));
  await h.fire("#clone-repository");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, "/api/repository-onboarding/clone/jobs/saved-clone");
  assert.equal(h.requests[0].method, undefined);
});

test("switching source modes preserves clone recovery identity while URL and destination remain unchanged", () => {
  const start = source.indexOf("  $$('[data-onboarding-mode]').forEach((button) => button.addEventListener");
  const end = source.indexOf('  $("#choose-repo-folder").addEventListener', start);
  const nodes = new Map(), modes = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {value:"",textContent:"",disabled:false,focus(){},classList:{toggle(){}},setAttribute(){}});
    return nodes.get(id);
  };
  for(const mode of ["local","clone"]) modes.push({dataset:{onboardingMode:mode},classList:{toggle(){}},setAttribute(){},addEventListener(_event,callback){this.click=callback;}});
  const state = {repositoryCloneJobId:"recover-me",folderDiscoveryRevision:0};
  const context = vm.createContext({state,$:element,$$:()=>modes,renderProductionBranchSelection(){}});
  vm.runInContext(source.slice(start,end),context);
  modes[0].click(); modes[1].click();
  assert.equal(state.repositoryCloneJobId,"recover-me");
});

test("reopening onboarding while cloning preserves the in-flight form", () => {
  const chooser = source.slice(source.indexOf("  const showRepositoryChooser = () => {"), source.indexOf('  $("#add-repo").addEventListener'));
  const dialogs = [];
  const context = vm.createContext({ state: { repositoryCloneBusy: true }, closeRepositoryTabTools() {}, showAppDialog: (id) => dialogs.push(id), $() { throw new Error("Should not reset in-flight fields"); }, switchPrimaryView() { throw new Error("Should not change active chat"); } });
  vm.runInContext(`${chooser}\nshowRepositoryChooser();`, context);
  assert.deepEqual(dialogs, ["repo-dialog"]);
});
