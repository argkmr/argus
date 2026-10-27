import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { NEXUS_THEMES, DEFAULT_NEXUS_THEME, normalizeNexusTheme, nexusThemeChoices, nexusThemeVariables } from "../public/nexus-themes.mjs";

const styles = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const source = await fs.readFile(new URL("../public/nexus-themes.mjs", import.meta.url), "utf8");
const block = styles.slice(styles.indexOf("/* Nexus selectable themes")).split("/* Nexus theme chooser")[0].split("/* Source citations open")[0];
const surfaces = ["bg", "surface", "surface-2", "surface-3"];
const foregrounds = ["text", "muted", "muted-2", "accent", "blue"];

function luminance(hex) {
  const channels = hex.slice(1, 7).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

test("Nexus exposes six curated directions with twelve named immutable palettes", () => {
  assert.deepEqual(NEXUS_THEMES.map(theme => theme.id), ["midnight", "ocean", "forest", "graphite", "violet", "ember"]);
  assert.equal(DEFAULT_NEXUS_THEME, "midnight");
  assert.equal(new Set(NEXUS_THEMES.flatMap(theme => Object.values(theme.names))).size, 12);
  assert.ok(Object.isFrozen(NEXUS_THEMES));
  const keys = ["bg", "surface", "surface-2", "surface-3", "line", "line-soft", "shadow", "text", "muted", "muted-2", "accent", "accent-ink", "blue", "control-line"];
  for (const theme of NEXUS_THEMES) {
    assert.ok(theme.description.length > 12 && Object.isFrozen(theme));
    for (const mode of ["dark", "light"]) {
      assert.deepEqual(Object.keys(theme[mode]), keys);
      assert.ok(Object.isFrozen(theme[mode]));
      for (const [key, value] of Object.entries(theme[mode])) assert.match(value, key === "shadow" ? /^#[a-f0-9]{8}$/ : /^#[a-f0-9]{6}$/);
    }
  }
  assert.doesNotMatch(source, /\b(?:document|window|localStorage|fetch)\s*[.(]/, "palette catalog must remain side-effect free");
});

test("all twelve palettes meet normal-text, accent-button and control-boundary contrast", () => {
  for (const theme of NEXUS_THEMES) {
    for (const mode of ["dark", "light"]) {
      const palette = theme[mode];
      for (const foreground of foregrounds) {
        for (const background of surfaces) {
          const ratio = contrast(palette[foreground], palette[background]);
          assert.ok(ratio >= 4.5, `${theme.id}/${mode}/${foreground}/${background}: ${ratio}`);
        }
      }
      assert.ok(contrast(palette["accent-ink"], palette.accent) >= 4.5, `${theme.id}/${mode}: button text`);
      for (const background of surfaces) assert.ok(contrast(palette["control-line"], palette[background]) >= 3, `${theme.id}/${mode}: control on ${background}`);
    }
  }
});

test("light themes retain visible tinted surfaces and individually distinct accents", () => {
  for (const mode of ["dark", "light"]) {
    assert.equal(new Set(NEXUS_THEMES.map(theme => theme[mode].accent)).size, 6);
    assert.equal(new Set(NEXUS_THEMES.map(theme => theme[mode].bg)).size, 6);
    assert.equal(new Set(NEXUS_THEMES.map(theme => theme[mode]["surface-3"])).size, 6);
  }
  for (const theme of NEXUS_THEMES) {
    assert.ok(contrast(theme.light["surface-2"], theme.light["surface-3"]) >= 1.18, `${theme.id}: selection has visible surface separation`);
    assert.ok(luminance(theme.light.bg) > .7, `${theme.id}: light canvas remains light`);
    assert.ok(luminance(theme.dark.bg) < .03, `${theme.id}: dark canvas remains dark`);
    assert.notEqual(theme.dark.accent, theme.light.accent);
  }
});

test("user-approved Deep Ocean, Forest Ink and Porcelain retain their exact preview colours", () => {
  const approved = [
    ["ocean", "dark", ["#091724", "#102433", "#162e42", "#e6f1f8", "#adc3d4", "#61d4f3"]],
    ["forest", "dark", ["#111a17", "#172520", "#21352c", "#eff7f2", "#b1c8bb", "#91d5b0"]],
    ["midnight", "light", ["#f8f9fb", "#eff2f6", "#ffffff", "#263346", "#5b687b", "#3f5bb5"]],
  ];
  for (const [id, mode, values] of approved) {
    const palette = NEXUS_THEMES.find(theme => theme.id === id)[mode];
    assert.deepEqual(["bg", "surface", "surface-2", "text", "muted", "accent"].map(key => palette[key]), values);
  }
});

test("every appearance shows its own six names and descriptions, including the approved samples", () => {
  assert.deepEqual(nexusThemeChoices("dark").map(theme => theme.label), ["Midnight Slate", "Deep Ocean", "Forest Ink", "Graphite", "Velvet Dusk", "Ember Glow"]);
  assert.deepEqual(nexusThemeChoices("light").map(theme => theme.label), ["Porcelain", "Coastal Mist", "Botanical Paper", "Silver Cloud", "Lavender Mist", "Warm Linen"]);
  for (const mode of ["dark", "light"]) for (const theme of nexusThemeChoices(mode)) {
    assert.ok(theme.description.length > 20);
    assert.equal(theme.palette, NEXUS_THEMES.find(item => item.id === theme.id)[mode]);
    assert.ok(Object.isFrozen(theme));
  }
});

test("all former saved theme IDs and approved readable names migrate deterministically", () => {
  const aliases = { teal: "forest", rose: "violet", indigo: "midnight", sand: "ember", "deep-ocean": "ocean", "forest-ink": "forest", porcelain: "midnight" };
  for (const [before, after] of Object.entries(aliases)) assert.equal(normalizeNexusTheme(before), after);
  for (const id of ["midnight", "ocean", "forest", "graphite", "violet", "ember"]) assert.equal(normalizeNexusTheme(id), id);
});

test("normalization rejects unknown input and variable maps cannot leak global tokens", () => {
  for (const value of [null, undefined, {}, [], false, 123, "", "not-a-theme", "__proto__", "red; --bg:black"]) assert.equal(normalizeNexusTheme(value), "midnight");
  assert.equal(normalizeNexusTheme(" OCEAN "), "ocean");
  for (const theme of NEXUS_THEMES) {
    for (const mode of ["dark", "light"]) {
      const variables = nexusThemeVariables(theme.id, mode);
      assert.deepEqual(variables, Object.fromEntries(Object.entries(theme[mode]).map(([key, value]) => [`--nexus-${key}`, value])));
      assert.ok(Object.keys(variables).every(key => key.startsWith("--nexus-")));
      variables["--nexus-bg"] = "changed";
      assert.notEqual(nexusThemeVariables(theme.id, mode)["--nexus-bg"], "changed");
    }
  }
  assert.deepEqual(nexusThemeVariables("bad-theme", "bad-mode"), nexusThemeVariables("midnight", "dark"));
});

test("both static Midnight fallbacks match the catalog, including control boundaries", () => {
  const defaults = NEXUS_THEMES[0];
  const fallback = block.slice(0, block.indexOf("#global-codex-panel {"));
  const declarations = [...fallback.matchAll(/\{([^}]+)\}/g)];
  assert.equal(declarations.length, 2);
  for (const [index, mode] of ["dark", "light"].entries()) {
    const values = Object.fromEntries([...declarations[index][1].matchAll(/--nexus-([\w-]+): (#[\da-f]{6,8});/g)].map(match => [match[1], match[2]]));
    assert.deepEqual(values, defaults[mode]);
  }
});

test("Nexus code, tables, links and form controls cannot inherit hardcoded global theme colours", () => {
  for (const selector of [".chat-code-block", ".chat-code-block > header", ".chat-table-scroll", ".chat-table", ".chat-table th", ".chat-quote", ".model-settings-popover", ".context-chip"]) {
    assert.ok(block.includes(`#global-codex-panel ${selector} {`), `${selector} has a scoped theme rule`);
  }
  assert.match(block, /#global-codex-panel :is\(\.chat-link, \.chat-file-reference\):hover \{ color: var\(--accent\)/);
  assert.match(block, /#global-codex-panel :is\(select, input, textarea\) \{[^}]*border-color: var\(--nexus-control-line\)/);
  assert.match(block, /#global-codex-panel \.chat-code-block > header button \{[^}]*border-color: var\(--nexus-control-line\)/);
  assert.doesNotMatch(block, /--green:|--red:|\.repo-tab[^\n]*\{|!important/);
});
