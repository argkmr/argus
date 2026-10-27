export function providerModelCatalog(provider) {
  if (Array.isArray(provider?.modelCatalog)) return provider.modelCatalog.filter((model) => model?.id);
  // Older/custom CLI adapters can provide IDs without capability metadata.
  return (provider?.models || []).map((id) => ({ id, displayName: id,
    supportedReasoningEfforts: [], defaultReasoningEffort: "", isDefault: id === provider.defaultModel }));
}

export function modelCatalogStatus(provider) {
  const source = provider?.modelCatalogSource || "unavailable";
  const count = providerModelCatalog(provider).length;
  const cached = source === "codex-cache" || source === "claude-cache";
  const custom = source === "cli-adapter" || source === "adapter";
  const text = cached ? `Cached catalogue · ${count} model${count === 1 ? "" : "s"}`
    : source === "unavailable" ? "Model catalogue unavailable · try refresh"
      : custom ? "Models supplied by your CLI adapter" : `Auto-sync on · ${count} model${count === 1 ? "" : "s"}`;
  const detail = cached ? "The CLI could not refresh. These are previously discovered models, not a current access check."
    : "Argus checks the connected CLI in the background and when this picker opens. New models and capabilities appear automatically when the CLI exposes them. Discovery sends no AI prompt and does not verify model entitlement.";
  return { text, title: `${detail}${provider?.version ? ` Connected CLI: ${provider.version}.` : ""}`, cached };
}

export function modelIdentityDescription(model) {
  if (!model) return "";
  const identity = model.resolvedModel && model.resolvedModel !== model.id
    ? `${model.id} currently resolves to ${model.resolvedModel}` : model.id;
  return [model.description, identity].filter(Boolean).join(" · ");
}

export function reasoningLabel(effort) {
  return ({ auto: "CLI setting", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" })[effort] || effort || "Not supported";
}

export function resolveModelSelection(provider, saved = {}) {
  const catalog = providerModelCatalog(provider);
  const defaultModel = catalog.find((model) => model.isDefault) || catalog.find((model) => model.id === provider?.defaultModel) || catalog[0];
  const model = saved.model || defaultModel?.id || "";
  const selected = catalog.find((entry) => entry.id === model);
  const efforts = (selected?.supportedReasoningEfforts || []).map((item) => typeof item === "string" ? { effort: item, description: "" } : item).filter((item) => item.effort);
  const defaultEffort = efforts.some((item) => item.effort === selected?.defaultReasoningEffort)
    ? selected.defaultReasoningEffort : efforts[0]?.effort || "auto";
  // Legacy "auto" resolves to the model default unless the CLI explicitly
  // advertises it as a supported choice (for example Claude's CLI setting).
  const effort = saved.effort && (saved.effort !== "auto" || efforts.some((entry) => entry.effort === "auto")) ? saved.effort : defaultEffort;
  const speed = saved.speed || "standard";
  const supportsFastMode = Boolean(selected && (selected.supportsFastMode ?? provider?.supportsFastMode ?? false));
  let error = !selected ? (model ? `${model} is unavailable. Select an available model for this chat.` : "No models are available. Refresh the CLI connection.") : "";
  if (!error && effort !== "auto" && !efforts.some((entry) => entry.effort === effort)) error = `${reasoningLabel(effort)} reasoning is unavailable for ${selected.displayName || model}. Select a supported reasoning level.`;
  if (!error && speed === "fast" && !supportsFastMode) error = "Fast mode is unavailable for this model. Select standard speed.";
  return { provider: saved.provider || provider?.id || "", model, effort, speed, catalog, selected, efforts, supportsFastMode, error };
}

export function modelSpeedControl(selection) {
  const available = selection.supportsFastMode;
  const options = [{ value: "standard", label: "Standard" }];
  if (available) options.push({ value: "fast", label: "Fast" });
  else if (selection.speed === "fast") options.push({ value: "fast", label: "Fast · unavailable", disabled: true });
  const title = available
    ? "Speed for the next request. Fast can use more credits. Reasoning is configured separately."
    : "Standard only: the connected provider does not report a separate Fast mode for this model.";
  return { options, title, disabled: !available && selection.speed !== "fast", unavailable: !available };
}

export function modelSelectionKey(scope, repositoryId, taskId) {
  return taskId ? `task:${scope}:${taskId}` : `draft:${scope}:${scope === "global" ? "global" : repositoryId || "none"}`;
}

export function createModelSelectionStore(storage) {
  const storageKey = "argus-chat-model-settings-v1";
  let records;
  try { records = JSON.parse(storage.getItem(storageKey) || "{}"); } catch { records = {}; }
  if (!records || typeof records !== "object" || Array.isArray(records)) records = {};
  const flush = () => { try { storage.setItem(storageKey, JSON.stringify(records)); } catch { /* Session settings still remain usable when storage is full. */ } };
  return {
    get(key) { return records[key] ? { ...records[key] } : undefined; },
    set(key, settings) { records[key] = { provider: settings.provider, model: settings.model, effort: settings.effort, speed: settings.speed }; flush(); },
    delete(key) { delete records[key]; flush(); },
  };
}
