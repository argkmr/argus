import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizeRepositoryTabGroups, normalizeRepositoryTabOrder, reconcileRepositoryTabOrder, reorderRepositoryTabs, repositoryTabLayout } from "../public/repository-tab-groups.js";

const markup = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");

function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}

function harness() {
  const elements = new Map(), requests = [], dialogs = [], frames = [], revealed = [], notifications = [];
  const element = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set(selector === "#terminal-panel" ? ["hidden"] : []);
      const listeners = new Map();
      elements.set(selector, {
        value: "", innerHTML: "", scrollLeft: 180, open: false, popoverOpen: false, attributes: new Map(), listeners,
        contains: () => false, querySelectorAll: () => [],
        focusCount: 0, focus() { this.focusCount += 1; }, close() { this.open = false; },
        matches(selector) { return selector === ":popover-open" && this.popoverOpen; },
        hidePopover() { this.popoverOpen = false; },
        setAttribute(name, value) { this.attributes.set(name, value); },
        addEventListener(type, handler) { const handlers = listeners.get(type) || []; handlers.push(handler); listeners.set(type, handlers); },
        classList: { contains: (name) => classes.has(name), toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, remove: (name) => classes.delete(name) },
      });
    }
    return elements.get(selector);
  };
  const repositories = [
    { id: "repo-a", name: "Service A", path: "/source/payments" },
    { id: "repo-b", name: "Service B", path: "/source/orders" },
    { id: "repo-c", name: "Service C", path: "/source/web" },
  ];
  const state = {
    currentView: "repository", activeRepository: repositories[0],
    workspace: { repositories, preferences: { repositoryTabGroups: [
      { id: "group-a", name: "Backend", color: "blue", collapsed: true, repositoryIds: ["repo-a", "repo-b"] },
    ] } },
    repositoryDrafts: { "repo-a": "Keep my draft" }, activeTaskByRepository: { "repo-a": "task-a" },
    globalDraft: "Keep Nexus draft", globalJob: { id: "global-job", status: "running" },
    selectedGitChanges: new Set(), pendingOnboardingRepositories: [{ id: "pending" }],
  };
  let navigationAllowed = true;
  const context = vm.createContext({
    state, $: element, document: { activeElement: null }, normalizeRepositoryTabGroups, normalizeRepositoryTabOrder, reconcileRepositoryTabOrder, reorderRepositoryTabs, repositoryTabLayout,
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    requestAnimationFrame: (callback) => frames.push(callback), updateRepositoryTabOverflow() {},
    revealActiveRepositoryTab: () => revealed.push(state.activeRepository?.id),
    api: async (path, options) => { requests.push(JSON.parse(JSON.stringify({ path, ...options }))); return {}; },
    showAppDialog: (id) => { dialogs.push(id); element(`#${id}`).open = true; return true; },
    switchPrimaryView: (view) => { if (!navigationAllowed) return false; state.currentView = view; return true; },
    syncRepositoryWorkspacePresence() {}, syncViewUrl() {}, storeComposerDraft() {}, renderContextTray() {},
    resetTabSurface() {}, restoreScopedComposer() {}, renderServices() {}, updateLocalAIInfo() {},
    repositoryTerminal: null, syncIdeRunControls() {},
    clearInterval() {}, refreshActiveRepository: async () => {},
    toast: (...args) => notifications.push(args),
  });
  vm.runInContext([
    "repositoryTabGroups", "persistRepositoryTabGroups", "persistRepositoryTabLayout", "moveRepositoryTab", "isRepositoryDestination", "repositoryTabHtml", "repositoryTabGroupHtml",
    "renderRepositoryTabs", "renderRepositoryTabTools", "closeRepositoryTabTools", "renderRepositoryManager",
    "openRepositoryManager", "toggleRepositoryTabGroup", "deleteRepositoryTabGroup", "activateRepository",
  ].map(declaration).join("\n"), context);
  return { context, state, element, requests, dialogs, revealed, notifications,
    flushFrames() { while (frames.length) frames.shift()(); },
    rejectNavigation() { navigationAllowed = false; },
  };
}

