const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const temporary=process.argv[2];
if(!temporary||!path.isAbsolute(temporary)||!path.basename(temporary).startsWith('argus-canvas-ui-'))throw new Error('Isolated fixture required');
for(const name of ['userData','sessionData','logs'])app.setPath(name,path.join(temporary,name));
app.commandLine.appendSwitch('disable-background-networking');
let preview;const windows=[],external=[],errors=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(fn,label){for(let i=0;i<100;i++){if(await fn())return;await delay(100);}throw new Error('Timed out: '+label);}
async function value(win,expression){try{return await win.webContents.executeJavaScript(expression);}catch(error){throw new Error(expression+'\n'+error.message);}}
async function input(win,selector,text){await value(win,`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing input');node.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(text)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
async function click(win,selector){await value(win,`document.querySelector(${JSON.stringify(selector)})?.click()`);}
async function fieldValue(win,label){return value(win,`document.querySelector(${JSON.stringify('[aria-label="'+label+'"]')})?.value`);}
async function join(label,url){
  const isolated=session.fromPartition('canvas-ui-'+label);
  isolated.webRequest.onBeforeRequest((details,callback)=>{const url=new URL(details.url);const permitted=['127.0.0.1','localhost'].includes(url.hostname)||['data:','blob:'].includes(url.protocol);if(!permitted)external.push(url.origin);callback({cancel:!permitted});});
  isolated.on('will-download',(_event,item)=>item.setSavePath(path.join(temporary,label+'-export.json')));
  const win=new BrowserWindow({show:false,width:1440,height:980,webPreferences:{partition:'canvas-ui-'+label,contextIsolation:true,nodeIntegration:false}});windows.push(win);
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=2&&!message.includes('Electron Security Warning'))errors.push(message);});
  await win.loadURL(url);await poll(()=>value(win,'Boolean(document.querySelector("#canvas-display-name"))'),'join form');
  await input(win,'#canvas-display-name',label);await click(win,'button[type="submit"]');
  await poll(()=>value(win,'Boolean(document.querySelector(".react-flow__node"))'),label+' loaded');
  await poll(()=>value(win,'[...document.querySelectorAll("[role=status]")].some(n=>/All changes saved|Read-only/.test(n.textContent))'),label+' ready');
  return win;
}
async function draft(win){
  await value(win,`(()=>{if(!window.testBlobCapture){const original=URL.createObjectURL;URL.createObjectURL=function(blob){window.testLastBlob=blob;return original.call(this,blob);};window.testBlobCapture=true;}document.querySelector('[title="Export a copy of this board"]').click();})()`);
  return JSON.parse(await value(win,'window.testLastBlob.text()'));
}
async function finish(code){for(const win of windows)if(!win.isDestroyed())win.destroy();if(preview)await preview.close();app.exit(code);}
const timeout=setTimeout(()=>{console.error('Canvas browser integration timed out');void finish(1);},90000);
app.whenReady().then(async()=>{
  const {createCanvasPreview}=await import(pathToFileURL(path.join(__dirname,'canvas-sharing-preview.mjs')));
  preview=await createCanvasPreview(temporary,{staticRoot:path.join(temporary,'site')});
  const alice=await join('Alice',preview.editorUrl),bob=await join('Bob',preview.editorUrl);
  await input(alice,'[aria-label="Class name"]','AliceService');
  await poll(async()=>await fieldValue(bob,'Class name')==='AliceService','remote class edit');
  await input(bob,'[aria-label="Field 1 in AliceService"]','+ shared: boolean');
  await poll(async()=>await fieldValue(alice,'Field 1 in AliceService')==='+ shared: boolean','remote field edit');
  await click(alice,'[aria-label="Undo"]');
  await poll(async()=>await fieldValue(alice,'Class name')!=='AliceService','local undo');
  assert.equal((await draft(alice)).snapshot.structured.nodes[0].data.fields[0].text,'+ shared: boolean','local undo preserves other participant field');
  await click(alice,'[aria-label="Redo"]');
  await poll(async()=>await fieldValue(bob,'Class name')==='AliceService','local redo');
  if(await value(alice,'document.documentElement.dataset.theme !== "dark"'))await click(alice,'[aria-label="Toggle color theme"]');
  await delay(150);await fs.writeFile(path.join(temporary,'canvas-dark.png'),(await alice.webContents.capturePage()).toPNG());
  await click(alice,'[aria-label="Toggle color theme"]');await delay(150);await fs.writeFile(path.join(temporary,'canvas-light.png'),(await alice.webContents.capturePage()).toPNG());
  for(const win of [alice,bob]){await value(win,`[...document.querySelectorAll('.diagram-mode-tabs button')].find(n=>n.textContent==='Draw').click()`);await poll(()=>value(win,'Boolean(document.querySelector(".excalidraw__canvas"))'),'drawing loaded');}
  await poll(()=>value(alice,'Boolean(document.querySelector("[data-testid=toolbar-rectangle]"))'),'rectangle tool');
  alice.show();alice.focus();await delay(150);
  await click(alice,'[data-testid="toolbar-rectangle"]');
  await delay(150);
  const rectangle=await value(alice,'(()=>{const r=document.querySelector(".excalidraw__canvas").getBoundingClientRect();return {x:Math.round(r.left+r.width*.4),y:Math.round(r.top+r.height*.4)};})()');
  alice.webContents.sendInputEvent({type:'mouseDown',x:rectangle.x,y:rectangle.y,button:'left',clickCount:1});
  await delay(100);
  alice.webContents.sendInputEvent({type:'mouseMove',x:rectangle.x+150,y:rectangle.y+90,button:'left'});
  await delay(100);
  alice.webContents.sendInputEvent({type:'mouseUp',x:rectangle.x+150,y:rectangle.y+90,button:'left',clickCount:1});
  await delay(300);
  await fs.writeFile(path.join(temporary,'canvas-drawing-attempt.png'),(await alice.webContents.capturePage()).toPNG());
  await poll(()=>preview.state.board.snapshot.sketch.elements.some(element=>element.type==='rectangle'),'drawing persisted');
  await poll(async()=> (await draft(bob)).snapshot.sketch.elements.some(element=>element.type==='rectangle'),'drawing received by peer');
  await delay(300);const settledSaves=preview.state.saves;await delay(300);assert.equal(preview.state.saves,settledSaves,'remote drawing does not create an echo loop');
  await fs.writeFile(path.join(temporary,'canvas-sketch.png'),(await bob.webContents.capturePage()).toPNG());
  const viewer=await join('Viewer',preview.viewerUrl);
  assert.equal(await value(viewer,`document.querySelector('[aria-label="Class name"]').matches(':disabled')`),true);
  assert.equal(await value(viewer,`document.querySelector('[aria-label="Board name"]').readOnly`),true);
  const before=preview.state.saves;
  await input(viewer,'[aria-label="Class name"]','FORBIDDEN');await delay(150);
  assert.equal(preview.state.saves,before,'read-only attempted mutation never persists');
  await value(viewer,`[...document.querySelectorAll('.diagram-mode-tabs button')].find(n=>n.textContent==='Draw').click()`);
  await poll(()=>value(viewer,'Boolean(document.querySelector(".excalidraw__canvas"))'),'viewer drawing');
  assert.equal(await value(viewer,`!document.querySelector('[data-testid="toolbar-rectangle"]')?.offsetParent`),true,'viewer has no drawing tool');
  await preview.service.revokeInvite(preview.state.board.id,preview.viewer.id);
  await poll(()=>value(viewer,'document.body.textContent.includes("Access expired")'),'revocation shown');
  assert.equal(external.length,0,'all assets including drawing fonts stay local');
  assert.equal(preview.requests.some(request=>request.url.includes(preview.editor.token)||request.referrer.includes(preview.editor.token)),false,'capabilities never enter HTTP URLs or referrers');
  const failures=errors.filter(message=>/ReferenceError|TypeError|violates|Refused to|Minified React error/.test(message));
  assert.deepEqual(failures,[],'no runtime or CSP errors');
  clearTimeout(timeout);console.log('CANVAS_UI_RESULT='+JSON.stringify({ok:true,saves:preview.state.saves,participants:3,externalRequests:external.length,screenshots:temporary}));await finish(0);
}).catch(async error=>{clearTimeout(timeout);console.error(error.stack||error);console.error(JSON.stringify({external,errors:errors.slice(0,12),errorCount:errors.length}));await finish(1);});
