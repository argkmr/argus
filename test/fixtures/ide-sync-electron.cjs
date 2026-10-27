// Production IDE + Services controller with synthetic transport only. No project
// command, package manager, provider or user's Argus profile is contacted.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-ide-sync-")) throw new Error("An isolated test directory is required.");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, server, complete = false, backendRequests = 0;
const timer = setTimeout(() => finish(new Error("IDE dependency sync fixture timed out")), 60_000);
async function finish(error, result) {
  if (complete) return; complete = true; clearTimeout(timer);
  if (error) console.error(error.stack || error);
  else console.log(`IDE_SYNC_RENDERER_RESULT=${JSON.stringify(result)}`);
  if (window && !window.isDestroyed()) window.destroy();
  server?.closeAllConnections(); server?.close(); app.exit(error ? 1 : 0);
}
const page = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Isolated project sync QA</title>
<link rel="stylesheet" href="/legacy/styles.css"><link rel="stylesheet" href="/legacy/repository-ide.css">
<style>body{display:flex;flex-direction:column;font:13px/1.4 system-ui,sans-serif}.fixture-label{flex:none;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line);color:var(--muted)}#ide{flex:1;min-height:0}</style>
</head><body class="repository-ide-enabled" data-view="repository"><header class="fixture-label">ISOLATED QA · Production IDE and terminal renderers · Synthetic transport only <span id="services"></span></header><main id="ide"></main>
<section id="terminal-panel" class="terminal-panel hidden" aria-label="Repository terminal"><div id="terminal-resizer" class="terminal-resizer"></div><header><div><span class="terminal-status-dot"></span><strong id="terminal-title">Terminal</strong><small id="terminal-cwd">Synthetic repository</small></div><nav><button type="button">Synthetic session</button></nav></header><div id="terminal-output" aria-label="Interactive zsh terminal"></div><p id="terminal-status" role="status" hidden></p></section></body></html>`;

async function initializeRenderer() {
  const { createRepositoryIde } = await import("/legacy/repository-ide.mjs");
  const { createIdeRunControls } = await import("/legacy/ide-run-controls.mjs");
  const { createRepositoryTerminal, loadTerminalAssets } = await import("/legacy/repository-terminal.mjs");
  const repository = { id: "synthetic-reviews", name: "Review service", path: "/synthetic/reviews" };
  const configuration = { id: "synthetic-review-api", name: "Review API", repositoryId: repository.id };
  const sourcePath = "pom.xml", source = "<project>\n  <artifactId>synthetic-reviews</artifactId>\n</project>\n";
  const errors = [], calls = [], accepted = [], operations = new Map(), processOutput = new Map(), terminalRenderers = [];
  let processes = [], ide, controls, terminal, sequence = 0, diskContent = source, diskRevision = 1, diskMissing = false, terminalSession = null, debugSession = null;
  const copy = value => structuredClone(value);
  const log = (line, stream = "stdout") => ({ timestamp: "2026-09-19T10:42:00Z", stream, line });
  const updateServices = () => { document.querySelector("#services").textContent = `· Services: ${processes[0]?.status || "stopped"}`; };
  const api = async (raw, options = {}) => {
    const url = new URL(raw, location.origin), method = options.method || "GET", body = options.body;
    calls.push({ path: url.pathname, query: url.search, method, body: copy(body) });
    if (url.pathname === "/api/processes" && method === "GET") return copy(processes);
    const logs = /^\/api\/processes\/([^/]+)\/logs$/.exec(url.pathname);
    if (logs && method === "GET") {
      const id = decodeURIComponent(logs[1]), current = processes.find(process => process.id === id), output = processOutput.get(id) || [];
      if (!current) throw new Error(`Unknown synthetic process: ${id}`);
      return { cursor: output.length, logs: copy(output.slice(Number(url.searchParams.get("after")) || 0)), status: current.status, dropped: 0 };
    }
    if (url.pathname.includes("/terminal")) {
      if (url.pathname.endsWith("/start") && method === "POST") {
        if (terminalSession) throw new Error("Synthetic shell must be reused rather than restarted");
        terminalSession = { id: "synthetic-pty-retained", pty: true, shell: "/bin/zsh", cwd: repository.path, running: true, cursor: 1,
          chunks: [{ cursor: 1, data: "review-service git:(main) $ echo retained session\r\nretained session\r\nreview-service git:(main) $ " }] };
      }
      if (!terminalSession) throw new Error("Start the terminal first");
      if (method !== "GET" && !url.pathname.endsWith("/start") && !url.pathname.endsWith("/resize")) throw new Error("The renderer fixture must not stop, clear, or send input to the synthetic shell");
      return { ...copy(terminalSession), chunks: copy(terminalSession.chunks.filter(chunk => chunk.cursor > (Number(url.searchParams.get("after")) || 0))) };
    }
    if (url.pathname.endsWith("/debug/status")) return { adapters: [], targets: [], session: copy(debugSession) };
    if (url.pathname.endsWith("/debug/events")) return { cursor: 1, session: copy(debugSession), events: Number(url.searchParams.get("after")) ? [] : [{ event: "output", body: { category: "console", output: "Synthetic debugger session retained across tool tabs.\n" } }] };
    if (url.pathname.endsWith("/debug/command")) {
      if (body.command === "pause") { debugSession.state = "stopped"; debugSession.threadId = 1; return {}; }
      if (body.command === "threads") return { threads: [{ id: 1, name: "main" }] };
      if (body.command === "stackTrace") return { stackFrames: [{ id: 7, name: "ReviewService.fetchReviews", source: { path: sourcePath }, line: 2, column: 3 }] };
      if (body.command === "scopes") return { scopes: [{ name: "Local", variablesReference: 10, expensive: false }] };
      if (body.command === "variables") return { variables: [{ name: "customerId", value: '"fixture-customer"', variablesReference: 0 }, { name: "reviews", value: "12", variablesReference: 0 }] };
      return {};
    }
    if (url.pathname.endsWith("/project-structure/maintenance") && method === "POST") {
      if (body.action !== "sync") throw new Error("Only synthetic Sync is supported");
      const process = { id: `synthetic-process-${++sequence}`, repositoryId: repository.id, configurationId: body.configurationId || `repository:${repository.id}`, startedAt: new Date().toISOString(), status: "syncing", running: true, task: "sync" };
      processes.unshift(process); processOutput.set(process.id, [log("Resolving project dependencies", "system"), log("BUILD SUCCESSFUL"), log("Synthetic dependency warning", "stderr")]); updateServices(); return copy(process);
    }
    if (url.pathname.endsWith("/stop") && method === "POST") {
      const configurationId = url.pathname.includes("/maintenance/") ? `repository:${repository.id}` : configuration.id;
      for (const process of processes) if (process.configurationId === configurationId) { process.status = "stopped"; process.running = false; }
      updateServices(); return { ok: true };
    }
    if (url.pathname.endsWith("/status")) return { languages: [] };
    if (url.pathname.endsWith("/tree")) return { path: "", entries: diskMissing ? [] : [{ name: sourcePath, path: sourcePath, directory: false }] };
    if (url.pathname.endsWith("/file") && method === "GET") {
      if (diskMissing) throw Object.assign(new Error("Synthetic file no longer exists"), { status: 404 });
      return { path: sourcePath, content: diskContent, contentHash: `synthetic-only-${diskRevision}`, language: "xml" };
    }
    if (url.pathname.endsWith("/code-discussions")) return { discussions: [] };
    if (url.pathname.endsWith("/session") && method === "DELETE") return { ok: true };
    throw new Error(`Unexpected synthetic request: ${method} ${raw}`);
  };
  controls = createIdeRunControls({ api, operations, onChange: () => ide?.syncRunState(), onProcesses: updateServices,
    beforeStart: () => !ide.isDirty(repository.id), onStarted: (process, context) => { accepted.push({ process: copy(process), mode: context.mode }); ide.showRunLogs(); }, onError: error => errors.push(error.message) });
  controls.setContext({ repository, configurations: [configuration], processes });
  terminal = createRepositoryTerminal({ document, api, getRepository: () => repository, notify: message => errors.push(message), onVisibilityChange: state => ide?.syncTerminalState(state),
    load: async document => { const { Terminal, FitAddon } = await loadTerminalAssets(document); return { FitAddon, Terminal: class extends Terminal { constructor(options) { super(options); terminalRenderers.push(this); } } }; } });
  ide = createRepositoryIde({ host: document.querySelector("#ide"), api, getRunState: () => controls.state,
    onRunAction: mode => controls.run(mode), onRunSelect: id => controls.select(id), onRunConfigure: () => {}, onError: error => errors.push(error.message),
    onTerminalMount: host => terminal.mount(host || document.body), onTerminalToggle: options => terminal.getState().visible ? terminal.minimize() : terminal.open(options),
    onTerminalHide: () => terminal.minimize({ restoreFocus: false }) });
  await ide.activate(repository); await ide.openFile(sourcePath, 2, 3, { focus: false });
  const fixture = window.syncFixture = { ide, controls, terminal, terminalRenderers, errors, calls, accepted, repository, configuration, source };
  fixture.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  fixture.wait = async predicate => { const end = performance.now() + 5_000; while (!predicate()) { if (performance.now() > end) throw new Error(`Sync fixture wait timed out: ${errors.join("; ")}`); await new Promise(resolve => setTimeout(resolve, 20)); } await fixture.settle(); };
  fixture.button = name => document.querySelector(`.repository-ide-run-${name}-action`);
  fixture.editor = () => document.querySelector(".repository-ide-editor-frame").contentWindow.monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === "argus");
  fixture.useNoConfiguration = () => { processes = []; updateServices(); controls.setContext({ configurations: [], processes }); };
  fixture.completeSync = async () => { for (const process of processes) { process.status = "completed"; process.running = false; } updateServices(); await controls.refresh(); };
  fixture.changeDisk = content => { diskContent = content; diskMissing = content === null; diskRevision++; };
  fixture.prepareDock = () => {
    const worker = { id: "synthetic-worker", name: "Worker", repositoryId: repository.id };
    processes = [{ id: "synthetic-live-service", name: configuration.name, repositoryId: repository.id, configurationId: configuration.id, status: "running", startedAt: "2026-09-19T10:41:00Z" },
      { id: "synthetic-worker-process", name: worker.name, repositoryId: repository.id, configurationId: worker.id, status: "running", startedAt: "2026-09-19T10:42:00Z" }];
    processOutput.set(processes[0].id, [log("Compiling ReviewService.java", "system"), ...Array.from({ length: 60 }, (_, i) => log(`GET /reviews/${i} 200 · ${i + 3}ms`)), log("Retrying synthetic upstream", "stderr")]);
    processOutput.set(processes[1].id, [log("WORKER ONLY · must follow selected configuration")]);
    debugSession = { id: "synthetic-debug-retained", processId: processes[0].id, adapterId: "java-jdi", port: 5005, state: "attached", threadId: 1 };
    controls.setContext({ configurations: [configuration, worker], processes }); controls.select(configuration.id); updateServices(); ide.showRunLogs();
  };
  fixture.appendOutput = (line, stream = "stdout") => { const current = controls.state.latestProcess; processOutput.get(current.id).push(log(line, stream)); };
  fixture.exitCurrent = () => { const current = processes.find(process => process.id === controls.state.latestProcess.id); current.status = "failed"; current.exitCode = 1; fixture.appendOutput("FINAL STDERR · synthetic service exited", "stderr"); controls.setContext({ processes: copy(processes) }); updateServices(); };
  fixture.dock = () => {
    const root = document.querySelector(".repository-ide-tool-dock"), editor = document.querySelector(".repository-ide-editor-wrap"), output = document.querySelector(".repository-ide-process-logs-output");
    const shown = selector => !!document.querySelector(selector)?.getClientRects().length;
    return { open: root.dataset.open, maximized: root.dataset.maximized, height: root.getBoundingClientRect().height, editorHeight: editor.getBoundingClientRect().height,
      visible: [["terminal", ".repository-ide-terminal-slot"], ["logs", ".repository-ide-run-logs"], ["debug", ".repository-ide-debug"]].filter(([, selector]) => shown(selector)).map(([name]) => name),
      dockCount: document.querySelectorAll(".repository-ide-tool-dock").length, debugCount: document.querySelectorAll(".repository-ide-debug").length,
      processId: controls.state.latestProcess?.id, identity: document.querySelector(".repository-ide-process-logs-identity").textContent,
      output: output.textContent, stderr: [...output.querySelectorAll('[data-stream="stderr"]')].map(row => row.textContent), scrollTop: output.scrollTop,
      terminalSessionId: terminalSession?.id, terminalRunning: terminalSession?.running, terminalRenderers: terminalRenderers.length, debugSessionId: debugSession?.id,
      terminalTranscript: terminalRenderers[0] ? Array.from({ length: terminalRenderers[0].buffer.active.length }, (_, i) => terminalRenderers[0].buffer.active.getLine(i)?.translateToString(true)).join("\n") : "" };
  };
  fixture.measure = () => {
    const sync = fixture.button("sync"), button = sync.getBoundingClientRect(), toolbar = document.querySelector(".repository-ide-toolbar").getBoundingClientRect();
    const runtime = document.querySelector(".repository-ide-runtime").getBoundingClientRect();
    return { button: { left: button.left, right: button.right, top: button.top, bottom: button.bottom, width: button.width, height: button.height }, toolbar: { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom }, runtime: { left: runtime.left, right: runtime.right }, opacity: getComputedStyle(sync).opacity, color: getComputedStyle(sync).color, background: getComputedStyle(document.querySelector(".repository-ide")).backgroundColor };
  };
  updateServices(); await fixture.settle();
  return { sandboxed: typeof process === "undefined" && typeof require === "undefined", errors };
}

app.whenReady().then(async () => {
  const { createPreviewServer } = await import(pathToFileURL(path.join(__dirname, "ide-ux-preview.mjs")).href);
  server = createPreviewServer(); const serveAssets = server.listeners("request")[0]; server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url.startsWith("/api/")) backendRequests++;
    if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; frame-src 'self' about:; connect-src 'self'; object-src 'none'" }); response.end(page); return; }
    void serveAssets(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, isolated = session.fromPartition("isolated-ide-sync", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }));
  window = new BrowserWindow({ show: false, width: 1320, height: 800, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.setContentSize(1320, 800); window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(origin);
  const initialized = await window.webContents.executeJavaScript(`(${initializeRenderer.toString()})()`);
  assert.equal(initialized.sandboxed, true); assert.deepEqual(initialized.errors, []);
  const evaluate = source => window.webContents.executeJavaScript(`(async () => { ${source} })()`);
  const before = await evaluate("return { disabled: syncFixture.button('sync').disabled, label: syncFixture.button('sync').getAttribute('aria-label'), posts: syncFixture.calls.filter(call => call.method === 'POST') }; ");
  assert.equal(before.disabled, false); assert.equal(before.label, "Sync project dependencies"); assert.deepEqual(before.posts, []);
  await evaluate("syncFixture.button('sync').click(); await syncFixture.wait(() => syncFixture.controls.state.currentProcess?.status === 'syncing' && syncFixture.accepted.length === 1); ");
  const busy = await evaluate("return { disabled: syncFixture.button('sync').disabled, busy: syncFixture.button('sync').getAttribute('aria-busy'), stop: syncFixture.button('stop').disabled, services: document.querySelector('#services').textContent, posts: syncFixture.calls.filter(call => call.method === 'POST'), accepted: syncFixture.accepted, measure: syncFixture.measure() }; ");
  assert.equal(busy.disabled, true); assert.equal(busy.busy, "true"); assert.equal(busy.stop, false); assert.match(busy.services, /Services: syncing/); assert.equal(busy.measure.opacity, "1");
  assert.deepEqual(busy.posts.map(call => call.body), [{ action: "sync", configurationId: "synthetic-review-api" }]); assert.equal(busy.accepted[0].mode, "sync");
  const screenshots = [];
  for (const [theme, width] of [["dark", 1320], ["light", 1320], ["dark", 600]]) {
    window.setContentSize(width, 800);
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; await syncFixture.settle();`);
    const measure = await evaluate("return syncFixture.measure();");
    assert.ok(measure.button.width >= 28 && measure.button.height >= 28, "Sync has a usable icon hit target");
    assert.ok(measure.button.left >= measure.toolbar.left && measure.button.right <= measure.toolbar.right + 1 && measure.button.top >= measure.toolbar.top && measure.button.bottom <= measure.toolbar.bottom + 1, `Sync fits the ${theme} ${width}px toolbar`);
    if (process.env.ARGUS_IDE_SYNC_CAPTURE === "1") { const file = path.join(temporary, `ide-sync-${theme}-${width}.png`); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots.push(file); }
  }
  await evaluate("syncFixture.button('stop').click(); await syncFixture.wait(() => syncFixture.controls.state.label === 'Stopped' && !syncFixture.button('sync').disabled); syncFixture.useNoConfiguration(); await syncFixture.settle(); syncFixture.button('sync').click(); await syncFixture.wait(() => syncFixture.accepted.length === 2); ");
  const synthetic = await evaluate("return { process: syncFixture.controls.state.currentProcess, post: syncFixture.calls.filter(call => call.method === 'POST').at(-1), canRun: syncFixture.controls.state.canRun, stop: syncFixture.button('stop').disabled }; ");
  assert.equal(synthetic.process.configurationId, "repository:synthetic-reviews"); assert.deepEqual(synthetic.post.body, { action: "sync" }); assert.equal(synthetic.canRun, false); assert.equal(synthetic.stop, false);
  await evaluate("syncFixture.button('stop').click(); await syncFixture.wait(() => !syncFixture.controls.state.currentProcess); ");
  assert.match(await evaluate("return syncFixture.calls.filter(call => call.method === 'POST').at(-1).path;"), /project-structure\/maintenance\/stop$/);
  await evaluate("syncFixture.editor().setValue(syncFixture.source + '<!-- unsaved dependency edit -->'); await syncFixture.wait(() => syncFixture.ide.isDirty()); ");
  const dirty = await evaluate("const previous = syncFixture.calls.filter(call => call.method === 'POST').length; syncFixture.button('sync').click(); await syncFixture.settle(); return { disabled: syncFixture.button('sync').disabled, title: syncFixture.button('sync').title, unchangedPosts: previous === syncFixture.calls.filter(call => call.method === 'POST').length, writes: syncFixture.calls.filter(call => call.method === 'PUT'), errors: syncFixture.errors }; ");
  assert.equal(dirty.disabled, true); assert.match(dirty.title, /Save all modified files/); assert.equal(dirty.unchangedPosts, true); assert.deepEqual(dirty.writes, []); assert.deepEqual(dirty.errors, []);
  await evaluate("syncFixture.editor().setValue(syncFixture.source); await syncFixture.wait(() => !syncFixture.ide.isDirty()); syncFixture.button('sync').click(); await syncFixture.wait(() => syncFixture.accepted.length === 3); await syncFixture.completeSync(); ");
  assert.equal(await evaluate("return syncFixture.button('sync').disabled;"), false, "completed Services sync re-enables IDE sync");
  window.setContentSize(1320, 800);
  await evaluate("document.documentElement.dataset.theme = 'dark'; syncFixture.prepareDock(); await syncFixture.wait(() => document.querySelector('.repository-ide-process-logs-output').textContent.includes('Retrying synthetic upstream')); window.retainedFixtureModel = syncFixture.editor().getModel(); ");
  const captureDock = async name => {
    if (process.env.ARGUS_IDE_SYNC_CAPTURE !== "1") return;
    const file = path.join(temporary, `ide-tool-dock-${name}.png`); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots.push(file);
  };
  const initialDock = await evaluate("return syncFixture.dock();");
  assert.deepEqual(initialDock.visible, ["logs"]); assert.equal(initialDock.dockCount, 1); assert.equal(initialDock.debugCount, 1);
  assert.equal(initialDock.processId, "synthetic-live-service"); assert.match(initialDock.identity, /synthetic-live-service/); assert.doesNotMatch(initialDock.output, /WORKER ONLY/);
  assert.ok(initialDock.editorHeight >= 120); assert.match(initialDock.stderr.join("\n"), /Retrying synthetic upstream/);
  await evaluate("syncFixture.appendOutput('LIVE STDOUT · request completed'); syncFixture.appendOutput('LIVE STDERR · upstream retry', 'stderr'); await syncFixture.wait(() => document.querySelector('.repository-ide-process-logs-output').textContent.includes('LIVE STDERR')); ");
  const streamed = await evaluate("return syncFixture.dock();");
  assert.match(streamed.output, /LIVE STDOUT/); assert.match(streamed.stderr.join("\n"), /LIVE STDERR/);
  await captureDock("logs-dark-1320");
  const scroll = await evaluate("const output = document.querySelector('.repository-ide-process-logs-output'); output.scrollTop = 60; output.dispatchEvent(new Event('scroll')); const top = output.scrollTop; syncFixture.appendOutput('SCROLL PRESERVED · new output'); await syncFixture.wait(() => output.textContent.includes('SCROLL PRESERVED')); return { before: top, after: output.scrollTop }; ");
  assert.ok(Math.abs(scroll.before - scroll.after) < 1, "live output leaves older reading position unchanged");
  await evaluate("const select = document.querySelector('.repository-ide-run-select'); select.value = 'synthetic-worker'; select.dispatchEvent(new Event('change')); await syncFixture.wait(() => document.querySelector('.repository-ide-process-logs-output').textContent.includes('WORKER ONLY')); ");
  const workerDock = await evaluate("return syncFixture.dock();");
  assert.equal(workerDock.processId, "synthetic-worker-process"); assert.match(workerDock.identity, /synthetic-worker-process/); assert.doesNotMatch(workerDock.output, /LIVE STDOUT|Retrying synthetic upstream/);
  await evaluate("const select = document.querySelector('.repository-ide-run-select'); select.value = syncFixture.configuration.id; select.dispatchEvent(new Event('change')); await syncFixture.wait(() => document.querySelector('.repository-ide-process-logs-output').textContent.includes('LIVE STDOUT')); document.querySelector('.repository-ide-tool-tab[data-tool=terminal]').click(); await syncFixture.wait(() => syncFixture.terminal.getState().visible && syncFixture.dock().terminalTranscript.includes('retained session')); ");
  const terminalDock = await evaluate("return syncFixture.dock();");
  assert.deepEqual(terminalDock.visible, ["terminal"]); assert.equal(terminalDock.terminalSessionId, "synthetic-pty-retained"); assert.equal(terminalDock.terminalRenderers, 1); assert.equal(terminalDock.terminalRunning, true);
  await captureDock("terminal-dark-1320");
  await evaluate("document.querySelector('.repository-ide-tool-tab[data-tool=logs]').click(); await syncFixture.settle(); document.querySelector('.repository-ide-tool-tab[data-tool=debug]').click(); await syncFixture.wait(() => document.querySelector('.repository-ide-debug').dataset.state === 'attached'); ");
  const debugDock = await evaluate("return { ...syncFixture.dock(), terminalVisible: syncFixture.terminal.getState().visible }; ");
  assert.deepEqual(debugDock.visible, ["debug"]); assert.equal(debugDock.debugSessionId, "synthetic-debug-retained"); assert.equal(debugDock.terminalVisible, false); assert.equal(debugDock.terminalRunning, true);
  assert.equal(debugDock.dockCount, 1); assert.equal(debugDock.debugCount, 1, "Debugger replaces the active tool rather than stacking another panel");
  await evaluate("document.querySelector('.repository-ide-debug-transport [aria-label=Pause]').click(); await syncFixture.wait(() => document.querySelector('.repository-ide-debug-variables').textContent.includes('fixture-customer')); ");
  await captureDock("debugger-dark-1320");
  const pausedHeight = await evaluate("return syncFixture.dock().height;");
  await evaluate("document.querySelector('[aria-label=\"Maximize tool panel\"]').click(); await syncFixture.settle(); ");
  const maximized = await evaluate("return syncFixture.dock();");
  assert.equal(maximized.maximized, "true"); assert.equal(maximized.editorHeight, 0); assert.ok(maximized.height > pausedHeight + 100); assert.deepEqual(maximized.visible, ["debug"]);
  await evaluate("document.querySelector('[aria-label=\"Restore code and tool panel\"]').click(); await syncFixture.settle(); ");
  const restored = await evaluate("return { ...syncFixture.dock(), sameModel: syncFixture.editor().getModel() === retainedFixtureModel }; ");
  assert.equal(restored.maximized, "false"); assert.ok(Math.abs(restored.height - pausedHeight) < 2); assert.equal(restored.sameModel, true); assert.ok(restored.editorHeight > 120);
  const resized = await evaluate("const before = syncFixture.dock().height; document.querySelector('.repository-ide-tool-resizer').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); await syncFixture.settle(); return { before, after: syncFixture.dock().height }; ");
  assert.ok(resized.after > resized.before + 5, "the shared splitter resizes the current tool");
  await evaluate("document.querySelector('.repository-ide-tool-tab[data-tool=terminal]').click(); await syncFixture.wait(() => syncFixture.terminal.getState().visible); ");
  const reopenedTerminal = await evaluate("return syncFixture.dock();");
  assert.equal(reopenedTerminal.terminalRenderers, 1); assert.equal(reopenedTerminal.terminalSessionId, terminalDock.terminalSessionId); assert.match(reopenedTerminal.terminalTranscript, /retained session/);
  await evaluate("document.querySelector('[aria-label=\"Hide tool panel (sessions keep running)\"]').click(); await syncFixture.settle(); ");
  const collapsed = await evaluate("return { ...syncFixture.dock(), rowHeight:parseFloat(getComputedStyle(document.querySelector('.repository-ide')).getPropertyValue('--ide-panel-row-height')) }; ");
  assert.equal(collapsed.open, "false"); assert.deepEqual(collapsed.visible, []); assert.equal(collapsed.rowHeight, 36); assert.ok(Math.abs(collapsed.height - collapsed.rowHeight) <= 1); assert.equal(collapsed.terminalRunning, true); assert.equal(collapsed.debugSessionId, debugDock.debugSessionId);
  const stoppedPolling = await evaluate("const count = () => syncFixture.calls.filter(call => /\\/processes\\/.*\\/logs$/.test(call.path)).length; const before = count(); await new Promise(resolve => setTimeout(resolve, 1200)); return { before, after: count() }; ");
  assert.equal(stoppedPolling.after, stoppedPolling.before, "a collapsed tool dock does not poll logs");
  await evaluate("document.querySelector('.repository-ide-tool-tab[data-tool=logs]').click(); await syncFixture.wait(() => !document.querySelector('.repository-ide-run-logs').hidden); syncFixture.exitCurrent(); await syncFixture.wait(() => document.querySelector('.repository-ide-process-logs-output').textContent.includes('FINAL STDERR')); ");
  const exited = await evaluate("return { ...syncFixture.dock(), status: document.querySelector('.repository-ide-process-logs-status').textContent, terminalStarts: syncFixture.calls.filter(call => call.path.endsWith('/terminal/start')).length, destructive: syncFixture.calls.filter(call => /\\/terminal\\/(stop|clear|input)$/.test(call.path) || call.method === 'DELETE'), errors: syncFixture.errors }; ");
  assert.deepEqual(exited.visible, ["logs"]); assert.match(exited.stderr.join("\n"), /FINAL STDERR/); assert.match(exited.status, /Failed.*exit 1/); assert.equal(exited.terminalStarts, 1); assert.deepEqual(exited.destructive, []); assert.deepEqual(exited.errors, []);
  await captureDock("exited-output-dark-1320");
  const changed = await evaluate("syncFixture.changeDisk('<project>updated by synthetic Git</project>'); const result = await syncFixture.ide.refreshAfterExternalChange(syncFixture.repository.id, { paths: ['pom.xml'] }); return { result, content: syncFixture.editor().getValue(), dirty: syncFixture.ide.isDirty() }; ");
  assert.deepEqual(changed.result.reloaded, ["pom.xml"]); assert.equal(changed.content, "<project>updated by synthetic Git</project>"); assert.equal(changed.dirty, false);
  const deleted = await evaluate("syncFixture.changeDisk(null); const result = await syncFixture.ide.refreshAfterExternalChange(syncFixture.repository.id, { paths: ['pom.xml'] }); return { result, tabs: document.querySelectorAll('.repository-ide-tab').length, empty: !document.querySelector('.repository-ide-editor-empty').hidden }; ");
  assert.deepEqual(deleted.result.closed, ["pom.xml"]); assert.equal(deleted.tabs, 0); assert.equal(deleted.empty, true);
  await evaluate("syncFixture.controls.dispose(); syncFixture.ide.dispose(); syncFixture.terminal.dispose();"); assert.equal(backendRequests, 0);
  await finish(null, { ok: true, sandboxed: true, backendRequests, configuredAndDetected: true, sharedState: true, unsavedProtected: true,
    sharedToolDock: true, liveProcessOutput: true, exactProcessSelection: true, retainedSessions: true, maximizeRestore: true, lazyLogPolling: true, screenshots });
}).catch(error => finish(error));
