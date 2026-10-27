import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const styles = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1].trim().split(",").map((selector) => selector.trim()),
  declarations: Object.fromEntries(match[2].split(";").map((item) => {
    const colon = item.indexOf(":");
    return colon < 0 ? [] : [item.slice(0, colon).trim(), item.slice(colon + 1).trim()];
  }).filter((entry) => entry.length)),
}));
const matchingRules = (selector) => rules.filter((rule) => rule.selectors.includes(selector));
const declaration = (selector, property) => matchingRules(selector)
  .map((rule) => rule.declarations[property]).filter((value) => value !== undefined).at(-1);

test("Nexus workspace and compact identity/provider row have no centered desktop-width cap", () => {
  for (const selector of [".global-codex-layout", ".global-codex-panel > header .global-codex-header-row"]) {
    assert.equal(declaration(selector, "width"), "100%", selector);
    assert.equal(declaration(selector, "margin"), "0", selector);
    for (const { declarations } of matchingRules(selector)) {
      if (declarations["max-width"]) assert.equal(declarations["max-width"], "none", selector);
      if (declarations.width) assert.equal(declarations.width, "100%", selector);
    }
  }
  assert.equal(declaration(".global-codex-layout", "max-width"), "none");
  assert.equal(declaration(".global-codex-panel > header .global-codex-header-row", "min-width"), "0");
});

test("header, sidebar and chat share a compact Nexus edge without changing other workspace gutters", () => {
  assert.equal(declaration(":root", "--responsive-content-pad"), "clamp(12px, 2vw, 30px)");
  assert.equal(declaration(".global-codex-panel", "--nexus-edge-gutter"), "8px");
  assert.equal(declaration(".global-codex-panel", "padding-inline"), "var(--nexus-edge-gutter)");
  assert.equal(declaration(".global-codex-panel > header", "padding-inline"), "var(--nexus-edge-gutter)");
  assert.equal(declaration(".global-codex-panel > header", "margin-inline"), "calc(-1 * var(--nexus-edge-gutter))");
  assert.equal(declaration(".global-codex-panel > header .global-codex-header-row", "grid-template-columns"), "auto minmax(0, 1fr)");
});

test("fluid width preserves existing sidebar, collapsed grid, and independent chat scrolling", () => {
  assert.equal(declaration(".global-codex-layout:not(.task-panel-collapsed)", "--global-task-panel-width"), "var(--side-panel-width) !important");
  assert.equal(declaration(".global-codex-layout:not(.task-panel-collapsed)", "grid-template-columns"), "var(--side-panel-width) 0 minmax(0, 1fr)");
  assert.equal(declaration(".global-codex-layout.task-panel-collapsed", "grid-template-columns"), "0 0 minmax(0, 1fr)");
  assert.equal(declaration(".global-codex-layout > main", "grid-column"), "3");
  assert.equal(declaration(".global-codex-layout > main", "min-width"), "0");
  assert.equal(declaration(".task-sidebar-resizer", "display"), "none !important");
  assert.equal(declaration(".chat-scroll-region", "overflow"), "hidden auto");
  assert.equal(declaration(".global-chat-scroll-region", "width"), "100%");
  assert.equal(declaration(".chat-message.assistant .chat-message-body", "max-width"), "calc(100% - 40px)");
});

test("Nexus composer wraps the four model controls against available width without changing type scale", () => {
  const footer = "#global-codex-panel .global-prompt-card.chat-composer > footer";
  assert.equal(declaration(footer, "flex-wrap"), "wrap");
  assert.equal(declaration(footer, "justify-content"), "flex-start");
  assert.equal(declaration(`${footer} > .global-agent-options`, "flex"), "1 1 460px");
  assert.equal(declaration(`${footer} > .global-agent-options`, "max-width"), "min(100%, 680px)");
  assert.equal(declaration(`${footer} > .global-agent-options`, "grid-template-columns"), "repeat(2, minmax(0, 1fr))");
  assert.equal(declaration(`${footer} > .context-mode-control`, "max-width"), "100%");
  assert.equal(declaration(".chat-composer .agent-options", "grid-template-columns"), "repeat(2, minmax(0, 1fr))");
  const scopedBlock = styles.slice(styles.indexOf("/* Wrap Nexus controls"), styles.indexOf("/* Data, diff, and orchestration surfaces"));
  assert.ok(scopedBlock.length > 0);
  assert.match(scopedBlock, /grid-template-columns: minmax\(80px, \.8fr\) minmax\(125px, 1\.5fr\) minmax\(118px, 1fr\) minmax\(94px, auto\)/);
  assert.doesNotMatch(scopedBlock, /@media|font(?:-size)?\s*:|zoom\s*:|transform\s*:|display\s*:\s*none|visibility\s*:/);
});

test("a hidden Nexus Queue leaves Send aligned to the composer end", () => {
  assert.equal(declaration("#global-codex-panel #run-global-agent", "margin-left"), "auto");
  assert.equal(declaration("#global-codex-panel #queue-global-agent-prompt + #run-global-agent", "margin-left"), undefined);
  assert.match(html, /id="queue-global-agent-prompt"[^>]*class="[^"]*\bhidden\b/);
  for (const selector of ["#global-codex-panel #queue-global-agent-prompt", "#global-codex-panel #run-global-agent"]) {
    assert.equal(declaration(selector, "display"), undefined, "alignment must not override action visibility");
  }
});

test("visible Nexus Queue and Send form one end-aligned action cluster", () => {
  assert.equal(declaration("#global-codex-panel #queue-global-agent-prompt", "margin-left"), "auto");
  assert.equal(declaration("#global-codex-panel #queue-global-agent-prompt:not(.hidden) + #run-global-agent", "margin-left"), "0");
  assert.match(html, /<button id="queue-global-agent-prompt"[^>]*>[\s\S]*?<\/button>\s*<button id="run-global-agent"/);
  assert.equal(declaration("#run-agent", "margin-left"), undefined, "repository action positioning must not change");
});

// Source-contract budget checks, not a substitute for Chromium/Electron layout QA.
// Account for the existing app zoom: a display pixel is not always one CSS pixel.
function horizontalSize(value, available) {
  if (value === undefined || value === "none" || value === "100%") return available;
  const capped = value.match(/^min\(100%, ([\d.]+)px\)$/);
  if (capped) return Math.min(available, Number(capped[1]));
  const pixels = value.match(/^([\d.]+)px$/);
  assert.ok(pixels, `Unexpected width contract: ${value}`);
  return Number(pixels[1]);
}

for (const displayWidth of [1440, 2560, 3440]) {
  test(`Nexus allocates the full ${displayWidth}px display content budget at standard and enlarged scale`, () => {
    for (const zoom of [1, 1.12, 1.25]) {
      for (const reservedRail of [30, 290]) {
        const available = displayWidth / zoom - reservedRail - 2 * 30;
        for (const selector of [".global-codex-layout", ".global-codex-panel > header .global-codex-header-row"]) {
          const width = horizontalSize(declaration(selector, "width"), available);
          const actual = Math.min(width, horizontalSize(declaration(selector, "max-width"), available));
          assert.equal(actual, available, `${selector}: zoom=${zoom}, reservedRail=${reservedRail}`);
        }
      }
    }
  });
}
