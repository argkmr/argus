// Real shell markup and every linked stylesheet, with only synthetic local
// state. This renderer never launches Argus, its backend, or a user service.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-repository-header-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, unexpectedNetworkCount = 0;
const timer = setTimeout(() => { console.error("Repository header fixture timed out"); app.exit(1); }, 75_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };

function sourceFunction(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Missing application function: ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

app.whenReady().then(async () => {
  const sourceShell = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const stylesheets = [...sourceShell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  assert.ok(stylesheets.includes("repository-ide-shell.css") && stylesheets.includes("font-family.css"));
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = sourceShell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style>`);
  const isolated = session.fromPartition("repository-header-regression", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { unexpectedNetworkCount++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  const application = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  const functions = ["isRepositoryDestination", "repositoryTabHtml", "escapeHtml", "closeRepositoryTabTools", "positionRepositoryTabTools"].map(name => sourceFunction(application, name)).join("\n");
  const toolsEventsStart = application.indexOf('  const tabToolsMenu = $("#repository-tab-tools-menu");');
  const toolsEventsEnd = application.indexOf('  $("#repository-tab-tools-groups").addEventListener', toolsEventsStart);
  assert.ok(toolsEventsStart >= 0 && toolsEventsEnd > toolsEventsStart);
  const toolsEvents = application.slice(toolsEventsStart, toolsEventsEnd);
  await window.webContents.executeJavaScript((await fs.readFile(path.join(root, "public/repository-ports.mjs"), "utf8")).replace(/^export /gm, ""));
  await window.webContents.executeJavaScript((await fs.readFile(path.join(root, "public/repository-context-bar.mjs"), "utf8")).replace(/^export /gm, ""));
  await window.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector);
    const repositories = ["reviewrating", "ticket-management", "post-order-recommendation-engine", "customer-facing-nextjs-web", "invoice", "slack-alerting-spring-boot-starter"].map((name, index) => ({ id: "repo-" + index, name, path: "/synthetic/" + name }));
    const state = { currentView: "repository", activeRepository: repositories[0] };
    ${functions}
    ${toolsEvents}
    $("#repo-tabs").innerHTML = repositories.map(repository => repositoryTabHtml(repository)).join("");
    document.body.dataset.view = "repository"; document.body.classList.add("task-context-visible");
    $("#workspace").classList.remove("hidden"); $("#empty-state").classList.add("hidden");
    renderRepositoryContextSummary(document, {
      repository: { name:"post-order-recommendation-engine", path:"/synthetic/post-order-recommendation-engine" },
      branch:"feature/header-alignment-with-long-repository-and-branch-names", changeCount:128,
    });
    $("#repository-chat-toggle").disabled = false;
    const configuration = { id:"review", repositoryId:"repo-0", name:"Review rating", port:8083, managementPort:10106 };
    const details = { configurationId:"review", repositoryId:"repo-0", applicationPort:8083, managementPort:10106, editable:true, configFile:"src/main/resources/application.yml", contentHash:"synthetic" };
    const fixture = window.fixture = { writeCount:0 };
    fixture.ports = createRepositoryPorts({ host:$("#repository-ports"), document, api:async (_route, options = {}) => {
      if (options.method && options.method !== "GET") { fixture.writeCount++; throw new Error("Writes are forbidden"); }
      return details;
    }});
    fixture.ports.setContext({ repository:repositories[0], configurations:[configuration], processes:[], selectedConfigurationId:"review", visible:true });
    fixture.frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fixture.setState = async ({ theme, font, enabled, ports, bodyZoom }) => {
      document.documentElement.dataset.theme = theme; document.documentElement.dataset.fontFamily = font;
      document.body.style.zoom = String(bodyZoom);
      document.body.classList.add("repository-ide-enabled");
      document.body.classList.toggle("repository-ide-chat-hidden", !enabled);
      $("#repository-ide-host").hidden = false;
      $("#repository-chat-toggle").setAttribute("aria-label", enabled ? "Hide AI chat" : "Show AI chat");
      $("#repository-chat-toggle").setAttribute("aria-pressed", String(enabled));
      fixture.ports.setContext({ visible:ports });
      await fixture.frames();
    };
    fixture.geometry = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height, centerY:(r.top + r.bottom) / 2 }; };
      const groups = selector => [...$(selector).children].filter(node => node.checkVisibility() && rect(node).width > 0).map(node => ({ name:node.id || node.className || node.tagName, ...rect(node) }));
      const control = selector => { const node = $(selector), bounds = rect(node), style = getComputedStyle(node), icon = node.querySelector('svg'); return { ...bounds, visible:node.checkVisibility(), text:node.textContent, title:node.title, label:node.getAttribute('aria-label'), cssWidth:parseFloat(style.width), cssHeight:parseFloat(style.height), icon:icon?{...rect(icon),decorative:icon.getAttribute('aria-hidden')}:null, uncovered:node.contains(document.elementFromPoint((bounds.left + bounds.right) / 2, bounds.centerY)) }; };
      return { width:innerWidth, zoom:getComputedStyle(document.body).zoom, titlebar:rect($(".titlebar")), context:rect($(".context-strip")), top:control("#repository-tab-tools-toggle"), nexus:control("#nexus-shortcut"), project:control("#project-structure-toggle"), chat:control("#repository-chat-toggle"), titleGroups:groups(".titlebar"), contextGroups:groups(".context-strip"), titleOverflow:$(".titlebar").scrollWidth > $(".titlebar").clientWidth + 1, contextOverflow:$(".context-strip").scrollWidth > $(".context-strip").clientWidth + 1, portsVisible:$("#repository-ports").checkVisibility() };
    };
    fixture.openTabTools = async () => {
      const button = $("#repository-tab-tools-toggle");
      if (!$("#repository-tab-tools-menu").matches(":popover-open")) button.click();
      await fixture.frames();
      const menu = $("#repository-tab-tools-menu"), r = menu.getBoundingClientRect(), anchor = button.getBoundingClientRect();
      return { open:menu.matches(":popover-open"), expanded:button.getAttribute('aria-expanded'), left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight, anchorRight:anchor.right, anchorBottom:anchor.bottom, firstActionVisible:$("#add-repo").checkVisibility() };
    };
    void 0;
  `);
  let viewport = "";
  async function resize(width, zoom, mode) {
    const key = [width, zoom, mode].join(":");
    if (viewport === key) return;
    const nativeZoom = mode === "native" ? zoom : 1;
    const physicalWidth = width * zoom, physicalHeight = 900;
    window.setContentSize(physicalWidth, physicalHeight); window.webContents.setZoomFactor(nativeZoom);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let matched = 0, frame;
      const timeout = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error("Header viewport did not settle")); }, 5000);
      const check = () => {
        matched = Math.abs(innerWidth - ${physicalWidth / nativeZoom}) <= 1 ? matched + 1 : 0;
        if (matched >= 2) { clearTimeout(timeout); resolve(); } else frame = requestAnimationFrame(check);
      }; frame = requestAnimationFrame(check);
    })`);
    viewport = key;
  }
  const result = { ok:true, nativeScenarios:0, bodyZoomScenarios:0, tabToolsPopoverScenarios:0, maxRightEdgeOffset:0, maxButtonCenterOffset:0, maxButtonHeightOffset:0 };
  for (const mode of ["native", "body"]) for (const width of [1440, 1050, 820, 700, 680, 640, 380]) for (const zoom of mode === "native" ? [1, 2] : [2]) {
    await resize(width, zoom, mode);
    for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans"]) for (const enabled of [false, true]) for (const ports of [false, true]) {
      const scenario = { width, zoom, mode, theme, font, enabled, ports };
      const geometry = await window.webContents.executeJavaScript(`(async () => { await fixture.setState(${JSON.stringify({ theme, font, enabled, ports, bodyZoom:mode === "body" ? zoom : 1 })}); return fixture.geometry(); })()`);
      const diagnostic = JSON.stringify({ scenario, ...geometry });
      const rightOffset = Math.abs(geometry.project.right - geometry.top.right), centerOffset = Math.abs(geometry.chat.centerY - geometry.project.centerY), heightOffset = Math.abs(geometry.chat.height - geometry.project.height);
      assert.ok(rightOffset <= 1, `Header right edges disagree: ${diagnostic}`);
      assert.ok(centerOffset <= 1 && heightOffset <= 1, `Repository actions have different alignment: ${diagnostic}`);
      assert.equal(geometry.chat.text.trim(), "", `AI chat action must remain icon-only: ${diagnostic}`);
      assert.equal(geometry.chat.label, enabled ? "Hide AI chat" : "Show AI chat");
      assert.equal(geometry.project.label, "Project structure");
      assert.equal(geometry.project.text.trim(), "", `Project structure action must remain icon-only: ${diagnostic}`);
      assert.equal(geometry.chat.cssHeight, 30, diagnostic);
      assert.equal(geometry.project.cssHeight, 30, diagnostic);
      assert.ok(geometry.context.height <= 38 * Number(geometry.zoom) + 1, `Context must remain a single compact row: ${diagnostic}`);
      assert.equal(geometry.top.text.trim(), "", `Tab tools must remain icon-only: ${diagnostic}`);
      assert.equal(geometry.top.title, "Tab tools", diagnostic); assert.equal(geometry.top.label, "Tab tools", diagnostic);
      assert.equal(geometry.top.cssWidth, 30, diagnostic); assert.equal(geometry.top.cssHeight, 30, diagnostic);
      assert.equal(geometry.top.icon.decorative, "true", diagnostic);
      assert.ok(Math.abs(geometry.top.icon.centerY - geometry.top.centerY) <= 1, `Hamburger is not vertically centered: ${diagnostic}`);
      assert.ok(Math.abs((geometry.top.icon.left + geometry.top.icon.right - geometry.top.left - geometry.top.right) / 2) <= 1, `Hamburger is not horizontally centered: ${diagnostic}`);
      assert.ok(Math.abs(geometry.nexus.centerY - geometry.top.centerY) <= 1 && geometry.nexus.right <= geometry.top.left, `Nexus and Tab tools alignment changed: ${diagnostic}`);
      assert.equal(geometry.portsVisible, ports, diagnostic);
      for (const name of ["top", "project", "chat"]) {
        assert.equal(geometry[name].visible, true, diagnostic); assert.equal(geometry[name].uncovered, true, diagnostic);
        assert.ok(geometry[name].left >= -1 && geometry[name].right <= geometry.width + 1, `Header control outside viewport: ${diagnostic}`);
      }
      assert.equal(geometry.titleOverflow, false, diagnostic); assert.equal(geometry.contextOverflow, false, diagnostic);
      assert.ok(geometry.chat.right <= geometry.project.left + 1, `AI chat must lead the repository tools without overlap: ${diagnostic}`);
      for (const groupName of ["titleGroups", "contextGroups"]) {
        const groups = geometry[groupName];
        for (let index = 1; index < groups.length; index++) assert.ok(groups[index - 1].right <= groups[index].left + 1, `Header groups overlap: ${diagnostic}`);
      }
      result.maxRightEdgeOffset = Math.max(result.maxRightEdgeOffset, rightOffset);
      result.maxButtonCenterOffset = Math.max(result.maxButtonCenterOffset, centerOffset);
      result.maxButtonHeightOffset = Math.max(result.maxButtonHeightOffset, heightOffset);
      result[mode === "native" ? "nativeScenarios" : "bodyZoomScenarios"]++;
      if (process.env.ARGUS_HEADER_CAPTURE === "1" && mode === "native" && [1440, 380].includes(width) && font === "comic-sans" && ports && enabled) {
        await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 75))");
        await fs.writeFile(path.join(temporary, `header-${width}-${zoom}x-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      }
      if ([1440, 380].includes(width) && font === "comic-sans" && ports && enabled) {
        const menu = await window.webContents.executeJavaScript('fixture.openTabTools()');
        const menuDiagnostic = JSON.stringify({ scenario, menu });
        assert.equal(menu.open, true, menuDiagnostic); assert.equal(menu.expanded, "true", menuDiagnostic); assert.equal(menu.firstActionVisible, true, menuDiagnostic);
        assert.ok(menu.left >= 0 && menu.top >= 0 && menu.right <= menu.width + 1 && menu.bottom <= menu.height + 1, `Tab tools popover escaped viewport: ${menuDiagnostic}`);
        assert.ok(Math.abs(menu.right - Math.min(menu.anchorRight, menu.width - 12)) <= 1, `Tab tools popover is not right-aligned to the trigger: ${menuDiagnostic}`);
        await window.webContents.executeJavaScript('$("#add-repo").focus()');
        if (process.env.ARGUS_HEADER_CAPTURE === "1" && width === 380) await fs.writeFile(path.join(temporary, `tab-tools-${mode}-${width}-${zoom}x-${theme}.png`), (await window.webContents.capturePage()).toPNG());
        window.webContents.sendInputEvent({ type:"keyDown", keyCode:"Escape" }); window.webContents.sendInputEvent({ type:"keyUp", keyCode:"Escape" });
        await window.webContents.executeJavaScript('fixture.frames()');
        assert.deepEqual(await window.webContents.executeJavaScript('({open:$("#repository-tab-tools-menu").matches(":popover-open"),expanded:$("#repository-tab-tools-toggle").getAttribute("aria-expanded"),focus:document.activeElement.id})'), { open:false, expanded:"false", focus:"repository-tab-tools-toggle" }, menuDiagnostic);
        result.tabToolsPopoverScenarios++;
      }
    }
  }
  result.writeCount = await window.webContents.executeJavaScript("fixture.writeCount"); result.unexpectedNetworkCount = unexpectedNetworkCount;
  assert.equal(result.writeCount, 0); assert.equal(result.unexpectedNetworkCount, 0);
  console.log("REPOSITORY_HEADER_RESULT=" + JSON.stringify(result)); finish(0);
}).catch(error => { console.error(error); finish(1); });
