import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const styles = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const rules = [...styles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selector: match[1].trim(),
  declarations: Object.fromEntries(match[2].split(";").map((declaration) => {
    const colon = declaration.indexOf(":");
    return colon < 0 ? [] : [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
  }).filter((entry) => entry.length)),
}));
const declarations = (selector) => Object.assign({}, ...rules.filter((rule) => rule.selector === selector).map((rule) => rule.declarations));

test("branch card gives branch name remaining space and reserves a centered Fetch target", () => {
  const bar = { ...declarations(".branch-bar"), ...declarations(".git-panel .branch-bar") };
  assert.equal(bar.display, "flex");
  assert.equal(bar["align-items"], "center");
  assert.equal(bar.padding, "4px 6px");
  assert.equal(bar.gap, "6px");
  const selector = declarations(".branch-selector");
  assert.equal(selector.flex, "1 1 0");
  assert.equal(selector["min-width"], "0");
  assert.equal(selector["max-width"], "none", "a resized dock must not retain the old 255px branch cap");
  const fetch = declarations(".branch-bar #fetch-button");
  assert.equal(fetch.flex, "0 0 52px", "Fetch must not shrink against a long branch");
  assert.equal(fetch.height, "32px");
  assert.equal(fetch.padding, "0 8px");
  assert.equal(fetch.margin, "0");
  assert.equal(fetch["margin-left"], undefined);
  assert.equal(fetch["align-items"], "center");
  assert.equal(fetch["justify-content"], "center");
  assert.equal(fetch["white-space"], "nowrap");
});

test("long branches truncate their name without shrinking or losing either branch icon", () => {
  const name = { ...declarations(".branch-bar strong"), ...declarations(".branch-selector strong") };
  assert.equal(name["min-width"], "0");
  assert.equal(name.flex, "1 1 auto");
  assert.equal(name.overflow, "hidden");
  assert.equal(name["text-overflow"], "ellipsis");
  assert.equal(name["white-space"], "nowrap");
  assert.equal(name["text-align"], "left");
  assert.equal(name["line-height"], "1.5", "font ascenders/descenders must fit before horizontal clipping");
  assert.equal(name["padding-block"], "1px", "retain a small ink safety gutter at fractional zoom");
  assert.equal(declarations(".branch-icon").flex, "0 0 18px");
  assert.equal(declarations(".branch-chevron").flex, "0 0 15px");
  assert.equal(declarations(".branch-selector").height, "36px");
});

test("sync counters keep one bounded row and a zero count does not leave a spacer", () => {
  const sync = declarations(".sync-state");
  assert.equal(sync["white-space"], "nowrap");
  assert.equal(sync["min-width"], "0");
  assert.equal(sync["max-width"], "28%");
  assert.equal(sync["text-overflow"], "ellipsis", "extreme counts must not displace Fetch");
  assert.equal(sync["font-variant-numeric"], "tabular-nums");
  assert.equal(declarations(".sync-state:empty").display, "none");
  assert.match(html, /id="branch-selector"[\s\S]*?id="branch-name"[\s\S]*?class="branch-chevron"[\s\S]*?id="sync-state"[\s\S]*?id="fetch-button"/);
  assert.match(source, /label\.setAttribute\("aria-label", label\.title\)/, "the full count remains available in the existing accessible description");
  assert.match(source, /\$\("#fetch-button"\)\.addEventListener\("click", \(\) => gitAction\("fetch"\)\)/, "layout must not change Git's explicit Fetch action");
});

test("Fetch hover and keyboard focus use theme tokens without changing layout or disabled behavior", () => {
  const hover = declarations(".branch-bar #fetch-button:hover:not(:disabled)");
  assert.equal(hover["border-color"], "var(--line)");
  assert.equal(hover.background, "var(--surface-2)");
  assert.equal(hover.color, "var(--text)");
  const focus = declarations(".branch-bar :is(#fetch-button, .branch-selector):focus-visible");
  assert.equal(focus.outline, "2px solid var(--accent)");
  assert.equal(focus["outline-offset"], "2px");
  for (const rule of rules.filter((rule) => /branch-bar|branch-selector|sync-state|fetch-button/.test(rule.selector))) {
    assert.doesNotMatch(rule.selector, /data-theme|data-font-size/, "all font scales and themes share the same branch layout");
    assert.equal(rule.declarations["margin-left"], undefined, "no legacy auto-margin can pin Fetch to the card edge");
  }
});
