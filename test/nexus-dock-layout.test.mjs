import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styles = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
function declaration(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}

function harness({ view = "repository", repository = true, dockOpen = false, ide = true, globalCollapsed = false, saved = {} } = {}) {
  const elements = new Map(), preferences = new Map([["argus-version-control-panel", "open"]]);
  const document = { activeElement: null };
  for (const [key, value] of Object.entries(saved)) preferences.set(key, value);
  const refreshes = [], routes = [], navigation = [], gitSyncs = [];
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set(), attributes = new Map();
      elements.set(selector, {
        classes, attributes, dataset: {}, open: false,
        contains(target) { return target?.parentElement === this; },
        focus() { document.activeElement = this; },
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
          toggle(name, active) { active ? classes.add(name) : classes.delete(name); },
        },
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: name => attributes.delete(name),
      });
    }
    return elements.get(selector);
  };
  const state = {
    currentView: view, activeRepository: repository ? { id: "repo-a" } : null,
    workspace: { repositories: repository ? [{ id: "repo-a" }] : [] },
    activeTaskByRepository: { "repo-a": "local-chat" }, activeGlobalTaskId: "nexus-chat",
    repositoryDrafts: { "repo-a": "unsent local draft" }, globalDraft: "unsent Nexus draft",
    globalJob: { id: "nexus-job", taskId: "nexus-chat", status: "running" },
  };
  const body = element("body");
  document.body = body;
  body.dataset.view = view;
  body.classList.toggle("version-control-dock-open", dockOpen);
  body.classList.toggle("repository-ide-enabled", ide && repository && view === "repository");
  body.classList.toggle("workspace-tool-active", !["repository", "global"].includes(view));
  element(".ai-canvas").classList.toggle("task-panel-collapsed", dockOpen);
  element(".global-codex-layout").classList.toggle("task-panel-collapsed", globalCollapsed);
  const globalToggles = [element("#nexus-sidebar-toggle")];
  let navigationAllowed = true;
  const context = vm.createContext({
    state, $: element, $$: selector => selector === '[data-task-panel-toggle="global"]' ? globalToggles : [], document,
    localStorage: { setItem: (key, value) => preferences.set(key, value), getItem: key => preferences.get(key) ?? null },
    closeOpenDialogs: () => navigationAllowed,
    syncRepositoryTabSelection() {}, syncRepositoryPorts() {}, syncViewUrl: view => routes.push(view),
    renderServices() {}, refreshRuntimeDetections() {}, refreshProcesses() {},
    queueAppNavigation: () => navigation.push({ view: state.currentView, gitOpen: body.classList.contains("version-control-dock-open") }),
    refreshVisibleGitStatus: async () => { refreshes.push(state.activeRepository?.id); },
    repositoryIdeBridge: {
      syncVersionControlState: () => gitSyncs.push(body.classList.contains("version-control-dock-open")),
      sync: visible => body.classList.toggle("repository-ide-enabled", visible && ide && repository),
    },
  });
  vm.runInContext(["setTaskPanelCollapsed", "versionControlAvailable", "setVersionControlDockOpen", "activeTaskPanelScope", "syncWorkspaceRail", "switchPrimaryView", "initializeDockedPanels"].map(declaration).join("\n"), context);
  return { context, state, body, document, element, globalToggles, preferences, refreshes, routes, navigation, gitSyncs, rejectNavigation() { navigationAllowed = false; } };
}

test("Nexus sidebar collapse and restore synchronize the header control and rail without changing chats, drafts or jobs", () => {
  const h = harness({ view: "global" });
  const before = JSON.stringify(h.state);
  for (const collapsed of [true, false, true, false]) {
    h.context.setTaskPanelCollapsed("global", collapsed);
    assert.equal(h.element(".global-codex-layout").classList.contains("task-panel-collapsed"), collapsed);
    assert.equal(h.preferences.get("argus-global-tasks-panel"), collapsed ? "collapsed" : "open");
    assert.equal(h.element("#global-context-sidebar").inert, collapsed);
    for (const button of [...h.globalToggles, h.element("#workspace-task-rail-toggle")])
      assert.equal(button.attributes.get("aria-expanded"), String(!collapsed));
    assert.equal(JSON.stringify(h.state), before);
  }
  assert.deepEqual(h.refreshes, []);
  assert.deepEqual(h.routes, []);
  assert.deepEqual(h.navigation, []);
});

