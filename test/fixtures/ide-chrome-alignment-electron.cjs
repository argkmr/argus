// Production styles and Git markup; isolated synthetic renderer, no backend or saved data.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-ide-chrome-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, networkRequests = 0;
const deadline = setTimeout(() => { console.error("IDE chrome fixture timed out"); app.exit(1); }, 40_000);
const run = script => window.webContents.executeJavaScript(script);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1.1, `${label}: ${actual} vs ${expected}`);
app.whenReady().then(async () => {
  const source = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const sheets = [...source.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const css = (await Promise.all(sheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${css}</style>`);
  const isolated = session.fromPartition("ide-chrome-alignment", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  await run(`
    document.body.dataset.view = 'repository';
    document.body.classList.add('repository-ide-enabled', 'repository-ide-chat-hidden', 'task-context-visible');
    document.querySelector('#workspace').classList.remove('hidden');
    document.querySelector('.ai-canvas').classList.add('task-panel-collapsed');
    const host = document.querySelector('#repository-ide-host'); host.hidden = false;
    host.innerHTML = '<section class="repository-ide" data-version-control-open="true"><header class="repository-ide-toolbar"><button class="repository-ide-icon-button" aria-label="Files">▤</button><button class="repository-ide-icon-button" aria-label="Version control">⑂</button><button class="repository-ide-search-launcher">Search code</button></header><div class="repository-ide-body"><section class="repository-ide-version-control-slot"></section><aside class="repository-ide-tree-pane"><header class="repository-ide-section-header"><strong>FILES</strong><button aria-label="Refresh files">↻</button></header><div class="repository-ide-tree">src<br>ReviewController.java</div></aside><div class="repository-ide-tree-divider ide-splitter"></div><div class="repository-ide-main"><div class="repository-ide-tabs"><div class="repository-ide-tab" data-active="true"><button class="repository-ide-tab-name">ReviewController.java</button><button class="repository-ide-tab-close" aria-label="Close file">×</button></div></div><div class="repository-ide-path">src/main/java/example/ReviewController.java</div><div class="repository-ide-editor-wrap"><div class="repository-ide-editor-empty">Repository editor</div></div><section class="repository-ide-tool-dock" data-open="false"><div class="repository-ide-tool-resizer ide-splitter"></div><header class="repository-ide-tool-header"><div class="repository-ide-tool-tabs" role="tablist"><button class="repository-ide-tool-tab" role="tab">Terminal</button><button class="repository-ide-tool-tab" role="tab">Run logs</button><button class="repository-ide-tool-tab" role="tab">Debugger</button></div><span class="repository-ide-tool-status">Running</span><button class="repository-ide-icon-button" aria-label="Maximize tools">□</button></header><div class="repository-ide-tool-content" hidden><div class="repository-ide-empty">Synthetic process output</div></div></section></div></div><footer class="repository-ide-footer"><span class="repository-ide-notice">Language navigation uses local servers; files are saved only on request.</span><span class="repository-ide-position">Ln 1, Col 1</span></footer></section>';
    host.querySelector('.repository-ide-version-control-slot').append(document.querySelector('.git-panel'));
    document.querySelector('#git-repo-name').textContent = 'nextjs-web';
    document.querySelector('#branch-name').textContent = 'feature/compact-professional-workspace';
    document.querySelector('#change-list').innerHTML = Array.from({length: 30}, (_,i) => '<div class="change-row"><input class="change-selector" type="checkbox" aria-label="Select changed file"><span class="file-status">M</span><span class="file-name"><strong>ReviewController' + i + '.java</strong><small>src/main/java/example</small></span><div class="change-actions"><button>Stage</button></div></div>').join('');
    document.querySelector('#context-repo').textContent = 'nextjs-web'; document.querySelector('#context-branch').textContent = 'feature/compact-professional-workspace';
    const rect = node => { const r = node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
    window.fixture = { host, ide:host.querySelector('.repository-ide'), dock:host.querySelector('.repository-ide-tool-dock') };
    fixture.frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fixture.measure = () => {
      const q = selector => host.querySelector(selector), push = q('.push-bar'), header = q('.repository-ide-tool-header'), view = q('#git-changes');
      const previous = view.scrollTop; view.scrollTop = view.scrollHeight; const scrolls = view.scrollTop > 0; view.scrollTop = previous;
      const button = node => { const r = rect(node), text = document.createRange(); text.selectNodeContents(node); const t = text.getBoundingClientRect(); return {...r,textTop:t.top,textBottom:t.bottom,textLeft:t.left,textRight:t.right,uncovered:node.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2))}; };
      return { ide:rect(fixture.ide), body:rect(q('.repository-ide-body')), gitHeader:rect(q('.panel-header')), treeHeader:rect(q('.repository-ide-section-header')), tabs:rect(q('.repository-ide-tabs')), push:rect(push), toolHeader:rect(header), dock:rect(fixture.dock), footer:rect(q('.repository-ide-footer')), notice:rect(q('.repository-ide-notice')), position:rect(q('.repository-ide-position')), scale:rect(fixture.ide).width / fixture.ide.offsetWidth, buttons:[...push.children].map(button), view:rect(view), scrolls, panelScroll:q('.git-panel').scrollHeight-q('.git-panel').clientHeight };
    };
    void 0;
  `);
  let scenarios = 0;
  for (const width of [1440, 980, 640, 420]) for (const height of [900, 500]) for (const zoom of [1, 1.22]) {
    window.setContentSize(width, height); window.webContents.setZoomFactor(zoom);
    await run(`new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error('Viewport did not settle')),3000); const check=()=>{if(Math.abs(innerWidth-${width/zoom})<=1&&Math.abs(innerHeight-${height/zoom})<=1){clearTimeout(timer);resolve();}else requestAnimationFrame(check);};check(); })`);
    for (const theme of ["dark", "light"]) for (const font of ["system", "serif", "mono", "comic-sans"]) for (const open of [false, true]) {
      const value = await run(`(async () => { document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};fixture.ide.dataset.versionControlOpen='true'; fixture.dock.dataset.open=${JSON.stringify(String(open))};fixture.dock.querySelector('.repository-ide-tool-content').hidden=${!open}; await fixture.frames();return fixture.measure(); })()`);
      const label = `${width}x${height} zoom=${zoom} ${theme}/${font} open=${open}`;
      if (process.env.ARGUS_IDE_CHROME_BASELINE === "1") {
        if (scenarios === 0) { console.log('IDE_CHROME_BASELINE='+JSON.stringify(value));await run("document.fonts.ready.then(() => new Promise(resolve => setTimeout(resolve,100)))");await fs.writeFile(path.join(temporary,"before.png"),(await window.webContents.capturePage()).toPNG()); }
      } else {
        near(value.push.height,36*value.scale,`${label}: Git footer uses shared row height`);
        near(value.toolHeader.height,36*value.scale,`${label}: tools use shared row height`);
        near(value.push.bottom,value.body.bottom,`${label}: Git footer stays pinned`);
        near(value.gitHeader.height,value.tabs.height,`${label}: Git and file heading rows align`);
        near(value.gitHeader.height,36*value.scale,`${label}: headings use shared row height`);
        near(value.footer.bottom,value.ide.bottom,`${label}: status footer stays on the IDE bottom edge`);
        assert.ok(value.notice.right<=value.position.left&&value.position.right<=value.footer.right&&value.position.bottom<=value.footer.bottom,`${label}: status text and cursor position remain separate and inside footer`);
        if (!open) { near(value.push.top,value.dock.top,`${label}: footer top rules align`);near(value.push.bottom,value.toolHeader.bottom,`${label}: footer bottom rules align`); }
        for(const button of value.buttons){
          assert.ok(button.height>=27*value.scale,`${label}: accessible button height`);
          assert.equal(button.uncovered,true,`${label}: Git actions can be clicked`);
          assert.ok(button.top>=value.push.top&&button.bottom<=value.push.bottom+.5,`${label}: buttons stay inside footer`);
          assert.ok(button.textTop>=button.top&&button.textBottom<=button.bottom+.5&&button.textLeft>=button.left&&button.textRight<=button.right+.5,`${label}: button labels fit`);
        }
        assert.equal(value.panelScroll,0,`${label}: whole Git panel does not scroll its footer away`);
        assert.ok(value.view.height>=40*value.scale,`${label}: Git content remains usable in short windows`);
        if(height===500)assert.equal(value.scrolls,true,`${label}: short Git changes scroll independently`);
        const tree=await run("(async()=>{fixture.ide.dataset.versionControlOpen='false';await fixture.frames();return fixture.measure();})()");
        near(tree.treeHeader.height,tree.tabs.height,`${label}: Files and editor header heights align`);
        near(tree.treeHeader.bottom,tree.tabs.bottom,`${label}: Files and editor bottom rules align`);
        await run("fixture.ide.dataset.versionControlOpen='true'");
      }
      if(process.env.ARGUS_IDE_CHROME_CAPTURE==='1'&&width===1440&&height===900&&zoom===1&&font==='comic-sans'&&theme==='dark'){
        await run("document.fonts.ready.then(() => new Promise(resolve=>setTimeout(resolve,100)))");
        await fs.writeFile(path.join(temporary,`aligned-${open?'open':'closed'}.png`),(await window.webContents.capturePage()).toPNG());
      }
      scenarios++;
    }
  }
  console.log('IDE_CHROME_RESULT='+JSON.stringify({ok:true,scenarios,networkRequests}));
  clearTimeout(deadline);window.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack||error);clearTimeout(deadline);window?.destroy();app.exit(1);});
