const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const copy = (value) => JSON.parse(JSON.stringify(value));
export const NOTES_LIMITS = { count: 20, text: 4000, total: 20000 };

export function validatePromptNotes(notes) {
  if (!Array.isArray(notes) || notes.length > NOTES_LIMITS.count) throw new Error("Use at most 20 notes per task.");
  const ids = new Set();
  let total = 0;
  return notes.map((note) => {
    const id = String(note?.id || ""), text = String(note?.text || "").trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || ids.has(id)) throw new Error("A note has an invalid or repeated ID. Remove it and add it again.");
    ids.add(id);
    if (!text || text.length > NOTES_LIMITS.text || text.includes("\0")) throw new Error("Each note needs text, up to 4,000 characters, without NUL characters. Remove empty notes before saving.");
    total += text.length;
    if (total > NOTES_LIMITS.total) throw new Error("Keep the combined notes under 20,000 characters.");
    if (typeof note.enabled !== "boolean") throw new Error("Choose whether each note is enabled.");
    return { id, text, enabled: note.enabled };
  });
}

export function promptNotesKey(context) {
  if (!context || !["repository", "global"].includes(context.scope) || !context.repositoryId) throw new Error("Open a repository or Nexus chat first.");
  return JSON.stringify([context.scope, context.repositoryId, context.taskId || "new"]);
}

// Java Instant strings omit trailing fractional zeros. Lexical comparison (and
// Date's millisecond precision) can therefore reverse two successive updates.
function instantNanos(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  const millis = Date.parse(`${match[1]}${match[3]}`);
  return Number.isFinite(millis) ? BigInt(millis) * 1000000n + BigInt((match[2] || "").padEnd(9, "0")) : null;
}

function olderInstant(value, previous) {
  const next = instantNanos(value), current = instantNanos(previous);
  return next !== null && current !== null && next < current;
}