test("collapsing Nexus returns hidden sidebar focus to its persistent header control without taking composer focus", () => {
  const h = harness({ view: "global" });
  const task = h.element("#task-card");
  task.parentElement = h.element("#global-context-sidebar");
  task.focus();
  h.context.setTaskPanelCollapsed("global", true);
  assert.equal(h.document.activeElement, h.element("#nexus-sidebar-toggle"));
  assert.equal(h.element("#global-context-sidebar").inert, true);
  h.context.setTaskPanelCollapsed("global", false);
  assert.equal(h.element("#global-context-sidebar").inert, false);
  h.element("#global-agent-prompt").focus();
  h.context.setTaskPanelCollapsed("global", true);
  assert.equal(h.document.activeElement, h.element("#global-agent-prompt"));
});

test("Nexus initializes the saved collapsed preference and defaults to expanded only when no collapse was saved", () => {
  for (const preference of [undefined, "open", "collapsed"]) {
    const h = harness({ view: "global", saved: preference ? { "argus-global-tasks-panel": preference } : {} });
    const before = JSON.stringify(h.state);
    h.context.initializeDockedPanels();
    const collapsed = preference === "collapsed";
    assert.equal(h.element(".global-codex-layout").classList.contains("task-panel-collapsed"), collapsed, String(preference));
    assert.equal(h.element("#workspace-task-rail-toggle").attributes.get("aria-expanded"), String(!collapsed));
    for (const button of h.globalToggles) assert.equal(button.attributes.get("aria-expanded"), String(!collapsed));
    assert.equal(h.preferences.get("argus-global-tasks-panel"), preference, "restoring never overwrites the saved setting");
    assert.equal(JSON.stringify(h.state), before);
  }
});

test("temporary Nexus disclosure changes do not overwrite the user's saved preference", () => {
  const h = harness({ view: "global", globalCollapsed: true, saved: { "argus-global-tasks-panel": "collapsed" } });
  h.context.setTaskPanelCollapsed("global", false, false);
  assert.equal(h.element(".global-codex-layout").classList.contains("task-panel-collapsed"), false);
  assert.equal(h.preferences.get("argus-global-tasks-panel"), "collapsed");
  h.context.initializeDockedPanels();
  assert.equal(h.element(".global-codex-layout").classList.contains("task-panel-collapsed"), true);
});

test("repository Git never changes the independently chosen Nexus sidebar state", () => {
  for (const collapsed of [false, true]) {
    const h = harness({ globalCollapsed: collapsed, saved: { "argus-global-tasks-panel": collapsed ? "collapsed" : "open" } });
    const before = JSON.stringify(h.state);
    h.context.setVersionControlDockOpen(true);
    assert.equal(h.element(".global-codex-layout").classList.contains("task-panel-collapsed"), collapsed);
    assert.equal(h.preferences.get("argus-global-tasks-panel"), collapsed ? "collapsed" : "open");
    assert.equal(JSON.stringify(h.state), before);
    h.context.switchPrimaryView("global");
    assert.equal(h.element(".global-codex-layout").classList.contains("task-panel-collapsed"), collapsed);
    assert.equal(h.element("#workspace-task-rail-toggle").attributes.get("aria-expanded"), String(!collapsed));
  }
});

