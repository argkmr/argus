const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const dateLabel = value => {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : "Date not recorded";
};

export function revisionHistoryButton(task, scope) {
  const count = Number(task?.revisionCount);
  if (!task?.id || !Number.isSafeInteger(count) || count <= 0) return "";
  return `<button type="button" class="chat-revisions-button" data-chat-revisions="${escapeHtml(task.id)}" data-revision-scope="${escapeHtml(scope)}" aria-haspopup="dialog">Previous versions (${count})</button>`;
}

function defaultAttachments(attachments) {
  return attachments.length ? `<ul class="chat-revisions-attachments">${attachments.map(item => `<li>${escapeHtml(item.title || item.name || item.fileName || "Attached context")}${item.kind ? ` <small>${escapeHtml(item.kind)}</small>` : ""}</li>`).join("")}</ul>` : "";
}

function notesMarkup(notes) {
  if (!Array.isArray(notes) || !notes.length) return "";
  return `<details class="chat-revisions-notes"><summary>Saved NOTE instructions</summary>${notes.map(note => `<p>${note.enabled ? "Included" : "Skipped"}</p><pre>${escapeHtml(note.text)}</pre>`).join("")}</details>`;
}

/**
 * Isolated read-only history. renderMessage receives content, not a message or
 * task: use the safe Markdown body renderer, never live chat/action markup.
 * No task is ingested into live state and no provider or mutation API is called.
 */
