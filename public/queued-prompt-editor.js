import { queuedSteerButtonMarkup } from "./queued-prompt-steering.mjs?v=20261013-383";
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export function queuedPromptButtons(scope, taskId, request, steering = {}) {
  if (!request?.requestId) return "";
  const attributes = `data-queue-scope="${escapeHtml(scope)}" data-queue-task="${escapeHtml(taskId)}"`;
  const steer = queuedSteerButtonMarkup(scope, taskId, request, steering);
  if (request.status !== "queued" && !steer) return "";
  const control = `<span class="queued-steering-control" data-queued-steering="${escapeHtml(request.requestId)}" ${attributes}>${steer}</span>`;
  const actions = request.status === "queued" ? `<button type="button" class="chat-message-edit" data-edit-queued="${escapeHtml(request.requestId)}" ${attributes} aria-label="Edit queued message" title="Edit this waiting message">✎ <span>Edit</span></button><button type="button" class="chat-message-edit" data-discard-queued="${escapeHtml(request.requestId)}" ${attributes} aria-label="Delete queued message" title="Delete this waiting message">× <span>Delete</span></button>` : "";
  return `<span class="queued-message-actions">${control}${actions}</span>`;
}

// Lives outside the transcript so polling cannot erase an unsaved edit.
// The returned close promise lets this window pause dispatch while editing.
export function createQueuedPromptEditor({ document, load, save, beforeOpen = () => true, createNoteFields }) {
  let dialog, selection, opener, resolveClosed;
  let noteFields;
  let busy = false, opening = false;
  const find = (selector) => dialog.querySelector(selector);
  const setBusy = (value) => {
    busy = value;
    for (const selector of ["textarea", "[data-save-queue-edit]", "[data-cancel-queue-edit]"]) find(selector).disabled = value;
    find("[data-save-queue-edit]").textContent = value ? "Saving…" : "Save changes";
    dialog.setAttribute("aria-busy", String(value));
    noteFields?.setBusy(value);
  };
  const finish = () => {
    selection = null;
    resolveClosed?.(); resolveClosed = null;
    if (opener?.isConnected) opener.focus();
  };
  const close = () => {
    if (busy) return;
    dialog.close(); finish();
  };
  function mount() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "queued-prompt-edit-dialog";
    dialog.className = "prompt-edit-dialog";
    dialog.setAttribute("aria-labelledby", "queued-prompt-edit-title");
    dialog.innerHTML = `<form><header><h2 id="queued-prompt-edit-title">Edit queued message</h2><p>Update this waiting message without starting another request. Its place in the queue, attachments, repositories and model settings stay the same.</p></header><label for="queued-prompt-edit-text">Message</label><textarea id="queued-prompt-edit-text" maxlength="100000" required></textarea><p data-edit-attachments></p><p class="prompt-edit-error" role="alert" data-queue-edit-error></p><footer><button type="button" class="secondary-button" data-cancel-queue-edit>Cancel</button><button type="submit" class="primary-button" data-save-queue-edit>Save changes</button></footer></form>`;
    document.body.append(dialog);
    if (createNoteFields) {
      const host = document.createElement("section"); host.className = "task-note-fields";
      find("[data-edit-attachments]").after(host);
      noteFields = createNoteFields(host);
    }
    find("[data-cancel-queue-edit]").addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.addEventListener("close", () => { if (!dialog.open) finish(); });
    find("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !selection) return;
      const prompt = find("textarea").value;
      if (!prompt.trim()) { find("[data-queue-edit-error]").textContent = "Enter a message before saving."; return; }
      find("[data-queue-edit-error]").textContent = "";
      let promptNotes;
      try { promptNotes = noteFields?.get(); }
      catch (error) { find("[data-queue-edit-error]").textContent = error.message; return; }
      setBusy(true);
      try {
        await save({ ...selection, prompt, ...(promptNotes ? { promptNotes } : {}) });
        setBusy(false); close();
      } catch (error) {
        find("[data-queue-edit-error]").textContent = error.message || "The queued message could not be saved. Your edit is kept here.";
        setBusy(false);
      }
    });
  }
  return {
    async open({ scope, taskId, requestId, trigger }) {
      if (opening || busy || dialog?.open) return null;
      opening = true;
      try {
        const request = await load({ scope, taskId, requestId });
        if (!request || request.taskId !== taskId || request.requestId !== requestId || request.status !== "queued")
          throw new Error("This message is no longer waiting in the queue. Refresh the chat to check its status.");
        if (!beforeOpen({ scope, taskId, request })) return null;
        mount(); opener = trigger;
        selection = { scope, request };
        find("textarea").value = request.prompt;
        noteFields?.set(request.promptNotes || []);
        find("[data-edit-attachments]").textContent = request.attachments?.length
          ? `Attachments retained: ${request.attachments.map((item) => item.title || item.name || item.fileName || "attachment").join(", ")}` : "";
        find("[data-queue-edit-error]").textContent = "";
        setBusy(false);
        const closed = new Promise((resolve) => { resolveClosed = resolve; });
        dialog.showModal(); find("textarea").focus();
        return { closed };
      } finally { opening = false; }
    },
  };
}
