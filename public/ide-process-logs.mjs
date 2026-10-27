// Process output belongs to the Services process, independently of debugger
// attachment. This viewer reads that process only; it never starts or stops it.
import { plainProcessLogText as plainText, formatProcessLogEntry as formatEntry, formatProcessLogSnapshot } from "./process-log-format.mjs?v=20261027-404";

const TERMINAL_STATES = new Set(["stopped", "completed", "failed", "exited"]);
const STATUS_LABELS = { installing: "Installing dependencies", starting: "Starting", running: "Running", syncing: "Syncing", testing: "Testing", stopping: "Stopping", stopped: "Stopped", completed: "Completed", failed: "Failed", exited: "Exited" };
const POLL_MS = 1000, MAX_ENTRIES = 1200, MAX_CHARACTERS = 80_000;

/**
 * Feed the selected Services configuration and runControls.state.latestLogProcess
 * (including failed/exited history). Repository maintenance may use the
 * synthetic configuration id repository:<id>. Construction and hidden contexts
 * never fetch. The caller owns process selection and panel visibility.
 *
 * GET /api/processes/:id/logs?after=<cursor> returns {cursor, logs, status,
 * dropped?}; cursor is the monotonically increasing emitted-entry count.
 */
export function createIdeProcessLogs({ document, api, container, onChange = () => {}, clipboard = document?.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard } = {}) {
  if (!document?.createElement || !container?.append) throw new TypeError("A document and log container are required");
  if (typeof api !== "function") throw new TypeError("An API function is required");
  let repository = null, configuration = null, process = null, visible = false;
  let epoch = 0, disposed = false, timer = null, request = null, urgent = false;
  let cursor = 0, status = "", error = "", entries = [], characters = 0;
  let discarded = false, dropped = 0, following = true, cleared = false, clearSerial = 0, quietReads = 0;
  let copyRequest = null, copyMessage = "", copyFailed = false;
  const listeners = [];
  const element = (tag, className, text = "") => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const listen = (node, event, callback) => { node.addEventListener(event, callback); listeners.push(() => node.removeEventListener(event, callback)); };
  const button = (text, label, callback) => {
    const node = element("button", "", text); node.type = "button"; node.setAttribute("aria-label", label); node.title = label;
    listen(node, "click", callback); return node;
  };
  const root = element("section", "repository-ide-process-logs");
  root.setAttribute("aria-label", "Service process output");
  const toolbar = element("div", "repository-ide-process-logs-toolbar");
  const title = element("strong", "repository-ide-process-logs-title", "Process output");
  const identity = element("span", "repository-ide-process-logs-identity");
  const statusNode = element("span", "repository-ide-process-logs-status");
  statusNode.setAttribute("role", "status");
  const actions = element("div", "repository-ide-process-logs-actions");
  const refreshButton = button("Refresh", "Refresh process output", () => { void refresh(); });
  const copyButton = button("Copy all", "Copy all available process logs", () => { void copyAll(); });
  copyButton.title = "Copy all retained logs for this process, including output trimmed or cleared from this view";
  const clearButton = button("Clear", "Clear displayed process output locally", () => clear());
  const followButton = button("Following", "Follow process output", () => {
    following = !following;
    if (following) output.scrollTop = output.scrollHeight;
    publish();
  });
  actions.append(refreshButton, copyButton, clearButton, followButton);
  toolbar.append(title, identity, statusNode, actions);
  const notice = element("p", "repository-ide-process-logs-notice");
  const copyFeedback = element("p", "repository-ide-process-logs-copy-feedback");
  copyFeedback.setAttribute("role", "status");
  const errorNode = element("div", "repository-ide-process-logs-error");
  const errorText = element("span", "");
  errorNode.setAttribute("role", "status");
  const retryButton = button("Retry", "Retry loading process output", () => { void refresh(); });
  errorNode.append(errorText, retryButton);
  const output = element("div", "repository-ide-process-logs-output");
  output.tabIndex = 0; output.setAttribute("role", "log"); output.setAttribute("aria-label", "Service stdout, stderr and build output");
  // A service can emit thousands of lines; avoid reading every line aloud.
  output.setAttribute("aria-live", "off");
  root.append(toolbar, notice, copyFeedback, errorNode, output); container.append(root);
  const atBottom = () => output.scrollHeight - output.scrollTop - output.clientHeight <= 48;
  listen(output, "scroll", () => { following = atBottom(); publish(); });
  const eligible = () => !disposed && visible && Boolean(repository?.id && process?.id);
  const snapshot = () => ({ repository, configuration, process, visible, cursor, status, error,
    loading: Boolean(request && request.epoch === epoch), entries: entries.map(entry => ({ ...entry.value })),
    discarded, dropped, following, complete: TERMINAL_STATES.has(status) && quietReads >= 2 && !error });
  function publish() {
    if (disposed) return;
    root.hidden = !visible;
    identity.textContent = process ? `${configuration?.name || process.name || repository?.name || "Service"} · ${process.id}` : configuration?.name || repository?.name || "";
    identity.title = process?.command ? plainText(process.command) : identity.textContent;
    const label = process ? STATUS_LABELS[status] || status || "Waiting for output" : "No process";
    statusNode.textContent = `${label}${process && TERMINAL_STATES.has(status) && process.exitCode != null ? ` · exit ${process.exitCode}` : ""}`;
    statusNode.dataset.state = status;
    root.dataset.status = status;
    refreshButton.disabled = !eligible() || Boolean(request && request.epoch === epoch);
    copyButton.disabled = !eligible() || cursor === 0 || Boolean(copyRequest);
    copyButton.textContent = copyRequest ? "Copying…" : "Copy all";
    copyFeedback.textContent = copyMessage;
    copyFeedback.hidden = !copyMessage;
    copyFeedback.dataset.state = copyFailed ? "error" : "success";
    retryButton.disabled = refreshButton.disabled;
    clearButton.disabled = entries.length === 0 && !discarded && !dropped;
    followButton.disabled = !process;
    followButton.textContent = following ? "Following" : "Follow";
    followButton.setAttribute("aria-pressed", String(following));
    errorNode.hidden = !error;
    errorText.textContent = error ? `Could not load process output: ${error}` : "";
    const notices = [];
    if (dropped) notices.push(`${dropped} earlier log ${dropped === 1 ? "entry is" : "entries are"} no longer available from this process.`);
    if (discarded) notices.push("Older displayed output was trimmed; showing the most recent output.");
    if (!entries.length) notices.push(!repository?.id ? "Select a repository to see process output."
      : !process ? "Run, Debug, or Sync this repository to see process output."
        : cleared ? "Output cleared locally. New process output will appear here."
          : request?.epoch === epoch ? "Loading process output…"
            : TERMINAL_STATES.has(status) ? "This process produced no output." : "Waiting for process output…");
    notice.textContent = notices.join(" "); notice.hidden = notices.length === 0;
    try { Promise.resolve(onChange(snapshot())).catch(() => {}); } catch { /* Observers do not own log loading. */ }
  }
  function appendLogs(logs) {
    const top = output.scrollTop, left = output.scrollLeft;
    const follows = following && atBottom(); let removedHeight = 0;
    for (const raw of logs) {
      const line = plainText(raw?.line), timestamp = plainText(raw?.timestamp);
      const value = { timestamp, stream: raw?.stream === "stderr" ? "stderr" : raw?.stream === "stdout" ? "stdout" : "system", line: line.slice(-MAX_CHARACTERS) };
      discarded ||= line.length > value.line.length;
      const row = element("div", "repository-ide-process-logs-entry"); row.dataset.stream = value.stream;
      row.textContent = formatEntry(value);
      entries.push({ value, row }); characters += value.line.length; output.append(row);
      while (entries.length > MAX_ENTRIES || characters > MAX_CHARACTERS) {
        const removed = entries.shift(); characters -= removed.value.line.length;
        removedHeight += removed.row.offsetHeight || 0; removed.row.remove(); discarded = true;
      }
    }
    following = follows;
    output.scrollTop = follows ? output.scrollHeight : Math.max(0, top - removedHeight);
    output.scrollLeft = left;
  }
  const stopTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  function schedule() {
    stopTimer();
    if (!eligible() || (!error && TERMINAL_STATES.has(status) && quietReads >= 2)) return;
    timer = setTimeout(() => { timer = null; void read(); }, POLL_MS); timer?.unref?.();
  }
  function read() {
    if (!eligible()) return Promise.resolve(null);
    if (request) {
      if (request.epoch === epoch) return request.promise;
      // Keep even an abort-ignoring API serialized across process/repo changes.
      return request.promise.then(() => read());
    }
    stopTimer(); urgent = false;
    const pending = { epoch, clearSerial, controller: new AbortController(), promise: null };
    const processId = process.id, after = cursor;
    request = pending;
    const current = () => !disposed && visible && pending.epoch === epoch;
    pending.promise = Promise.resolve().then(() => {
      if (!current()) return null;
      return api(`/api/processes/${encodeURIComponent(processId)}/logs?after=${after}`, { signal: pending.controller.signal, dedupe: false, cache: "no-store" });
    }).then(result => {
      if (!current() || result === null) return null;
      if (!Array.isArray(result?.logs) || !Number.isSafeInteger(result.cursor) || result.cursor < after) throw new Error("Services returned an invalid process log response");
      cursor = result.cursor; error = "";
      if (typeof result.status === "string" && result.status) status = result.status;
      if (pending.clearSerial === clearSerial) {
        if (Number.isSafeInteger(result.dropped) && result.dropped > 0) dropped += result.dropped;
        if (result.logs.length) appendLogs(result.logs);
      }
      quietReads = TERMINAL_STATES.has(status) && result.logs.length === 0 ? quietReads + 1 : 0;
      return result;
    }).catch(reason => {
      if (current()) { error = plainText(reason?.message || reason || "Unknown error"); quietReads = 0; }
      return null;
    }).finally(() => {
      if (request === pending) request = null;
      if (disposed) return;
      publish();
      if (eligible() && (urgent || pending.epoch !== epoch)) void read();
      else schedule();
    });
    publish(); return pending.promise;
  }
  function refresh() { if (disposed) return Promise.resolve(null); quietReads = 0; return read(); }
  async function copyAll() {
    if (!eligible() || cursor === 0 || copyRequest) return;
    const pending = { epoch, controller: new AbortController() };
    copyRequest = pending; copyMessage = ""; copyFailed = false; publish();
    const current = () => !disposed && visible && pending.epoch === epoch && copyRequest === pending;
    try {
      if (typeof clipboard?.writeText !== "function") throw new Error("Clipboard is unavailable");
      // Read the complete retained backend snapshot, not the smaller display
      // buffer. Copy does not advance the viewer cursor or alter local Clear.
      const result = await api(`/api/processes/${encodeURIComponent(process.id)}/logs?after=0`, { signal: pending.controller.signal, dedupe: false, cache: "no-store" });
      if (!current()) return;
      const snapshot = formatProcessLogSnapshot(result);
      if (!snapshot.count) { copyMessage = snapshot.message; return; }
      await clipboard.writeText(snapshot.text);
      if (current()) copyMessage = snapshot.message;
    } catch {
      if (current()) { copyFailed = true; copyMessage = "Could not copy logs. Click Copy all to try again."; }
    } finally {
      if (copyRequest === pending) { copyRequest = null; publish(); }
    }
  }
  function cancelCopy() {
    copyRequest?.controller.abort(); copyRequest = null; copyMessage = ""; copyFailed = false;
  }
  function clear() {
    if (disposed) return;
    clearSerial++; entries = []; characters = 0; discarded = false; dropped = 0; cleared = true;
    output.replaceChildren(); publish();
  }
  function reset() {
    cursor = 0; status = process?.status || ""; error = ""; entries = []; characters = 0;
    discarded = false; dropped = 0; following = true; cleared = false; quietReads = 0;
    output.replaceChildren(); output.scrollTop = 0; output.scrollLeft = 0;
  }
  publish();
  return {
    get state() { return snapshot(); },
    setContext(next = {}) {
      if (disposed) return;
      const previousKey = `${repository?.id || ""}\0${configuration?.id || ""}\0${process?.id || ""}`;
      const previousStatus = process?.status, previousVisible = visible;
      if (Object.hasOwn(next, "repository")) repository = next.repository || null;
      if (Object.hasOwn(next, "configuration")) configuration = next.configuration || null;
      if (configuration && configuration.repositoryId !== repository?.id) configuration = null;
      if (Object.hasOwn(next, "process")) process = next.process || null;
      if (process && (!repository?.id || process.repositoryId !== repository.id
          || ![configuration?.id, `repository:${repository.id}`].includes(process.configurationId))) process = null;
      if (Object.hasOwn(next, "visible")) visible = Boolean(next.visible);
      const key = `${repository?.id || ""}\0${configuration?.id || ""}\0${process?.id || ""}`;
      const changed = key !== previousKey;
      if (changed || visible !== previousVisible) {
        epoch++; stopTimer(); request?.controller.abort(); cancelCopy(); urgent = eligible(); quietReads = 0;
        if (changed) reset();
      }
      const finished = !changed && previousStatus !== process?.status && TERMINAL_STATES.has(process?.status);
      if (!changed && process?.status && (!TERMINAL_STATES.has(status) || TERMINAL_STATES.has(process.status))) status = process.status;
      if (finished) { quietReads = 0; urgent = true; }
      publish();
      if (eligible() && (changed || !previousVisible || finished)) void read();
    },
    refresh, clear,
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; stopTimer(); request?.controller.abort(); cancelCopy();
      for (const remove of listeners) remove(); root.remove(); entries = []; characters = 0;
    },
  };
}
