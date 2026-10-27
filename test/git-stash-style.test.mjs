import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const css = await fs.readFile(new URL("../public/git-stash.css", import.meta.url), "utf8");
const shared = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const selector = ".git-panel .stash-create-button";
const rule = (source, exactSelector) => {
  const body = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find((match) => match[1].trim() === exactSelector)?.[2];
  assert.ok(body, `Missing rule: ${exactSelector}`);
  return Object.fromEntries(body.split(";").map((entry) => {
    const colon = entry.indexOf(":");
    return colon < 0 ? [] : [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()];
  }).filter((entry) => entry.length));
};
const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, "");
const button = rule(uncommented, selector);

test("Stash remains a secondary, non-submit action in the existing commit grid", () => {
  const markup = html.match(/<button\b[^>]*\bid="stash-button"[^>]*>/)?.[0];
  assert.ok(markup);
  assert.match(markup, /class="stash-create-button"/);
  assert.match(markup, /type="button"/);
  assert.doesNotMatch(markup, /primary-button/);
  assert.equal(button.background, "var(--surface-2)");
  assert.equal(button.color, "var(--text)");
  assert.equal(button["border-radius"], "8px");
  assert.equal(button.appearance, "none");
  assert.equal(button["-webkit-appearance"], "none");
});

test("Stash has the existing Git action height and gap without a second top margin", () => {
  assert.equal(button["min-height"], "34px");
  assert.equal(button.height, "auto");
  assert.equal(button.padding, "8px 12px");
  assert.equal(button.margin, "0");
  assert.equal(button["margin-top"], undefined);
  assert.equal(rule(shared, ".commit-box").gap, "8px");
  assert.equal(button.display, "inline-flex");
  assert.equal(button["align-items"], "center");
  assert.equal(button["justify-content"], "center");
  assert.equal(button["font-size"], "11px");
  assert.equal(button["font-weight"], "600");
});

test("Stash follows the 250px, 260px and 720px dock without a fixed width or clipped type", () => {
  assert.equal(button.width, "100%");
  assert.equal(button["max-width"], "100%");
  assert.equal(button["min-width"], "0");
  assert.equal(button["white-space"], "normal");
  assert.equal(button["overflow-wrap"], "anywhere");
  assert.equal(button["line-height"], "1.4");
  assert.equal(button.font, "inherit");
  for (const property of ["position", "zoom", "transform", "overflow", "text-overflow"]) assert.equal(button[property], undefined);
  // Source sizing contract only; rendered layout is checked separately in the isolated app.
  const parentInset = Number.parseFloat(rule(shared, ".commit-box").padding) * 2;
  const borderBoxHeight = Math.max(34, 11 * 1.4 + 8 * 2 + 2);
  for (const width of [250, 260, 720]) {
    for (const zoom of [1, 1.12, 1.22]) {
      const available = (width - parentInset) * zoom;
      assert.ok(available > (12 * 2 + 2) * zoom);
      assert.equal(borderBoxHeight * zoom, 34 * zoom);
      assert.ok(available < width * zoom, "parent gutters remain inside the dock at every scale");
    }
  }
});

function rgb(hex) {
  assert.match(hex, /^#[a-f\d]{6}$/i);
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}
function luminance(channels) {
  return channels.map((channel) => channel / 255).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}
function contrast(first, second) {
  const lights = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lights[0] + .05) / (lights[1] + .05);
}

for (const [theme, rootSelector] of [["dark", ":root"], ["light", ':root[data-theme="light"]']]) {
  test(`Stash text, boundary and keyboard focus remain distinct in ${theme} mode`, () => {
    const tokens = rule(shared, rootSelector);
    const surface = rgb(tokens["--surface-2"]);
    const border = rgb(tokens["--muted"]).map((channel, index) => channel * .75 + rgb(tokens["--line"])[index] * .25);
    assert.equal(button.border, "1px solid color-mix(in srgb, var(--muted) 75%, var(--line))");
    for (const background of ["--surface", "--surface-2", "--surface-3"]) {
      assert.ok(contrast(rgb(tokens["--text"]), rgb(tokens[background])) >= 4.5, `${theme} text on ${background}`);
    }
    assert.ok(contrast(border, surface) >= 3, `${theme} control boundary`);
    assert.ok(contrast(rgb(tokens["--blue"]), surface) >= 3, `${theme} keyboard focus`);
  });
}

test("hover and pressed states exclude disabled controls and keyboard focus is explicit", () => {
  assert.equal(rule(uncommented, `${selector}:hover:not(:disabled)`).background, "var(--surface-3)");
  assert.equal(rule(uncommented, `${selector}:active:not(:disabled)`).background, "var(--surface)");
  assert.equal(rule(uncommented, `${selector}:disabled`).cursor, "not-allowed");
  const focus = rule(uncommented, `${selector}:focus-visible`);
  assert.equal(focus.outline, "2px solid var(--blue)");
  assert.equal(focus["outline-offset"], "2px");
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(css, /border-color:\s*ButtonText;\s*background:\s*ButtonFace;\s*color:\s*ButtonText;/);
  assert.match(css, /outline-color:\s*Highlight/);
});

test("Stash styling stays scoped and does not override global button or primary action rules", () => {
  const actionRules = uncommented.slice(uncommented.indexOf(selector), uncommented.indexOf(".stash-toolbar"));
  for (const match of actionRules.matchAll(/([^{}]+)\{/g)) {
    const target = match[1].trim();
    if (target.startsWith("@media")) continue;
    assert.ok(target.startsWith(selector), target);
  }
  assert.doesNotMatch(actionRules, /!important|var\(--accent\)|\.primary-button|#commit-button|#pull-button|#push-button/);
});