test("repository search, Nexus and Tab tools stay outside the scrolling repository rail", () => {
  const titlebar = markup.slice(markup.indexOf('<header class="titlebar">'), markup.indexOf("</header>", markup.indexOf('<header class="titlebar">')));
  const rail = titlebar.slice(titlebar.indexOf('id="repo-tab-rail"'), titlebar.indexOf('class="repository-toolbar"'));
  const toolbar = titlebar.slice(titlebar.indexOf('class="repository-toolbar"'));
  assert.match(rail, /id="repo-tabs"[^>]*aria-label="Repositories"[^>]*tabindex="0"/);
  assert.match(rail, /id="repo-tabs-scroll-left"/);
  assert.match(rail, /id="repo-tabs-scroll-right"/);
  assert.doesNotMatch(rail, /id="nexus-shortcut"|id="repository-tab-tools-toggle"|id="repository-tab-search-toggle"/);
  assert.match(toolbar, /id="repository-tab-search-toggle"[^>]*popovertarget="repository-tab-search-popover"[^>]*aria-label="Search repositories"/);
  assert.match(toolbar, /id="nexus-shortcut"/);
  assert.match(toolbar, /id="repository-tab-tools-toggle"/);
});

test("tab search uses saved tab order and activates existing repositories without creating chats", async () => {
  const h = harness();
  let searchOptions;
  h.context.createRepositoryTabSearch = options => { searchOptions = options; return { refresh() {} }; };
  const start = app.indexOf("repositoryTabSearch = createRepositoryTabSearch({");
  assert.ok(start > 0);
  vm.runInContext(app.slice(start, app.indexOf("\n});", start) + 4), h.context);
  const expected = repositoryTabLayout(h.state.workspace.repositories, normalizeRepositoryTabGroups(h.state.workspace.preferences.repositoryTabGroups, h.state.workspace.repositories), h.state.workspace.preferences.repositoryTabOrder)
    .flatMap(item => item.type === "repository" ? [item.repository.id] : item.repositories.map(repository => repository.id));
  assert.deepEqual(Array.from(searchOptions.getRepositories(), repository => repository.id), expected);
  assert.equal(searchOptions.getGroups()[0].collapsed, true, "search includes members of collapsed groups without opening them");
  assert.equal(searchOptions.getActiveRepositoryId(), "repo-a");
  h.state.currentView = "global";
  assert.equal(searchOptions.getActiveRepositoryId(), null, "a background repo is not marked as the current view in Nexus");
  const originalDraft = h.state.repositoryDrafts["repo-a"];
  assert.equal(await searchOptions.onSelect("missing-repo"), false);
  assert.equal(await searchOptions.onSelect("repo-b"), true);
  assert.equal(h.state.activeRepository.id, "repo-b");
  assert.equal(h.state.currentView, "repository");
  assert.equal(h.state.repositoryDrafts["repo-a"], originalDraft);
  assert.equal(h.state.activeTaskByRepository["repo-a"], "task-a");
  assert.equal(h.state.globalDraft, "Keep Nexus draft");
  assert.equal(h.requests.some(request => /ai-tasks/.test(request.path)), false);
  h.rejectNavigation();
  assert.equal(await searchOptions.onSelect("repo-c"), false);
  assert.equal(h.state.activeRepository.id, "repo-b");
});

test("the quick repository search is a separate safe switcher, not the offboarding manager", () => {
  const start = markup.indexOf('<section id="repository-tab-search-popover"');
  const popup = markup.slice(start, markup.indexOf("</section>", start));
  assert.match(popup, /popover="auto" role="dialog" aria-labelledby="repository-tab-search-heading"/);
  assert.match(popup, /id="repository-tab-search-input"[^>]*type="search"/);
  assert.match(popup, /id="repository-tab-search-status"[^>]*role="status"/);
  assert.doesNotMatch(popup, /Offboard|data-offboard|id="repo-offboard"/);
});

test("Tab tools is an accessible native popover with only onboarding, repository management and groups", () => {
  const menuStart = markup.indexOf('<section id="repository-tab-tools-menu"');
  const menu = markup.slice(menuStart, markup.indexOf("</section>", menuStart));
  assert.ok(menuStart >= 0);
  assert.match(markup, /id="repository-tab-tools-toggle"[^>]*popovertarget="repository-tab-tools-menu"[^>]*aria-label="Tab tools"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-controls="repository-tab-tools-menu"/);
  assert.match(menu, /popover="auto" role="dialog" aria-labelledby="repository-tab-tools-heading"/);
  assert.deepEqual([...menu.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]), ["add-repo", "manage-repositories", "repo-groups"]);
  assert.match(menu, /id="repository-tab-tools-groups"/);
  assert.doesNotMatch(menu, /All repositories|id="repo-tabs"|id="nexus-shortcut"|data-repository-id=/i);
});