// Defaults live with the task on the server. Only unsent draft defaults and
// one-prompt overrides are cached locally; neither can rewrite a sent snapshot.
export function createPromptNotesStore(storage) {
  const entries = new Map();
  let generation = 0;
  const newEntry = (values = {}) => ({ defaults: [], override: null, known: false, updatedAt: "", revision: 0, defaultRevision: 0, pendingDefaults: false, generation: ++generation, ...values });
  try {
    for (const [key, value] of Object.entries(JSON.parse(storage?.getItem("argus-task-prompt-notes-v1") || "{}"))) {
      const context = JSON.parse(key);
      if (!Array.isArray(context) || context.length !== 3) continue;
      const draft = context[2] === "new", pending = value.pendingDefaults === true;
      entries.set(key, newEntry({ defaults: draft || pending ? validatePromptNotes(value.defaults || []) : [], override: value.override == null ? null : validatePromptNotes(value.override), known: draft || pending, pendingDefaults: !draft && pending }));
    }
  } catch { /* Corrupt local drafts never replace saved task defaults. */ }
  const persist = () => {
    const data = {};
    for (const [key, entry] of entries) {
      const draft = JSON.parse(key)[2] === "new";
      if (entry.override !== null || entry.pendingDefaults || (draft && entry.defaults.length)) data[key] = { defaults: draft || entry.pendingDefaults ? entry.defaults : [], override: entry.override, pendingDefaults: entry.pendingDefaults };
    }
    try { storage?.setItem("argus-task-prompt-notes-v1", JSON.stringify(data)); } catch { /* Server-saved defaults remain durable when local storage is full. */ }
  };
  const entryFor = (context) => {
    const key = promptNotesKey(context);
    if (!entries.has(key)) entries.set(key, newEntry({ known: !context.taskId }));
    return entries.get(key);
  };
  const defaultsSnapshot = (context, entry) => copy({ context, generation: entry.generation, defaultRevision: entry.defaultRevision, notes: entry.defaults });
  const snapshotCurrent = (snapshot) => {
    const entry = entries.get(promptNotesKey(snapshot.context));
    return Boolean(entry && entry.generation === snapshot.generation && entry.defaultRevision === snapshot.defaultRevision);
  };
  const stageDefaults = (context, notes) => {
    const entry = entryFor(context);
    entry.defaults = validatePromptNotes(notes); entry.override = null; entry.known = true;
    entry.pendingDefaults = Boolean(context.taskId); entry.defaultRevision++; entry.revision++; persist();
    return defaultsSnapshot(context, entry);
  };
  const acknowledgeDefaults = (snapshot, task) => {
    if (!snapshotCurrent(snapshot)) return false;
    const entry = entryFor(snapshot.context);
    entry.pendingDefaults = false;
    if (task?.updatedAt && !olderInstant(task.updatedAt, entry.updatedAt)) entry.updatedAt = task.updatedAt;
    // The request's defaults are already staged. Never clear an override the
    // user added while the save was in flight.
    persist(); return true;
  };
  return {
    view(context) {
      const entry = entryFor(context);
      return copy({ ...entry, effective: entry.override ?? entry.defaults });
    },
    ingest(context, task) {
      if (!task?.id || task.id !== context.taskId) return;
      const entry = entryFor(context);
      if (olderInstant(task.updatedAt, entry.updatedAt)) return;
      if (!entry.pendingDefaults) entry.defaults = validatePromptNotes(task.promptNotes || []);
      entry.known = true;
      entry.updatedAt = task.updatedAt || entry.updatedAt;
    },
    override(context, notes) {
      const entry = entryFor(context);
      entry.override = validatePromptNotes(notes); entry.revision++; persist();
    },
    resetOverride(context) { const entry = entryFor(context); entry.override = null; entry.revision++; persist(); },
    save(context, notes, task) {
      const snapshot = stageDefaults(context, notes);
      acknowledgeDefaults(snapshot, task);
    },
    stageDefaults, acknowledgeDefaults, snapshotCurrent,
    pendingDefaults(context) { const entry = entryFor(context); return entry.pendingDefaults ? defaultsSnapshot(context, entry) : null; },
    resetDraft(context) { if (!context.taskId) { entries.delete(promptNotesKey(context)); persist(); } },
    capture(context) {
      const entry = entryFor(context);
      return copy({ context, generation: entry.generation, revision: entry.revision, request: {
        ...(entry.known || entry.override !== null ? { promptNotes: entry.override ?? entry.defaults } : {}),
        ...(!context.taskId ? { taskPromptNotes: entry.defaults } : {}),
      } });
    },
    submitted(capture, taskId) {
      if (!capture) return null;
      const key = promptNotesKey(capture.context), entry = entries.get(key);
      // An explicitly reset/new draft cannot inherit a late prior acceptance.
      if (!entry || entry.generation !== capture.generation) return null;
      if (!capture.context.taskId && taskId) {
        const context = { ...capture.context, taskId }, next = entryFor(context);
        const changed = entry.revision !== capture.revision;
        const changedDefaults = changed && JSON.stringify(entry.defaults) !== JSON.stringify(capture.request.taskPromptNotes || []);
        // An edit already made directly in the created task is newer than its
        // draft. Do not replace it with a late migration.
        if (next.revision === 0) {
          if (changedDefaults || !next.known) next.defaults = copy(changedDefaults ? entry.defaults : capture.request.taskPromptNotes || []);
          next.override = changed ? copy(entry.override) : null;
          next.known = true; next.revision++;
          if (changedDefaults) { next.pendingDefaults = true; next.defaultRevision++; }
        }
        entries.delete(key); persist();
        return { context, generation: next.generation, sourceGeneration: entry.generation,
          pendingDefaults: next.pendingDefaults ? defaultsSnapshot(context, next) : null };
      }
      if (entry.revision === capture.revision) {
        entry.override = null;
        entry.revision++; persist();
      }
      return null;
    },
  };
}

