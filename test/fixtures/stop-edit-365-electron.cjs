// Isolated Stop -> Edit renderer check. The production recovery coordinator,
// prompt editor, note fields and complete CSS cascade run against synthetic
// chats only. No app initialization, profile, HTTP API or model invocation.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-stop-edit-365-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, networkRequests = 0;
const timeout = setTimeout(() => finish(new Error("Stop/edit renderer timed out")), 90_000);
function finish(error, result) {
  clearTimeout(timeout);
  if (error) console.error(error.stack || error);
  else console.log(`STOP_EDIT_365_RESULT=${JSON.stringify(result)}`);
  window?.destroy(); app.exit(error ? 1 : 0);
}
const evaluate = source => window.webContents.executeJavaScript(`(async () => { ${source} })()`);
const settle = () => evaluate("await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); ");
async function click(selector) {
  const point = await evaluate(`const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({block:'nearest'}); const r = element.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};`);
  window.webContents.sendInputEvent({ type:"mouseDown", button:"left", clickCount:1, ...point });
  window.webContents.sendInputEvent({ type:"mouseUp", button:"left", clickCount:1, ...point });
  await settle();
}
async function viewport(width, height) {
  window.setContentSize(width, height);
  await evaluate(`await new Promise((resolve,reject) => {
    const timer=setTimeout(() => reject(new Error('Viewport did not settle')),3000);
    const check=() => { if(innerWidth===${width} && innerHeight===${height}) {clearTimeout(timer);resolve();} else requestAnimationFrame(check); }; check();
  });`);
}
async function capture(name) {
  if (process.env.ARGUS_STOP_EDIT_CAPTURE !== "1") return;
  await fs.writeFile(path.join(temporary, `${name}.png`), (await window.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  const read = file => fs.readFile(path.join(root, "public", file), "utf8");
  const html = await read("index.html");
  const cssFiles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\/([^"?]+)[^"]*"[^>]*>/g)].map(match => match[1]);
  const styles = (await Promise.all(cssFiles.map(read))).join("\n");
  const moduleSource = async (file, exports) => `(() => { ${(await read(file)).replace(/^export /gm, "")} return {${exports.join(",")}}; })()`;
  const isolated = session.fromPartition("stop-edit-365", { cache:false });
  isolated.setPermissionRequestHandler((_contents,_permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => {
    if (/^(?:https?|wss?):/.test(details.url)) networkRequests++;
    callback({ cancel:!details.url.startsWith("data:") });
  });
  window = new BrowserWindow({ show:false, width:1280, height:800,
    webPreferences:{ session:isolated, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  window.webContents.setWindowOpenHandler(() => ({action:"deny"}));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html data-theme="dark" data-font-family="system"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style></head><body><main id="fixture" style="padding:24px;width:100%;box-sizing:border-box"><h1 id="fixture-title">Synthetic chat</h1><p>Original request and the cancelled response remain in this chat.</p><div id="fixture-editor" hidden style="height:120px;border:1px solid var(--line);padding:16px">Synthetic IDE code — no repository attached</div><p>Separate unsent composer draft</p><textarea id="fixture-composer" style="width:100%;height:80px"></textarea><button id="fixture-stop" type="button">Stop response &amp; edit</button><p id="fixture-status" role="status"></p></main></body></html>`)}`);
  await evaluate(`
    const {createPromptEditor} = ${await moduleSource("prompt-editor.js", ["createPromptEditor"])};
    const {createPromptNoteFields} = ${await moduleSource("task-prompt-notes.mjs", ["createPromptNoteFields"])};
    const {createStoppedPromptRecovery} = ${await moduleSource("stopped-prompt-recovery.mjs", ["createStoppedPromptRecovery"])};
    const $ = selector => document.querySelector(selector);
    const original = 'Keep this service independently deployable. Explain the API flow, preserve existing integrations, and add the focused regression tests.';
    const separateDraft = 'A new unsent follow-up with its own attachment — do not overwrite it.';
    const notes = [{id:'note-original',text:'Explain what changed and list the tests you ran.',enabled:true}];
    const attachments = [{id:'attachment-original',name:'architecture-notes.md'}];
    window.fixture = { errors:[], submits:[], restored:[], current:true, stopClicks:0 };
    const editor = createPromptEditor({ document,
      createRequestId: () => 'fixture-request-id',
      createNoteFields: host => createPromptNoteFields(document,host),
      loadTask:async taskId => { if(taskId!==fixture.task.id) throw new Error('Wrong synthetic chat'); return structuredClone(fixture.task); },
      submit:async request => {
        fixture.submits.push(structuredClone({...request,onProgress:undefined}));
        request.onProgress('Updating this chat…');
        await new Promise(resolve => setTimeout(resolve,80));
        fixture.previousVersions.push(structuredClone(fixture.task.messages));
        fixture.task.messages = [{...fixture.task.messages[0],content:request.prompt,promptNotes:request.promptNotes}];
        $('#fixture-status').textContent='Edited request submitted once in the same chat; original preserved.';
      },
    });
    const recover = createStoppedPromptRecovery({
      isCurrent:(scope,source) => fixture.current && scope===fixture.scope && source.taskId===fixture.task.id && source.repositoryId===fixture.task.repositoryId,
      loadTask:async id => { if(id!==fixture.task.id) throw new Error('Wrong synthetic chat'); return structuredClone(fixture.task); },
      openEditor:selection => editor.open(selection),
      restoreDraft:source => { fixture.restored.push(source); return false; },
      onError:error => fixture.errors.push(error.message),
    });
    fixture.prepare=(scope,ide) => {
      fixture.scope=scope; fixture.current=true; fixture.stopClicks=0; fixture.errors=[]; fixture.submits=[]; fixture.restored=[]; fixture.previousVersions=[];
      fixture.task={id:scope==='global'?'nexus-chat-original':'repo-chat-original',repositoryId:scope==='global'?'global':'repo-original',messages:[
        {id:'request-original',role:'user',content:original,createdAt:'2026-09-20T16:00:00Z',promptNotes:notes,attachments},
        {id:'response-cancelled',role:'assistant',content:'The agent was stopped.',createdAt:'2026-09-20T16:00:05Z'},
      ]};
      fixture.source={kind:'job',repositoryId:fixture.task.repositoryId,taskId:fixture.task.id,prompt:original,startedAt:'2026-09-20T16:00:01Z'};
      document.body.classList.toggle('repository-ide-enabled',ide);
      $('#fixture-title').textContent=scope==='global'?'Nexus — synthetic chat':ide?'Repository IDE — synthetic chat':'Repository — synthetic chat';
      $('#fixture-editor').hidden=!ide; $('#fixture-status').textContent=''; $('#fixture-composer').value=separateDraft;
    };
    $('#fixture-stop').addEventListener('click',async () => { fixture.stopClicks++; fixture.lastRecovery=await recover(fixture.scope,fixture.source); });
    fixture.recover=() => recover(fixture.scope,fixture.source);
    fixture.inspect=() => {
      const dialog=$('#prompt-edit-dialog'), field=$('#prompt-edit-text'), rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      return {open:dialog.open,dialog:rect(dialog),field:rect(field),fieldValue:field.value,focused:document.activeElement===field,
        attachments:dialog.querySelector('[data-edit-attachments]').textContent,
        notes:[...dialog.querySelectorAll('[data-note-id]')].map(row=>({id:row.dataset.noteId,text:row.querySelector('[data-note-text]').value,enabled:row.querySelector('[data-note-enabled]').checked})),
        composer:$('#fixture-composer').value,sandboxed:typeof process==='undefined'&&typeof require==='undefined',
        horizontalOverflow:dialog.scrollWidth>dialog.clientWidth+1,bodyOverflow:document.documentElement.scrollWidth>innerWidth+1,
        submitCount:fixture.submits.length,footer:rect(dialog.querySelector('footer')),font:getComputedStyle(field).fontFamily};
    };
    fixture.expected={original,separateDraft,notes,attachments};
  `);
  const scenarios=[];
  for (const surface of ["nexus","repository","short-ide"]) for (const width of [360,1280]) for (const font of ["system","comic-sans"]) for (const theme of ["dark","light"]) {
    const scope=surface==="nexus"?"global":"repository", ide=surface==="short-ide", height=ide?460:820;
    const scenario={surface,width,height,font,theme};
    await viewport(width,height);
    await evaluate(`document.documentElement.dataset.fontFamily=${JSON.stringify(font)};document.documentElement.dataset.theme=${JSON.stringify(theme)};fixture.prepare(${JSON.stringify(scope)},${ide});`);
    await click("#fixture-stop");
    const inspect=await evaluate("return fixture.inspect();"), expected=await evaluate("return fixture.expected;");
    assert.equal(inspect.open,true,JSON.stringify(scenario));
    assert.equal(inspect.fieldValue,expected.original); assert.deepEqual(inspect.notes,expected.notes);
    assert.match(inspect.attachments,/architecture-notes\.md/); assert.equal(inspect.composer,expected.separateDraft);
    assert.equal(inspect.focused,true); assert.equal(inspect.sandboxed,true);
    assert.equal(inspect.horizontalOverflow,false,JSON.stringify({scenario,inspect}));
    assert.equal(inspect.bodyOverflow,false,JSON.stringify({scenario,inspect}));
    assert.ok(inspect.dialog.left>=15 && inspect.dialog.right<=width-15,JSON.stringify({scenario,inspect}));
    assert.ok(inspect.dialog.top>=19 && inspect.dialog.bottom<=height-19,JSON.stringify({scenario,inspect}));
    assert.ok(inspect.field.width>180); assert.equal(inspect.submitCount,0);
    if(font==="comic-sans") assert.match(inspect.font,/Comic Sans/i);
    if(font==="comic-sans" && theme==="dark") await capture(`${surface}-${width}-prompt`);
    await evaluate("document.querySelector('#prompt-edit-dialog footer').scrollIntoView({block:'nearest'});"); await settle();
    const footer=await evaluate("return fixture.inspect();");
    assert.ok(footer.footer.bottom<=footer.dialog.bottom+1,JSON.stringify({scenario,footer}));
    assert.ok(footer.footer.left>=footer.dialog.left && footer.footer.right<=footer.dialog.right);
    if(font==="comic-sans" && theme==="dark") await capture(`${surface}-${width}-notes-actions`);
    await click("[data-cancel-edit]");
    assert.deepEqual(await evaluate("return {open:document.querySelector('#prompt-edit-dialog').open,submits:fixture.submits.length,composer:document.querySelector('#fixture-composer').value};"),{open:false,submits:0,composer:expected.separateDraft});
    await click("#fixture-stop");
    await evaluate(`document.querySelector('#prompt-edit-text').value=${JSON.stringify(expected.original+" Please clarify the contract first.")};
      const form=document.querySelector('#prompt-edit-dialog form');
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
    assert.equal(await evaluate("return document.querySelector('#prompt-edit-dialog').getAttribute('aria-busy');"),"true");
    await evaluate("await new Promise((resolve,reject)=>{const end=performance.now()+3000; const tick=()=>{if(!document.querySelector('#prompt-edit-dialog').open)resolve();else if(performance.now()>end)reject(new Error('Synthetic resend did not complete'));else setTimeout(tick,10);};tick();});");
    const result=await evaluate("return {submits:fixture.submits,task:fixture.task,previousVersions:fixture.previousVersions,composer:document.querySelector('#fixture-composer').value,errors:fixture.errors,restored:fixture.restored};");
    assert.equal(result.submits.length,1); assert.equal(result.submits[0].task.id,result.task.id);
    assert.equal(result.submits[0].message.id,"request-original"); assert.deepEqual(result.submits[0].message.attachments,expected.attachments);
    assert.deepEqual(result.submits[0].promptNotes,expected.notes); assert.equal(result.previousVersions[0][0].content,expected.original);
    assert.equal(result.composer,expected.separateDraft); assert.deepEqual(result.errors,[]); assert.deepEqual(result.restored,[]);
    scenarios.push(scenario);
  }
  // A changed active chat cannot open this request in another conversation.
  await evaluate("fixture.prepare('global',false);fixture.current=false;await fixture.recover();");
  assert.equal(await evaluate("return document.querySelector('#prompt-edit-dialog').open;"),false);
  assert.equal(networkRequests,0);
  const result={ok:true,scenarios:scenarios.length,networkRequests,sandboxed:true,details:scenarios};
  await fs.writeFile(path.join(temporary,"stop-edit-365-result.json"),JSON.stringify(result,null,2)+"\n");
  finish(null,result);
}).catch(error=>finish(error));
