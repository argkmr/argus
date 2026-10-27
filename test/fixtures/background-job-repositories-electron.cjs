// Render production markup/styles in isolation. No application data or AI calls.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
assert.ok(path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-kit-card-layout-"));
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const timer = setTimeout(() => app.exit(1), 35_000);
app.whenReady().then(async () => {
  const { kitJob, renderJob } = await import(pathToFileURL(path.join(__dirname, "../helpers/background-job-markup.mjs")).href);
  const publicRoot = path.resolve(__dirname, "../../public");
  const shell = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const sheets = [...shell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const css = (await Promise.all(sheets.map(name => fs.readFile(path.join(publicRoot, name), "utf8")))).join("\n");
  const html = shell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${css}</style>`);
  const isolated = session.fromPartition("kit-card-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const run = code => window.webContents.executeJavaScript(code);
  let scenarios = 0;
  for (const width of [380, 1440]) for (const font of ["system", "comic-sans"]) for (const theme of ["dark", "light"]) for (const zoom of [1, 1.22]) for (const variant of ["ready", "long", "mixed"]) {
    window.setContentSize(width, 900); window.webContents.setZoomFactor(zoom);
    const job = kitJob();
    if (variant === "long") job.items = Array.from({ length: 12 }, (_, index) => ({ name: `a-very-long-repository-name-with-no-spaces-to-wrap-${index}-`.repeat(3), status: "completed" }));
    if (variant === "mixed") { job.status = "running"; job.items[0].status = "failed"; job.items[1].status = "running"; job.items[2].status = "queued"; }
    const result = await run(`(async () => {
      document.documentElement.dataset.fontFamily=${JSON.stringify(font)};
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      const panel=document.querySelector('#background-jobs-panel'), list=document.querySelector('#background-jobs-list');
      panel.classList.remove('hidden'); panel.classList.toggle('completed',${variant !== "mixed"});
      list.innerHTML=${JSON.stringify(renderJob(job))}; list.scrollTop=0;
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const rows=[...list.querySelectorAll('.background-job-repositories li')];
      const rowBounds=rows.map(row=>({row:box(row),name:box(row.firstElementChild),status:box(row.lastElementChild),nameClipped:row.firstElementChild.scrollWidth>row.firstElementChild.clientWidth+1}));
      const bounds=box(list), last=rows.at(-1); list.scrollTop=list.scrollHeight;
      return {panel:box(panel),viewport:innerWidth,rows:rowBounds,overflow:list.scrollWidth>list.clientWidth+1,lastReachable:box(last).bottom<=bounds.bottom+1,allVisible:rowBounds.every(item=>item.row.bottom<=bounds.bottom+1)};
    })()`);
    const context = JSON.stringify({ width, font, theme, zoom, variant, result });
    assert.equal(result.rows.length, job.items.length, context);
    assert.equal(result.overflow, false, context);
    assert.ok(result.panel.left >= 0 && result.panel.right <= result.viewport + 1, context);
    assert.ok(result.lastReachable, context);
    if (variant === "ready" && width === 1440) assert.ok(result.allVisible, context);
    for (const { row, name, status, nameClipped } of result.rows) {
      assert.equal(nameClipped, false, context);
      assert.ok(name.left >= row.left && name.right <= status.left - 5 && status.right <= row.right + 1, context);
    }
    scenarios++;
    if (width === 1440 && font === "comic-sans" && zoom === 1 && variant === "ready") {
      await run("document.querySelector('#background-jobs-list').scrollTop=0; new Promise(resolve=>setTimeout(resolve,50))");
      await fs.writeFile(path.join(temporary, `ai-kits-${theme}.png`), (await window.webContents.capturePage({ x: 980, y: 60, width: 450, height: 390 })).toPNG());
    }
  }
  await fs.writeFile(path.join(temporary, "result.json"), JSON.stringify({ scenarios }));
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timer); window?.destroy(); app.exit(1); });
