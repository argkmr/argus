const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export function promptEditButton(scope, task, message) {
  if (!task?.id || task.codeDiscussionTask === true || !message?.id || message.role !== "user" || message.optimistic) return "";
  return `<button type="button" class="chat-message-edit" data-edit-prompt="${escapeHtml(message.id)}" data-edit-task="${escapeHtml(task.id)}" data-edit-scope="${escapeHtml(scope)}" aria-label="Edit request" title="Edit and resend this request">✎ <span>Edit</span></button>`;
}

// Separate from conversation rendering: polling must never replace an unsaved edit.
export function createPromptEditor({ document, loadTask, submit, beforeOpen = () => true, createNoteFields,
  createRequestId = () => globalThis.crypto.randomUUID() }) {
  let dialog;
  let selection;
  let busy = false;
  let opener;
  let opening = false;
  let noteFields;
  let attempt;
  const find = (selector) => dialog.querySelector(selector);
  const setBusy = (value) => {
    busy = value;
    find("textarea").disabled = value;
    find("[data-save-edit]").disabled = value;
    find("[data-cancel-edit]").disabled = value;
    find("[data-save-edit]").textContent = value ? "Updating this chat…" : "Save & resend";
    find("[data-edit-progress]").textContent = value ? "Checking current response…" : "";
    dialog.setAttribute("aria-busy", String(value));
    noteFields?.setBusy(value);
  };
  const close = () => {
    if (busy) return;
    dialog.close();
    selection = null;
    if (opener?.isConnected) opener.focus();
  };
  function mount() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "prompt-edit-dialog";
    dialog.className = "prompt-edit-dialog";
    dialog.setAttribute("aria-labelledby", "prompt-edit-title");
    dialog.innerHTML = `<form><header><h2 id="prompt-edit-title">Edit request</h2><p>Save &amp; resend automatically stops the current response, then continues from your edited request in this same chat. The original request and its later replies are kept under Previous versions. Changes already made to repository files are not undone.</p><p>The revised response uses the conversation before this request, with a fresh AI session and older-chat search off.</p></header><label for="prompt-edit-text">Request</label><textarea id="prompt-edit-text" maxlength="100000" required></textarea><p data-edit-attachments></p><p role="status" aria-live="polite" data-edit-progress></p><p class="prompt-edit-error" role="alert" data-edit-error></p><footer><button type="button" class="secondary-button" data-cancel-edit>Cancel</button><button type="submit" class="primary-button" data-save-edit>Save &amp; resend</button></footer></form>`;
    document.body.append(dialog);
    if (createNoteFields) {
      const host = document.createElement("section"); host.className = "task-note-fields";
      find("[data-edit-attachments]").after(host);
      noteFields = createNoteFields(host);
    }
    find("[data-cancel-edit]").addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    find("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !selection) return;
      const prompt = find("textarea").value.trim();
      if (!prompt) { find("[data-edit-error]").textContent = "Enter a request before resending."; return; }
      find("[data-edit-error]").textContent = "";
      let promptNotes;
      try { promptNotes = noteFields?.get(); }
      catch (error) { find("[data-edit-error]").textContent = error.message; return; }
      // An uncertain response may already have saved the revision. Retrying
      // unchanged text must recover that same operation, never revise twice.
      const fingerprint = JSON.stringify([prompt, promptNotes]);
      if (attempt?.fingerprint !== fingerprint) attempt = { fingerprint, requestId: createRequestId() };
      setBusy(true);
      try {
        const result = await submit({ ...selection, requestId: attempt.requestId, prompt, ...(promptNotes ? { promptNotes } : {}), onProgress: (label) => {
          find("[data-edit-progress]").textContent = label;
          find("[data-save-edit]").textContent = label;
        } });
        setBusy(false);
        if (result && result.status !== "started") {
          if (result.task?.revisionDraft) {
            selection = { ...selection, task: result.task, message: { ...selection.message, id: "revision-draft", pendingRevision: true,
              content: result.task.revisionDraft.prompt, promptNotes: result.task.revisionDraft.promptNotes, attachments: result.task.revisionDraft.attachments } };
          }
          if (result.error) find("[data-edit-error]").textContent = `Edit saved; ${result.error.status >= 400 && result.error.status < 500 ? "response was not started" : "submission could not be confirmed"}. ${result.error.message}`;
          return;
        }
        close();
      } catch (error) {
        find("[data-edit-error]").textContent = error.message || "The revised request could not start.";
        setBusy(false);
      }
    });
  }
  return {
    async open({ scope, taskId, messageId, trigger }) {
      if (busy || opening || dialog?.open) return;
      opening = true;
      try {
        const task = await loadTask(taskId);
        const message = messageId === "revision-draft" && task.revisionDraft
          ? { id: "revision-draft", role: "user", content: task.revisionDraft.prompt, attachments: task.revisionDraft.attachments, promptNotes: task.revisionDraft.promptNotes, pendingRevision: true }
          : task.messages?.find((item) => item.id === messageId && item.role === "user");
        if (!message) throw new Error("This request is no longer available. Refresh the chat and try again.");
        if (!beforeOpen({ task, scope })) return;
        mount();
        opener = trigger;
        selection = { scope, task, message };
        attempt = null;
        find("textarea").value = message.content;
        noteFields?.set(message.promptNotes || []);
        const attachments = message.attachments || [];
        find("[data-edit-attachments]").textContent = attachments.length ? `Attachments retained: ${attachments.map((item) => item.name || item.fileName || "attachment").join(", ")}` : "";
        find("[data-edit-error]").textContent = "";
        setBusy(false);
        dialog.showModal();
        find("textarea").focus();
      } finally { opening = false; }
    },
  };
}
