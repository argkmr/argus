// Synthetic DOM and paths only; no Argus backend or live profile is opened.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
assert.ok(temporary && path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-git-bulk-ui-"));
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
let window, unexpectedNetwork = 0;
const timer = setTimeout(() => { console.error("Bulk Git UI fixture timed out"); app.exit(1); }, 40000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, "../.."), publicRoot = path.join(root, "public");
  const html = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(sheets.map(file => fs.readFile(path.join(publicRoot, file), "utf8")))).join("\n");
  const toolbar = html.slice(html.indexOf('<div id="change-selection-toolbar"'), html.indexOf('<div id="change-list"')).replace("change-selection-toolbar hidden", "change-selection-toolbar");
  const module = (await fs.readFile(path.join(publicRoot, "git-bulk-revert.mjs"), "utf8")).replaceAll("export function", "function");
  const isolated = session.fromPartition("git-bulk-revert-ui", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => { const allowed = details.url.startsWith("data:"); if (!allowed) unexpectedNetwork++; callback({ cancel: !allowed }); });
  window = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style></head><body class="repository-ide-enabled" data-view="repository"><main class="repository-ide" data-version-control-open="true" style="width:100%;height:750px"><section id="fixture-slot" class="repository-ide-version-control-slot" style="width:280px;height:700px;flex:none"><aside class="git-panel"><section id="git-changes" class="git-view">${toolbar}</section></aside></section></main></body></html>`)}`);
  const run = code => window.webContents.executeJavaScript(code);
  await run(`${module}; window.confirmGitBulkRevert=confirmGitBulkRevert; window.fixtureFiles=Array.from({length:25},(_,i)=>({file:i===0?'<img src=x onerror="window.injected=true">.txt':'src/components/VeryLongDirectoryName/AnotherFolder/SelectedChange'+i+'.java',staged:i%2===0})); undefined;`);
  let scenarios = 0;
  for (const width of [360, 740, 1100]) for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans"]) for (const count of [2, 25]) {
    window.setContentSize(width, 800);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};document.querySelector('#fixture-slot').style.width=${JSON.stringify(Math.min(width - 24, 340) + "px")};document.querySelector('#change-selection-count').textContent='${count} selected';window.confirmed=null;confirmGitBulkRevert({document,repository:{id:'synthetic',name:'Synthetic repository',path:'/synthetic/repository-with-a-long-name'},files:fixtureFiles.slice(0,${count}),preview:{recoveryDirectory:'/synthetic/argus/git-recovery'},isCurrent:()=>true}).then(value=>window.confirmed=value);undefined;`);
    const result = await run(`(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));const rect=n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}};const d=document.querySelector('#git-bulk-revert-dialog'),footer=d.querySelector('footer'),toolbar=document.querySelector('#change-selection-toolbar');return {width:innerWidth,height:innerHeight,dialog:rect(d),dialogOverflow:d.scrollWidth-d.clientWidth,footer:rect(footer),cancelDefault:document.activeElement===footer.children[0],files:d.querySelectorAll('li').length,escapedPaths:!d.querySelector('img')&&!window.injected,toolbar:rect(toolbar),toolbarOverflow:toolbar.scrollWidth-toolbar.clientWidth,buttons:[...toolbar.querySelectorAll('button'),...footer.querySelectorAll('button')].map(n=>({label:n.textContent,...rect(n)}))};})()`);
    const message = JSON.stringify({ width, theme, font, count, ...result });
    assert.equal(result.files, count, message); assert.equal(result.cancelDefault, true, message); assert.equal(result.escapedPaths, true, message);
    assert.ok(result.dialog.left >= 0 && result.dialog.right <= result.width + 1 && result.dialog.top >= 0 && result.dialog.bottom <= result.height + 1, message);
    assert.ok(result.dialogOverflow <= 1 && result.toolbarOverflow <= 1, message);
    assert.ok(result.footer.bottom <= result.dialog.bottom + 1, message);
    for (const button of result.buttons) assert.ok(button.left >= 0 && button.right <= result.width + 1 && button.height >= 28, message);
    if (process.env.ARGUS_GIT_BULK_CAPTURE === "1" && width === 740 && font === "system" && count === 25) {
      await run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await fs.writeFile(path.join(temporary, `${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await run("document.querySelector('#git-bulk-revert-dialog footer button').click();undefined;");
    assert.equal(await run("window.confirmed"), false);
    scenarios++;
  }
  await fs.writeFile(path.join(temporary, "results.json"), JSON.stringify({ scenarios, unexpectedNetwork, escapedPaths: true, cancelDefault: true }));
  finish(0);
}).catch(error => { console.error(error.stack || error); finish(1); });
