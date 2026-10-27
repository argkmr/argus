// Only synthetic references and injected callbacks are used. No backend, real
// clipboard, user folder, filesystem opener, or Argus bootstrap is loaded.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
assert.ok(path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-source-folder-layout-"));
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
let window, networkRequests = 0;
const timer = setTimeout(() => app.exit(1), 55_000);

app.whenReady().then(async () => {
  const publicRoot = path.resolve(__dirname, "../../public");
  const html = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const css = (await Promise.all(sheets.map(name => fs.readFile(path.join(publicRoot, name), "utf8")))).join("\n");
  const shell = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data:"><style>${css}</style>`);
  const bundled = new Map();
  async function moduleUrl(file) {
    if (bundled.has(file)) return bundled.get(file);
    let source = await fs.readFile(file, "utf8");
    for (const match of [...source.matchAll(/\bfrom\s+(["'])(\.\.?\/[^"']+)\1/g)]) {
      const dependency = path.resolve(path.dirname(file), match[2].split("?")[0]);
      assert.ok(dependency.startsWith(publicRoot + path.sep));
      source = source.replace(match[0], `from ${JSON.stringify(await moduleUrl(dependency))}`);
    }
    const url = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
    bundled.set(file, url); return url;
  }
  const viewer = await moduleUrl(path.join(publicRoot, "source-reference-viewer.js"));
  const { nexusThemeVariables } = await import(pathToFileURL(path.join(publicRoot, "nexus-themes.mjs")).href);
  const isolated = session.fromPartition("source-folder-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const fixtureOrigin = "https://argus-folder-fixture.invalid";
  isolated.protocol.handle("https", request => new Response(request.url === fixtureOrigin + "/" ? shell : "Not found", { status: request.url === fixtureOrigin + "/" ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } }));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    const external = new URL(details.url).origin !== fixtureOrigin;
    if (external) networkRequests++;
    callback({ cancel: external });
  });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL(fixtureOrigin + "/");
  const run = code => window.webContents.executeJavaScript(code);
  const settle = () => run("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
  await run(`(async()=>{
    const {initializeSourceReferences}=await import(${JSON.stringify(viewer)});
    window.reveals=[];window.copies=[];window.failReveal=false;
    window.folderPath='/Users/synthetic/Documents/projects/Résumé 100%25 + plan/guided-help-studio-with-a-very-long-directory-name';
    window.folderMetadata={kind:'directory',previewType:'directory',scope:'local',name:'guided-help-studio-with-a-very-long-directory-name',path:folderPath,file:folderPath,contentUrl:null,downloadUrl:null};
    const button=document.createElement('button');button.id='folder-citation';button.dataset.sourceReference='/synthetic/studio-link';button.textContent='guided-help-studio';button.style.cssText='position:fixed;top:8px;left:110px;z-index:5';document.body.append(button);
    initializeSourceReferences({document,loadReference:async()=>folderMetadata,
      preferredRepositoryId:()=>null,
      revealReference:async(target,repositoryId)=>{reveals.push({target,repositoryId});if(failReveal)throw new Error('Finder is unavailable. Try again or copy the folder path.');return{opened:true};},
      copyText:async value=>{copies.push(value);},
      showDialog:id=>{const dialog=document.getElementById(id);if(!dialog.open)dialog.showModal();return true;}});
    window.folderState=()=>{
      const dialog=document.getElementById('source-reference-dialog');
      const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const card=dialog.querySelector('.source-reference-card'),folder=dialog.querySelector('[data-source-folder]');
      return{open:dialog.open,kind:dialog.dataset.sourceKind,card:rect(card),viewport:{width:innerWidth,height:innerHeight},
        path:dialog.querySelector('[data-folder-path]').textContent,scrollWidth:folder.scrollWidth,clientWidth:folder.clientWidth,
        name:rect(dialog.querySelector('[data-folder-name]')),pathBounds:rect(dialog.querySelector('[data-folder-path]')),
        controls:[...folder.querySelectorAll('button')].map(button=>({rect:rect(button),label:button.textContent,disabled:button.disabled})),
        notice:dialog.querySelector('[data-source-notice]').textContent,error:dialog.querySelector('[data-source-notice]').dataset.error,
        hidden:['[data-source-body]','[data-document-preview]','[data-source-download]','[data-source-toggle]'].every(selector=>dialog.querySelector(selector).hidden),
        focus:document.activeElement.getAttribute('aria-label')||document.activeElement.textContent,
        unsafe:folder.querySelectorAll('script,iframe,a,input,textarea').length};};
    button.click();
  })()`);
  await settle();
  let scenarios = 0, interactionChecks = 0;
  for (const width of [1440, 760, 440]) for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans"]) for (const zoom of [1, 1.22]) {
    window.setContentSize(width, 900); window.webContents.setZoomFactor(zoom);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};for(const[key,value]of Object.entries(${JSON.stringify(nexusThemeVariables("ocean", theme))}))document.getElementById('source-reference-dialog').style.setProperty(key,value);`);
    await settle();
    const state = await run("folderState()"), context = JSON.stringify({ width, theme, font, zoom, state });
    assert.equal(state.open, true, context); assert.equal(state.kind, "directory", context); assert.equal(state.hidden, true, context); assert.equal(state.unsafe, 0, context);
    assert.ok(state.card.width <= 642, context); assert.ok(state.card.height < 480, `Folder preview must not fill the viewport: ${context}`);
    assert.ok(state.card.left >= 0 && state.card.right <= state.viewport.width + 1 && state.card.top >= 0 && state.card.bottom <= state.viewport.height + 1, context);
    assert.ok(state.scrollWidth <= state.clientWidth + 1, context);
    for (const bounds of [state.name, state.pathBounds, ...state.controls.map(control => control.rect)]) assert.ok(bounds.left >= state.card.left && bounds.right <= state.card.right + 1 && bounds.bottom <= state.card.bottom + 1, context);
    for (const control of state.controls) assert.ok(control.rect.height >= 32 && control.rect.width >= 64, context);
    assert.equal(state.path, await run("folderPath"), context);
    assert.match(state.notice, /Shown in Finder/, context);
    if (process.env.ARGUS_FOLDER_CAPTURE === "1" && font === "comic-sans" && ((width === 1440 && zoom === 1) || (width === 440 && zoom === 1.22))) await fs.writeFile(path.join(temporary, `folder-${theme}-${width}-${zoom}.png`), (await window.webContents.capturePage()).toPNG());
    scenarios++;
  }
  assert.deepEqual(await run("reveals"), [{ target: "/synthetic/studio-link", repositoryId: null }]); interactionChecks++;
  await run("document.querySelector('[data-folder-copy]').focus()");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" }); window.webContents.sendInputEvent({ type: "char", keyCode: "\r" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" }); await settle();
  assert.deepEqual(await run("copies"), [await run("folderPath")]); interactionChecks++;
  await run("failReveal=true;document.querySelector('[data-folder-reveal]').click()"); await settle();
  assert.equal((await run("folderState()")).error, "true"); assert.equal((await run("folderState()")).hidden, true); interactionChecks++;
  await run("failReveal=false;document.querySelector('[data-folder-reveal]').click()"); await settle();
  assert.equal((await run("folderState()")).error, "false"); assert.match((await run("folderState()")).notice, /Shown in Finder/); interactionChecks++;
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await settle();
  assert.equal((await run("folderState()")).open, false); assert.equal(await run("document.activeElement.id"), "folder-citation"); interactionChecks++;
  await fs.writeFile(path.join(temporary, "result.json"), JSON.stringify({ scenarios, interactionChecks, networkRequests }));
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timer); window?.destroy(); app.exit(1); });
