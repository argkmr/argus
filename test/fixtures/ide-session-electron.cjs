// Isolated integration QA: production IDE/Monaco, synthetic API, private profile.
// The parent keeps a single localhost origin alive across two Electron launches.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const [temporary, phase, origin] = process.argv.slice(2);
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-ide-session-")) throw new Error("An isolated session QA directory is required");
if (!["write", "restore"].includes(phase) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Invalid isolated QA phase or origin");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, isolated, finished = false, externalRequests = 0, unsavedDiscardPrompts = 0;
const timer = setTimeout(() => fail(new Error("IDE session restart fixture timed out")), 35_000);
function fail(error) {
  if (finished) return; finished = true; clearTimeout(timer);
  console.error(error.stack || error);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
}

async function initializeRenderer(phase) {
  const { createRepositoryIde } = await import("/legacy/repository-ide.mjs");
  const repositories = {
    alpha: { id: "session-alpha", name: "Synthetic Alpha", path: "/synthetic/session-alpha" },
    beta: { id: "session-beta", name: "Synthetic Beta", path: "/synthetic/session-beta" },
  };
  const files = { alpha: ["src/first.ts", "src/retained.ts"], beta: ["services/worker.py"] };
  const sourceMarker = "SOURCE_IS_SYNTHETIC_AND_MUST_NOT_BE_PERSISTED", dirtyMarker = "UNSAVED_SYNTHETIC_EDIT_NOT_TO_PERSIST";
  const revision = phase === "write" ? "initial-disk" : "updated-disk-after-restart";
  const source = (name, file) => Array.from({ length: 320 }, (_, index) => `${index === 0 ? "// " + sourceMarker + " " + revision : "// " + name + " " + file} line ${index + 1} · ${"synthetic-column ".repeat(25)}`).join("\n");
  const errors = [], calls = [], initialStorage = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));
  const api = async (raw, options = {}) => {
    const url = new URL(raw, location.origin), method = options.method || "GET";
    calls.push({ route: url.pathname, path: url.searchParams.get("path"), method });
    if (method === "DELETE" && url.pathname.endsWith("/session")) return { ok: true };
    if (method !== "GET") throw new Error(`No writes allowed in session QA: ${method} ${raw}`);
    const name = Object.keys(repositories).find(key => url.pathname.includes("/" + repositories[key].id + "/"));
    if (!name) throw new Error(`Unknown synthetic repository: ${raw}`);
    if (url.pathname.endsWith("/status")) return { languages: [] };
    if (url.pathname.endsWith("/tree")) {
      const directory = url.searchParams.get("path") || "";
      const paths = files[name].filter(file => file.startsWith(directory ? directory + "/" : ""));
      const children = [...new Set(paths.map(file => file.slice(directory ? directory.length + 1 : 0).split("/")[0]))];
      return { path: directory, entries: children.map(child => {
        const file = directory ? directory + "/" + child : child;
        return { name: child, path: file, directory: !files[name].includes(file) };
      }) };
    }
    if (url.pathname.endsWith("/file")) {
      const file = url.searchParams.get("path");
      if (!files[name].includes(file)) throw Object.assign(new Error("Synthetic file missing"), { status: 404 });
      return { path: file, content: source(name, file), contentHash: `${revision}-${name}-${file}`, language: "plaintext" };
    }
    if (url.pathname.endsWith("/code-discussions")) return { discussions: [] };
    throw new Error(`Unexpected synthetic request: ${method} ${raw}`);
  };
  const ide = createRepositoryIde({ host: document.querySelector("#ide"), api, onError: error => errors.push(error.message) });
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const editor = () => document.querySelector(".repository-ide-editor-frame")?.contentWindow.monaco?.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === "argus");
  const wait = async predicate => {
    const until = performance.now() + 5_000;
    while (!predicate()) { if (performance.now() > until) throw new Error("Session renderer wait timed out: " + errors.join("; ")); await new Promise(resolve => setTimeout(resolve, 20)); }
    await settle();
  };
  const snapshot = () => {
    const current = editor();
    return { path: current.getModel().uri.path.slice(1), position: current.getPosition(), scrollTop: current.getScrollTop(), scrollLeft: current.getScrollLeft(), dirty: ide.isDirty() };
  };
  const locate = async (lineNumber, column, scrollTop, scrollLeft) => {
    const current = editor(); current.setPosition({ lineNumber, column }); current.setScrollPosition({ scrollTop, scrollLeft }); await settle();
  };
  window.sessionFixture = { ide, repositories, files, source, sourceMarker, dirtyMarker, revision, errors, calls, initialStorage, editor, settle, wait, snapshot, locate };
  return { sandboxed: typeof process === "undefined" && typeof require === "undefined" };
}

