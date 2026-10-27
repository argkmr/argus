// The IDE is a second control surface for Services, not a separate process runner.
// Configuration ids and process state always come from the shared workspace API.
const ACTIVE_PROCESS_STATES = new Set(["installing", "starting", "running", "syncing", "testing", "stopping"]);
const STATUS_LABELS = {
  installing: "Installing dependencies", starting: "Starting", running: "Running",
  syncing: "Syncing", testing: "Testing", stopping: "Stopping", stopped: "Stopped",
  completed: "Completed", failed: "Failed", exited: "Exited",
};
const BUSY_LABELS = { run: "Starting…", start: "Starting…", debug: "Starting debug…", stop: "Stopping…", restart: "Restarting…", sync: "Syncing…", test: "Testing…" };

export function describeIdeRunState({ repository = null, configurations = [], processes = [], selectedId = "", busy = "", loading = false, known = false, error = "" } = {}) {
  const choices = configurations.filter(item => item?.id && repository?.id && item.repositoryId === repository.id);
  const selectedConfiguration = choices.find(item => item.id === selectedId) || choices[0] || null;
  const repositoryControlId = repository?.id ? `repository:${repository.id}` : "";
  // A newly saved Services configuration must not hide repository-wide work
  // that was already started before that configuration existed.
  const repositoryMaintenance = repositoryControlId && processes.some(item => item?.configurationId === repositoryControlId && ACTIVE_PROCESS_STATES.has(item.status));
  const controlId = repositoryMaintenance ? repositoryControlId : selectedConfiguration?.id || repositoryControlId;
  const matching = controlId ? processes.filter(item => item?.configurationId === controlId)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || ""))) : [];
  const currentProcess = matching.find(item => ACTIVE_PROCESS_STATES.has(item.status)) || null;
  const latestProcess = currentProcess || matching[0] || null;
  // Output can outlive repository-wide maintenance. Keep its final diagnostics
  // available after a saved configuration becomes the Run/Stop target again.
  const logCandidates = repository?.id ? processes.filter(item => item?.repositoryId === repository.id
    && (item.configurationId === repositoryControlId || selectedConfiguration && item.configurationId === selectedConfiguration.id))
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || ""))) : [];
  const latestLogProcess = logCandidates.find(item => item.configurationId === selectedConfiguration?.id && ACTIVE_PROCESS_STATES.has(item.status))
    || logCandidates.find(item => ACTIVE_PROCESS_STATES.has(item.status)) || logCandidates[0] || null;
  const ready = Boolean(repository?.id && known && !busy);
  const canSync = ready && !currentProcess;
  const canStart = canSync && Boolean(selectedConfiguration);
  const status = currentProcess?.status || latestProcess?.status || "stopped";
  return {
    repository, configurations: choices, selectedConfiguration, selectedId: selectedConfiguration?.id || "", controlId,
    currentProcess, latestProcess, latestLogProcess, busy, loading, known, error,
    canRun: canStart, canDebug: canStart, canSync,
    canStop: ready && Boolean(currentProcess) && currentProcess.status !== "stopping",
    label: !repository?.id ? "No repository" : busy ? BUSY_LABELS[busy] || "Working…"
      : !known ? "Checking service…" : !selectedConfiguration && !latestProcess ? "Configure in Services"
        : STATUS_LABELS[status] || "Unknown service state",
    debug: currentProcess?.debug || null,
  };
}

/**
 * Shared-process controller. setContext accepts partial updates from app state;
 * configurations must be the saved workspace.runConfigurations, not new copies
 * inferred from an open file. Feed Services polling through setContext({processes})
 * or opt in to polling with pollMs. onProcesses is the authoritative global list.
 * onStarted reports launch acceptance only; the IDE owns debugger attachment.
 * operations may be shared with Services (Map of id to {mode, repositoryId}).
 * Each surface must check the Map before adding an id and remove only its own
 * operation in finally.
 * beforeStart can asynchronously return false to cancel (e.g. unsaved buffers).
 */
