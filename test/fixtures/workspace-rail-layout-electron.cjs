// Production shell/styles only; never launch Argus or read its application data.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const temporary = process.argv[2];
assert.ok(path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-rail-layout-"));
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const timer = setTimeout(() => app.exit(1), 50_000);
app.whenReady().then(async () => {
  const publicRoot = path.resolve(__dirname, "../../public");
  const shell = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const sheets = [...shell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const css = (await Promise.all(sheets.map(name => fs.readFile(path.join(publicRoot, name), "utf8")))).join("\n");
  const html = shell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${css}</style>`);
  const isolated = session.fromPartition("rail-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const run = code => window.webContents.executeJavaScript(code);
  window.webContents.focus();
  window.webContents.sendInputEvent({type:"keyDown",keyCode:"Tab"});
  window.webContents.sendInputEvent({type:"keyUp",keyCode:"Tab"});
  let scenarios = 0, hoverChecks = 0;
  const names = { "workspace-task-rail-toggle": "Tasks", "agents-toggle": "Agents", "daily-planner-toggle": "Daily tasks", "diagram-studio-rail-toggle": "Canvas", tools: "Workspace tools" };
  for (const wrapper of [false, true]) {
    // Match frontend/app/page.jsx as well as the legacy/static shell.
    if (wrapper) await run(`{const root=document.createElement('div');root.id='argus-next-root';root.append(...document.body.childNodes);document.body.append(root);}`);
    for (const width of [380, 1440]) for (const font of ["system", "comic-sans"]) for (const theme of ["dark", "light"]) for (const zoom of [1, 1.22]) for (const mode of ["repository", "daily-planner", "diagrams", "fresh"]) for (const open of [false, true]) {
    window.setContentSize(width, 900); window.webContents.setZoomFactor(zoom);
    const result = await run(`(async () => {
      document.documentElement.dataset.fontFamily=${JSON.stringify(font)};
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      document.body.dataset.view=${JSON.stringify(mode === "fresh" ? "repository" : mode)};
      document.body.className=${JSON.stringify(mode === "repository" ? "task-context-visible" : mode === "fresh" ? "repository-workspace-empty" : "")};
      document.querySelector('#workspace').classList.toggle('hidden',${mode !== "repository"});
      document.querySelector('.context-strip').classList.toggle('hidden',${mode !== "repository"});
      // Match syncWorkspaceRail: history is available only for an active chat scope.
      document.querySelector('#workspace-task-rail-toggle').classList.toggle('hidden',${mode !== "repository"});
      document.querySelector('#daily-planner-toggle').classList.toggle('active',${mode === "daily-planner"});
      document.querySelector('#diagram-studio-rail-toggle').classList.toggle('active',${mode === "diagrams"});
      document.querySelector('#app-menu').open=${open};
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const box = element => { const r=element.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
      document.activeElement?.blur();
      const controls=[...document.querySelectorAll('.workspace-rail-action, #app-menu > summary')].filter(element=>element.checkVisibility());
      return controls.map(element => {
        const icon=element.querySelector('svg'), label=element.querySelector('.workspace-rail-tooltip');
        const bounds=box(element), style=getComputedStyle(icon), hidden=getComputedStyle(label).visibility==='hidden';
        element.focus();
        const focused=getComputedStyle(label), labelBounds=box(label);
        const result={id:element.id||'tools',bounds,icon:box(icon),transform:style.transform,buttonTransform:getComputedStyle(element).transform,
          reachable:element.contains(document.elementFromPoint((bounds.left+bounds.right)/2,(bounds.top+bounds.bottom)/2)),
          label:label.textContent, name:element.getAttribute('aria-label'), decorative:icon.getAttribute('aria-hidden'),
          tooltipHidden:hidden,tooltipVisible:focused.visibility==='visible'&&focused.opacity==='1',tooltipBounds:labelBounds,
          tooltipPointerEvents:focused.pointerEvents,tooltipWritingMode:focused.writingMode,
          focusOutline:getComputedStyle(element).outlineStyle,viewportWidth:innerWidth,
          expectedRailTop:box(document.querySelector('.titlebar')).bottom+${mode === "repository" ? "box(document.querySelector('.context-strip')).height" : "0"}+7};
        element.blur();
        return result;
      });
    })()`);
    assert.ok(result.length >= 4);
    for (const control of result) {
      const context = JSON.stringify({ wrapper, width, font, theme, zoom, mode, open, control });
      assert.equal(control.transform, "none", context);
      assert.equal(control.buttonTransform, "none", context);
      assert.ok(control.reachable, context);
      assert.equal(control.label, names[control.id], context);
      assert.ok(control.name?.startsWith('Open '), context);
      assert.equal(control.decorative, "true", context);
      assert.ok(control.tooltipHidden && control.tooltipVisible, context);
      assert.equal(control.tooltipPointerEvents, "none", context);
      assert.equal(control.tooltipWritingMode, "horizontal-tb", context);
      assert.equal(control.focusOutline, "solid", context);
      assert.ok(control.tooltipBounds.left > control.bounds.right && control.tooltipBounds.right <= control.viewportWidth, context);
      assert.ok(Math.abs(control.bounds.width-32)<0.1 && Math.abs(control.bounds.height-32)<0.1, context);
      assert.ok(Math.abs(control.icon.width-20)<0.1 && Math.abs(control.icon.height-20)<0.1, context);
      assert.ok(control.icon.left >= control.bounds.left - 1 && control.icon.right <= control.bounds.right + 1 && control.icon.top >= control.bounds.top - 1 && control.icon.bottom <= control.bounds.bottom + 1, context);
    }
    const ordered = result.toSorted((a,b) => a.bounds.top-b.bounds.top);
    assert.deepEqual(ordered.map(control=>control.label), mode==='repository' ? ["Tasks","Workspace tools","Agents","Daily tasks","Canvas"] : ["Workspace tools","Agents","Daily tasks","Canvas"]);
    assert.ok(Math.abs(ordered[0].bounds.top-ordered[0].expectedRailTop)<0.1, JSON.stringify({ mode, control:ordered[0] }));
    for(let i=1;i<ordered.length;i++) assert.ok(Math.abs(ordered[i].bounds.top-ordered[i-1].bounds.bottom-6)<0.1);
    scenarios++;
    if (wrapper && width === 1440 && font === "comic-sans" && theme === "dark" && zoom === 1 && ["daily-planner", "diagrams"].includes(mode)) {
      await run("new Promise(resolve => setTimeout(resolve, 50))");
      await fs.writeFile(path.join(temporary, `rail-${mode}-${open ? "open" : "closed"}.png`), (await window.webContents.capturePage({ x: 0, y: 0, width: 340, height: 300 })).toPNG());
    }
    }
  }
  window.setContentSize(1440,900); window.webContents.setZoomFactor(1);
  await run(`document.body.className='task-context-visible';document.body.dataset.view='repository';document.documentElement.dataset.theme='dark';document.querySelector('#workspace-task-rail-toggle').classList.remove('hidden');document.querySelector('#app-menu').open=true;`);
  for (const id of Object.keys(names)) {
    const selector=id==='tools'?'#app-menu > summary':`#${id}`;
    const bounds=await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    window.webContents.sendInputEvent({ type:"mouseMove",x:Math.round(bounds.x),y:Math.round(bounds.y) });
    await run("new Promise(resolve => setTimeout(resolve, 50))");
    const tooltip=await run(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}).querySelector('.workspace-rail-tooltip'),style=getComputedStyle(node),r=node.getBoundingClientRect();node.style.pointerEvents='auto';const exposed=node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));node.style.removeProperty('pointer-events');return {visible:style.visibility==='visible'&&style.opacity==='1',exposed};})()`);
    assert.ok(tooltip.visible && tooltip.exposed, JSON.stringify({id,tooltip}));
    await fs.writeFile(path.join(temporary, `rail-hover-${id}.png`), (await window.webContents.capturePage({ x:0,y:80,width:340,height:230 })).toPNG());
    hoverChecks++;
  }
  await fs.writeFile(path.join(temporary, "result.json"), JSON.stringify({ scenarios, hoverChecks }));
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timer); window?.destroy(); app.exit(1); });
