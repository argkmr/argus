import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createChatContextPreference } from "../public/chat-context-preference.mjs";
import { modelSelectionKey } from "../public/model-selection.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const declaration = name => {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
};
function harness() {
  const nodes = new Map(), active = { repository: "repo-chat", global: "nexus-chat" };
  const state = { activeRepository: { id: "repo-a" }, repositoryDrafts: { "repo-a": "Repository draft" }, globalDraft: "Nexus draft" };
  const element = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", classes: new Set(), events: [],
      classList: { toggle(name, on) { on ? element(selector).classes.add(name) : element(selector).classes.delete(name); } },
      dispatchEvent(event) { this.events.push(event.type); },
    });
    return nodes.get(selector);
  };
  const preference = createChatContextPreference();
  const key = scope => modelSelectionKey(scope, state.activeRepository.id, active[scope]);
  const context = vm.createContext({
    $: element, Event, state, currentModelSelectionKey: key, chatContextPreference: preference,
    modelSelections: { get() {} }, renderModelControls() {}, renderModelConfigurationSummary() {},
    updateGlobalAIInfo() {}, updateLocalAIInfo() {}, resizeAgentComposer() {},
    composerSubmission: () => null, setComposerActionState() {}, runningAgentJob: () => null,
  });
  vm.runInContext(["selectedContextMode", "restoreContextMode", "persistContextMode", "renderContextMode", "restoreTaskModelSettings", "restoreScopedComposer"].map(declaration).join("\n"), context);
  return { context, element, key, active, state, preference, control: scope => element(scope === "global" ? "#global-agent-context-mode" : "#agent-context-mode") };
}

for (const scope of ["repository", "global"]) {
  test(`${scope}: legacy saved fresh requests do not override the new next-prompt default`, () => {
    const h = harness(), task = { id: h.active[scope], contextMode: "fresh", messages: [{ content: "Unchanged", contextMode: "fresh" }] };
    const before = JSON.stringify(task);
    h.context.restoreTaskModelSettings(scope, task);
    assert.equal(h.control(scope).value, "history");
    assert.equal(h.context.selectedContextMode(scope), "history");
    assert.equal(JSON.stringify(task), before);
    const composer = h.element(scope === "global" ? ".global-prompt-card.chat-composer" : ".prompt-card.chat-composer");
    assert.ok(composer.classes.has("history-context-mode"));
    assert.deepEqual(composer.events, ["change"], "programmatic restoration refreshes the compact context badge too");
  });

  test(`${scope}: explicit Fresh survives background restoration and stays isolated by chat`, () => {
    const h = harness();
    h.control(scope).value = "fresh"; h.context.persistContextMode(scope);
    h.context.restoreTaskModelSettings(scope, { contextMode: "history" });
    assert.equal(h.control(scope).value, "fresh");
    const first = h.active[scope]; h.active[scope] = "another-chat";
    h.context.restoreTaskModelSettings(scope, { contextMode: "fresh" });
    assert.equal(h.control(scope).value, "history");
    h.active[scope] = first; h.context.restoreTaskModelSettings(scope, {});
    assert.equal(h.control(scope).value, "fresh");
  });

  test(`${scope}: pending revisions keep fresh without resetting normal follow-up preference`, () => {
    const h = harness();
    h.context.restoreTaskModelSettings(scope, { contextMode: "fresh", revisionDraft: { prompt: "Edit" } });
    assert.equal(h.control(scope).value, "fresh");
    assert.equal(h.preference.has(h.key(scope)), false);
    h.context.restoreTaskModelSettings(scope, { contextMode: "fresh" });
    assert.equal(h.control(scope).value, "history");
  });
}

test("switching unsent repository drafts cannot leak history preferences or text", () => {
  const h = harness(); h.active.repository = null;
  h.control("repository").value = "fresh"; h.context.persistContextMode("repository");
  h.state.activeRepository.id = "repo-b"; h.state.repositoryDrafts["repo-b"] = "Different unsent draft";
  h.context.restoreScopedComposer("repository");
  assert.equal(h.control("repository").value, "history");
  assert.equal(h.element("#agent-prompt").value, "Different unsent draft");
  h.state.activeRepository.id = "repo-a"; h.context.restoreScopedComposer("repository");
  assert.equal(h.control("repository").value, "fresh");
  assert.equal(h.element("#agent-prompt").value, "Repository draft");
  h.context.restoreScopedComposer("global");
  assert.equal(h.control("global").value, "history");
  assert.equal(h.element("#global-agent-prompt").value, "Nexus draft");
});
