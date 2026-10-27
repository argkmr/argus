import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { repositoryTabLayout } from "../public/repository-tab-groups.js";
import { NEXUS_THEMES, DEFAULT_NEXUS_THEME } from "../public/nexus-themes.mjs";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styles = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const navigation = app.slice(app.indexOf("function switchPrimaryView("), app.indexOf("async function restoreRoute("));
const renderTabs = app.slice(app.indexOf("function repositoryTabHtml("), app.indexOf("function renderRepositoryTabGroupEditor("));

function mockElement(dataset = {}) {
  const classes = new Set(), attributes = new Map();
  return {
    classes, attributes, dataset, scrollLeft: 0,
    classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); } },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    contains: () => false,
  };
}

function harness() {
  const repositories = [{ id: "repo-a", name: "Service A", path: "/repo/a" }, { id: "repo-b", name: "Service B", path: "/repo/b" }];
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, mockElement());
    return elements.get(selector);
  };
  const tabs = repositories.map((repository) => {
    const tab = mockElement({ repositoryTab: repository.id });
    tab.button = mockElement();
    tab.querySelector = () => tab.button;
    return tab;
  });
  const group = mockElement({ tabGroup: "group-a" });
  group.classes.add("repo-tab-group-blue");
  group.classes.add("collapsed");
  // A collapsed group has no rendered repository tab to derive selection from.
  group.querySelector = () => null;
  const state = {
    currentView: "repository", activeRepository: repositories[0],
    activeTaskByRepository: { "repo-a": "task-a" }, repositoryDrafts: { "repo-a": "unsent draft" },
    workspace: { activeRepositoryId: "repo-a", repositories },
  };
  const groups = [{ id: "group-a", name: "Backend", color: "blue", collapsed: true, repositoryIds: ["repo-a"] }];
  let closed = true;
  const context = vm.createContext({
    state, $: element, $$: (selector) => selector.includes("data-repository-tab") ? tabs : [group],
    document: { body: element("body") }, closeOpenDialogs: () => closed,
    setVersionControlDockOpen() {}, syncWorkspaceRail() {}, syncViewUrl() {}, requestAnimationFrame() {},
    renderServices() {}, refreshRuntimeDetections() {}, refreshProcesses() {},
    escapeHtml: (value) => String(value), repositoryTabLayout,
    repositoryTabGroups: () => groups,
  });
  vm.runInContext(navigation + renderTabs, context);
  return { context, state, tabs, group, groups, element, rejectNavigation() { closed = false; } };
}

test("Nexus is the only active top-bar destination; remembered repository, drafts and group state survive", () => {
  const h = harness();
  h.context.switchPrimaryView("repository");
  assert.ok(h.tabs[0].classes.has("active"));
  assert.equal(h.tabs[0].button.attributes.get("aria-current"), "page");
  assert.ok(h.group.classes.has("contains-active"));
  const before = JSON.stringify(h.state);
  h.context.switchPrimaryView("global");
  assert.ok(h.tabs.every((tab) => !tab.classes.has("active")));
  assert.ok(h.tabs.every((tab) => !tab.button.attributes.has("aria-current")));
  assert.ok(!h.group.classes.has("contains-active"));
  assert.ok(h.group.classes.has("repo-tab-group-blue"));
  assert.ok(h.group.classes.has("collapsed"));
  assert.equal(h.element("#nexus-shortcut").attributes.get("aria-current"), "page");
  assert.equal(h.element("#nexus-shortcut").attributes.get("aria-pressed"), "true");
  assert.equal(JSON.stringify({ ...h.state, currentView: "repository" }), before);
});

test("returning to the remembered repository restores exactly its active tab", () => {
  const h = harness();
  h.context.switchPrimaryView("global");
  h.context.switchPrimaryView("repository");
  assert.deepEqual(h.tabs.map((tab) => tab.classes.has("active")), [true, false]);
  assert.equal(h.element("#nexus-shortcut").attributes.get("aria-pressed"), "false");
  assert.ok(!h.element("#nexus-shortcut").attributes.has("aria-current"));
});

test("background tab rendering while in Nexus cannot restore a stale repository highlight", () => {
  const h = harness();
  h.context.switchPrimaryView("global");
  h.context.renderRepositoryTabs();
  assert.doesNotMatch(h.element("#repo-tabs").innerHTML, /aria-current|contains-active|repo-tab active/);
  assert.match(h.element("#repo-tabs").innerHTML, /<button\b[^>]*data-toggle-tab-group="group-a"[^>]*aria-expanded="false"/);
  assert.match(h.element("#repo-tabs").innerHTML, />Backend<\/span>/);
  assert.doesNotMatch(h.element("#repo-tabs").innerHTML, /data-repository-id="repo-a"/);
  assert.match(h.element("#repo-tabs").innerHTML, /data-repository-id="repo-b"/);
  assert.match(h.element("#repository-tab-tools-groups").innerHTML, /data-toggle-tab-group="group-a" aria-expanded="false"/);
  assert.match(h.element("#global-repository-list").innerHTML, /Service A/);
  h.groups[0].collapsed = false;
  h.context.renderRepositoryTabs();
  assert.doesNotMatch(h.element("#repo-tabs").innerHTML, /aria-current|contains-active|repo-tab active/);
  assert.match(h.element("#repo-tabs").innerHTML, /<button\b[^>]*data-toggle-tab-group="group-a"[^>]*aria-expanded="true"/);
  assert.match(h.element("#repo-tabs").innerHTML, /data-repository-id="repo-a"/);
  h.context.switchPrimaryView("repository");
  h.context.renderRepositoryTabs();
  assert.equal((h.element("#repo-tabs").innerHTML.match(/aria-current="page"/g) || []).length, 1);
});

