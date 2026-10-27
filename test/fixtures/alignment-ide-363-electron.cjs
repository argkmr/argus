// Production IDE markup/styles, with synthetic labels only. No backend, user
// repositories, language servers, terminal sessions, or AI providers are used.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-alignment-ide-363-")) throw new Error("An isolated fixture directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, server, unexpectedRequests = 0;
const timer = setTimeout(() => finish(new Error("IDE alignment fixture timed out")), 60_000);
function finish(error, result) {
  clearTimeout(timer);
  if (error) console.error(error.stack || error);
  else console.log("ALIGNMENT_IDE_363=" + JSON.stringify(result));
  window?.destroy(); server?.closeAllConnections(); server?.close(); app.exit(error ? 1 : 0);
}
async function initialize() {
  const { createRepositoryIde } = await import("/legacy/repository-ide.mjs");
  const terminal = document.querySelector("#terminal-panel"), git = document.querySelector(".git-panel");
  document.body.replaceChildren(); document.body.className = "repository-ide-enabled";
  const host = document.createElement("main"); host.style.cssText = "height:100%;width:100%;min-width:0;min-height:0"; document.body.append(host);
  window.fixtureErrors = [];
  window.fixtureIde = createRepositoryIde({ host, api: async () => { throw new Error("No backend calls permitted"); }, onError: error => fixtureErrors.push(error.message) });
  const ide = host.querySelector(".repository-ide"); ide.hidden = false; ide.dataset.treeHidden = "true";
  ide.querySelector(".repository-ide-tree-pane").hidden = true; ide.querySelector(".repository-ide-tree-divider").hidden = true;
  const main = ide.querySelector(".repository-ide-main"); main.dataset.toolMaximized = "true";
  const dock = ide.querySelector(".repository-ide-tool-dock"); dock.dataset.open = "true"; dock.dataset.maximized = "true";
  ide.querySelector(".repository-ide-tool-content").hidden = false;
  ide.querySelector(".repository-ide-version-control-slot").append(git);
  ide.querySelector(".repository-ide-terminal-slot").append(terminal);
  terminal.classList.remove("hidden"); terminal.classList.add("running");
  const longName = "customer-cancellation-notification-recommendation-orchestration-service-with-custom-spring-profile";
  document.querySelector("#terminal-title").textContent = longName + " · zsh";
  document.querySelector("#terminal-cwd").textContent = "/synthetic/" + longName + "/modules/api-service";
  document.querySelector("#terminal-output").textContent = "synthetic-service git:(main) $ ";
  ide.querySelector(".repository-ide-position").textContent = "Ln 1501, Col 241";
  const notice = ide.querySelector(".repository-ide-notice");
  notice.textContent = "src/main/java/com/example/" + longName + "/RepositoryConfigurationWithAnUnusuallyLongButValidClassName.java:1501";
  const debug = ide.querySelector(".repository-ide-debug");
  debug.querySelector(".repository-ide-debug-session-detail").textContent = "Local debug session";
  debug.querySelector(".repository-ide-debug-targets").innerHTML = '<div class="repository-ide-debug-target"><div class="repository-ide-debug-target-info"><strong>' + longName + '</strong><span>Java · 127.0.0.1:5005</span></div><span class="repository-ide-debug-target-state" data-ready="true">Ready to attach</span><button>Attach</button></div>';
  debug.querySelector(".repository-ide-debug-transport").hidden = true;
  const variables = debug.querySelector(".repository-ide-debug-variables");
  variables.innerHTML = '<div class="repository-ide-scope"><strong>Local</strong><div class="repository-ide-variable"><code>customerServiceConfiguration = {endpoint: "http://localhost:8083"}</code></div></div>';
  const stack = debug.querySelector(".repository-ide-debug-stack");
  stack.innerHTML = '<button class="repository-ide-stack-frame"><strong>' + longName + '.initialize</strong><span>Application.java:1501</span></button>';
  const logs = ide.querySelector(".repository-ide-process-logs");
  logs.querySelector(".repository-ide-process-logs-identity").textContent = longName + " · 00000000-0000-0000-0000-000000000000";
  logs.querySelector(".repository-ide-process-logs-status").textContent = "Failed · exit 1";
  logs.querySelector(".repository-ide-process-logs-output").textContent = "12:34:56 [INFO] " + longName + ".java:1501\n12:34:57 [INFO] Synthetic process output.\n";
  window.fixtureSet = async ({ theme, font, panel, populated }) => {
    document.documentElement.dataset.theme = theme; document.documentElement.dataset.fontFamily = font;
    for (const [key, selector] of [["terminal", ".repository-ide-terminal-slot"], ["debug", ".repository-ide-debug"], ["logs", ".repository-ide-run-logs"]]) ide.querySelector(selector).hidden = key !== panel;
    ide.querySelector(".repository-ide-debug-targets").hidden = !populated;
    notice.textContent = populated ? "src/main/java/com/example/" + longName + "/RepositoryConfigurationWithAnUnusuallyLongButValidClassName.java:1501" : "Language navigation uses local servers; files are saved only on request.";
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  window.fixtureMeasure = () => {
    const rect = element => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
    const measure = selector => { const element = document.querySelector(selector); return { ...rect(element), scrollWidth:element.scrollWidth, clientWidth:element.clientWidth, scrollHeight:element.scrollHeight, clientHeight:element.clientHeight, text:element.textContent, visible:element.checkVisibility() }; };
    // Footer height is intentionally capped to protect editor space. Prove the
    // end of a wrapped diagnostic remains reachable in its scroll container.
    const footer = ide.querySelector(".repository-ide-footer"), previousScroll = footer.scrollTop;
    footer.scrollTop = footer.scrollHeight;
    const end = document.createRange(), text = notice.firstChild;
    end.setStart(text, Math.max(0, text.length - 1)); end.setEnd(text, text.length);
    const lastGlyph = end.getBoundingClientRect(), footerBounds = footer.getBoundingClientRect();
    const footerScroll = { overflowY:getComputedStyle(footer).overflowY, scrollTop:footer.scrollTop, lastGlyphTop:lastGlyph.top, lastGlyphBottom:lastGlyph.bottom, top:footerBounds.top, bottom:footerBounds.bottom };
    footer.scrollTop = previousScroll;
    const controls = [...terminal.querySelectorAll("nav button")].map(element => ({ ...rect(element), reachable:element.contains(document.elementFromPoint(...[(rect(element).left + rect(element).right) / 2, (rect(element).top + rect(element).bottom) / 2])) }));
    const logControls = [...logs.querySelectorAll("button")].filter(element => element.checkVisibility()).map(element => ({ ...rect(element), text:element.textContent }));
    return { width:innerWidth, footer:measure(".repository-ide-footer"), footerScroll, notice:measure(".repository-ide-notice"), position:measure(".repository-ide-position"), terminal:measure("#terminal-panel > header"), title:measure("#terminal-title"), controls, debugger:measure(".repository-ide-debug"), target:measure(".repository-ide-debug-target"), targetInfo:measure(".repository-ide-debug-target-info"), logs:measure(".repository-ide-process-logs"), logToolbar:measure(".repository-ide-process-logs-toolbar"), logControls, errors:fixtureErrors };
  };
}
app.whenReady().then(async () => {
  const source = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const sheets = [...source.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(sheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const page = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "").replace("<head>", `<head><style>${styles}</style>`);
  const { createPreviewServer } = await import(pathToFileURL(path.join(__dirname, "ide-ux-preview.mjs")).href);
  server = createPreviewServer(); const serve = server.listeners("request")[0]; server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url.startsWith("/api/")) { unexpectedRequests++; response.writeHead(403); response.end(); return; }
    if (request.url === "/") { response.writeHead(200, { "Content-Type":"text/html", "Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" }); response.end(page); return; }
    void serve(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isolated = session.fromPartition("alignment-ide-363", { cache:false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls:["http://*/*", "https://*/*"] }, (details, callback) => { const denied = !details.url.startsWith(origin + "/"); if (denied) unexpectedRequests++; callback({ cancel:denied }); });
  window = new BrowserWindow({ show:false, width:1440, height:760, webPreferences:{ session:isolated, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  await window.loadURL(origin); await window.webContents.executeJavaScript(`(${initialize.toString()})()`);
  const failures = [], measurements = []; let scenarios = 0;
  for (const width of [1440, 900, 640, 420, 320]) {
    window.setContentSize(width, 620);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { let attempts = 0; const check = () => Math.abs(innerWidth - ${width}) <= 1 ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : ++attempts < 100 ? setTimeout(check, 10) : reject(new Error("Viewport did not settle")); check(); })`);
    for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans"]) for (const panel of ["terminal", "debug", "logs"]) for (const populated of [false, true]) {
      const scenario = { width, theme, font, panel, populated };
      await window.webContents.executeJavaScript(`fixtureSet(${JSON.stringify(scenario)})`);
      const result = await window.webContents.executeJavaScript("fixtureMeasure()"); measurements.push({ scenario, result });
      const check = (condition, message) => { if (!condition) failures.push({ scenario, message, result }); };
      check(result.footer.scrollWidth <= result.footer.clientWidth + 1, "Footer notice overflows the available width");
      check(result.footerScroll.lastGlyphTop >= result.footerScroll.top && result.footerScroll.lastGlyphBottom <= result.footerScroll.bottom + 1, "Wrapped diagnostic ending cannot be reached by scrolling the footer");
      if (result.footer.scrollHeight > result.footer.clientHeight + 1) check(result.footerScroll.overflowY === "auto" && result.footerScroll.scrollTop > 0, "Long footer notice must remain scrollable");
      check(result.notice.right <= result.position.left - 10, "Footer notice and cursor position must have a clear gap");
      check(result.errors.length === 0, "Unexpected application error");
      if (panel === "terminal") {
        check(result.terminal.scrollWidth <= result.terminal.clientWidth + 1, "Terminal title crowds its controls");
        check(result.controls.every(control => control.reachable && control.left >= 0 && control.right <= width), "Terminal controls are clipped or overlapped");
        check(result.title.right + 4 <= result.controls[0].left, "Terminal title and controls have no clear separation");
      }
      if (panel === "debug") {
        check(result.debugger.scrollWidth <= result.debugger.clientWidth + 1, "Debugger content overflows its pane");
        if (populated) check(result.target.scrollWidth <= result.target.clientWidth + 1, "Debugger target name overlaps its attach control");
      }
      if (panel === "logs") {
        check(result.logs.scrollWidth <= result.logs.clientWidth + 1, "Run logs overflow their pane");
        check(result.logControls.every(control => control.left >= 0 && control.right <= width), "Run log actions leave the available width");
        check(result.logToolbar.scrollWidth <= result.logToolbar.clientWidth + 1, "Run log toolbar overflows its pane");
      }
      if (process.env.ARGUS_ALIGNMENT_IDE_CAPTURE === "1" && populated && font === "comic-sans" && [900, 320].includes(width)) {
        await fs.writeFile(path.join(temporary, `${panel}-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
        if (width === 320 && panel === "terminal") {
          await window.webContents.executeJavaScript(`{ const footer = document.querySelector(".repository-ide-footer"); footer.scrollTop = footer.scrollHeight; }`);
          await fs.writeFile(path.join(temporary, `${panel}-${theme}-${width}-footer-end.png`), (await window.webContents.capturePage()).toPNG());
          await window.webContents.executeJavaScript(`document.querySelector(".repository-ide-footer").scrollTop = 0`);
        }
      }
      scenarios++;
    }
  }
  await fs.writeFile(path.join(temporary, "measurements.json"), JSON.stringify({ scenarios, failures, measurements }, null, 2));
  assert.equal(unexpectedRequests, 0, "Unexpected backend or external requests");
  assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 5)));
  finish(null, { ok:true, scenarios, unexpectedRequests });
}).catch(error => finish(error));
