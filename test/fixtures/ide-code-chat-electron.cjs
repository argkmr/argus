// Real Monaco + popup with an in-memory/synthetic session store. No Argus backend,
// provider, user profile, user repository or source file is ever contacted.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-ide-chat-")) throw new Error("An isolated test directory is required.");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, server, completed = false, backendRequests = 0;
const timer = setTimeout(() => finish(new Error("Inline code chat renderer fixture timed out")), 75_000);
async function finish(error, result) {
  if (completed) return; completed = true; clearTimeout(timer);
  if (error) console.error(error.stack || error);
  else console.log(`IDE_CHAT_RENDERER_RESULT=${JSON.stringify(result)}`);
  if (window && !window.isDestroyed()) window.destroy();
  server?.closeAllConnections(); server?.close(); app.exit(error ? 1 : 0);
}
const page = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Isolated inline code chat</title>
<link rel="stylesheet" href="/legacy/styles.css"><link rel="stylesheet" href="/legacy/repository-ide.css"><link rel="stylesheet" href="/legacy/ide-code-chat.css">
<style>body{display:flex;flex-direction:column;font:13px/1.4 system-ui,sans-serif}.fixture-label{flex:none;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line);color:var(--muted)}#ide{flex:1;min-height:0}</style>
</head><body class="repository-ide-enabled" data-view="repository"><header class="fixture-label">ISOLATED QA · Synthetic code conversations · No provider or repository writes</header><main id="ide"></main></body></html>`;

async function initializeRenderer() {
  const { createRepositoryIde } = await import("/legacy/repository-ide.mjs");
  const repositoryId = "synthetic-reviews", sourcePath = "src/reviews.js";
  const source = ["// Repository-local code discussion fixture", "", "export function createReview(request) {", "  if (!request.rating) throw new Error('A rating is required');", "  return { rating: request.rating, published: true };", "}", "", "export function displayRating(review) {", "  return String(review.rating);", "}", ""].join("\n");
  const store = JSON.parse(sessionStorage.getItem("argus-synthetic-code-discussions") || '{"counter":0,"discussions":[],"details":{}}');
  const errors = [], calls = [], taskOpens = [], posts = [], cancellations = [];
  const save = () => sessionStorage.setItem("argus-synthetic-code-discussions", JSON.stringify(store));
  const clone = value => JSON.parse(JSON.stringify(value));
  const reply = "createReview checks that a rating is present, then returns a published review containing that rating. It does not write to a database. This answer uses the selected repository snapshot.";
  const api = async (raw, options = {}) => {
    const url = new URL(raw, location.origin), method = options.method || "GET", body = options.body;
    calls.push({ path: url.pathname, method });
    if (url.pathname === "/api/ai-tasks" && method === "GET") return [{ id: "nexus-checkout", title: "Checkout architecture context" }, { id: "nexus-reviews", title: "Reviews rollout notes" }];
    if (url.pathname.endsWith("/code-discussions/ask") && method === "POST") {
      posts.push(clone(body));
      const id = body.discussionId || `discussion-${++store.counter}`;
      let discussion = store.discussions.find(item => item.id === id);
      if (!discussion) { discussion = { id, title: `${body.anchor.side} · ${body.anchor.path}:${body.anchor.line}`, anchor: body.anchor }; store.discussions.push(discussion); }
      discussion.nexusTaskId = body.nexusTaskId;
      const prior = store.details[id]?.messages || [];
      const detail = { taskId: "synthetic-code-task", discussion, messages: [...prior, { id: `user-${posts.length}`, role: "user", content: body.prompt }], status: "running",
        job: { id: `job-${id}`, status: "running", displayOutput: "Reading the selected code and linked context…" }, due: Date.now() + 500 };
      store.details[id] = detail; save(); return clone(detail);
    }
    if (url.pathname.endsWith("/code-discussions") && method === "GET") return clone({ taskId: store.discussions.length ? "synthetic-code-task" : null, discussions: store.discussions });
    if (url.pathname.includes("/code-discussions/") && method === "GET") {
      const id = url.pathname.split("/").at(-1), detail = store.details[id];
      if (!detail) throw new Error("Unknown synthetic discussion");
      if (detail.due && Date.now() >= detail.due) {
        detail.job = { ...detail.job, status: "completed", displayOutput: "" }; detail.status = "completed"; delete detail.due;
        detail.messages.push({ id: `assistant-${detail.messages.length}`, role: "assistant", content: reply }); save();
      }
      return clone(detail);
    }
    if (url.pathname.startsWith("/api/agents/") && method === "DELETE") { cancellations.push(url.pathname); throw new Error("Closing the popup must not cancel a job"); }
    if (url.pathname.endsWith("/status") && method === "GET") return { languages: [] };
    if (url.pathname.endsWith("/tree") && method === "GET") {
      const directory = url.searchParams.get("path") || "";
      return { path: directory, entries: directory ? [{ name: "reviews.js", path: sourcePath, directory: false }] : [{ name: "src", path: "src", directory: true }] };
    }
    if (url.pathname.endsWith("/file") && method === "GET") return { path: sourcePath, content: source, contentHash: "synthetic-saved-source", language: "javascript" };
    if (url.pathname.endsWith("/session") && method === "DELETE") return { ok: true };
    throw new Error(`Unexpected synthetic API request: ${method} ${raw}`);
  };
  const ide = createRepositoryIde({ host: document.querySelector("#ide"), api, onError: error => errors.push(error.message),
    getCodeChatSettings: () => ({ provider: "codex", model: "synthetic-model", effort: "low", speed: "standard" }),
    onCodeChatOpenTask: task => taskOpens.push(task) });
  await ide.activate(repositoryId);
  const fixture = window.chatFixture = { ide, errors, calls, posts, cancellations, store, source, sourcePath, repositoryId, taskOpens };
  fixture.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  fixture.wait = async predicate => { const end = performance.now() + 6_000; while (!predicate()) { if (performance.now() >= end) throw new Error(`Inline chat wait timed out: ${errors.join("; ")}`); await new Promise(resolve => setTimeout(resolve, 20)); } await fixture.settle(); };
  fixture.sync = () => {
    fixture.frame = document.querySelector(".repository-ide-editor-frame");
    fixture.monaco = fixture.frame.contentWindow.monaco;
    fixture.sourceEditor = fixture.monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === "argus") || fixture.monaco.editor.getEditors()[0];
    const createDiff = fixture.monaco.editor.createDiffEditor;
    fixture.monaco.editor.createDiffEditor = (...args) => (fixture.diffEditor = createDiff(...args));
  };
  fixture.card = () => document.querySelector(".ide-code-chat:not([hidden])");
  fixture.prompt = () => fixture.card()?.querySelector("textarea");
  fixture.glyphs = () => [...fixture.frame.contentDocument.querySelectorAll(".argus-code-discussion-glyph")];
  fixture.close = async () => { fixture.card()?.querySelector(".ide-code-chat-close").click(); await fixture.settle(); };
  fixture.askSource = async () => {
    await ide.openFile(sourcePath, 3, 17, { focus: true });
    fixture.sync(); fixture.sourceEditor.setSelection({ startLineNumber: 3, startColumn: 17, endLineNumber: 3, endColumn: 29 });
    await fixture.sourceEditor.getAction("argus.codeDiscussion.source").run(); await fixture.wait(() => fixture.card() && fixture.card().getAttribute("aria-busy") === "false");
  };
  fixture.submit = async (message, nexusId) => {
    const card = fixture.card();
    if (nexusId !== undefined) { const picker = card.querySelector('[aria-label="Optional Nexus context"]'); picker.value = nexusId; picker.dispatchEvent(new Event("change", { bubbles: true })); }
    const input = fixture.prompt(); input.value = message; input.dispatchEvent(new Event("input", { bubbles: true }));
    const previous = posts.length;
    card.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fixture.wait(() => posts.length > previous && card.querySelector(".ide-code-chat-status").textContent.includes("working"));
  };
  fixture.askDiff = async side => {
    await ide.openDiff({ path: sourcePath, before: source, after: source.replace("published: true", "published: false"), staged: true,
      beforeLabel: "HEAD", afterLabel: "Staged index", changes: [], revert: { allowed: false } });
    const editor = side === "before" ? fixture.diffEditor.getOriginalEditor() : fixture.diffEditor.getModifiedEditor();
    editor.setSelection({ startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 61 });
    await editor.getAction(`argus.codeDiscussion.${side}`).run(); await fixture.wait(() => fixture.card()?.getAttribute("aria-busy") === "false");
  };
  fixture.measure = () => {
    const card = fixture.card(), rect = card.getBoundingClientRect(), host = document.querySelector(".repository-ide").getBoundingClientRect();
    const controls = [...card.querySelectorAll("textarea, .ide-code-chat-send, .ide-code-chat-close")].map(node => { const item = node.getBoundingClientRect(); return { left: item.left, top: item.top, right: item.right, bottom: item.bottom, width: item.width, height: item.height }; });
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, host: { left: host.left, top: host.top, right: host.right, bottom: host.bottom }, controls, color: getComputedStyle(card).color, background: getComputedStyle(card).backgroundColor };
  };
  await ide.openFile(sourcePath, 3, 17, { focus: false }); fixture.sync(); await fixture.settle();
  return { sandboxed: typeof process === "undefined" && typeof require === "undefined", errors, savedCount: store.discussions.length };
}

app.whenReady().then(async () => {
  const { createPreviewServer } = await import(pathToFileURL(path.join(__dirname, "ide-ux-preview.mjs")).href);
  server = createPreviewServer();
  const serveAssets = server.listeners("request")[0]; server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url.startsWith("/api/")) backendRequests++;
    if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; frame-src 'self' about:; connect-src 'self'; object-src 'none'" }); response.end(page); return; }
    void serveAssets(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, isolated = session.fromPartition("isolated-ide-code-chat", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }));
  window = new BrowserWindow({ show: false, width: 1320, height: 800, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.setContentSize(1320, 800); window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(origin);
  const initial = await window.webContents.executeJavaScript(`(${initializeRenderer.toString()})()`);
  assert.equal(initial.sandboxed, true); assert.deepEqual(initial.errors, []); assert.equal(initial.savedCount, 0);
  const evaluate = source => window.webContents.executeJavaScript(`(async () => { ${source} })()`);
  await evaluate("await chatFixture.askSource();");
  const before = await evaluate("return { snapshot: chatFixture.card().querySelector('.ide-code-chat-snapshot pre').textContent, posts: chatFixture.posts.length, html: chatFixture.card().outerHTML }; ");
  assert.equal(before.snapshot, "createReview"); assert.equal(before.posts, 0);
  const keys = await evaluate(`
    const input = chatFixture.prompt(); input.focus(); input.value = "Draft preserved"; input.dispatchEvent(new Event("input", { bubbles: true }));
    const events = [new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }), new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }), new KeyboardEvent("keydown", { key: "F9", bubbles: true, cancelable: true }), new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true }), new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true })];
    for (const event of events) input.dispatchEvent(event); await chatFixture.settle();
    return { prevented: events.map(event => event.defaultPrevented), searchHidden: document.querySelector('.repository-ide-search').hidden, draft: input.value, dirty: chatFixture.ide.isDirty(), source: chatFixture.sourceEditor.getValue(), mutations: chatFixture.calls.filter(call => call.method !== "GET") };
  `);
  assert.deepEqual(keys.prevented, [false, false, false, false, false]); assert.equal(keys.searchHidden, true); assert.equal(keys.draft, "Draft preserved"); assert.equal(keys.dirty, false); assert.deepEqual(keys.mutations, []);
  await evaluate('await chatFixture.submit("What does createReview do?", "nexus-checkout");');
  const sent = await evaluate("return { body: chatFixture.posts[0], visible: chatFixture.card().textContent, dirty: chatFixture.ide.isDirty() };");
  assert.equal(sent.body.nexusTaskId, "nexus-checkout"); assert.equal(sent.body.model, "synthetic-model"); assert.equal(sent.body.anchor.side, "source"); assert.equal(sent.body.anchor.selection, "createReview"); assert.ok(sent.body.requestId); assert.equal(sent.dirty, false); assert.match(sent.visible, /Reading the selected code/);
  await evaluate("await chatFixture.wait(() => chatFixture.card().textContent.includes('It does not write to a database')); await chatFixture.wait(() => chatFixture.glyphs().length === 1);");
  const colors = {}, captures = [];
  for (const theme of ["dark", "light"]) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; await new Promise(resolve => setTimeout(resolve, 300)); await chatFixture.settle();`);
    const measure = await evaluate("return chatFixture.measure();");
    assert.ok(measure.left >= measure.host.left && measure.right <= measure.host.right + 1 && measure.top >= measure.host.top && measure.bottom <= measure.host.bottom + 1, `${theme}: popup fits editor workspace`);
    colors[theme] = measure.background;
    if (process.env.ARGUS_IDE_CHAT_CAPTURE === "1") { const file = path.join(temporary, `inline-chat-${theme}.png`); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); captures.push(file); }
  }
  assert.notEqual(colors.dark, colors.light, "popup follows application light/dark colors");
  await evaluate("await chatFixture.close(); chatFixture.glyphs()[0].click(); await chatFixture.wait(() => chatFixture.card()?.textContent.includes('It does not write to a database'));");
  assert.equal(await evaluate("return chatFixture.posts.length;"), 1, "reopening a marker does not submit another request");
  await evaluate('await chatFixture.submit("And does it persist anything?"); await chatFixture.close();');
  assert.equal(await evaluate("return chatFixture.cancellations.length;"), 0, "closing a running conversation does not stop it");
  await evaluate("await chatFixture.askSource(); await chatFixture.wait(() => chatFixture.card().textContent.includes('And does it persist anything?')); ");
  assert.equal(await evaluate("return chatFixture.posts[1].discussionId;"), "discussion-1");
  for (const side of ["before", "after"]) {
    await evaluate(`await chatFixture.close(); await chatFixture.askDiff(${JSON.stringify(side)});`);
    const snapshot = await evaluate("return chatFixture.card().querySelector('.ide-code-chat-snapshot').textContent;");
    assert.match(snapshot, side === "before" ? /Before diff/ : /After diff/); assert.match(snapshot, /staged diff/);
    assert.match(snapshot, side === "before" ? /published: true/ : /published: false/);
    await evaluate(`await chatFixture.submit(${JSON.stringify(`Explain this ${side} version.`)}); await chatFixture.wait(() => chatFixture.card().textContent.includes('It does not write to a database'));`);
    assert.equal(await evaluate("return chatFixture.posts.at(-1).anchor.side;"), side);
    assert.equal(await evaluate("return chatFixture.posts.at(-1).anchor.staged;"), true);
  }
  await evaluate("await chatFixture.close(); await chatFixture.ide.deactivate(); await chatFixture.ide.activate(chatFixture.repositoryId); for (const button of document.querySelectorAll('.repository-ide-tab .repository-ide-tab-close')) button.click(); await chatFixture.settle(); await chatFixture.ide.openCodeDiscussions(); await chatFixture.wait(() => chatFixture.card()?.getAttribute('aria-busy') === 'false');");
  assert.equal(await evaluate("return document.querySelectorAll('.repository-ide-tab').length;"), 0, "the history popup also opens with every code tab closed");
  assert.equal(await evaluate("return chatFixture.card().querySelector('[aria-label=\"Code discussion\"]').options.length;"), 4, "history exposes all source/before/after discussions without requiring a selection");
  await evaluate("chatFixture.card().querySelector('[aria-label=\"Code discussion\"]').value = 'discussion-1'; chatFixture.card().querySelector('[aria-label=\"Code discussion\"]').dispatchEvent(new Event('change', { bubbles: true })); await chatFixture.wait(() => chatFixture.card().textContent.includes('And does it persist anything?'));");
  window.setContentSize(540, 560);
  await evaluate("await chatFixture.settle();");
  const narrow = await evaluate("return chatFixture.measure();");
  assert.ok(narrow.left >= narrow.host.left && narrow.right <= narrow.host.right + 1 && narrow.top >= narrow.host.top && narrow.bottom <= narrow.host.bottom + 1, "narrow popup remains in its resized workspace");
  assert.ok(narrow.controls.every(rect => rect.left >= narrow.left && rect.right <= narrow.right + 1 && rect.top >= narrow.top && rect.bottom <= narrow.bottom + 1), "input, send and close controls remain inside the narrow popup");
  if (process.env.ARGUS_IDE_CHAT_CAPTURE === "1") { const file = path.join(temporary, "inline-chat-narrow.png"); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); captures.push(file); }
  const preReload = await evaluate("return { errors: chatFixture.errors, cancellations: chatFixture.cancellations, dirty: chatFixture.ide.isDirty(), count: chatFixture.store.discussions.length }; ");
  assert.deepEqual(preReload.errors, []); assert.deepEqual(preReload.cancellations, []); assert.equal(preReload.dirty, false); assert.equal(preReload.count, 3);
  window.setContentSize(1320, 800);
  const pageLoaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
  window.reload(); await pageLoaded;
  const reloaded = await window.webContents.executeJavaScript(`(${initializeRenderer.toString()})()`);
  assert.equal(reloaded.savedCount, 3);
  await evaluate("await chatFixture.askSource(); await chatFixture.wait(() => chatFixture.card()?.textContent.includes('And does it persist anything?')); ");
  const restored = await evaluate("return { posts: chatFixture.posts.length, glyphs: chatFixture.glyphs().length, errors: chatFixture.errors, selection: chatFixture.card().querySelector('[aria-label=\"Code discussion\"]').value }; ");
  assert.equal(restored.posts, 0); assert.equal(restored.glyphs, 1); assert.equal(restored.selection, "discussion-1"); assert.deepEqual(restored.errors, []);
  await evaluate("chatFixture.ide.dispose();"); assert.equal(backendRequests, 0);
  await finish(null, { ok: true, sandboxed: true, backendRequests, sourceAndBothDiffSides: true, restored: true, screenshots: captures, electron: process.versions.electron });
}).catch(error => finish(error));
