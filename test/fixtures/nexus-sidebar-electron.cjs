// Synthetic renderer only: production HTML/CSS and disclosure function, no app
// bootstrap, network, repository data, persisted preferences or AI requests.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-nexus-sidebar-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const timer = setTimeout(() => { console.error("Nexus sidebar layout timed out"); app.exit(1); }, 35_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };

app.whenReady().then(async () => {
  const html = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const stylesheets = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\/([^"?]+)[^"]*"[^>]*>/g)].map(match => match[1]);
  assert.ok(stylesheets.includes("styles.css"));
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${styles}</style>`);
  const source = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  const start = source.indexOf("function setTaskPanelCollapsed(");
  assert.ok(start >= 0);
  const disclosure = source.slice(start, source.indexOf("\n}", start) + 2);
  const binding = source.match(/\$\$\('\[data-task-panel-toggle\]'\)\.forEach\(\(button\) => button\.addEventListener\("click", \(\) => \{[\s\S]*?\n\s*\}\)\);/)?.[0];
  assert.ok(binding, "Bind the production disclosure click handler");
  const { nexusThemeVariables } = await import(pathToFileURL(path.join(root, "public/nexus-themes.mjs")).href);
  const { installChatHistoryPanels } = await import(pathToFileURL(path.join(root, "public/chat-history-panel.mjs")).href);
  const isolated = session.fromPartition("nexus-sidebar-regression", { cache:false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel:!details.url.startsWith("data:") }));
  window = new BrowserWindow({ show:false, width:1440, height:900, webPreferences:{ session:isolated, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  await window.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
    const fixturePreferences = new Map();
    Object.defineProperty(window, "localStorage", { value:{ getItem:key => fixturePreferences.get(key) ?? null, setItem:(key, value) => fixturePreferences.set(key, String(value)) } });
    function closeOpenDialogs() { return true; }
    function setVersionControlDockOpen() {}
    function syncWorkspaceRail() {}
    ${disclosure}
    ${binding}
    (${installChatHistoryPanels.toString()})({document,toggle:(scope,open)=>setTaskPanelCollapsed(scope,!open)});
    if(document.querySelector('#global-context-sidebar').parentElement!==document.querySelector('#nexus-workspace-view'))throw Error('Nexus sidebar was relocated');
    if(document.querySelector('#global-chat-history-toggle')||document.querySelector('#global-context-sidebar').hasAttribute('popover'))throw Error('Nexus must not use a history popover');
    if(!document.querySelector('#repository-chat-history-toggle')||!document.querySelector('#repository-task-sidebar').hasAttribute('popover'))throw Error('Repository history icon is missing');
    document.body.dataset.view = "global";
    document.body.classList.add("task-context-visible");
    $("#global-codex-panel").classList.remove("hidden");
    $("#global-ai-status").textContent = "Codex authenticated";
    $("#global-ai-version").textContent = "Synthetic renderer fixture";
    $("#global-agent-provider").innerHTML = '<option>Codex</option>';
    $("#global-agent-model").innerHTML = '<option>GPT-6-Astra</option>';
    $("#global-agent-speed").innerHTML = '<option>Standard</option>';
    $("#global-agent-config-summary").textContent = "Low · Edit";
    $("#global-task-list").innerHTML = ["InAppChat", "Self Heal", "Slack Alerting Task", "Chat Service", "TMS Knowledge Base", "Current task", "Release notes", "Test coverage", "Observability", "Workspace navigation"].map((name, index) => '<div class="task-row ' + (index ? '' : 'active') + '"><button class="task-row-main"><strong>' + name + '</strong><small>' + (79 + index) + ' messages · 2m ago</small></button><div class="task-row-actions"><button aria-label="Rename task">✎</button><button aria-label="Delete task">×</button></div></div>').join('');
    $("#global-repository-list").innerHTML = ["chc-rookie-ui", "crm-apis", "invoice", "nextjs-web", "playwright_automation", "post-order-cx-bff", "post-order-recommendation-engine", "reviewrating", "ticket-management", "userprofileservice", "promotion-dashboard", "cart-service", "aether", "catalog"].map(name => '<div class="global-repository-item"><span></span><strong>' + name + '</strong></div>').join('');
    $("#global-agent-conversation").classList.remove("is-empty");
    $("#global-agent-conversation").innerHTML = Array.from({ length:14 }, (_, index) => '<article class="chat-message ' + (index % 2 ? 'assistant' : 'user') + '"><div class="chat-message-body"><div class="chat-message-meta">' + (index % 2 ? 'Argus' : 'You') + ' · ' + index + '</div><div class="chat-message-content"><p>' + (index % 2 ? 'The task history and workspace scope remain available whenever you need them. Collapsing the sidebar gives this conversation and its composer the full available width, without changing your chat.' : 'Keep the current task, all messages and my unsent draft while I focus on this conversation.') + '</p></div></div></article>').join('');
    $("#global-agent-prompt").value = "Unsent draft — keep this exact text when I hide or restore the panels.";
    const originalConversation = $("#global-agent-conversation"), originalPrompt = $("#global-agent-prompt");
    const originalMessages = originalConversation.innerHTML, originalDraft = originalPrompt.value;
    window.measureNexus = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      const layout = $(".global-codex-layout"), sidebar = $("#global-context-sidebar"), toggle = $("#nexus-sidebar-toggle"), task = sidebar.querySelector(".task-sidebar-inline"), services = sidebar.querySelector(".global-services-section");
      return {
        viewport:{ width:innerWidth, height:innerHeight }, layout:rect(layout), main:rect(layout.querySelector("main")), composer:rect($(".global-prompt-card")), chat:rect($(".global-chat-scroll-region")), sidebar:rect(sidebar), toggle:rect(toggle), task:rect(task), services:rect(services),
        taskBackground:getComputedStyle(task.querySelector("header")).backgroundColor, servicesBackground:getComputedStyle(services.querySelector("header")).backgroundColor,
        taskBorder:getComputedStyle(task).borderTopWidth, servicesBorder:getComputedStyle(services).borderTopWidth,
        sidebarVisible:sidebar.checkVisibility(), sidebarInert:sidebar.inert, expanded:toggle.getAttribute("aria-expanded"), label:toggle.getAttribute("aria-label"), controls:toggle.getAttribute("aria-controls"), toggleVisible:toggle.checkVisibility(),
        bodyOverflow:document.documentElement.scrollWidth > innerWidth + 1,
        taskScrollable:$("#global-task-list").scrollHeight > $("#global-task-list").clientHeight, servicesScrollable:$("#global-repository-list").scrollHeight > $("#global-repository-list").clientHeight,
        identityPreserved:$("#global-agent-conversation") === originalConversation && $("#global-agent-prompt") === originalPrompt,
        contentPreserved:originalConversation.innerHTML === originalMessages && originalPrompt.value === originalDraft,
        preference:localStorage.getItem("argus-global-tasks-panel")
      };
    };
    setTaskPanelCollapsed("global", false, false);
  `);
  const measure = () => window.webContents.executeJavaScript("window.measureNexus()");
  const settle = () => window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const capture = async (theme, width, phase) => {
    if (process.env.ARGUS_NEXUS_SIDEBAR_CAPTURE === "1" && [1440, 760, 640].includes(width)) await fs.writeFile(path.join(temporary, `nexus-${theme}-${width}-${phase}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const assertInViewport = result => {
    const reason = JSON.stringify(result);
    assert.equal(result.bodyOverflow, false, reason);
    assert.ok(result.layout.left >= 0 && result.layout.right <= result.viewport.width + 1, reason);
    assert.ok(result.main.left >= result.layout.left && result.main.right <= result.layout.right + 1, reason);
    assert.ok(result.composer.left >= result.main.left && result.composer.right <= result.main.right + 1 && result.composer.bottom <= result.viewport.height + 1, reason);
    assert.ok(result.toggleVisible && result.toggle.left >= 0 && result.toggle.right <= result.viewport.width, reason);
    assert.equal(result.controls, "global-context-sidebar");
    assert.equal(result.identityPreserved, true, reason); assert.equal(result.contentPreserved, true, reason);
  };
  let scenarios = 0;
  for (const width of [1440, 1024, 760, 640]) for (const theme of ["dark", "light"]) {
    window.setContentSize(width, 900);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => Math.abs(innerWidth - ${width}) <= 1 ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : ++attempts < 100 ? setTimeout(check, 10) : reject(new Error("Resize did not settle")); check();
    })`);
    await window.webContents.executeJavaScript(`
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      for (const [key, value] of Object.entries(${JSON.stringify(nexusThemeVariables("ocean", theme))})) $("#global-codex-panel").style.setProperty(key, value);
      setTaskPanelCollapsed("global", false, false);
    `);
    await settle();
    const opened = await measure();
    assertInViewport(opened);
    assert.equal(opened.expanded, "true"); assert.equal(opened.sidebarInert, false);
    assert.ok(opened.sidebarVisible && opened.sidebar.width >= 160, JSON.stringify(opened));
    assert.ok(opened.main.left >= opened.sidebar.right + 8, JSON.stringify(opened));
    assert.ok(opened.services.top - opened.task.bottom >= 8, JSON.stringify(opened));
    assert.notEqual(opened.taskBackground, opened.servicesBackground, JSON.stringify(opened));
    assert.ok(parseFloat(opened.taskBorder) >= 1 && parseFloat(opened.servicesBorder) >= 1, JSON.stringify(opened));
    assert.equal(opened.taskScrollable, true); assert.equal(opened.servicesScrollable, true);
    await capture(theme, width, "open");
    for (let pass = 0; pass < 3; pass++) {
      // Programmatic focus on a sidebar control proves collapsing also moves
      // keyboard focus out of the now-inert panel, not just its painted pixels.
      await window.webContents.executeJavaScript(`$("#new-global-task").focus(); $("#nexus-sidebar-toggle").click();`);
      await settle();
      const collapsed = await measure();
      assertInViewport(collapsed);
      assert.equal(collapsed.expanded, "false"); assert.match(collapsed.label, /^Show /);
      assert.equal(collapsed.sidebarInert, true); assert.equal(collapsed.preference, "collapsed");
      assert.ok(collapsed.sidebar.width <= 1 || !collapsed.sidebarVisible, JSON.stringify(collapsed));
      assert.ok(Math.abs(collapsed.main.left - collapsed.layout.left) <= 1 && Math.abs(collapsed.main.width - collapsed.layout.width) <= 1, JSON.stringify(collapsed));
      assert.ok(Math.abs(collapsed.chat.width - collapsed.main.width) <= 1 && Math.abs(collapsed.composer.width - collapsed.main.width) <= 1, JSON.stringify(collapsed));
      assert.ok(collapsed.composer.width - opened.composer.width >= opened.sidebar.width, JSON.stringify({ opened, collapsed }));
      const focus = await window.webContents.executeJavaScript(`(() => { const moved = document.activeElement === $("#nexus-sidebar-toggle"); $("#new-global-task").focus(); return { moved, stayed:document.activeElement === $("#nexus-sidebar-toggle") }; })()`);
      assert.deepEqual(focus, { moved:true, stayed:true });
      if (!pass) await capture(theme, width, "collapsed");
      await window.webContents.executeJavaScript(`$("#nexus-sidebar-toggle").click()`);
      await settle();
      const restored = await measure();
      assertInViewport(restored);
      assert.equal(restored.expanded, "true"); assert.match(restored.label, /^Hide /);
      assert.equal(restored.sidebarInert, false); assert.equal(restored.preference, "open");
      assert.ok(Math.abs(restored.main.width - opened.main.width) <= 1 && Math.abs(restored.sidebar.width - opened.sidebar.width) <= 1, JSON.stringify({ opened, restored }));
    }
    scenarios++;
  }
  console.log("NEXUS_SIDEBAR_RESULT=" + JSON.stringify({ ok:true, scenarios })); finish(0);
}).catch(error => { console.error(error); finish(1); });
