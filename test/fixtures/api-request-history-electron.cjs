// Production sidebar markup/CSS and the pure renderer only. No app startup,
// backend, real requests, credentials, or existing user profile is accessed.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const temporary = process.argv[2];
assert.ok(path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-api-history-layout-"));
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const timer = setTimeout(() => app.exit(1), 50_000);
app.whenReady().then(async () => {
  const publicRoot = path.resolve(__dirname, "../../public");
  const shell = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const panel = shell.slice(shell.indexOf('<section id="api-client-drawer"'), shell.indexOf('<section id="json-explorer-panel"')).replace('class="api-client-drawer hidden"', 'class="api-client-drawer"');
  assert.ok(panel.includes('id="api-history-list"'));
  const sheets = [...shell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const css = (await Promise.all(sheets.map(name => fs.readFile(path.join(publicRoot, name), "utf8")))).join("\n");
  const moduleSource = await fs.readFile(path.join(publicRoot, "api-request-history-view.mjs"), "utf8");
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(moduleSource).toString("base64");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data:"><style>${css}</style></head><body>${panel}</body></html>`;
  const isolated = session.fromPartition("api-history-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  window = new BrowserWindow({ show: false, width: 1440, height: 800, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const run = code => window.webContents.executeJavaScript(code);
  await run(`import(${JSON.stringify(moduleUrl)}).then(module => { window.historyView = module; })`);
  let scenarios = 0;
  for (const width of [520, 1000, 1440]) for (const font of ["system", "comic-sans"]) for (const theme of ["dark", "light"]) for (const zoom of [1, 1.22]) {
    window.setContentSize(width, 800);
    const result = await run(`(async () => {
      document.documentElement.dataset.fontFamily=${JSON.stringify(font)};
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      document.body.style.zoom=${zoom};
      const drawer=document.querySelector('#api-client-drawer'), sidebar=document.querySelector('#api-request-sidebar'), history=document.querySelector('#api-request-history'), list=document.querySelector('#api-history-list');
      drawer.classList.add('api-history-open');
      document.querySelector('#api-saved-pane').classList.add('hidden'); history.classList.remove('hidden');
      document.querySelector('#api-history-tab').classList.add('active'); document.querySelector('#api-saved-tab').classList.remove('active');
      const entries=Array.from({length:20},(_,index)=>({id:'row-'+index,name:index===1?'':index===2?'<img src=x onerror=bad>':index===3?'Extremely long request name that should remain accessible and never push the sidebar wide':'Get order details',method:index%2?'POST':'GET',url:'https://user:supersecret@api.example.test/some/very/long/order/details/path?token=private',kind:index%3===0?'draft':index%3===1?'sent':'failed',status:200,updatedAt:'2026-09-23T08:00:00Z'}));
      list.innerHTML=historyView.historyRowsMarkup(entries); document.querySelector('#api-history-count').textContent=entries.length;
      await document.fonts.ready;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const first=list.querySelector('[data-api-history-id]'); first.focus();
      return {sidebar:box(sidebar),tabs:box(document.querySelector('.api-sidebar-tabs')),list:box(list),layout:box(document.querySelector('.api-client-layout')),viewport:innerWidth,overflow:list.scrollWidth>list.clientWidth+1,sidebarOverflow:sidebar.scrollWidth>sidebar.clientWidth+1,scrolls:list.scrollHeight>list.clientHeight,first:box(first),delete:box(list.querySelector('[data-delete-api-history]')),focus:document.activeElement===first,openVisible:getComputedStyle(document.querySelector('#open-api-history')).display!=='none',closeVisible:getComputedStyle(document.querySelector('#close-api-history')).display!=='none',unsafe:sidebar.querySelectorAll('img,script').length,leaks:sidebar.textContent.includes('supersecret')||sidebar.textContent.includes('private')};
    })()`);
    const context=JSON.stringify({width,font,theme,zoom,result});
    assert.ok(result.sidebar.width>170 && result.sidebar.right<=result.layout.right+1,context);
    assert.ok(result.list.height>100 && result.list.bottom<=result.sidebar.bottom+1,context);
    assert.equal(result.overflow,false,context); assert.equal(result.sidebarOverflow,false,context);
    assert.equal(result.scrolls,true,context); assert.equal(result.focus,true,context);
    assert.equal(result.unsafe,0,context); assert.equal(result.leaks,false,context);
    assert.ok(result.delete.left>=result.first.right-1,context);
    assert.equal(result.openVisible,result.closeVisible,context);
    if(width===520) assert.equal(result.openVisible,true,context);
    if(width===1440) assert.equal(result.openVisible,false,context);
    if(width===1440 && font==='comic-sans' && zoom===1) await fs.writeFile(path.join(temporary,`history-${theme}.png`),(await window.webContents.capturePage()).toPNG());
    if(width===520 && font==='comic-sans' && theme==='dark' && zoom===1) await fs.writeFile(path.join(temporary,'history-compact.png'),(await window.webContents.capturePage()).toPNG());
    scenarios++;
  }
  await fs.writeFile(path.join(temporary,"result.json"),JSON.stringify({scenarios}));
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timer);window?.destroy();app.exit(1);});
