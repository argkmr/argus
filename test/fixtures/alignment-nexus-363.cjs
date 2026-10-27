// Production shell/styles, synthetic state, isolated Chromium profile. No app
// bootstrap, user repositories, saved preferences or AI requests are involved.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-alignment-nexus-363-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, networkRequests = 0;
const timer = setTimeout(() => { console.error("Nexus alignment fixture timed out"); app.exit(1); }, 75_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };

app.whenReady().then(async () => {
  const html = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const css = (await Promise.all(sheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${css}</style>`);
  const isolated = session.fromPartition("alignment-nexus-363", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  const { nexusThemeVariables } = await import(pathToFileURL(path.join(root, "public/nexus-themes.mjs")).href);
  await window.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector);
    document.body.dataset.view = "global";
    document.body.classList.add("task-context-visible");
    $("#global-codex-panel").classList.remove("hidden");
    $("#global-ai-status").textContent = "Connect your AI provider";
    $("#global-ai-version").textContent = "Choose a local coding provider to get started";
    $("#global-ai-repository-scope").textContent = "No connected repositories";
    $("#global-agent-provider").innerHTML = '<option>Codex</option>';
    $("#global-agent-model").innerHTML = '<option>GPT-6-Astra</option>';
    window.nexusAlignment = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height, centerY:(r.top + r.bottom) / 2 }; };
      const control = selector => { const node = $(selector), r = rect(node); return { ...r, visible:node.checkVisibility(), uncovered:node.contains(document.elementFromPoint((r.left + r.right) / 2, r.centerY)), overflow:node.scrollWidth > node.clientWidth + 1 }; };
      return { width:innerWidth, height:innerHeight, panel:rect($("#global-codex-panel")), header:rect($("#global-codex-panel > header")), row:rect($(".global-codex-header-row")), identity:rect($(".global-codex-heading")), title:rect($(".global-codex-title")), heading:rect($(".global-codex-title h2")), theme:control("#nexus-theme-toggle"), sidebar:control("#nexus-sidebar-toggle"), chevron:rect($("#nexus-theme-toggle .disclosure-chevron")), info:rect($(".global-ai-info")), infoOverflow:$(".global-ai-info").scrollWidth > $(".global-ai-info").clientWidth + 1, pageOverflow:document.documentElement.scrollWidth > innerWidth + 1, bodyOverflow:document.body.scrollWidth > document.body.clientWidth + 1 };
    }; void 0;
  `);
  let scenarios = 0;
  for (const width of [1440, 1024, 760, 640, 480, 380]) for (const zoom of [1, 1.22]) {
    window.setContentSize(width, 900); window.webContents.setZoomFactor(zoom);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let frames = 0; const deadline = performance.now() + 5000;
      const step = () => { frames = Math.abs(innerWidth - ${width / zoom}) <= 1 ? frames + 1 : 0; if (frames >= 2) resolve(); else if (performance.now() > deadline) reject(new Error("Resize did not settle")); else requestAnimationFrame(step); }; requestAnimationFrame(step);
    })`);
    for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans", "serif", "mono"]) {
      const scenario = { width, zoom, theme, font };
      await window.webContents.executeJavaScript(`
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        document.documentElement.dataset.fontFamily = ${JSON.stringify(font)};
        for (const [key, value] of Object.entries(${JSON.stringify(nexusThemeVariables("ocean", theme))})) $("#global-codex-panel").style.setProperty(key, value);
        $("#nexus-theme-label").textContent = ${JSON.stringify(theme === "dark" ? "Deep Ocean" : "Sea Glass")};
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      `);
      const geometry = await window.webContents.executeJavaScript("nexusAlignment()");
      const diagnostic = JSON.stringify({ scenario, ...geometry });
      if (process.env.ARGUS_ALIGNMENT_CAPTURE === "1" && font === "comic-sans" && [1440, 640, 380].includes(width) && zoom === 1.22) {
        await fs.writeFile(path.join(temporary, `nexus-${width}-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      }
      assert.equal(geometry.pageOverflow || geometry.bodyOverflow, false, `Workspace overflow: ${diagnostic}`);
      assert.equal(geometry.infoOverflow, false, `Connection card overflows: ${diagnostic}`);
      for (const name of ["theme", "sidebar"]) {
        assert.ok(geometry[name].visible && geometry[name].uncovered && !geometry[name].overflow, `Identity control clipped: ${diagnostic}`);
        assert.ok(geometry[name].left >= geometry.row.left - 1 && geometry[name].right <= geometry.row.right + 1, `Identity control outside header: ${diagnostic}`);
      }
      assert.ok(Math.abs(geometry.theme.centerY - geometry.chevron.centerY) <= 1, `Theme chevron off-center: ${diagnostic}`);
      if (geometry.theme.top >= geometry.title.bottom - 1) {
        assert.ok(Math.abs(geometry.title.left - geometry.theme.left) <= 1 && Math.abs(geometry.title.right - geometry.theme.right) <= 1, `Nexus and theme must share column edges: ${diagnostic}`);
      } else {
        assert.ok(geometry.title.right + 4 <= geometry.theme.left && Math.abs(geometry.title.centerY - geometry.theme.centerY) <= 1, `Narrow identity controls overlap/misalign: ${diagnostic}`);
      }
      const separateRows = geometry.info.top >= geometry.identity.bottom - 1;
      assert.ok(separateRows || geometry.identity.right + 4 <= geometry.info.left, `Identity overlaps connection card: ${diagnostic}`);
      assert.ok(geometry.info.right <= geometry.row.right + 1 && geometry.heading.right <= geometry.title.right + 1, `Header content escapes its column: ${diagnostic}`);
      scenarios++;
    }
  }
  console.log("NEXUS_ALIGNMENT_363=" + JSON.stringify({ ok: true, scenarios, networkRequests })); finish(0);
}).catch(error => { console.error(error); finish(1); });
