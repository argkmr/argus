// A real local PTY owns editing, prompts, history, completion and job control.
// The browser only renders its byte stream and forwards raw user input.
const terminalLoads = new WeakMap();
const ASSET_ROOT = "/legacy/vendor/xterm";

export function* terminalInputChunks(input) {
  const limit = 64_000;
  for (let start = 0; start < input.length;) {
    let end = Math.min(input.length, start + limit);
    // Java and JavaScript both count UTF-16 units. Never cut an astral code point
    // between its surrogate halves while observing the backend request limit.
    if (end < input.length && /[\uD800-\uDBFF]/.test(input[end - 1]) && /[\uDC00-\uDFFF]/.test(input[end])) end--;
    yield input.slice(start, end); start = end;
  }
}

export function loadTerminalAssets(document) {
  if (!terminalLoads.has(document)) {
    const promise = (async () => {
      const win = document.defaultView;
      async function asset(tag, url) {
        await new Promise((resolve, reject) => {
          const element = document.createElement(tag);
          const timer = win.setTimeout(() => finish(new Error("The local terminal renderer took too long to load.")), 15_000);
          function finish(error) {
            win.clearTimeout(timer); element.onload = null; element.onerror = null;
            if (error) { element.remove(); reject(error); } else resolve();
          }
          element.onload = () => finish();
          element.onerror = () => finish(new Error("The local terminal renderer could not be loaded. Restart Argus and try again."));
          if (tag === "link") { element.rel = "stylesheet"; element.href = url; }
          else element.src = url;
          document.head.append(element);
        });
      }
      await asset("link", `${ASSET_ROOT}/xterm.css`);
      // Native ESM deliberately avoids Monaco's global AMD loader.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import(`${ASSET_ROOT}/xterm.mjs`), import(`${ASSET_ROOT}/addon-fit.mjs`),
      ]);
      return { Terminal, FitAddon };
    })();
    terminalLoads.set(document, promise);
    promise.catch(() => terminalLoads.delete(document));
  }
  return terminalLoads.get(document);
}

