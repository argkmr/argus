// Actual project renderers and every production stylesheet, synthetic project
// models only. No backend, repository files, provider calls or user profile.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
assert.ok(temporary && path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-project-inspector-"));
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, unexpectedNetworkCount = 0;
const timer = setTimeout(() => { console.error("Project inspector fixture timed out"); app.exit(1); }, 75_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
function sourceFunction(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
app.whenReady().then(async () => {
  const sourceShell = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const sheets = [...sourceShell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  assert.ok(sheets.includes("project-structure-polish.css") && sheets.includes("font-family.css"));
  const styles = (await Promise.all(sheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = sourceShell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style>`);
  const isolated = session.fromPartition("project-inspector-polish", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { unexpectedNetworkCount++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  const application = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  const functions = ["escapeHtml", "switchProjectStructureSection", "renderProjectStructure", "moduleCards", "renderNodeProjectStructure", "renderPythonProjectStructure", "renderGenericProjectStructure", "renderJavaProjectStructure"].map(name => sourceFunction(application, name)).join("\n");
  await window.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
    const state = {};
    ${functions}
    const fixture = window.fixture = {};
    fixture.frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const modules = Array.from({length: 24}, (_, index) => ({name: 'customer-workspace-module-' + index, path:'packages/customer-workspace-module-' + index, roots: [{type:'Source',path:'packages/customer-workspace-module-' + index + '/src/components/details'}, {type:'Tests',path:'packages/customer-workspace-module-' + index + '/src/test'}],compilerOutput:'build/classes/customer-workspace-module-' + index}));
    const scripts = Array.from({length: 24}, (_, index) => ({name: 'local-command-' + index, command:'node tools/customer-workspace-module-' + index + '/runner.js --environment=local --configuration=local-testing'}));
    const base = {repository:{name:'nextjs-web',path:'/synthetic/nextjs-web'},framework:'Next.js',modules,scripts,build:{tool:'npm',files:['package.json','package-lock.json']},dependencies:{production:50,development:36}};
    fixture.models = {
      node: {...base,projectType:'node',runtime:{packageManager:'npm',nodeVersion:'20.20.0',requiredNode:'20.x',configuredNode:'20.20.0',packageManagerVersion:'10.8.2',dependenciesInstalled:true,dependencyDirectory:'node_modules'}},
      python: {...base,projectType:'python',repository:{name:'customer-mcp-tools'},framework:'FastMCP',runtime:{packageManager:'uv',pythonVersion:'3.12.8',configuredPython:'3.12',entryPoint:'src/customer/mcp/server.py',packageManagerVersion:'0.5.0',virtualEnvironment:'.venv',dependenciesInstalled:true,installCommand:'uv sync'}},
      generic: {...base,projectType:'generic',repository:{name:'infrastructure-config'},framework:'Configuration',runtime:{languages:Array.from({length:24},(_,index)=>({name:'Language ' + index,count:45 + index}))}},
      java: {...base,projectType:'java',repository:{name:'customer-api'},framework:'Spring Boot',build:{tool:'Gradle',version:'8.12',files:['build.gradle','settings.gradle']},languageLevel:'Java 17',compilerOutput:'build/classes/java/main',settings:{javaHome:'/synthetic/java/temurin-0/Contents/Home'},jdks:Array.from({length:12},(_,index)=>({name:'Temurin JDK ' + (17+index),version:String(17+index)+'.0.1',vendor:'Eclipse Adoptium',architecture:'aarch64',path:'/synthetic/java/temurin-' + index + '/Contents/Home'}))}
    };
    $('#project-structure-dialog').addEventListener('click', event => { const button=event.target.closest('[data-project-section]');if(button)switchProjectStructureSection(button.dataset.projectSection); });
    fixture.configure = async ({font,theme,zoom,type,section}) => {
      document.documentElement.dataset.fontFamily = font; document.documentElement.dataset.theme = theme;
      document.body.style.zoom = String(zoom);
      const dialog = $('#project-structure-dialog'); if(!dialog.open) dialog.show();
      renderProjectStructure(fixture.models[type]);
      const button = $('[data-project-section="' + section + '"]');
      button.scrollIntoView({block:'nearest',inline:'nearest'}); button.click();
      await fixture.frames();
    };
    fixture.geometry = () => {
      const rect = node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
      const card=$('.project-structure-card'),content=$('.project-structure-content'),footer=$('.project-structure-actions'),nav=$('.project-structure-nav'),active=$('[data-project-section].active');
      const pane=$('.project-structure-pane:not(.hidden)');
      return {viewport:{width:innerWidth,height:innerHeight},card:rect(card),content:rect(content),footer:rect(footer),heading:rect($('.project-structure-heading')),nav:rect(nav),pane:rect(pane),active:active.getAttribute('aria-current'),padding:parseFloat(getComputedStyle(content).paddingLeft),overflow:content.scrollWidth>content.clientWidth+1,scrollable:content.scrollHeight>content.clientHeight+2,scrollTop:content.scrollTop,dialogName:$('#project-structure-dialog').getAttribute('aria-labelledby'),buttons:[...footer.querySelectorAll('button')].filter(node=>node.checkVisibility()).map(node=>({text:node.textContent,...rect(node)}))};
    };
    fixture.lastVisible = async () => {
      const content=$('.project-structure-content'),pane=$('.project-structure-pane:not(.hidden)');
      content.scrollTop=content.scrollHeight;
      await fixture.frames();
      const last=pane.lastElementChild.lastElementChild || pane.lastElementChild;
      const bounds=last.getBoundingClientRect(),viewport=content.getBoundingClientRect();
      return {bottom:bounds.bottom,viewportBottom:viewport.bottom,scrollTop:content.scrollTop};
    };
    void 0;
  `);
  const result={ok:true,scenarios:0,scrollChecks:0,maxOverviewHeight:0};
  const viewports=[{width:1440,height:900,zoom:1},{width:1024,height:768,zoom:1.22},{width:440,height:700,zoom:1},{width:380,height:700,zoom:1.22},{width:1440,height:900,zoom:2}];
  for(const viewport of viewports) {
    window.setContentSize(viewport.width,viewport.height);
    await window.webContents.executeJavaScript(`new Promise(resolve=>{const check=()=>innerWidth===${viewport.width}?resolve():requestAnimationFrame(check);check();})`);
    for(const font of ['system','comic-sans']) for(const theme of ['dark','light']) for(const type of ['node','python','generic','java']) for(const section of ['project','modules','sdks','build']) {
      const scenario={...viewport,font,theme,type,section};
      const geometry=await window.webContents.executeJavaScript(`(async()=>{await fixture.configure(${JSON.stringify(scenario)});return fixture.geometry();})()`);
      const diagnostic=JSON.stringify({scenario,...geometry});
      assert.ok(geometry.card.width<=900*viewport.zoom+1, 'Inspector must not stretch across the workspace: '+diagnostic);
      assert.ok(geometry.card.left>=0&&geometry.card.right<=viewport.width+1&&geometry.card.top>=0&&geometry.card.bottom<=viewport.height+1,'Inspector is outside viewport: '+diagnostic);
      assert.ok(geometry.heading.bottom<=geometry.nav.top+1&&geometry.nav.bottom<=geometry.content.top+1&&geometry.content.bottom<=geometry.footer.top+1,'Inspector regions overlap: '+diagnostic);
      assert.ok(geometry.footer.bottom<=geometry.card.bottom+1,'Footer clipped: '+diagnostic);
      assert.ok(geometry.padding>=12,'Content padding lost: '+diagnostic);
      assert.equal(geometry.active,'page',diagnostic);
      assert.equal(geometry.dialogName,'project-structure-title',diagnostic);
      assert.equal(geometry.overflow,false,'Horizontal content overflow: '+diagnostic);
      assert.equal(geometry.scrollTop,0,'Changing section must reset its scroll position: '+diagnostic);
      assert.equal(geometry.buttons.length,type==='java'?2:1,diagnostic);
      for(const button of geometry.buttons) assert.ok(button.left>=geometry.card.left&&button.right<=geometry.card.right+1&&button.bottom<=geometry.card.bottom+1,'Action out of bounds: '+diagnostic);
      if(geometry.scrollable){const last=await window.webContents.executeJavaScript('fixture.lastVisible()');assert.ok(last.scrollTop>0&&last.bottom<=last.viewportBottom+1,'Final row cannot be reached: '+diagnostic+JSON.stringify(last));result.scrollChecks++;}
      if(viewport.width===1440&&viewport.zoom===1&&section==='project'&&type!=='java') {result.maxOverviewHeight=Math.max(result.maxOverviewHeight,geometry.card.height);assert.ok(geometry.card.height<480,'Overview still has excessive blank height: '+diagnostic);}
      if(process.env.ARGUS_PROJECT_INSPECTOR_CAPTURE==='1'&&font==='comic-sans'&&theme==='dark'&&section==='project'&&['node','java'].includes(type)&&[1440,440].includes(viewport.width)&&viewport.zoom===1){
        await window.webContents.executeJavaScript("$('.project-structure-content').scrollTop=0;new Promise(resolve=>setTimeout(resolve,120));");
        await fs.writeFile(path.join(temporary,`project-${type}-${viewport.width}.png`),(await window.webContents.capturePage()).toPNG());
      }
      result.scenarios++;
    }
  }
  result.unexpectedNetworkCount=unexpectedNetworkCount;
  console.log('PROJECT_INSPECTOR_RESULT='+JSON.stringify(result));finish(0);
}).catch(error=>{console.error(error.stack||error);finish(1);});
