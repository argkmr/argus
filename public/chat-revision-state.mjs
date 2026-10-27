// A prompt revision keeps the task identity, but starts a new live-response boundary.
// Legacy forked chats deliberately retain their original job behavior.
export const chatRevisionCount = (task) => Number.isSafeInteger(task?.revisionCount) && task.revisionCount >= 0 ? task.revisionCount : 0;

export function sameTaskRevision(task) {
  return Boolean(task?.id && task.revisionOf?.taskId === task.id);
}

export function createChatRevisionState() {
  const latest = new Map();
  return {
    accept(task) {
      if (!task?.id) return true;
      const previous = latest.get(task.id);
      if (previous && chatRevisionCount(task) < chatRevisionCount(previous)) return false;
      // Retain only the identity boundary, never a whole transcript per visited task.
      latest.set(task.id, { id: task.id, revisionCount: chatRevisionCount(task),
        revisionOf: task.revisionOf ? { taskId: task.revisionOf.taskId, createdAt: task.revisionOf.createdAt } : null });
      return true;
    },
    acceptsJob(job, candidate) {
      if (!job) return false;
      const saved = latest.get(job.taskId);
      const task = candidate?.id === job.taskId && (!saved || chatRevisionCount(candidate) >= chatRevisionCount(saved)) ? candidate : saved;
      if (!sameTaskRevision(task)) return true;
      const boundary = Date.parse(task.revisionOf.createdAt || '');
      const started = Date.parse(job.startedAt || job.createdAt || '');
      // Unknown timestamps cannot prove that a job belongs to the revised conversation.
      return Number.isFinite(boundary) && Number.isFinite(started) && started >= boundary;
    },
  };
}
