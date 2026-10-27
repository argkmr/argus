const ACTIVE_STATES = new Set(["starting", "running", "stopping"]);
const MAX_ROWS = 80;
let nextId = 0;
const text = value => String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 1600);
const portNumber = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : null;

/** Configured ports and observed listeners are different facts: never infer one from the other. */
export function describeRepositoryPortState({ configuration = null, details = null, inventory = null, processes = null } = {}) {
  // A reported null is meaningful (for example an unresolved environment
  // override); do not replace it with an older saved fallback port.
  const port = portNumber(details ? details.applicationPort : configuration?.port);
  const running = Array.isArray(processes) ? Boolean(configuration?.id && processes.some(item => item?.configurationId === configuration.id
    && (item.running === true || ACTIVE_STATES.has(item.status)))) : Boolean(details?.running);
  const listeners = inventory?.available === true && port ? (inventory.listeners || []).filter(item => Number(item.port) === port) : [];
  const assignments = port ? (inventory?.configurations || []).filter(item => item.id !== configuration?.id
    && (Number(item.port) === port || Number(item.managementPort) === port)) : [];
  const foreign = listeners.filter(item => item.configurationId ? item.configurationId !== configuration?.id
    : item.repositoryId && item.repositoryId !== configuration?.repositoryId);
  const own = listeners.filter(item => configuration?.id && item.configurationId === configuration.id);
  const unknown = listeners.filter(item => !item.configurationId && !(item.repositoryId && item.repositoryId !== configuration?.repositoryId));
  const state = !port ? "unconfigured" : foreign.length ? "conflict"
    : own.length ? "listening" : unknown.length ? "occupied" : assignments.length ? "shared" : running ? "running"
      : inventory?.available === false ? "unknown" : "configured";
  const label = { unconfigured: "No port", conflict: "Port conflict", shared: "Also configured elsewhere", listening: "Listening",
    occupied: "In use · owner unverified", running: "Running · listener unverified", unknown: "Listener check unavailable", configured: "Configured port" }[state];
  return { port, running, state, label, listeners, assignments, foreign, own, unknown };
}

