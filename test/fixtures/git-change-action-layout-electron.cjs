// Real CSS and changeRow renderer; synthetic files only. No application backend,
// real repositories, mutation handlers or live Argus profile are loaded.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const temporary = process.argv[2];
assert.ok(temporary && path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-git-action-layout-"), "Isolated test directory required");
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
const root = path.resolve(__dirname, "../.."), publicRoot = path.join(root, "public");
let window, unexpectedNetwork = 0;
const timer = setTimeout(() => { console.error("Git action layout fixture timed out"); app.exit(1); }, 40_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };

app.whenReady().then(async () => {
  const index = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const sheets = [...index.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  assert.ok(sheets.includes("repository-ide.css") && sheets.includes("font-family.css"), "Use the production IDE and font overrides");
  const styles = (await Promise.all(sheets.map(file => fs.readFile(path.join(publicRoot, file), "utf8")))).join("\n");
  const source = await fs.readFile(path.join(publicRoot, "app.js"), "utf8");
  const declaration = name => {
    const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
    assert.ok(start >= 0, name);
    const next = source.slice(start + 1).search(/\n(?:async )?function \w+\(/);
    return source.slice(start, next < 0 ? undefined : start + next + 1);
  };
  const context = vm.createContext({
    state: { activeRepository: { id: "synthetic" }, selectedGitChanges: new Set(), gitActionRepositories: new Set() },
    escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  });
  vm.runInContext(["gitSelectionKey", "changeRow"].map(declaration).join("\n"), context);
  const rows = [];
  for (const staged of [true, false]) for (const status of ["modified", "added"]) {
    const file = status === "added" ? "src/components/PageComponents/SelectedTicketDetails/DeeplyNestedDirectory/CallbackTranscriptWithAVeryLongFileName.jsx" : "package-lock.json";
    rows.push(context.changeRow({ file, status, index: status === "added" ? "A" : "M" }, staged));
  }
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style></head><body class="repository-ide-enabled" data-view="repository"><main class="repository-ide" data-version-control-open="true" style="width:740px;height:750px"><section id="fixture-slot" class="repository-ide-version-control-slot" style="width:480px;height:700px;flex:none"><aside class="git-panel"><header class="panel-header"><div><div class="eyebrow">Version Control</div><h2>Synthetic repository</h2></div></header><section id="git-changes" class="git-view"><div id="change-list" class="change-list"><div class="change-group-title">STAGED / CHANGES<span>4</span></div>${rows.join("")}</div></section></aside></section></main></body></html>`;
  const isolated = session.fromPartition("git-action-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith("data:");
    if (!allowed) unexpectedNetwork++;
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({ show: false, width: 1100, height: 1000, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.setContentSize(1100, 1000);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const run = script => window.webContents.executeJavaScript(script);
  await run(`window.fixture = {
    measure() {
      const rect = node => { const b=node.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}; };
      const slot=document.querySelector('#fixture-slot'), list=document.querySelector('#change-list');
      return {slot:rect(slot), list:rect(list), clientWidth:list.clientWidth, scrollWidth:list.scrollWidth, rows:[...list.querySelectorAll('.change-row')].map(row=>{
        const file=row.querySelector('.file-name'), actions=row.querySelector('.change-actions');
        return {bounds:rect(row), file:rect(file), fullPath:file.title, actions:rect(actions), buttons:[...actions.querySelectorAll('button')].map(button=>{
          const css=getComputedStyle(button), range=document.createRange(); range.selectNodeContents(button);
          const b=rect(button), t=range.getBoundingClientRect();
          const content={left:b.left+parseFloat(css.borderLeftWidth)+parseFloat(css.paddingLeft),right:b.right-parseFloat(css.borderRightWidth)-parseFloat(css.paddingRight),top:b.top+parseFloat(css.borderTopWidth)+parseFloat(css.paddingTop),bottom:b.bottom-parseFloat(css.borderBottomWidth)-parseFloat(css.paddingBottom)};
          button.focus();
          const hit=document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);
          return {label:button.textContent,bounds:b,text:{left:t.left,right:t.right,top:t.top,bottom:t.bottom},content,focused:document.activeElement===button,reachable:button===hit||button.contains(hit),font:css.fontFamily,fontSize:css.fontSize};
        })};
      })};
    }
  }; undefined;`);
  const settle = zoom => run(`(async()=>{
    await document.fonts.ready;
    let previous='',stable=0; const deadline=performance.now()+5000;
    while(performance.now()<deadline) {
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const sample=JSON.stringify([innerWidth,innerHeight,document.querySelector('.change-actions').getBoundingClientRect().width]);
      const matches=Math.abs(innerWidth-${1100 / zoom})<=1 && Math.abs(innerHeight-${1000 / zoom})<=1;
      stable=matches && previous===sample ? stable+1 : 0; previous=sample;
      if(stable>=2)return;
    }
    throw new Error('Git action layout did not settle: '+previous);
  })()`);
  // Negative control restores only the two faulty declarations in an isolated
  // stylesheet. It verifies text geometry catches what scrollWidth alone misses.
  await run(`document.documentElement.dataset.fontFamily='comic-sans';const old=document.createElement('style');old.id='old-css';old.textContent='.change-actions button { width:auto; flex:0 0 22px; }';document.head.append(old);undefined;`);
  await settle(1);
  const oldResult = await run("fixture.measure()");
  const oldCssReproducesOverflow = oldResult.rows.some(row => row.buttons.some(button => button.label === "Unstage" && button.text.right > button.content.right + .75));
  assert.equal(oldCssReproducesOverflow, true, JSON.stringify(oldResult));
  if (process.env.ARGUS_GIT_ACTION_LAYOUT_CAPTURE === "1") await fs.writeFile(path.join(temporary, "before-comic-sans-480.png"), (await window.webContents.capturePage()).toPNG());
  await run("document.querySelector('#old-css').remove();undefined;");
  const layouts = [], labels = new Set();
  for (const zoom of [1.04, 1.12, 1.22]) {
    window.webContents.setZoomFactor(zoom);
    for (const width of [240, 280, 340, 360, 480, 720]) for (const theme of ["dark", "light"]) for (const font of ["system", "serif", "mono", "comic-sans"]) {
      await run(`document.querySelector('#fixture-slot').style.width=${JSON.stringify(width + "px")};document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};undefined;`);
      await settle(zoom);
      const result = await run("fixture.measure()"), diagnostic = JSON.stringify({ width, theme, font, zoom, ...result });
      assert.ok(result.scrollWidth <= result.clientWidth + 1, "List overflows horizontally: " + diagnostic);
      for (const row of result.rows) {
        assert.ok(row.bounds.left >= result.slot.left - .75 && row.bounds.right <= result.slot.right + .75, "Row escapes its panel: " + diagnostic);
        assert.ok(row.actions.right <= row.bounds.right + .75, "Actions escape row: " + diagnostic);
        assert.ok(row.file.width > 0 && row.fullPath.length > 0, "Filename must remain available with full-path tooltip: " + diagnostic);
        if (width <= 340) assert.ok(row.actions.top >= row.file.bottom - .75, "Narrow docks must move actions below filename: " + diagnostic);
        else assert.ok(row.file.right <= row.actions.left + .75, "Filename overlaps actions: " + diagnostic);
        assert.ok(row.buttons[0].bounds.right <= row.buttons[1].bounds.left - 1, "Action buttons overlap: " + diagnostic);
        for (const button of row.buttons) {
          labels.add(button.label);
          assert.ok(button.text.left >= button.content.left - .75 && button.text.right <= button.content.right + .75, "Action label consumes padding or overflows: " + diagnostic);
          assert.ok(button.text.top >= button.bounds.top - .75 && button.text.bottom <= button.bounds.bottom + .75, "Action label clips vertically: " + diagnostic);
          assert.ok(button.bounds.left >= row.bounds.left - .75 && button.bounds.right <= row.bounds.right + .75, "Button escapes row: " + diagnostic);
          assert.equal(button.focused, true, "Action cannot receive keyboard focus: " + diagnostic);
          assert.equal(button.reachable, true, "Action is obscured at its click target: " + diagnostic);
        }
      }
      if (process.env.ARGUS_GIT_ACTION_LAYOUT_CAPTURE === "1" && theme === "dark" && font === "comic-sans" && zoom === 1.22 && [280, 480].includes(width)) await fs.writeFile(path.join(temporary, `after-${font}-${width}-${zoom}.png`), (await window.webContents.capturePage()).toPNG());
      layouts.push({ width, theme, font, zoom });
    }
  }
  await fs.writeFile(path.join(temporary, "results.json"), JSON.stringify({ layouts, labels: [...labels].sort(), unexpectedNetwork, oldCssReproducesOverflow }, null, 2));
  finish(0);
}).catch(error => { console.error(error.stack || error); finish(1); });
