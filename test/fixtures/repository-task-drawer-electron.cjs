// Isolated renderer: production shell/CSS and drawer controller, synthetic content only.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-task-drawer-")) throw new Error("An isolated test directory is required.");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, networkRequests = 0;
const deadline = setTimeout(() => finish(new Error("Task drawer fixture timed out")), 35_000);
function finish(error, result) {
  clearTimeout(deadline);
  if (error) console.error(error.stack || error);
  else console.log(`TASK_DRAWER_RENDERER_RESULT=${JSON.stringify(result)}`);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(error ? 1 : 0);
}
const evaluate = source => window.webContents.executeJavaScript(`(async () => { ${source} })()`);
async function click(selector, rightEdge = false) {
  const point = await evaluate(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(${rightEdge ? "r.right - 20" : "r.left + r.width / 2"}), y: Math.round(r.top + r.height / 2) };`);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  await evaluate("await fixture.settle();");
}
async function viewport(width) {
  window.setContentSize(width, 800);
  await evaluate(`await new Promise((resolve, reject) => {
    let count = 0;
    const timer = setTimeout(() => reject(new Error("Viewport did not settle")), 3000);
    const check = () => {
      count = Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - 800) <= 1 ? count + 1 : 0;
      if (count >= 2) { clearTimeout(timer); resolve(); } else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });`);
}
function sameGeometry(before, after, label) {
  for (const pane of ["editor", "chat"]) for (const axis of ["left", "top", "width", "height"]) {
    assert.ok(Math.abs(before[pane][axis] - after[pane][axis]) < 1, `${label}: ${pane} ${axis} shifted`);
  }
}

app.whenReady().then(async () => {
  const sourceShell = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const stylesheets = [...sourceShell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = sourceShell
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src about:"><style>${styles}</style>`);
  const isolated = session.fromPartition("repository-task-drawer-regression", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 800, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  window.webContents.focus();
  const controller = (await fs.readFile(path.join(root, "public/repository-task-drawer.mjs"), "utf8")).replace(/^export /gm, "");
  await window.webContents.executeJavaScript(controller);
  for (const file of ["ide-splitter.mjs", "repository-ide-resize.mjs"]) {
    const source = (await fs.readFile(path.join(root, "public", file), "utf8")).replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
    await window.webContents.executeJavaScript(source);
  }
  const initial = await evaluate(`
    document.body.dataset.view = "repository";
    document.querySelector("#workspace").classList.remove("hidden");
    document.querySelector("#empty-state").classList.add("hidden");
    const canvas = document.querySelector(".ai-canvas"), rail = document.querySelector("#workspace-task-rail-toggle");
    const host = document.querySelector("#repository-ide-host"), panel = document.querySelector("#repository-task-sidebar"), close = document.querySelector("#repository-task-history-close");
    const nonIdeCloseDisplay = getComputedStyle(close).display;
    canvas.classList.add("task-panel-collapsed");
    document.body.classList.add("repository-ide-enabled");
    host.hidden = false;
    host.innerHTML = '<section style="height:100%;position:relative"><header style="height:40px;display:flex;justify-content:flex-end"><button id="fixture-editor-action" type="button">Editor action</button></header><iframe id="fixture-editor-frame" title="Synthetic editor" style="display:block;width:100%;height:calc(100% - 40px);border:0"></iframe></section>';
    const frame = document.querySelector("#fixture-editor-frame");
    frame.contentDocument.body.style.cssText = "margin:0;width:100%;height:100%";
    frame.contentDocument.body.innerHTML = '<textarea aria-label="Synthetic code" style="box-sizing:border-box;width:100%;height:100%;resize:none">Synthetic source only</textarea>';
    document.querySelector("#repository-task-list").innerHTML = '<div class="task-row active"><button id="fixture-saved-task" class="task-row-main"><strong>Saved task</strong><small>2 messages · just now</small></button></div>';
    document.querySelector("#agent-prompt").value = "Unsent fixture prompt";
    window.fixture = { canvas, rail, panel, close, host, frame, rowClicks: 0, actionClicks: 0, closes: 0 };
    fixture.split = createRepositoryWorkbenchResize({ document, storage:null });
    fixture.split.setContext("drawer-fixture", true);
    fixture.setOpen = open => { canvas.classList.toggle("task-panel-collapsed", !open); rail.setAttribute("aria-expanded", String(open)); };
    fixture.isOpen = () => !canvas.classList.contains("task-panel-collapsed");
    fixture.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fixture.measure = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
      return { editor: rect(host), chat: rect(document.querySelector(".ai-main-content")), drawer: rect(panel), close: rect(close), closeDisplay: getComputedStyle(close).display };
    };
    fixture.controller = createRepositoryTaskDrawer({ document,
      getEnabled: () => document.body.classList.contains("repository-ide-enabled") && fixture.isOpen(),
      onClose: () => { fixture.closes++; fixture.setOpen(false); },
    });
    rail.addEventListener("click", () => fixture.setOpen(!fixture.isOpen()));
    document.querySelector("#fixture-saved-task").addEventListener("click", () => fixture.rowClicks++);
    document.querySelector("#fixture-editor-action").addEventListener("click", () => fixture.actionClicks++);
    fixture.setOpen(false);
    return { nonIdeCloseDisplay, sandboxed: typeof process === "undefined" && typeof require === "undefined" };
  `);
  assert.equal(initial.nonIdeCloseDisplay, "none");
  assert.equal(initial.sandboxed, true);
  const widths = [420, 1440];
  for (const width of widths) {
    await viewport(width);
    const before = await evaluate("return fixture.measure();");
    await click("#workspace-task-rail-toggle");
    const open = await evaluate("return { ...fixture.measure(), open: fixture.isOpen() };");
    assert.equal(open.open, true);
    assert.notEqual(open.closeDisplay, "none");
    assert.ok(open.close.width > 0 && open.close.height > 0);
    assert.ok(open.drawer.width > 100 && open.drawer.left + open.drawer.width <= width + 1);
    sameGeometry(before, open, `${width}px open`);
    await click("#fixture-saved-task");
    assert.equal(await evaluate("return fixture.isOpen();"), true, "clicking within task history keeps it open");
    await click("#workspace-task-rail-toggle");
    assert.equal(await evaluate("return fixture.isOpen();"), false, "the rail closes without reopening from outside pointer dismissal");
    await click("#workspace-task-rail-toggle");
    await click("#repository-task-history-close");
    assert.deepEqual(await evaluate("return { open: fixture.isOpen(), focus: document.activeElement.id };"), { open: false, focus: "workspace-task-rail-toggle" });
    await click("#workspace-task-rail-toggle");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await evaluate("await fixture.settle();");
    assert.deepEqual(await evaluate("return { open: fixture.isOpen(), focus: document.activeElement.id };"), { open: false, focus: "workspace-task-rail-toggle" });
    await click("#workspace-task-rail-toggle");
    await click("#fixture-editor-action");
    assert.deepEqual(await evaluate("return { open: fixture.isOpen(), focus: document.activeElement.id };"), { open: false, focus: "fixture-editor-action" });
    await click("#workspace-task-rail-toggle");
    await evaluate('document.querySelector("#agent-prompt").focus(); await fixture.settle();');
    assert.deepEqual(await evaluate("return { open: fixture.isOpen(), focus: document.activeElement.id };"), { open: false, focus: "agent-prompt" });
    // On narrow windows the chat drawer covers the editor body, so exercise
    // iframe dismissal with chat toggled off, as the user would expose code.
    await evaluate('document.body.classList.add("repository-ide-chat-hidden"); fixture.split.refresh(); await fixture.settle();');
    await click("#workspace-task-rail-toggle");
    await click("#fixture-editor-frame", true);
    assert.deepEqual(await evaluate("return { open: fixture.isOpen(), frameFocused: document.activeElement === fixture.frame };"), { open: false, frameFocused: true });
    await evaluate('document.body.classList.remove("repository-ide-chat-hidden"); fixture.split.refresh(); await fixture.settle();');
    sameGeometry(before, await evaluate("return fixture.measure();"), `${width}px dismissed`);
    assert.equal(await evaluate('return document.querySelector("#agent-prompt").value;'), "Unsent fixture prompt");
    if (process.env.ARGUS_TASK_DRAWER_CAPTURE === "1") {
      await click("#workspace-task-rail-toggle");
      await fs.writeFile(path.join(temporary, `task-history-${width}.png`), (await window.webContents.capturePage()).toPNG());
      await click("#repository-task-history-close");
    }
  }
  const restored = await evaluate('document.body.classList.remove("repository-ide-enabled"); fixture.setOpen(true); return { closeDisplay: getComputedStyle(fixture.close).display, rowClicks: fixture.rowClicks, actionClicks: fixture.actionClicks };');
  assert.equal(restored.closeDisplay, "none");
  assert.equal(restored.rowClicks, widths.length);
  assert.equal(restored.actionClicks, widths.length);
  assert.equal(networkRequests, 0);
  finish(null, { ok: true, sandboxed: true, networkRequests, widths, iframeDismissed: true });
}).catch(error => finish(error));
