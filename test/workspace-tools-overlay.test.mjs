import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
function declaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Production function ${name} exists`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

function harness({ view = "global", repository = true, collapsed = false, git = false, ide = true } = {}) {
  const elements = new Map(), writes = [], routes = [], effects = [], listeners = new Map();
  let document, navigationAllowed = true, nativeModal = false, nativePopover = false;
  function element(selector) {
    if (elements.has(selector)) return elements.get(selector);
    const classes = new Set(), attributes = new Map(), events = new Map();
    const result = {
      selector, dataset: {}, open: false, value: "", scrollTop: 127, scrollLeft: 15,
      classList: {
        contains: name => classes.has(name),
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle(name, force) { const active = force ?? !classes.has(name); active ? classes.add(name) : classes.delete(name); return active; },
      },
      classes, attributes,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: name => attributes.get(name) ?? null,
      removeAttribute: name => attributes.delete(name),
      querySelector: child => element(`${selector} ${child}`),
      contains: target => target === result || target?.selector?.startsWith(`${selector} `)
        || (selector === "#app-menu" && (target?.selector?.startsWith("#app-menu-panel") || target?.selector === "#workspace-tools-close")),
      closest: selectors => selectors.split(",").some(candidate => selector === candidate.trim() || selector.startsWith(`${candidate.trim()} `)) ? result : null,
      focus(options) { document.activeElement = result; effects.push(["focus", selector, options]); },
      addEventListener(type, listener) { if (!events.has(type)) events.set(type, []); events.get(type).push(listener); },
      dispatch(event) { event.target ??= result; event.currentTarget = result; for (const listener of events.get(event.type) || []) listener(event); },
    };
    elements.set(selector, result);
    return result;
  }
  document = {
    body: element("body"), activeElement: null,
    querySelector: selector => selector === "dialog:modal, [popover]:popover-open"
      ? (nativeModal ? element("#modal") : nativePopover ? element("#native-popover") : null) : element(selector),
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
  };
  const state = {
    currentView: view, activeRepository: repository ? { id: "fixture-repo" } : null,
    workspace: { repositories: repository ? [{ id: "fixture-repo" }] : [] },
    activeGlobalTaskId: "fixture-nexus-chat", activeTaskByRepository: { "fixture-repo": "fixture-repo-chat" },
    globalDraft: "Unsent Nexus draft", repositoryDrafts: { "fixture-repo": "Unsent repository draft" },
    globalJob: { id: "fixture-job", status: "running", taskId: "fixture-nexus-chat" },
  };
  document.body.dataset.view = view;
  document.body.classList.toggle("version-control-dock-open", git);
  document.body.classList.toggle("repository-ide-enabled", ide && repository && view === "repository");
  document.body.classList.toggle("workspace-tool-active", !["repository", "global"].includes(view));
  element(".ai-canvas").classList.toggle("task-panel-collapsed", collapsed);
  element(".global-codex-layout").classList.toggle("task-panel-collapsed", false);
  element("#global-codex-panel").classList.toggle("hidden", view !== "global");
  element("#global-agent-prompt").value = state.globalDraft;
  element("#agent-prompt").value = state.repositoryDrafts["fixture-repo"];
  const context = vm.createContext({
    state, document, $: element, $$: () => [], window: {}, pollServiceProcesses() {},
    localStorage: { setItem: (name, value) => writes.push([name, value]) },
    closeOpenDialogs: () => { effects.push(["closeDialogs"]); return navigationAllowed; },
    syncRepositoryTabSelection: () => effects.push(["renderTabs"]), syncRepositoryPorts() {},
    renderServices() {}, refreshRuntimeDetections() {}, refreshProcesses() {},
    syncViewUrl: view => routes.push(view),
    refreshVisibleGitStatus: async () => effects.push(["refreshGit"]),
    repositoryIdeBridge: {
      syncVersionControlState() {},
      sync: visible => document.body.classList.toggle("repository-ide-enabled", visible && ide && repository),
    },
  });
  vm.runInContext([
    "setTaskPanelCollapsed", "versionControlAvailable", "setVersionControlDockOpen", "activeTaskPanelScope", "syncWorkspaceRail",
    "syncWorkspaceToolsOverlay", "setWorkspaceToolsOpen", "showWorkspaceTools", "bindWorkspaceToolsMenu",
    "launchWorkspaceTool", "switchPrimaryView",
  ].map(declaration).join("\n"), context);
  context.syncWorkspaceRail();
  context.bindWorkspaceToolsMenu();
  effects.length = 0; writes.length = 0;
  function dispatch(type, target = element("#workspace"), values = {}) {
    const event = { type, target, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    for (const listener of listeners.get(type) || []) listener(event);
    return event;
  }
  function snapshot() {
    return JSON.stringify({ state, body: { view: document.body.dataset.view, classes: [...document.body.classes].filter(name => !name.includes("tools-overlay")) },
      elements: [".ai-canvas", ".global-codex-layout", "#global-codex-panel", "#global-agent-prompt", "#agent-prompt"].map(selector => {
        const item = element(selector); return { selector, value: item.value, classes: [...item.classes], scrollTop: item.scrollTop, scrollLeft: item.scrollLeft };
      }),
    });
  }
  return { context, state, document, element, writes, routes, effects, dispatch, snapshot,
    rejectNavigation() { navigationAllowed = false; }, setNativeModal(value) { nativeModal = value; }, setNativePopover(value) { nativePopover = value; } };
}

test("Workspace Tools is an accessible disclosure with an explicit close control", () => {
  assert.match(html, /<summary[^>]*aria-controls="app-menu-panel"[^>]*aria-expanded="false"/);
  assert.match(html, /id="workspace-tools-close"[^>]*type="button"[^>]*aria-label="Close workspace tools"/);
  assert.match(source, /function bindEvents\(\)[\s\S]*?bindWorkspaceToolsMenu\(\)/);
});

test("opening and closing Tools preserves every base view, selected chat, drafts, scroll and dock state", () => {
  for (const view of ["global", "repository", "services", "api", "json", "orchestration"]) {
    for (const ide of [false, true]) for (const collapsed of [false, true]) for (const git of [false, true]) {
      const h = harness({ view, collapsed, git, ide });
      assert.equal(h.document.body.classList.contains("version-control-dock-open"), git && ide && view === "repository", "only a repository IDE may retain an open Git dock");
      const before = h.snapshot();
      assert.equal(h.context.showWorkspaceTools(), true);
      assert.equal(h.element("#app-menu").open, true);
      assert.equal(h.element("#app-menu summary").getAttribute("aria-expanded"), "true");
      assert.equal(h.snapshot(), before, `${view} must remain untouched behind the open overlay`);
      h.context.setWorkspaceToolsOpen(false);
      assert.equal(h.snapshot(), before, `${view} must remain untouched after closing`);
      assert.deepEqual(h.routes, []);
      assert.deepEqual(h.effects, [], "Opening a menu must not refresh unrelated views, render chats, prompt, or close dialogs");
      assert.ok(h.writes.every(([name]) => name === "argus-tools-panel"), "No task/Git preferences are changed");
    }
  }
});

test("Tools remains available without a connected repository and does not navigate to Nexus", () => {
  const h = harness({ view: "repository", repository: false });
  const before = h.snapshot();
  h.context.showWorkspaceTools();
  assert.equal(h.element("#app-menu").open, true);
  assert.equal(h.snapshot(), before);
  assert.deepEqual(h.routes, []);
});

test("overlay remains usable if browser preference storage is unavailable", () => {
  const h = harness();
  h.context.localStorage.setItem = () => { throw new Error("Storage unavailable"); };
  h.context.showWorkspaceTools();
  assert.equal(h.element("#app-menu").open, true);
  h.context.setWorkspaceToolsOpen(false);
  assert.equal(h.element("#app-menu").open, false);
});

test("the summary toggles the overlay without relying on delayed details toggle navigation", () => {
  const h = harness();
  const summary = h.element("#app-menu summary");
  const click = () => { const event = { type: "click", preventDefault() { this.prevented = true; } }; summary.dispatch(event); assert.equal(event.prevented, true); };
  click();
  assert.equal(h.element("#app-menu").open, true);
  click();
  assert.equal(h.element("#app-menu").open, false);
  h.element("#app-menu").open = true;
  h.element("#app-menu").dispatch({ type: "toggle" });
  assert.equal(summary.getAttribute("aria-expanded"), "true");
  assert.deepEqual(h.routes, []);
  assert.deepEqual(h.effects, []);
});

test("Escape closes Tools and returns focus without affecting the chat", () => {
  const h = harness();
  const before = h.snapshot();
  h.context.showWorkspaceTools();
  const event = h.dispatch("keydown", h.element("#app-menu-panel button"), { key: "Escape" });
  assert.equal(h.element("#app-menu").open, false);
  assert.equal(h.document.activeElement, h.element("#app-menu summary"));
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.equal(h.snapshot(), before);
});

test("Escape respects prevented events and native modal/popover ownership; closed Tools ignores Escape", () => {
  const h = harness();
  let event = h.dispatch("keydown", undefined, { key: "Escape" });
  assert.equal(event.defaultPrevented, false);
  h.context.showWorkspaceTools();
  event = h.dispatch("keydown", undefined, { key: "Escape", defaultPrevented: true });
  assert.equal(h.element("#app-menu").open, true);
  assert.equal(event.stopped, false);
  h.setNativeModal(true);
  event = h.dispatch("keydown", undefined, { key: "Escape" });
  assert.equal(h.element("#app-menu").open, true);
  assert.equal(event.defaultPrevented, false);
  h.setNativeModal(false);
  h.setNativePopover(true);
  event = h.dispatch("keydown", undefined, { key: "Escape" });
  assert.equal(h.element("#app-menu").open, true);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(h.effects, []);
});

test("outside pointer clicks dismiss only the overlay and do not swallow the underlying action", () => {
  const h = harness();
  h.context.showWorkspaceTools();
  let event = h.dispatch("pointerdown", h.element("#app-menu-panel button"));
  assert.equal(h.element("#app-menu").open, true);
  event = h.dispatch("pointerdown", h.element("#global-agent-prompt"));
  assert.equal(h.element("#app-menu").open, false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.stopped, false);
  assert.deepEqual(h.effects, [], "An outside click must keep its natural focus target");
});

test("the close button returns focus to the Tools toggle", () => {
  const h = harness();
  h.context.showWorkspaceTools();
  h.element("#workspace-tools-close").dispatch({ type: "click" });
  assert.equal(h.element("#app-menu").open, false);
  assert.equal(h.document.activeElement, h.element("#app-menu summary"));
});

test("launching a dialog from Tools keeps the underlying Nexus and repository tasks intact", () => {
  for (const view of ["global", "repository"]) {
    const h = harness({ view, git: view === "repository" });
    const before = h.snapshot();
    h.context.showWorkspaceTools();
    let launched = 0;
    const result = h.context.launchWorkspaceTool(() => { launched++; return "dialog-opened"; });
    assert.equal(result, "dialog-opened");
    assert.equal(launched, 1);
    assert.equal(h.element("#app-menu").open, false);
    assert.equal(h.snapshot(), before);
    assert.deepEqual(h.routes, []);
    assert.deepEqual(h.effects, [["closeDialogs"]]);
  }
});

test("a protected unsaved dialog can veto tool launch without losing the menu or chat", () => {
  const h = harness();
  h.context.showWorkspaceTools();
  h.rejectNavigation();
  const before = h.snapshot();
  let launched = false;
  h.context.launchWorkspaceTool(() => { launched = true; });
  assert.equal(launched, false);
  assert.equal(h.element("#app-menu").open, true);
  assert.equal(h.snapshot(), before);
  assert.deepEqual(h.routes, []);
});

test("explicit selection of a tool page still changes routes and preserves unsent drafts", () => {
  for (const view of ["services", "api", "json", "orchestration"]) {
    const h = harness();
    h.context.showWorkspaceTools();
    h.context.launchWorkspaceTool(() => h.context.switchPrimaryView(view));
    assert.equal(h.element("#app-menu").open, false);
    assert.equal(h.state.currentView, view);
    assert.equal(h.document.body.dataset.view, view);
    assert.deepEqual(h.routes, [view]);
    assert.equal(h.element("#global-agent-prompt").value, "Unsent Nexus draft");
    assert.equal(h.element("#agent-prompt").value, "Unsent repository draft");
  }
});
