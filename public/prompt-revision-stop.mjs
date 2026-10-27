const busyMessage = "Wait for this chat’s queued prompts to finish before editing an earlier request.";
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A cancelled status is published before output drains and the transcript is
// saved. Never revise that transcript until completionPending has cleared.
export function revisionJobIsBusy(job) {
  return Boolean(job && (!terminalStatuses.has(job.status) || job.completionPending !== false));
}

export function createPromptRevisionCoordinator({ api, isCurrent, hasQueuedWork, getSubmission,
  sleep = delay, now = Date.now, timeoutMs = 45_000, pollMs = 300 }) {
  return async function revise({ scope, task, mutate, onProgress = () => {} }) {
    const deadline = now() + timeoutMs;
    const repositoryId = scope === "global" ? "global" : task.repositoryId;
    const headers = { "X-Argus-Cancel-Control": scope === "global" ? "global-prompt-edit" : "repository-prompt-edit" };
    const options = { dedupe: false, cache: "no-store", timeout: 5000 };
    const checkTime = () => {
      if (now() >= deadline) throw new Error("The current response is still stopping. Your edit is kept here; try Save & resend again shortly.");
    };
    const checkCurrent = () => {
      if (!isCurrent(scope, task)) throw new Error("Return to the original chat before resending this edit. Your edit is kept here.");
    };
    const checkQueue = async () => {
      checkTime(); checkCurrent();
      if (hasQueuedWork(scope, task.id)) throw new Error(busyMessage);
      const queue = await api(`/api/prompt-queue?taskId=${encodeURIComponent(task.id)}`, options);
      if (!Array.isArray(queue)) throw new Error("Could not check this chat’s queue. Your edit is kept; please retry.");
      if (queue.length || hasQueuedWork(scope, task.id)) throw new Error(busyMessage);
      checkCurrent();
    };
    const jobs = async () => {
      checkTime();
      const result = await api(`/api/agents/jobs?repositoryId=${encodeURIComponent(repositoryId)}`, options);
      if (!Array.isArray(result)) throw new Error("Could not check the current response. Your edit is kept; please retry.");
      return result.filter((job) => job.taskId === task.id && job.repositoryId === repositoryId && !job.systemJob && !job.orchestrationRunId);
    };
    const stop = (path) => api(path, { ...options, method: "DELETE", headers });

    await checkQueue();
    const capturedJobs = (await jobs()).filter(revisionJobIsBusy);
    checkCurrent();
    const submission = getSubmission(scope, repositoryId);
    const capturedSubmission = submission?.taskId === task.id ? submission : null;
    if (capturedSubmission && !capturedSubmission.requestId)
      throw new Error("The current request is still being prepared. Your edit is kept; please retry shortly.");
    // Refresh the durable queue again just before the first cancellation. A
    // queue worker can dispatch as soon as its predecessor stops.
    if (capturedSubmission || capturedJobs.length) {
      await checkQueue();
      onProgress("Stopping current response…");
      let preparationAcknowledged = !capturedSubmission;
      const stopPreparation = async () => {
        if (!capturedSubmission) return;
        const receipt = await stop(`/api/agents/preparations/${encodeURIComponent(capturedSubmission.requestId)}`);
        preparationAcknowledged ||= Boolean(receipt?.cancellation && Object.keys(receipt.cancellation).length);
      };
      if (capturedSubmission) capturedSubmission.cancelled = true;
      await stopPreparation();
      for (const job of capturedJobs) await stop(`/api/agents/jobs/${encodeURIComponent(job.id)}`);
      while (true) {
        checkTime();
        // A preparation cancellation can arrive before POST /run registers it.
        // Repeat only this captured request ID, never whichever chat is now open.
        await stopPreparation();
        const latest = await jobs();
        const stillPreparing = capturedSubmission && getSubmission(scope, repositoryId) === capturedSubmission;
        // Missing captured jobs are not evidence of completion.
        const missing = capturedJobs.some((job) => !latest.some((item) => item.id === job.id));
        // A timed-out POST can disappear locally while still registering on the
        // server. An empty cancellation receipt cannot prove it will not launch.
        if (preparationAcknowledged && !stillPreparing && !missing && !latest.some(revisionJobIsBusy)) break;
        await sleep(pollMs);
      }
    }
    // The backend takes the task activity lease before writing a revision. Its
    // completion callback releases that lease just after the final job snapshot.
    // Retry ONLY that explicit pre-mutation conflict; never replay an uncertain
    // network failure or a stale-content conflict that might duplicate an edit.
    while (true) {
      await checkQueue();
      onProgress("Updating this chat…");
      try { return await mutate(); }
      catch (error) {
        if (error.status !== 409 || error.message !== "Wait for the task's response to finish before changing or sending a prompt") throw error;
        onProgress("Waiting for the response to finish saving…");
        await sleep(pollMs);
      }
    }
  };
}
