// Checkpoints are local reading metadata, never a new AI request or a prompt edit.
export function createChatCheckpointActions({ api, getTask, isActive, onChange, onError }) {
  const latest = new Map();
  const pending = new Set();
  const revision = (task) => Number.isSafeInteger(task?.checkpointRevision) ? task.checkpointRevision : 0;
  function ingest(task) {
    if (!task?.id) return task;
    const saved = latest.get(task.id);
    if (saved && saved.revision > revision(task))
      return { ...task, checkpointRevision: saved.revision, checkpoints: saved.checkpoints };
    latest.set(task.id, { revision: revision(task), checkpoints: task.checkpoints || [] });
    return task;
  }
  return {
    ingest,
    isPending: (taskId) => pending.has(taskId),
    async toggle(scope, taskId, messageId) {
      const original = getTask(scope);
      if (original?.id !== taskId || !isActive(scope, taskId) || pending.has(taskId)) return;
      const task = ingest(original);
      const marked = task.checkpoints?.some((item) => item.messageId === messageId);
      const message = task.messages?.find((item) => item.id === messageId)
        || task.checkpoints?.find((item) => item.messageId === messageId)?.message;
      if (!message || !["user", "assistant"].includes(message.role) || message.optimistic || message.queued || message.pendingRevision) return;
      pending.add(taskId);
      onChange(scope, taskId);
      try {
        const result = await api(`/api/ai-tasks/${encodeURIComponent(taskId)}/checkpoints/${encodeURIComponent(messageId)}`, { method: marked ? "DELETE" : "PUT" });
        // Store only bookmark metadata from this response. A concurrent live
        // response may already have appended messages to the visible task.
        if (result?.id !== taskId) throw new Error("The checkpoint response did not match this chat.");
        ingest(result);
      } catch (error) {
        onError(error.message || "Could not save this checkpoint. Please try again.");
      } finally {
        pending.delete(taskId);
        onChange(scope, taskId);
      }
    },
  };
}

export function checkpointButtonMarkup({ taskId, messageId, marked, pending, escapeHtml }) {
  const action = marked ? "Remove checkpoint" : "Add checkpoint";
  return `<button type="button" class="chat-message-checkpoint" data-checkpoint-task="${escapeHtml(taskId)}" data-checkpoint-message="${escapeHtml(messageId)}" aria-label="${action}" aria-pressed="${Boolean(marked)}" title="${action} · saved in this chat only"${pending ? " disabled" : ""}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h8v11l-4-2.8-4 2.8z" /></svg><span>${marked ? "Checkpoint" : "Mark"}</span></button>`;
}