export function createIdeRunControls({ api, onChange = () => {}, onProcesses = () => {}, onStarted = () => {}, onError = () => {}, beforeStart = () => true, operations = new Map(), pollMs = 0 } = {}) {
  if (typeof api !== "function") throw new TypeError("An API function is required");
  let repository = null, configurations = [], processes = [], known = false, error = "";
  let epoch = 0, requestSerial = 0, disposed = false, refreshRequest = null;
  let acceptingSharedSnapshot = false, lastContextProcesses = null;
  const selections = new Map();
  // An observer error must never relabel an accepted launch as failed, or cause
  // an unhandled rejection after the backend has already started the service.
  const notify = (callback, ...args) => {
    if (disposed) return;
    try { Promise.resolve(callback(...args)).catch(() => {}); } catch { /* Observers do not own process execution. */ }
  };
  const snapshot = () => {
    const selectedId = selections.get(repository?.id) || "";
    const selected = configurations.find(item => item.repositoryId === repository?.id && item.id === selectedId)
      || configurations.find(item => item.repositoryId === repository?.id);
    return describeIdeRunState({ repository, configurations, processes, selectedId,
      busy: operations.get(repository?.id ? `repository:${repository.id}` : "")?.mode || operations.get(selected?.id)?.mode || "", known, error,
      loading: Boolean(refreshRequest && refreshRequest.epoch === epoch) });
  };
  const publish = () => notify(onChange, snapshot());
  const fail = (reason, contextEpoch) => {
    if (disposed || contextEpoch !== epoch) return;
    error = reason?.message || String(reason);
    notify(onError, reason instanceof Error ? reason : new Error(error));
    publish();
  };
  const shareProcesses = () => {
    // The application's onProcesses callback normally feeds this same snapshot
    // back through setContext while refreshing Services. That feedback is not a
    // newer external poll and must not invalidate our own in-flight operation.
    acceptingSharedSnapshot = true;
    try { notify(onProcesses, processes.slice()); }
    finally { acceptingSharedSnapshot = false; }
  };
  const readProcesses = async () => {
    const serial = ++requestSerial;
    let result;
    try { result = await api("/api/processes"); }
    catch (reason) {
      if (disposed || serial !== requestSerial) return processes.slice();
      throw reason;
    }
    // A fresh shared Services poll supersedes an older IDE request too. Return
    // that newer snapshot to the mutation preflight, not the stale response.
    if (disposed || serial !== requestSerial) return processes.slice();
    if (!Array.isArray(result)) throw new Error("Services returned an invalid process list");
    processes = result.slice(); known = true;
    shareProcesses(); publish();
    return result;
  };
  const refresh = () => {
    if (disposed || !repository?.id) return Promise.resolve(null);
    if (refreshRequest?.epoch === epoch) return refreshRequest.promise;
    const request = { epoch, promise: null };
    refreshRequest = request;
    // Assign the promise before notifying observers so synchronous refreshes join it.
    request.promise = Promise.resolve().then(readProcesses).catch(reason => { fail(reason, request.epoch); return null; })
      .finally(() => { if (refreshRequest === request) { refreshRequest = null; publish(); } });
    publish();
    return request.promise;
  };
  const run = async (mode) => {
    if (!["run", "debug", "stop", "sync"].includes(mode)) throw new TypeError("Unknown IDE service action");
    if (disposed) return null;
    const initial = snapshot();
    if (!(mode === "stop" ? initial.canStop : mode === "debug" ? initial.canDebug : mode === "sync" ? initial.canSync : initial.canRun)) return null;
    const contextEpoch = epoch, sourceRepository = repository, controlId = initial.controlId;
    const configuration = initial.selectedConfiguration?.id === controlId ? initial.selectedConfiguration : null;
    const operation = { mode, repositoryId: sourceRepository.id };
    if (operations.has(controlId)) return null;
    operations.set(controlId, operation); error = ""; publish();
    const stillSelected = () => {
      const repositoryOperation = operations.get(`repository:${sourceRepository.id}`);
      return !disposed && epoch === contextEpoch && snapshot().controlId === controlId
        && (!repositoryOperation || repositoryOperation === operation);
    };
    try {
      if (mode !== "stop" && await beforeStart({ repository: sourceRepository, configuration, mode }) === false) return null;
      if (!stillSelected()) return null;
      // A service may have just been started/stopped in the Services drawer.
      // Recheck before writing; the backend also rejects duplicate launches.
      const latest = await readProcesses();
      if (!stillSelected()) return null;
      const fresh = describeIdeRunState({ repository: sourceRepository, configurations, processes: latest, selectedId: configuration?.id, known: true });
      if (fresh.controlId !== controlId || !(mode === "stop" ? fresh.canStop : mode === "sync" ? fresh.canSync : fresh.canRun)) return null;
      ++requestSerial; // Discard any older polling response during this mutation.
      const endpoint = mode === "sync"
        ? `/api/repositories/${encodeURIComponent(sourceRepository.id)}/project-structure/maintenance`
        : !configuration && mode === "stop"
          ? `/api/repositories/${encodeURIComponent(sourceRepository.id)}/project-structure/maintenance/stop`
          : `/api/run-configurations/${encodeURIComponent(configuration.id)}/${mode === "stop" ? "stop" : "start"}`;
      const result = await api(endpoint, {
        method: "POST", ...(mode === "sync" ? { body: { action: "sync", ...(configuration ? { configurationId: configuration.id } : {}) } } : mode === "debug" ? { body: { debug: true } } : {}),
      });
      ++requestSerial;
      if (!disposed) {
        // Start returns the actual process immediately, before the next poll.
        // Stop returns {ok:true}; do not invent a stopped process or erase logs.
        if (mode !== "stop" && result?.id && result.configurationId === controlId) {
          processes = [result, ...processes.filter(item => item.id !== result.id)]; known = true;
          shareProcesses(); publish();
        }
        if (mode !== "stop" && stillSelected()) notify(onStarted, result, { repository: sourceRepository, configuration, mode });
        try { await readProcesses(); } catch (reason) { fail(reason, contextEpoch); }
      }
      return result;
    } catch (reason) { fail(reason, contextEpoch); return null; }
    finally {
      if (operations.get(controlId) === operation) operations.delete(controlId);
      publish();
    }
  };
  const timer = pollMs > 0 ? setInterval(() => { if (repository?.id && !disposed) void refresh(); }, Math.max(250, pollMs)) : null;
  timer?.unref?.();
  return {
    get state() { return snapshot(); },
    setContext(next = {}) {
      if (disposed) return;
      if (Object.hasOwn(next, "repository")) {
        const nextRepository = next.repository || null;
        if (nextRepository?.id !== repository?.id) { epoch++; error = ""; }
        repository = nextRepository;
      }
      if (Object.hasOwn(next, "configurations")) configurations = Array.isArray(next.configurations) ? next.configurations.slice() : [];
      if (Object.hasOwn(next, "processes")) {
        if (!acceptingSharedSnapshot && next.processes !== lastContextProcesses) ++requestSerial;
        lastContextProcesses = next.processes;
        processes = Array.isArray(next.processes) ? next.processes.slice() : []; known = Array.isArray(next.processes);
      }
      const selected = snapshot().selectedConfiguration;
      if (repository?.id && selected) selections.set(repository.id, selected.id);
      publish();
    },
    select(id) {
      if (disposed || snapshot().busy || !configurations.some(item => item.id === id && item.repositoryId === repository?.id)) return false;
      selections.set(repository.id, id); error = ""; publish(); return true;
    },
    refresh, run,
    dispose() { disposed = true; epoch++; requestSerial++; if (timer) clearInterval(timer); },
  };
}