app.whenReady().then(async () => {
  isolated = session.fromPartition("persist:isolated-ide-session-restart", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
    const outside = !details.url.startsWith(origin + "/");
    if (outside) externalRequests++;
    callback({ cancel: outside });
  });
  window = new BrowserWindow({ show: false, width: 1120, height: 760, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.setContentSize(1120, 760); window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("console-message", event => { if (event.level === "error") console.error(`Isolated renderer: ${event.message}`); });
  window.webContents.on("will-prevent-unload", event => {
    assert.equal(phase, "write", "Only the deliberately dirty synthetic first process may ask to discard");
    unsavedDiscardPrompts++; event.preventDefault(); // Approve discarding this synthetic fixture draft only.
  });
  await window.loadURL(origin + "/session-qa");
  const initialized = await window.webContents.executeJavaScript(`(${initializeRenderer.toString()})(${JSON.stringify(phase)})`);
  assert.equal(initialized.sandboxed, true);
  const evaluate = async source => {
    const value = await window.webContents.executeJavaScript(`(async () => { try { ${source} } catch(error) { return { fixtureError: error.stack || String(error) }; } })()`);
    if (value?.fixtureError) throw new Error(value.fixtureError);
    return value;
  };
  const result = { ok: true, phase, pid: process.pid, sandboxed: true, views: {} };
  if (phase === "write") {
    const written = await evaluate(`
      const f = sessionFixture;
      await f.ide.activate(f.repositories.alpha, { focus: false });
      await f.ide.openFile(f.files.alpha[0], 8, 4, { focus: false });
      await f.ide.openFile(f.files.alpha[1], 150, 13, { focus: false });
      await f.locate(150, 13, 2450, 105);
      await f.ide.activate(f.repositories.beta, { focus: false });
      await f.ide.openFile(f.files.beta[0], 87, 9, { focus: false });
      await f.locate(87, 9, 1320, 65);
      const beta = f.snapshot();
      await f.ide.activate(f.repositories.alpha, { focus: false });
      await f.wait(() => f.editor()?.getModel().uri.path.endsWith('/src/retained.ts'));
      const current = f.editor(), model = current.getModel();
      current.executeEdits('synthetic-unsaved', [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: model.getLineMaxColumn(1) }, text: '// ' + f.dirtyMarker }]);
      await f.locate(173, 17, 2860, 115);
      return { alpha: f.snapshot(), beta, errors: f.errors, fileWrites: f.calls.filter(call => call.route.endsWith('/file') && call.method !== 'GET').length };
    `);
    assert.equal(written.alpha.dirty, true); assert.deepEqual(written.errors, []); assert.equal(written.fileWrites, 0);
    result.views = { alpha: written.alpha, beta: written.beta }; result.errors = written.errors; result.fileWrites = written.fileWrites;
  } else {
    const restored = await evaluate(`
      const f = sessionFixture, raw = f.initialStorage['argus-ide-last-file:v1'];
      if (!raw) throw new Error('Previous process did not persist last-file metadata');
      const metadata = JSON.parse(raw), allValues = Object.values(f.initialStorage).join('\\n');
      if (allValues.includes(f.sourceMarker) || allValues.includes(f.dirtyMarker)) throw new Error('Source text leaked into persisted preferences');
      if (metadata.version !== 1 || metadata.repositories.length !== 2) throw new Error('Missing independent repository metadata');
      for (const entry of metadata.repositories) {
        if (Object.keys(entry).sort().join(',') !== 'id,root,view') throw new Error('Unexpected persisted repository fields');
        if (Object.keys(entry.view).sort().join(',') !== 'column,line,path,scrollLeft,scrollTop') throw new Error('Unexpected persisted editor fields');
      }
      const outside = document.querySelector('#outside-focus'); outside.focus();
      await f.ide.activate(f.repositories.alpha, { focus: false });
      await f.wait(() => !!f.editor()?.getModel());
      const alpha = f.snapshot(), alphaFresh = f.editor().getValue() === f.source('alpha', f.files.alpha[1]);
      const focusPreserved = document.activeElement === outside;
      await f.ide.activate(f.repositories.beta, { focus: false });
      await f.wait(() => !!f.editor()?.getModel());
      const beta = f.snapshot(), betaFresh = f.editor().getValue() === f.source('beta', f.files.beta[0]);
      if (!document.querySelector('.repository-ide-path').textContent.includes(f.files.beta[0]) || !document.querySelector('.repository-ide-editor-empty').hidden) throw new Error('Restored file is not visibly active in the editor');
      const repositoryIsolation = f.calls.filter(call => call.route.endsWith('/file')).every(call => call.route.includes('/session-alpha/') ? call.path === f.files.alpha[1] : call.route.includes('/session-beta/') && call.path === f.files.beta[0]);
      return { alpha, beta, metadataOnly: true, diskReloaded: alphaFresh && betaFresh && !f.ide.isDirty(), focusPreserved, repositoryIsolation, errors: f.errors, fileWrites: f.calls.filter(call => call.route.endsWith('/file') && call.method !== 'GET').length };
    `);
    assert.deepEqual(restored.errors, []); assert.equal(restored.metadataOnly, true); assert.equal(restored.diskReloaded, true);
    assert.equal(restored.focusPreserved, true); assert.equal(restored.repositoryIsolation, true); assert.equal(restored.fileWrites, 0);
    result.views = { alpha: restored.alpha, beta: restored.beta };
    for (const key of ["metadataOnly", "diskReloaded", "focusPreserved", "repositoryIsolation", "errors", "fileWrites"]) result[key] = restored[key];
    if (process.env.ARGUS_IDE_SESSION_CAPTURE === "1") {
      result.screenshot = path.join(temporary, "restored-monaco-after-process-restart.png");
      await evaluate("await new Promise(resolve => setTimeout(resolve, 200)); await sessionFixture.settle();");
      await fs.writeFile(result.screenshot, (await window.webContents.capturePage()).toPNG());
    }
  }
  // Do not call ide.dispose/deactivate: closing the actual window must flush the
  // final cursor synchronously, including during the unsaved-draft close guard.
  const closed = new Promise(resolve => window.once("closed", resolve));
  window.close(); await closed;
  isolated.flushStorageData();
  assert.equal(externalRequests, 0); result.externalRequests = externalRequests;
  result.unsavedDiscardPrompts = unsavedDiscardPrompts; result.windowClosed = true;
  finished = true; clearTimeout(timer);
  console.log(`IDE_SESSION_RENDERER_RESULT=${JSON.stringify(result)}`);
  app.quit();
}).catch(fail);
