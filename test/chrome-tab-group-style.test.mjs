import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { repositoryTabLayout } from "../public/repository-tab-groups.js";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styles = (await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector) {
  const body = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].trim() === selector).at(-1)?.[2];
  assert.ok(body, `Missing style rule: ${selector}`);
  return Object.fromEntries(body.split(";").flatMap((entry) => {
    const colon = entry.indexOf(":");
    return colon < 0 ? [] : [[entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]];
  }));
}

function declaration(name) {
  const start = app.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Missing render function: ${name}`);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}

function harness() {
  const repositories = [
    { id: "api", name: "API", path: "/source/api" },
    { id: "web", name: "Web", path: "/source/web" },
    { id: "tools", name: "Tools", path: "/source/tools" },
  ];
  const group = { id: "backend", name: "Backend", color: "blue", collapsed: false, repositoryIds: ["api", "web"] };
  const state = { currentView: "repository", activeRepository: repositories[0], workspace: { repositories, preferences: { repositoryTabGroups: [group] } } };
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: "", scrollLeft: 117, open: false, contains: () => false, querySelectorAll: () => [] });
    return elements.get(selector);
  };
  const context = vm.createContext({
    state, $: element, document: { activeElement: null }, repositoryTabLayout,
    repositoryTabGroups: () => state.workspace.preferences.repositoryTabGroups,
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    renderRepositoryTabTools() {}, renderRepositoryManager() {}, requestAnimationFrame() {},
  });
  vm.runInContext(["isRepositoryDestination", "repositoryTabHtml", "repositoryTabGroupHtml", "renderRepositoryTabs"].map(declaration).join("\n"), context);
  return { context, state, group, element };
}

test("repository tabs reclaim space without shrinking text or actionable targets", () => {
  const tab = rule(".repo-tab"), label = rule(".repo-tab-label"), close = rule(".repo-tab-close");
  assert.equal(tab.height, "26px");
  assert.equal(tab.width, "max-content");
  assert.equal(tab["min-width"], "104px");
  assert.equal(tab["max-width"], "144px");
  assert.equal(tab["border-radius"], "6px");
  assert.equal(tab.background, "transparent", "inactive tabs should not read as bulky cards");
  assert.equal(label["font-size"], "12px", "compact spacing must not make names unreadable");
  assert.equal(label["line-height"], "1.4", "custom fonts retain vertical clearance");
  assert.equal(label["text-overflow"], "ellipsis");
  assert.ok(parseFloat(close.width) >= 24 && parseFloat(close.height) >= 24);
  assert.equal(rule(".repository-tab-tools-toggle").height, "30px");
  assert.match(styles, /--titlebar-height:\s*40px/);
  assert.equal(rule("body.task-context-visible")["--rail-context-offset"], "var(--repository-context-height, 38px)", "rail and drawers follow the compact context strip");
  const h = harness();
  h.state.workspace.repositories[0].name = "very-long-repository-name-that-needs-truncation";
  const markup = h.context.repositoryTabHtml(h.state.workspace.repositories[0]);
  assert.match(markup, /title="very-long-repository-name-that-needs-truncation · \/source\/api/);
  assert.match(markup, /aria-current="page"/);
  assert.match(markup, /aria-label="Offboard very-long-repository-name-that-needs-truncation"/);
});

test("group wrappers share the regular tab baseline without introducing a second panel", () => {
  const group = rule(".repo-tab-group-block"), tab = rule(".repo-tab");
  assert.equal(group.height, tab.height);
  assert.equal(group.padding, "0");
  assert.equal(group.border, "0");
  assert.equal(group.background, "transparent");
  assert.equal(group["box-shadow"], undefined);
  assert.equal(group.display, "flex");
  assert.equal(group["align-items"], "center");
  const line = rule(".repo-tab-group-block::after");
  assert.equal(line.position, "absolute");
  assert.equal(line.left, "4px", "rounded group line must not crowd the group edges");
  assert.equal(line.right, "4px");
  assert.equal(line.height, "2px");
  assert.equal(line.bottom, "-6px", "a separate 4px gap preserves equal breathing room below tabs and group chips");
  assert.equal(line.background, "var(--tab-group-color)");
  assert.equal(line["pointer-events"], "none", "the connecting line must not steal drag or close targets");
  assert.equal(rule(".repo-tab-group-block.is-collapsed::after").display, "none");
});

test("group labels stay compact while preserving a usable join target and readable text", () => {
  const chip = rule(".repo-tab-group-chip"), name = rule(".repo-tab-group-name"), tab = rule(".repo-tab");
  assert.equal(chip.height, tab.height, "group chips and repository tabs share the same visible bottom edge");
  assert.ok(Number.parseFloat(chip["max-width"]) <= Number.parseFloat(tab["max-width"]));
  assert.ok(Number.parseFloat(chip["min-width"]) >= 48, "the center half of the chip remains at least a 24px group-join target");
  assert.equal(name["font-size"], rule(".repo-tab-label")["font-size"]);
  assert.equal(name["font-weight"], rule(".repo-tab-label")["font-weight"]);
  assert.equal(name["min-width"], "0");
  assert.equal(name.overflow, "hidden");
  assert.equal(name["text-overflow"], "ellipsis");
  assert.equal(rule(".repo-tab-group-chip small").padding, "0");
  assert.equal(rule(".repo-tab-group-chip small").background, undefined);
  assert.equal(rule('.repo-tab-group-chip[aria-expanded="true"] small').display, "none");
  assert.ok(rule(".repo-tab-group-chip:focus-visible").outline);
  assert.equal(rule(".repo-tab-group-chip.contains-active .repo-tab-group-name")["text-decoration"], "underline");
});

test("expanded groups preserve whole-group drag boundaries and separate repository close controls", () => {
  const h = harness();
  h.context.renderRepositoryTabs();
  const markup = h.element("#repo-tabs").innerHTML;
  assert.match(markup, /^<div class="repo-tab-group-block repo-tab-group-blue" data-tab-group-block="backend" role="group" aria-label="Backend repository tabs"><button/);
  assert.match(markup, /data-tab-group="backend" data-toggle-tab-group="backend" aria-expanded="true"/);
  assert.match(markup, /<small aria-hidden="true">2<\/small><\/button><div class="repo-tab /);
  assert.deepEqual([...markup.matchAll(/data-repository-tab="([^"]+)"/g)].map((match) => match[1]), ["api", "web", "tools"]);
  for (const [id, name] of [["api", "API"], ["web", "Web"], ["tools", "Tools"]]) {
    assert.match(markup, new RegExp(`<button type="button" class="repo-tab-close" data-close-repository="${id}" aria-label="Offboard ${name}" title="Offboard repository">×</button>`));
  }
  const chip = h.context.repositoryTabGroupHtml(h.group);
  assert.match(chip, /repo-tab-group-name">Backend<\/span>/);
  assert.match(chip, /Drag to move the whole group · Alt\+Shift\+Arrow to move · Right-click to edit group/);
  assert.doesNotMatch(chip, /repo-tab-group-color|<svg|data-close-repository/);
  assert.equal(h.element("#repo-tabs").scrollLeft, 117);
});

test("collapsed labels retain their count, active destination and accessible expansion action", () => {
  const h = harness();
  h.group.collapsed = true;
  h.context.renderRepositoryTabs();
  const markup = h.element("#repo-tabs").innerHTML;
  assert.match(markup, /repo-tab-group-blue is-collapsed/);
  assert.match(markup, /repo-tab-group-chip repo-tab-group-blue contains-active/);
  assert.match(markup, /aria-expanded="false" aria-label="Expand Backend tab group \(2 repositories\)"/);
  assert.match(markup, /<small aria-hidden="true">2<\/small>/);
  assert.doesNotMatch(markup, /data-repository-tab="(?:api|web)"/);
  assert.match(markup, /data-repository-tab="tools"/);
  h.state.currentView = "global";
  assert.doesNotMatch(h.context.repositoryTabGroupHtml(h.group), /contains-active/);
  assert.equal(h.group.collapsed, true);
});

test("compact group text and attributes continue escaping saved labels and identifiers", () => {
  const h = harness();
  h.group.id = 'group-"<&';
  h.group.name = 'CX "<&> <img src=x onerror=1>';
  h.context.renderRepositoryTabs();
  const markup = h.element("#repo-tabs").innerHTML;
  for (const attribute of ["data-tab-group-block", "data-tab-group", "data-toggle-tab-group"]) {
    assert.ok(markup.includes(`${attribute}="group-&quot;&lt;&amp;"`), attribute);
  }
  assert.match(markup, /repo-tab-group-name">CX &quot;&lt;&amp;&gt; &lt;img src=x onerror=1&gt;<\/span>/);
  assert.doesNotMatch(markup, /<img|group-"<&/);
});

function rgb(hex) {
  assert.match(hex, /^#[a-f\d]{6}$/i);
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function luminance(channels) {
  return channels.map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
}

test("all group colors retain readable compact label text at rest and on hover", () => {
  const foreground = luminance(rgb(rule(".repo-tab-group-chip").color));
  for (const color of ["blue", "violet", "magenta", "orange", "rose", "cyan"]) {
    const channels = rgb(rule(`.repo-tab-group-${color}`)["--tab-group-color"]);
    for (const selector of [".repo-tab-group-chip", ".repo-tab-group-chip:hover"]) {
      const background = rule(selector).background;
      const mix = background.match(/^color-mix\(in srgb, var\(--tab-group-color\) (\d+)%, #fff\)$/);
      assert.ok(mix, `Unrecognized chip fill: ${background}`);
      const fraction = Number(mix[1]) / 100;
      const fill = luminance(channels.map((value) => value * fraction + 255 * (1 - fraction)));
      const ratio = (Math.max(fill, foreground) + .05) / (Math.min(fill, foreground) + .05);
      assert.ok(ratio >= 4.5, `${color} ${selector} contrast is ${ratio.toFixed(2)}:1`);
    }
  }
});
