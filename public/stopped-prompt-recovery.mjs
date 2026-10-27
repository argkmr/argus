// Recover only the captured request. A later turn must never become the target
// of Stop -> Edit, especially when a saved queue advances during cancellation.
export function findStoppedPromptMessage(task, source) {
  if (!source?.taskId || task?.id !== source.taskId || task.repositoryId !== source.repositoryId) return null;
  const startedAt = typeof source.startedAt === "number" ? source.startedAt : Date.parse(source.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const message = [...(task.messages || [])].reverse().find(item => item.role === "user"
    // Steering belongs to this same response, not a later independent turn.
    // Skip only proven same-job steering; unknown/newer user turns still block.
    && !(source.id && item.status === "steered" && item.steering?.jobId === source.id
      && item.steering.requestId && item.steering.turnId
      && (!source.nativeTurnId || item.steering.turnId === source.nativeTurnId)));
  const createdAt = Date.parse(message?.createdAt);
  if (!message?.id || message.optimistic || !Number.isFinite(createdAt) || !source.prompt?.trim()
    || message.content?.trim() !== source.prompt.trim()) return null;
  if (source.kind === "preparation" && source.previousMessageIds?.includes(message.id)) return null;
  if (source.kind === "preparation" ? createdAt < startedAt - 2_000 : createdAt > startedAt) return null;
  return message;
}

export function createStoppedPromptRecovery({ isCurrent, loadTask, openEditor, restoreDraft, onError }) {
  return async function recover(scope, source) {
    if (!source || !isCurrent(scope, source)) return false;
    if (!source.taskId) return restoreDraft(source);
    try {
      const task = await loadTask(source.taskId);
      if (!isCurrent(scope, source)) return false;
      const message = findStoppedPromptMessage(task, source);
      if (message) {
        await openEditor({ scope, taskId: task.id, messageId: message.id });
        return true;
      }
      // Preparation can be cancelled before appendUser. There is no saved
      // request to revise in that case; put the original draft back instead.
      if (source.kind === "preparation") return restoreDraft(source);
      return false;
    } catch (error) {
      if (isCurrent(scope, source)) onError(error);
      return false;
    }
  };
}
