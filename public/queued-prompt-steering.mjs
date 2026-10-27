const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

// UI eligibility is explanatory only. Backend checks turn, model, scope,
// attachments and durable ownership again before any native delivery.
export function queuedSteeringState(request, job) {
  if (!request || request.status !== "queued" || !job || request.taskId !== job.taskId
    || request.repositoryId !== job.repositoryId || !job.steering?.supported) return { visible: false, available: false };
  let reason = "";
  if (request.providerId !== job.provider) reason = "This queued message uses a different AI provider. It will run normally when its turn arrives.";
  else if (request.recovered || request.pauseReason) reason = "This saved queue is paused. Resume it before steering.";
  else if (job.status !== "running" || job.completionPending || !job.nativeTurnId || !job.steering.available)
    reason = job.steering.reason || "The active response is not ready for steering. Your message stays queued.";
  return { visible: true, available: !reason, reason };
}

export function queuedSteerButtonMarkup(scope, taskId, request, { job, pending = false } = {}) {
  if (request?.status === "interrupted" && request.delivery === "steer" && request.jobId && request.turnId) {
    const help = "Check the saved delivery receipt without sending this message again.";
    return `<button type="button" class="chat-message-edit queued-steer-button" data-check-steer="${escapeHtml(request.requestId)}" data-queue-scope="${escapeHtml(scope)}" data-queue-task="${escapeHtml(taskId)}" aria-label="${escapeHtml(help)}" aria-disabled="${pending}"${pending ? ' aria-busy="true"' : ""} title="${escapeHtml(help)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 5a5 5 0 1 0 1 5M12 2v3H9"/></svg><span>${pending ? "Checking…" : "Check delivery"}</span></button>`;
  }
  const state = queuedSteeringState(request, job);
  if (!state.visible && !pending) return "";
  const available = state.available && !pending;
  const help = pending ? "Sending this message into the active response without stopping it."
    : state.reason || "Send this queued message into the active response. It keeps running with its current model and settings.";
  return `<button type="button" class="chat-message-edit queued-steer-button" data-steer-queued="${escapeHtml(request.requestId)}" data-queue-scope="${escapeHtml(scope)}" data-queue-task="${escapeHtml(taskId)}" aria-label="${escapeHtml(pending ? "Steering queued message" : `Steer now. ${help}`)}" aria-disabled="${!available}"${pending ? ' aria-busy="true"' : ""} title="${escapeHtml(help)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12V9a4 4 0 0 1 4-4h6M10 2l3 3-3 3"/></svg><span>${pending ? "Steering…" : "Steer now"}</span></button>`;
}

export function acceptedSteeringMessage(task, requestId, jobId, turnId) {
  return task?.messages?.find(message => message.role === "user" && message.status === "steered"
    && message.steering?.requestId === requestId && message.steering?.jobId === jobId
    && (!turnId || message.steering?.turnId === turnId));
}

// No composer writes, new history messages, queue DELETE, automatic resends,
// or reordering of another waiting item. Use the existing exact-item hold.
export function createQueuedPromptSteering({ api, getQueue, getJob, hold, isCurrent, onChange = () => {}, onSuccess = () => {}, onError = () => {} }) {
  const pending = new Set();
  const notify = change => { if (isCurrent(change.scope, change.taskId, change.repositoryId)) onChange(change); };
  async function perform(scope, taskId, requestId, reconcileOnly) {
    if (pending.has(requestId)) return;
    const queue = getQueue(scope, taskId), request = queue.find(item => item.requestId === requestId);
    if (!request || !isCurrent(scope, taskId, request.repositoryId)) return;
    const job = reconcileOnly ? { id: request.jobId, nativeTurnId: request.turnId } : getJob(scope);
    if (reconcileOnly) {
      if (request.status !== "interrupted" || request.delivery !== "steer" || !job.id || !job.nativeTurnId) return;
    } else {
      const capability = queuedSteeringState(request, job);
      if (!capability.available) { onError(capability.reason || "This response cannot be steered. Your message stays queued."); return; }
    }
    const held = hold(requestId); if (!held) return;
    const change = { scope, taskId, repositoryId: request.repositoryId };
    const body = { taskId, jobId: job.id, expectedTurnId: job.nativeTurnId, expectedPrompt: request.prompt, expectedPromptNotes: request.promptNotes || [] };
    pending.add(requestId);
    let task, accepted = false, failure;
    const endpoint = `/api/prompt-queue/${encodeURIComponent(requestId)}/steer`;
    const isAccepted = result => result?.accepted === true && result.requestId === requestId && result.jobId === job.id && result.turnId === job.nativeTurnId;
    try {
      notify(change);
      const result = await api(`${endpoint}${reconcileOnly ? "/reconcile" : ""}`, { method: "POST", body });
      accepted = isAccepted(result);
      if (!accepted) throw new Error("Steering could not be confirmed. Check this chat before trying again.");
      task = result.task?.id === taskId ? result.task : null;
    } catch (error) {
      failure = error;
      // This endpoint only inspects/repairs an already accepted receipt. It
      // NEVER sends native input, including when history persistence failed.
      const repaired = !reconcileOnly ? await api(`${endpoint}/reconcile`, { method: "POST", body }).catch(() => null) : null;
      accepted = isAccepted(repaired);
      if (accepted) task = repaired.task?.id === taskId ? repaired.task : null;
      else {
        // A lost POST response is not failure proof. Only exact persisted
        // steering metadata proves acceptance; absence from a list does not.
        const [saved, latestTask] = await Promise.all([
          api(`/api/prompt-queue?taskId=${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" }).catch(() => null),
          api(`/api/ai-tasks/${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" }).catch(() => null),
        ]);
        task = latestTask?.id === taskId ? latestTask : null;
        accepted = Boolean(acceptedSteeringMessage(task, requestId, job.id, job.nativeTurnId));
        if (!accepted) {
          const observed = Array.isArray(saved) && saved.find(item => item.requestId === requestId && item.taskId === taskId);
          if (observed) {
            // A known rejection releases the claim. Do not leave stale local
            // delivery fields on a request that is durably queued again.
            for (const key of ["delivery", "jobId", "turnId", "attempted", "error", "pauseReason"])
              if (!(key in observed)) delete request[key];
            Object.assign(request, observed, { recovered: Boolean(observed.pauseReason) || observed.status !== "queued" });
          }
          else Object.assign(request, { status: "interrupted", recovered: true, delivery: "steer", attempted: true,
            jobId: job.id, turnId: job.nativeTurnId,
            error: "Steering may already have been accepted. Check this chat before sending this message again." });
        }
      }
    } finally {
      if (accepted) {
        const index = queue.findIndex(item => item.requestId === requestId);
        if (index >= 0) queue.splice(index, 1);
        if (!task) task = await api(`/api/ai-tasks/${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" }).catch(() => null);
      }
      pending.delete(requestId); held.release();
      notify({ ...change, task: task?.id === taskId ? task : null, refreshConversation: true });
    }
    if (accepted) onSuccess(reconcileOnly ? "Delivery confirmed · the saved message was not sent again"
      : task ? "Message sent into the active response · it keeps working" : "Message sent into the active response. Refresh this chat to see it.");
    else onError(request.status === "interrupted" && request.delivery === "steer" ? request.error || "Steering may already have been accepted. Check this chat before resending." : `${failure?.message || "The message could not be steered."} Your message remains queued.`);
  }
  return {
    isPending: id => pending.has(id),
    steer: (scope, taskId, requestId) => perform(scope, taskId, requestId, false),
    reconcile: (scope, taskId, requestId) => perform(scope, taskId, requestId, true),
  };
}