export function sentPromptNotesMarkup(notes) {
  if (!Array.isArray(notes) || !notes.length) return "";
  const enabled = notes.filter((note) => note.enabled);
  return `<details class="chat-message-note-summary"><summary>NOTE · ${enabled.length} ${enabled.length === 1 ? "instruction" : "instructions"} included</summary>${notes.map((note) => `<p>${note.enabled ? "Included" : "Skipped"}</p><pre>${escapeHtml(note.text)}</pre>`).join("")}</details>`;
}

export function promptNoteRows(notes, start = 0) {
  return notes.map((note, index) => `<article class="task-note-row" data-note-id="${escapeHtml(note.id)}"><header><label><input type="checkbox" data-note-enabled ${note.enabled ? "checked" : ""} /> Note ${start + index + 1}</label><button type="button" data-remove-note aria-label="Remove note ${start + index + 1}">Remove</button></header><textarea data-note-text rows="2" maxlength="4000" aria-label="Note ${start + index + 1} text" placeholder="For example: Explain what changed and list the tests you ran.">${escapeHtml(note.text)}</textarea></article>`).join("");
}

export function createPromptNoteFields(document, host) {
  host.innerHTML = '<div class="task-note-rows"></div><button type="button" class="task-note-add" data-add-note>＋ Add note</button><small>Up to 20 notes. Enabled notes are appended to the actual prompt as a NOTE section.</small>';
  const rows = host.querySelector(".task-note-rows");
  const values = () => [...rows.querySelectorAll("[data-note-id]")].map((row) => ({ id: row.dataset.noteId, text: row.querySelector("[data-note-text]").value, enabled: row.querySelector("[data-note-enabled]").checked }));
  const update = () => {
    const items = [...rows.querySelectorAll("[data-note-id]")];
    host.querySelector("[data-add-note]").disabled = items.length >= NOTES_LIMITS.count;
    items.forEach((row, index) => {
      row.querySelector("label").lastChild.textContent = ` Note ${index + 1}`;
      row.querySelector("[data-remove-note]").setAttribute("aria-label", `Remove note ${index + 1}`);
      row.querySelector("[data-note-text]").setAttribute("aria-label", `Note ${index + 1} text`);
    });
  };
  host.addEventListener("click", (event) => {
    if (event.target.closest("[data-remove-note]")) { event.target.closest("[data-note-id]").remove(); update(); }
    if (event.target.closest("[data-add-note]") && values().length < NOTES_LIMITS.count) {
      const row = document.createElement("div");
      row.innerHTML = promptNoteRows([{ id: crypto.randomUUID(), text: "", enabled: true }], values().length);
      const article = row.firstElementChild;
      // Preserve all existing textarea nodes and caret positions while adding.
      const number = values().length + 1;
      article.querySelector("[data-note-text]").setAttribute("aria-label", `Note ${number} text`);
      rows.append(article); update(); article.querySelector("textarea").focus();
    }
  });
  return {
    set(notes) { rows.innerHTML = promptNoteRows(notes); update(); },
    get() { return validatePromptNotes(values()); },
    setBusy(busy) { for (const field of host.querySelectorAll("input, textarea, button")) field.disabled = busy; if (!busy) update(); },
  };
}

