// Full production CSS/markup, isolated native renderer, synthetic metadata only.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-ai-context-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, unexpectedNetworkCount = 0;
const timer = setTimeout(() => { console.error("AI context fixture timed out"); app.exit(1); }, 75_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };

app.whenReady().then(async () => {
  const sourceShell = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const stylesheets = [...sourceShell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  assert.ok(stylesheets.includes("ai-context-header.css"));
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = sourceShell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style>`);
  const isolated = session.fromPartition("ai-context-regression", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { unexpectedNetworkCount++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  for (const file of ["ide-splitter.mjs", "repository-ide-resize.mjs", "ai-context-header.mjs"]) {
    await window.webContents.executeJavaScript((await fs.readFile(path.join(root, "public", file), "utf8")).replace(/^import .*;\n/gm, "").replace(/^export /gm, ""));
  }
  await window.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector);
    document.body.dataset.view = "repository"; document.body.classList.add("task-context-visible");
    $("#workspace").classList.remove("hidden"); $("#empty-state").classList.add("hidden");
    $(".ai-canvas").classList.add("task-panel-collapsed");
    $("#agent-conversation").classList.remove("is-empty");
    $("#agent-conversation").innerHTML = '<article class="chat-message assistant"><div class="chat-message-body"><div class="chat-message-meta">Argus</div><div class="chat-message-content"><p>Your chat has more room. Connection and repository details are one click away.</p></div></div></article>';
    $("#local-ai-provider").textContent = "Codex authenticated";
    $("#local-ai-version").textContent = "codex-cli 0.162.0-alpha.17.2 · ChatGPT · Current account reports capacity";
    $("#local-ai-repository").textContent = "/synthetic/post-orders/customer-facing-nextjs-web-with-a-very-long-name";
    $("#local-codex-title").textContent = "customer-facing-nextjs-web AI";
    const fixture = window.fixture = {};
    fixture.header = createAiContextHeader({ document, window });
    fixture.split = createRepositoryWorkbenchResize({ document, storage: null });
    fixture.frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fixture.update = () => fixture.header.update({ providerName:"Codex", status:"Connected · account reports capacity", readiness:"ready", repositoryName:"customer-facing-nextjs-web", mode:"edit" });
    fixture.update();
    fixture.measure = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      const button = $("#local-ai-info-toggle"), header = $(".ai-sticky-header"), panel = $("#local-ai-details"), main = $(".ai-main-content");
      return { visible:button.checkVisibility(), button:rect(button), header:rect(header), main:rect(main), panel:rect(panel), expanded:button.getAttribute("aria-expanded"), isOpen:panel.matches(":popover-open"), buttonOverflow:button.scrollWidth > button.clientWidth + 1, panelOverflow:panel.scrollWidth > panel.clientWidth + 1, width:innerWidth, height:innerHeight, cssHeight:parseFloat(getComputedStyle(header).height), padding:parseFloat(getComputedStyle(panel).paddingLeft), allFields:["local-ai-provider","local-ai-version","local-ai-repository","local-ai-access","local-codex-title"].every(id => document.getElementById(id).checkVisibility()) };
    };
    void 0;
  `);
  let layoutScenarios = 0;
  for (const [width, height] of [[1440,900], [1024,768], [440,900], [700,420]]) {
    window.setContentSize(width, height);
    await window.webContents.executeJavaScript(`new Promise((resolve,reject) => { let n=0; const end=Date.now()+5000; const check=()=> { n=Math.abs(innerWidth-${width})<=1 && Math.abs(innerHeight-${height})<=1?n+1:0; if(n>=2) resolve(); else if(Date.now()>end) reject(new Error('Viewport did not settle')); else requestAnimationFrame(check); }; check(); })`);
    for (const zoom of [1, 1.22]) for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans"]) for (const ide of [true, false]) {
      const scenario = { width, height, zoom, theme, font, ide };
      const collapsed = await window.webContents.executeJavaScript(`(async () => {
        fixture.header.close(); document.body.style.zoom = ${zoom}; document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.documentElement.dataset.fontFamily = ${JSON.stringify(font)};
        document.body.classList.toggle("repository-ide-enabled", ${ide}); $("#repository-ide-host").hidden = ${!ide};
        fixture.split.setContext("synthetic", ${ide}); fixture.split.refresh(); await fixture.frames(); return fixture.measure();
      })()`);
      const diagnostic = JSON.stringify({ scenario, collapsed });
      assert.equal(collapsed.visible, true, diagnostic);
      assert.ok(collapsed.cssHeight <= 34, `Header wastes vertical space: ${diagnostic}`);
      assert.equal(collapsed.buttonOverflow, false, diagnostic);
      assert.ok(collapsed.button.left >= collapsed.main.left - 1 && collapsed.button.right <= collapsed.main.right + 1, diagnostic);
      const expanded = await window.webContents.executeJavaScript(`(async () => { $("#local-ai-info-toggle").click(); await fixture.frames(); return fixture.measure(); })()`);
      const details = JSON.stringify({ scenario, expanded });
      assert.equal(expanded.isOpen, true, details); assert.equal(expanded.expanded, "true", details);
      assert.equal(expanded.allFields, true, details); assert.equal(expanded.panelOverflow, false, details);
      assert.ok(expanded.padding >= 14, details);
      assert.ok(expanded.panel.left >= 11 && expanded.panel.right <= expanded.width - 11 && expanded.panel.top >= 11 && expanded.panel.bottom <= expanded.height - 11, details);
      if (width === 1440 && zoom === 1 && theme === "dark" && font === "system" && ide || width === 440 && zoom === 1.22 && theme === "dark" && font === "comic-sans" && ide) {
        await fs.writeFile(path.join(temporary, `ai-details-${width}.png`), (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript(`fixture.header.close(); void 0;`);
        await fs.writeFile(path.join(temporary, `ai-summary-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      layoutScenarios++;
    }
  }
  await window.webContents.executeJavaScript(`fixture.header.close(); $("#local-ai-info-toggle").click(); void 0;`);
  window.webContents.sendInputEvent({ type:"mouseDown", x:5, y:5, button:"left", clickCount:1 });
  window.webContents.sendInputEvent({ type:"mouseUp", x:5, y:5, button:"left", clickCount:1 });
  await window.webContents.executeJavaScript(`fixture.frames()`);
  assert.equal(await window.webContents.executeJavaScript(`$("#local-ai-details").matches(":popover-open")`), false, "Native outside click closes the top-layer popover");
  const behaviorChecks = 1 + await window.webContents.executeJavaScript(`(async () => {
    let checks = 0; const assert = (value, label) => { if (!value) throw new Error(label); checks++; };
    fixture.header.close(); $("#local-ai-info-toggle").click(); $("#local-ai-details-close").click();
    assert(!$("#local-ai-details").matches(":popover-open") && document.activeElement === $("#local-ai-info-toggle"), "Close restores trigger focus");
    $("#local-ai-info-toggle").click(); document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true,cancelable:true}));
    assert(!$("#local-ai-details").matches(":popover-open") && document.activeElement === $("#local-ai-info-toggle"), "Escape closes and restores focus");
    const outsideButton = document.createElement("button"); outsideButton.textContent = "Outside fixture focus target"; document.body.append(outsideButton);
    $("#local-ai-info-toggle").click(); outsideButton.focus(); outsideButton.dispatchEvent(new FocusEvent("focusin", {bubbles:true}));
    assert(!$("#local-ai-details").matches(":popover-open"), "Outside focus closes details: " + document.activeElement?.id);
    outsideButton.remove();
    fixture.header.update({providerName:"<img src=x>", repositoryName:"<script>fixture</script>", readiness:"warning", status:"Usage unknown · retry allowed", mode:"plan"});
    assert(!$("#local-ai-summary-provider").querySelector("img") && $("#local-ai-summary-provider").textContent === "<img src=x>", "Metadata is text, never injected markup");
    assert($("#local-ai-summary-mode").textContent === "Plan" && $("#local-ai-info-toggle").getAttribute("aria-label").includes("Read-only investigation"), "Plan mode accessible summary");
    assert($("#local-ai-summary-status").dataset.state === "warning" && $("#local-ai-info-toggle").title.includes("Usage unknown"), "Unknown capacity is not shown as ready");
    $("#local-ai-info-toggle").click(); $(".ai-sticky-header").style.display = "none"; await fixture.frames();
    assert(!$("#local-ai-details").matches(":popover-open"), "Hiding the repository view dismisses stale context details");
    $(".ai-sticky-header").style.removeProperty("display"); await fixture.frames();
    fixture.header.dispose(); $("#local-ai-info-toggle").click();
    assert(!$("#local-ai-details").matches(":popover-open"), "Disposal removes listeners");
    return checks;
  })()`);
  console.log("AI_CONTEXT_RESULT=" + JSON.stringify({ ok:true, layoutScenarios, behaviorChecks, unexpectedNetworkCount }));
  finish(0);
}).catch(error => { console.error(error); finish(1); });
