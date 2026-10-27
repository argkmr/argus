import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}
function classList(initial = []) {
  const values = new Set(initial);
  return { contains: name => values.has(name), add: (...names) => names.forEach(name => values.add(name)), remove: (...names) => names.forEach(name => values.delete(name)),
    toggle(name, on = !values.has(name)) { on ? values.add(name) : values.delete(name); return on; } };
}
function harness({ ide = true, view = "repository", repository = true } = {}) {
  const repo = { id: "repo-a" }, state = { currentView: view, activeRepository: repository ? repo : null, workspace: { repositories: [repo] } };
  const elements = new Map(), values = new Map(), calls = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { open: false, classList: classList(), attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, value); }, removeAttribute(name) { this.attributes.delete(name); } });
    return elements.get(selector);
  };
  const body = { dataset: { view }, classList: classList(ide ? ["repository-ide-enabled"] : []) };
  const bridge = { syncVersionControlState: () => calls.push("sync-git") };
  let allowed = true;
  const context = vm.createContext({ state, document: { body }, $: element, $$: () => [],
    repositoryIdeBridge: bridge, bridge, syncRepositoryPorts() {},
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    closeOpenDialogs: () => allowed, refreshVisibleGitStatus: async () => calls.push("read-git"), queueAppNavigation: () => calls.push("navigation"),
  });
  vm.runInContext(["versionControlAvailable", "setVersionControlDockOpen", "activeTaskPanelScope", "syncWorkspaceRail", "setTaskPanelCollapsed", "initializeDockedPanels"].map(declaration).join("\n"), context);
  return { context, state, body, element, calls, values, disallowDialogClose() { allowed = false; } };
}

test("Version Control is available only for a selected repository whose IDE is visible", () => {
  for (const view of ["repository", "global", "orchestration", "services", "api", "json", "ai"]) {
    for (const ide of [true, false]) for (const repository of [true, false]) {
      const h = harness({ view, ide, repository });
      assert.equal(h.context.versionControlAvailable(), view === "repository" && ide && repository, `${view}, IDE ${ide}, repository ${repository}`);
    }
  }
  const h = harness(); h.body.classList.add("workspace-tool-active"); assert.equal(h.context.versionControlAvailable(), false);
});

test("opening Git synchronizes the IDE icon, collapses tasks and closes tools without hiding repository context", () => {
  const h = harness(); h.element("#app-menu").open = true;
  h.context.setVersionControlDockOpen(true);
  assert.equal(h.body.classList.contains("version-control-dock-open"), true);
  assert.equal(h.body.classList.contains("task-context-visible"), true, "the IDE toggle must remain reachable while Git is open");
  assert.equal(h.element(".ai-canvas").classList.contains("task-panel-collapsed"), true);
  assert.equal(h.element("#app-menu").open, false);
  assert.equal(h.values.get("argus-version-control-panel"), "open");
  assert.ok(h.calls.includes("sync-git")); assert.ok(h.calls.includes("read-git")); assert.ok(h.calls.includes("navigation"));
  assert.equal(h.element("#workspace-task-rail-toggle").attributes.get("aria-expanded"), "false");
  h.context.setVersionControlDockOpen(false);
  assert.equal(h.body.classList.contains("version-control-dock-open"), false); assert.equal(h.values.get("argus-version-control-panel"), "collapsed");
});

test("unavailable Git cannot reopen through stale state and does not rewrite the saved preference", () => {
  for (const options of [{ ide: false }, { view: "global" }, { view: "orchestration" }, { repository: false }]) {
    const h = harness(options); h.values.set("argus-version-control-panel", "open"); h.body.classList.add("version-control-dock-open");
    h.context.setVersionControlDockOpen(true);
    assert.equal(h.body.classList.contains("version-control-dock-open"), false);
    assert.equal(h.values.get("argus-version-control-panel"), "open");
    assert.equal(h.calls.includes("read-git"), false); assert.ok(h.calls.includes("sync-git"));
  }
});

