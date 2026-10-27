// Isolated renderer only: never starts the Argus application or its backend.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-ide-layout-")) throw new Error("An isolated test directory is required.");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const timer = setTimeout(() => { console.error("IDE layout fixture timed out"); app.exit(1); }, 40_000);
const close = code => { clearTimeout(timer); if (window && !window.isDestroyed()) window.destroy(); app.exit(code); };
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1.5, `${message}: ${actual} vs ${expected}`);
let settledViewport;
async function setViewport(width, height, zoom = 1) {
  const key = `${width}:${height}:${zoom}`;
  if (key === settledViewport) return;
  window.setContentSize(width, height);
  window.webContents.setZoomFactor(zoom);
  // Native resize/zoom is asynchronous in the renderer. Two animation frames
  // alone can both see the old viewport when several Electron fixtures run.
  // Wait for the requested viewport itself before reading any layout bounds.
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const expectedWidth = ${width / zoom}, expectedHeight = ${height / zoom};
    let frame, matched = 0;
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error("Viewport did not settle: expected " + expectedWidth + "x" + expectedHeight + ", received " + innerWidth + "x" + innerHeight));
    }, 5000);
    const check = () => {
      const matches = Math.abs(innerWidth - expectedWidth) <= 1 && Math.abs(innerHeight - expectedHeight) <= 1;
      matched = matches ? matched + 1 : 0;
      if (matched >= 2) { clearTimeout(timer); resolve(); }
      else frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
  })`);
  settledViewport = key;
}

app.whenReady().then(async () => {
  const sourceShell = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const stylesheets = [...sourceShell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = sourceShell
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${styles}</style>`);
  const isolated = session.fromPartition("ide-layout-regression", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  window.setContentSize(1440, 900);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  await setViewport(1440, 900);
  await window.webContents.executeJavaScript(`
    document.body.dataset.view = "repository";
    document.querySelector("#workspace").classList.remove("hidden");
    document.querySelector(".ai-canvas").prepend(document.querySelector(".git-panel"));
    document.querySelector(".ai-canvas").classList.add("task-panel-collapsed");
    const normalCanvas = document.querySelector(".ai-canvas"), normalBounds = normalCanvas.getBoundingClientRect();
    window.fixtureNormal = { left: normalBounds.left, top: normalBounds.top, width: normalBounds.width, height: normalBounds.height, columns: getComputedStyle(normalCanvas).gridTemplateColumns };
    document.body.classList.add("repository-ide-enabled");
    document.querySelector("#repository-ide-host").hidden = false;
  `);
  // Render representative editor chrome using the production classes and icons.
  // Keep the real application/backend offline; only the file/code contents are fixtures.
  const iconSource = (await fs.readFile(path.join(root, "public/ide-icons.mjs"), "utf8")).replace(/^export /gm, "");
  await window.webContents.executeJavaScript(iconSource);
  await window.webContents.executeJavaScript(`
    const host = document.querySelector("#repository-ide-host");
    host.innerHTML = [
      '<section class="repository-ide" aria-label="Repository code editor" data-tree-hidden="false" data-version-control-open="false">',
      '<header class="repository-ide-toolbar" aria-label="Editor toolbar"><div class="repository-ide-toolbar-group" data-fixture="views"></div><div class="repository-ide-toolbar-group repository-ide-navigation" data-fixture="navigation"></div><button class="repository-ide-search-launcher"><span class="repository-ide-search-label">Search code</span><kbd class="repository-ide-search-shortcut">⌘P / Ctrl+P</kbd></button><div class="repository-ide-toolbar-group repository-ide-runtime"><span class="repository-ide-run-status" data-state="running"></span><select class="repository-ide-run-select" aria-label="Services run configuration"><option>Review rating</option></select></div></header>',
      '<div class="repository-ide-body"><section class="repository-ide-version-control-slot" hidden></section><aside class="repository-ide-tree-pane"><header class="repository-ide-section-header"><strong>FILES</strong><button>↻</button></header><div class="repository-ide-tree"><button class="repository-ide-tree-row" aria-expanded="true"><svg class="disclosure-chevron repository-ide-tree-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"/></svg><span class="repository-ide-tree-name">src</span></button><div class="repository-ide-tree-children"><button class="repository-ide-tree-row" data-active="true"><span class="repository-ide-tree-name">ReviewController.java</span></button><button class="repository-ide-tree-row"><span class="repository-ide-tree-name">ReviewService.java</span></button></div></div></aside><div class="repository-ide-tree-divider ide-splitter"></div>',
      '<div class="repository-ide-main" data-tool-maximized="false"><div class="repository-ide-tabs"><div class="repository-ide-tab" data-active="true"><button class="repository-ide-tab-name">ReviewController.java</button><button class="repository-ide-tab-close">×</button></div></div><div class="repository-ide-path">src/main/java/example/ReviewController.java</div><div class="repository-ide-diff-labels" hidden></div><div class="repository-ide-conflict" hidden></div><div class="repository-ide-editor-wrap"><div class="repository-ide-editor-empty">ReviewController.java<br>Repository code stays in the editor.</div></div><section class="repository-ide-results" hidden></section>',
      '<section class="repository-ide-tool-dock" data-open="false" data-maximized="false"><div class="repository-ide-tool-resizer ide-splitter" role="separator" aria-label="Resize tools" aria-orientation="horizontal" tabindex="0"></div><header class="repository-ide-tool-header"><div class="repository-ide-tool-tabs" role="tablist" aria-label="Repository tools"></div><span class="repository-ide-tool-status">Running</span></header><div class="repository-ide-tool-content" hidden><section class="repository-ide-terminal-slot" role="tabpanel" hidden></section><section class="repository-ide-run-logs" role="tabpanel" hidden></section><section class="repository-ide-debug" role="tabpanel" hidden></section></div></section></div></div>',
      '<footer class="repository-ide-footer"><span class="repository-ide-notice">Local repository · no network access in this fixture</span><span class="repository-ide-position">Ln 1, Col 1</span></footer></section>',
    ].join('');
    const iconButton = (icon, label, parent, extra = "") => {
      const button = document.createElement("button"); button.className = "repository-ide-icon-button " + extra;
      button.setAttribute("aria-label", label); button.title = label; button.append(createIdeIcon(document, icon)); parent.append(button); return button;
    };
    const toolbar = host.querySelector(".repository-ide-toolbar"), views = host.querySelector('[data-fixture="views"]'), nav = host.querySelector('[data-fixture="navigation"]'), runtime = host.querySelector(".repository-ide-runtime");
    iconButton("files", "Show repository files", views, "repository-ide-visibility-toggle").setAttribute("aria-pressed", "true");
    iconButton("chat", "Show AI chat", views, "repository-ide-visibility-toggle");
    window.fixtureGitToggle = iconButton("branch", "Version Control", views, "repository-ide-visibility-toggle repository-ide-version-control-toggle");
    iconButton("left", "Navigate back", nav); iconButton("right", "Navigate forward", nav);
    host.querySelector(".repository-ide-search-launcher").prepend(createIdeIcon(document, "search"));
    iconButton("play", "Run", runtime, "repository-ide-run-action"); iconButton("bug", "Debug", runtime); iconButton("stop", "Stop", runtime);
    iconButton("more", "More editor actions", toolbar);
    window.fixtureIde = host.querySelector(".repository-ide");
    window.fixtureToolDock = host.querySelector(".repository-ide-tool-dock");
    const toolHeader = host.querySelector(".repository-ide-tool-header"), toolTabs = host.querySelector(".repository-ide-tool-tabs");
    for (const [name, label, icon] of [["terminal", "Terminal", "terminal"], ["logs", "Run logs", "logs"], ["debug", "Debugger", "bug"]]) {
      const tab = iconButton(icon, label, toolTabs, "repository-ide-tool-tab");
      tab.classList.remove("repository-ide-icon-button"); tab.dataset.tool = name; tab.setAttribute("role", "tab");
      const text = document.createElement("span"); text.textContent = label; tab.append(text);
    }
    window.fixtureToolMaximize = iconButton("maximize", "Maximize tool panel", toolHeader);
    window.fixtureToolMinimize = iconButton("minimize", "Hide tool panel", toolHeader);
    const terminalPanel = document.querySelector("#terminal-panel");
    host.querySelector(".repository-ide-terminal-slot").append(terminalPanel);
    terminalPanel.classList.remove("hidden"); terminalPanel.classList.add("running");
    document.querySelector("#terminal-title").textContent = "Review rating · zsh";
    document.querySelector("#terminal-cwd").textContent = "/synthetic/review-rating";
    document.querySelector("#terminal-output").textContent = 'review-rating git:(main) $ npm run dev\\n\\n> review-rating@1.0.0 dev\\n> node --watch src/server.js\\n\\nServer listening on http://127.0.0.1:3000\\nGET /health 200 4ms\\n';
    document.querySelector("#terminal-output").style.whiteSpace = "pre-wrap";
    const runLogs = host.querySelector(".repository-ide-run-logs");
    runLogs.innerHTML = '<section class="repository-ide-process-logs"><header class="repository-ide-process-logs-toolbar"><strong class="repository-ide-process-logs-title">Process output</strong><span class="repository-ide-process-logs-identity">Review rating · 85c2973b-56a1-4b1e-bf88-0d840355435c</span><span class="repository-ide-process-logs-status" data-state="running">Running</span><div class="repository-ide-process-logs-actions"><button>Refresh</button><button>Clear</button><button aria-pressed="true">Following</button></div></header><div class="repository-ide-process-logs-notice" hidden></div><div class="repository-ide-process-logs-error" hidden></div><div class="repository-ide-process-logs-output" tabindex="0" aria-label="Process output"></div></section>';
    const output = runLogs.querySelector(".repository-ide-process-logs-output");
    for (let index = 0; index < 160; index++) { const line = document.createElement("div"); line.className = "repository-ide-process-logs-entry"; line.dataset.stream = index % 19 ? "stdout" : "stderr"; line.textContent = "10:42:" + String(index % 60).padStart(2, "0") + " " + (index % 19 ? "INFO  Request completed: GET /reviews/81 status=200 duration=12ms" : "WARN  Retry scheduled: upstream connection temporarily unavailable"); output.append(line); }
    const debug = host.querySelector(".repository-ide-debug");
    debug.innerHTML = '<div class="repository-ide-debug-toolbar"><span class="repository-ide-debug-session-state" data-state="stopped">Paused</span><span class="repository-ide-debug-session-detail">Java · 127.0.0.1:5005</span><div class="repository-ide-debug-transport" role="group" aria-label="Debugger execution controls"></div></div><div class="repository-ide-debug-targets" hidden></div><div class="repository-ide-debug-tabs" role="tablist"><button class="repository-ide-debug-tab" aria-selected="true">Variables &amp; stack</button><button class="repository-ide-debug-tab" aria-selected="false">Console</button><button class="repository-ide-debug-tab" aria-selected="false">Breakpoints</button></div><div class="repository-ide-debug-inspectors"><section class="repository-ide-debug-inspector"><h4>Call stack</h4><div class="repository-ide-debug-stack"></div></section><section class="repository-ide-debug-inspector"><h4>Variables</h4><div class="repository-ide-debug-variables"></div></section></div><section class="repository-ide-debug-console-panel" hidden><div class="repository-ide-debug-console-header"><span>Debugger output · read only</span><button>Clear</button></div><div class="repository-ide-debug-output" tabindex="0"></div></section><section class="repository-ide-debug-breakpoint-panel" hidden></section><div class="repository-ide-debug-notice">Paused: breakpoint at ReviewService.java:84</div>';
    for (const [icon, label] of [["play", "Continue"], ["step-over", "Step over"], ["step-into", "Step into"], ["step-out", "Step out"], ["stop", "Detach"]]) iconButton(icon, label, debug.querySelector(".repository-ide-debug-transport"), "repository-ide-debug-icon");
    for (let index = 0; index < 60; index++) {
      const frame = document.createElement("button"); frame.className = "repository-ide-stack-frame"; frame.innerHTML = "<strong>ReviewService.handleRequest</strong><span>src/main/java/example/ReviewService.java:" + (84 + index) + "</span>"; debug.querySelector(".repository-ide-debug-stack").append(frame);
      const variable = document.createElement("div"); variable.className = "repository-ide-variable"; variable.textContent = "request" + index + ': { customerId: "fixture-customer", reviewCount: 12 }'; debug.querySelector(".repository-ide-debug-variables").append(variable);
      const line = document.createElement("div"); line.className = "repository-ide-debug-log-entry"; line.textContent = "Debugger attached to local fixture process · event " + index; debug.querySelector(".repository-ide-debug-output").append(line);
    }
    window.fixtureSetTool = (name, open = true, maximized = false, debugView = "inspect") => {
      fixtureToolDock.dataset.open = String(open); fixtureToolDock.dataset.maximized = String(open && maximized);
      host.querySelector(".repository-ide-main").dataset.toolMaximized = String(open && maximized);
      host.querySelector(".repository-ide-tool-content").hidden = !open;
      for (const [tool, selector] of [["terminal", ".repository-ide-terminal-slot"], ["logs", ".repository-ide-run-logs"], ["debug", ".repository-ide-debug"]]) host.querySelector(selector).hidden = !open || tool !== name;
      for (const tab of toolTabs.children) { tab.setAttribute("aria-selected", String(open && tab.dataset.tool === name)); tab.tabIndex = tab.dataset.tool === name ? 0 : -1; }
      fixtureToolMaximize.hidden = fixtureToolMinimize.hidden = !open;
      debug.querySelector(".repository-ide-debug-inspectors").hidden = debugView !== "inspect";
      debug.querySelector(".repository-ide-debug-console-panel").hidden = debugView !== "console";
      host.querySelector(".repository-ide-tool-status").textContent = name === "debug" ? "Paused" : "Running";
      host.querySelector(".repository-ide-tool-status").dataset.state = name === "debug" ? "stopped" : "running";
    };
    fixtureSetTool("logs", false);
    window.fixtureGitSlot = host.querySelector(".repository-ide-version-control-slot");
    fixtureGitSlot.id = "fixture-ide-version-control-slot";
    fixtureGitSlot.append(document.querySelector(".git-panel"));
    document.querySelector("#git-repo-name").textContent = "Review rating";
    document.querySelector("#branch-name").textContent = "main";
    document.querySelector("#change-list").innerHTML = Array.from({ length: 12 }, (_, index) => '<div class="change-row"><input class="change-selector" type="checkbox" aria-label="Select changed file"/><span class="file-status">' + (index % 4 ? 'M' : 'A') + '</span><span class="file-name" tabindex="0"><strong>ReviewService' + index + '.java</strong><small>src/main/java/example</small></span><span class="change-actions"><button title="Stage this file">Stage</button><button class="git-file-destructive-action" title="Inspect and confirm this file action">' + (index % 4 ? 'Revert' : 'Delete') + '</button></span></div>').join('');
    window.fixtureSetGitOpen = open => {
      document.body.classList.toggle("version-control-dock-open", open);
      fixtureIde.dataset.versionControlOpen = String(open); fixtureGitSlot.hidden = !open;
      fixtureGitToggle.setAttribute("aria-pressed", String(open)); fixtureGitToggle.setAttribute("aria-expanded", String(open));
    };
    void 0;
  `);
  // Exercise the production split and Git resize controllers without importing app.js.
  for (const file of ["ide-splitter.mjs", "repository-ide-resize.mjs", "git-panel-resize.mjs"]) {
    const source = (await fs.readFile(path.join(root, "public", file), "utf8"))
      .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
    await window.webContents.executeJavaScript(source);
  }
  await window.webContents.executeJavaScript(`
    window.fixtureSplit = createRepositoryWorkbenchResize({ document, storage: null });
    window.fixtureGit = setupGitPanelResize({ document, storage: null });
    void 0;
  `);
  const treeDisclosure = await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.repository-ide-tree-row[aria-expanded]');
    const chevron = row.querySelector('.repository-ide-tree-chevron'), label = row.querySelector('.repository-ide-tree-name');
    const r = row.getBoundingClientRect(), c = chevron.getBoundingClientRect(), l = label.getBoundingClientRect();
    const openTransform = getComputedStyle(chevron).transform;
    row.setAttribute('aria-expanded', 'false'); const closedTransform = getComputedStyle(chevron).transform; row.setAttribute('aria-expanded', 'true');
    return { width:c.width, height:c.height, centerOffset:Math.abs((c.top + c.bottom) / 2 - (r.top + r.bottom) / 2), gap:l.left - c.right, openTransform, closedTransform };
  })()`);
  assert.equal(treeDisclosure.width, 14); assert.equal(treeDisclosure.height, 14);
  assert.ok(treeDisclosure.centerOffset <= .5, JSON.stringify(treeDisclosure)); assert.equal(treeDisclosure.gap, 6);
  assert.equal(treeDisclosure.openTransform, "none"); assert.equal(treeDisclosure.closedTransform, "matrix(0, -1, 1, 0, 0, 0)");
  const measurements = [];
  for (const width of [1440, 980, 800, 420]) for (const height of [900, 500]) for (const zoom of [1, 1.22]) for (const zoomMode of ["native", "body"]) for (const context of [false, true]) for (const chatHidden of [false, true]) {
    await setViewport(width, height, zoomMode === "native" ? zoom : 1);
    const result = await window.webContents.executeJavaScript(`(async () => {
      document.body.style.zoom = ${zoomMode === "body" ? zoom : 1};
      document.body.classList.toggle("task-context-visible", ${context});
      document.body.classList.toggle("repository-ide-chat-hidden", ${chatHidden});
      const body = document.body, canvas = document.querySelector(".ai-canvas"), workbench = document.querySelector("#repository-workbench");
      fixtureSplit.setContext("layout-test", ${!chatHidden});
      fixtureGit.refresh();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const capture = () => ({ editor: rect(document.querySelector("#repository-ide-host")), chat: rect(document.querySelector(".ai-main-content")) });
      const panel = selector => {
        const element = document.querySelector(selector), r = rect(element);
        const hit = document.elementFromPoint(r.left + Math.min(15, r.width / 2), r.top + 15);
        return { ...r, owner: element.offsetParent?.id, hit: element === hit || element.contains(hit), hitTarget: hit?.id || hit?.className, display: getComputedStyle(element).display };
      };
      fixtureSetGitOpen(false); canvas.classList.add("task-panel-collapsed");
      const closed = capture(), hidden = [".git-panel", ".task-sidebar"].map(selector => document.querySelector(selector).getClientRects().length ? "visible" : "none");
      const closedMain = rect(document.querySelector(".repository-ide-main"));
      canvas.classList.remove("task-panel-collapsed");
      const tasks = panel(".task-sidebar"), withTasks = capture();
      canvas.classList.add("task-panel-collapsed"); fixtureSetGitOpen(true);
      fixtureGit.refresh();
      const git = panel(".git-panel"), withGit = capture();
      for (let index = 0; index < 4; index++) fixtureGit.handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true }));
      const resized = panel(".git-panel"), withResizedGit = capture();
      const acceptedWidth = Number(fixtureGit.handle.getAttribute("aria-valuenow"));
      const editorBody = rect(document.querySelector(".repository-ide-body")), toolbar = rect(document.querySelector(".repository-ide-toolbar"));
      const gitPanel = document.querySelector(".git-panel"), gitContent = document.querySelector("#git-changes");
      const gitLayout = { main: rect(document.querySelector(".repository-ide-main")), closedMain, body: editorBody, toolbar, toggle: rect(fixtureGitToggle), slot: rect(fixtureGitSlot), handle: rect(fixtureGit.handle), treeDisplay: getComputedStyle(document.querySelector(".repository-ide-tree-pane")).display, dividerDisplay: getComputedStyle(document.querySelector(".repository-ide-tree-divider")).display, treePreference: fixtureIde.dataset.treeHidden, cssWidth: fixtureIde.clientWidth, contentHeight: gitContent.clientHeight, overflow: getComputedStyle(gitPanel).overflowY, clippedHeight: gitPanel.scrollHeight - gitPanel.clientHeight };
      if (gitLayout.clippedHeight > 1) {
        gitPanel.scrollTop = gitPanel.scrollHeight;
        gitLayout.scrolledPush = rect(document.querySelector("#push-button"));
        gitLayout.scrollTop = gitPanel.scrollTop;
        gitPanel.scrollTop = 0;
      }
      fixtureGit.handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
      const chatStyle = getComputedStyle(document.querySelector(".ai-main-content"));
      const splitter = document.querySelector("#repository-workbench-resizer");
      return { workbench: rect(workbench), chatLayout: workbench.dataset.chatLayout, scale: rect(workbench).width / workbench.offsetWidth, rail: parseFloat(getComputedStyle(body).getPropertyValue("--tools-rail-width")), hidden, closed, tasks, withTasks, git, withGit, resized, withResizedGit, gitLayout, acceptedWidth, containers: chatStyle.containerName, containerType: chatStyle.containerType, chatDisplay: chatStyle.display, splitter: { ...rect(splitter), display: getComputedStyle(splitter).display, orientation: splitter.getAttribute("aria-orientation") }, viewport: { width: innerWidth, height: innerHeight } };
    })()`);
    const label = `${width}x${height}px ${zoomMode} zoom=${zoom} context=${context} chatHidden=${chatHidden}`;
    near(result.closed.editor.left, result.workbench.left + result.rail * result.scale, `${label}: editor starts after rail`);
    near(result.closed.editor.top, result.workbench.top, `${label}: code starts at workbench top`);
    near(result.closed.editor.bottom, result.workbench.bottom, `${label}: editor always has full height`);
    if (chatHidden) {
      near(result.closed.editor.right, result.workbench.right, `${label}: hiding chat gives code full width`);
      assert.equal(result.chatDisplay, "none", `${label}: chat is fully hidden`);
      assert.equal(result.splitter.display, "none", `${label}: hidden chat has no splitter`);
    } else if (result.chatLayout === "overlay") {
      near(result.closed.editor.right, result.workbench.right, `${label}: narrow drawer keeps full-width editor beneath it`);
      near(result.closed.chat.right, result.workbench.right, `${label}: narrow chat stays on the right`);
      near(result.closed.chat.top, result.gitLayout.toolbar.bottom, `${label}: narrow chat leaves toolbar controls reachable`);
      near(result.closed.chat.bottom, result.workbench.bottom, `${label}: narrow chat fills remaining height`);
      near(result.closed.chat.width, Math.min(360 * result.scale, result.workbench.width - result.rail * result.scale), `${label}: drawer retains a usable width rather than its inherited grid slot`);
      assert.ok(result.closed.chat.left >= result.closed.editor.left - 1.5, `${label}: drawer never covers tools rail`);
      assert.equal(result.splitter.display, "none", `${label}: narrow drawer does not offer a misleading resize handle`);
    } else {
      near(result.splitter.left, result.closed.editor.right, `${label}: divider is beside code`);
      near(result.closed.chat.left, result.splitter.right, `${label}: chat is right of the divider`);
      near(result.closed.chat.right, result.workbench.right, `${label}: chat reaches the right edge`);
      near(result.closed.chat.top, result.workbench.top, `${label}: chat has full-height conversation space`);
      near(result.closed.chat.bottom, result.workbench.bottom, `${label}: chat fills available height`);
      assert.equal(result.splitter.orientation, "vertical", `${label}: divider resizes horizontally`);
      assert.ok(result.closed.editor.width >= 359 * result.scale && result.closed.chat.width >= 279 * result.scale, `${label}: both panes keep usable widths`);
    }
    assert.deepEqual(result.hidden, ["none", "none"], `${label}: collapsed panels stay hidden`);
    for (const panel of [result.tasks]) {
      assert.equal(panel.owner, "repository-workbench", `${label}: drawer containing block`);
      near(panel.left, result.workbench.left + result.rail * result.scale, `${label}: aligned after tools rail`);
      near(panel.top, result.workbench.top, `${label}: full workbench top`);
      near(panel.bottom, result.workbench.bottom, `${label}: full workbench height`);
      assert.ok(panel.right <= result.workbench.right + 1.5, `${label}: drawer stays in workspace`);
      assert.equal(panel.hit, true, `${label}: drawer is visible and receives input ${JSON.stringify(panel)}`);
    }
    const layout = result.gitLayout;
    near(layout.body.top, layout.toolbar.bottom, `${label}: Git body begins below the toolbar`);
    assert.equal(layout.treeDisplay, "none", `${label}: Git replaces the tree without doubling the sidebar`);
    assert.equal(layout.dividerDisplay, "none", `${label}: hidden tree has no resize divider`);
    assert.equal(layout.treePreference, "false", `${label}: opening Git preserves the files preference`);
    for (const panel of [result.git, result.resized]) {
      assert.equal(panel.owner, "fixture-ide-version-control-slot", `${label}: Git is owned by its IDE slot`);
      near(panel.left, layout.body.left, `${label}: Git begins at the editor body edge`);
      near(panel.top, layout.body.top, `${label}: Git never covers the toolbar`);
      near(panel.bottom, layout.body.bottom, `${label}: Git fits the code pane, not the chat`);
      assert.ok(panel.right <= layout.body.right + 1.5, `${label}: Git stays inside the editor`);
      const chatCoversHit = !chatHidden && result.chatLayout === "overlay" && panel.left + 15 >= result.closed.chat.left && panel.top + 15 >= result.closed.chat.top;
      if (!chatCoversHit) assert.equal(panel.hit, true, `${label}: Git receives input outside the narrow chat drawer ${JSON.stringify(panel)}`);
    }
    assert.ok(layout.toggle.left >= layout.toolbar.left - 1.5 && layout.toggle.right <= layout.toolbar.right + 1.5, `${label}: Version Control icon stays reachable`);
    assert.ok(layout.handle.left >= result.resized.left - 1.5 && layout.handle.right <= result.resized.right + 1.5, `${label}: Git resize handle stays within dock bounds`);
    near(layout.handle.top, result.resized.top, `${label}: resize handle starts below the toolbar`);
    near(layout.handle.bottom, result.resized.bottom, `${label}: resize handle fits the dock height`);
    assert.ok(layout.contentHeight >= 60, `${label}: Git changes keep a usable scroll area even in short editors`);
    if (layout.clippedHeight > 1) {
      assert.match(layout.overflow, /auto|scroll/, `${label}: overflowing Git controls are reachable by scrolling`);
      assert.ok(layout.scrollTop > 0, `${label}: short-height Git scrolls independently`);
      assert.ok(layout.scrolledPush.top >= result.resized.top - 1.5 && layout.scrolledPush.bottom <= result.resized.bottom + 1.5, `${label}: bottom Git actions can be reached inside the dock`);
    }
    near(layout.main.right, layout.body.right, `${label}: code remains within the IDE body`);
    if (layout.cssWidth > 620) {
      near(layout.main.left, result.resized.right, `${label}: wide layouts split Git and code without overlap`);
      assert.ok(layout.main.width >= 220 * result.scale, `${label}: wide layouts preserve usable code width`);
    } else {
      near(layout.main.left, layout.body.left, `${label}: narrow layouts overlay Git instead of squeezing code`);
      near(layout.main.width, layout.body.width, `${label}: narrow editor keeps its full width beneath Git`);
    }
    for (const state of [result.withTasks, result.withGit, result.withResizedGit]) assert.deepEqual(state, result.closed, `${label}: opening/resizing drawers preserves editor and chat bounds`);
    near(result.resized.width, result.acceptedWidth * result.scale, `${label}: existing Git resize controller controls actual width`);
    assert.ok(result.resized.width >= result.git.width, `${label}: right arrows grow the drawer when bounds permit`);
    assert.equal(result.containerType, "size", `${label}: compact-height chat queries retained`);
    assert.equal(result.containers, "repository-chat chat-layout", `${label}: both responsive chat containers retained`);
    if (process.env.ARGUS_IDE_LAYOUT_CAPTURE === "1" && zoomMode === "body" && !context && ((width === 1440 && height === 900 && zoom === 1) || (width === 420 && height === 500 && zoom === 1.22))) {
      await window.webContents.executeJavaScript('(async () => { fixtureSetGitOpen(true); fixtureGit.refresh(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })();');
      await fs.writeFile(path.join(temporary, `layout-${width}-${chatHidden ? "chat-hidden" : "chat-visible"}-git.png`), (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript('(async () => { fixtureSetGitOpen(false); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })();');
      await fs.writeFile(path.join(temporary, `layout-${width}-${chatHidden ? "chat-hidden" : "chat-visible"}.png`), (await window.webContents.capturePage()).toPNG());
    }
    measurements.push(label);
  }
  const scrollMeasurements = [];
  for (const width of [1440, 980, 800, 420]) for (const zoom of [1, 1.22]) {
    await setViewport(width, 500);
    const result = await window.webContents.executeJavaScript(`(async () => {
      document.body.style.zoom = ${zoom};
      document.body.classList.remove("repository-ide-chat-hidden", "task-context-visible"); fixtureSetGitOpen(false);
      document.querySelector(".ai-canvas").classList.add("task-panel-collapsed");
      fixtureSplit.setContext("scroll-test", true);
      const main = document.querySelector(".ai-main-content"), scroll = main.querySelector(".chat-scroll-region"), conversation = main.querySelector(".chat-thread");
      conversation.classList.remove("is-empty");
      conversation.innerHTML = '<div class="chat-message assistant"><div class="chat-message-body"><div class="chat-message-content">' + '<p class="chat-paragraph">A long response stays inside the chat pane while the editor remains in place.</p>'.repeat(80) + '</div></div></div>';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const editor = document.querySelector("#repository-ide-host"), before = editor.getBoundingClientRect().toJSON();
      scroll.scrollTop = scroll.scrollHeight;
      main.scrollTop = main.scrollHeight;
      const mainRect = main.getBoundingClientRect(), send = main.querySelector("#run-agent").getBoundingClientRect();
      return { before, after: editor.getBoundingClientRect().toJSON(), conversationHeight: scroll.clientHeight, conversationScrolled: scroll.scrollTop > 0, mainBottom: mainRect.bottom, mainTop: mainRect.top, sendTop: send.top, sendBottom: send.bottom, pageScrolled: document.documentElement.scrollTop || document.body.scrollTop, chatOverflow: getComputedStyle(main).overflowY };
    })()`);
    const label = `${width}x500px body zoom=${zoom}`;
    assert.deepEqual(result.before, result.after, `${label}: scrolling chat does not move code`);
    assert.ok(result.conversationHeight >= 63, `${label}: conversation retains its own scroll area`);
    assert.equal(result.conversationScrolled, true, `${label}: long responses scroll within chat`);
    assert.equal(result.chatOverflow, "auto", `${label}: short chat lets overflowing controls scroll`);
    assert.equal(result.pageScrolled, 0, `${label}: shell does not scroll`);
    assert.ok(result.sendTop >= result.mainTop - 1.5 && result.sendBottom <= result.mainBottom + 1.5, `${label}: send button is reachable after scrolling chat`);
    scrollMeasurements.push(label);
  }
  const toolMeasurements = [];
  const toolCases = [
    { name: "logs", open: false },
    { name: "terminal", open: true }, { name: "logs", open: true }, { name: "debug", open: true },
    { name: "debug", open: true, debugView: "console" },
    { name: "terminal", open: true, maximized: true }, { name: "logs", open: true, maximized: true }, { name: "debug", open: true, maximized: true },
  ];
  for (const width of [1440, 800, 420]) for (const height of [900, 500]) for (const zoom of [1, 1.22]) for (const chatHidden of [false, true]) for (const scenario of toolCases) {
    await setViewport(width, height, zoom);
    const result = await window.webContents.executeJavaScript(`(async () => {
      document.body.style.zoom = "1";
      document.body.classList.remove("task-context-visible");
      document.body.classList.toggle("repository-ide-chat-hidden", ${chatHidden});
      document.querySelector(".ai-canvas").classList.add("task-panel-collapsed");
      fixtureSetGitOpen(false); fixtureSplit.setContext("tool-layout-test", ${!chatHidden});
      const scenario = ${JSON.stringify(scenario)};
      fixtureSetTool(scenario.name, scenario.open, scenario.maximized, scenario.debugView);
      const main = document.querySelector(".repository-ide-main"), content = document.querySelector(".repository-ide-tool-content");
      main.style.setProperty("--ide-tool-height", "260px");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const visible = element => getComputedStyle(element).display !== "none" && element.getClientRects().length > 0;
      const selected = [...content.children].filter(visible);
      const panel = selected[0];
      const selectedOutput = scenario.name === "logs" ? document.querySelector(".repository-ide-process-logs-output")
        : scenario.name === "debug" && scenario.debugView === "console" ? document.querySelector(".repository-ide-debug-output") : null;
      const measureScroll = element => {
        const previous = element.scrollTop; element.scrollTop = element.scrollHeight;
        const value = { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrolled: element.scrollTop > 0, overflow: getComputedStyle(element).overflowY };
        element.scrollTop = previous; return value;
      };
      const debug = document.querySelector(".repository-ide-debug");
      const inspectionScroll = scenario.name === "debug" && scenario.debugView !== "console" && scenario.open
        ? [debug, ...debug.querySelectorAll(".repository-ide-debug-inspector")].map(measureScroll) : [];
      const tabs = [...document.querySelectorAll(".repository-ide-tool-tab")];
      return { main: rect(main), dock: rect(fixtureToolDock), header: rect(document.querySelector(".repository-ide-tool-header")), content: rect(content),
        code: rect(document.querySelector(".repository-ide-editor-wrap")), codeVisible: visible(document.querySelector(".repository-ide-editor-wrap")),
        contentVisible: visible(content), resizerVisible: visible(document.querySelector(".repository-ide-tool-resizer")),
        selected: selected.map(element => element.className), panel: panel ? rect(panel) : null,
        hiddenPanels: [...content.children].filter(element => element.hidden).every(element => getComputedStyle(element).display === "none" && element.getClientRects().length === 0),
        selectedTabs: tabs.filter(tab => tab.getAttribute("aria-selected") === "true").map(tab => tab.dataset.tool),
        tabStops: tabs.filter(tab => tab.tabIndex === 0).length,
        mainOverflow: main.scrollWidth - main.clientWidth, panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : 0,
        terminal: rect(document.querySelector("#terminal-panel")), terminalResizerVisible: visible(document.querySelector("#terminal-resizer")),
        output: selectedOutput && scenario.open ? measureScroll(selectedOutput) : null, inspectionScroll,
        nestedVisible: scenario.name === "debug" && scenario.open ? [".repository-ide-debug-inspectors", ".repository-ide-debug-console-panel", ".repository-ide-debug-breakpoint-panel"].filter(selector => visible(debug.querySelector(selector))) : [],
        maximizeVisible: visible(fixtureToolMaximize), minimizeVisible: visible(fixtureToolMinimize),
        scale: rect(main).width / main.offsetWidth, mainHeight: main.clientHeight,
        pageScrolled: document.documentElement.scrollTop || document.body.scrollTop,
      };
    })()`);
    const label = `${width}x${height}px zoom=${zoom} chatHidden=${chatHidden} ${scenario.name}/${scenario.debugView || "inspect"} open=${scenario.open} maximized=${Boolean(scenario.maximized)}`;
    const expectedPanel = { terminal: "repository-ide-terminal-slot", logs: "repository-ide-run-logs", debug: "repository-ide-debug" }[scenario.name];
    assert.equal(result.hiddenPanels, true, `${label}: hidden flex panes never consume layout space`);
    assert.equal(result.tabStops, 1, `${label}: dock keeps one tab stop`);
    assert.deepEqual(result.selectedTabs, scenario.open ? [scenario.name] : [], `${label}: only the active open tool is selected`);
    assert.deepEqual(result.selected, scenario.open ? [expectedPanel] : [], `${label}: tools share one pane`);
    assert.equal(result.contentVisible, scenario.open, `${label}: collapsed dock hides content`);
    assert.equal(result.codeVisible, !scenario.maximized, `${label}: maximize and restore affect code visibility`);
    assert.equal(result.maximizeVisible, scenario.open, `${label}: maximize follows dock visibility`);
    assert.equal(result.minimizeVisible, scenario.open, `${label}: minimize follows dock visibility`);
    assert.equal(result.resizerVisible, scenario.open && !scenario.maximized, `${label}: only expanded split tools expose a resizer`);
    assert.equal(result.terminalResizerVisible, false, `${label}: terminal has no competing resize handle`);
    assert.equal(result.pageScrolled, 0, `${label}: tools do not scroll the whole page`);
    assert.ok(result.mainOverflow <= 1 && result.panelOverflow <= 1, `${label}: long identities and output fit the editor width ${JSON.stringify(result)}`);
    near(result.dock.left, result.main.left, `${label}: dock begins at code column`);
    near(result.dock.right, result.main.right, `${label}: dock fills code column`);
    near(result.dock.bottom, result.main.bottom, `${label}: dock stays anchored below code`);
    assert.ok(result.dock.top >= result.main.top - 1.5, `${label}: dock stays within editor`);
    if (!scenario.open) near(result.dock.height, 36 * result.scale, `${label}: collapsed dock retains compact tabs aligned with Git actions`);
    else {
      near(result.panel.left, result.content.left, `${label}: selected pane aligns with shared content`);
      near(result.panel.right, result.content.right, `${label}: selected pane uses full content width`);
      near(result.panel.top, result.content.top, `${label}: selected pane begins beneath tabs`);
      near(result.panel.bottom, result.content.bottom, `${label}: selected pane fills dock height`);
      if (scenario.maximized) near(result.dock.top, result.main.top, `${label}: maximized dock fills code area`);
      else {
        assert.ok(result.code.bottom <= result.dock.top + 1.5, `${label}: tool panel never overlays code`);
        if (result.mainHeight >= 220) assert.ok(result.code.height >= 98 * result.scale, `${label}: split panel preserves readable code height`);
      }
      if (scenario.name === "terminal") { near(result.terminal.left, result.panel.left, `${label}: existing terminal is docked`); near(result.terminal.bottom, result.panel.bottom, `${label}: terminal fits pane height`); }
      if (result.output && result.content.height > 80 * result.scale) assert.equal(result.output.scrolled, true, `${label}: output scrolls independently`);
      if (scenario.name === "debug") {
        assert.deepEqual(result.nestedVisible, [scenario.debugView === "console" ? ".repository-ide-debug-console-panel" : ".repository-ide-debug-inspectors"], `${label}: hidden debug tabs occupy no space`);
        if (scenario.debugView !== "console" && result.content.height > 60 * result.scale) assert.ok(result.inspectionScroll.some(item => item.scrolled), `${label}: stack and variables stay reachable by scrolling`);
      }
    }
    if (process.env.ARGUS_IDE_LAYOUT_CAPTURE === "1" && scenario.open && zoom === 1 && chatHidden && ((width === 1440 && height === 900 && !scenario.maximized && scenario.debugView !== "console") || (width === 420 && height === 500 && scenario.maximized && scenario.name !== "terminal"))) {
      await fs.writeFile(path.join(temporary, `dock-${width}-${scenario.name}${scenario.maximized ? "-maximized" : ""}.png`), (await window.webContents.capturePage()).toPNG());
    }
    toolMeasurements.push(label);
  }
  await window.webContents.executeJavaScript('fixtureSetTool("logs", false);');
  if (process.env.ARGUS_IDE_LAYOUT_CAPTURE === "1") {
    for (const [width, height, zoom] of [[1440, 900, 1], [1024, 768, 1], [1440, 900, 1.12], [440, 900, 1]]) {
      await setViewport(width, height, zoom);
      await window.webContents.executeJavaScript(`(async () => {
        document.body.style.zoom = "1";
        document.documentElement.dataset.fontFamily = "comic-sans";
        document.body.classList.add("task-context-visible");
        document.body.classList.remove("repository-ide-chat-hidden");
        fixtureSetGitOpen(false); fixtureSplit.setContext("right-dock-capture", true);
        const conversation = document.querySelector(".chat-thread");
        conversation.innerHTML = '<div class="chat-message assistant"><div class="chat-message-body"><div class="chat-message-content"><p class="chat-paragraph">The retry flow is now easier to follow.</p><ul class="chat-list"><li>Validation stays in the controller.</li><li>Retry handling is shared by the service.</li><li>Existing responses keep the same shape.</li></ul><p class="chat-paragraph">The editor, terminal and this conversation remain available side by side.</p></div></div></div>';
        document.querySelector(".chat-scroll-region").scrollTop = 0;
        document.querySelector(".ai-main-content").scrollTop = 0;
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))));
      })()`);
      await fs.writeFile(path.join(temporary, `right-dock-${width}x${height}-zoom-${zoom}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  await setViewport(1440, 900);
  const normal = await window.webContents.executeJavaScript(`(async () => {
    document.body.style.zoom = "1";
    fixtureSetGitOpen(false);
    const treeRestored = getComputedStyle(document.querySelector(".repository-ide-tree-pane")).display !== "none";
    const tree = document.querySelector(".repository-ide-tree-pane"), divider = document.querySelector(".repository-ide-tree-divider");
    fixtureIde.dataset.treeHidden = "true"; tree.hidden = true; divider.hidden = true;
    fixtureSetGitOpen(true); fixtureSetGitOpen(false);
    const hiddenTreePreserved = tree.hidden && divider.hidden && getComputedStyle(tree).display === "none";
    // A stale open preference must not leak Version Control into non-IDE screens.
    fixtureSetGitOpen(true);
    document.body.classList.remove("repository-ide-enabled", "repository-ide-chat-hidden", "task-context-visible");
    document.querySelector("#repository-ide-host").hidden = true;
    fixtureSplit.setContext("layout-test", false);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector(".ai-canvas"), bounds = canvas.getBoundingClientRect();
    return { before: fixtureNormal, after: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, columns: getComputedStyle(canvas).gridTemplateColumns }, treeRestored, hiddenTreePreserved, gitHidden: document.querySelector(".git-panel").getClientRects().length === 0, toggleHidden: fixtureGitToggle.getClientRects().length === 0, railToggleRemoved: !document.querySelector("#version-control-rail-toggle") };
  })()`);
  assert.deepEqual(normal.after, normal.before, "disabling IDE restores the normal chat layout");
  assert.equal(normal.treeRestored, true, "closing Git restores the visible files pane");
  assert.equal(normal.hiddenTreePreserved, true, "closing Git does not reveal a previously hidden files pane");
  assert.equal(normal.gitHidden, true, "disabling IDE hides Git even if its open preference is stale");
  assert.equal(normal.toggleHidden, true, "Git toolbar action is unavailable without IDE");
  assert.equal(normal.railToggleRemoved, true, "Version Control is removed from the global tools rail");
  console.log(`IDE_LAYOUT_RESULT=${JSON.stringify({ ok: true, scenarios: measurements.length, scrollScenarios: scrollMeasurements.length, toolScenarios: toolMeasurements.length, sharedToolDock: true, normalLayoutRestored: true, gitIdeOnly: true, treePreferencePreserved: true, electron: process.versions.electron })}`);
  close(0);
}).catch(error => { console.error(error.stack); close(1); });
