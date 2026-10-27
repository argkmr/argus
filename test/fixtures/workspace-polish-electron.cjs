// Real local editor + production chrome; all repositories and API replies are synthetic.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-workspace-polish-")) throw new Error("Isolated test directory required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, server, externalRequests = 0;
const timer = setTimeout(() => finish(1, new Error("Workspace polish fixture timed out")), 60_000);
function finish(code, error) { clearTimeout(timer); if (error) console.error(error); window?.destroy(); server?.close(); app.exit(code); }
function declaration(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(start >= 0, name); return source.slice(start, source.indexOf("\n}", start) + 2);
}

async function initialize() {
  const { createRepositoryIde } = await import("/legacy/repository-ide.mjs");
  const files = [".argus/settings.json", ".gradle/cache.properties", ".idea/workspace.xml", "build/classes/Report.class", "gradle/wrapper/gradle-wrapper.properties", "k8s/deployment.yaml", "src/main/java/com/example/orders/OrderController.java", "src/main/java/com/example/orders/OrderService.java", "src/main/java/com/example/orders/OrderRepository.java", "src/main/resources/application.yaml", "src/test/java/OrderServiceTest.java", "web/app.tsx", "web/api-client.js", "scripts/worker.py", ".gitignore", "build.gradle", "Dockerfile", "gradlew", "README.md", "settings.gradle"];
  // Directory-only paths now compact. Exercise scrolling with an actual long
  // filename instead of relying on the old staircase of redundant folders.
  files.push("src/main/java/com/example/orders/CustomerOrderFulfilmentReconciliationNotificationHandler.java");
  const apiCalls = [], errors = [];
  const api = async (raw, options = {}) => {
    apiCalls.push({ raw, method: options.method || "GET" });
    const url = new URL(raw, location.origin);
    if (url.pathname.endsWith("/status")) return { languages: [] };
    if (url.pathname.endsWith("/code-discussions")) return { discussions: [] };
    if (url.pathname.endsWith("/session") && options.method === "DELETE") return {};
    if (options.method && options.method !== "GET") throw new Error("No file or service writes allowed");
    if (url.pathname.endsWith("/tree")) {
      const directory = url.searchParams.get("path") || "", prefix = directory ? directory + "/" : "";
      const names = [...new Set(files.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split("/")[0]))];
      return { entries: names.map(name => ({ name, path: prefix + name, directory: !files.includes(prefix + name) })).sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
    }
    if (url.pathname.endsWith("/file")) return { path: url.searchParams.get("path"), language: "java", contentHash: "synthetic-v1", content: "package com.example.orders;\n\nimport java.util.List;\n\n/** Example code for layout verification only. */\npublic final class OrderService {\n  private final OrderRepository repository;\n\n  public OrderService(OrderRepository repository) {\n    this.repository = repository;\n  }\n\n  public List<Order> findOrders(String customerId) {\n    return repository.findByCustomer(customerId);\n  }\n}\n" };
    throw new Error("Unexpected synthetic endpoint: " + raw);
  };
  const ide = createRepositoryIde({ host: document.querySelector("#polish-ide"), api, onError: error => errors.push(error.message) });
  await ide.activate({ id: "synthetic-orders", path: "/synthetic/orders", name: "crm-apis" });
  await ide.openFile("src/main/java/com/example/orders/OrderService.java", 13, 3, { focus: false });
  window.polish = { ide, apiCalls, errors, frames: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) };
}

