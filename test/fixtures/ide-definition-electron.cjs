// Native pointer events, real Monaco, and synthetic files only: no user backend or repository.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-ide-definition-")) throw new Error("An isolated test directory is required.");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, server, backendRequests = 0, completed = false;
const timer = setTimeout(() => finish(new Error("Definition fixture timed out")), 40_000);
function finish(error, result) {
  if (completed) return; completed = true; clearTimeout(timer);
  if (error) console.error(error.stack || error); else console.log(`IDE_DEFINITION_RESULT=${JSON.stringify(result)}`);
  if (window && !window.isDestroyed()) window.destroy();
  server?.closeAllConnections(); server?.close(); app.exit(error ? 1 : 0);
}
const page = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/legacy/styles.css"><link rel="stylesheet" href="/legacy/repository-ide.css"><style>body{display:flex;flex-direction:column}#ide{flex:1;min-height:0}</style></head><body><main id="ide"></main></body></html>`;
async function initializeRenderer() {
  const { createRepositoryIde } = await import("/legacy/repository-ide.mjs");
  const files = {
    "src/Caller.java": 'class Caller {\n  void run() { service(); }\n  int read(int count) { return count + Constants.LIMIT; }\n  @Value("${orders.timeout-ms:30}") private int timeout;\n  void configure() { env.getProperty("orders.timeout-ms"); }\n}\n',
    "src/Service.java": "class Service {\n  void service() {}\n}\n",
    "src/Constants.java": "class Constants {\n  static final int LIMIT = 30;\n}\n",
    "src/application.yml": "orders:\n  timeout-ms: 30\n",
  };
  const fixture = window.definitionFixture = { errors: [], queries: [], pending: null, mode: "direct" };
  const api = async (raw, options = {}) => {
    const url = new URL(raw, location.origin);
    if (url.pathname.endsWith("/status")) return { languages: [] };
    if (url.pathname.endsWith("/code-discussions")) return { discussions: [] };
    if (url.pathname.endsWith("/tree")) return { entries: url.searchParams.get("path") ? Object.keys(files).map(path => ({ path, name: path.slice(4), directory: false })) : [{ path: "src", name: "src", directory: true }] };
    if (url.pathname.endsWith("/file")) { const path = url.searchParams.get("path"); return { path, content: files[path], contentHash: `${path}-fixture`, language: path.endsWith(".yml") ? "yaml" : "java" }; }
    if (url.pathname.endsWith("/session") && options.method === "DELETE") return { ok: true };
    if (url.pathname.endsWith("/navigate")) {
      fixture.queries.push({ ...options.body, signal: options.signal });
      if (fixture.mode !== "direct" && fixture.queries.length === 1) return await new Promise(resolve => { fixture.pending = resolve; });
      return { locations: [fixture.destination] };
    }
    throw new Error(`Unexpected fixture API: ${raw}`);
  };
  fixture.ide = createRepositoryIde({ host: document.querySelector("#ide"), api, onError: error => fixture.errors.push(error.message) });
  await fixture.ide.activate("definition-fixture"); await fixture.ide.openFile("src/Caller.java", 1, 1);
  fixture.frame = document.querySelector(".repository-ide-editor-frame");
  fixture.editor = fixture.frame.contentWindow.monaco.editor.getEditors()[0];
  fixture.waitFor = async predicate => {
    const deadline = performance.now() + 5000;
    while (!predicate()) { if (performance.now() > deadline) throw new Error(`Renderer condition timed out: ${JSON.stringify({ mode: fixture.mode, destination: fixture.destination, queries: fixture.queries.map(({ signal, ...query }) => ({ ...query, aborted: signal?.aborted })), path: fixture.editor.getModel()?.uri.path, at: fixture.editor.getPosition() })}`); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  fixture.reset = async (mode, target = {}) => {
    await fixture.ide.openFile("src/Caller.java", 1, 1);
    fixture.mode = mode; fixture.queries.length = 0; fixture.pending = null;
    fixture.destination = target.destination || { path: "src/Service.java", line: 2, column: 8 };
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const lineNumber = target.line || 2;
    const position = { lineNumber, column: files["src/Caller.java"].split("\n")[lineNumber - 1].lastIndexOf(target.symbol || "service") + (target.offset ?? 2) + 1 };
    // Monaco's iframe may settle after the outer frame under concurrent renderer
    // tests. Wait for a real hit-testable source glyph before the one native click.
    let point;
    await fixture.waitFor(() => {
      const visible = fixture.editor.getScrolledVisiblePosition(position), editorRect = fixture.editor.getDomNode().getBoundingClientRect(), frameRect = fixture.frame.getBoundingClientRect();
      if (!visible) return false;
      const x = Math.round(frameRect.left + editorRect.left + visible.left + 1), y = Math.round(frameRect.top + editorRect.top + visible.top + visible.height / 2);
      const pointerTarget = fixture.editor.getTargetAtClientPoint(x - frameRect.left, y - frameRect.top);
      if (pointerTarget?.position?.lineNumber !== lineNumber || pointerTarget.position.column !== position.column) return false;
      point = { x, y, position }; return true;
    });
    return point;
  };
}
app.whenReady().then(async () => {
  const { createPreviewServer } = await import(pathToFileURL(path.join(__dirname, "ide-ux-preview.mjs")).href);
  server = createPreviewServer(); const assets = server.listeners("request")[0]; server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url.startsWith("/api/")) backendRequests++;
    if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; frame-src 'self' about:; connect-src 'self'; object-src 'none'" }); response.end(page); } else void assets(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, isolated = session.fromPartition("isolated-definition", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }));
  window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(origin); await window.webContents.executeJavaScript(`(${initializeRenderer.toString()})()`);
  const evaluate = code => window.webContents.executeJavaScript(`(async () => { const f = definitionFixture; ${code} })()`);
  let scenarios = 0;
  for (const modifier of ["meta", "control"]) for (const mode of ["direct", "pending", "empty"]) {
    window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
    const point = await evaluate(`return await f.reset(${JSON.stringify(mode)});`);
    if (mode !== "direct") {
      window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y, modifiers: [modifier] });
      await evaluate("await f.waitFor(() => Boolean(f.pending));");
    }
    window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: [modifier] });
    window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: [modifier] });
    if (mode !== "direct") {
      await evaluate("await new Promise(resolve => setTimeout(resolve, 30));");
      const requests = await evaluate("return f.queries.map(q => ({ aborted: q.signal?.aborted }));");
      assert.equal(requests.length, 1, `${modifier}/${mode}: first click reuses pending lookup`);
      assert.equal(requests[0].aborted, false);
      await evaluate(`f.pending(${mode === "empty" ? "{ locations: [] }" : "{ locations: [{ path: 'src/Service.java', line: 2, column: 8 }] }"});`);
    }
    await evaluate("await f.waitFor(() => f.editor.getModel().uri.path === '/src/Service.java');");
    const state = await evaluate("return { count: f.queries.length, at: f.editor.getPosition(), errors: f.errors }; ");
    assert.equal(state.count, mode === "empty" ? 2 : 1, `${modifier}/${mode}: bounded request count`);
    assert.deepEqual(state.at, { lineNumber: 2, column: 8 }); assert.deepEqual(state.errors, []);
    scenarios++;
  }
  const symbols = [
    { line: 3, symbol: "count", destination: { path: "src/Caller.java", line: 3, column: 16 } },
    { line: 3, symbol: "LIMIT", destination: { path: "src/Constants.java", line: 2, column: 20 } },
    { line: 3, symbol: "Constants", destination: { path: "src/Constants.java", line: 1, column: 7 } },
    { line: 4, symbol: "orders.timeout-ms", offset: 6, destination: { path: "src/application.yml", line: 2, column: 3 } },
    { line: 5, symbol: "orders.timeout-ms", offset: 14, destination: { path: "src/application.yml", line: 2, column: 3 } },
  ];
  for (const modifier of ["meta", "control"]) for (const symbol of symbols) {
    window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
    const point = await evaluate(`return await f.reset('direct', ${JSON.stringify(symbol)});`);
    window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: [modifier] });
    window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: [modifier] });
    await evaluate(`await f.waitFor(() => f.queries.length === 1 && f.editor.getModel().uri.path === ${JSON.stringify('/' + symbol.destination.path)} && f.editor.getPosition().column === ${symbol.destination.column});`);
    const state = await evaluate("return { query: { line: f.queries[0].line, column: f.queries[0].column, kind: f.queries[0].kind }, at: f.editor.getPosition(), errors: f.errors };");
    assert.deepEqual(state.query, { line: point.position.lineNumber, column: point.position.column, kind: "definition" }, `${modifier}/${symbol.symbol}: exact symbol position`);
    assert.deepEqual(state.at, { lineNumber: symbol.destination.line, column: symbol.destination.column }); assert.deepEqual(state.errors, []); scenarios++;
  }
  for (const kind of ["declaration", "typeDefinition"]) {
    const source = await evaluate(`
      const point = await f.reset('direct', ${JSON.stringify(symbols[1])});
      f.editor.setPosition(point.position);
      const action = f.editor.getAction('argus.${kind}');
      if (!action?.isSupported()) throw new Error('Missing source ${kind} action');
      await action.run();
      return { kind: f.queries[0]?.kind, path: f.editor.getModel().uri.path, errors: f.errors };
    `);
    assert.deepEqual(source, { kind, path: "/src/Constants.java", errors: [] }); scenarios++;
  }
  const diff = await evaluate(`
    f.diffQueries = [];
    await f.ide.openDiff({ path: 'src/Config.java', before: '', after: '@Value("\u0024{orders.timeout-ms:30}") int timeout;', onNavigate: hit => f.diffQueries.push(hit) });
    const control = f.frame.contentWindow.monaco.editor.getDiffEditors()[0].getModifiedEditor();
    control.setPosition({ lineNumber: 1, column: 17 });
    for (const kind of ['declaration', 'typeDefinition']) {
      const action = control.getAction('argus.diff.' + kind);
      if (!action?.isSupported()) throw new Error('Missing diff ' + kind + ' action');
      await action.run();
    }
    return { queries: f.diffQueries, errors: f.errors };
  `);
  assert.deepEqual(diff, { queries: ["declaration", "typeDefinition"].map(kind => ({ side: "after", path: "src/Config.java", line: 1, column: 11, word: "orders.timeout-ms", kind })), errors: [] }); scenarios += 2;
  window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
  const point = await evaluate("return await f.reset('pending');");
  window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y, modifiers: ["meta"] });
  await evaluate("await f.waitFor(() => Boolean(f.pending));");
  window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: ["meta"] });
  const switched = await evaluate(`
    await new Promise(resolve => setTimeout(resolve, 30));
    const signal = f.queries[0].signal;
    if (signal.aborted) throw new Error('Click failed to adopt pending lookup');
    await f.ide.activate('another-synthetic-repository');
    f.pending({ locations: [{ path: 'src/Service.java', line: 2, column: 8 }] });
    await new Promise(resolve => setTimeout(resolve, 30));
    const frame = document.querySelector('.repository-ide-editor-frame');
    const model = frame.contentWindow.monaco.editor.getEditors()[0].getModel();
    return { aborted: signal.aborted, model: model?.uri.scheme === 'argus' ? model.uri.path : null, content: model?.getValue() || '', errors: f.errors };
  `);
  assert.deepEqual(switched, { aborted: true, model: null, content: "", errors: [] }); scenarios++;
  const errors = await evaluate("await f.ide.dispose(); return f.errors;");
  finish(null, { ok: true, scenarios, backendRequests, errors });
}).catch(finish);