test("the titlebar Tab tools trigger is icon-only with a hover name and accessible label", () => {
  const trigger = markup.match(/<button\b[^>]*id="repository-tab-tools-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(trigger);
  assert.match(trigger, /\btitle="Tab tools"/);
  assert.match(trigger, /\baria-label="Tab tools"/);
  assert.match(trigger, /<svg\b[^>]*aria-hidden="true"/);
  assert.match(trigger, /<path\b[^>]*d="M4 6h16M4 12h16M4 18h16"/);
  assert.doesNotMatch(trigger, /<span\b|>TAB TOOLS</);
  assert.equal(trigger.replace(/<[^>]*>/g, "").trim(), "");
});

test("collapsed groups retain one named top-bar control while hiding only their repository tabs", async () => {
  const h = harness();
  h.context.renderRepositoryTabs();
  const collapsedTabs = h.element("#repo-tabs").innerHTML;
  assert.doesNotMatch(collapsedTabs, /data-repository-id="repo-[ab]"/);
  assert.match(collapsedTabs, /data-repository-id="repo-c"/);
  assert.equal((collapsedTabs.match(/data-toggle-tab-group="group-a"/g) || []).length, 1);
  assert.match(collapsedTabs, /<button\b[^>]*data-toggle-tab-group="group-a"[^>]*aria-expanded="false"/);
  assert.match(collapsedTabs, />Backend<\/span>/);
  assert.match(collapsedTabs, />2<\//);
  assert.ok(collapsedTabs.indexOf('data-toggle-tab-group="group-a"') < collapsedTabs.indexOf('data-repository-id="repo-c"'));
  const menu = h.element("#repository-tab-tools-groups").innerHTML;
  assert.match(menu, /data-toggle-tab-group="group-a" aria-expanded="false"/);
  assert.match(menu, /Backend<\/span><small>2<\/small>/);
  assert.match(menu, /data-edit-tab-group="group-a"/);
  assert.doesNotMatch(menu, /data-repository-id=|Service A|Service B|Service C/);
  await h.context.toggleRepositoryTabGroup("group-a");
  const tabs = h.element("#repo-tabs").innerHTML;
  assert.deepEqual([...tabs.matchAll(/data-repository-id="([^"]+)"/g)].map((match) => match[1]), ["repo-a", "repo-b", "repo-c"]);
  assert.equal((tabs.match(/data-toggle-tab-group="group-a"/g) || []).length, 1);
  assert.match(tabs, /<button\b[^>]*data-toggle-tab-group="group-a"[^>]*aria-expanded="true"/);
  assert.match(tabs, />Backend<\/span>/);
  assert.ok(tabs.indexOf('data-toggle-tab-group="group-a"') < tabs.indexOf('data-repository-id="repo-a"'));
  assert.match(h.element("#repository-tab-tools-groups").innerHTML, /aria-expanded="true"/);
});

test("Tab tools keeps the same decorative SVG chevron through group expansion", async () => {
  const h = harness();
  const assertChevron = (expanded) => {
    const menu = h.element("#repository-tab-tools-groups").innerHTML;
    assert.match(menu, new RegExp(`data-toggle-tab-group="group-a" aria-expanded="${expanded}"`));
    assert.equal((menu.match(/class="disclosure-chevron"/g) || []).length, 1);
    assert.match(menu, /<svg class="disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"><\/path><\/svg>/);
    assert.doesNotMatch(menu, /[⌄▾▼›]/);
  };
  h.context.renderRepositoryTabTools();
  assertChevron(false);
  await h.context.toggleRepositoryTabGroup("group-a");
  assertChevron(true);
});

test("all-collapsed saved groups stay discoverable in the rail without a hidden-groups empty state", () => {
  const h = harness();
  h.state.workspace.preferences.repositoryTabGroups.push({ id: "group-b", name: "Frontend", color: "violet", collapsed: true, repositoryIds: ["repo-c"] });
  h.context.renderRepositoryTabs();
  const tabs = h.element("#repo-tabs").innerHTML;
  assert.deepEqual([...tabs.matchAll(/data-toggle-tab-group="([^"]+)"/g)].map((match) => match[1]), ["group-a", "group-b"]);
  assert.match(tabs, />Backend<\/span>/);
  assert.match(tabs, />Frontend<\/span>/);
  assert.doesNotMatch(tabs, /data-repository-id=|repository-tabs-empty|Groups hidden/);
});

test("top-bar group controls escape saved names and identifiers in text and attributes", () => {
  const h = harness();
  const group = h.state.workspace.preferences.repositoryTabGroups[0];
  group.id = 'group-"<&';
  group.name = 'CX "<&> <img src=x onerror=1>';
  h.context.renderRepositoryTabs();
  const tabs = h.element("#repo-tabs").innerHTML;
  assert.match(tabs, /data-toggle-tab-group="group-&quot;&lt;&amp;"/);
  assert.match(tabs, /CX &quot;&lt;&amp;&gt; &lt;img src=x onerror=1&gt;/);
  assert.doesNotMatch(tabs, /<img|data-toggle-tab-group="group-"<&/);
});

test("clicking the top-bar group control toggles its members without activating or offboarding a repository", async () => {
  const h = harness();
  const activation = [], offboarding = [];
  h.context.activateRepository = (id) => activation.push(id);
  h.context.openCloseRepositoryDialog = (id) => offboarding.push(id);
  const start = app.indexOf('  $("#repo-tabs").addEventListener("click",');
  const end = app.indexOf('  $("#repo-offboard").addEventListener', start);
  vm.runInContext(app.slice(start, end), h.context);
  const event = { target: { closest: (selector) => selector === "[data-toggle-tab-group]" ? { dataset: { toggleTabGroup: "group-a" } } : null } };
  const click = async () => {
    for (const listener of h.element("#repo-tabs").listeners.get("click")) await listener(event);
  };
  await click();
  assert.equal(h.state.workspace.preferences.repositoryTabGroups[0].collapsed, false);
  assert.match(h.element("#repo-tabs").innerHTML, /data-repository-id="repo-a"/);
  await click();
  assert.equal(h.state.workspace.preferences.repositoryTabGroups[0].collapsed, true);
  assert.match(h.element("#repo-tabs").innerHTML, /data-toggle-tab-group="group-a"/);
  assert.doesNotMatch(h.element("#repo-tabs").innerHTML, /data-repository-id="repo-[ab]"/);
  assert.deepEqual(activation, []);
  assert.deepEqual(offboarding, []);
  assert.equal(h.state.currentView, "repository");
  assert.equal(h.state.activeRepository.id, "repo-a");
  assert.equal(h.state.repositoryDrafts["repo-a"], "Keep my draft");
  assert.deepEqual(h.requests.map((request) => [request.path, request.method]), [["/api/preferences", "PATCH"], ["/api/preferences", "PATCH"]]);
});

test("group visibility and deletion preserve current chats, drafts, agent work, and repository membership", async () => {
  const h = harness();
  const retained = () => JSON.stringify({
    currentView: h.state.currentView, activeRepository: h.state.activeRepository,
    repositoryDrafts: h.state.repositoryDrafts, activeTaskByRepository: h.state.activeTaskByRepository,
    globalDraft: h.state.globalDraft, globalJob: h.state.globalJob, repositories: h.state.workspace.repositories,
  });
  const before = retained();
  await h.context.toggleRepositoryTabGroup("group-a");
  await h.context.toggleRepositoryTabGroup("group-a");
  assert.equal(retained(), before);
  h.state.editingRepositoryTabGroupId = "group-a";
  await h.context.deleteRepositoryTabGroup();
  assert.equal(retained(), before);
  assert.equal(h.state.workspace.preferences.repositoryTabGroups.length, 0);
  assert.equal((h.element("#repo-tabs").innerHTML.match(/data-repository-id=/g) || []).length, 3);
  assert.ok(h.requests.every((request) => request.path === "/api/preferences" && request.method === "PATCH"));
});

test("dragging a group saves order and membership together, without changing chats or repository data", async () => {
  const h = harness();
  const repositories = JSON.stringify(h.state.workspace.repositories);
  const draft = h.state.globalDraft;
  await h.context.moveRepositoryTab({ source: { type: "group", id: "group-a" }, target: { type: "repository", id: "repo-c" }, position: "after" });
  assert.equal(h.requests.length, 1);
  assert.deepEqual(Object.keys(h.requests[0].body).sort(), ["repositoryTabGroups", "repositoryTabOrder"]);
  assert.deepEqual(h.requests[0].body.repositoryTabOrder, [{ type: "repository", id: "repo-c" }, { type: "group", id: "group-a" }]);
  assert.equal(JSON.stringify(h.state.workspace.repositories), repositories);
  assert.equal(h.state.activeRepository.id, "repo-a");
  assert.equal(h.state.globalDraft, draft);
  assert.equal(h.state.globalJob.status, "running");
  const tabs = h.element("#repo-tabs").innerHTML;
  assert.ok(tabs.indexOf('data-repository-id="repo-c"') < tabs.indexOf('data-tab-group-block="group-a"'));
  assert.match(tabs, /role="group" aria-label="Backend repository tabs"/);
  assert.equal(h.element("#repository-tab-move-status").textContent, "Tab layout saved.");
});

test("a failed layout save keeps the previous order and reports failure instead of showing an unsaved move", async () => {
  const h = harness();
  h.context.renderRepositoryTabs();
  const preferences = JSON.stringify(h.state.workspace.preferences), html = h.element("#repo-tabs").innerHTML;
  h.context.api = async () => { throw new Error("Disk is unavailable"); };
  await h.context.moveRepositoryTab({ source: { type: "repository", id: "repo-c" }, target: { type: "group", id: "group-a" }, position: "inside" });
  assert.equal(JSON.stringify(h.state.workspace.preferences), preferences);
  assert.equal(h.element("#repo-tabs").innerHTML, html);
  assert.equal(h.state.repositoryTabSaving, false);
  assert.equal(h.element("#repo-tabs").attributes.get("aria-busy"), "false");
  assert.match(h.element("#repository-tab-move-status").textContent, /previous order is unchanged/);
  assert.deepEqual(h.notifications, [["Disk is unavailable", "error"]]);
});

test("pending layout saves block overlapping drag writes and preserve unrelated preferences", async () => {
  const h = harness();
  let finish;
  h.context.api = () => new Promise((resolve) => { finish = resolve; });
  const pending = h.context.moveRepositoryTab({ source: { type: "group", id: "group-a" }, target: { type: "repository", id: "repo-c" }, position: "after" });
  assert.equal(h.state.repositoryTabSaving, true);
  assert.equal(h.state.workspace.preferences.repositoryTabOrder, undefined);
  await h.context.moveRepositoryTab({ source: { type: "repository", id: "repo-c" }, target: { type: "group", id: "group-a" }, position: "inside" });
  h.state.workspace.preferences.nexusTheme = "ember";
  finish({});
  await pending;
  assert.equal(h.state.workspace.preferences.nexusTheme, "ember");
  assert.equal(h.state.workspace.preferences.repositoryTabGroups[0].repositoryIds.length, 2);
  assert.equal(h.state.repositoryTabSaving, false);
});

test("background refresh cannot replace elements underneath an active drag", () => {
  const h = harness();
  h.context.renderRepositoryTabs();
  const html = h.element("#repo-tabs").innerHTML;
  h.state.repositoryTabDrag = { isDragging: () => true };
  h.state.workspace.preferences.repositoryTabGroups[0].collapsed = false;
  h.context.renderRepositoryTabs();
  assert.equal(h.element("#repo-tabs").innerHTML, html);
  assert.equal(h.state.repositoryTabRenderPending, true);
});

test("background repository renders retain scroll position and reveal the active tab only when requested", () => {
  const h = harness();
  h.context.renderRepositoryTabs();
  h.flushFrames();
  assert.equal(h.element("#repo-tabs").scrollLeft, 180);
  assert.deepEqual(h.revealed, []);
  h.context.renderRepositoryTabs({ revealActive: true });
  h.flushFrames();
  assert.deepEqual(h.revealed, ["repo-a"]);
});

test("the repository manager searches names, paths and group names without losing hidden repositories", () => {
  const h = harness();
  const cases = [[" SERVICE B ", ["repo-b"]], ["web", ["repo-c"]], ["BACKEND", ["repo-a", "repo-b"]], ["", ["repo-a", "repo-b", "repo-c"]], ["unmatched", []]];
  for (const [search, expected] of cases) {
    h.element("#repository-manager-search").value = search;
    h.context.renderRepositoryManager();
    const rows = h.element("#repository-manager-list").innerHTML;
    assert.deepEqual([...rows.matchAll(/data-open-managed-repository="([^"]+)"/g)].map((match) => match[1]), expected, search);
    assert.deepEqual([...rows.matchAll(/data-offboard-managed-repository="([^"]+)"/g)].map((match) => match[1]), expected, search);
    if (search === "BACKEND") assert.match(rows, /Backend · tabs hidden/);
    if (!expected.length) assert.match(rows, /No repositories match your search/);
  }
});

test("opening repository management dismisses Tab tools, resets its search and focuses the dialog search", () => {
  const h = harness();
  h.element("#repository-tab-tools-menu").popoverOpen = true;
  h.element("#repository-manager-search").value = "old filter";
  h.context.openRepositoryManager();
  assert.equal(h.element("#repository-tab-tools-menu").popoverOpen, false);
  assert.equal(h.element("#repository-manager-search").value, "");
  assert.deepEqual(h.dialogs, ["manage-repositories-dialog"]);
  assert.equal(h.element("#repository-manager-search").focusCount, 1);
});

test("opening a repository from a hidden group exposes that group and retains the existing activation path", async () => {
  const h = harness();
  await h.context.activateRepository("repo-b");
  h.flushFrames();
  assert.equal(h.state.workspace.preferences.repositoryTabGroups[0].collapsed, false);
  assert.equal(h.state.activeRepository.id, "repo-b");
  assert.equal(h.state.repositoryDrafts["repo-a"], "Keep my draft");
  assert.equal(h.state.globalJob.status, "running");
  assert.match(h.element("#repo-tabs").innerHTML, /data-repository-id="repo-b" aria-current="page"/);
  assert.deepEqual(h.requests.map((request) => [request.path, request.method]), [["/api/preferences", "PATCH"], ["/api/repositories/repo-b/activate", "POST"]]);
  assert.deepEqual(h.revealed, ["repo-b"]);
});

test("cancelled repository activation cannot expand a group, change tasks, discard drafts or issue API calls", async () => {
  const h = harness();
  h.rejectNavigation();
  const before = JSON.stringify(h.state);
  await h.context.activateRepository("repo-b");
  h.flushFrames();
  assert.equal(JSON.stringify(h.state), before);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.revealed, []);
});

test("cancelled onboarding navigation preserves the chooser inputs and pending repositories", () => {
  const h = harness();
  h.rejectNavigation();
  h.element("#repo-path").value = "/source/pending";
  h.element("#repo-clone-url").value = "https://example.test/source.git";
  const before = JSON.stringify(h.state);
  const start = app.indexOf("  const showRepositoryChooser = () => {");
  const end = app.indexOf('  $("#repo-groups").addEventListener', start);
  vm.runInContext(app.slice(start, end), h.context);
  h.element("#add-repo").listeners.get("click")[0]();
  assert.equal(JSON.stringify(h.state), before);
  assert.equal(h.element("#repo-path").value, "/source/pending");
  assert.equal(h.element("#repo-clone-url").value, "https://example.test/source.git");
  assert.deepEqual(h.dialogs, []);
  assert.deepEqual(h.requests, []);
});

test("Tab tools Escape and manager actions use the existing focus, activation and offboarding paths", () => {
  const h = harness();
  const offboarding = [], activation = [];
  h.context.activateRepository = (id) => activation.push(id);
  h.context.openCloseRepositoryDialog = (id) => offboarding.push(id);
  h.context.positionRepositoryTabTools = () => {};
  h.context.window = { addEventListener() {} };
  h.context.ResizeObserver = class { observe() {} };
  const start = app.indexOf('  const tabToolsMenu = $("#repository-tab-tools-menu");');
  const end = app.indexOf('  $("#ai-status-pill").addEventListener', start);
  vm.runInContext(app.slice(start, end), h.context);
  const menu = h.element("#repository-tab-tools-menu");
  menu.popoverOpen = true;
  menu.listeners.get("toggle")[0]();
  assert.equal(h.element("#repository-tab-tools-toggle").attributes.get("aria-expanded"), "true");
  let prevented = false;
  menu.listeners.get("keydown")[0]({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(menu.popoverOpen, false);
  assert.equal(h.element("#repository-tab-tools-toggle").focusCount, 1);
  menu.listeners.get("toggle")[0]();
  assert.equal(h.element("#repository-tab-tools-toggle").attributes.get("aria-expanded"), "false");
  const click = h.element("#repository-manager-list").listeners.get("click")[0];
  click({ target: { closest: (selector) => selector === "[data-open-managed-repository]" ? { dataset: { openManagedRepository: "repo-a" } } : null } });
  click({ target: { closest: (selector) => selector === "[data-offboard-managed-repository]" ? { dataset: { offboardManagedRepository: "repo-b" } } : null } });
  assert.deepEqual(activation, ["repo-a"]);
  assert.deepEqual(offboarding, ["repo-b"]);
  assert.deepEqual(h.requests, []);
});
