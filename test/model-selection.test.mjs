import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createModelSelectionStore, modelCatalogStatus, modelIdentityDescription, modelSelectionKey, providerModelCatalog, reasoningLabel, resolveModelSelection } from "../public/model-selection.js";

const provider = {
  id: "codex", defaultModel: "gpt-6-astra", supportsFastMode: true,
  modelCatalog: [
    { id: "gpt-6-astra", displayName: "GPT-6 Astra", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort, description: `${effort} description` })) },
    { id: "gpt-5.5", displayName: "GPT-5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })) },
  ],
};

test("catalogue defaults resolve to an explicit actual model and its supported effort", () => {
  const selected = resolveModelSelection(provider);
  assert.equal(selected.model, "gpt-6-astra");
  assert.equal(selected.selected.displayName, "GPT-6 Astra");
  assert.equal(selected.effort, "high");
  assert.equal(selected.error, "");
  assert.equal(selected.efforts.at(-1).effort, "ultra");
  assert.equal(reasoningLabel("ultra"), "Ultra");
  assert(!selected.catalog.some((model) => !model.id));
});

test("future models appear without changing an existing chat's selected model", () => {
  const saved = { model: "gpt-6-astra", effort: "ultra", speed: "standard" };
  const next = { ...provider, modelCatalog: [
    { id: "provider-future-generation", isDefault: true, supportedReasoningEfforts: [{ effort: "future-effort" }] },
    ...provider.modelCatalog.map(model => ({ ...model, isDefault: false })),
  ] };
  const selected = resolveModelSelection(next, saved);
  assert.equal(selected.catalog[0].id, "provider-future-generation");
  assert.equal(selected.model, saved.model);
  assert.equal(selected.effort, saved.effort);
  assert.equal(resolveModelSelection(next, { model: "provider-future-generation" }).effort, "future-effort");
});

test("catalogue state distinguishes live discovery, cached models and unknown availability", () => {
  assert.match(modelCatalogStatus({ ...provider, modelCatalogSource: "codex-app-server" }).text, /Auto-sync on.*2 models/);
  const cached = modelCatalogStatus({ ...provider, modelCatalogSource: "codex-cache" });
  assert.equal(cached.cached, true);
  assert.match(cached.text, /Cached catalogue/);
  assert.match(cached.title, /not a current access check/);
  assert.match(modelCatalogStatus().text, /unavailable/);
  assert.equal(modelIdentityDescription({ id: "opus", resolvedModel: "claude-next-opus", description: "Capable" }), "Capable · opus currently resolves to claude-next-opus");
});

test("saved model and Ultra stay selected despite catalog ordering or default changes", () => {
  const selected = resolveModelSelection({ ...provider, modelCatalog: [...provider.modelCatalog].reverse().map((model) => ({ ...model, isDefault: model.id === "gpt-5.5" })) }, { model: "gpt-6-astra", effort: "ultra", speed: "fast" });
  assert.deepEqual([selected.model, selected.effort, selected.speed, selected.error], ["gpt-6-astra", "ultra", "fast", ""]);
});

test("each model exposes only its own reasoning choices and legacy auto resolves explicitly", () => {
  const selected = resolveModelSelection(provider, { model: "gpt-5.5", effort: "auto" });
  assert.equal(selected.effort, "medium");
  assert.deepEqual(selected.efforts.map((item) => item.effort), ["low", "medium", "high", "xhigh"]);
});

test("missing models and unsupported saved reasoning are retained and block sending", () => {
  const missing = resolveModelSelection(provider, { model: "removed-model", effort: "ultra" });
  assert.equal(missing.model, "removed-model");
  assert.equal(missing.effort, "ultra");
  assert.match(missing.error, /removed-model is unavailable/);
  const invalidEffort = resolveModelSelection(provider, { model: "gpt-5.5", effort: "ultra" });
  assert.equal(invalidEffort.effort, "ultra");
  assert.match(invalidEffort.error, /Ultra reasoning is unavailable/);
});

test("an empty discovered catalogue does not reintroduce stale fallback models", () => {
  assert.deepEqual(providerModelCatalog({ modelCatalog: [], models: ["old-model"] }), []);
  assert.match(resolveModelSelection({ modelCatalog: [] }).error, /No models are available/);
});

test("models without reasoning metadata do not invent effort support", () => {
  const selected = resolveModelSelection({ id: "custom", models: ["custom-model"] });
  assert.equal(selected.model, "custom-model");
  assert.equal(selected.effort, "auto");
  assert.equal(selected.error, "");
  assert.deepEqual(selected.efforts, []);
});

test("speed availability belongs to the selected model", () => {
  const selected = resolveModelSelection({ ...provider, modelCatalog: [{ ...provider.modelCatalog[0], supportsFastMode: false }] }, { model: "gpt-6-astra", speed: "fast" });
  assert.equal(selected.supportsFastMode, false);
  assert.match(selected.error, /Fast mode is unavailable for this model/);
});

