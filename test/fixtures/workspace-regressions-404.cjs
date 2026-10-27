const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const temp=process.argv[2],root=path.resolve(__dirname,'../..');
if(!temp||!path.basename(temp).startsWith('argus-workspace-404-'))throw Error('Isolated profile required');
for(const key of ['userData','sessionData','logs'])app.setPath(key,path.join(temp,key));
app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(async()=>{
 const html=await fs.readFile(path.join(root,'public/index.html'),'utf8');
 const sheets=[...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(m=>m[1]);
 const css=(await Promise.all(sheets.map(f=>fs.readFile(path.join(root,'public',f),'utf8')))).join('\n');
 const shell=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'').replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${css}</style>`);
 const partition=session.fromPartition('404-isolated');partition.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('data:')}));
 const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{session:partition,sandbox:true,contextIsolation:true}});
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(shell));
 const {installChatHistoryPanels}=await import(pathToFileURL(path.join(root,'public/chat-history-panel.mjs')).href);
 await win.webContents.executeJavaScript(`
 document.body.dataset.view='repository';document.body.classList.add('repository-ide-enabled');
 document.querySelector('#workspace').classList.remove('hidden');
 const canvas=document.querySelector('.ai-canvas');canvas.classList.add('task-panel-collapsed');
 document.querySelector('#repository-ai-chat .ai-sticky-header').innerHTML='<div class="ai-context-header"><button class="ai-context-summary">Codex · Synthetic repository</button></div>';
 document.querySelector('#repository-task-list').innerHTML=Array.from({length:25},(_,i)=>'<div class="task-row"><button class="task-row-main">Synthetic task '+i+'</button></div>').join('');
 (${installChatHistoryPanels.toString()})({document,toggle:(scope,open)=>{const p=document.querySelector('#repository-task-sidebar');if(open&&!p.matches(':popover-open'))p.showPopover();if(!open&&p.matches(':popover-open'))p.hidePopover();}});
 window.checkHistory=()=>{const p=document.querySelector('#repository-task-sidebar'),b=document.querySelector('#repository-chat-history-toggle'),h=document.querySelector('.ai-context-header');b.click();const br=b.getBoundingClientRect(),hr=h.getBoundingClientRect(),pr=p.getBoundingClientRect();return {open:p.matches(':popover-open'),header:p.querySelector('header').checkVisibility(),list:p.querySelector('.task-list').checkVisibility(),text:p.innerText,aligned:Math.abs(br.top+br.height/2-hr.top-hr.height/2)<2,bounds:pr.right<=innerWidth&&pr.bottom<=innerHeight,scroll:p.querySelector('.task-list').scrollHeight>p.querySelector('.task-list').clientHeight};};
 void 0;
 `);
 for(const [width,height] of [[1440,900],[1000,650],[640,550]]){
 win.setContentSize(width,height);await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,100))');
 const r=await win.webContents.executeJavaScript('checkHistory()');assert.ok(r.open&&r.header&&r.list&&r.aligned&&r.bounds&&r.scroll,JSON.stringify(r));assert.match(r.text,/Synthetic task 24/);
 if(process.env.ARGUS_LAYOUT_404_CAPTURE==='1')await fs.writeFile(path.join(temp,'history-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 await win.webContents.executeJavaScript("document.querySelector('#repository-task-sidebar').hidePopover()");
 }
 await win.webContents.executeJavaScript(`
 document.querySelector('#data-storage-list').innerHTML=Array.from({length:30},(_,i)=>'<details class="storage-card"><summary class="storage-card-heading">Synthetic storage category '+i+'</summary><p>Details</p></details>').join('');
 const dialog=document.querySelector('#data-storage-dialog');dialog.querySelectorAll('[role="tabpanel"]').forEach(p=>p.hidden=p.id!=='local-storage-panel');dialog.show();
 `);
 win.showInactive();win.webContents.focus();
 await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,200))');
 const target=await win.webContents.executeJavaScript(`(()=>{const s=document.querySelector('.data-storage-scroll'),r=s.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,overflow:getComputedStyle(s).overflowY};})()`);
 assert.equal(target.overflow,'auto');
 win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(target.x),y:Math.round(target.y)});
 win.webContents.sendInputEvent({type:'mouseWheel',x:Math.round(target.x),y:Math.round(target.y),deltaY:-450,canScroll:true});
 await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,150))');
 const scroll=await win.webContents.executeJavaScript(`(()=>{const s=document.querySelector('.data-storage-scroll');return {height:s.clientHeight,total:s.scrollHeight,top:s.scrollTop,last:s.lastElementChild?.textContent,done:[...document.querySelectorAll('#data-storage-dialog button')].find(b=>b.textContent==='Done').checkVisibility()};})()`);
 assert.ok(scroll.height>0&&scroll.total>scroll.height&&scroll.top>0&&scroll.done,JSON.stringify(scroll));
 if(process.env.ARGUS_LAYOUT_404_CAPTURE==='1')await fs.writeFile(path.join(temp,'storage-scrolled.png'),(await win.webContents.capturePage()).toPNG());
 console.log('404 renderer regressions passed');win.destroy();app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