test("leaving the repository IDE drops the Git dock and updates the correct active rail", () => {
  for (const view of ["global", "orchestration", "services"]) {
    const h = harness(); h.context.setVersionControlDockOpen(true); h.state.currentView = view;
    h.context.syncWorkspaceRail();
    assert.equal(h.body.classList.contains("version-control-dock-open"), false);
    assert.equal(h.body.classList.contains("task-context-visible"), false);
    assert.equal(h.element("#agents-toggle").classList.contains("active"), view === "orchestration");
  }
  const h = harness(); h.context.setVersionControlDockOpen(true); h.body.classList.remove("repository-ide-enabled"); h.context.syncWorkspaceRail();
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
});

test("declining an unsaved dialog close does not open Git or mutate its preference", () => {
  const h = harness(); h.disallowDialogClose(); h.context.setVersionControlDockOpen(true);
  assert.equal(h.body.classList.contains("version-control-dock-open"), false); assert.equal(h.values.has("argus-version-control-panel"), false); assert.deepEqual(h.calls, []);
});

test("initial dock setup keeps a prior Git preference closed until the IDE owns the panel", () => {
  const h = harness({ ide: false }); h.values.set("argus-version-control-panel", "open");
  assert.doesNotThrow(() => h.context.initializeDockedPanels());
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.equal(h.values.get("argus-version-control-panel"), "open");
  assert.equal(h.calls.includes("read-git"), false);
});

test("IDE task history disclosure never overwrites the ordinary repository chat layout preference", () => {
  for (const saved of ["open", "collapsed"]) {
    const h = harness();
    h.values.set("argus-repository-tasks-panel", saved);
    for (const collapsed of [false, true, false]) {
      h.context.setTaskPanelCollapsed("repository", collapsed);
      assert.equal(h.element(".ai-canvas").classList.contains("task-panel-collapsed"), collapsed);
      assert.equal(h.values.get("argus-repository-tasks-panel"), saved);
    }
    h.body.classList.remove("repository-ide-enabled");
    h.context.setTaskPanelCollapsed("repository", true);
    assert.equal(h.values.get("argus-repository-tasks-panel"), "collapsed");
    h.context.setTaskPanelCollapsed("repository", false);
    assert.equal(h.values.get("argus-repository-tasks-panel"), "open");
  }
});

test("the initial dock setup runs after the bridge binding exists, avoiding a startup TDZ", () => {
  const h = harness({ ide: false });
  const bindingAt = app.indexOf("\nconst repositoryIdeBridge = createRepositoryIdeBridge("), initializeAt = app.indexOf("\ninitializeDockedPanels();");
  assert.ok(bindingAt >= 0 && initializeAt >= 0);
  const binding = "const repositoryIdeBridge = bridge;", initialize = "initializeDockedPanels();";
  assert.doesNotThrow(() => vm.runInContext(bindingAt < initializeAt ? `${binding}\n${initialize}` : `${initialize}\n${binding}`, h.context));
});

test("opening consecutive IDE diffs keeps the Git file list available and never opens a modal", async () => {
  const h = harness(); const diffs = [], failures = [];
  h.context.repositoryIdeBridge.isVisible = id => id === h.state.activeRepository.id;
  h.context.repositoryIdeBridge.openDiff = async (id, payload, isCurrent) => { assert.equal(isCurrent(), true); diffs.push([id, payload.path]); return true; };
  h.context.api = async path => path.includes("/git/diff?") ? { diff: "fixture", beforeContent: "before", afterContent: "after" } : { contentHash: "hash" };
  h.context.parseUnifiedDiff = () => ({ rows: [] }); h.context.expandToFullFile = parsed => parsed;
  h.context.showAppDialog = () => assert.fail("IDE diffs must stay embedded"); h.context.toast = message => failures.push(message);
  vm.runInContext(declaration("showDiff"), h.context);
  h.context.setVersionControlDockOpen(true);
  for (const file of ["First.java", "Second.java"]) {
    assert.equal(await h.context.showDiff(file, false), true);
    assert.equal(h.body.classList.contains("version-control-dock-open"), true, "the next file should remain one click away");
  }
  assert.deepEqual(diffs, [["repo-a", "First.java"], ["repo-a", "Second.java"]]); assert.deepEqual(failures, []);
});
