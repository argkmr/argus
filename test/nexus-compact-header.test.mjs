import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styles = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const header = html.match(/<section id="global-codex-panel"[^>]*>\s*<header>([\s\S]*?)<\/header>/)?.[1] || "";

test("Nexus identity sits outside the information card on the same compact header row", () => {
  assert.match(header, /^\s*<div class="global-codex-header-row">/);
  assert.match(header, /class="global-codex-heading"[\s\S]*?<h2><span aria-hidden="true">✦<\/span> Nexus<\/h2>/);
  assert.match(header, /Each repository keeps its private AI context\./);
  assert.match(header, /class="global-codex-heading">\s*<div class="global-codex-title">\s*<button id="nexus-sidebar-toggle"[\s\S]*?<\/button>\s*<h2>[\s\S]*?<\/h2>\s*<\/div>\s*<button id="nexus-theme-toggle"[\s\S]*?<\/button>\s*<\/div>\s*<section class="global-ai-info"/);
  const card = header.match(/<section class="global-ai-info"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(card, /class="global-ai-description"[\s\S]*?class="global-ai-provider"[\s\S]*?class="global-ai-scope"/);
  assert.doesNotMatch(card, /global-codex-heading|<h2>/);
  assert.equal((header.match(/class="global-ai-info"/g) || []).length, 1);
  assert.equal((header.match(/class="global-ai-connection-mark"/g) || []).length, 1);
  for (const id of ["global-ai-status", "global-ai-version", "global-ai-repository-scope", "global-ai-access-mode"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must retain its unique runtime target`);
  }
  assert.match(styles, /\.global-codex-panel > header \.global-codex-header-row \{[^}]*grid-template-columns: auto minmax\(0, 1fr\)/s);
  assert.match(styles, /\.global-codex-panel > header \.global-ai-info \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(215px, \.62fr\) auto/s);
  assert.match(styles, /@media \(max-width: 900px\) \{\s*\.global-codex-panel > header \.global-codex-header-row \{ gap: 12px; }\s*\.global-codex-panel > header \.global-ai-info \{ grid-template-columns: minmax\(0, 1fr\) minmax\(200px, \.8fr\)/);
  assert.match(styles, /@media \(max-width: 600px\) \{\s*\.global-codex-panel > header \.global-ai-info \{ grid-template-columns: minmax\(0, 1fr\)/);
});

test("provider status updates still reach the shared card without replacing Nexus identity", () => {
  const elements = new Map();
  const dot = { style: {} };
  const card = { disconnected: false, querySelector: (selector) => { assert.equal(selector, ".status-dot"); return dot; } };
  card.classList = { toggle(name, value) { assert.equal(name, "disconnected"); card.disconnected = value; } };
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", value: "codex", classList: { add() {} }, closest: (selector) => { assert.equal(selector, ".global-ai-info"); return card; } });
    return elements.get(selector);
  };
  const state = { providers: [{ id: "codex", name: "Codex", version: "codex-cli 0.153.4", authenticated: true }], workspace: { repositories: Array.from({ length: 13 }) } };
  const context = vm.createContext({ state, $: element, providerCanRun: (provider) => Boolean(provider?.authenticated), providerAvailability: () => ({ message: "Last request succeeded" }), providerStatusDescription: () => "Unavailable", setComposerActionState() {}, runningAgentJob: () => null });
  vm.runInContext(app.slice(app.indexOf("function updateGlobalAIInfo()"), app.indexOf("function cliCapabilityScopeKey(")), context);
  context.updateGlobalAIInfo();
  assert.equal(element("#global-ai-status").textContent, "Codex connected");
  assert.equal(element("#global-ai-version").textContent, "codex-cli 0.153.4 · Last request succeeded");
  assert.equal(element("#global-ai-repository-scope").textContent, "13 connected repositories");
  assert.equal(card.disconnected, false);
  assert.equal(dot.style.background, "var(--green)");
  state.providers = [];
  context.updateGlobalAIInfo();
  assert.equal(element("#global-ai-status").textContent, "AI connection required");
  assert.equal(card.disconnected, true);
  assert.equal(dot.style.background, "var(--red)");
  assert.ok(!elements.has(".global-codex-heading"), "connection updates must not rewrite the Nexus identity");
});
