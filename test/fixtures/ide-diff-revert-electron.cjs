// Real Monaco, synthetic repository only. Never connects to an Argus backend.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-ide-diff-")) throw new Error("An isolated test directory is required.");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, server, completed = false, backendRequests = 0;
const timer = setTimeout(() => finish(new Error("IDE diff renderer fixture timed out")), 50_000);
async function finish(error, result) {
  if (completed) return; completed = true; clearTimeout(timer);
  if (error) console.error(error.stack || error);
  else console.log(`IDE_DIFF_RENDERER_RESULT=${JSON.stringify(result)}`);
  if (window && !window.isDestroyed()) window.destroy();
  server?.closeAllConnections(); server?.close(); app.exit(error ? 1 : 0);
}

const page = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Isolated IDE diff regression</title>
<link rel="stylesheet" href="/legacy/styles.css"><link rel="stylesheet" href="/legacy/repository-ide.css">
<style>body{display:flex;flex-direction:column;font:13px/1.4 system-ui,sans-serif}.fixture-label{flex:none;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line);color:var(--muted)}#ide{flex:1;min-height:0}</style>
</head><body class="repository-ide-enabled" data-view="repository"><header class="fixture-label">ISOLATED QA · Synthetic diff and callbacks only · No repository or backend mutations</header><main id="ide"></main></body></html>`;

async function initializeRenderer() {
  const { createRepositoryIde } = await import("/legacy/repository-ide.mjs");
  const sourcePath = "src/reviews.js", originalSource = "export const rating = 3;\nexport const keep = true;\n";
  const errors = [], apiCalls = [], calls = [];
  const api = async (raw, options = {}) => {
    const url = new URL(raw, location.origin); apiCalls.push({ path: url.pathname, method: options.method || "GET" });
    if (url.pathname.endsWith("/code-discussions")) return { taskId: null, discussions: [] };
    if (url.pathname.endsWith("/status")) return { languages: [] };
    if (url.pathname.endsWith("/tree")) {
      const directory = url.searchParams.get("path") || "";
      return { path: directory, entries: directory ? [{ name: "reviews.js", path: sourcePath, directory: false }] : [{ name: "src", path: "src", directory: true }] };
    }
    if (url.pathname.endsWith("/file") && !options.method) return { path: sourcePath, content: originalSource, contentHash: "synthetic-disk-revision", language: "javascript" };
    if (url.pathname.endsWith("/session") && options.method === "DELETE") return { ok: true };
    throw new Error(`Unexpected synthetic API request: ${raw}`);
  };
  const ide = createRepositoryIde({ host: document.querySelector("#ide"), api, onError: error => errors.push(error.message) });
  await ide.activate({ id: "isolated-diff-fixture", name: "Synthetic reviews", path: "/not-a-real-repository" });
  await ide.openFile(sourcePath, 1, 1, { focus: false });
  const frame = document.querySelector(".repository-ide-editor-frame");
  if (!frame?.contentWindow.monaco) throw new Error(`Monaco did not load: ${errors.join("; ")}`);
  const fixture = window.diffFixture = { ide, frame, errors, apiCalls, calls, originalSource, sourcePath, pending: null, mode: "cancel" };
  const createDiff = frame.contentWindow.monaco.editor.createDiffEditor;
  frame.contentWindow.monaco.editor.createDiffEditor = (...args) => (fixture.currentDiff = createDiff(...args));
  fixture.settle = async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
  fixture.buttons = () => [...frame.contentDocument.querySelectorAll(".repository-ide-diff-revert")];
  fixture.models = () => frame.contentWindow.monaco.editor.getModels().filter(model => model.uri.scheme === "argus-diff").map(model => ({ uri: model.uri.path, value: model.getValue() }));
  fixture.open = async (kind, staged = false, mode = "cancel") => {
    fixture.mode = mode; fixture.pending = null; fixture.calls.length = 0;
    const cases = {
      replacement: { before: "export const rating = 3;\nexport const keep = true;\n", after: "export const rating = 5;\nexport const keep = true;\n", changes: [{ id: "1".repeat(64), beforeStart: 1, beforeCount: 1, afterStart: 1, afterCount: 1 }] },
      insertion: { before: "export const keep = true;\nexport const tail = 1;\n", after: "export const keep = true;\nexport const added = 2;\nexport const tail = 1;\n", changes: [{ id: "2".repeat(64), beforeStart: 2, beforeCount: 0, afterStart: 2, afterCount: 1 }] },
      deletion: { before: "export const keep = true;\nexport const removed = 1;", after: "export const keep = true;", changes: [{ id: "3".repeat(64), beforeStart: 2, beforeCount: 1, afterStart: 2, afterCount: 0 }] },
      multiple: { before: "export const first = 1;\nexport const keep = true;\nexport const last = 3;\n", after: "export const first = 2;\nexport const keep = true;\nexport const last = 4;\n", changes: [{ id: "4".repeat(64), beforeStart: 1, beforeCount: 1, afterStart: 1, afterCount: 1 }, { id: "5".repeat(64), beforeStart: 3, beforeCount: 1, afterStart: 3, afterCount: 1 }] },
    };
    const data = cases[kind]; fixture.expected = data;
    await ide.openDiff({ ...data, path: sourcePath, staged, beforeLabel: staged ? "HEAD" : "Staged index", afterLabel: staged ? "Staged index" : "Working tree", revert: { allowed: true, revision: "a".repeat(64), baseline: staged ? "HEAD" : "index", target: staged ? "index" : "worktree" },
      onRevertChange: async (id, isCurrent) => {
        calls.push({ id, current: isCurrent() });
        if (mode === "pending") return await new Promise(resolve => { fixture.pending = resolve; });
        if (mode === "applied") return { applied: true };
        if (mode === "invalidated") return { invalidated: true, reason: "Synthetic diff changed; reopen it." };
        return false;
      },
    });
    const deadline = performance.now() + 5000;
    while (!fixture.currentDiff.getLineChanges()?.length) {
      if (performance.now() >= deadline) throw new Error("Monaco diff computation did not finish");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await fixture.settle();
    return data;
  };
  fixture.measure = index => {
    const button = fixture.buttons()[index], rect = button.getBoundingClientRect(), parent = frame.getBoundingClientRect();
    const hit = frame.contentDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const style = frame.contentWindow.getComputedStyle(button);
    return { title: button.title, disabled: button.disabled, width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, frameWidth: frame.clientWidth, frameHeight: frame.clientHeight, hit: hit === button || button.contains(hit), x: Math.round(parent.left + rect.left + rect.width / 2), y: Math.round(parent.top + rect.top + rect.height / 2), color: style.color, background: style.backgroundColor };
  };
  await fixture.settle();
  return { sandboxed: typeof process === "undefined" && typeof require === "undefined", initialErrors: errors };
}

app.whenReady().then(async () => {
  const { createPreviewServer } = await import(pathToFileURL(path.join(__dirname, "ide-ux-preview.mjs")).href);
  server = createPreviewServer();
  const serveAssets = server.listeners("request")[0]; server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url.startsWith("/api/")) backendRequests++;
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; frame-src 'self' about:; connect-src 'self'; object-src 'none'" }); response.end(page); return;
    }
    void serveAssets(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isolated = session.fromPartition("isolated-ide-diff", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }));
  window = new BrowserWindow({ show: false, width: 1320, height: 800, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.setContentSize(1320, 800); window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(origin);
  const initial = await window.webContents.executeJavaScript(`(${initializeRenderer.toString()})()`);
  assert.equal(initial.sandboxed, true); assert.deepEqual(initial.initialErrors, []);
  const evaluate = code => window.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const click = async index => {
    const point = await evaluate(`return diffFixture.measure(${index});`);
    assert.equal(point.hit, true, "Revert glyph receives pointer input");
    window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await evaluate("await diffFixture.settle();");
  };
  const colors = {}, scenarios = [];
  for (const theme of ["dark", "light"]) for (const staged of [false, true]) for (const kind of ["replacement", "insertion", "deletion"]) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; await diffFixture.open(${JSON.stringify(kind)}, ${staged});`);
    const before = await evaluate("const readOnly = diffFixture.frame.contentWindow.monaco.editor.EditorOption.readOnly; return { count: diffFixture.buttons().length, models: diffFixture.models(), button: diffFixture.measure(0), expected: diffFixture.expected, readOnly: [diffFixture.currentDiff.getOriginalEditor().getOption(readOnly), diffFixture.currentDiff.getModifiedEditor().getOption(readOnly)] };");
    const label = `${theme} ${staged ? "staged" : "working"} ${kind}`;
    assert.equal(before.count, 1, `${label}: one control for one server block`);
    assert.deepEqual(before.readOnly, [true, true], `${label}: both diff snapshots remain read-only`);
    assert.equal(before.button.disabled, false, `${label}: safe change is enabled`);
    assert.match(before.button.title, staged ? /^Unstage this change/ : /^Revert this change/, `${label}: target-specific label`);
    assert.ok(before.button.width >= 16 && before.button.height >= 16, `${label}: usable visible glyph`);
    assert.ok(before.button.left >= 0 && before.button.top >= 0 && before.button.right <= before.button.frameWidth && before.button.bottom <= before.button.frameHeight, `${label}: glyph fits Monaco, including EOF deletion`);
    await click(0);
    const after = await evaluate("return { models: diffFixture.models(), calls: diffFixture.calls, disabled: diffFixture.buttons()[0].disabled, dirty: diffFixture.ide.isDirty() };");
    assert.deepEqual(after.calls, [{ id: before.expected.changes[0].id, current: true }], `${label}: selected server ID is called exactly once`);
    assert.deepEqual(after.models, before.models, `${label}: cancellation never edits either Monaco snapshot`);
    assert.equal(after.disabled, false, `${label}: cancellation re-enables control`);
    assert.equal(after.dirty, false, `${label}: diff click cannot dirty source buffer`);
    colors[theme] = before.button.color;
    if (process.env.ARGUS_IDE_DIFF_CAPTURE === "1" && kind === "replacement") await fs.writeFile(path.join(temporary, `diff-${theme}-${staged ? "staged" : "working"}.png`), (await window.webContents.capturePage()).toPNG());
    scenarios.push(label);
  }
  assert.notEqual(colors.dark, colors.light, "glyph colors follow Monaco light/dark theme");
  for (const result of [{ applied: true }, { invalidated: true, reason: "Synthetic external edit" }]) {
    await evaluate('await diffFixture.open("multiple", false, "pending");');
    const models = await evaluate("return diffFixture.models();"); await click(0);
    const busy = await evaluate("return { disabled: diffFixture.buttons().map(button => button.disabled), calls: diffFixture.calls.length, pending: typeof diffFixture.pending }; ");
    assert.deepEqual(busy, { disabled: [true, true], calls: 1, pending: "function" }, "all controls disable while selected mutation is pending");
    await evaluate("diffFixture.buttons()[1].click(); await diffFixture.settle();");
    assert.equal(await evaluate("return diffFixture.calls.length;"), 1, "no concurrent revert from a second button");
    await evaluate(`diffFixture.pending(${JSON.stringify(result)}); await diffFixture.settle();`);
    assert.deepEqual(await evaluate("return diffFixture.buttons().map(button => button.disabled);"), [true, true], "applied/invalidated diff keeps obsolete controls disabled");
    assert.deepEqual(await evaluate("return diffFixture.models();"), models, "callback result cannot directly mutate displayed snapshot");
  }
  const cleanup = await evaluate(`
    const oldButtons = diffFixture.buttons();
    document.querySelector(".repository-ide-diff-tab .repository-ide-tab-close").click(); await diffFixture.settle();
    const closed = { controls: diffFixture.buttons().length, models: diffFixture.models().length, detached: oldButtons.every(button => !button.isConnected) };
    await diffFixture.open("replacement"); const reopened = diffFixture.buttons().length;
    await diffFixture.ide.deactivate();
    return { closed, reopened, iframeRemoved: !document.querySelector(".repository-ide-editor-frame"), errors: diffFixture.errors, writes: diffFixture.apiCalls.filter(call => call.method !== "GET" && call.method !== "DELETE") };
  `);
  assert.deepEqual(cleanup.closed, { controls: 0, models: 0, detached: true }); assert.equal(cleanup.reopened, 1); assert.equal(cleanup.iframeRemoved, true); assert.deepEqual(cleanup.errors, []); assert.deepEqual(cleanup.writes, []); assert.equal(backendRequests, 0);
  await finish(null, { ok: true, scenarios: scenarios.length, stateScenarios: 2, sandboxed: true, backendRequests, disposed: true, electron: process.versions.electron });
}).catch(error => finish(error));
