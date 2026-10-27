// Observe only work seen running in this window (or explicitly launched here), not old history.
export function createProjectSyncLifecycle({ refresh, onError = () => {} }) {
  const pending = new Map(), handled = new Set();
  function complete(process) {
    if (handled.has(process.id)) return;
    handled.add(process.id);
    if (handled.size > 500) handled.delete(handled.values().next().value);
    pending.delete(process.id);
    if (process.status !== "completed" || process.exitCode !== 0) return;
    Promise.resolve().then(() => refresh(process.repositoryId)).catch(onError);
  }
  function track(process) {
    if (!process?.id || !process.repositoryId || process.task !== "sync" || handled.has(process.id)) return;
    if (["completed", "failed", "stopped"].includes(process.status)) complete(process);
    else pending.set(process.id, process.repositoryId);
  }
  return {
    track,
    observe(processes) {
      const ids = new Set();
      for (const process of processes) {
        ids.add(process.id);
        if (pending.has(process.id) || process.task === "sync" && ["syncing", "starting", "running", "stopping"].includes(process.status)) track(process);
      }
      for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
    },
  };
}