/** Service assignments remain useful when stopped or when OS listener discovery is unavailable. */
export function describeArgusServicePorts({ configurations = [], inventory = null, processes = null, configurationId = "", details = null } = {}) {
  const rows = [], seen = new Set();
  for (const configuration of inventory?.configurations || configurations) {
    if (!configuration?.id || seen.has(configuration.id)) continue;
    seen.add(configuration.id);
    const current = configuration.id === configurationId && details;
    const active = Array.isArray(processes) ? processes.some(item => item.configurationId === configuration.id
      && (item.running === true || ACTIVE_STATES.has(item.status))) : Boolean(configuration.running);
    for (const [key, label] of [["port", "Application"], ["managementPort", "Management"]]) {
      const port = portNumber(current ? details[key === "port" ? "applicationPort" : key] : configuration[key]);
      if (!port) continue;
      const listening = inventory?.available === true && inventory.listeners?.some(item => item.configurationId === configuration.id && Number(item.port) === port);
      rows.push({ configurationId: configuration.id, name: text(configuration.name || "Service"), port, kind: label,
        status: listening ? "Listening" : active ? "Running · unverified" : "Configured" });
    }
  }
  return rows.sort((a, b) => a.port - b.port || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

/**
 * Context changes read lightweight file metadata; only an open panel scans
 * listeners. There is no polling or automatic restart. Saves retain the
 * original repo/configuration/file identity even if the user navigates away.
 */
export function createRepositoryPorts({ host, document, api, onError = () => {}, onSaved = () => {},
  onSelect = () => {}, onConfigure = () => {}, onInspected = () => {}, beforeOpen = () => {}, canEditFile = () => true } = {}) {
  if (!host?.append || !document?.createElement || typeof api !== "function") throw new TypeError("A host, document, and API function are required");
  let repository = null, configurations = [], processes = [], selectedId = "", visible = false;
  let opened = false, disposed = false, epoch = 0, read = null, queuedRead = null, saving = null, opening = false;
  let inventory = null, details = null, error = "", success = "", loadedKey = "";
  const listeners = [], id = `repository-ports-${++nextId}`, view = document.defaultView;
  const element = (tag, className, value = "") => { const node = document.createElement(tag); node.className = className; node.textContent = value; return node; };
  const listen = (node, event, handler) => { node?.addEventListener?.(event, handler); listeners.push(() => node?.removeEventListener?.(event, handler)); };
  const notify = (callback, ...args) => { try { Promise.resolve(callback(...args)).catch(() => {}); } catch { /* An observer cannot change a save's outcome. */ } };
  const button = (label, className, action) => { const node = element("button", className, label); node.type = "button"; listen(node, "click", action); return node; };
  const trigger = button("", "repository-ports-trigger", () => opened ? close() : open());
  trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-controls", id);
  const triggerDot = element("span", "repository-ports-dot"); triggerDot.setAttribute("aria-hidden", "true");
  const triggerCopy = element("span", "repository-ports-trigger-copy");
  const triggerPort = element("strong", "repository-ports-trigger-port", "No port");
  const triggerState = element("span", "repository-ports-trigger-state", "Service port");
  const triggerArrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  triggerArrow.setAttribute("class", "repository-ports-chevron disclosure-chevron"); triggerArrow.setAttribute("viewBox", "0 0 16 16");
  triggerArrow.setAttribute("aria-hidden", "true"); triggerArrow.setAttribute("focusable", "false");
  const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrowPath.setAttribute("d", "m4 6 4 4 4-4"); triggerArrow.append(arrowPath);
  triggerCopy.append(triggerPort, triggerState); trigger.append(triggerDot, triggerCopy, triggerArrow); host.append(trigger);
  const panel = element("section", "repository-ports-panel"); panel.id = id; panel.hidden = true;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-labelledby", `${id}-title`);
  const heading = element("div", "repository-ports-heading");
  const title = element("h3", "", "Service ports"); title.id = `${id}-title`;
  const refreshButton = button("↻", "repository-ports-icon", () => { void refresh(); }); refreshButton.title = "Refresh local ports"; refreshButton.setAttribute("aria-label", "Refresh local ports");
  const closeButton = button("×", "repository-ports-icon", () => close()); closeButton.title = "Close local ports"; closeButton.setAttribute("aria-label", "Close local ports");
  heading.append(title, refreshButton, closeButton);
  const body = element("div", "repository-ports-body");
  const currentService = element("div", "repository-ports-current");
  const scope = element("p", "repository-ports-scope");
  const selectionLabel = element("label", "repository-ports-label", "Services configuration");
  const selection = element("select", "repository-ports-select"); selection.setAttribute("aria-label", "Port configuration"); selectionLabel.append(selection);
  const summary = element("p", "repository-ports-summary"); summary.setAttribute("role", "status");
  currentService.append(scope, summary);
  const errorNode = element("p", "repository-ports-message"); errorNode.setAttribute("role", "alert");
  const successNode = element("p", "repository-ports-success"); successNode.setAttribute("role", "status");
  const form = element("form", "repository-ports-form");
  const portLabel = element("label", "repository-ports-label", "Application port");
  const fieldRow = element("div", "repository-ports-field-row");
  const input = element("input", "repository-ports-input"); input.type = "number"; input.min = "1"; input.max = "65535"; input.step = "1"; input.inputMode = "numeric"; input.required = true; input.setAttribute("aria-label", "Application port");
  const saveButton = element("button", "repository-ports-save", "Save port"); saveButton.type = "submit";
  fieldRow.append(input, saveButton); portLabel.append(fieldRow);
  const management = element("p", "repository-ports-management");
  const file = element("p", "repository-ports-file");
  const editNotice = element("p", "repository-ports-notice");
  const configureButton = button("Configure service…", "repository-ports-configure", () => {
    const configurationId = selected()?.id || "", repositoryId = repository?.id;
    if (!repositoryId || saving) return;
    close(false); notify(onConfigure, configurationId, repositoryId);
  });
  form.append(portLabel, management, file, editNotice, configureButton);
  currentService.append(form);
  const listenerSection = element("section", "repository-ports-section");
  const listenerHeading = element("h4", "", "Argus service ports");
  const listenerNotice = element("p", "repository-ports-notice");
  const listenerList = element("div", "repository-ports-list"); listenerList.setAttribute("aria-label", "Argus service ports");
  listenerSection.append(listenerHeading, listenerNotice, listenerList);
  const checked = element("p", "repository-ports-checked");
  body.append(selectionLabel, currentService, errorNode, successNode, listenerSection, checked);
  panel.append(heading, body); (document.body || host).append(panel);
  const choices = () => configurations.filter(item => item?.id && item.repositoryId === repository?.id);
  const selected = () => choices().find(item => item.id === selectedId) || choices()[0] || null;
  const key = () => `${repository?.id || ""}\0${selected()?.id || ""}`;
  const inventoryContext = () => JSON.stringify([
    processes.map(item => [item.id, item.configurationId, item.pid, item.status, item.running]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    configurations.map(item => [item.id, item.name, item.port, item.managementPort]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
  const eligible = () => !disposed && visible && opened && Boolean(repository?.id);
  const describe = () => describeRepositoryPortState({ configuration: selected(), details, inventory, processes });
  const pendingRead = () => Boolean(read && read.epoch === epoch);
  const valueValid = () => /^\d{1,5}$/.test(input.value || "") && portNumber(input.value) !== null;
  function position() {
    if (!opened || !trigger.getBoundingClientRect || !panel.style) return;
    const rect = trigger.getBoundingClientRect(), width = Math.min(360, (view?.innerWidth || 1024) - 24);
    const top = Math.min(rect.bottom + 8, Math.max(12, (view?.innerHeight || 768) - 200));
    panel.style.width = `${width}px`; panel.style.left = `${Math.max(12, Math.min(rect.left, (view?.innerWidth || 1024) - width - 12))}px`;
    panel.style.top = `${top}px`; panel.style.maxHeight = `${Math.max(160, (view?.innerHeight || 768) - top - 12)}px`;
  }
  function listenerName(value) {
    const owner = value.configurationId ? (inventory?.configurations || configurations).find(item => item.id === value.configurationId) : null;
    return text(owner?.name || value.command || "Unknown process");
  }
  function renderRows(list, values) {
    list.replaceChildren();
    for (const value of values.slice(0, MAX_ROWS)) {
      const row = element("div", "repository-ports-row");
      const number = element("code", "repository-ports-row-port", `:${portNumber(value.port) || "—"}`);
      const identity = element("span", "repository-ports-row-identity");
      const name = value.name;
      const label = element("strong", "", name); label.title = name;
      const status = element("span", "repository-ports-row-status", `${value.kind} · ${value.status}`);
      identity.append(label, status); row.append(number, identity);
      if (value.configurationId === selected()?.id) row.dataset.selectedPort = "true";
      list.append(row);
    }
    if (!values.length) list.append(element("p", "repository-ports-notice", "No ports configured in Argus Services yet."));
    if (values.length > MAX_ROWS) list.append(element("p", "repository-ports-notice", `Showing ${MAX_ROWS} of ${values.length} entries.`));
  }
  function renderInventory() {
    listenerNotice.textContent = inventory?.available === true ? ""
      : inventory ? "Live status unavailable. Showing configured service ports." : pendingRead() ? "Checking service ports…" : "Configured ports · refresh to check live status.";
    listenerNotice.hidden = !listenerNotice.textContent;
    renderRows(listenerList, describeArgusServicePorts({ configurations, inventory, processes, configurationId: selected()?.id, details }));
    const timestamp = inventory?.checkedAt && new Date(inventory.checkedAt);
    checked.textContent = timestamp && Number.isFinite(timestamp.getTime()) ? `Checked ${timestamp.toLocaleTimeString()}` : "";
  }
  function publish() {
    if (disposed) return;
    const configuration = selected(), state = describe(), loading = pendingRead();
    host.hidden = !visible || !repository?.id; trigger.disabled = !repository?.id;
    trigger.dataset.state = state.state; trigger.setAttribute("aria-expanded", String(opened));
    triggerPort.textContent = state.port ? `localhost:${state.port}` : "No port";
    trigger.title = `${text(repository?.name || "Repository")}${state.port ? ` uses localhost:${state.port}. ` : ": "}${state.label}. Edit this port and view Argus services.`;
    trigger.setAttribute("aria-label", `Local ports: ${state.port || "not configured"}. ${state.label}.`);
    panel.hidden = !opened || !visible; panel.setAttribute("aria-busy", String(loading || Boolean(saving)));
    scope.textContent = text(repository?.name || "Repository");
    const options = choices(), previous = [...(selection.children || [])].map(option => `${option.value}\0${option.textContent}`).join("\n");
    const next = options.map(item => `${item.id}\0${text(item.name || item.id)}`).join("\n");
    if (previous !== next) selection.replaceChildren(...options.map(item => { const option = element("option", "", text(item.name || item.id)); option.value = item.id; return option; }));
    selection.value = configuration?.id || ""; selection.disabled = Boolean(saving); selectionLabel.hidden = options.length < 2;
    const address = `localhost:${state.port}`;
    summary.textContent = !state.port ? "No service port configured."
      : loading ? `${address} · checking…`
        : state.foreign.length ? `${address} · occupied by ${[...new Set(state.foreign.map(listenerName))].join(", ")}`
          : state.own.length ? `Listening on ${address}`
            : state.unknown.length ? `${address} · in use, service unverified`
              : state.running ? `${address} · starting or listener unverified`
                : inventory?.available === true ? `${address} · not running`
                  : `${address} · configured`;
    summary.dataset.state = state.own.length && !state.foreign.length ? "listening" : state.state;
    errorNode.textContent = error; errorNode.hidden = !error; successNode.textContent = success; successNode.hidden = !success;
    input.disabled = loading || Boolean(saving) || !configuration || !details?.editable;
    saveButton.hidden = !configuration;
    saveButton.textContent = saving ? "Saving…" : "Save port";
    saveButton.disabled = input.disabled || !valueValid() || Number(input.value) === portNumber(details?.applicationPort)
      || (!details?.configFile && details?.editMode !== "launch") || !details?.contentHash;
    configureButton.hidden = Boolean(configuration && details?.editable);
    configureButton.disabled = loading || Boolean(saving);
    const managementPort = portNumber(details ? details.managementPort : configuration?.managementPort);
    management.textContent = managementPort ? `Management port: ${managementPort} · unchanged` : "";
    management.hidden = !management.textContent;
    const affectedFiles = details?.affectedFiles?.length ? details.affectedFiles : details?.configFile ? [details.configFile] : [];
    file.textContent = affectedFiles.length ? `${details.editable ? "Updates" : "Configuration"}: ${affectedFiles.map(text).join(" · ")}` : ""; file.hidden = !file.textContent;
    editNotice.textContent = !details ? "Loading port settings…" : !details.editable ? text(details.reason || "This configuration cannot be edited safely here. Update it in Services or its source configuration.")
      : text(details.editNotice || "Saves to Services and this file. Restart the service to apply.");
    refreshButton.disabled = loading || Boolean(saving);
    position();
  }
  function invalidate() { epoch++; read?.controller.abort(); }
  function refresh() {
    const canRead = () => !disposed && visible && Boolean(repository?.id);
    if (!canRead() || saving) return Promise.resolve(null);
    if (read?.epoch === epoch) return read.promise;
    if (read) {
      if (queuedRead?.epoch === epoch) return queuedRead.promise;
      const waiting = { epoch, promise: null };
      waiting.promise = read.promise.then(() => epoch === waiting.epoch && canRead() ? refresh() : null)
        .finally(() => { if (queuedRead === waiting) queuedRead = null; });
      queuedRead = waiting; return waiting.promise;
    }
    const pending = { epoch, controller: new AbortController(), promise: null };
    const configuration = selected(), repositoryId = repository.id, includeInventory = opened, sourceInventoryContext = inventoryContext();
    read = pending; error = "";
    const current = () => !disposed && visible && pending.epoch === epoch;
    const options = { signal: pending.controller.signal, cache: "no-store", dedupe: false };
    pending.promise = Promise.resolve().then(async () => {
      if (!current()) return null;
      const results = await Promise.allSettled([
        includeInventory ? api("/api/runtime-ports", options) : Promise.resolve(null),
        api(configuration ? `/api/run-configurations/${encodeURIComponent(configuration.id)}/ports`
          : `/api/repositories/${encodeURIComponent(repositoryId)}/ports`, options),
      ]);
      if (!current()) return null;
      const errors = [];
      if (includeInventory) {
        if (inventoryContext() !== sourceInventoryContext) inventory = null;
        else if (results[0].status === "fulfilled" && typeof results[0].value?.available === "boolean" && Array.isArray(results[0].value.listeners) && Array.isArray(results[0].value.configurations)) inventory = results[0].value;
        else { inventory = null; errors.push(results[0].reason?.message || "Could not inspect local listeners."); }
      }
      if (results[1].status === "fulfilled" && (!configuration || results[1].value?.configurationId === configuration.id) && results[1].value?.repositoryId === repositoryId) {
        details = results[1].value; input.value = String(portNumber(details.applicationPort) || portNumber(details.savedApplicationPort) || ""); loadedKey = key();
        if (configuration) notify(onInspected, details, { repositoryId, configurationId: configuration.id, configuration });
      } else { details = null; loadedKey = ""; errors.push(results[1].reason?.message || "Could not read this service's port configuration."); }
      error = errors.map(text).join(" "); return { inventory, details };
    }).catch(reason => { if (current()) error = text(reason?.message || reason); return null; })
      .finally(() => { if (read === pending) read = null; if (current()) { renderInventory(); publish(); } });
    publish(); return pending.promise;
  }
  function close(restoreFocus = true) {
    if (!opened) return;
    opened = false; invalidate(); publish();
    if (restoreFocus && visible && !disposed) trigger.focus?.();
  }
  async function open() {
    if (disposed || !visible || !repository?.id || opening) return;
    const sourceEpoch = epoch; opening = true;
    try {
      if (await beforeOpen() === false || disposed || !visible || epoch !== sourceEpoch) return;
      opened = true; invalidate(); error = ""; renderInventory(); publish();
      closeButton.focus?.(); void refresh();
    } catch (reason) {
      if (!disposed && epoch === sourceEpoch) notify(onError, reason instanceof Error ? reason : new Error(text(reason)));
    } finally { opening = false; }
  }
  async function save(event) {
    event.preventDefault();
    if (!eligible() || saving || saveButton.disabled || loadedKey !== key()) return;
    const configuration = selected(), sourceEpoch = epoch;
    const source = { repository: { ...repository }, repositoryId: repository.id, configuration: { ...configuration }, configurationId: configuration.id, configFile: details.configFile,
      affectedFiles: [...new Set([details.configFile, ...(Array.isArray(details.affectedFiles) ? details.affectedFiles : [])])].filter(Boolean) };
    const body = { applicationPort: Number(input.value), configFile: details.configFile, expectedContentHash: details.contentHash };
    const operation = {}; let saved = false; saving = operation; error = ""; success = ""; publish();
    try {
      for (const affectedFile of source.affectedFiles) {
        if (await canEditFile(source.repositoryId, affectedFile) === false) throw new Error("Save or discard unsaved edits to this configuration file before changing its port.");
        if (!eligible() || epoch !== sourceEpoch) return;
      }
      if (!eligible() || epoch !== sourceEpoch) return;
      const result = await api(`/api/run-configurations/${encodeURIComponent(source.configurationId)}/ports`, { method: "POST", body, dedupe: false });
      saved = true;
      // A committed write belongs to its immutable source scope, not whichever
      // repository happens to be visible when its response arrives.
      notify(onSaved, result, source);
      if (!disposed && epoch === sourceEpoch) {
        const applicationPort = portNumber(result?.applicationPort) || body.applicationPort;
        configurations = configurations.map(item => item.id === source.configurationId ? { ...item, port: applicationPort } : item);
        details = { ...details, applicationPort, contentHash: result?.contentHash || "" }; input.value = String(applicationPort);
        success = `${result?.changed === false ? "Port is already saved" : `Saved port ${applicationPort}`}${result?.restartRequired ? ". Restart this service when ready to use the new port." : "."}`;
      }
    } catch (reason) {
      if (!disposed && epoch === sourceEpoch) { error = text(reason?.message || reason); notify(onError, reason instanceof Error ? reason : new Error(error)); }
    } finally {
      if (saving === operation) saving = null;
      if (!disposed) { publish(); if (visible && (saved || epoch !== sourceEpoch)) void refresh(); }
    }
  }
  listen(form, "submit", event => { void save(event); });
  listen(input, "input", () => { error = ""; success = ""; publish(); });
  listen(selection, "change", () => {
    const configuration = choices().find(item => item.id === selection.value); if (!configuration || saving) return;
    selectedId = configuration.id; invalidate(); details = null; loadedKey = ""; input.value = ""; error = ""; success = "";
    notify(onSelect, selectedId, repository.id); renderInventory(); publish(); void refresh();
  });
  listen(document, "keydown", event => { if (opened && event.key === "Escape") { event.preventDefault(); event.stopPropagation?.(); close(); } });
  listen(document, "pointerdown", event => { if (opened && !host.contains?.(event.target) && !panel.contains?.(event.target)) close(false); });
  listen(view, "resize", position); listen(view, "scroll", position);
  publish();
  return {
    get state() { return { repository, configuration: selected(), opened, visible, loading: pendingRead(), saving: Boolean(saving), details, inventory, error, success, ...describe() }; },
    setContext(next = {}) {
      if (disposed) return;
      const previousKey = key(), previousVisible = visible, previousConfiguration = selected(), previousInventoryContext = inventoryContext();
      if (Object.hasOwn(next, "repository")) repository = next.repository || null;
      if (Object.hasOwn(next, "configurations")) configurations = Array.isArray(next.configurations) ? next.configurations.slice() : [];
      if (Object.hasOwn(next, "processes")) processes = Array.isArray(next.processes) ? next.processes.slice() : [];
      if (Object.hasOwn(next, "selectedConfigurationId")) selectedId = next.selectedConfigurationId || "";
      if (Object.hasOwn(next, "visible")) visible = Boolean(next.visible);
      const changed = previousKey !== key();
      if (changed) { invalidate(); details = null; loadedKey = ""; inventory = null; error = ""; success = ""; input.value = ""; }
      else if (visible !== previousVisible) invalidate();
      // Service inventory changes must not leave stale ports or live labels
      // behind. Ordinary polling never scans listeners or resets a draft.
      if (!changed && previousInventoryContext !== inventoryContext()) { inventory = null; if (opened) renderInventory(); }
      if (!visible || !repository?.id) close(false);
      const configChanged = JSON.stringify(previousConfiguration) !== JSON.stringify(selected());
      if (configChanged && !changed && !saving) { invalidate(); details = null; loadedKey = ""; }
      if (visible && (changed || configChanged || !previousVisible)) { if (opened) renderInventory(); void refresh(); }
      publish();
    },
    refresh,
    dispose() { if (disposed) return; disposed = true; invalidate(); for (const remove of listeners) remove(); trigger.remove(); panel.remove(); },
  };
}
