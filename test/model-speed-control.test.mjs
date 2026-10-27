import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createModelSelectionStore, modelSelectionKey, modelSpeedControl, providerModelCatalog, resolveModelSelection } from "../public/model-selection.js";

const provider = { id: "codex", supportsFastMode: true, modelCatalog: [
  { id: "fast-capable", supportsFastMode: true, defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "high", "ultra"] },
  { id: "standard-only", supportsFastMode: false, defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "high"] },
] };
const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const bodyOf = name => {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end);
};

test("repository and Nexus retain one of every model control inside their native model menu", () => {
  const menus = [...html.matchAll(/<details class="[^"]*\bmodel-settings-menu\b[^"]*">([\s\S]*?)<\/details>/g)].map(match => match[0]);
  assert.equal(menus.length, 2);
  for (const [prefix, scope] of [["agent", "repository"], ["global-agent", "global"]]) {
    const menu = menus.find(markup => markup.includes(`id="${prefix}-provider"`));
    assert(menu, `${scope} model menu exists`);
    assert.match(menu, new RegExp(`id="${scope}-composer-model"[^>]*popover="auto"[^>]*role="dialog"`));
    for (const control of ["provider", "model", "speed", "effort", "mode", "catalog-source", "model-error", "config-summary"]) {
      const id = `${prefix}-${control}`;
      assert.equal([...html.matchAll(new RegExp(`id="${id}"`, "g"))].length, 1, `${id} is not duplicated`);
      assert(menu.includes(`id="${id}"`), `${id} remains in its model menu`);
    }
    assert.match(menu, new RegExp(`<summary[^>]*aria-controls="${scope}-composer-model"[^>]*>[\\s\\S]*?id="${prefix}-config-summary"[\\s\\S]*?<\\/summary>`));
    assert.match(menu, new RegExp(`<label class="model-speed-control"><span>Speed<\\/span><select id="${prefix}-speed"`));
    assert.match(source, new RegExp(`#${prefix}-speed"\\)\\.addEventListener\\("change"`));
  }
});

test("both model pickers check the CLI on opening and expose a bounded manual refresh", () => {
  assert.match(source, /panel\.addEventListener\("toggle", event => \{\s*if \(event\.newState === "open"\) void providerStatusPoller\.poll\(\{ force: true \}\)/);
  assert.match(source, /button\.addEventListener\("click", \(\) => void providerStatusPoller\.poll\(\{ force: true \}\)/);
  assert.match(source, /read: \(\{ force \}\) => api\(`\/api\/agents\/providers\$\{force \? "\?refresh=true"/);
  assert.equal([...html.matchAll(/data-refresh-model-catalog aria-label=/g)].length, 2);
  assert.equal([...html.matchAll(/class="model-catalog-identity" hidden/g)].length, 2);
});

test("the speed chip only offers provider-reported capabilities and keeps reasoning independent", () => {
  const selected = resolveModelSelection(provider, { model: "fast-capable", effort: "ultra", speed: "standard" });
  const control = modelSpeedControl(selected);
  assert.deepEqual(control.options.map(item => item.value), ["standard", "fast"]);
  assert.equal(control.disabled, false);
  assert.match(control.title, /Reasoning is configured separately/);
  assert.equal(resolveModelSelection(provider, { ...selected, speed: "fast" }).effort, "ultra");
  assert.deepEqual(modelSpeedControl(resolveModelSelection(provider, { model: "standard-only" })).options, [{ value: "standard", label: "Standard" }]);
});

test("unavailable Fast remains recoverable instead of silently changing a saved request", () => {
  const selected = resolveModelSelection(provider, { model: "standard-only", speed: "fast" });
  const control = modelSpeedControl(selected);
  assert.match(selected.error, /Fast mode is unavailable/);
  assert.equal(control.disabled, false, "the user can change back to Standard");
  assert.equal(control.options[1].disabled, true, "unsupported Fast cannot be newly selected");
  assert.equal(modelSpeedControl(resolveModelSelection(provider, { model: "standard-only" })).disabled, true);
  assert.match(control.title, /Standard only/);
});

test("missing models and unknown provider capabilities never advertise Fast", () => {
  assert.equal(resolveModelSelection(provider, { model: "removed" }).supportsFastMode, false);
  const unknown = resolveModelSelection({ id: "custom", models: ["custom-model"] });
  assert.equal(unknown.supportsFastMode, false);
  assert.equal(modelSpeedControl(unknown).disabled, true);
});

test("changing speed persists the same task's independent reasoning and exact outgoing speed", () => {
  for (const scope of ["repository", "global"]) {
    const controls = { provider: { value: "codex" }, model: { value: "fast-capable" }, effort: { value: "ultra" }, speed: { value: "fast" } };
    const selectedSettings = new Function("modelControlElements", `return ${bodyOf("selectedModelSettings")}`)(() => controls);
    const store = createModelSelectionStore({ getItem: () => null, setItem() {} });
    const writes = [], refreshed = [], state = { activeRepository: { id: "repo-a" } };
    const key = modelSelectionKey(scope, "repo-a", "task-a");
    const persist = new Function("modelControlElements", "selectedModelSettings", "currentModelSelectionKey", "activeTaskId", "modelSelections", "state", "modelSelectionKey", "modelSelectionError", "syncTaskModelSelection", `return ${bodyOf("persistModelSelection")}`)(() => controls, selectedSettings, () => key, () => "task-a", store, state, modelSelectionKey, () => "", (id, settings) => writes.push({ id, settings }));
    const change = new Function("renderModelConfigurationSummary", "persistModelSelection", "setComposerActionState", "runningAgentJob", `return ${bodyOf("handleSpeedChange")}`)(value => refreshed.push(value), persist, () => {}, () => null);
    change(scope);
    assert.deepEqual(selectedSettings(scope), { model: "fast-capable", effort: "ultra", speed: "fast" });
    assert.deepEqual(store.get(key), { provider: "codex", model: "fast-capable", effort: "ultra", speed: "fast" });
    assert.deepEqual(writes, [{ id: "task-a", settings: store.get(key) }]);
    assert.deepEqual(refreshed, [scope]);
  }
});

test("changing to a standard-only model resets speed but preserves supported reasoning", () => {
  const controls = { provider: { value: "codex" }, model: { value: "standard-only" }, effort: { value: "high" }, speed: { value: "fast" } }, renders = [], saves = [];
  const change = new Function("modelControlElements", "selectedProvider", "providerModelCatalog", "renderModelControls", "persistModelSelection", `return ${bodyOf("handleModelChange")}`)(() => controls, () => provider, providerModelCatalog, (scope, selection) => renders.push({ scope, selection }), scope => saves.push(scope));
  change("repository");
  assert.deepEqual(renders, [{ scope: "repository", selection: { provider: "codex", model: "standard-only", effort: "high", speed: "standard" } }]);
  assert.deepEqual(saves, ["repository"]);
});
