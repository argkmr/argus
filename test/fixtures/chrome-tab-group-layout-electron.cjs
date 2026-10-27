// Production shell/CSS and tab renderers, synthetic repositories only.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-tab-group-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, unexpectedNetworkCount = 0;
const timer = setTimeout(() => { console.error("Tab group fixture timed out"); app.exit(1); }, 50_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
function sourceFunction(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Missing ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
app.whenReady().then(async () => {
  const source = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const files = [...source.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(files.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style>`);
  const isolated = session.fromPartition("tab-group-regression", { cache:false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls:["http://*/*", "https://*/*"] }, (_details, callback) => { unexpectedNetworkCount++; callback({ cancel:true }); });
  window = new BrowserWindow({ show:false, width:1440, height:700, webPreferences:{ session:isolated, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  const application = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  const functions = ["isRepositoryDestination", "repositoryTabHtml", "repositoryTabGroupHtml", "escapeHtml"].map(name => sourceFunction(application, name)).join("\n");
  await window.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector);
    const repositories = ["crm-apis", "invoice", "nextjs-web"].map((name, index) => ({ id:"repo-" + index, name, path:"/synthetic/" + name }));
    const state = { currentView:"repository", activeRepository:repositories[0] };
    ${functions}
    window.fixture = {};
    fixture.frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fixture.setState = async ({ font, theme, zoom, collapsed }) => {
      document.documentElement.dataset.fontFamily = font; document.documentElement.dataset.theme = theme; document.body.style.zoom = String(zoom);
      const group = { id:"backend", name:"CX-BE", color:"blue", repositoryIds:["repo-0", "repo-1"], collapsed };
      $("#repo-tabs").innerHTML = '<div class="repo-tab-group-block repo-tab-group-blue' + (collapsed ? ' is-collapsed' : '') + '">' + repositoryTabGroupHtml(group) + (collapsed ? '' : repositories.slice(0, 2).map(repository => repositoryTabHtml(repository, group)).join('')) + '</div>' + repositoryTabHtml(repositories[2]);
      await fixture.frames();
    };
    fixture.geometry = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, height:r.height }; };
      const group = $(".repo-tab-group-block"), groupRect = rect(group), line = getComputedStyle(group, "::after"), rail = $("#repo-tabs"), zoom = Number(getComputedStyle(document.body).zoom);
      return { zoom, titlebar:rect($(".titlebar")), group:groupRect, chip:rect($(".repo-tab-group-chip")), line:{ display:line.display, top:groupRect.top + parseFloat(line.top) * zoom, bottom:groupRect.top + (parseFloat(line.top) + parseFloat(line.height)) * zoom, left:groupRect.left + parseFloat(line.left) * zoom, right:groupRect.right - parseFloat(line.right) * zoom, pointerEvents:line.pointerEvents }, rail:{ ...rect(rail), clipBottom:rect(rail).top + rail.clientHeight * zoom, overflow:rail.scrollWidth > rail.clientWidth }, tab:$(".repo-tab-grouped") ? rect($(".repo-tab-grouped")) : null, plain:rect($("#repo-tabs > .repo-tab")), labels:[...document.querySelectorAll(".repo-tab-label, .repo-tab-group-name")].map(node => ({ label:rect(node), parent:rect(node.closest(".repo-tab, .repo-tab-group-chip")) })), closes:[...document.querySelectorAll("#repo-tabs .repo-tab-close")].map(node => ({ close:rect(node), parent:rect(node.closest(".repo-tab")) })) };
    }; void 0;
  `);
  const result = { ok:true, scenarios:0, overflowScenarios:0, minGap:Infinity, maxGapDifference:0, minBottomClearance:Infinity, unexpectedNetworkCount:0 };
  for (const width of [1440, 680]) for (const font of ["system", "serif", "mono", "comic-sans"]) for (const theme of ["dark", "light"]) for (const zoom of [1, 1.25, 2]) for (const zoomMode of ["native", "body"]) for (const collapsed of [false, true]) {
    window.setContentSize(Math.round(width * zoom), 700);
    window.webContents.setZoomFactor(zoomMode === "native" ? zoom : 1);
    await window.webContents.executeJavaScript(`fixture.setState(${JSON.stringify({font, theme, zoom:zoomMode === "body" ? zoom : 1, collapsed})})`);
    const g = await window.webContents.executeJavaScript("fixture.geometry()");
    const diagnostic = JSON.stringify({ width, font, theme, requestedZoom:zoom, zoomMode, collapsed, ...g });
    const scale = g.zoom;
    assert.ok(Math.abs(g.titlebar.height / scale - 40) <= 1, diagnostic);
    assert.ok(Math.abs(g.chip.height / scale - 26) <= .05 && Math.abs(g.plain.height - g.chip.height) / scale <= .05, `Chip and ungrouped tab heights differ: ${diagnostic}`);
    assert.ok(Math.abs(g.plain.top - g.chip.top) / scale <= .05 && Math.abs(g.plain.bottom - g.chip.bottom) / scale <= .05, `Chip and ungrouped tab baselines differ: ${diagnostic}`);
    for (const {label, parent} of g.labels) assert.ok(label.top >= parent.top && label.bottom <= parent.bottom, `Tab label clips vertically: ${diagnostic}`);
    for (const {close, parent} of g.closes) {
      assert.ok(close.height / scale >= 23.95 && (close.right - close.left) / scale >= 23.95, `Close target shrank: ${diagnostic}`);
      assert.ok(close.top >= parent.top && close.bottom <= parent.bottom && close.right <= parent.right, `Close target clips: ${diagnostic}`);
    }
    assert.equal(g.line.pointerEvents, "none", diagnostic);
    if (collapsed) assert.equal(g.line.display, "none", diagnostic);
    else {
      assert.ok(Math.abs(g.tab.top - g.plain.top) <= 1, `Tab baseline changed: ${diagnostic}`);
      const gap = (g.line.top - g.tab.bottom) / scale, chipGap = (g.line.top - g.chip.bottom) / scale, clearance = (g.rail.clipBottom - g.line.bottom) / scale;
      const gapDifference = Math.abs(chipGap - gap);
      assert.ok(gap >= 3.95 && gap <= 4.05, `Group line must retain a 4px gap: ${diagnostic}`);
      assert.ok(gapDifference <= .05, `Active tab and group chip need equal bottom padding: ${diagnostic}`);
      assert.ok(clearance >= .5, `Group line clips against the rail: ${diagnostic}`);
      assert.ok(g.line.left > g.group.left && g.line.right < g.group.right, diagnostic);
      result.minGap = Math.min(result.minGap, gap); result.maxGapDifference = Math.max(result.maxGapDifference, gapDifference); result.minBottomClearance = Math.min(result.minBottomClearance, clearance);
    }
    if (g.rail.overflow) result.overflowScenarios++;
    result.scenarios++;
    if (process.env.ARGUS_TAB_GROUP_CAPTURE === "1" && font === "comic-sans" && !collapsed && zoom === 2 && zoomMode === "native") {
      await fs.writeFile(path.join(temporary, `tab-group-${width}-${theme}.png`), (await window.webContents.capturePage({x:0,y:0,width:Math.round(width * zoom),height:100})).toPNG());
    }
  }
  result.unexpectedNetworkCount = unexpectedNetworkCount;
  assert.equal(unexpectedNetworkCount, 0);
  console.log("TAB_GROUP_LAYOUT_RESULT=" + JSON.stringify(result)); finish(0);
}).catch(error => { console.error(error); finish(1); });
