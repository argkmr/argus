// Isolated production DOM/CSS only: never loads app.js, a live profile or backend.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-selector-clipping-369-")) throw new Error("Isolated test directory required");
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
const root = path.resolve(__dirname, "../.."), publicRoot = path.join(root, "public");
let window, server, unexpectedNetwork = 0;
const timer = setTimeout(() => { console.error("Selector clipping fixture timed out"); app.exit(1); }, 30_000);
const finish = code => { clearTimeout(timer); window?.destroy(); server?.close(); app.exit(code); };

app.whenReady().then(async () => {
  const index = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const files = [...index.matchAll(/<link\s+rel="stylesheet"\s+href="\/([^"?]+)[^"]*"[^>]*>/g)].map(match => match[1]);
  assert.ok(files.includes("font-family.css"), "The actual font preference CSS must be tested");
  const styles = (await Promise.all(files.map(file => fs.readFile(path.join(publicRoot, file), "utf8")))).join("\n");
  const branchMarkup = index.match(/<div class="branch-bar">[\s\S]*?<\/div>/)?.[0];
  assert.ok(branchMarkup, "Production branch selector markup must exist");
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style><style>
    body { padding:20px; height:auto; min-height:100%; overflow:auto; }
    #fixture { width:100%; max-width:1200px; display:grid; gap:24px; }
    #branch-host { width:min(100%,420px); }
    #ide-host { height:160px; }
    .fixture-reference { padding:8px; font-size:12px; line-height:1.6; }
  </style></head><body><main id="fixture"><section id="branch-host">${branchMarkup}</section><section id="ide-host"></section><p class="fixture-reference">Unclipped reference: reviewrating · feature/pod-failure-fix · gjpqy ÀÉÅ</p></main></body></html>`;
  server = http.createServer(async (request, response) => {
    try {
      const relative = new URL(request.url, "http://localhost").pathname;
      if (relative === "/fixture") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); return; }
      const file = path.resolve(publicRoot, `.${relative}`);
      if (!file.startsWith(publicRoot + path.sep) || !/\.(?:mjs|js)$/.test(file)) { response.writeHead(404); response.end(); return; }
      response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(await fs.readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isolated = session.fromPartition("selector-clipping-369", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(origin + "/") || details.url.startsWith("data:");
    if (!allowed) unexpectedNetwork++;
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({ show:false, width:1280, height:620, webPreferences:{ session:isolated, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  window.webContents.setWindowOpenHandler(() => ({ action:"deny" }));
  await window.loadURL(origin + "/fixture");
  const run = script => window.webContents.executeJavaScript(script);
  const settle = () => run("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  await run(`(async () => {
    const {createRepositoryIde} = await import('/repository-ide.mjs');
    window.backendCalls=0;
    window.ide=createRepositoryIde({host:document.querySelector('#ide-host'),document,api:async()=>{backendCalls++;throw new Error('No backend allowed in selector fixture');}});
    document.querySelector('.repository-ide').hidden=false;
    window.service=document.querySelector('.repository-ide-run-select');
    document.querySelector('.repository-ide-runtime').hidden=false;
    document.querySelector('.repository-ide-run-empty').hidden=true;
    service.hidden=false; service.disabled=false;
    service.replaceChildren(...['reviewrating','gjpqy ÀÉÅ','Very long service name with gjpqy which must truncate horizontally but never vertically'].map((name,i)=>{const option=document.createElement('option');option.value='service-'+i;option.textContent=name;return option;}));
    document.querySelector('#branch-name').textContent='feature/pod-failure-fix';
    window.measure = () => {
      const rect = node => {const b=node.getBoundingClientRect();return {left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height};};
      const glyphs = node => {
        const css=getComputedStyle(node), context=document.createElement('canvas').getContext('2d');
        context.font=css.fontWeight+' '+css.fontSize+' '+css.fontFamily;
        const label=node.tagName==='SELECT'?node.selectedOptions[0].textContent:node.textContent;
        const metrics=context.measureText(label), baseline=context.measureText('gjpqy ÀÉÅ');
        return {font:css.fontFamily,fontSize:parseFloat(css.fontSize),lineHeight:parseFloat(css.lineHeight),paddingTop:parseFloat(css.paddingTop),paddingBottom:parseFloat(css.paddingBottom),height:node.clientHeight,actualInk:metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent,fontInk:baseline.fontBoundingBoxAscent+baseline.fontBoundingBoxDescent,overflow:css.overflow,textOverflow:css.textOverflow,paddingRight:parseFloat(css.paddingRight),backgroundSize:css.backgroundSize,backgroundImage:css.backgroundImage,bounds:rect(node)};
      };
      return {branch:glyphs(document.querySelector('#branch-name')),service:glyphs(service),branchButton:rect(document.querySelector('#branch-selector')),branchIcon:rect(document.querySelector('.branch-icon')),chevron:rect(document.querySelector('.branch-chevron')),fetch:rect(document.querySelector('#fetch-button')),bar:rect(document.querySelector('.branch-bar')),toolbar:rect(document.querySelector('.repository-ide-toolbar'))};
    };
    window.setLabels=long=>{document.querySelector('#branch-name').textContent=long?'feature/very-long-gjpqy-branch-name-with-extra-text-for-truncation-regression':'feature/pod-failure-fix';service.selectedIndex=long?2:0;};
  })()`);
  const layouts=[];
  for (const width of [420,1280]) for (const theme of ["dark","light"]) for (const font of ["system","serif","mono","comic-sans"]) for (const zoom of [1,1.22]) for (const zoomMode of ["body","native"]) for (const long of [false,true]) {
    window.setContentSize(width,620);
    window.webContents.setZoomFactor(zoomMode==="native"?zoom:1);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};document.body.style.zoom=${zoomMode==="body"?zoom:1};setLabels(${long});undefined;`);
    await settle();
    const result=await run("measure()"), diagnostic=JSON.stringify({width,theme,font,zoom,zoomMode,long,...result});
    assert.ok(result.branch.height+.1>=result.branch.fontInk, "Branch glyph clip box too short: "+diagnostic);
    assert.ok(result.service.lineHeight+.1>=result.service.fontInk, "Native select line box too short: "+diagnostic);
    assert.ok(result.service.height+.1>=result.service.lineHeight+result.service.paddingTop+result.service.paddingBottom, "Native select content clipped by fixed height: "+diagnostic);
    assert.equal(result.branch.textOverflow,"ellipsis",diagnostic); assert.equal(result.service.textOverflow,"ellipsis",diagnostic);
    assert.ok(result.service.paddingRight>=30, "Arrow gutter missing: "+diagnostic);
    assert.equal(result.service.backgroundSize,"14px 14px",diagnostic); assert.match(result.service.backgroundImage,/data:image\/svg\+xml/,diagnostic);
    assert.ok(result.branch.bounds.left>=result.branchIcon.right && result.branch.bounds.right<=result.chevron.left+.5, "Branch overlaps an icon: "+diagnostic);
    assert.ok(result.chevron.right<=result.fetch.left+.5, "Branch disclosure overlaps Fetch: "+diagnostic);
    assert.ok(result.fetch.right<=result.bar.right+.5, "Fetch escapes branch bar: "+diagnostic);
    if (process.env.ARGUS_SELECTOR_CLIPPING_CAPTURE==="1" && font==="comic-sans" && !long && zoomMode==="body") await fs.writeFile(path.join(temporary,`${theme}-${width}-${zoom}.png`),(await window.webContents.capturePage()).toPNG());
    layouts.push({width,theme,font,zoom,zoomMode,long,branch:result.branch,service:result.service});
  }
  // This is a negative control, not a snapshot assertion: the prior CSS must
  // demonstrably lack vertical room when applied to the same production DOM.
  window.webContents.setZoomFactor(1);
  await run(`document.documentElement.dataset.theme='dark';document.documentElement.dataset.fontFamily='comic-sans';document.body.style.zoom=1.22;setLabels(false);undefined;`);
  await settle();
  if(process.env.ARGUS_SELECTOR_CLIPPING_CAPTURE==="1") await fs.writeFile(path.join(temporary,"fixed.png"),(await window.webContents.capturePage()).toPNG());
  await run(`window.legacy=document.createElement('style');legacy.textContent='.branch-selector strong{line-height:1!important;padding-block:0!important} select{line-height:1!important} .repository-ide .repository-ide-run-select{height:30px!important}';document.head.append(legacy);undefined;`);
  await settle();
  const old=await run("measure()");
  const legacyFails=old.branch.height<old.branch.fontInk && old.service.lineHeight<old.service.fontInk;
  assert.equal(legacyFails,true,"The regression must detect the old tight line boxes: "+JSON.stringify(old));
  if(process.env.ARGUS_SELECTOR_CLIPPING_CAPTURE==="1") await fs.writeFile(path.join(temporary,"legacy-clipped.png"),(await window.webContents.capturePage()).toPNG());
  await run("legacy.remove();service.selectedIndex=0;service.focus();undefined;");
  window.webContents.focus();
  window.webContents.sendInputEvent({type:"keyDown",keyCode:"g"});
  window.webContents.sendInputEvent({type:"char",keyCode:"g"});
  window.webContents.sendInputEvent({type:"keyUp",keyCode:"g"});
  await settle();
  const keyboard=await run("({tag:document.activeElement.tagName,role:service.getAttribute('aria-label'),index:service.selectedIndex,backendCalls})");
  assert.equal(keyboard.tag,"SELECT"); assert.equal(keyboard.index,1,"Native keyboard selection must still work: "+JSON.stringify(keyboard));
  assert.match(keyboard.role,/Services run configuration/);
  await fs.writeFile(path.join(temporary,"results.json"),JSON.stringify({layouts,legacyFails,keyboardChecks:"PASS",backendCalls:keyboard.backendCalls,unexpectedNetwork},null,2));
  finish(0);
}).catch(error=>{console.error(error.stack||error);finish(1);});
