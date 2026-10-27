/** One read stream for all repository/service surfaces. Does not navigate or replace drafts. */
export function createRuntimeStateSync({ read, apply, enabled = () => true, schedule = callback => setTimeout(callback, 0) }) {
  let revision = 0, mutations = 0, pending = null, queued = false, scheduled = false;
  const relevant = path => /^\/api\/(?:run-configurations(?:\/|$)|repositories(?:\/|$)|repository-onboarding(?:\/|$))/.test(path);
  function request() {
    if (scheduled) return;
    scheduled = true;
    schedule(() => { scheduled = false; void refresh(); });
  }
  function refresh() {
    if (!enabled() || mutations) return Promise.resolve();
    if (pending) { queued = true; return pending; }
    const epoch = revision;
    const operation = Promise.resolve().then(read).then(snapshot => {
      if (epoch !== revision || mutations || !enabled()) return;
      if (!Array.isArray(snapshot?.repositories) || !Array.isArray(snapshot?.runConfigurations))
        throw new Error("Invalid runtime state");
      apply(snapshot);
      revision++;
    }).catch(() => { /* Retain last good state; the next focus/poll retries. */ })
      .finally(() => { if (pending === operation) pending = null; if (queued) { queued = false; request(); } });
    pending = operation; return operation;
  }
  return {
    refresh,
    observe({ path, phase }) {
      if (!relevant(path)) return;
      revision++;
      if (phase === "started") mutations++;
      else { mutations = Math.max(0, mutations - 1); if (!mutations) request(); }
    },
    get revision() { return revision; },
  };
}
