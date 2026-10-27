const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** A clone belongs to the backend job, not to a long-lived HTTP request. */
export function createRepositoryCloneJobs({ api, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), randomId = () => crypto.randomUUID() }) {
  let pendingStart;
  const path = "/api/repository-onboarding/clone/jobs";
  return {
    async start(input) {
      // If the POST response is lost, retry the same logical submission, not another clone.
      const key = JSON.stringify([input.remoteUrl, input.destinationPath]);
      if (pendingStart?.key !== key) pendingStart = { key, requestId: randomId() };
      try {
        const job = await api(path, { method: "POST", body: { ...input, requestId: pendingStart.requestId } });
        pendingStart = undefined;
        return job;
      } catch (error) {
        if (error.status >= 400 && error.status < 500) pendingStart = undefined;
        throw error;
      }
    },
    async list() { return (await api(path, { dedupe: false })).jobs || []; },
    async get(id) { return api(`${path}/${encodeURIComponent(id)}`, { dedupe: false }); },
    async cancel(id) { return api(`${path}/${encodeURIComponent(id)}/cancel`, { method: "POST" }); },
    async wait(job, onUpdate = () => {}) {
      for (;;) {
        onUpdate(job);
        if (job.status === "completed") {
          // A crash-safe receipt may have been persisted just before branch inspection.
          if (!job.result?.repository) job = await this.get(job.id);
          if (!job.result?.repository) throw new Error("Clone finished without repository details. Choose the cloned folder to continue onboarding.");
          return job.result;
        }
        if (terminal.has(job.status)) throw Object.assign(new Error(job.error || job.message || `Clone ${job.status}`), { terminal: true });
        await delay(1_500);
        try { job = await this.get(job.id); }
        catch (error) { throw Object.assign(new Error(`Status check interrupted. The clone may still be running. Resume status to reconnect. ${error.message}`), { jobId: job.id }); }
      }
    },
  };
}
