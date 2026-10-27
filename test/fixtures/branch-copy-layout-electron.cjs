// Exact production branch-bar markup and every production stylesheet. Synthetic
// state only: no application scripts, backend, repositories or clipboard access.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
assert.ok(temporary && path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-branch-copy-layout-"), "Isolated test directory required");
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
const root = path.resolve(__dirname, "../.."), publicRoot = path.join(root, "public");
let window, unexpectedNetwork = 0;
const timer = setTimeout(() => { console.error("Branch copy layout fixture timed out"); app.exit(1); }, 40_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };

app.whenReady().then(async () => {
  const index = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const sheets = [...index.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  assert.ok(sheets.includes("repository-ide.css") && sheets.includes("font-family.css"), "Use production IDE and font overrides");
  const styles = (await Promise.all(sheets.map(file => fs.readFile(path.join(publicRoot, file), "utf8")))).join("\n");
  const branchBar = index.match(/<div class="branch-bar">[\s\S]*?<\/div>/)?.[0];
  assert.ok(branchBar?.includes('id="copy-branch-button"'), "Use the production branch copy button");
  const { FONT_SIZE_ZOOM } = await import(pathToFileURL(path.join(publicRoot, "font-size.js")));
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style></head><body class="repository-ide-enabled" data-view="repository"><main class="repository-ide" data-version-control-open="true" style="width:740px;height:400px"><section id="fixture-slot" class="repository-ide-version-control-slot" style="width:420px;height:400px;flex:none"><aside class="git-panel"><header class="panel-header"><div><div class="eyebrow">Version Control</div><h2>Synthetic repository</h2></div></header>${branchBar}</aside></section></main></body></html>`;
  const isolated = session.fromPartition("branch-copy-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith("data:");
    if (!allowed) unexpectedNetwork++;
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.setContentSize(1000, 700);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const run = script => window.webContents.executeJavaScript(script);
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await run(`window.fixture = {
    measure() {
      const rect=node=>{const b=node.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};};
      const bar=document.querySelector('.branch-bar'), name=document.querySelector('#branch-name');
      const nameStyle=getComputedStyle(name);
      return {
        bar:rect(bar), clientWidth:bar.clientWidth, scrollWidth:bar.scrollWidth,
        name:{bounds:rect(name),overflow:nameStyle.overflow,textOverflow:nameStyle.textOverflow,whiteSpace:nameStyle.whiteSpace},
        controls:['branch-selector','copy-branch-button','fetch-button'].map(id=>{
          const button=document.getElementById(id), b=rect(button), css=getComputedStyle(button);
          const children=[...button.children].filter(node=>getComputedStyle(node).display!=='none').map(node=>({tag:node.tagName,id:node.id,bounds:rect(node)}));
          const content={left:b.left+parseFloat(css.borderLeftWidth)+parseFloat(css.paddingLeft),right:b.right-parseFloat(css.borderRightWidth)-parseFloat(css.paddingRight)};
          button.focus();
          const hit=document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);
          let text=null;
          if(id==='fetch-button'){const range=document.createRange();range.selectNodeContents(button);const t=range.getBoundingClientRect();text={left:t.left,right:t.right,top:t.top,bottom:t.bottom};}
          return {id,bounds:b,children,content,text,focused:document.activeElement===button,reachable:button===hit||button.contains(hit),outlineWidth:css.outlineWidth,outlineStyle:css.outlineStyle,label:button.getAttribute('aria-label'),title:button.title};
        })
      };
    }
  }; document.querySelector('#copy-branch-button').disabled=false; undefined;`);
  const settle = zoom => run(`(async()=>{
    await document.fonts.ready;
    let previous='',stable=0;const deadline=performance.now()+5000;
    while(performance.now()<deadline){
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const sample=JSON.stringify([innerWidth,innerHeight,document.querySelector('.branch-bar').getBoundingClientRect().width]);
      const matches=Math.abs(innerWidth-${1000 / zoom})<=1&&Math.abs(innerHeight-${700 / zoom})<=1;
      stable=matches&&previous===sample?stable+1:0;previous=sample;if(stable>=2)return;
    }
    throw new Error('Branch copy layout did not settle: '+previous);
  })()`);
  const layouts = [];
  const states = [{ name: "main", sync: "" }, { name: "feature/synthetic-branch-with-a-long-name-that-must-truncate", sync: "↑99 ↓99" }];
  for (const zoom of Object.values(FONT_SIZE_ZOOM)) {
    window.webContents.setZoomFactor(zoom);
    for (const width of [280, 320, 420]) for (const theme of ["dark", "light"]) for (const font of ["system", "serif", "mono", "comic-sans"]) for (const state of states) {
      await run(`document.querySelector('#fixture-slot').style.width=${JSON.stringify(width + "px")};document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};document.querySelector('#branch-name').textContent=${JSON.stringify(state.name)};document.querySelector('#sync-state').textContent=${JSON.stringify(state.sync)};document.querySelector('#copy-branch-button').classList.remove('copied');document.querySelector('#branch-copy-status').textContent='';undefined;`);
      await settle(zoom);
      const result = await run("fixture.measure()"), diagnostic = JSON.stringify({ width, theme, font, zoom, state, ...result });
      assert.ok(result.scrollWidth <= result.clientWidth + 1, "Branch bar overflows horizontally: " + diagnostic);
      assert.ok(result.name.bounds.width > 5, "Branch name has no readable space: " + diagnostic);
      assert.equal(result.name.overflow, "hidden", "Long branch must remain clipped: " + diagnostic);
      assert.equal(result.name.textOverflow, "ellipsis", "Long branch must use ellipsis: " + diagnostic);
      assert.equal(result.name.whiteSpace, "nowrap");
      for (let i = 0; i < result.controls.length; i++) {
        const button = result.controls[i];
        assert.ok(button.bounds.left >= result.bar.left - .75 && button.bounds.right <= result.bar.right + .75 && button.bounds.top >= result.bar.top - .75 && button.bounds.bottom <= result.bar.bottom + .75, "Button escapes branch bar: " + diagnostic);
        assert.equal(button.focused, true, "Button cannot receive keyboard focus: " + diagnostic);
        assert.equal(button.reachable, true, "Button is obscured at its click target: " + diagnostic);
        if (i) assert.ok(result.controls[i - 1].bounds.right <= button.bounds.left - 1, "Buttons overlap: " + diagnostic);
        for (const child of button.children) {
          assert.ok(child.bounds.left >= button.content.left - .75 && child.bounds.right <= button.content.right + .75 && child.bounds.top >= button.bounds.top - .75 && child.bounds.bottom <= button.bounds.bottom + .75, "Button child clips or consumes padding: " + diagnostic);
        }
        if (button.text) assert.ok(button.text.left >= button.content.left - .75 && button.text.right <= button.content.right + .75 && button.text.top >= button.bounds.top - .75 && button.text.bottom <= button.bounds.bottom + .75, "Fetch label clips or consumes padding: " + diagnostic);
      }
      const copy = result.controls[1];
      assert.equal(copy.label, "Copy branch name");
      assert.equal(copy.title, "Copy branch name");
      assert.ok(copy.bounds.width >= 30 && copy.bounds.height >= 30, "Copy target must remain usable: " + diagnostic);
      assert.ok(copy.children.some(child => child.tag.toLowerCase() === "svg"), "Copy icon must remain visible: " + diagnostic);
      if (process.env.ARGUS_BRANCH_COPY_LAYOUT_CAPTURE === "1" && theme === "dark" && ["system", "comic-sans"].includes(font) && zoom === 1.22 && state.sync) {
        const crop = { x: 0, y: 0, width: Math.ceil(width * zoom), height: 145 };
        await fs.writeFile(path.join(temporary, `${font}-${width}-${zoom}.png`), (await window.webContents.capturePage(crop)).toPNG());
      }
      await run("document.querySelector('#copy-branch-button').classList.add('copied');document.querySelector('#branch-copy-status').textContent='Branch name copied.';undefined;");
      const copied = await run("fixture.measure()");
      assert.deepEqual(copied.controls.map(button => button.bounds), result.controls.map(button => button.bounds), "Copy confirmation must not move controls: " + diagnostic);
      assert.deepEqual(copied.name.bounds, result.name.bounds, "Copy confirmation must not resize branch label: " + diagnostic);
      const copiedIcon = await run("({copy:getComputedStyle(document.querySelector('.branch-copy-icon')).display,check:getComputedStyle(document.querySelector('.branch-copied-icon')).display})");
      assert.equal(copiedIcon.copy, "none");
      assert.notEqual(copiedIcon.check, "none");
      layouts.push({ width, theme, font, zoom, branch: state.name });
    }
  }
  // Native Tab traversal checks the production DOM order without activating any
  // control or loading an application handler.
  const keyboardOrder = [];
  window.webContents.focus();
  await run("document.querySelector('#branch-selector').focus();undefined;");
  keyboardOrder.push(await run("document.activeElement.id"));
  for (let i = 0; i < 2; i++) {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await settle(1.22);
    keyboardOrder.push(await run("document.activeElement.id"));
    const focused = await run("(()=>{const button=document.activeElement,css=getComputedStyle(button);return {id:button.id,visible:button.matches(':focus-visible'),outlineWidth:css.outlineWidth,outlineStyle:css.outlineStyle};})()");
    assert.ok(focused.visible && parseFloat(focused.outlineWidth) > 0 && focused.outlineStyle !== "none", "Keyboard focus must have a visible outline: " + JSON.stringify(focused));
  }
  assert.deepEqual(keyboardOrder, ["branch-selector", "copy-branch-button", "fetch-button"]);
  await fs.writeFile(path.join(temporary, "results.json"), JSON.stringify({ layouts, keyboardOrder, unexpectedNetwork }, null, 2));
  finish(0);
}).catch(error => { console.error(error.stack || error); finish(1); });