export function createTaskPromptNotes({ document, storage, getContext, loadTask, saveTask, beforeOpen = () => true, onError = () => {} }) {
  const store = createPromptNotesStore(storage);
  const saves = new Map();
  let dialog, fields, selection, opener, contextOpener, busy = false, opening = false;
  const rootFor = (scope) => document.querySelector(scope === "global" ? "#global-task-notes" : "#repository-task-notes");
  function render(scope) {
    const host = rootFor(scope), context = getContext(scope);
    if (!host || !context?.repositoryId) return;
    const view = store.view(context), enabled = view.effective.filter((note) => note.enabled).length;
    const saving = saves.has(promptNotesKey(context));
    for (const [key, value] of Object.entries({ enabledNoteCount: String(enabled), noteCount: String(view.effective.length), noteOverride: String(view.override !== null) })) {
      if (host.dataset[key] !== value) host.dataset[key] = value;
    }
    const html = `<button type="button" data-edit-task-notes="${scope}" class="task-notes-open" aria-label="Edit notes for this task"><span>NOTE</span> ${enabled ? `${enabled} enabled` : view.effective.length ? "Off" : "Add notes"}</button><small>${view.override !== null ? "This prompt only" : "This task"}${view.pendingDefaults ? saving ? " · Saving defaults…" : " · Defaults not saved" : ""}</small>${view.pendingDefaults && !saving ? `<button type="button" data-retry-task-notes="${scope}" class="task-notes-toggle">Retry save</button>` : ""}${view.effective.length ? `<button type="button" data-toggle-task-notes="${scope}" class="task-notes-toggle">${enabled ? "Skip this prompt" : "Enable this prompt"}</button>` : ""}${view.override !== null ? `<button type="button" data-reset-task-notes="${scope}" class="task-notes-toggle">Use task defaults</button>` : ""}`;
    if (host.innerHTML !== html) host.innerHTML = html;
  }
  function persistDefaults(snapshot) {
    const key = promptNotesKey(snapshot.context), previous = saves.get(key);
    if (previous?.snapshot.generation === snapshot.generation && previous.snapshot.defaultRevision === snapshot.defaultRevision) return previous.promise;
    const promise = (previous?.promise || Promise.resolve()).catch(() => {}).then(async () => {
      if (!store.snapshotCurrent(snapshot)) return;
      const task = await saveTask(snapshot.context, snapshot.notes);
      store.acknowledgeDefaults(snapshot, task);
    });
    const operation = { snapshot, promise };
    saves.set(key, operation);
    const finish = () => { if (saves.get(key) === operation) saves.delete(key); render(snapshot.context.scope); };
    promise.then(finish, finish);
    render(snapshot.context.scope);
    return promise;
  }
  function savePending(snapshot) {
    if (!snapshot) return Promise.resolve();
    return persistDefaults(snapshot).catch((error) => {
      if (store.snapshotCurrent(snapshot)) onError(new Error(`Task notes are kept locally but could not be saved. Choose Retry save. ${error.message || ""}`.trim()));
    });
  }
  function currentSelection() {
    if (!selection || store.view(selection).generation !== selection.generation) throw new Error("This draft was replaced. Your edits are kept here; cancel and open Notes in the intended task before applying them.");
    return copy(selection);
  }
  function setBusy(value) {
    busy = value; fields.setBusy(value);
    for (const button of dialog.querySelectorAll("footer button")) button.disabled = value;
    dialog.setAttribute("aria-busy", String(value));
  }
  function close() {
    if (busy) return;
    dialog.close();
    // Applying notes may replace their button, and the context popover can be
    // dismissed by the modal. Restore focus to a visible control, never behind it.
    const visible = (element) => element?.isConnected && (element.checkVisibility?.({ checkVisibilityCSS: true }) ?? Boolean(element.getClientRects?.().length ?? true));
    const nextOpener = selection && rootFor(selection.scope)?.querySelector("[data-edit-task-notes]");
    [opener, nextOpener, contextOpener].find(visible)?.focus();
    selection = null;
  }
  function mount() {
    if (dialog) return;
    dialog = document.createElement("dialog"); dialog.id = "task-notes-dialog"; dialog.className = "task-notes-dialog";
    dialog.setAttribute("aria-labelledby", "task-notes-title");
    dialog.innerHTML = '<form><header><p class="eyebrow">TASK NOTES</p><h2 id="task-notes-title">Instructions that travel with your prompt</h2><p>Enabled notes are added at the end of the prompt. Make a one-off change, or save defaults for this task only.</p></header><div class="task-note-fields" data-note-fields></div><p class="task-notes-save-help">Removing a note and choosing Save for this task deletes it from future prompts. Sent and queued prompts keep their original notes.</p><p class="task-notes-error" role="alert"></p><footer><button type="button" class="secondary-button" data-cancel-notes>Cancel</button><button type="button" class="secondary-button" data-use-notes>Use for this prompt</button><button type="submit" class="primary-button">Save for this task</button></footer></form>';
    document.body.append(dialog); fields = createPromptNoteFields(document, dialog.querySelector("[data-note-fields]"));
    dialog.querySelector("[data-cancel-notes]").addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.querySelector("[data-use-notes]").addEventListener("click", () => {
      if (!selection || busy) return;
      try { const context = currentSelection(); store.override(context, fields.get()); render(context.scope); close(); }
      catch (error) { dialog.querySelector(".task-notes-error").textContent = error.message; }
    });
    dialog.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault(); if (!selection || busy) return;
      try {
        const context = currentSelection(), notes = fields.get(); setBusy(true);
        const snapshot = store.stageDefaults(context, notes);
        if (context.taskId) await persistDefaults(snapshot);
        else store.acknowledgeDefaults(snapshot, null);
        render(context.scope); setBusy(false); close();
      } catch (error) { setBusy(false); dialog.querySelector(".task-notes-error").textContent = error.message || "Notes could not be saved. Your edits are kept here."; }
    });
  }
  async function open(scope, trigger) {
    if (busy || opening || dialog?.open) return;
    const context = copy(getContext(scope));
    const contextTrigger = trigger?.closest?.(".composer-context-menu")?.querySelector("summary");
    opening = true;
    try {
      if (context.taskId) store.ingest(context, await loadTask(context.taskId));
      if (promptNotesKey(getContext(scope)) !== promptNotesKey(context)) throw new Error("The active chat changed. Open Notes again in the intended task.");
      if (!beforeOpen()) return;
      mount(); selection = { ...context, generation: store.view(context).generation }; opener = trigger; contextOpener = contextTrigger;
      fields.set(store.view(context).effective); dialog.querySelector(".task-notes-error").textContent = "";
      setBusy(false); dialog.showModal(); dialog.querySelector("[data-add-note]").focus();
    } catch (error) { onError(error); } finally { opening = false; }
  }
  for (const scope of ["repository", "global"]) rootFor(scope)?.addEventListener("click", (event) => {
    if (event.target.closest("[data-edit-task-notes]")) return void open(scope, event.target.closest("button"));
    const context = getContext(scope);
    if (event.target.closest("[data-retry-task-notes]")) return void savePending(store.pendingDefaults(context));
    if (event.target.closest("[data-toggle-task-notes]")) {
      const notes = store.view(context).effective, enabled = notes.some((note) => note.enabled);
      store.override(context, notes.map((note) => ({ ...note, enabled: !enabled })));
    }
    if (event.target.closest("[data-reset-task-notes]")) store.resetOverride(context);
    render(scope);
  });
  return {
    sync(scope, task) { const context = getContext(scope); if (context.repositoryId) { store.ingest(context, task); render(scope); } },
    resetDraft(scope) { store.resetDraft(getContext(scope)); render(scope); },
    capture(scope) { return store.capture(getContext(scope)); },
    submitted(capture, taskId) {
      const migration = store.submitted(capture, taskId);
      if (migration && selection && selection.generation === migration.sourceGeneration
        && promptNotesKey(selection) === promptNotesKey(capture.context)) {
        // Preserve the live textarea nodes/unsaved text, only change where the
        // existing modal's Save button will write after the first send starts.
        selection = { ...migration.context, generation: migration.generation };
      }
      render(capture.context.scope);
      return savePending(migration?.pendingDefaults);
    },
    render, open,
  };
}