test("a collapsed active group is marked only while its repository is the current destination", () => {
  const h = harness();
  h.context.renderRepositoryTabs();
  assert.match(h.element("#repo-tabs").innerHTML, /contains-active/);
  assert.match(h.element("#repo-tabs").innerHTML, /data-toggle-tab-group="group-a"/);
  assert.doesNotMatch(h.element("#repo-tabs").innerHTML, /data-repository-id="repo-a"|aria-current="page"/);
  for (const view of ["global", "services", "api", "json", "orchestration", "ai"]) {
    h.context.switchPrimaryView(view);
    h.context.renderRepositoryTabs();
    assert.match(h.element("#repo-tabs").innerHTML, /data-toggle-tab-group="group-a"/);
    assert.doesNotMatch(h.element("#repo-tabs").innerHTML, /contains-active|aria-current="page"|repo-tab active/, view);
  }
  assert.equal(h.groups[0].collapsed, true);
  assert.equal(h.state.activeRepository.id, "repo-a");
});

test("other workspace tools and an empty workspace do not claim an active repository", () => {
  const h = harness();
  for (const view of ["services", "api", "json", "orchestration", "ai"]) {
    h.context.switchPrimaryView(view);
    assert.ok(h.tabs.every((tab) => !tab.classes.has("active")));
    assert.equal(h.element("#nexus-shortcut").attributes.get("aria-pressed"), "false");
  }
  h.state.activeRepository = null;
  h.context.switchPrimaryView("repository");
  assert.ok(h.tabs.every((tab) => !tab.classes.has("active")));
});

test("a cancelled navigation keeps both destination and visual selection intact", () => {
  const h = harness();
  h.context.switchPrimaryView("repository");
  h.rejectNavigation();
  assert.equal(h.context.switchPrimaryView("global"), false);
  assert.equal(h.state.currentView, "repository");
  assert.ok(h.tabs[0].classes.has("active"));
  assert.equal(h.element("body").dataset.view, "repository");
});

test("Nexus theme is scoped, adaptive, static and leaves service semantics and repository layouts alone", () => {
  const block = styles.slice(styles.indexOf("/* Nexus selectable themes")).split("/* Nexus theme chooser")[0].split("/* Source citations open")[0];
  assert.match(block, /:root\[data-theme="light"\] :is\(#global-codex-panel, #nexus-shortcut\)/);
  assert.match(block, /body\[data-view="global"\] #nexus-shortcut/);
  assert.match(block, /#global-codex-panel \.task-row\.active/);
  assert.match(block, /#global-codex-panel \.chat-composer:focus-within/);
  assert.match(block, /#global-codex-panel \.composer-stop-icon \{ background: currentColor/);
  assert.doesNotMatch(block, /!important|animation:|filter:|--green:|--red:|grid-template|position:|\.repo-tab[^\n]*\{/);
});

test("Midnight is the safe CSS fallback while all Nexus palettes remain selectable", () => {
  const block = styles.slice(styles.indexOf("/* Nexus selectable themes"), styles.indexOf(":root[data-theme=\"light\"] :is(#global-codex-panel, #nexus-shortcut)"));
  assert.equal(DEFAULT_NEXUS_THEME, "midnight");
  const palette = NEXUS_THEMES.find(theme => theme.id === DEFAULT_NEXUS_THEME).dark;
  for (const [name, value] of Object.entries(palette)) assert.match(block, new RegExp(`--nexus-${name}: ${value};`));
  assert.doesNotMatch(block, /#df9d64|#995019/);
});

function luminance(hex) {
  const c = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
}

test("Nexus foreground, secondary labels and action colours meet normal-text contrast in both themes", () => {
  const block = styles.slice(styles.indexOf("/* Nexus selectable themes"), styles.indexOf("#global-codex-panel {", styles.indexOf("/* Nexus selectable themes")));
  const palettes = [...block.matchAll(/\{([^}]+)\}/g)].map((match) => Object.fromEntries([...match[1].matchAll(/--nexus-([\w-]+): (#[\da-f]{6});/g)].map((entry) => [entry[1], entry[2]])));
  assert.equal(palettes.length, 2);
  for (const palette of palettes) {
    for (const foreground of ["text", "muted", "muted-2", "accent", "blue"]) {
      for (const background of ["bg", "surface", "surface-2"]) {
        assert.ok(contrast(palette[foreground], palette[background]) >= 4.5, `${foreground}/${background}: ${contrast(palette[foreground], palette[background]).toFixed(2)}`);
      }
    }
    assert.ok(contrast(palette["accent-ink"], palette.accent) >= 4.5);
  }
});