test("Nexus remains collapsed across view switches and cancellation cannot partially restore it", () => {
  const h = harness({ view: "global" });
  h.context.setTaskPanelCollapsed("global", true);
  h.context.switchPrimaryView("services");
  h.context.switchPrimaryView("global");
  assert.equal(h.element(".global-codex-layout").classList.contains("task-panel-collapsed"), true);
  const before = JSON.stringify(h.state);
  h.rejectNavigation();
  h.context.setTaskPanelCollapsed("global", false);
  assert.equal(h.element(".global-codex-layout").classList.contains("task-panel-collapsed"), true);
  assert.equal(h.preferences.get("argus-global-tasks-panel"), "collapsed");
  assert.equal(h.element("#workspace-task-rail-toggle").attributes.get("aria-expanded"), "false");
  assert.equal(JSON.stringify(h.state), before);
});

test("entering Nexus clears the hidden repository Git dock without changing chat state or saved preference", () => {
  const h = harness({ dockOpen: true });
  const before = JSON.stringify(h.state);
  assert.equal(h.context.switchPrimaryView("global"), true);
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.equal(h.context.versionControlAvailable(), false);
  assert.equal(h.gitSyncs.at(-1), false);
  assert.equal(h.element("#workspace-task-rail-toggle").attributes.get("aria-expanded"), "true");
  assert.equal(h.preferences.get("argus-version-control-panel"), "open");
  assert.equal(JSON.stringify({ ...h.state, currentView: "repository" }), before);
  assert.deepEqual(h.refreshes, []);
});

test("Git is hidden in Nexus and cannot navigate away from its independent chat", () => {
  const h = harness({ view: "global" });
  const before = JSON.stringify(h.state);
  h.context.setVersionControlDockOpen(true);
  assert.equal(h.state.currentView, "global");
  assert.equal(h.body.dataset.view, "global");
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.equal(h.context.versionControlAvailable(), false);
  assert.equal(h.gitSyncs.at(-1), false);
  assert.equal(JSON.stringify(h.state), before);
  assert.deepEqual(h.refreshes, []);
  assert.deepEqual(h.routes, []);
});

test("restoring a saved open Git dock cannot redirect Nexus or reserve a hidden dock", () => {
  const h = harness({ view: "global", dockOpen: true });
  h.context.setVersionControlDockOpen(true, false);
  assert.equal(h.state.currentView, "global");
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.equal(h.preferences.get("argus-version-control-panel"), "open");
  assert.deepEqual(h.refreshes, []);
  assert.deepEqual(h.routes, []);
});

test("cancelled navigation from Nexus cannot open Git or disturb the current task", () => {
  const h = harness({ view: "global" });
  h.rejectNavigation();
  const before = JSON.stringify(h.state);
  h.context.setVersionControlDockOpen(true);
  assert.equal(JSON.stringify(h.state), before);
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.deepEqual(h.refreshes, []);
  assert.deepEqual(h.routes, []);
});

test("cancelled navigation into Nexus leaves an existing repository Git dock intact", () => {
  const h = harness({ dockOpen: true });
  h.rejectNavigation();
  assert.equal(h.context.switchPrimaryView("global"), false);
  assert.equal(h.state.currentView, "repository");
  assert.equal(h.body.classList.contains("version-control-dock-open"), true);
  assert.deepEqual(h.routes, []);
});

