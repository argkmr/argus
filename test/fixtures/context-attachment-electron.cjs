// Isolated synthetic contexts only: no Argus bootstrap, user files, backend, or
// provider is ever accessed. Card markup, viewer, shell, and CSS are production.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
assert.ok(path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-context-attachment-layout-"));
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
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; frame-src data: blob:"><style>${css}</style>`);
  const bundled = new Map();
  async function moduleUrl(file) {
    if (bundled.has(file)) return bundled.get(file);
    let source = await fs.readFile(file, "utf8");
    for (const match of [...source.matchAll(/\bfrom\s+(["'])(\.\.?\/[^"']+)\1/g)]) {
      const dependency = path.resolve(path.dirname(file), match[2].split("?")[0]);
      assert.ok(dependency.startsWith(publicRoot + path.sep), "Only production local modules can be imported");
      source = source.replace(match[0], `from ${JSON.stringify(await moduleUrl(dependency))}`);
    }
    const url = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
    bundled.set(file, url); return url;
  }
  const cardsModule = await moduleUrl(path.join(publicRoot, "context-attachment-view.mjs"));
  const viewerModule = await moduleUrl(path.join(publicRoot, "context-attachment-viewer.mjs"));
  const { nexusThemeVariables } = await import(pathToFileURL(path.join(publicRoot, "nexus-themes.mjs")).href);
  const isolated = session.fromPartition("context-attachment-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const fixtureOrigin = "https://argus-attachment-fixture.invalid";
  // A local protocol response supplies an origin for the production capability
  // URL checks. Requests never reach a socket, backend, or external service.
  isolated.protocol.handle("https", request => new Response(request.url === fixtureOrigin + "/" ? shell : "Not found", { status: request.url === fixtureOrigin + "/" ? 200 : 404, headers: { "content-type": request.url === fixtureOrigin + "/" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" } }));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    const external = new URL(details.url).origin !== fixtureOrigin;
    if (external) networkRequests++;
    callback({ cancel: external });
  });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL(fixtureOrigin + "/");
  const run = code => window.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message}\nRenderer script: ${code.slice(0,1200)}`);});
  await run(`Promise.all([import(${JSON.stringify(cardsModule)}),import(${JSON.stringify(viewerModule)})]).then(([cards,viewer])=>{window.attachmentCards=cards;window.attachmentViewerModule=viewer;})`);
  const settle = () => run("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
  const capture = async name => {
    if (process.env.ARGUS_ATTACHMENT_CAPTURE !== "1") return;
    await settle(); await fs.writeFile(path.join(temporary, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  await run(`
    window.fixtureItems = [
      { id:'fixture-image', kind:'image', title:'Checkout screenshot.png', mimeType:'image/png', size:1280 },
      { id:'fixture-docx', kind:'file', title:'Fulfillment investigation and customer-support handoff specification.docx', mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size:22000 },
      { id:'fixture-text', kind:'file', title:'Technical details.txt', mimeType:'text/plain', size:350 },
      { id:'fixture-pdf', kind:'file', title:'Weekly review.pdf', mimeType:'application/pdf', size:8000 },
      { id:'fixture-audio', kind:'file', title:'Meeting recording.wav', mimeType:'audio/wav', size:1200 },
      { id:'fixture-video', kind:'file', title:'Interaction demo.mp4', mimeType:'video/mp4', size:9800 },
      { id:'fixture-other', kind:'file', title:'Archive.zip', mimeType:'application/zip', size:18000 },
      { id:'fixture-browser', kind:'browser', title:'Saved documentation tab', url:'https://example.invalid/documentation', size:600 },
    ];
    fixtureItems.forEach((item,index)=>{item.id='10000000-0000-4000-8000-'+String(index+1).padStart(12,'0');});
    window.fixtureRemovals=[];
    document.addEventListener('click', event=>{const button=event.target.closest('[data-remove-context]');if(button)fixtureRemovals.push(button.dataset.removeContext);});
    window.configureAttachmentView = kind => {
      const global=kind==='nexus', scope=global?'global':'repository';
      document.body.dataset.view=global?'global':'repository';
      document.body.classList.remove('repository-ide-enabled');document.body.classList.add('task-context-visible');
      document.querySelector('#global-codex-panel').classList.toggle('hidden',!global);
      document.querySelector('#workspace').classList.toggle('hidden',global);
      document.querySelector('.global-codex-layout').classList.add('task-panel-collapsed');
      document.querySelector('.ai-canvas').classList.add('task-panel-collapsed');
      window.activeComposer=document.querySelector('[data-composer-scope="'+scope+'"]');
      const tray=activeComposer.querySelector('.context-tray');tray.classList.add('has-context');
      tray.querySelector('.context-chips').innerHTML=fixtureItems.slice(0,3).map(item=>attachmentCards.attachmentCardMarkup(item,{scope,removable:true})).join('');
      activeComposer.querySelector('textarea').value='Review these attachments without changing this draft.';
      const conversation=document.querySelector(global?'#global-agent-conversation':'#agent-conversation');conversation.classList.remove('is-empty');
      conversation.innerHTML='<article class="chat-message user"><div class="chat-message-body"><div class="chat-message-meta">You</div><div class="chat-message-content"><p>Previously attached context remains available here.</p></div><div class="chat-message-attachments">'+fixtureItems.map(item=>attachmentCards.attachmentCardMarkup(item,{scope,removable:false})).join('')+'</div></div></article>';
      window.activeConversation=conversation;
    };
    window.fixtureCardState=()=>{
      const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const tray=activeComposer.querySelector('.context-tray');
      return {viewport:{width:innerWidth,height:innerHeight},composer:rect(activeComposer),tray:rect(tray),draft:activeComposer.querySelector('textarea').value,
        cards:[...tray.querySelectorAll('[data-preview-context]')].map(button=>({tag:button.tagName,id:button.dataset.previewContext,label:button.getAttribute('aria-label'),title:button.title,rect:rect(button),card:rect(button.closest('.attachment-card')),nestedButtons:button.querySelectorAll('button').length,style:{paddingLeft:getComputedStyle(button).paddingLeft,paddingRight:getComputedStyle(button).paddingRight,paddingTop:getComputedStyle(button).paddingTop,paddingBottom:getComputedStyle(button).paddingBottom},texts:[...button.querySelectorAll('strong,small')].map(text=>({text:text.textContent,rect:rect(text),fontSize:parseFloat(getComputedStyle(text).fontSize)}))})),
        removals:[...tray.querySelectorAll('[data-remove-context]')].map(button=>({tag:button.tagName,rect:rect(button),insidePreview:Boolean(button.parentElement.closest('[data-preview-context]'))})),
        sent:activeConversation.querySelectorAll('[data-preview-context]').length,
        sentCards:[...activeConversation.querySelectorAll('[data-preview-context]')].map(button=>({card:rect(button.closest('.attachment-card')),button:rect(button)})),
        unsafe:tray.querySelectorAll('script,iframe').length};
    };
    undefined;
  `);
  let scenarios=0,interactionChecks=0;
  for(const kind of ['nexus','repository']) for(const width of [1440,760,440]) for(const theme of ['dark','light']) for(const zoom of [1,1.22]) {
    window.setContentSize(width,900);window.webContents.setZoomFactor(zoom);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily='comic-sans';for(const[key,value]of Object.entries(${JSON.stringify(nexusThemeVariables("ocean",theme))}))document.querySelector('#global-codex-panel').style.setProperty(key,value);configureAttachmentView(${JSON.stringify(kind)});`);
    await settle();
    const state=await run('fixtureCardState()'), context=JSON.stringify({kind,width,theme,zoom,state});
    assert.equal(state.cards.length,3,context);assert.equal(state.removals.length,3,context);assert.equal(state.sent,8,context);assert.equal(state.unsafe,0,context);
    assert.ok(state.composer.left>=0&&state.composer.right<=state.viewport.width+1,context);
    for(const card of state.cards){
      assert.equal(card.tag,'BUTTON',context);assert.equal(card.nestedButtons,0,context);assert.ok(card.rect.height>=32,context);
      assert.ok(card.rect.top>=card.card.top&&card.rect.bottom<=card.card.bottom+1,`Preview contents must fit their card: ${context}`);
      assert.ok(card.card.top>=state.tray.top+3&&card.card.bottom<=state.tray.bottom-3,`Cards need vertical padding inside the tray: ${context}`);
      assert.ok(parseFloat(card.style.paddingLeft)>=6&&parseFloat(card.style.paddingRight)>=6,context);
      assert.ok(parseFloat(card.style.paddingTop)>=3&&parseFloat(card.style.paddingBottom)>=3,context);
      for(const text of card.texts)assert.ok(text.rect.height>=text.fontSize&&text.rect.top>=card.rect.top&&text.rect.bottom<=card.rect.bottom+1,context);
    }
    for(const remove of state.removals){assert.equal(remove.tag,'BUTTON',context);assert.equal(remove.insidePreview,false,context);assert.ok(remove.rect.width>=20&&remove.rect.height>=20,context);}
    for(const sent of state.sentCards){assert.ok(sent.button.top>=sent.card.top&&sent.button.bottom<=sent.card.bottom+1,context);assert.ok(sent.card.left>=0&&sent.card.right<=state.viewport.width+1,context);}
    assert.equal(state.draft,'Review these attachments without changing this draft.',context);
    if(width===1440&&zoom===1)await capture('attachment-cards-'+kind+'-'+theme);
    if(width===440&&zoom===1.22&&theme==='dark')await capture('attachment-cards-'+kind+'-narrow');
    scenarios++;
  }
  window.setContentSize(1440,900);window.webContents.setZoomFactor(1);
  await run(`
    document.documentElement.dataset.theme='dark';
    for(const[key,value]of Object.entries(${JSON.stringify(nexusThemeVariables('ocean','dark'))}))document.querySelector('#global-codex-panel').style.setProperty(key,value);
    configureAttachmentView('nexus');
    window.fixtureCalls=[];window.fixtureDisposals=[];window.fixturePending=[];window.fixtureDeferred=false;window.fixtureOverrides={};window.fixtureFailureId=null;
    window.fixturePayload=id=>{
      const item=fixtureItems.find(item=>item.id===id);if(!item)throw new Error('Unknown synthetic attachment');
      const index=fixtureItems.indexOf(item),previewType=['image','docx','text','pdf','audio','video','download','text'][index];
      return {...item,fileName:item.title,previewType,content:'Saved text: <img src=x onerror="window.__attachmentInjected=true"> is literal.\\nSecond line.',
        contentUrl:previewType==='download'?null:'/api/context/'+id+'/content'+(previewType==='docx'?'?preview=docx':''),
        downloadUrl:'/api/context/'+id+'/content?download=true',...(previewType==='download'?{previewNotice:'Download the original archive to open it safely.'}:{}),...(fixtureOverrides[id]||{})};
    };
    const imageCanvas=document.createElement('canvas');imageCanvas.width=640;imageCanvas.height=360;const imageContext=imageCanvas.getContext('2d');
    imageContext.fillStyle='#102c3d';imageContext.fillRect(0,0,640,360);imageContext.fillStyle='#54cee9';imageContext.fillRect(30,30,580,6);
    imageContext.fillStyle='#effaff';imageContext.font='bold 26px sans-serif';imageContext.fillText('Synthetic attachment preview',32,96);
    imageContext.font='18px sans-serif';imageContext.fillStyle='#a8c7d7';imageContext.fillText('No user files, backend, or network accessed.',32,136);
    for(let index=0;index<3;index++){imageContext.fillStyle=['#54cee9','#70dca4','#e4ac69'][index];imageContext.fillRect(32+index*200,190,176,130);}
    const imageBytes=Uint8Array.from(atob(imageCanvas.toDataURL('image/png').split(',')[1]),character=>character.charCodeAt(0));
    const wav=new Uint8Array(844),wavView=new DataView(wav.buffer);const write=(offset,text)=>[...text].forEach((character,index)=>wav[offset+index]=character.charCodeAt(0));
    write(0,'RIFF');wavView.setUint32(4,836,true);write(8,'WAVE');write(12,'fmt ');wavView.setUint32(16,16,true);wavView.setUint16(20,1,true);wavView.setUint16(22,1,true);wavView.setUint32(24,8000,true);wavView.setUint32(28,8000,true);wavView.setUint16(32,1,true);wavView.setUint16(34,8,true);write(36,'data');wavView.setUint32(40,800,true);wav.fill(128,44);
    window.fixtureViewer=attachmentViewerModule.initializeAttachmentViewer({document,
      showDialog:id=>{const dialog=document.getElementById(id);if(!dialog.open)dialog.showModal();return true;},
      loadPreview:async(id,{signal})=>{fixtureCalls.push({type:'metadata',id});if(id===fixtureFailureId)throw new Error('Saved attachment is unavailable.');if(fixtureDeferred)return new Promise(resolve=>fixturePending.push({id,signal,resolve}));return fixturePayload(id);},
      renderPdf:async(mount,url,{signal})=>{fixtureCalls.push({type:'pdf',url});const page=document.createElement('div');page.className='fixture-pdf-page';page.textContent='Synthetic PDF page — renderer delegation';mount.append(page);return()=>{fixtureDisposals.push('pdf');page.remove();};},
      renderWord:async(mount,url,{signal})=>{fixtureCalls.push({type:'docx',url});const page=document.createElement('div');page.className='fixture-word-page';page.textContent='Synthetic Word page — renderer delegation';mount.append(page);return()=>{fixtureDisposals.push('docx');page.remove();};},
      renderMarkdown:async(mount,file)=>{fixtureCalls.push({type:'markdown',path:file.path});const paragraph=document.createElement('p');paragraph.textContent=file.content;mount.append(paragraph);return()=>{fixtureDisposals.push('markdown');paragraph.remove();};},
      renderMedia:async(mount,url,options)=>{
        fixtureCalls.push({type:options.type,url});
        if(options.type==='video'){const video=document.createElement('video');video.className='attachment-media attachment-media-video';video.controls=true;video.setAttribute('aria-label',options.name);mount.append(video);return()=>{fixtureDisposals.push('video');video.remove();};}
        const dispose=await attachmentViewerModule.renderAttachmentMedia(mount,url,{...options,fetchFile:async()=>new Response(options.type==='image'?imageBytes:wav,{headers:{'content-type':options.mimeType}})});
        return()=>{fixtureDisposals.push(options.type);dispose();};
      }
    });
    window.fixtureDialogState=()=>{
      const dialog=document.querySelector('#context-attachment-dialog');if(!dialog)return{open:false};
      const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const download=dialog.querySelector('[data-attachment-download]'),content=dialog.querySelector('[data-attachment-content]'),text=content.querySelector('textarea');
      return{open:dialog.open,title:dialog.querySelector('h2').textContent,notice:dialog.querySelector('[data-attachment-notice]').textContent,error:dialog.querySelector('[data-attachment-notice]').dataset.error,
        card:rect(dialog.querySelector('.attachment-viewer-card')),viewport:{width:innerWidth,height:innerHeight},content:rect(content),background:getComputedStyle(dialog.querySelector('.attachment-viewer-card')).backgroundColor,
        text:text?.value,textReadOnly:text?.readOnly,textHidden:text?.hidden,sourceHidden:dialog.querySelector('[data-attachment-source]').hidden,
        sourceLabel:dialog.querySelector('[data-attachment-source]').textContent,downloadHidden:download.hidden,download:download.getAttribute('href'),downloadName:download.download,
        image:content.querySelector('img')?{complete:content.querySelector('img').complete,width:content.querySelector('img').naturalWidth,src:content.querySelector('img').src}:null,
        audio:content.querySelector('audio')?{controls:content.querySelector('audio').controls,paused:content.querySelector('audio').paused}:null,
        video:content.querySelector('video')?{controls:content.querySelector('video').controls,paused:content.querySelector('video').paused}:null,
        pdf:content.querySelectorAll('.fixture-pdf-page').length,docx:content.querySelectorAll('.fixture-word-page').length,unavailable:content.querySelector('.source-document-unavailable')?.textContent,
        unsafe:content.querySelectorAll('script,iframe,img[onerror]').length,injected:Boolean(window.__attachmentInjected),focused:document.activeElement.getAttribute('data-preview-context')||document.activeElement.getAttribute('data-remove-context')||document.activeElement.getAttribute('aria-label'),
        mountCount:content.children.length,contentText:content.textContent};
    };
    window.fixtureReady=async()=>{const deadline=performance.now()+5000;while(performance.now()<deadline){const state=fixtureDialogState();if(state.open&&state.notice!=='Opening attachment…')return state;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Attachment preview did not open and settle: '+JSON.stringify(fixtureDialogState()));};
    undefined;
  `);
  await settle();
  const click = async selector => {
    await run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});undefined;`);
    await settle();
    const point=await run(`(()=>{const button=document.querySelector(${JSON.stringify(selector)}),r=button.getBoundingClientRect(),point={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};const hit=document.elementFromPoint(point.x,point.y);if(!hit||!button.contains(hit))throw new Error('Attachment control is not the hit target: '+JSON.stringify({selector:${JSON.stringify(selector)},point,hit:hit?.outerHTML.slice(0,500)}));window.fixtureClick={seen:false,target:null};document.addEventListener('click',function observe(event){fixtureClick.target=event.target.outerHTML?.slice(0,500);if(button.contains(event.target)){fixtureClick.seen=true;document.removeEventListener('click',observe,true);}},true);return point;})()`);
    // Native input is queued independently of renderer animation frames. Wait
    // for the actual event, never click again or accept an unopened dialog.
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await run(`(async()=>{const deadline=performance.now()+5000;while(!fixtureClick.seen&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));if(!fixtureClick.seen)throw new Error('Native attachment click not observed: '+JSON.stringify({selector:${JSON.stringify(selector)},point:${JSON.stringify(point)},event:fixtureClick,focused:document.hasFocus(),viewport:{width:innerWidth,height:innerHeight}}));})()`);
    await settle();
  };
  const closePreview=async()=>{await run('fixtureViewer.close()');await settle();};
  const firstImage='#global-context-tray [data-preview-context="10000000-0000-4000-8000-000000000001"]';
  await click(firstImage);
  let dialog=await run('fixtureReady()');
  assert.equal(dialog.open,true);assert.equal(dialog.title,'Checkout screenshot.png');assert.equal(dialog.image?.complete,true);assert.equal(dialog.image?.width,640);assert.match(dialog.image.src,/^blob:/);assert.equal(dialog.downloadHidden,false);assert.equal(dialog.unsafe,0);interactionChecks++;
  await capture('attachment-preview-nexus-image');
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await settle();
  dialog=await run('fixtureDialogState()');assert.equal(dialog.open,false);assert.equal(dialog.focused,'10000000-0000-4000-8000-000000000001');assert.ok((await run('fixtureDisposals')).includes('image'));interactionChecks++;
  const callsBeforeRemove=await run('fixtureCalls.length');
  await click('#global-context-tray [data-remove-context="10000000-0000-4000-8000-000000000001"]');
  assert.equal(await run('fixtureCalls.length'),callsBeforeRemove);assert.equal(await run('fixtureDialogState().open'),false);assert.equal(await run('fixtureRemovals.at(-1)'),'10000000-0000-4000-8000-000000000001');interactionChecks++;
  await run(`activeConversation.querySelector('[data-preview-context="10000000-0000-4000-8000-000000000003"]').focus()`);
  assert.equal(await run("document.activeElement.dataset.previewContext"),'10000000-0000-4000-8000-000000000003',JSON.stringify(await run("({active:document.activeElement.outerHTML,visible:activeConversation.checkVisibility(),parent:activeConversation.parentElement.outerHTML.slice(0,500)})")));
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});window.webContents.sendInputEvent({type:'char',keyCode:'\r'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await settle();
  dialog=await run('fixtureReady()');assert.equal(dialog.open,true);assert.equal(dialog.title,'Technical details.txt');assert.equal(dialog.textReadOnly,true);assert.match(dialog.text,/<img src=x onerror=/);assert.equal(dialog.unsafe,0);assert.equal(dialog.injected,false);interactionChecks++;
  await capture('attachment-preview-nexus-text');await closePreview();
  for(const[index,type]of[[1,'docx'],[3,'pdf'],[4,'audio'],[5,'video'],[6,'download'],[7,'text']]){
    await run(`fixtureViewer.open(activeConversation.querySelector('[data-preview-context="'+fixtureItems[${index}].id+'"]'))`);
    dialog=await run('fixtureReady()');assert.equal(dialog.open,true);assert.equal(dialog.title,await run(`fixtureItems[${index}].title`));assert.equal(dialog.downloadHidden,false);assert.equal(dialog.unsafe,0);
    if(type==='docx'||type==='pdf')assert.equal(dialog[type],1);
    if(type==='audio'||type==='video'){assert.equal(dialog[type].controls,true);assert.equal(dialog[type].paused,true);}
    if(type==='download')assert.match(dialog.unavailable,/Download the original archive/);
    if(type==='text')assert.equal(dialog.textReadOnly,true);
    interactionChecks++;await closePreview();
  }
  await run(`(async()=>{fixtureOverrides[fixtureItems[2].id]={title:'Instructions.md',fileName:'Instructions.md',content:'# Saved instructions\\nNo external documents are accessed.'};await fixtureViewer.open(activeConversation.querySelector('[data-preview-context="'+fixtureItems[2].id+'"]'));})()`);
  dialog=await run('fixtureReady()');assert.equal(dialog.sourceHidden,false);assert.equal(dialog.textHidden,true);assert.equal(dialog.sourceLabel,'Source');
  await click('#context-attachment-dialog [data-attachment-source]');dialog=await run('fixtureDialogState()');assert.equal(dialog.textHidden,false);assert.equal(dialog.sourceLabel,'Preview');assert.equal(dialog.textReadOnly,true);assert.equal((await run(`fixtureCalls.filter(call=>call.type==='markdown').at(-1)`)).path,'');
  interactionChecks++;await closePreview();await run('fixtureOverrides={}');

  // Late metadata must not reopen a dismissed dialog or overwrite a newer item.
  await run(`fixtureDeferred=true;void fixtureViewer.open(activeConversation.querySelector('[data-preview-context="'+fixtureItems[0].id+'"]'));`);await settle();
  assert.equal((await run('fixtureDialogState()')).notice,'Opening attachment…');await closePreview();
  await run(`fixtureDeferred=false;for(const pending of fixturePending.splice(0))pending.resolve(fixturePayload(pending.id));`);await settle();assert.equal(await run('fixtureDialogState().open'),false);interactionChecks++;
  await run(`fixtureDeferred=true;void fixtureViewer.open(activeConversation.querySelector('[data-preview-context="'+fixtureItems[0].id+'"]'));`);await settle();
  await run(`(async()=>{fixtureDeferred=false;await fixtureViewer.open(activeConversation.querySelector('[data-preview-context="'+fixtureItems[2].id+'"]'));for(const pending of fixturePending.splice(0))pending.resolve(fixturePayload(pending.id));})()`);await settle();
  dialog=await run('fixtureReady()');assert.equal(dialog.title,'Technical details.txt');assert.equal(dialog.image,null);assert.equal(dialog.mountCount,1);assert.equal(dialog.textReadOnly,true);interactionChecks++;await closePreview();
  await run(`(async()=>{fixtureFailureId=fixtureItems[2].id;await fixtureViewer.open(activeConversation.querySelector('[data-preview-context="'+fixtureItems[2].id+'"]'));})()`);dialog=await run('fixtureReady()');assert.equal(dialog.error,'true');assert.match(dialog.notice,/unavailable/);assert.equal(dialog.downloadHidden,true);interactionChecks++;await closePreview();await run('fixtureFailureId=null');

  // Viewer header/body remain within the viewport at the same narrow zoom used
  // for cards, and repository colors replace the previous Nexus palette.
  for(const kind of ['nexus','repository'])for(const theme of ['dark','light']){
    window.setContentSize(440,900);window.webContents.setZoomFactor(1.22);
    await run(`(async()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};for(const[key,value]of Object.entries(${JSON.stringify(nexusThemeVariables('ocean',theme))}))document.querySelector('#global-codex-panel').style.setProperty(key,value);configureAttachmentView(${JSON.stringify(kind)});await fixtureViewer.open(activeConversation.querySelector('[data-preview-context="'+fixtureItems[1].id+'"]'));})()`);
    await settle();dialog=await run('fixtureReady()');const context=JSON.stringify({kind,theme,dialog});
    assert.ok(dialog.card.left>=0&&dialog.card.top>=0&&dialog.card.right<=dialog.viewport.width+1&&dialog.card.bottom<=dialog.viewport.height+1,context);
    assert.ok(dialog.content.height>60,context);assert.equal(dialog.docx,1,context);assert.equal(dialog.unsafe,0,context);interactionChecks++;
    await capture('attachment-preview-'+kind+'-'+theme+'-narrow');await closePreview();
  }
  await fs.writeFile(path.join(temporary,"result.json"),JSON.stringify({scenarios,interactionChecks,networkRequests}));
  clearTimeout(timer);window.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timer);window?.destroy();app.exit(1);});