test("CLI-configured reasoning remains an explicit choice when advertised", () => {
  const selected = resolveModelSelection({ id: "claude", modelCatalog: [{ id: "opus", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ effort: "auto" }, { effort: "high" }] }] }, { model: "opus", effort: "auto" });
  assert.equal(selected.effort, "auto");
  assert.equal(reasoningLabel(selected.effort), "CLI setting");
  assert.equal(selected.error, "");
});

test("chat choices survive restart while repositories, Nexus, chats and drafts remain isolated", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  let store = createModelSelectionStore(storage);
  const first = { provider: "codex", model: "gpt-6-astra", effort: "ultra", speed: "fast" };
  const second = { provider: "codex", model: "gpt-5.5", effort: "medium", speed: "standard" };
  store.set(modelSelectionKey("repository", "repo-a", "chat-a"), first);
  store.set(modelSelectionKey("repository", "repo-b", "chat-b"), second);
  store.set(modelSelectionKey("global", null, "nexus-a"), second);
  store.set(modelSelectionKey("repository", "repo-a", null), first);
  store = createModelSelectionStore(storage);
  assert.deepEqual(store.get(modelSelectionKey("repository", "repo-a", "chat-a")), first);
  assert.deepEqual(store.get(modelSelectionKey("repository", "repo-b", "chat-b")), second);
  assert.deepEqual(store.get(modelSelectionKey("global", null, "nexus-a")), second);
  assert.deepEqual(store.get(modelSelectionKey("repository", "repo-a", null)), first);
  assert.equal(store.get(modelSelectionKey("repository", "repo-b", null)), undefined);
  assert.equal(store.get(modelSelectionKey("global", null, "nexus-b")), undefined);
  assert.equal(store.get(modelSelectionKey("global", null, null)), undefined);
  store.delete(modelSelectionKey("repository", "repo-a", "chat-a"));
  assert.equal(createModelSelectionStore(storage).get(modelSelectionKey("repository", "repo-a", "chat-a")), undefined);
});

test("invalid local settings data does not break chat controls", () => {
  for (const value of ["not-json", "null", "[]"]) {
    const store = createModelSelectionStore({ getItem: () => value, setItem() {} });
    assert.equal(store.get("missing"), undefined);
    store.set("chat", { provider: "codex", model: "gpt-6-astra", effort: "ultra" });
    assert.equal(store.get("chat").effort, "ultra");
  }
});

test("a model change while the first request starts transfers to that chat, not a newer draft", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function retainStartedTaskSelection(");
  const end = source.indexOf("\nfunction renderModelConfigurationSummary(", start);
  const store = createModelSelectionStore({ getItem: () => null, setItem() {} });
  const epochs = new Map();
  const writes = [];
  const contexts = new Map();
  const chatContextPreference = { has: key => contexts.has(key), get: key => contexts.get(key) || "history", set: (key, value) => contexts.set(key, value) };
  const retain = new Function("modelSelections", "modelSelectionKey", "modelDraftEpochs", "syncTaskModelSelection", "chatContextPreference", `return ${source.slice(start, end)}`)(store, modelSelectionKey, epochs, async (id, settings) => writes.push({ id, settings }), chatContextPreference);
  const original = { provider: "codex", model: "gpt-5.5", effort: "medium", speed: "standard" };
  const latest = { provider: "codex", model: "gpt-6-astra", effort: "ultra", speed: "fast" };
  const draftKey = modelSelectionKey("global", null, null);
  const submission = { repositoryId: "global", modelSelectionKey: draftKey, modelDraftEpoch: 0 };
  store.set(draftKey, latest);
  contexts.set(draftKey, "fresh");
  await retain("global", "new-chat", submission, original);
  assert.deepEqual(store.get(modelSelectionKey("global", null, "new-chat")), latest);
  assert.deepEqual(writes, [{ id: "new-chat", settings: latest }]);
  assert.equal(contexts.get(modelSelectionKey("global", null, "new-chat")), "fresh");
  epochs.set(draftKey, 1);
  await retain("global", "other-chat", submission, original);
  assert.deepEqual(store.get(modelSelectionKey("global", null, "other-chat")), original);
  assert.equal(contexts.get(modelSelectionKey("global", null, "other-chat")), "history", "a newer draft's fresh choice cannot leak into the previous submission");
  assert.equal(writes.length, 1);
  store.set(modelSelectionKey("global", null, "existing-chat"), latest);
  await retain("global", "existing-chat", { ...submission, taskId: "existing-chat" }, original);
  assert.deepEqual(store.get(modelSelectionKey("global", null, "existing-chat")), latest);
});