export function createRepositoryTerminal({ document, api, getRepository, notify = () => {}, onVisibilityChange = () => {}, load = loadTerminalAssets, timers = document.defaultView }) {
  const win = document.defaultView;
  const panel = document.querySelector("#terminal-panel"), output = document.querySelector("#terminal-output");
  const title = document.querySelector("#terminal-title"), cwd = document.querySelector("#terminal-cwd");
  const status = document.querySelector("#terminal-status");
  const entries = new Map();
  let active = null, visible = false, disposed = false, viewEpoch = 0, pollTimer, resizeTimer, returnFocus;

  const path = (entry, action = "") => `/api/repositories/${encodeURIComponent(entry.repository.id)}/terminal${action}`;
  const snapshotId = (snapshot) => snapshot?.sessionId || snapshot?.id;
  const selected = (entry, epoch = viewEpoch) => !disposed && visible && active === entry && epoch === viewEpoch && getRepository()?.id === entry.repository.id;
  const enqueue = (entry, operation) => {
    const result = entry.queue.then(operation);
    entry.queue = result.catch(() => {});
    return result;
  };
  const getState = () => ({ visible, repositoryId: active?.repository.id || null });
  function visibilityChanged() { onVisibilityChange(getState()); }
  function clearTimers() { timers.clearTimeout(pollTimer); timers.clearTimeout(resizeTimer); }
  function message(text, error = false) {
    // Never feed local errors into xterm's escape-sequence interpreter.
    status.textContent = String(text || "");
    status.hidden = !text;
    status.classList.toggle("error", error);
  }
  function failure(entry, error, epoch) {
    if (!selected(entry, epoch)) return;
    const text = String(error?.message || error);
    message(text, true);
  }
  function header(entry) {
    const shell = entry.snapshot?.shell || "zsh";
    title.textContent = `${entry.repository.name || "Repository"} · ${String(shell).split("/").at(-1)}`;
    cwd.textContent = entry.snapshot?.cwd || entry.repository.path || "";
    panel.classList.toggle("running", Boolean(entry.running));
  }
  function apply(entry, snapshot, { acceptSession = false } = {}) {
    const sessionId = snapshotId(snapshot);
    if (!sessionId || snapshot.pty !== true) throw new Error("This build requires a real PTY terminal. Restart the terminal after updating Argus.");
    if (entry.sessionId !== sessionId) {
      if (!acceptSession) return false;
      entry.sessionId = sessionId; entry.cursor = 0; entry.lastSize = "";
      entry.term.reset();
    }
    entry.startedSessionId = null;
    entry.snapshot = snapshot;
    const chunks = [...(snapshot.chunks || [])].sort((a, b) => a.cursor - b.cursor);
    let changed = false;
    for (const chunk of chunks) {
      if (chunk.cursor <= entry.cursor) continue;
      entry.term.write(String(chunk.data || ""));
      entry.cursor = chunk.cursor; changed = true;
    }
    entry.cursor = Math.max(entry.cursor, Number(snapshot.cursor) || 0);
    entry.running = Boolean(snapshot.running);
    entry.term.options.disableStdin = !entry.running;
    if (selected(entry)) {
      header(entry);
      message(entry.running ? "" : "Terminal stopped. Choose Restart to open a new zsh session.");
    }
    return changed;
  }
  async function renderer(entry) {
    if (entry.term) return;
    const { Terminal, FitAddon } = await load(document);
    if (disposed) return;
    entry.term = new Terminal({
      cursorBlink: true, cursorStyle: "block", fontSize: 13, lineHeight: 1.2,
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
      scrollback: 5000, convertEol: false, screenReaderMode: true, disableStdin: true,
      allowProposedApi: false, allowTransparency: false,
      // OSC 8 output must not navigate/open URLs, nor access the clipboard.
      linkHandler: { activate() {}, hover() {}, leave() {} },
      theme: { background: "#080b0d", foreground: "#d9e0e6", cursor: "#d9e0e6", selectionBackground: "#405768", black: "#1b2026", red: "#ed7474", green: "#8ccc79", yellow: "#e0be7c", blue: "#70a8e8", magenta: "#bc94df", cyan: "#71c4cb", white: "#d9e0e6", brightBlack: "#748292", brightRed: "#ff9991", brightGreen: "#b4e799", brightYellow: "#f1dba0", brightBlue: "#9bc5ff", brightMagenta: "#d7b7f1", brightCyan: "#9edee5", brightWhite: "#ffffff" },
    });
    entry.fit = new FitAddon(); entry.term.loadAddon(entry.fit); entry.term.open(entry.host);
    entry.input = entry.term.onData((data) => { void sendInput(entry, data); });
    entry.term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault(); void clear(); return false;
      }
      if ((event.metaKey || event.ctrlKey) && event.code === "Backquote") return false;
      event.stopPropagation();
      return true;
    });
  }
  function restoreFocus() {
    const preferred = typeof returnFocus === "function" ? returnFocus() : returnFocus;
    if (typeof returnFocus === "function" && !preferred) return; // The callback may perform focus itself.
    const target = preferred?.isConnected ? preferred : document.querySelector('.repository-ide-tool-tab[data-tool="terminal"]');
    target?.focus?.({ preventScroll: true });
  }
  function schedulePoll(entry, delay = 200) {
    timers.clearTimeout(pollTimer);
    if (!selected(entry) || !entry.running || !entry.sessionId) return;
    const epoch = viewEpoch, revision = entry.revision, pollRevision = entry.pollRevision, sessionId = entry.sessionId;
    pollTimer = timers.setTimeout(async () => {
      if (!selected(entry, epoch) || revision !== entry.revision || pollRevision !== entry.pollRevision || sessionId !== entry.sessionId) return;
      if (entry.polling) { schedulePoll(entry, 75); return; }
      entry.polling = true;
      let nextDelay = 250;
      try {
        const snapshot = await api(path(entry, `?after=${entry.cursor}`), { timeout: 5_000 });
        if (!selected(entry, epoch) || revision !== entry.revision || pollRevision !== entry.pollRevision || sessionId !== entry.sessionId) return;
        nextDelay = apply(entry, snapshot) ? 75 : 250;
        if (snapshotId(snapshot) !== sessionId) {
          entry.running = false; entry.term.options.disableStdin = true; header(entry);
          message("This terminal session changed. Choose Restart to reconnect safely.", true);
        }
      } catch (error) { failure(entry, error, epoch); nextDelay = 1500; }
      finally { entry.polling = false; }
      if (selected(entry, epoch) && revision === entry.revision && pollRevision === entry.pollRevision) schedulePoll(entry, nextDelay);
    }, delay);
  }
  async function fit(entry) {
    if (!selected(entry) || !entry.term || !entry.sessionId || !entry.running) return;
    entry.fit.fit();
    const cols = entry.term.cols, rows = entry.term.rows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) return;
    const size = `${cols}:${rows}`, sessionId = entry.sessionId, revision = entry.revision, epoch = viewEpoch;
    if (size === entry.lastSize) return;
    entry.lastSize = size;
    await enqueue(entry, async () => {
      if (!selected(entry, epoch) || revision !== entry.revision || sessionId !== entry.sessionId) { entry.lastSize = ""; return; }
      try { await api(path(entry, "/resize"), { method: "POST", body: { sessionId, cols, rows }, timeout: 5_000 }); }
      catch (error) { entry.lastSize = ""; failure(entry, error, epoch); }
    });
  }
  function scheduleFit() {
    timers.clearTimeout(resizeTimer);
    const entry = active;
    if (!visible || !entry || disposed) return;
    resizeTimer = timers.setTimeout(() => { if (entry) void fit(entry); }, 60);
  }
  const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(scheduleFit) : null;
  observer?.observe(output);
  win.addEventListener("resize", scheduleFit);
  async function sendInput(entry, input) {
    if (!input || !selected(entry) || !entry.running || !entry.sessionId) return;
    const sessionId = entry.sessionId, revision = entry.revision, epoch = viewEpoch;
    await enqueue(entry, async () => {
      if (!selected(entry, epoch) || revision !== entry.revision || sessionId !== entry.sessionId || !entry.running) return;
      try {
        // No newline insertion, frontend echo, interpolation, or synthetic commands.
        for (const chunk of terminalInputChunks(input)) {
          if (!selected(entry, epoch) || revision !== entry.revision || sessionId !== entry.sessionId || !entry.running) return;
          await api(path(entry, "/input"), { method: "POST", body: { sessionId, input: chunk }, timeout: 5_000 });
          if (selected(entry, epoch)) schedulePoll(entry, 0);
        }
      } catch (error) {
        if (!selected(entry, epoch) || revision !== entry.revision) return;
        // Do not retry an uncertain write or send the rest of a half-delivered
        // command. Reopening can inspect the existing PTY without restarting it.
        ++entry.revision; clearTimers(); entry.running = false; entry.term.options.disableStdin = true; header(entry);
        failure(entry, new Error(`${error.message || error} Terminal input paused. Minimize and reopen to reconnect; no input was retried.`), epoch);
      }
    });
  }
  // The IDE supplies the repository it owns. A click queued just before a
  // repository switch must not accidentally start a shell in the next repo.
  async function open({ repositoryId, returnFocus: focusTarget } = {}) {
    const repository = getRepository();
    if (repositoryId && repository?.id !== repositoryId) return;
    if (!repository) { notify("Open a repository before starting Terminal", "error"); return; }
    if (disposed) return;
    if (!visible) returnFocus = focusTarget || document.activeElement;
    clearTimers(); visible = true; const epoch = ++viewEpoch;
    let entry = entries.get(repository.id);
    if (!entry) {
      const host = document.createElement("div"); host.className = "repository-terminal-screen";
      entry = { repository: { ...repository }, host, queue: Promise.resolve(), revision: 0, pollRevision: 0, cursor: 0, sessionId: null, running: false, lastSize: "" };
      entries.set(repository.id, entry); output.append(host);
    }
    active = entry; entry.repository = { ...repository };
    for (const candidate of entries.values()) candidate.host.hidden = candidate !== entry;
    panel.classList.remove("hidden"); header(entry); message("Opening zsh…");
    visibilityChanged();
    const revision = entry.revision;
    try {
      await enqueue(entry, async () => {
        await renderer(entry);
        if (!selected(entry, epoch) || revision !== entry.revision) return;
        let snapshot;
        try {
          snapshot = await api(path(entry, `?after=${entry.cursor}`), { timeout: 5_000 });
          entry.startedSessionId = snapshotId(snapshot);
        }
        catch (error) { if (!String(error.message).includes("Start the terminal first")) throw error; }
        if (!selected(entry, epoch) || revision !== entry.revision) return;
        if (!snapshot?.running) {
          snapshot = await api(path(entry, "/start"), { method: "POST", timeout: 15_000 });
          entry.startedSessionId = snapshotId(snapshot);
        }
        if (!selected(entry, epoch) || revision !== entry.revision) return;
        // A new backend session needs its full transcript, not the old cursor.
        if (entry.sessionId && snapshotId(snapshot) !== entry.sessionId) snapshot = await api(path(entry), { timeout: 5_000 });
        if (!selected(entry, epoch) || revision !== entry.revision) return;
        apply(entry, snapshot, { acceptSession: true });
      });
      if (!selected(entry, epoch) || revision !== entry.revision) return;
      await fit(entry); schedulePoll(entry); entry.term.focus();
    } catch (error) { failure(entry, error, epoch); }
  }
  function minimize({ restoreFocus: shouldRestoreFocus = true } = {}) {
    if (!visible) return;
    clearTimers(); visible = false; ++viewEpoch; panel.classList.add("hidden");
    visibilityChanged();
    if (shouldRestoreFocus) restoreFocus();
  }
  // Reparent the existing renderer instead of recreating a PTY or transcript.
  // Mounting a closed dock remains entirely lazy; only open() starts a shell.
  function mount(host) {
    if (disposed || !host || typeof host.append !== "function") return false;
    if (panel.parentElement !== host) host.append(panel);
    scheduleFit();
    return true;
  }
  async function close() {
    const entry = active;
    if (!entry) { minimize(); return; }
    ++entry.revision; minimize(); active = null;
    await enqueue(entry, async () => {
      // A close always targets the captured PTY, never a newer/reselected session.
      // An in-flight start may finish before this serialized close gets its turn.
      const sessionId = entry.startedSessionId || entry.sessionId;
      if (sessionId) {
        try { await api(path(entry, "/stop"), { method: "POST", body: { sessionId }, timeout: 10_000 }); }
        catch (error) { notify(String(error.message || error), "error"); return; }
      }
      if (!entry.sessionId || entry.sessionId === sessionId || entry.startedSessionId === sessionId) {
        entry.sessionId = null; entry.running = false; entry.cursor = 0; entry.lastSize = "";
        entry.startedSessionId = null;
        entry.term?.reset(); if (entry.term) entry.term.options.disableStdin = true;
      }
    });
  }
  async function clear() {
    const entry = active;
    if (!entry || !selected(entry) || !entry.sessionId) return;
    const sessionId = entry.sessionId, epoch = viewEpoch, revision = entry.revision;
    ++entry.pollRevision;
    clearTimers();
    await enqueue(entry, async () => {
      if (!selected(entry, epoch) || revision !== entry.revision || sessionId !== entry.sessionId) return;
      try {
        const snapshot = await api(path(entry, "/clear"), { method: "POST", body: { sessionId }, timeout: 5_000 });
        if (!selected(entry, epoch) || revision !== entry.revision || sessionId !== entry.sessionId) return;
        entry.term.clear(); apply(entry, snapshot); entry.term.focus();
      } catch (error) { failure(entry, error, epoch); }
    });
    if (selected(entry, epoch) && revision === entry.revision) schedulePoll(entry, 0);
  }
  async function restart() {
    const entry = active;
    if (!entry || !visible) return open();
    const sessionId = entry.sessionId, epoch = viewEpoch, revision = ++entry.revision;
    clearTimers(); entry.running = false; if (entry.term) entry.term.options.disableStdin = true;
    header(entry); message("Restarting zsh…");
    await enqueue(entry, async () => {
      if (!selected(entry, epoch) || revision !== entry.revision) return;
      try {
        await renderer(entry);
        if (!selected(entry, epoch) || revision !== entry.revision) return;
        if (sessionId) await api(path(entry, "/stop"), { method: "POST", body: { sessionId }, timeout: 10_000 });
        if (!selected(entry, epoch) || revision !== entry.revision) return;
        const snapshot = await api(path(entry, "/start"), { method: "POST", timeout: 15_000 });
        entry.startedSessionId = snapshotId(snapshot);
        if (!selected(entry, epoch) || revision !== entry.revision) return;
        apply(entry, snapshot, { acceptSession: true });
      } catch (error) { failure(entry, error, epoch); }
    });
    if (selected(entry, epoch) && revision === entry.revision) { await fit(entry); schedulePoll(entry); entry.term?.focus(); }
  }
  function dispose() {
    disposed = true; visible = false; ++viewEpoch; clearTimers(); observer?.disconnect(); win.removeEventListener("resize", scheduleFit);
    for (const entry of entries.values()) { ++entry.revision; entry.input?.dispose(); entry.term?.dispose(); entry.host.remove(); }
    entries.clear();
    active = null; panel.classList.add("hidden"); visibilityChanged();
  }
  return { open, minimize, close, clear, restart, mount, getState, dispose };
}
