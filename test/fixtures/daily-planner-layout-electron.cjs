// Real production module/styles with isolated Electron and synthetic state only.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), http = require("node:http");
const temporary = process.argv[2];
assert.ok(temporary && path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-daily-planner-layout-"));
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
const publicRoot = path.resolve(__dirname, "../../public");
let window, server, unexpectedNetwork = 0, backendCalls = 0;
const timer = setTimeout(() => { console.error("Planner fixture timed out"); app.exit(1); }, 55_000);
const finish = code => { clearTimeout(timer); window?.destroy(); server?.close(); app.exit(code); };
app.whenReady().then(async () => {
  const shell = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const stylesheets = [...shell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(publicRoot, file), "utf8")))).join("\n");
  const modules = new Map(await Promise.all(["daily-planner.mjs", "planner-time-picker.mjs"].map(async file => ["/" + file, await fs.readFile(path.join(publicRoot, file), "utf8")])));
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style></head><body data-view="daily-planner"><section class="daily-planner-panel" id="planner"></section></body></html>`;
  server = http.createServer((request, response) => {
    if (request.url === "/fixture") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); return; }
    const module = modules.get(new URL(request.url, "http://fixture.invalid").pathname);
    if (module !== undefined) { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(module); return; }
    if (request.url.startsWith("/api/")) backendCalls++;
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isolated = session.fromPartition("daily-planner-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const allowed = (url.origin === origin && (url.pathname === "/fixture" || modules.has(url.pathname))) || details.url.startsWith("data:");
    if (!allowed) { unexpectedNetwork++; if (details.url.startsWith(origin + "/api/")) backendCalls++; }
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(origin + "/fixture");
  const run = script => window.webContents.executeJavaScript(script);
  const settle = () => {
    const [width,height]=window.getContentSize(),zoom=window.webContents.getZoomFactor();
    return run(`(async()=>{await document.fonts.ready;const deadline=performance.now()+2000;let previous='',stable=0;while(performance.now()<deadline){await new Promise(resolve=>requestAnimationFrame(resolve));const rect=document.querySelector('#planner').getBoundingClientRect(),board=document.querySelector('.dp-body')?.getBoundingClientRect();const current=JSON.stringify([innerWidth,innerHeight,rect.width,rect.height,board?.width,board?.height,board?.top]);stable=current===previous?stable+1:0;previous=current;if(stable>=3&&Math.abs(innerWidth-${width/zoom})<=2&&Math.abs(innerHeight-${height/zoom})<=2)return;}throw new Error('Planner viewport did not settle after resize/zoom');})()`);
  };
  await run(`(async () => {
    const NativeDate=Date, fixtureNow=NativeDate.parse('2026-09-22T06:30:00Z');
    window.Date=class FixtureDate extends NativeDate {constructor(...args){super(...(args.length?args:[window.fixture?.clockNow??fixtureNow]));}static now(){return window.fixture?.clockNow??fixtureNow;}};
    const { createDailyPlanner } = await import('/daily-planner.mjs');
    const tasks = Array.from({length: 18}, (_, i) => ({id:'task-'+i,key:'TASK-'+(i+1),title:i===0?'Review the release and verify the longest potentially unbroken identifier '+ 'LongIdentifier'.repeat(10):['Fix sign-in redirect','Review pull requests','Prepare sprint demo','Update documentation'][i%4],notes:i===1?'Keep this compact while still readable. Confirm on both light and dark themes.':'',status:i%5===0?'done':i%3===0?'in-progress':'todo',date:['2026-09-21','2026-09-22','2026-09-23','2026-09-25'][i%4],originalDate:'2026-09-21'}));
    tasks.push({id:'task-future',key:'TASK-19',title:'Future dependency review',notes:'Link this across sprint boundaries',status:'todo',date:'2026-10-05'}, {id:'task-past',key:'TASK-20',title:'Completed September investigation',notes:'Historical context',status:'done',date:'2026-09-01'}, {id:'task-archived',key:'TASK-21',title:'Archived rollout checklist',notes:'Preserved history',status:'archived',date:'2026-09-03'});
    window.fixture = {state:{revision:1,today:'2026-09-22',settings:{startTime:'09:00',endTime:'18:00',timeZone:'Asia/Kolkata',remindersEnabled:false},tasks,links:[{id:'link-existing',sourceTaskId:'task-1',targetTaskId:'task-2',type:'related',createdAt:'2026-09-22T01:00:00Z'}],events:[{taskId:'task-2',title:'Prepare sprint demo',kind:'moved',fromDate:'2026-09-21',toDate:'2026-09-23'}],daysOff:[{date:'2026-09-24',label:'Personal leave'}],sprints:[{id:'s1',name:'Sprint 24 · App experience',startDate:'2026-09-21',endDate:'2026-10-02'}]},calls:[],conflictNext:false,nextTaskKey:22,toasts:[]};
    const clone = value => JSON.parse(JSON.stringify(value));
    // Simulate authoritative timing fields from the backend, keeping missed-day
    // facts monotonic even after a task is completed, reopened, or archived.
    fixture.syncTimings=()=>{
      const previous=fixture.state.taskTimings||{},taskTimings={},missedByDate={};
      for(const task of fixture.state.tasks){
        const completedDate=previous[task.id]?.completedDate||task.completedAt?.slice(0,10)||((task.status==='done')?task.date:'');
        const elapsedDays=Math.floor((Date.parse((completedDate||fixture.state.today)+'T12:00:00Z')-Date.parse(task.date+'T12:00:00Z'))/86400000),latenessDays=completedDate?elapsedDays:Math.max(0,elapsedDays);
        const missedPlannedDay=Boolean(previous[task.id]?.missedPlannedDay||(task.date<fixture.state.today&&(!completedDate||completedDate>task.date)));
        const timingStatus=completedDate?(latenessDays<=0?'on-time':latenessDays<=2?'late':'very-late'):(latenessDays===0?'pending':latenessDays<=2?'overdue':'very-overdue');
        taskTimings[task.id]={plannedDate:task.date,completedDate,latenessDays,timingStatus,missedPlannedDay};
        if(missedPlannedDay)missedByDate[task.date]=(missedByDate[task.date]||0)+1;
      }
      fixture.state.taskTimings=taskTimings;fixture.state.missedByDate=missedByDate;
    };
    fixture.api = async (url, options = {}) => {
      fixture.calls.push({url, options});
      if(url.endsWith('/ai/proposals') && options.method === 'POST') return fixture.aiMode==='cleanup' ? {id:'j2',status:'failed',cleanupRequired:true,error:'Cleanup pending'} : fixture.aiMode ? {id:'j2',status:'running',provider:'codex'} : {id:'j1',status:'completed',provider:'codex',tasks:[{title:'Suggested task',notes:'Editable before adding',date:'2026-09-22'}]};
      if(url.includes('/ai/proposals/')) {
        if(options.method==='DELETE') { if(fixture.cancelFail) {fixture.cancelFail=false;throw new Error('temporary cancellation error');} if(fixture.cleanupNext){fixture.cleanupNext=false;return{id:'j2',status:'cancelled',cleanupRequired:true};} return {id:'j2',status:'cancelled',cleanupRequired:false}; }
        if(fixture.aiMode==='poll-error') throw new Error('temporary poll error');
        return {id:'j2',status:'paused'};
      }
      if(url.includes('/report?')) return fixture.reportHook ? fixture.reportHook(url,options) : {summary:{planned:3,worked:2,completed:1,missedPlannedDay:1,moved:1},daily:[{date:'2026-09-22',summary:{planned:3,completed:1,missedPlannedDay:1,moved:1},tasks:[{taskId:'task-1',key:'TASK-2',title:'Release review',plannedDate:'2026-09-21',completedDate:'2026-09-22',latenessDays:1,timingStatus:'late',missedPlannedDay:true,worked:true,completed:true}]}]};
      if (options.method) {
        if(fixture.holdTaskMutation&&options.method==='PATCH'&&url.includes('/tasks/'))await fixture.holdTaskMutation;
        if(fixture.conflictNext) { fixture.conflictNext=false; throw Object.assign(new Error('conflict'),{status:409}); }
        const parsed = new URL(url, location.origin), endpoint = parsed.pathname;
        const revision = options.method==='DELETE' ? Number(parsed.searchParams.get('revision')) : options.body?.revision;
        if(revision!==fixture.state.revision) throw Object.assign(new Error('stale revision'),{status:409});
        const data={...options.body};delete data.revision;
        if(endpoint.endsWith('/links') && options.method==='POST') {
          const ids=[data.sourceTaskId,data.targetTaskId].sort();
          if(ids[0]===ids[1] || ids.some(id=>!fixture.state.tasks.some(task=>task.id===id)) || data.type!=='related') throw new Error('Invalid fixture link');
          if(fixture.state.links.some(link=>link.sourceTaskId===ids[0]&&link.targetTaskId===ids[1])) throw Object.assign(new Error('duplicate link'),{status:409});
          fixture.state.links.push({id:'link-'+(fixture.state.revision+1),sourceTaskId:ids[0],targetTaskId:ids[1],type:'related',createdAt:'2026-09-22T02:00:00Z'});
        }
        if(endpoint.includes('/links/') && options.method==='DELETE') fixture.state.links=fixture.state.links.filter(link=>link.id!==decodeURIComponent(endpoint.split('/').pop()));
        if(endpoint.includes('/tasks/') && options.method==='DELETE') {
          const id=decodeURIComponent(endpoint.split('/').pop());
          fixture.state.tasks=fixture.state.tasks.filter(t=>t.id!==id);
          fixture.state.events=fixture.state.events.filter(e=>e.taskId!==id);
          fixture.state.links=fixture.state.links.filter(l=>l.sourceTaskId!==id&&l.targetTaskId!==id);
        }
        fixture.state.revision++;
        if(endpoint.endsWith('/tasks') && options.method==='POST') fixture.state.tasks.push(...data.tasks.map((t,i)=>({...t,id:'new-'+fixture.state.revision+'-'+i,key:'TASK-'+fixture.nextTaskKey++,status:'todo'})));
        if(endpoint.includes('/tasks/') && options.method==='PATCH') {
          const task=fixture.state.tasks.find(t=>t.id===decodeURIComponent(endpoint.split('/').pop()));
          if(data.date&&data.date!==task.date)throw new Error('The planned date is fixed');
          if(data.status==='done'&&task.status!=='done')task.completedAt=new Date().toISOString();
          Object.assign(task,data);
        }
        if(endpoint.endsWith('/settings') && options.method==='PUT') Object.assign(fixture.state.settings,data);
      }
      fixture.syncTimings();
      return clone(fixture.state);
    };
    fixture.createPlanner=()=>createDailyPlanner({root:document.querySelector('#planner'),api:fixture.api,toast:message=>fixture.toasts.push(message),desktop:{getPlannerNotificationStatus:async()=>({supported:true,appMustBeRunning:true})}});
    fixture.planner=fixture.createPlanner();
    await fixture.planner.open();
    fixture.click = action => {const button=[...document.querySelectorAll('[data-planner-action="'+action+'"]')].find(n=>!n.closest('dialog') || n.closest('dialog').open); if(!button)throw new Error('Missing '+action);button.click();};
    fixture.input = (name,value) => {const el=document.querySelector('dialog [name="'+name+'"]');el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
    fixture.assert = (yes,message) => {if(!yes)throw new Error(message);};
    fixture.pause = () => new Promise(resolve=>setTimeout(resolve,20));
    fixture.select = selector => {const element=document.querySelector(selector);fixture.assert(element,'Missing '+selector);element.click();};
    fixture.timeField = name => document.querySelector('dialog [name="'+name+'"]').closest('[data-planner-time-field]');
    fixture.measure = () => {
      const rect = node => {const b=node.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};};
      const board=document.querySelector('.dp-week-grid'), days=[...document.querySelectorAll('.dp-day')];
      return {viewport:{width:innerWidth,height:innerHeight}, root:rect(document.querySelector('#planner')), bodyWidth:document.body.scrollWidth, board:rect(board), days:days.map(d=>({bounds:rect(d),width:d.clientWidth,scrollWidth:d.scrollWidth,taskBounds:rect(d.querySelector('.dp-day-tasks')),taskWidth:d.querySelector('.dp-day-tasks').clientWidth,taskScrollWidth:d.querySelector('.dp-day-tasks').scrollWidth})), actionBounds:rect(document.querySelector('.dp-main-actions'))};
    };
  })()`);
  const layouts = [];
  for (const width of [360, 720, 1400]) for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans"]) for (const zoom of [1, 1.22]) {
    window.setContentSize(width, 900); window.webContents.setZoomFactor(zoom);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};undefined;`); await settle();
    assert.equal(await run("document.querySelector('dialog').open"), false, "Dialog remains closed on the board");
    const layout = await run("fixture.measure()");
    assert.equal(layout.days.length, 5); assert.ok(layout.bodyWidth <= layout.viewport.width + 1, `Root horizontal overflow ${width}/${font}/${zoom}`);
    assert.ok(layout.root.right <= layout.viewport.width + 1 && layout.root.bottom <= layout.viewport.height + 1, "Production fixed panel must fit after titlebar and left rail");
    assert.ok(layout.board.bottom <= layout.viewport.height + 1 && layout.board.height > 180, "Board must occupy available height");
    assert.ok(layout.actionBounds.right <= layout.viewport.width + 1, "Header actions must fit");
    for (const day of layout.days) { assert.ok(day.scrollWidth <= day.width + 1, "Column text overflow"); assert.ok(day.taskScrollWidth <= day.taskWidth + 1, "Task text overflow"); assert.ok(day.taskBounds.bottom <= layout.board.bottom + 1, "Independent task scroll must stay inside board"); }
    await run("new Promise(resolve => setTimeout(resolve, 50))");
    if (width === 1400 && theme === "dark" && font === "comic-sans" && zoom === 1) await fs.writeFile(path.join(temporary, "week-desktop.png"), (await window.webContents.capturePage()).toPNG());
    if (width === 360 && theme === "light" && font === "comic-sans" && zoom === 1.22) await fs.writeFile(path.join(temporary, "week-narrow.png"), (await window.webContents.capturePage()).toPNG());
    // Every settings field and footer must remain reachable in the real dialog.
    await run("fixture.click('settings');undefined;"); await settle();
    const modal = await run("(() => {const d=document.querySelector('dialog'),r=d.getBoundingClientRect(),f=d.querySelector('footer').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,footerBottom:f.bottom,scrollWidth:d.scrollWidth,clientWidth:d.clientWidth};})()");
    assert.ok(modal.left >= -1 && modal.right <= modal.width + 1 && modal.bottom <= modal.height + 1, `Dialog bounds ${width}/${font}/${zoom}`);
    assert.ok(modal.footerBottom <= modal.height + 1 && modal.scrollWidth <= modal.clientWidth + 1, "Settings actions fit");
    assert.ok(modal.right - modal.left <= 562, "Settings dialog must stay compact, not inherit legacy fullscreen dialog styles");
    assert.ok(modal.bottom - modal.footerBottom < 3, "No empty padding below the settings footer");
    if (width === 1400 && theme === "light" && font === "comic-sans" && zoom === 1) { await run("new Promise(resolve => setTimeout(resolve, 50))"); await fs.writeFile(path.join(temporary, "settings-desktop.png"), (await window.webContents.capturePage()).toPNG()); }
    assert.equal(await run("document.querySelectorAll('dialog input[type=time]').length"), 0, "Settings must not fall back to platform-native time controls");
    await run("fixture.timeField('startTime').querySelector('[data-time-toggle]').click();undefined;"); await settle();
    const popup = await run("(() => {const p=document.querySelector('[data-time-popup]:not([hidden])'),r=p.getBoundingClientRect(),d=p.closest('dialog').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,dialogLeft:d.left,dialogRight:d.right,dialogTop:d.top,dialogBottom:d.bottom,scrollWidth:p.scrollWidth,clientWidth:p.clientWidth,selected:p.querySelectorAll('[aria-selected=true]').length,foreground:getComputedStyle(p).color,background:getComputedStyle(p).backgroundColor};})()");
    assert.ok(popup.left >= popup.dialogLeft && popup.right <= popup.dialogRight + 1 && popup.top >= popup.dialogTop && popup.bottom <= popup.dialogBottom + 1, `Time picker must fit dialog ${width}/${theme}/${font}/${zoom}: ${JSON.stringify(popup)}`);
    assert.ok(popup.left >= 0 && popup.right <= popup.width + 1 && popup.bottom <= popup.height + 1 && popup.scrollWidth <= popup.clientWidth + 1, "Time picker must fit the viewport without horizontal clipping");
    assert.equal(popup.selected, 3, "Hour, minute, and period must each have a visible selection");
    assert.notEqual(popup.foreground, popup.background, "Time picker must inherit readable theme colors");
    if (font === "comic-sans" && ((width === 1400 && theme === "dark" && zoom === 1) || (width === 360 && theme === "light" && zoom === 1.22))) await fs.writeFile(path.join(temporary, `time-popup-${width === 1400 ? "desktop" : "narrow"}.png`), (await window.webContents.capturePage()).toPNG());
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await settle();
    assert.equal(await run("document.querySelectorAll('[data-time-popup]:not([hidden])').length"), 0, "Escape must close the time popup");
    assert.equal(await run("document.querySelector('dialog').open"), true, "Escape from the time picker must preserve the settings dialog");
    await run("fixture.click('close-dialog');undefined;");
    layouts.push({ width, theme, font, zoom, boardHeight: layout.board.height, timePickerFits: true });
  }
  window.setContentSize(1400, 900); window.webContents.setZoomFactor(1);
  await run("document.documentElement.dataset.theme='dark';fixture.click('view-performance');new Promise(resolve=>setTimeout(resolve,80));"); await settle();
  await run("(()=>{const assert=fixture.assert;assert(document.querySelector('.dp-metrics').textContent.includes('Not completed on planned day'),'Performance must show the permanent missed-day metric');const row=document.querySelector('.dp-report-task-row');assert(row?.dataset.timing==='late','Report must retain task timing state');const dates=row.querySelector('.dp-report-task-dates').textContent;assert(dates.includes('Planned')&&dates.includes('First completed'),'Report must distinguish planned and first-completed dates');document.querySelector('.dp-performance-day').open=true;})()");await settle();
  await fs.writeFile(path.join(temporary, "performance-desktop.png"), (await window.webContents.capturePage()).toPNG());
  for (const action of ["reports", "sprints"]) {
    await run(`fixture.click(${JSON.stringify(action)});new Promise(resolve=>setTimeout(resolve,80));`); await settle();
    await fs.writeFile(path.join(temporary, `${action}-desktop.png`), (await window.webContents.capturePage()).toPNG());
    await run("fixture.click('close-dialog');undefined;");
  }
  await run("fixture.click('view-week');undefined;");
  await run(`(async () => {
    const assert=fixture.assert, pause=fixture.pause;
    fixture.click('settings');
    const field=fixture.timeField('startTime'), display=field.querySelector('[data-time-display]');
    const writes=()=>fixture.calls.filter(call=>call.url.endsWith('/settings')&&call.options.method==='PUT').length;
    const before=writes();display.value='25:99';display.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('dialog form').requestSubmit();await pause();
    assert(!display.checkValidity()&&display.getAttribute('aria-invalid')==='true','Invalid typed time must be visibly invalid');
    assert(writes()===before&&document.querySelector('dialog').open,'Invalid time must block Save');
    display.value='09:15';display.dispatchEvent(new Event('input',{bubbles:true}));display.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true,cancelable:true}));
    assert(!field.querySelector('[data-time-popup]').hidden,'Alt+Down must open the styled picker');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
    assert(field.querySelector('[data-time-value]').value==='10:15','Hour arrow navigation must update canonical time');
    field.querySelector('[data-time-part="minute"][data-time-choice="30"]').click();field.querySelector('[data-time-done]').click();
    assert(display.value==='10:30 AM','Styled selection must format display');
    const endDisplay=fixture.timeField('endTime').querySelector('[data-time-display]');endDisplay.value='6:45 PM';endDisplay.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('dialog form').requestSubmit();await pause();
    assert(!document.querySelector('dialog').open,'Valid time settings must save');
    const settings=fixture.calls.filter(call=>call.url.endsWith('/settings')&&call.options.method==='PUT').at(-1).options.body;
    assert(settings.startTime==='10:30'&&settings.endTime==='18:45','Settings API must receive canonical HH:mm from custom fields');
    fixture.click('settings');assert(fixture.timeField('startTime').querySelector('[data-time-display]').value==='10:30 AM','Saved time must survive settings reopen');fixture.click('close-dialog');
    fixture.timeInteractionsPassed=true;

    const source='task-1', sourceKey='TASK-2';
    assert(document.querySelector('[data-task="'+source+'"] .dp-task-key').textContent===sourceKey,'Task cards must show stable display keys');
    fixture.select('[data-planner-action="task-links"][data-id="'+source+'"]');
    assert(document.querySelector('.dp-related-section').open,'Card link button must reveal related tasks');
    assert(document.querySelector('dialog .dp-task-key').textContent===sourceKey,'Task editor must show key');
    fixture.input('title','Unsaved task title stays while linking');fixture.input('notes','Unsaved detailed notes also stay');
    const patchCount=()=>fixture.calls.filter(call=>call.options.method==='PATCH').length;
    const patches=patchCount();
    for(const [id,query] of [['task-future','2026-10-05'],['task-past','TASK-20'],['task-archived','Archived rollout']]) {
      fixture.input('linkQuery',query);
      const result=document.querySelector('[data-link-results] [data-planner-action="add-link"][data-id="'+id+'"]');
      assert(result,'Link search must include '+id+' across all dates/status');
      assert(result.closest('.dp-task-result').querySelector('.dp-task-key'),'Link result must show task key');result.click();await pause();
      assert(document.querySelector('[data-related-list] [data-planner-action="edit-task"][data-id="'+id+'"]'),'New link must appear immediately');
      assert(document.querySelector('dialog [name="title"]').value==='Unsaved task title stays while linking'&&document.querySelector('dialog [name="notes"]').value==='Unsaved detailed notes also stay','Linking must preserve unsaved fields');
    }
    assert(patchCount()===patches,'Linking must not silently save task fields');
    assert(document.querySelector('[data-related-count]').textContent==='4','Related count must include persisted and new links');
    const taskCount=fixture.state.tasks.length, futureLink=fixture.state.links.find(link=>[link.sourceTaskId,link.targetTaskId].includes('task-future'));
    fixture.select('[data-planner-action="remove-link"][data-link-id="'+futureLink.id+'"]');await pause();
    assert(fixture.state.tasks.length===taskCount&&fixture.state.tasks.some(task=>task.id==='task-future'),'Unlink must preserve both tasks');
    assert(!document.querySelector('[data-related-list] [data-id="task-future"]')&&document.querySelector('[data-related-count]').textContent==='3','Unlink must update visible graph immediately');
    assert(document.querySelector('dialog [name="title"]').value==='Unsaved task title stays while linking','Unlink lost unsaved title');
    fixture.input('linkQuery','TASK-19');fixture.select('[data-planner-action="add-link"][data-id="task-future"]');await pause();
    fixture.click('close-dialog');fixture.select('[data-planner-action="task-links"][data-id="task-2"]');
    assert(document.querySelector('[data-related-count]').textContent==='1'&&document.querySelector('[data-related-list] [data-id="task-1"]'),'Incoming links must show in reverse direction');
    fixture.click('close-dialog');fixture.click('task-browser');fixture.input('taskQuery','2026-09-03');
    fixture.select('[data-task-results] [data-planner-action="edit-task"][data-id="task-archived"]');
    assert(['title','notes','date','status'].every(name=>document.querySelector('dialog [name="'+name+'"]').disabled),'Archived task fields must be read-only');
    const details=document.querySelector('.dp-related-section');details.open=true;fixture.input('linkQuery','TASK-19');
    const archivedLink=document.querySelector('[data-planner-action="add-link"][data-id="task-future"]');assert(archivedLink&&!archivedLink.disabled,'Archived task links must remain editable');archivedLink.click();await pause();
    assert(document.querySelector('[data-related-count]').textContent==='2','Archived links should include incoming and new links');
    fixture.click('close-dialog');
    const linksBefore=JSON.stringify(fixture.state.links),plannedDate=fixture.state.tasks.find(task=>task.id===source).date;
    assert(!document.querySelector('[data-planner-action="move"]'),'Fixed-date tasks must not offer a Next day action');
    fixture.planner.close();await fixture.planner.open();fixture.click('refresh');await pause();
    assert(fixture.state.tasks.find(task=>task.id===source).date===plannedDate&&fixture.state.tasks.find(task=>task.id===source).key===sourceKey&&JSON.stringify(fixture.state.links)===linksBefore,'Refresh and route reopen must preserve the planned date, task ID, and graph');
    fixture.select('[data-planner-action="task-links"][data-id="'+source+'"]');
    assert(document.querySelector('[data-related-count]').textContent==='4','Link graph must survive refresh and route reopen');
    assert(document.querySelector('dialog [name="title"]').value==='Unsaved task title stays while linking','Refreshing must keep unsaved task draft');
    const fixedDate=document.querySelector('dialog [name="date"]');
    assert(fixedDate.value===plannedDate&&(fixedDate.disabled||fixedDate.readOnly),'Existing task date must remain visibly fixed and non-editable');
    fixture.click('close-dialog');fixture.click('task-browser');
    for(const [query,id] of [['TASK-19','task-future'],['Historical context','task-past'],['Archived','task-archived']]) {
      fixture.input('taskQuery',query);assert(document.querySelector('[data-task-results] [data-id="'+id+'"]'),'Global browser must find '+id);
    }
    fixture.click('close-dialog');
    fixture.select('[data-planner-action="edit-task"][data-id="task-9"]');fixture.click('close-dialog');
    fixture.select('[data-planner-action="complete"][data-id="task-9"]');await pause();
    assert(fixture.state.tasks.find(task=>task.id==='task-9').status==='done','Board completion must update the task');
    fixture.select('[data-planner-action="edit-task"][data-id="task-9"]');
    assert(document.querySelector('dialog [name="status"]').value==='done','Reopened clean status must use the latest task, not a stale cancelled draft');
    fixture.input('notes','Only notes changed after board completion');document.querySelector('dialog form').requestSubmit();await pause();
    assert(fixture.state.tasks.find(task=>task.id==='task-9').status==='done','Editing notes must not undo completion');
    const lastPatch=fixture.calls.filter(call=>call.url.endsWith('/tasks/task-9')&&call.options.method==='PATCH').at(-1).options.body;
    assert(!('status' in lastPatch)&&!('date' in lastPatch),'Unchanged status/date must not be sent by a sparse notes update');
    fixture.linkInteractionsPassed=true;
  })()`);
  // Representative real-DOM screenshots and geometry for the expanded links editor.
  const linkLayouts=[];
  for(const [width,theme,zoom] of [[1400,"dark",1],[720,"light",1],[360,"light",1.22]]) {
    window.setContentSize(width,900);window.webContents.setZoomFactor(zoom);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};fixture.select('[data-planner-action="task-links"][data-id="task-1"]');fixture.input('linkQuery','');undefined;`);await settle();
    const bounds=await run("(() => {const d=document.querySelector('dialog'),r=d.getBoundingClientRect(),f=d.querySelector('footer').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,footerBottom:f.bottom,scrollWidth:d.scrollWidth,clientWidth:d.clientWidth,rows:[...d.querySelectorAll('.dp-task-result')].map(row=>({width:row.clientWidth,scrollWidth:row.scrollWidth}))};})()");
    assert.ok(bounds.left>=0&&bounds.right<=bounds.width+1&&bounds.bottom<=bounds.height+1&&bounds.footerBottom<=bounds.height+1&&bounds.scrollWidth<=bounds.clientWidth+1,`Linked task editor must fit ${width}/${zoom}`);
    for(const row of bounds.rows) assert.ok(row.scrollWidth<=row.width+1,"Link results must wrap without clipping actions");
    await run("document.querySelector('.dp-related-section').scrollIntoView({block:'start'});undefined;");await settle();
    await fs.writeFile(path.join(temporary,`task-links-${width}.png`),(await window.webContents.capturePage()).toPNG());
    await run("fixture.click('close-dialog');undefined;");linkLayouts.push({width,theme,zoom,linksFit:true});
  }
  window.setContentSize(1400,900);window.webContents.setZoomFactor(1);
  await run(`(async () => {
    const assert=(yes,message)=>{if(!yes)throw new Error(message);};
    fixture.click('new-task');fixture.input('title','Kept draft across route changes');fixture.input('notes','Important details');
    fixture.planner.close();await fixture.planner.open();fixture.click('new-task');
    assert(document.querySelector('dialog [name="title"]').value==='Kept draft across route changes','Route change lost draft');
    fixture.conflictNext=true;document.querySelector('dialog form').requestSubmit();await new Promise(r=>setTimeout(r,20));
    assert(document.querySelector('dialog').open,'Conflict closed draft');
    assert(document.querySelector('dialog [name="title"]').value==='Kept draft across route changes','Conflict lost draft');
    const reload=document.querySelector('dialog [data-planner-action="refresh"]');assert(!reload.hidden,'Conflict needs a reachable reload');reload.click();await new Promise(r=>setTimeout(r,20));
    document.querySelector('dialog form').requestSubmit();await new Promise(r=>setTimeout(r,20));
    assert(!document.querySelector('dialog').open,'Successful add did not close');assert(fixture.state.tasks.some(t=>t.title==='Kept draft across route changes'),'Manual task not added');
    fixture.click('ai');fixture.input('prompt','Prepare a release');fixture.click('propose');await new Promise(r=>setTimeout(r,20));
    const writes=fixture.calls.filter(c=>c.options.method==='POST'&&c.url.endsWith('/tasks')).length;
    assert(document.querySelector('[name="proposalTitle"]').value==='Suggested task','AI preview missing');
    fixture.input('proposalTitle','Reviewed AI suggestion');
    assert(fixture.calls.filter(c=>c.options.method==='POST'&&c.url.endsWith('/tasks')).length===writes,'AI wrote before confirmation');
    document.querySelector('dialog form').requestSubmit();await new Promise(r=>setTimeout(r,20));
    assert(fixture.state.tasks.some(t=>t.title==='Reviewed AI suggestion'),'Editable AI task not committed through shared tasks path');
    fixture.aiMode='paused';fixture.click('ai');fixture.input('prompt','Keep paused draft');fixture.click('propose');await new Promise(r=>setTimeout(r,900));
    assert(document.querySelector('[data-ai-status]').textContent.includes('paused'),'Paused status was treated as failure');
    const cancel=document.querySelector('[data-planner-action="cancel-ai"]');assert(!cancel.hidden,'Paused job must remain cancellable');
    fixture.cancelFail=true;cancel.click();await new Promise(r=>setTimeout(r,20));assert(!cancel.hidden,'Unconfirmed cancellation hid retry');
    cancel.click();await new Promise(r=>setTimeout(r,20));assert(cancel.hidden,'Confirmed cancellation did not settle');
    assert(fixture.calls.filter(c=>c.url.endsWith('/ai/proposals/j2')&&c.options.method==='DELETE').length===2,'Cancel retry lost job identity');
    assert(document.querySelector('dialog [name="prompt"]').value==='Keep paused draft','Cancel lost prompt');
    fixture.aiMode='poll-error';fixture.click('propose');await new Promise(r=>setTimeout(r,900));
    assert(document.querySelector('[data-ai-status]').textContent.includes('Retrying'),'Poll error must retry without losing ownership');
    assert(!cancel.hidden,'Poll error hid Cancel');cancel.click();await new Promise(r=>setTimeout(r,20));fixture.click('close-dialog');
    fixture.aiMode='cleanup';fixture.click('ai');fixture.click('propose');await new Promise(r=>setTimeout(r,20));
    const cleanupCancel=document.querySelector('[data-planner-action="cancel-ai"]');assert(!cleanupCancel.hidden,'Failed cleanup lost owned AI job');
    fixture.cleanupNext=true;cleanupCancel.click();await new Promise(r=>setTimeout(r,20));assert(!cleanupCancel.hidden,'Unconfirmed cleanup must remain retryable');
    cleanupCancel.click();await new Promise(r=>setTimeout(r,20));assert(cleanupCancel.hidden,'Successful cleanup did not release AI ownership');fixture.click('close-dialog');
    fixture.click('view-performance');await new Promise(r=>setTimeout(r,20));assert(document.querySelectorAll('.dp-metrics article').length===4,'Performance missing');
    fixture.click('view-week');fixture.click('reports');assert(document.querySelector('[name="groupBy"] option[value="sprint"]'),'Sprint grouping missing');
    fixture.input('period','six-months');assert(document.querySelector('[data-report-range]').textContent.includes('2026'),'Six-month range missing');fixture.click('close-dialog');
    fixture.planner.close();
  })()`);
  // A real, long-lived planner with a large saved backlog. Archive records and
  // moved history are retained in state, not discarded to make the board fit.
  await run(`(async()=>{
    const dates=['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25'];
    const tasks=[],events=[];
    for(const [day,date]of dates.entries()){
      for(let index=0;index<100;index++){
        const id='stress-'+day+'-'+index;
        tasks.push({id,key:'TASK-'+(1000+day*100+index),title:index%10===0?'A deliberately long unbroken task identifier '+ 'LongIdentifier'.repeat(24):'Task '+index+' — Investigate the service workflow, document findings, and verify the final release',notes:('Long notes remain readable without widening a card. '+ 'UnbrokenNotes'.repeat(20)+String.fromCharCode(10)).repeat(5),status:index%4===0?'done':index%3===0?'in-progress':'todo',date,originalDate:date});
        const movedId='history-'+day+'-'+index;
        tasks.push({id:movedId,key:'TASK-'+(2000+day*100+index),title:'Previously moved '+index+' '+ 'HistoricalIdentifier'.repeat(12),notes:'Legacy movement evidence remains after archival and fixed-date migration',status:'archived',date,originalDate:date});
        events.push({id:'move-'+day+'-'+index,taskId:movedId,title:'Moved '+index+' '+ 'HistoricalIdentifier'.repeat(12),kind:'moved',fromDate:date,toDate:'2026-10-05',date});
      }
      for(let index=0;index<20;index++)tasks.push({id:'archived-stress-'+day+'-'+index,key:'TASK-'+(3000+day*20+index),title:'Archived retained task '+index,notes:'Never delete this archive',status:'archived',date,originalDate:date});
    }
    fixture.state={...fixture.state,revision:fixture.state.revision+1,tasks,events,links:[],daysOff:[],sprints:[{id:'stress-sprint',name:'Release quality and resilience sprint '+ 'LongSprintName'.repeat(20),startDate:dates[0],endDate:dates[4]}]};
    fixture.planner.destroy();const root=document.querySelector('#planner');root.replaceWith(root.cloneNode(false));fixture.planner=fixture.createPlanner();
    fixture.stressDates=dates;await fixture.planner.open();
    fixture.stressGeometry=()=>{
      const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const board=document.querySelector('.dp-week-grid');
      return{width:innerWidth,height:innerHeight,bodyOverflow:document.body.scrollWidth>innerWidth+1,rootOverflow:document.querySelector('#planner').scrollWidth>document.querySelector('#planner').clientWidth+1,rootWidth:document.querySelector('#planner').clientWidth,rootScrollWidth:document.querySelector('#planner').scrollWidth,rootChildren:[...document.querySelector('#planner').children].map(node=>({name:node.className,...rect(node),width:node.clientWidth,scrollWidth:node.scrollWidth,overflow:getComputedStyle(node).overflow})),board:rect(board),boardScrollTop:board.scrollTop,
        archivedCards:document.querySelectorAll('.dp-task[data-task^="archived-stress-"]').length,
        days:[...document.querySelectorAll('.dp-day')].map(day=>{
          const scroller=day.querySelector('.dp-day-tasks'),history=day.querySelector('.dp-moved-history');
          return{date:day.dataset.date,header:rect(day.querySelector('.dp-day-heading')),bounds:rect(day),meta:day.querySelector('.dp-day-meta').textContent,overflow:day.scrollWidth>day.clientWidth+1,scrollTop:scroller.scrollTop,scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight,scroller:rect(scroller),scrollerOverflow:scroller.scrollWidth>scroller.clientWidth+1,
            cards:[...day.querySelectorAll('.dp-task')].map(card=>({id:card.dataset.task,bounds:rect(card),overflow:card.scrollWidth>card.clientWidth+1,done:card.classList.contains('is-done')})),history:history?{open:history.open,count:history.querySelectorAll('.dp-moved-record').length,text:history.querySelector('summary').textContent}:null};})};
    };
  })()`);
  const stressLayouts=[];
  for(const width of [360,720,1400])for(const theme of ['dark','light'])for(const font of ['system','comic-sans'])for(const zoom of [1,1.22]){
    window.setContentSize(width,900);window.webContents.setZoomFactor(zoom);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};document.querySelector('.dp-week-grid').scrollLeft=0;document.querySelectorAll('[data-day-scroll]').forEach(node=>node.scrollTop=0);undefined;`);await settle();
    const before=await run('fixture.stressGeometry()'),diagnostic=JSON.stringify({width,theme,font,zoom});
    assert.equal(before.days.length,5,diagnostic);assert.equal(before.archivedCards,0,'Archived tasks must not crowd the active board');
    assert.equal(before.bodyOverflow,false,'No page horizontal overflow '+diagnostic);assert.equal(before.rootOverflow,false,'No planner horizontal overflow '+JSON.stringify({scenario:diagnostic,rootWidth:before.rootWidth,rootScrollWidth:before.rootScrollWidth,children:before.rootChildren}));
    assert.ok(before.board.bottom<=before.height+1&&before.board.height>150,'Dense board must use remaining viewport '+diagnostic);
    for(const day of before.days){
      assert.equal(day.cards.length,40,'Initial card rendering must stay bounded '+diagnostic);assert.ok(day.cards.every(card=>!card.done),'Pending work should appear before completed cards');
      assert.match(day.meta,/100/,'Header count must include unloaded tasks');assert.match(day.meta,/25/,'Header count must include all completed tasks');
      assert.equal(day.overflow,false,diagnostic);assert.equal(day.scrollerOverflow,false,diagnostic);assert.ok(day.scrollHeight>day.clientHeight*3,'Stress state must actually overflow vertically');
      assert.ok(day.scroller.bottom<=before.board.bottom+1,'Day scrollbar must remain inside the board');
      assert.ok(day.history&&!day.history.open,'Large moved history must be collapsed initially');assert.equal(day.history.count,40,'History must also be bounded');assert.match(day.history.text,/100/,'History summary must show the full count');
      for(const card of day.cards)assert.ok(!card.overflow&&card.bounds.left>=day.bounds.left-1&&card.bounds.right<=day.bounds.right+1,'Long task content widened its column '+diagnostic);
    }
    await run("document.querySelectorAll('[data-day-scroll]').forEach(node=>node.scrollTop=node.scrollHeight);undefined;");await settle();
    const after=await run('fixture.stressGeometry()');
    for(let index=0;index<5;index++){assert.ok(after.days[index].scrollTop>0,'Every day must scroll independently');assert.ok(Math.abs(before.days[index].header.top-after.days[index].header.top)<=1,'Day heading moved while task list scrolled '+diagnostic+' '+JSON.stringify({index,before:before.days[index].header,after:after.days[index].header,boardBefore:before.board,boardAfter:after.board}));}
    assert.equal(after.boardScrollTop,0,'Task scrolling must not move the weekly board itself');
    // Status actions on the final rendered card must be reachable,
    // rather than clipped behind a fixed card height or the scroll boundary.
    await run("(()=>{const cards=document.querySelector('.dp-day').querySelectorAll('.dp-task');cards[cards.length-1].querySelector('footer').scrollIntoView({block:'end',inline:'nearest'});})()");await settle();
    const footer=await run(`(()=>{const day=document.querySelector('.dp-day'),cards=day.querySelectorAll('.dp-task'),node=cards[cards.length-1].querySelector('footer');const r=node.getBoundingClientRect(),s=day.querySelector('.dp-day-tasks').getBoundingClientRect();return{top:r.top,bottom:r.bottom,scrollerTop:s.top,scrollerBottom:s.bottom,buttons:[...node.querySelectorAll('button')].map(button=>{const b=button.getBoundingClientRect(),hit=document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,uncovered:button.contains(hit),hit:hit?.outerHTML.slice(0,200)}})}})()`);
    assert.ok(footer.top>=footer.scrollerTop-1&&footer.bottom<=footer.scrollerBottom+1,'Card footer cannot be reached '+diagnostic);assert.ok(footer.buttons.every(button=>button.uncovered),'Footer action obscured '+diagnostic+' '+JSON.stringify(footer));
    if(font==='comic-sans'&&zoom===1&&((width===1400&&theme==='dark')||(width===360&&theme==='light'))){
      await run("document.querySelectorAll('[data-day-scroll]').forEach(node=>node.scrollTop=0);undefined;");await settle();await new Promise(resolve=>setTimeout(resolve,60));
      await fs.writeFile(path.join(temporary,`backlog-${width}-${theme}.png`),(await window.webContents.capturePage()).toPNG());
    }
    stressLayouts.push({width,theme,font,zoom,headersFixed:true,cardsFit:true,initialCardsPerDay:40});
  }
  window.setContentSize(1400,900);window.webContents.setZoomFactor(1);await settle();
  await run(`(async()=>{
    const assert=fixture.assert,pause=fixture.pause,date='2026-09-22';
    const day=()=>document.querySelector('.dp-day[data-date="'+date+'"]');
    const history=()=>day().querySelector('.dp-moved-history');
    const showMore=action=>{const node=day().querySelector('[data-planner-action="'+action+'"]');assert(node,'Missing '+action);node.click();};
    showMore('more-day-tasks');await pause();assert(day().querySelectorAll('.dp-task').length===80,'First expansion must reveal 80 tasks');
    showMore('more-day-tasks');await pause();assert(day().querySelectorAll('.dp-task').length===100,'Second expansion must reveal every task');assert(!day().querySelector('[data-planner-action="more-day-tasks"]'),'Fully loaded day should have no extra task button');
    history().open=true;await pause();showMore('more-day-history');await pause();assert(history().open&&history().querySelectorAll('.dp-moved-record').length===80,'Loading history should preserve expansion');
    showMore('more-day-history');await pause();assert(history().querySelectorAll('.dp-moved-record').length===100,'All historical records must be reachable');
    const scroller=day().querySelector('.dp-day-tasks');scroller.scrollTop=400;const scrollTop=scroller.scrollTop;
    fixture.state.revision++;await fixture.planner.refresh();await pause();
    assert(day().querySelectorAll('.dp-task').length===100&&history().querySelectorAll('.dp-moved-record').length===100,'Refresh lost the loaded backlog');
    assert(history().open,'Refresh unexpectedly collapsed moved history');assert(Math.abs(day().querySelector('.dp-day-tasks').scrollTop-scrollTop)<=1,'Refresh jumped the task scroll');
    history().open=false;await pause();fixture.state.revision++;await fixture.planner.refresh();await pause();assert(!history().open,'Refresh unexpectedly reopened collapsed history');
    history().open=true;await pause();const historical=history().querySelector('[data-planner-action="edit-task"]');assert(historical,'Historical task must have an explicit action');historical.click();await pause();
    assert(document.querySelector('dialog').open,'Historical task must open its current detail');assert(document.querySelector('dialog [name="date"]').value===date&&document.querySelector('dialog [name="date"]').disabled,'Legacy history must resolve its retained task with the immutable original planned day');fixture.click('close-dialog');
    const archived=fixture.state.tasks.find(task=>task.id==='archived-stress-1-0');assert(archived,'Archived task must still exist');
    fixture.click('task-browser');fixture.input('taskQuery',archived.key);fixture.select('[data-task-results] [data-id="'+archived.id+'"]');await pause();
    assert(document.querySelector('[data-planner-action="restore-task"]'),'Archived detail needs a restore action');
  })()`);await settle();
  for(const [width,theme,zoom]of [[1400,'dark',1],[360,'light',1.22]]){
    window.setContentSize(width,900);window.webContents.setZoomFactor(zoom);await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};undefined;`);await settle();
    const footer=await run("(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect(),f=d.querySelector('footer').getBoundingClientRect();return{left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,footerBottom:f.bottom,overflow:d.scrollWidth>d.clientWidth+1,actions:[...d.querySelectorAll('footer button')].filter(b=>b.checkVisibility()).map(b=>{const x=b.getBoundingClientRect();return{left:x.left,right:x.right,top:x.top,bottom:x.bottom,visible:b.contains(document.elementFromPoint((x.left+x.right)/2,(x.top+x.bottom)/2))}})}})()");
    assert.ok(!footer.overflow&&footer.left>=0&&footer.right<=footer.width+1&&footer.bottom<=footer.height+1&&footer.footerBottom<=footer.height+1,'Archived task dialog escapes the viewport');assert.ok(footer.actions.every(action=>action.visible&&action.left>=footer.left&&action.right<=footer.right&&action.bottom<=footer.height+1),'Archive restore/footer action is clipped');
    await new Promise(resolve=>setTimeout(resolve,60));await fs.writeFile(path.join(temporary,`backlog-archive-${width}-${theme}.png`),(await window.webContents.capturePage()).toPNG());
  }
  window.setContentSize(1400,900);window.webContents.setZoomFactor(1);await settle();
  await run(`(async()=>{
    const assert=fixture.assert,pause=fixture.pause;
    const task=id=>fixture.state.tasks.find(task=>task.id===id);
    const patches=()=>fixture.calls.filter(call=>call.options.method==='PATCH'&&call.url.includes('/tasks/'));
    const openTask=async id=>{fixture.click('task-browser');fixture.input('taskStatusFilter','all');fixture.input('taskQuery',task(id).key);fixture.select('[data-task-results] [data-id="'+id+'"]');await pause();};
    const archivedId='archived-stress-1-0',archivedBefore=JSON.stringify({...task(archivedId),status:'todo'}),eventsBefore=JSON.stringify(fixture.state.events);
    fixture.click('restore-task');await pause();
    assert(document.querySelector('dialog').open,'Restore must keep the task editor open for preserved drafts');
    assert(JSON.stringify(task(archivedId))===archivedBefore&&JSON.stringify(fixture.state.events)===eventsBefore,'Restore must retain task ID, details, and previous history');
    assert(patches().at(-1).options.body.status==='todo','Restore must submit the shared task status mutation');
    assert(['title','notes','status'].every(name=>!document.querySelector('dialog [name="'+name+'"]').disabled),'Restored task details must be editable');assert(document.querySelector('dialog [name="date"]').disabled,'Restore must not unlock the original planned date');fixture.click('close-dialog');

    const futureId='stress-2-1',futureComplete=document.querySelector('[data-planner-action="complete"][data-id="'+futureId+'"]');
    assert(futureComplete&&!futureComplete.disabled,'A future scheduled task must be completable now');futureComplete.focus({preventScroll:true});assert(document.activeElement===futureComplete,'The completion control must own focus before mutation');futureComplete.click();await pause();
    assert(task(futureId).status==='done'&&patches().at(-1).options.body.status==='done','Future board completion must submit immediately');
    assert(task(futureId).date==='2026-09-23'&&task(futureId).completedAt.startsWith('2026-09-22'),'Completing early must record the completion date without moving the planned card');
    fixture.completedFocusFallbackPassed=document.activeElement.dataset.dayScroll==='2026-09-23';
    let releaseMutation;fixture.holdTaskMutation=new Promise(resolve=>{releaseMutation=resolve;});
    const delayedComplete=document.querySelector('[data-planner-action="complete"][data-id="stress-2-6"]');delayedComplete.focus();delayedComplete.click();
    const reportsButton=document.querySelector('[data-planner-action="reports"]');reportsButton.focus();releaseMutation();await pause();fixture.holdTaskMutation=null;
    assert(document.activeElement===reportsButton,'Finishing an earlier task action must not steal newly chosen focus');
    const futureEditorId='stress-2-2';await openTask(futureEditorId);
    assert([...document.querySelector('dialog [name="status"]').options].every(option=>!option.disabled),'All status choices must be available for a future task');
    fixture.input('status','done');document.querySelector('dialog form').requestSubmit();await pause();
    assert(task(futureEditorId).status==='done'&&!document.querySelector('dialog').open,'Future status dropdown must save completion');
    assert(!('date' in patches().at(-1).options.body)&&task(futureEditorId).date==='2026-09-23','Status-only edit must never change the fixed planned date');

    const editableId='stress-2-3';await openTask(editableId);const savedTitle=task(editableId).title;
    fixture.input('title','Unsent title retained before archiving');const count=patches().length;fixture.click('archive-task');await pause();
    assert(patches().length===count&&task(editableId).title===savedTitle&&task(editableId).status!=='archived','Dirty archive must not silently discard or submit edits');
    assert(document.querySelector('dialog [name="title"]').value==='Unsent title retained before archiving'&&document.querySelector('.dp-form-message').textContent.includes('Save your edits'),'Archive must explain how to keep the unsaved draft');
    document.querySelector('dialog form').requestSubmit();await pause();await openTask(editableId);fixture.click('archive-task');await pause();
    assert(task(editableId).status==='archived'&&!document.querySelector('.dp-task[data-task="'+editableId+'"]'),'Saved task should archive without deleting its record');
    fixture.click('task-browser');fixture.input('taskQuery','');fixture.input('taskStatusFilter','archived');
    assert([...document.querySelectorAll('[data-task-results] .dp-task-result-open')].every(node=>task(node.dataset.id).status==='archived'),'Archived filter must exclude active tasks');
    fixture.input('taskQuery',task(editableId).key);fixture.select('[data-task-results] [data-id="'+editableId+'"]');await pause();
    fixture.click('restore-task');await pause();assert(task(editableId).status==='todo','Find task → Archived must restore the saved task');fixture.click('close-dialog');

    const concurrentId='stress-2-5';await openTask(concurrentId);fixture.input('notes','Unsaved notes across external archive and restore');
    task(concurrentId).status='archived';fixture.state.revision++;await fixture.planner.refresh();await pause();
    assert(document.querySelector('[data-planner-action="restore-task"]')&&!document.querySelector('[data-planner-action="archive-task"]'),'External archive must swap editor actions');
    assert(['title','notes','date','status'].every(name=>document.querySelector('dialog [name="'+name+'"]').disabled),'External archive must make existing editor readonly');
    assert(document.querySelector('dialog [name="notes"]').value==='Unsaved notes across external archive and restore','External archive must not erase unsaved notes');
    task(concurrentId).status='todo';fixture.state.revision++;await fixture.planner.refresh();await pause();
    assert(document.querySelector('[data-planner-action="archive-task"]')&&!document.querySelector('[data-planner-action="restore-task"]'),'External restore must swap editor actions back');
    assert(['title','notes','status'].every(name=>!document.querySelector('dialog [name="'+name+'"]').disabled),'External restore must re-enable task details');assert(document.querySelector('dialog [name="date"]').disabled,'External restore must leave the planned date fixed');
    assert(document.querySelector('dialog [name="notes"]').value==='Unsaved notes across external archive and restore','External restore must retain the unsaved draft');
    task(concurrentId).status='archived';fixture.state.revision++;await fixture.planner.refresh();await pause();fixture.click('restore-task');await pause();
    assert(document.querySelector('dialog').open&&!document.querySelector('dialog [name="notes"]').disabled,'Restoring through the editor must preserve and unlock it');
    assert(document.querySelector('dialog [name="notes"]').value==='Unsaved notes across external archive and restore'&&task(concurrentId).notes!=='Unsaved notes across external archive and restore','Restore must retain unsaved notes without implicitly submitting them');
    document.querySelector('dialog form').requestSubmit();await pause();assert(task(concurrentId).notes==='Unsaved notes across external archive and restore','Saving after restore must persist the retained draft');
    fixture.state.tasks.push({id:'weekend-completion',key:'TASK-9000',title:'Saturday completion stays visible',notes:'',status:'done',date:'2026-09-26'},{id:'weekend-archive',key:'TASK-9001',title:'Sunday archive remains searchable',notes:'',status:'archived',date:'2026-09-27'});
    fixture.state.revision++;await fixture.planner.refresh();await pause();
    const saturday=document.querySelector('.dp-day[data-date="2026-09-26"]');
    assert(document.querySelectorAll('.dp-day').length===6&&saturday,'An explicit weekend completion must remain visible');
    assert(document.querySelector('.dp-week-grid').style.getPropertyValue('--dp-day-count')==='6','Grid tracks must match the visible weekend column');
    assert(!saturday.querySelector('[data-planner-action="day-off"]')&&saturday.querySelector('[data-planner-action="new-task"]').disabled,'Weekend visibility must not enable scheduling or day-off editing');
    assert(!document.querySelector('.dp-day[data-date="2026-09-27"]'),'An archived weekend task must not add a spurious column');
    assert(fixture.completedFocusFallbackPassed,'When the completed task leaves the bounded first page, focus must stay on its day scroller');
    fixture.planner.close();
  })()`);
  // Fixed planned dates and durable timing facts, including archived misses and
  // early/on-time/late completions, are rendered from synthetic API snapshots.
  await run(`(async()=>{
    fixture.clockNow=Date.parse('2026-09-25T06:30:00Z');
    const task=(id,date,status,completedDate)=>({id:'timing-'+id,key:'TASK-T-'+id,title:({ontime:'Completed on its planned day',late:'Completed two days after planning',verylate:'Completed three days after planning',overdue:'Still open two days later',veryoverdue:'Still open four days later',lateone:'Completed one day after planning',pending:'Planned today',archived:'Archived without finishing that day'})[id],notes:'A fixed-date task keeps its place and previous outcome.',date,originalDate:date,status,...(completedDate?{completedAt:completedDate+'T06:00:00Z'}:{})});
    const tasks=[task('ontime','2026-09-21','done','2026-09-21'),task('verylate','2026-09-21','done','2026-09-24'),task('veryoverdue','2026-09-21','todo'),task('archived','2026-09-21','archived'),task('late','2026-09-22','done','2026-09-24'),task('overdue','2026-09-23','todo'),task('lateone','2026-09-24','done','2026-09-25'),task('pending','2026-09-25','todo')];
    fixture.state={...fixture.state,revision:fixture.state.revision+1,today:'2026-09-25',tasks,events:[],links:[],daysOff:[],sprints:[],taskTimings:{},missedByDate:{}};
    await fixture.planner.open();
    fixture.timingGeometry=()=>{
      const bounds=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
      return {width:innerWidth,height:innerHeight,bodyOverflow:document.body.scrollWidth>innerWidth+1,rootOverflow:document.querySelector('#planner').scrollWidth>document.querySelector('#planner').clientWidth+1,
        cards:[...document.querySelectorAll('.dp-task')].map(card=>({id:card.dataset.task,timing:card.dataset.timing,text:card.querySelector('.dp-task-timing')?.textContent,bounds:bounds(card),overflow:card.scrollWidth>card.clientWidth+1,background:getComputedStyle(card).backgroundColor,border:getComputedStyle(card).borderLeftColor,badgeColor:card.querySelector('.dp-task-timing')?getComputedStyle(card.querySelector('.dp-task-timing')).color:''})),
        days:[...document.querySelectorAll('.dp-day')].map(day=>({date:day.dataset.date,missed:day.querySelector('.dp-day-missed')?.textContent||'',className:day.className,bounds:bounds(day),badge:day.querySelector('.dp-day-missed')?bounds(day.querySelector('.dp-day-missed')):null}))};
    };
  })()`);
  const timingLayouts=[];
  for(const width of [360,720,1400])for(const theme of ['dark','light'])for(const font of ['system','comic-sans'])for(const zoom of [1,1.22]){
    window.setContentSize(width,900);window.webContents.setZoomFactor(zoom);await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};document.querySelector('.dp-week-grid').scrollLeft=0;undefined;`);await settle();
    const layout=await run('fixture.timingGeometry()'),scenario=JSON.stringify({width,theme,font,zoom});
    assert.ok(!layout.bodyOverflow&&!layout.rootOverflow,'Fixed-date badges caused page overflow '+scenario);
    const byId=Object.fromEntries(layout.cards.map(card=>[card.id,card]));
    for(const[id,timing]of Object.entries({ontime:'on-time',late:'late',verylate:'very-late',overdue:'overdue',veryoverdue:'very-overdue',lateone:'late',pending:'pending'})){
      assert.equal(byId['timing-'+id]?.timing,timing,'Wrong timing state '+id+' '+scenario);assert.ok(!byId['timing-'+id].overflow,'Timing card horizontal overflow '+scenario);
    }
    assert.ok(byId['timing-ontime'].text&&byId['timing-late'].text&&byId['timing-verylate'].text,'Timing outcomes must also be communicated as text, not color only');
    assert.notEqual(byId['timing-ontime'].badgeColor,byId['timing-late'].badgeColor,'On-time and late colors must be distinguishable');
    assert.notEqual(byId['timing-late'].badgeColor,byId['timing-verylate'].badgeColor,'Yellow late and brown very-late colors must be distinguishable');
    assert.equal(layout.cards.length,7,'Archived task must stay out of active cards');
    const monday=layout.days.find(day=>day.date==='2026-09-21');assert.match(monday.missed,/3.*not completed that day/,'Monday must retain the archived and late misses');assert.match(monday.className,/has-missed-tasks/);
    for(const day of layout.days)if(day.badge)assert.ok(day.badge.left>=day.bounds.left-1&&day.badge.right<=day.bounds.right+1,'Permanent missed count clipped '+scenario);
    if(font==='comic-sans'&&zoom===1&&((width===1400&&theme==='dark')||(width===360&&theme==='light'))){await new Promise(resolve=>setTimeout(resolve,60));await fs.writeFile(path.join(temporary,'fixed-planned-days-'+width+'-'+theme+'.png'),(await window.webContents.capturePage()).toPNG());}
    timingLayouts.push({width,theme,font,zoom,fixedDates:true,missedCountsVisible:true});
  }
  window.setContentSize(1400,900);window.webContents.setZoomFactor(1);await settle();
  await run(`(async()=>{
    const assert=fixture.assert,pause=fixture.pause,task=()=>fixture.state.tasks.find(task=>task.id==='timing-veryoverdue');
    const monday=()=>document.querySelector('.dp-day[data-date="2026-09-21"]'),missed=()=>monday().querySelector('.dp-day-missed').textContent;
    const permanentMisses=missed(),firstDate=task().date;
    fixture.select('[data-planner-action="complete"][data-id="timing-veryoverdue"]');await pause();
    assert(task().date===firstDate&&task().completedAt.startsWith('2026-09-25'),'Late completion must preserve the original planned date');
    assert(monday().querySelector('[data-task="timing-veryoverdue"][data-timing="very-late"]'),'Completed late task must remain in its original column with brown timing');
    assert(missed()===permanentMisses,'Completing late must not erase the original missed-day count');
    fixture.select('[data-planner-action="edit-task"][data-id="timing-veryoverdue"]');assert(document.querySelector('dialog [name="date"]').disabled,'Existing planned date must be non-editable');
    fixture.click('archive-task');await pause();assert(task().status==='archived'&&missed()===permanentMisses,'Archiving must preserve the original missed-day count');
    fixture.click('task-browser');fixture.input('taskStatusFilter','archived');fixture.input('taskQuery',task().key);fixture.select('[data-task-results] [data-id="timing-veryoverdue"]');fixture.click('restore-task');await pause();
    assert(task().status==='todo'&&task().date===firstDate&&missed()===permanentMisses,'Restore must keep original day and the permanent missed count');
    assert(document.querySelector('dialog [name="date"]').disabled,'Restore must keep planned date locked');fixture.input('notes','Edited after restoring on the original planned date');document.querySelector('dialog form').requestSubmit();await pause();
    assert(task().notes==='Edited after restoring on the original planned date'&&task().date===firstDate,'Editing restored notes must not move the task');
    assert(monday().querySelector('[data-task="timing-veryoverdue"][data-timing="very-overdue"]'),'Reopened overdue task must use elapsed-time state, not completed styling');
    assert(!document.querySelector('[data-planner-action="move"]')&&!document.querySelector('.dp-task').textContent.includes('Carried over'),'Fixed-date cards must not suggest carry-forward or Next day');
    fixture.planner.close();
  })()`);
  const rolloverResults=await run(`(async()=>{
    const assert=fixture.assert,pause=fixture.pause,plannedDate='2026-09-25';
    fixture.state={...fixture.state,revision:fixture.state.revision+1,today:'2026-09-26',tasks:[{id:'rollover-friday',key:'TASK-ROLLOVER',title:'Friday work remains on Friday',notes:'',date:plannedDate,originalDate:plannedDate,status:'todo'}],events:[{taskId:'rollover-friday',kind:'missed-planned-day',date:'2026-09-26'}],links:[],daysOff:[],sprints:[],taskTimings:{'rollover-friday':{plannedDate,completedDate:null,latenessDays:null,timingStatus:'overdue',missedPlannedDay:true}},missedByDate:{[plannedDate]:1}};
    const revision=fixture.state.revision;await fixture.planner.open();
    const card=()=>document.querySelector('[data-task="rollover-friday"]'),missed=()=>document.querySelector('.dp-day[data-date="'+plannedDate+'"] .dp-day-missed').textContent;
    const boardDates=[];
    for(const[today,days,tone]of [['2026-09-26',1,'overdue'],['2026-09-27',2,'overdue'],['2026-09-28',3,'very-overdue']]){
      fixture.state.today=today;await fixture.planner.refresh();await pause();
      assert(fixture.planner.snapshot().revision===revision,'Daily aging must not need a new data revision');
      assert(card()?.dataset.timing===tone,'Wrong age color after same-revision day rollover '+today);
      assert(card().querySelector('.dp-task-timing').textContent.includes(days+(days===1?' day overdue':' days overdue')),'Overdue age did not advance on '+today);
      assert(card().closest('.dp-day').dataset.date===plannedDate&&missed()==='1 not completed that day','Rollover must preserve the original planned day and permanent missed count');
      boardDates.push(today);
    }
    // A fresh view starts on Saturday and keeps performance open while dates
    // advance; no manual Refresh action or view switch invalidates the cache.
    fixture.planner.destroy();const root=document.querySelector('#planner');root.replaceWith(root.cloneNode(false));fixture.state.today='2026-09-26';fixture.planner=fixture.createPlanner();await fixture.planner.open();
    const reportFor=today=>({summary:{planned:1,worked:0,completed:0,missedPlannedDay:1},daily:[{date:plannedDate,summary:{planned:1,completed:0,missedPlannedDay:1},tasks:[{taskId:'rollover-friday',key:'TASK-ROLLOVER',title:'Report as of '+today,plannedDate,completedDate:null,latenessDays:null,timingStatus:today==='2026-09-28'?'very-overdue':'overdue',missedPlannedDay:true,worked:false,completed:false}]}]});
    const reportDates=[];let releaseSaturday;
    fixture.reportHook=()=>{const today=fixture.state.today;reportDates.push(today);return today==='2026-09-26'?new Promise(resolve=>{releaseSaturday=()=>resolve(reportFor(today));}):reportFor(today);};
    fixture.click('view-performance');await pause();assert(reportDates.length===1&&reportDates[0]==='2026-09-26','Performance must start its Saturday request');
    fixture.state.today='2026-09-27';await fixture.planner.refresh();await pause();
    assert(reportDates.length===2&&reportDates[1]==='2026-09-27','A new calendar day must refetch Performance without a revision change');
    assert(document.querySelector('.dp-performance').textContent.includes('Report as of 2026-09-27'),'Sunday report was not displayed');
    releaseSaturday();await pause();assert(document.querySelector('.dp-performance').textContent.includes('Report as of 2026-09-27')&&!document.querySelector('.dp-performance').textContent.includes('Report as of 2026-09-26'),'A delayed previous-day report must never replace the current report');
    fixture.state.today='2026-09-28';await fixture.planner.refresh();await pause();
    assert(reportDates.length===3&&reportDates[2]==='2026-09-28'&&document.querySelector('.dp-performance').textContent.includes('Report as of 2026-09-28'),'Monday must invalidate the same-revision Performance cache too');
    assert(fixture.planner.snapshot().revision===revision&&fixture.state.missedByDate[plannedDate]===1,'Performance refresh must not alter revision or durable missed counts');
    fixture.reportHook=null;fixture.planner.close();return{boardDates,reportDates,stalePreviousDayIgnored:true};
  })()`);
  await run(`(async()=>{
    const pause=()=>new Promise(r=>setTimeout(r,30));
    const assert=(ok,message)=>{if(!ok)throw new Error(message);};
    fixture.state.tasks.push({id:'delete-target',key:'TASK-DELETE',title:'Deletion target',notes:'Notes',status:'archived',date:'2026-09-28'});
    fixture.state.events.push({taskId:'delete-target',kind:'created',date:'2026-09-28'});
    fixture.state.revision++;await fixture.planner.open();fixture.click('task-browser');
    fixture.input('taskQuery','Deletion target');document.querySelector('[data-task-results] [data-id="delete-target"]').click();
    window.confirm=message=>{fixture.confirmation=message;return false;};
    const writes=fixture.calls.filter(c=>c.options.method==='DELETE').length;fixture.click('delete-task');await pause();
    assert(fixture.state.tasks.some(t=>t.id==='delete-target')&&fixture.calls.filter(c=>c.options.method==='DELETE').length===writes,'Cancel must never delete');
    assert(fixture.confirmation.includes('TASK-DELETE')&&fixture.confirmation.includes('Deletion target')&&fixture.confirmation.includes('cannot be undone'),'Confirmation must identify task and irreversible scope');
    window.confirm=()=>true;fixture.conflictNext=true;fixture.click('delete-task');await pause();
    assert(fixture.state.tasks.some(t=>t.id==='delete-target')&&document.querySelector('dialog').open,'Conflict must preserve task and editor');
    fixture.click('refresh');await pause();fixture.click('delete-task');await pause();
    assert(!fixture.state.tasks.some(t=>t.id==='delete-target')&&!fixture.state.events.some(e=>e.taskId==='delete-target')&&!document.querySelector('dialog').open,'Successful deletion must close editor and remove evidence');
  })()`);
  const featureResults=await run("({timeInteractionsPassed:fixture.timeInteractionsPassed,linkInteractionsPassed:fixture.linkInteractionsPassed})");
  await fs.writeFile(path.join(temporary, "results.json"), JSON.stringify({ layouts, linkLayouts, stressLayouts, timingLayouts, rolloverResults, fixedDateInteractionsPassed:true, stressInteractionsPassed:true, ...featureResults, interactionsPassed: true, unexpectedNetwork, backendCalls }, null, 2));
  finish(0);
}).catch(error => { console.error(error); finish(1); });
