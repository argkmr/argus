// Actual Services renderer and styles, synthetic process state only. No Argus
// bootstrap, profile, repositories, live processes, or network is accessed.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-service-running-367-")) throw new Error("An isolated fixture directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, networkRequests = 0;
const timer = setTimeout(() => finish(new Error("Running service highlight fixture timed out")), 35_000);
function finish(error, result) {
  clearTimeout(timer);
  if (error) console.error(error.stack || error);
  else console.log("SERVICE_RUNNING_367=" + JSON.stringify(result));
  window?.destroy(); app.exit(error ? 1 : 0);
}
function declaration(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
app.whenReady().then(async () => {
  const html = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(sheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const page = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "").replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${styles}</style>`);
  const isolated = session.fromPartition("service-running-367", { cache:false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls:["http://*/*", "https://*/*"] }, (_details, callback) => { networkRequests++; callback({ cancel:true }); });
  window = new BrowserWindow({ show:false, width:1440, height:900, webPreferences:{ session:isolated, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  const source = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  const order = (await fs.readFile(path.join(root, "public/service-card-order.mjs"), "utf8")).replace(/^export /gm, "");
  await window.webContents.executeJavaScript(`
    ${order}
    const $ = selector => document.querySelector(selector);
    const syncIdeRunControls = () => {}, syncServicePendingControls = () => {}, syncStopAllServicesControl = () => {};
    const serviceCardOrder = { isDragging:() => false, restore:() => {}, arrange:cards => cards };
    const statuses = [
      { id:'running', name:'reviewrating', status:'running', running:true },
      { id:'starting', name:'ticket-management', status:'starting', running:true },
      { id:'stopped', name:'invoice', status:'stopped', running:false },
      { id:'failed', name:'post-order-recommendation-engine-with-a-long-name', status:'failed', running:false },
      { id:'stopping', name:'chat-service', status:'stopping', running:true },
      { id:'syncing', name:'client-dependency-sync', status:'syncing', running:true },
      { id:'testing', name:'integration-tests', status:'testing', running:true },
      { id:'installing', name:'nextjs-web', status:'installing', running:true },
      { id:'notalive', name:'No live process', status:'running', running:false },
    ];
    const state = { currentView:'services', serviceProcessSignature:'known', detectedRuntimes:[],
      workspace:{ repositories:[...statuses.map(item => ({ id:item.id, name:item.name })), { id:'fresh', name:'Fresh repository' }], runConfigurations:statuses.map((item, index) => ({ id:item.id, repositoryId:item.id, name:item.name, executable:'./mvnw', args:['spring-boot:run'], port:8080 + index, environmentKeys:['EXAMPLE_LOCAL_KEY'] })), preferences:{} },
      processes:statuses.map(item => ({ id:'synthetic-' + item.id, configurationId:item.id, status:item.status, running:item.running, startedAt:'2026-09-20T12:00:00Z' })) };
    ${declaration(source, "escapeHtml")}
    ${declaration(source, "renderServices")}
    document.body.dataset.view = 'services'; $('#services-drawer').classList.remove('hidden'); renderServices();
    const rect = element => { const box = element.getBoundingClientRect(); return { left:box.left, right:box.right, top:box.top, bottom:box.bottom, width:box.width, height:box.height }; };
    const colour = value => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d'); context.fillStyle = value; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data].slice(0,3); };
    const luminance = value => colour(value).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126,.7152,.0722][index], 0);
    const contrast = (a,b) => { const values = [luminance(a),luminance(b)].sort((a,b) => a-b); return (values[1]+.05)/(values[0]+.05); };
    window.measure = () => {
      const cards = [...document.querySelectorAll('[data-service-card]')].map(card => { const style = getComputedStyle(card), label = card.querySelector('.service-state'), labelStyle = getComputedStyle(label); return { id:card.dataset.serviceCard, running:card.dataset.serviceRunning, state:label.textContent, stateClass:label.className, background:style.backgroundColor, border:style.borderColor, borderWidth:style.borderLeftWidth, animation:style.animationName, statusContrast:contrast(labelStyle.color,style.backgroundColor), titleContrast:contrast(getComputedStyle(card.querySelector('h3')).color,style.backgroundColor), bounds:rect(card), overflow:card.scrollWidth > card.clientWidth + 1, buttons:[...card.querySelectorAll('button')].map(button => rect(button)) }; });
      return { width:innerWidth, cards, list:rect($('#service-list')), drawer:rect($('#services-drawer')) };
    };
    window.transitions = () => {
      const card = () => document.querySelector('[data-service-card="configuration:running"]');
      const original = card(); renderServices(); const unchanged = original === card();
      state.processes[0] = { ...state.processes[0], status:'stopped', running:false }; renderServices();
      const stopped = { highlighted:card().dataset.serviceRunning, text:card().querySelector('.service-state').textContent };
      state.processes[0] = { ...state.processes[0], status:'starting', running:true }; renderServices();
      const starting = card().dataset.serviceRunning;
      state.processes[0] = { ...state.processes[0], status:'running', running:true }; renderServices();
      const resumed = card().dataset.serviceRunning;
      card().classList.add('service-drop-before'); const dragShadow = getComputedStyle(card()).boxShadow; card().classList.remove('service-drop-before');
      return { unchanged, stopped, starting, resumed, dragShadow };
    };
    void 0;
  `);
  const results = [];
  for (const width of [1440, 980, 640, 380]) {
    window.setContentSize(width, 900);
    await window.webContents.executeJavaScript(`new Promise((resolve,reject) => { let count=0; const check=() => Math.abs(innerWidth-${width})<1 ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : ++count<100 ? setTimeout(check,10) : reject(new Error('Viewport did not settle')); check(); })`);
    for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans"]) {
      await window.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.fontFamily=${JSON.stringify(font)}; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const result = await window.webContents.executeJavaScript("measure()");
      const diagnostic = JSON.stringify({ width, theme, font, result });
      const running = result.cards.find(card => card.id === "configuration:running");
      assert.deepEqual(result.cards.filter(card => card.running === "true").map(card => card.id), ["configuration:running"], diagnostic);
      assert.equal(running.state, "running", diagnostic); assert.match(running.stateClass, /\brunning\b/);
      assert.ok(running.statusContrast >= 4.5 && running.titleContrast >= 4.5, diagnostic);
      assert.equal(running.animation, "none", diagnostic);
      for (const card of result.cards) {
        assert.equal(card.overflow, false, diagnostic);
        assert.ok(card.bounds.left >= 0 && card.bounds.right <= width + 1, diagnostic);
        assert.ok(card.buttons.every(button => button.left >= card.bounds.left && button.right <= card.bounds.right + 1), diagnostic);
        if (card !== running) {
          assert.notEqual(running.background, card.background, diagnostic); assert.notEqual(running.border, card.border, diagnostic);
          assert.equal(running.borderWidth, card.borderWidth, "Highlight must not change card layout");
          assert.doesNotMatch(card.stateClass, /\brunning\b/, "Transitional or inactive processes must not receive the running presentation");
        }
      }
      const transitions = await window.webContents.executeJavaScript("transitions()");
      assert.equal(transitions.unchanged, true); assert.deepEqual(transitions.stopped, { highlighted:"false", text:"stopped" });
      assert.equal(transitions.starting, "false"); assert.equal(transitions.resumed, "true");
      assert.match(transitions.dragShadow, /-4px 0px/, "Running highlight must preserve drag/drop indication");
      results.push({ width, theme, font, cards:result.cards.length, statusContrast:running.statusContrast, titleContrast:running.titleContrast, transitions });
      if (process.env.ARGUS_SERVICE_RUNNING_CAPTURE === "1" && font === "comic-sans") await fs.writeFile(path.join(temporary, `services-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  assert.equal(networkRequests, 0);
  const result = { ok:true, scenarios:results.length, networkRequests, results };
  await fs.writeFile(path.join(temporary,"results.json"),JSON.stringify(result,null,2)); finish(null,result);
}).catch(error => finish(error));