export function createChatRevisionViewer({ document, api, renderMessage = content => `<p>${escapeHtml(content)}</p>`, renderAttachments = defaultAttachments, beforeOpen = () => true }) {
  let dialog, opener, context, revisions = [], selectedId = "", generation = 0, selectionGeneration = 0;
  let listRequest, detailRequest, failedOperation, destroyed = false;
  const find = selector => dialog.querySelector(selector);
  const current = epoch => !destroyed && epoch === generation && Boolean(context) && dialog?.open;
  const status = text => { find("[data-revisions-status]").textContent = text; };

  function abortRequests() {
    listRequest?.abort(); detailRequest?.abort();
    listRequest = detailRequest = undefined;
  }
  function reset() {
    generation++; selectionGeneration++; abortRequests();
    context = null; revisions = []; selectedId = ""; failedOperation = undefined;
  }
  function restoreFocus() {
    const target = opener; opener = undefined;
    // Native close events are queued. Do not pull focus away from a newer modal.
    if (target?.isConnected && !document.querySelector?.("dialog[open]")) target.focus({ preventScroll: true });
  }
  function close() {
    reset();
    if (dialog?.open) dialog.close();
    restoreFocus();
  }
  function clearError() {
    failedOperation = undefined;
    find("[data-revisions-error]").textContent = "";
    find("[data-revisions-retry]").hidden = true;
  }
  function showError(error, operation) {
    failedOperation = operation;
    find("[data-revisions-error]").textContent = error?.status === 404
      ? "This saved version is no longer available. Close this view and refresh the chat, or retry."
      : `Could not load previous versions. ${error?.message || "Please try again."}`;
    find("[data-revisions-retry]").hidden = false;
    status("Previous versions could not be loaded.");
  }
  function mount() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "chat-revisions-dialog";
    dialog.className = "chat-revisions-dialog";
    dialog.setAttribute("aria-labelledby", "chat-revisions-title");
    dialog.setAttribute("aria-describedby", "chat-revisions-description");
    dialog.innerHTML = `<section class="chat-revisions-card"><header class="chat-revisions-header"><div><p class="chat-revisions-eyebrow">READ-ONLY CHAT HISTORY</p><h2 id="chat-revisions-title">Previous versions</h2><p id="chat-revisions-description">Saved before editing and resending a request. Viewing a previous version does not change your current chat or undo changes to repository files.</p></div><button type="button" data-revisions-close aria-label="Close previous versions">×</button></header><div class="chat-revisions-toolbar"><label for="chat-revisions-select">Saved version</label><select id="chat-revisions-select" data-revisions-select disabled><option>Loading versions…</option></select><p role="status" aria-live="polite" data-revisions-status></p></div><div class="chat-revisions-error"><p role="alert" data-revisions-error></p><button type="button" data-revisions-retry hidden>Retry</button></div><section class="chat-revisions-transcript" data-revisions-transcript aria-label="Saved conversation" tabindex="0"></section></section>`;
    document.body.append(dialog);
    find("[data-revisions-close]").addEventListener("click", close);
    find("[data-revisions-select]").addEventListener("change", () => selectRevision(find("[data-revisions-select]").value));
    find("[data-revisions-retry]").addEventListener("click", () => failedOperation === "list" ? loadList(generation) : selectRevision(selectedId));
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("close", () => { if (!dialog.open) { reset(); restoreFocus(); } });
  }

  function transcriptMarkup(revision) {
    const task = revision.task;
    if (!task || !Array.isArray(task.messages)) throw new Error("The saved conversation is incomplete. Please retry.");
    const messages = task.messages;
    const editedIndex = messages.findIndex(message => message.id === revision.editedMessageId);
    const rolling = typeof task.rollingContext === "string" ? task.rollingContext : "";
    return `<div class="chat-revisions-snapshot"><span>Saved ${escapeHtml(dateLabel(revision.createdAt))}</span><span>${messages.length} saved ${messages.length === 1 ? "message" : "messages"} · Read-only</span></div>${rolling ? `<details class="chat-revisions-context"><summary>Compacted earlier context</summary><p>Older messages were compacted before this version was saved. This is the preserved context, not a full transcript of those older messages.</p><pre>${escapeHtml(rolling)}</pre></details>` : ""}${messages.length ? messages.map((message, index) => {
      const user = message.role === "user", edited = index === editedIndex;
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      return `${editedIndex >= 0 && index === editedIndex + 1 ? '<p class="chat-revisions-suffix">Later messages from this saved version</p>' : ""}<article class="chat-revisions-message${user ? " is-user" : ""}${edited ? " is-edited" : ""}"><header><strong>${user ? "You" : message.role === "assistant" ? "Argus" : escapeHtml(message.role || "Message")}</strong>${message.createdAt ? `<time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(dateLabel(message.createdAt))}</time>` : ""}${edited ? '<span class="chat-revisions-edited">Request before edit</span>' : ""}</header><div class="chat-revisions-content">${attachments.length ? renderAttachments(attachments) : ""}${renderMessage(String(message.content ?? ""))}${notesMarkup(message.promptNotes)}</div></article>`;
    }).join("") : '<p class="chat-revisions-empty">No individual messages were retained in this saved version.</p>'}`;
  }

  async function selectRevision(id) {
    if (!context || !revisions.some(revision => String(revision.id) === id)) return;
    detailRequest?.abort();
    const request = detailRequest = new AbortController(), epoch = generation, selection = ++selectionGeneration;
    selectedId = id; find("[data-revisions-select]").value = id;
    clearError(); status("Loading saved conversation…");
    const transcript = find("[data-revisions-transcript]");
    transcript.innerHTML = '<p class="chat-revisions-empty">Loading saved conversation…</p>';
    transcript.setAttribute("aria-busy", "true");
    try {
      const revision = await api(`/api/ai-tasks/${encodeURIComponent(context.taskId)}/revisions/${encodeURIComponent(id)}`, { method: "GET", signal: request.signal, dedupe: false, timeout: 20000 });
      if (!current(epoch) || selection !== selectionGeneration || request.signal.aborted) return;
      if (String(revision?.id) !== id) throw new Error("A different saved version was returned. Please retry.");
      transcript.innerHTML = transcriptMarkup(revision);
      transcript.scrollTop = 0;
      status(`Showing saved version from ${dateLabel(revision.createdAt)}. Your current chat is unchanged.`);
    } catch (error) {
      if (!current(epoch) || selection !== selectionGeneration || request.signal.aborted) return;
      transcript.innerHTML = ""; showError(error, "detail");
    } finally {
      if (current(epoch) && selection === selectionGeneration) {
        detailRequest = undefined;
        transcript.setAttribute("aria-busy", "false");
      }
    }
  }

  async function loadList(epoch) {
    if (!current(epoch)) return;
    listRequest?.abort(); detailRequest?.abort(); detailRequest = undefined; selectionGeneration++;
    const request = listRequest = new AbortController();
    clearError(); status("Loading previous versions…");
    const selector = find("[data-revisions-select]"), transcript = find("[data-revisions-transcript]");
    selector.disabled = true; selector.innerHTML = '<option>Loading versions…</option>';
    transcript.innerHTML = ""; transcript.setAttribute("aria-busy", "true");
    try {
      const result = await api(`/api/ai-tasks/${encodeURIComponent(context.taskId)}/revisions`, { method: "GET", signal: request.signal, dedupe: false, timeout: 20000 });
      if (!current(epoch) || request.signal.aborted) return;
      if (!Array.isArray(result)) throw new Error("The saved version list is incomplete. Please retry.");
      revisions = result.filter(revision => revision && typeof revision.id === "string" && revision.id);
      if (!revisions.length) {
        selector.innerHTML = '<option>No previous versions</option>';
        transcript.innerHTML = '<p class="chat-revisions-empty">No previous versions have been saved for this chat.</p>';
        status("No previous versions."); return;
      }
      selector.innerHTML = revisions.map(revision => `<option value="${escapeHtml(revision.id)}">${escapeHtml(dateLabel(revision.createdAt))}${Number.isSafeInteger(revision.messageCount) ? ` · ${revision.messageCount} messages` : ""}${revision.promptPreview ? ` · ${escapeHtml(String(revision.promptPreview).slice(0, 100))}` : ""}</option>`).join("");
      selector.disabled = false;
      await selectRevision(String(revisions[0].id));
    } catch (error) {
      if (!current(epoch) || request.signal.aborted) return;
      selector.innerHTML = '<option>Versions unavailable</option>'; showError(error, "list");
    } finally {
      if (current(epoch) && listRequest === request && !detailRequest) transcript.setAttribute("aria-busy", "false");
    }
  }

  return {
    async open({ taskId, scope, trigger }) {
      if (destroyed || !taskId) return;
      const epoch = ++generation;
      abortRequests();
      mount();
      if (await beforeOpen({ taskId, scope, trigger, dialogId: dialog.id }) === false || destroyed || epoch !== generation) return;
      opener = trigger || document.activeElement;
      context = { taskId, scope }; revisions = []; selectedId = "";
      find("h2").textContent = scope === "global" ? "Previous versions · Nexus" : "Previous versions";
      if (!dialog.open) dialog.showModal();
      find("[data-revisions-close]").focus({ preventScroll: true });
      return loadList(epoch);
    },
    close,
    destroy() { destroyed = true; close(); dialog?.remove(); dialog = undefined; },
  };
}
