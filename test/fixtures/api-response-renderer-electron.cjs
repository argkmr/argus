// Only the production response renderer and styles are loaded. No app startup,
// backend, repository access, persistent profile, or real API requests.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const temporary = process.argv[2];
assert.ok(path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-api-response-layout-"));
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const timer = setTimeout(() => app.exit(1), 35_000);
app.whenReady().then(async () => {
  const publicRoot = path.resolve(__dirname, "../../public");
  const shell = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const panel = shell.match(/<section class="api-response-panel">[\s\S]*?<\/section>/)?.[0];
  assert.ok(panel, "The production API response panel must exist");
  const sheets = [...shell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const css = (await Promise.all(sheets.map(name => fs.readFile(path.join(publicRoot, name), "utf8")))).join("\n");
  const moduleSource = await fs.readFile(path.join(publicRoot, "api-response-renderer.mjs"), "utf8");
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(moduleSource).toString("base64");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data:"><style>${css}</style><style>body { margin:0; padding:16px; display:block; } .api-response-panel { width:100%; height:calc(100vh - 32px); border:1px solid var(--line); border-radius:10px; }</style></head><body>${panel}</body></html>`;
  const isolated = session.fromPartition("api-response-renderer-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  window = new BrowserWindow({ show: false, width: 1440, height: 480, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const run = code => window.webContents.executeJavaScript(code);
  await run(`import(${JSON.stringify(moduleUrl)}).then(module => { window.responseRenderer = module; })`);
  const message = "FulfillmentException(errorCode=FS_500001, message=Can't perform operation, internal service error, action=REJECT_V2)";
  let scenarios = 0, securityChecks = 0;
  for (const width of [650, 1440]) for (const font of ["system", "comic-sans"]) for (const theme of ["dark", "light"]) for (const wrap of [true, false]) for (const tab of ["body", "headers"]) {
    window.setContentSize(width, 480);
    const response = tab === "body" ? { errors: [{ message }] } : { "content-type": "application/json", "x-service-message": message };
    const raw = JSON.stringify(response), formatted = JSON.stringify(response, null, 2);
    const result = await run(`(async () => {
      document.documentElement.dataset.fontFamily=${JSON.stringify(font)};
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      const panel=document.querySelector('.api-response-panel'), body=document.querySelector('#api-response-body'), headers=document.querySelector('#api-response-headers');
      const active=${JSON.stringify(tab)}==='body'?body:headers;
      for(const element of [body,headers]) { element.classList.toggle('hidden',element!==active); element.classList.toggle('no-wrap',${!wrap}); }
      document.querySelectorAll('[data-api-response]').forEach(button=>button.classList.toggle('active',button.dataset.apiResponse===${JSON.stringify(tab)}));
      document.querySelector('#toggle-response-wrap').classList.toggle('active',${wrap});
      document.querySelector('#toggle-response-wrap').textContent=${JSON.stringify(wrap ? "Wrap lines" : "No wrap")};
      document.querySelector('#api-response-status').className='error';
      document.querySelector('#api-response-status').textContent='500 Internal Server Error';
      document.querySelector('#api-response-meta').textContent='23356 ms · 143 bytes';
      responseRenderer.renderResponseContent(active,${JSON.stringify(raw)});
      await document.fonts.ready;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const string=[...active.querySelectorAll('.json-string')].find(element=>element.textContent.includes('FulfillmentException'));
      return {text:[...active.querySelectorAll('.json-line')].map(line=>line.textContent).join('\\n'),raw:active.dataset.raw,string:string?.textContent,nestedTokens:string?.children.length,numberCount:active.querySelectorAll('.json-number').length,
        panel:box(panel),response:box(active),header:box(panel.querySelector('header')),tabs:box(panel.querySelector('.api-response-tabs')),viewport:innerWidth,horizontalOverflow:active.scrollWidth>active.clientWidth+1,panelOverflow:panel.scrollWidth>panel.clientWidth+1};
    })()`);
    const context = JSON.stringify({ width, font, theme, wrap, tab, result });
    assert.equal(result.text, formatted, context);
    assert.equal(result.raw, formatted, context);
    assert.equal(result.string, JSON.stringify(message), context);
    assert.equal(result.nestedTokens, 0, context);
    assert.equal(result.numberCount, 0, context);
    assert.equal(result.text.includes("&#39;"), false, context);
    assert.ok(result.panel.left >= 0 && result.panel.right <= result.viewport + 1, context);
    assert.equal(result.panelOverflow, false, context);
    assert.ok(result.response.top >= result.tabs.bottom - 1 && result.tabs.top >= result.header.bottom - 1, context);
    if (wrap) assert.equal(result.horizontalOverflow, false, context);
    else if (width === 650) assert.equal(result.horizontalOverflow, true, context);
    if (width === 1440 && font === "comic-sans" && wrap && tab === "body") {
      await fs.writeFile(path.join(temporary, `api-response-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    const security = await run(`(() => {
      const active=document.querySelector('.api-response-panel pre:not(.hidden)');
      const text=()=>[...active.querySelectorAll('.json-line')].map(line=>line.textContent).join('\\n');
      const roundTrip=value=>{responseRenderer.renderResponseContent(active,JSON.stringify(value));return {raw:active.dataset.raw,text:text(),unsafe:active.querySelectorAll('img,script,svg,iframe').length};};
      const entity={message:'Literal &#39; &quot; &lt; must stay literal'};
      const payload={message:'<img src=x onerror="window.__responseInjected=true"><script>window.__responseInjected=true</script>',other:'Quotes " and apostrophe \\' and ampersand &'};
      const entities=roundTrip(entity), html=roundTrip(payload), controls=roundTrip({message:'line one\\nline two\\twith tab',enabled:true,count:-12.5,missing:null});
      const raw='<img src=x onerror="window.__responseInjected=true"> plain text &#39;\\nNext line';
      responseRenderer.renderResponseContent(active,raw); const fallback={text:active.textContent,raw:active.dataset.raw,json:active.classList.contains('json-view'),children:active.children.length};
      responseRenderer.renderResponseContent(active,'{"plain":true}',false); const forced={text:active.textContent,json:active.classList.contains('json-view'),children:active.children.length};
      return {entities,html,controls,fallback,forced,injected:Boolean(window.__responseInjected),entityExpected:JSON.stringify(entity,null,2),payloadExpected:JSON.stringify(payload,null,2),fallbackExpected:raw};
    })()`);
    assert.equal(security.entities.text, security.entityExpected, context);
    assert.equal(security.entities.raw, security.entityExpected, context);
    assert.equal(security.html.text, security.payloadExpected, context);
    assert.equal(security.html.raw, security.payloadExpected, context);
    assert.equal(security.html.unsafe + security.entities.unsafe + security.controls.unsafe, 0, context);
    assert.equal(security.injected, false, context);
    assert.deepEqual(JSON.parse(security.controls.text), { message: "line one\nline two\twith tab", enabled: true, count: -12.5, missing: null }, context);
    assert.deepEqual(security.fallback, { text: security.fallbackExpected, raw: security.fallbackExpected, json: false, children: 0 }, context);
    assert.deepEqual(security.forced, { text: '{"plain":true}', json: false, children: 0 }, context);
    scenarios++; securityChecks += 5;
  }
  await fs.writeFile(path.join(temporary, "result.json"), JSON.stringify({ scenarios, securityChecks }));
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timer); window?.destroy(); app.exit(1); });