app.whenReady().then(async () => {
  const source = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const styleFiles = [...source.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(styleFiles.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><style>${styles}</style>`);
  const preview = await import(pathToFileURL(path.join(__dirname, "ide-ux-preview.mjs")));
  server = preview.createPreviewServer(); const assetHandler = server.listeners("request")[0]; server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url === "/polish-qa") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); }
    else { if (request.url.startsWith("/assets/")) request.url = "/legacy" + request.url; assetHandler(request, response); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const isolated = session.fromPartition("workspace-polish", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { const outside = !details.url.startsWith(origin + "/"); if (outside) externalRequests++; callback({ cancel: outside }); });
  window = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(origin + "/polish-qa");
  const application = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  const functions = ["isRepositoryDestination", "repositoryTabHtml", "repositoryTabGroupHtml", "renderRepositoryTabTools", "positionRepositoryTabTools", "escapeHtml"].map(name => declaration(application, name)).join("\n");
  await window.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector);
    const shell = $('.app-shell'), titlebar = $('.titlebar');
    const host = document.createElement('main'); host.id = 'polish-ide'; host.style.cssText = 'min-height:0;overflow:hidden;padding-left:var(--tools-rail-width)';
    shell.replaceChildren(titlebar, host); document.body.classList.add('repository-ide-enabled');
    document.body.dataset.view = 'repository';
    const repositories = ['nextjs-web','promotion-dashboard','crm-apis','invoice'].map((name,index) => ({ id:'repo-'+index, name, path:'/synthetic/'+name }));
    const groups = [{id:'frontend',name:'CX-FE',color:'orange',repositoryIds:['repo-0','repo-1'],collapsed:false}, {id:'backend',name:'CX-BE',color:'blue',repositoryIds:['repo-2','repo-3'],collapsed:false}];
    const state = { currentView:'repository', activeRepository:repositories[2], workspace:{ repositories, preferences:{} } };
    const repositoryTabGroups = () => groups;
    const repositoryTabLayout = () => groups.map(group => ({type:'group',group,repositories:repositories.filter(repo => group.repositoryIds.includes(repo.id))}));
    ${functions}
    $('#repo-tabs').innerHTML = repositoryTabLayout().map(item => '<div class="repo-tab-group-block repo-tab-group-'+item.group.color+'">'+repositoryTabGroupHtml(item.group)+item.repositories.map(repo=>repositoryTabHtml(repo,item.group)).join('')+'</div>').join('');
    renderRepositoryTabTools();
    window.positionFixtureMenu = positionRepositoryTabTools;
    void 0;
  `);
  await window.webContents.executeJavaScript(`(${initialize.toString()})()`);
  const result = { ok: true, scenarios: 0, screenshots: [], externalRequests: 0, icons: 0, minTextContrast: Infinity, minIconContrast: Infinity };
  for (const theme of ["dark", "light"]) for (const width of [1280, 700]) for (const zoom of [1, 1.5]) {
    window.setContentSize(Math.round(width * zoom), Math.round(850 * zoom)); window.webContents.setZoomFactor(zoom);
    await window.webContents.executeJavaScript(`new Promise((resolve,reject) => { const start=performance.now(); const tick=()=> { if(Math.abs(innerWidth-${width})<=1) resolve(); else if(performance.now()-start>3000) reject(new Error('Viewport did not settle')); else requestAnimationFrame(tick); }; tick(); })`);
    await window.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.querySelector('.repository-ide-body').style.setProperty('--ide-tree-width','292px'); if(!document.querySelector('#repository-tab-tools-menu').matches(':popover-open')) document.querySelector('#repository-tab-tools-menu').showPopover(); positionFixtureMenu(); polish.frames()`);
    // Let the production hover/theme transition finish before comparing pixels.
    await new Promise(resolve => setTimeout(resolve, 180));
    const g = await window.webContents.executeJavaScript(`(() => {
      const rect = node => { const r=node.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
      const rgb = color => { const canvas=document.createElement('canvas'); canvas.width=canvas.height=1; const context=canvas.getContext('2d'); context.fillStyle=color; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data]; };
      const luminance = color => rgb(color).slice(0,3).map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
      const surface=getComputedStyle(document.querySelector('.repository-ide-tree-pane')).backgroundColor;
      const contrast = node => { const a=luminance(getComputedStyle(node).color),b=luminance(surface); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); };
      const rows=[...document.querySelectorAll('.repository-ide-tree-row')].filter(node=>node.getClientRects().length), tree=document.querySelector('.repository-ide-tree');
      const files=rows.filter(node=>!node.hasAttribute('aria-expanded'));
      const folder=rows.find(node=>node.dataset.path==='src'), branch=folder?.parentElement.querySelector('.repository-ide-tree-children');
      const labels=[...document.querySelectorAll('.repository-ide-tree-name,.repository-tab-tools-action strong,.repository-tab-tools-action small,.repository-tab-tools-heading')];
      return {menu:rect(document.querySelector('#repository-tab-tools-menu')),viewport:{width:innerWidth,height:innerHeight},tree:{...rect(tree),scrollWidth:tree.scrollWidth,clientWidth:tree.clientWidth},rows:rows.map(row=>({rect:rect(row),icon:rect(row.querySelector('.repository-ide-file-icon')),label:rect(row.querySelector('.repository-ide-tree-name'))})),tabs:[...document.querySelectorAll('.repo-tab')].map(rect),icons:files.map(row=>row.querySelector('.repository-ide-file-icon').dataset.kind),guide:getComputedStyle(branch).borderLeftWidth,errors:polish.errors,menuIcons:document.querySelectorAll('.repository-tab-tools-action > span svg').length,minTextContrast:Math.min(...labels.map(contrast)),minIconContrast:Math.min(...rows.map(row=>contrast(row.querySelector('.repository-ide-file-icon'))))};
    })()`);
    assert.deepEqual(g.errors, []); assert.equal(g.menuIcons, 3);
    assert.ok(g.minTextContrast >= 4.5, `${theme} text contrast: ${g.minTextContrast}`); assert.ok(g.minIconContrast >= 3, `${theme} icon contrast: ${g.minIconContrast}`);
    result.minTextContrast = Math.min(result.minTextContrast, g.minTextContrast); result.minIconContrast = Math.min(result.minIconContrast, g.minIconContrast);
    assert.ok(g.menu.left >= 0 && g.menu.right <= g.viewport.width && g.menu.bottom <= g.viewport.height, JSON.stringify(g.menu));
    assert.equal(g.guide, "1px"); assert.ok(g.icons.includes("java") && g.icons.includes("markdown") && g.icons.includes("container"));
    for (const tab of g.tabs) assert.ok(tab.width >= 103.9 && tab.width <= 144.1 && Math.abs(tab.height-26)<.1, JSON.stringify(tab));
    for (const row of g.rows) { assert.ok(row.rect.height >= 25.9 && row.rect.height <= 28); assert.ok(row.icon.right < row.label.left); assert.ok(row.label.top >= row.rect.top && row.label.bottom <= row.rect.bottom); }
    assert.ok(g.tree.scrollWidth > g.tree.clientWidth, "Long filenames must remain scrollable instead of clipped");
    result.icons = Math.max(result.icons, g.icons.length); result.scenarios++;
    if (process.env.ARGUS_WORKSPACE_POLISH_CAPTURE === "1" && zoom === 1) {
      const file = path.join(temporary, `workspace-${theme}-${width}.png`); await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); result.screenshots.push(file);
    }
  }
  // Collapse is presentation-only. It retains the source model and selected row.
  const collapse = await window.webContents.executeJavaScript(`(async () => { document.querySelector('#repository-tab-tools-menu').hidePopover(); const before=polish.apiCalls.length; document.querySelector('[title="Collapse all folders"]').click(); await polish.frames(); return {calls:polish.apiCalls.length-before, expanded:document.querySelectorAll('.repository-ide-tree-row[aria-expanded="true"]').length,selected:document.querySelector('.repository-ide-tree-row[data-active="true"]').dataset.path,dirty:polish.ide.isDirty()}; })()`);
  assert.equal(collapse.calls, 0); assert.equal(collapse.expanded, 0); assert.equal(collapse.dirty, false); assert.ok(collapse.selected.endsWith("OrderService.java"));
  await window.webContents.executeJavaScript(`(async () => {
    await polish.ide.deactivate();
    const { renderTokenUsage } = await import('/legacy/token-usage.mjs');
    const host=document.querySelector('#polish-ide'); host.style.cssText='overflow:auto;padding:24px 24px 24px calc(var(--tools-rail-width) + 24px)';
    host.innerHTML='<section style="max-width:860px;margin:0 auto"><h1 style="font-size:20px;margin:0 0 18px">How Argus handled this</h1>'+renderTokenUsage({reported:true,measurement:'provider-counters',incompleteCounterCoverage:true,status:'partial',exact:false,inputTokens:153840,cachedInputTokens:131072,outputTokens:8924,totalTokens:162764,reasoningOutputTokens:6048,source:'Synthetic Codex turn counters',coverage:'isolated-turn',recoveredFromLocalRollout:true,costEstimate:{status:'unavailable',provider:'codex',model:'synthetic-new-model',speed:'standard',amount:null,detail:'No verified rate is available for this synthetic model.'}})+'</section>';
  })()`);
  result.usageScenarios = 0;
  for (const theme of ["dark", "light"]) for (const width of [1280, 460]) {
    window.setContentSize(width, 850); window.webContents.setZoomFactor(1);
    await window.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; polish.frames()`);
    await new Promise(resolve=>setTimeout(resolve,180));
    const usage = await window.webContents.executeJavaScript(`(() => {const card=document.querySelector('.execution-token-usage'), metrics=document.querySelector('.token-usage-breakdown'), cost=document.querySelector('[data-usage-detail="cost"]'), r=card.getBoundingClientRect(); return {total:document.querySelector('.token-usage-total > strong').textContent,visible:metrics.checkVisibility(),costOpen:cost.open,provenance:document.querySelector('[data-usage-detail="tokens"]').open,badge:document.querySelector('.token-usage-badge').textContent,overflow:card.scrollWidth>card.clientWidth,right:r.right,viewport:innerWidth};})()`);
    assert.equal(usage.total, "162,764"); assert.equal(usage.visible, true); assert.equal(usage.costOpen, false); assert.equal(usage.provenance, false); assert.match(usage.badge, /not billing/); assert.equal(usage.overflow, false); assert.ok(usage.right <= usage.viewport);
    const partial = await window.webContents.executeJavaScript(`({label:document.querySelector('.token-usage-total > span').textContent,explanation:document.querySelector('.execution-token-usage > p').textContent})`);
    assert.match(partial.label, /partial turn/); assert.match(partial.explanation, /some updates were skipped/);
    result.usageScenarios++;
    if (process.env.ARGUS_WORKSPACE_POLISH_CAPTURE === "1") { const file=path.join(temporary,`usage-${theme}-${width}.png`); await fs.writeFile(file,(await window.webContents.capturePage()).toPNG()); result.screenshots.push(file); }
  }
  // Shared surfaces outside the IDE must also remain legible in both themes.
  await window.webContents.executeJavaScript(`(() => {
    const host=document.querySelector('#polish-ide');
    host.style.cssText='overflow:auto;padding:24px 24px 24px calc(var(--tools-rail-width) + 24px);background:var(--surface-2)';
    host.innerHTML='<section style="max-width:860px;margin:0 auto"><h1 style="font-size:20px">Shared surface contrast checks</h1><div class="data-storage-trust-row"><span><i data-contrast="icon">✓</i><strong data-contrast="text">Local storage</strong><small>Saved on this Mac</small></span></div><article class="storage-card is-sensitive"><div class="storage-card-icon" data-contrast="icon">⚿</div><strong>Credentials</strong><span class="storage-card-state available" data-contrast="text">Available</span><p class="storage-error" data-contrast="text">Example permission warning</p></article><div class="storage-memory-note"><span data-contrast="icon">ⓘ</span><div><strong>Memory index</strong><p>Rebuilt from retained conversations.</p></div></div><div class="repo-onboarding-note"><span data-contrast="icon">↗</span><p><strong>Connect a repository</strong><small>Folder access stays local.</small></p></div><pre class="json-code-view" style="margin-top:20px">{ &quot;enabled&quot;: <span class="json-boolean" data-contrast="text">true</span>, &quot;value&quot;: <span class="json-null" data-contrast="text">null</span> }</pre><div style="padding-top:70px;display:flex;justify-content:flex-end"><button class="orchestration-run-action" data-tooltip="Run details stay available in every theme">Details</button></div></section>';
    document.querySelector('.orchestration-run-action').focus();
  })()`);
  result.sharedThemeScenarios=0;
  for(const theme of ['dark','light']) {
    window.setContentSize(1280,850);
    await window.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; polish.frames()`);
    const pointer=await window.webContents.executeJavaScript(`(() => {const r=document.querySelector('.orchestration-run-action').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    window.webContents.sendInputEvent({type:'mouseMove',...pointer});
    await new Promise(resolve=>setTimeout(resolve,180));
    const checks=await window.webContents.executeJavaScript(`(() => {
      const rgb=color=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((value,index)=>index===3?value/255:value);};
      const composite=(front,back)=>front.slice(0,3).map((value,index)=>value*front[3]+back[index]*(1-front[3])).concat(1);
      const background=node=>{const layers=[];for(let current=node;current;current=current.parentElement)layers.push(rgb(getComputedStyle(current).backgroundColor));return layers.reverse().reduce((back,front)=>composite(front,back),[255,255,255,1]);};
      const luminance=color=>color.slice(0,3).map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
      const ratio=(front,back)=>{const a=luminance(composite(front,back)),b=luminance(back);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
      const entries=[...document.querySelectorAll('[data-contrast]')].map(node=>({name:node.className||node.closest('[class]')?.className||node.outerHTML,minimum:node.dataset.contrast==='icon'?3:4.5,contrast:ratio(rgb(getComputedStyle(node).color),background(node))}));
      const action=document.querySelector('.orchestration-run-action'),tip=getComputedStyle(action,'::after');
      entries.push({name:'orchestration tooltip',minimum:4.5,contrast:ratio(rgb(tip.color),composite(rgb(tip.backgroundColor),background(action)))});
      return {entries,tooltipContent:tip.content};
    })()`);
    assert.match(checks.tooltipContent,/Run details/);
    for(const check of checks.entries) assert.ok(check.contrast>=check.minimum,`${theme} ${check.name}: ${check.contrast} < ${check.minimum}`);
    result.sharedThemeScenarios++;
    if(process.env.ARGUS_WORKSPACE_POLISH_CAPTURE==='1') {const file=path.join(temporary,`shared-theme-${theme}.png`);await fs.writeFile(file,(await window.webContents.capturePage()).toPNG());result.screenshots.push(file);}
  }
  result.externalRequests = externalRequests; assert.equal(externalRequests, 0);
  console.log("WORKSPACE_POLISH_RESULT=" + JSON.stringify(result)); finish(0);
}).catch(error => finish(1, error));