test("the Nexus shortcut leaves dock closing to navigation rather than persisting an outside click", () => {
  assert.doesNotMatch(app, /document\.addEventListener\("pointerdown", \(event\) => \{\s*if \(!document\.body\.classList\.contains\("version-control-dock-open"\)\)/);
  assert.doesNotMatch(html, /id="version-control-rail-toggle"/);
  const h = harness({ dockOpen: true });
  assert.equal(h.body.classList.contains("version-control-dock-open"), true);
  assert.equal(h.preferences.get("argus-version-control-panel"), "open");
  assert.equal(h.context.switchPrimaryView("global"), true);
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.equal(h.preferences.get("argus-version-control-panel"), "open");
});

test("opening Git without a remembered repository does not leave Nexus", () => {
  const h = harness({ view: "global", repository: false });
  h.context.setVersionControlDockOpen(true);
  assert.equal(h.state.currentView, "global");
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.deepEqual(h.refreshes, []);
  assert.deepEqual(h.routes, []);
});

test("repository IDE Git docks retain their open and close behavior", () => {
  const h = harness();
  h.context.setVersionControlDockOpen(true);
  assert.equal(h.state.currentView, "repository");
  assert.equal(h.body.classList.contains("version-control-dock-open"), true);
  assert.equal(h.context.versionControlAvailable(), true);
  assert.equal(h.gitSyncs.at(-1), true);
  assert.deepEqual(h.refreshes, ["repo-a"]);
  h.context.setVersionControlDockOpen(false);
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.equal(h.preferences.get("argus-version-control-panel"), "collapsed");
  assert.deepEqual(h.routes, []);
  assert.deepEqual(h.navigation, [{ view: "repository", gitOpen: true }, { view: "repository", gitOpen: false }]);
});

test("repository chat without IDE cannot open Git or alter its tasks, drafts or saved preference", () => {
  const h = harness({ ide: false }); const before = JSON.stringify(h.state);
  h.context.setVersionControlDockOpen(true);
  assert.equal(h.context.versionControlAvailable(), false); assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.equal(h.preferences.get("argus-version-control-panel"), "open"); assert.equal(JSON.stringify(h.state), before);
  assert.deepEqual(h.refreshes, []); assert.deepEqual(h.navigation, []);
});

test("Agents and all workspace tools hide and close Git without overwriting its saved preference", () => {
  for (const view of ["orchestration", "api", "json", "services", "ai", "global"]) {
    const h = harness({ dockOpen: true });
    h.context.switchPrimaryView(view);
    assert.equal(h.context.versionControlAvailable(), false, view);
    assert.equal(h.gitSyncs.at(-1), false, view);
    assert.equal(h.body.classList.contains("version-control-dock-open"), false);
    assert.equal(h.preferences.get("argus-version-control-panel"), "open");
    const before = JSON.stringify(h.state);
    h.context.setVersionControlDockOpen(true);
    assert.equal(h.body.classList.contains("version-control-dock-open"), false);
    assert.equal(JSON.stringify(h.state), before);
    assert.deepEqual(h.refreshes, []);
    h.context.switchPrimaryView("repository");
    assert.equal(h.context.versionControlAvailable(), true);
    assert.equal(h.body.classList.contains("version-control-dock-open"), false, "returning to the IDE does not reopen Git automatically");
  }
});

test("rail synchronization removes a stale hidden dock and preserves task/draft/agent state", () => {
  const h = harness({ view: "orchestration", dockOpen: true });
  const before = JSON.stringify(h.state);
  h.context.syncWorkspaceRail();
  assert.equal(h.body.classList.contains("version-control-dock-open"), false);
  assert.equal(h.element("#agents-toggle").attributes.get("aria-current"), "page");
  assert.equal(h.context.versionControlAvailable(), false);
  assert.equal(h.gitSyncs.at(-1), false);
  assert.equal(h.preferences.get("argus-version-control-panel"), "open");
  assert.equal(JSON.stringify(h.state), before);
});

test("Nexus never inherits the hidden Git dock or floating Tools-menu inset", () => {
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const nexusDockRules = rules.filter(([, selectors]) => selectors.split(",").some(selector => selector.includes("body.version-control-dock-open .global-codex-panel")));
  assert.ok(nexusDockRules.length > 0, "the shared transition rule remains");
  for (const [, , body] of nexusDockRules) assert.doesNotMatch(body, /(?:^|;)\s*(?:inset|left|right|width|margin-left)\s*:/);
  assert.doesNotMatch(styles, /body:has\(#app-menu\[open\]\)[^{]*\.global-codex-panel/);
  assert.match(styles, /body\[data-view="global"\] \.app-shell > #workspace \{ display: none; \}/);
});
