// The real Services header and stopping functions run against synthetic,
// deferred API responses. This never opens Argus or stops a real process.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-stop-services-ui-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, unexpectedNetworkCount = 0;
const timer = setTimeout(() => { console.error("Stop services fixture timed out"); app.exit(1); }, 45_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
function sourceFunction(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Missing application function: ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

app.whenReady().then(async () => {
  const sourceShell = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const stylesheets = [...sourceShell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = sourceShell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style>`);
  const isolated = session.fromPartition("stop-services-regression", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { unexpectedNetworkCount++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  const source = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  assert.match(source, /\$\("#stop-all-services"\)\.addEventListener\("click", stopAllServices\)/, "The visible Stop all control must invoke the tested handler");
  const functions = ["activeServiceProcesses", "setServicesStopStatus", "setTextIfChanged", "syncStopAllServicesControl", "stopAllServices", "acceptServiceProcesses", "syncServicePendingControls", "withServiceOperation"].map(name => sourceFunction(source, name)).join("\n");
  await window.webContents.executeJavaScript(`
    const $=selector=>document.querySelector(selector), $$=selector=>[...document.querySelectorAll(selector)];
    const fixture=window.fixture={calls:[],pending:[],messages:[],renders:0,ideSyncs:0};
    let state, serviceProcessRevision=0;
    const serviceOperations=new Map(), projectSyncLifecycle={observe(){}}, syncIdeRunControls=()=>{fixture.ideSyncs++;};
    const toast=(message,type)=>fixture.messages.push({message,type});
    const renderServices=()=>{fixture.renders++;syncServicePendingControls();};
    const acceptServiceProcess=()=>{throw new Error('Bulk stop must accept one authoritative snapshot');};
    const api=(route,options={})=>{
      if(!['/api/processes/stop-services','/api/processes'].includes(route)) throw new Error('Unexpected synthetic API: '+route);
      fixture.calls.push({route,method:options.method||'GET',timeout:options.timeout});
      return new Promise((resolve,reject)=>fixture.pending.push({route,resolve,reject}));
    };
    ${functions}
    fixture.processes=[
      {id:'api-process',configurationId:'api',name:'Review API',status:'running',running:true},
      {id:'ui-process',configurationId:'ui',name:'Customer UI',status:'starting',running:false},
      {id:'installation',configurationId:'new',name:'Fresh service',status:'installing',running:false},
      {id:'sync-process',configurationId:'sync',name:'Project sync',status:'syncing',running:true,task:'sync'},
      {id:'test-process',configurationId:'test',name:'Unit tests',status:'testing',running:true,task:'test'},
      {id:'stopping-test',configurationId:'test',name:'Unit tests',status:'stopping',running:true,task:'test'},
      {id:'unmanaged',name:'Unmanaged',status:'running',running:true},
      {id:'stopped',configurationId:'old',name:'Stopped service',status:'stopped',running:false}
    ];
    fixture.reset=(options={})=>{
      if(fixture.pending.length) throw new Error('Unsettled synthetic request before reset');
      fixture.calls=[]; fixture.messages=[]; serviceOperations.clear(); serviceProcessRevision=0;
      state={workspace:{repositories:[{id:'repo-api',name:'API'},{id:'repo-ui',name:'UI'}],runConfigurations:[{id:'api',repositoryId:'repo-api'},{id:'ui',repositoryId:'repo-ui'},{id:'new',repositoryId:'repo-ui'}]},processes:options.empty?[]:structuredClone(fixture.processes),serviceProcessSignature:options.unknown?undefined:'known',currentView:'services',stoppingAllServices:null};
      $('#services-stop-status').textContent='';$('#services-stop-status').hidden=true;
      $('#service-list').innerHTML='<article class="service-card"><h3>Synthetic API</h3><div class="service-actions"><button data-service-action="stop" data-config-id="api">Stop running</button><button data-configure-service="api">Configure</button></div></article>';
      syncServicePendingControls();
    };
    fixture.snapshot=()=>({calls:fixture.calls,label:$('[data-stop-all-label]').textContent,count:$('[data-stop-all-count]').textContent,disabled:$('#stop-all-services').disabled,busy:$('#stop-all-services').getAttribute('aria-busy'),accessibleLabel:$('#stop-all-services').getAttribute('aria-label'),status:$('[role="status"]#services-stop-status').textContent,statusHidden:$('#services-stop-status').hidden,statusState:$('#services-stop-status').dataset.state,locks:[...serviceOperations.keys()],stopping:Boolean(state.stoppingAllServices),active:activeServiceProcesses().map(p=>p.id),processes:state.processes,cardLocked:$('[data-config-id="api"]').disabled,messages:fixture.messages});
    fixture.begin=()=>{fixture.operation=stopAllServices();return fixture.snapshot();};
    fixture.reply=async(route,result,error)=>{const request=fixture.pending.find(item=>item.route===route);if(!request)throw new Error('No pending '+route);fixture.pending.splice(fixture.pending.indexOf(request),1);error?request.reject(new Error(error)):request.resolve(result);await Promise.resolve();await Promise.resolve();return fixture.snapshot();};
    fixture.complete=async()=>{await fixture.operation;return fixture.snapshot();};
    fixture.frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    fixture.prepare=async({theme,font,busy})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.fontFamily=font;fixture.reset();if(busy)state.stoppingAllServices={};syncStopAllServicesControl();await document.fonts.ready;await fixture.frames();};
    fixture.geometry=()=>{
      const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const bounds=selector=>{const node=$(selector),style=getComputedStyle(node);return{...rect(node),fontSize:parseFloat(style.fontSize),visible:node.checkVisibility()};};
      return{width:innerWidth,header:bounds('#services-drawer > header'),heading:bounds('#services-drawer > header > div:first-child'),actions:bounds('.service-header-actions'),stop:bounds('#stop-all-services'),label:bounds('[data-stop-all-label]'),count:bounds('[data-stop-all-count]'),refresh:bounds('#refresh-services'),icon:bounds('#stop-all-services svg'),overflow:$('#services-drawer').scrollWidth>$('#services-drawer').clientWidth+1};
    };
    document.body.dataset.view='services';document.body.classList.add('workspace-tool-active');
    $('#empty-state').classList.add('hidden');$('#workspace').classList.add('hidden');$('#services-drawer').classList.remove('hidden');$('#services-context').textContent='All services';
    fixture.reset();void 0;
  `);
  const result={ok:true,layoutScenarios:0,behaviorScenarios:0};
  for(const width of [1440,760,380])for(const zoom of [1,1.5]){
    window.setContentSize(width,900);window.webContents.setZoomFactor(zoom);
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let frame;const timeout=setTimeout(()=>{cancelAnimationFrame(frame);reject(new Error('Viewport did not settle'));},3000);const check=()=>{if(Math.abs(innerWidth-${width/zoom})<=1){clearTimeout(timeout);resolve()}else frame=requestAnimationFrame(check)};frame=requestAnimationFrame(check)})`);
    for(const theme of ['dark','light'])for(const font of ['system','comic-sans'])for(const busy of [false,true]){
      const scenario={width,zoom,theme,font,busy},g=await window.webContents.executeJavaScript(`(async()=>{await fixture.prepare(${JSON.stringify(scenario)});return fixture.geometry()})()`),diagnostic=JSON.stringify({scenario,...g});
      assert.equal(g.overflow,false,diagnostic);assert.equal(g.stop.visible,true,diagnostic);
      assert.ok(g.stop.height>=30&&g.stop.height<=36&&g.stop.width<=165,`Stop all is not compact: ${diagnostic}`);
      assert.ok(g.stop.fontSize>=11&&g.stop.fontSize<=13,diagnostic);
      for(const control of [g.stop,g.refresh])assert.ok(control.left>=g.header.left-1&&control.right<=g.header.right+1&&control.top>=g.header.top-1&&control.bottom<=g.header.bottom+1&&control.right<=g.width+1,`Header control escapes: ${diagnostic}`);
      assert.ok(g.stop.right<=g.refresh.left+1&&Math.abs((g.stop.top+g.stop.bottom-g.refresh.top-g.refresh.bottom)/2)<=1,`Stop and Refresh are misaligned: ${diagnostic}`);
      for(const child of [g.label,g.count,g.icon])assert.ok(child.left>=g.stop.left&&child.right<=g.stop.right&&child.top>=g.stop.top&&child.bottom<=g.stop.bottom,`Stop contents are clipped: ${diagnostic}`);
      assert.ok(g.heading.right<=g.actions.left+1||g.heading.bottom<=g.actions.top+1,`Heading and actions overlap: ${diagnostic}`);
      result.layoutScenarios++;
      if(process.env.ARGUS_STOP_SERVICES_CAPTURE==='1'&&zoom===1&&font==='comic-sans'&&!busy&&[1440,380].includes(width)){
        await new Promise(resolve=>setTimeout(resolve,80));await fs.writeFile(path.join(temporary,`stop-services-${width}-${theme}.png`),(await window.webContents.capturePage()).toPNG());
      }
    }
  }
  // Behavioral assertions are below the geometry pass so fixture failures
  // identify a layout problem independently from process-state reconciliation.
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const reset=options=>evaluate(`fixture.reset(${JSON.stringify(options||{})});fixture.snapshot()`);
  const reply=(result,error)=>evaluate(`fixture.reply('/api/processes/stop-services',${JSON.stringify(result)},${JSON.stringify(error)})`);
  const complete=()=>evaluate('fixture.complete()');
  let snapshot=await reset();
  assert.deepEqual(snapshot.active,['api-process','ui-process','installation']);assert.equal(snapshot.count,'3');assert.equal(snapshot.disabled,false);assert.match(snapshot.accessibleLabel,/3/);
  assert.equal(await evaluate(`$('#services-stop-status').getAttribute('aria-live')`),'polite');
  result.behaviorScenarios++;
  for(const options of [{unknown:true},{empty:true},{existingOperation:true}]){
    await reset(options);
    if(options.existingOperation)await evaluate(`serviceOperations.set('unrelated-operation',{mode:'sync'});syncServicePendingControls();`);
    assert.equal((await evaluate('fixture.snapshot()')).disabled,true);
    await evaluate('stopAllServices()');snapshot=await evaluate('fixture.snapshot()');assert.equal(snapshot.calls.length,0);
    result.behaviorScenarios++;
  }
  await reset();snapshot=await evaluate('fixture.begin()');
  assert.equal(snapshot.stopping,true);assert.equal(snapshot.busy,'true');assert.equal(snapshot.label,'Stopping…');assert.equal(snapshot.cardLocked,true);assert.equal(snapshot.count,'3');
  assert.deepEqual(snapshot.locks.slice().sort(),['api','new','repository:repo-api','repository:repo-ui','ui']);
  await evaluate(`stopAllServices();withServiceOperation('new-configuration','start',()=>{throw new Error('A parallel start escaped the bulk-stop lock')});`);
  assert.equal((await evaluate('fixture.snapshot()')).calls.length,1);
  const originals=await evaluate('structuredClone(fixture.processes)'),targeted=originals.filter(item=>['api-process','ui-process','installation'].includes(item.id));
  const stopped=originals.map(item=>targeted.some(target=>target.id===item.id)?{...item,status:'stopped',running:false}:item);
  const response={targeted,stopped:targeted.map(item=>item.id),failures:[],processes:stopped};
  await reply(response);snapshot=await complete();
  assert.equal(snapshot.label,'Stop all');assert.equal(snapshot.count,'0');assert.equal(snapshot.disabled,true);assert.equal(snapshot.busy,'false');assert.equal(snapshot.stopping,false);assert.equal(snapshot.cardLocked,false);assert.deepEqual(snapshot.locks,[]);assert.match(snapshot.status,/Stopped 3 services/);assert.deepEqual(snapshot.calls,[{route:'/api/processes/stop-services',method:'POST',timeout:60000}]);
  assert.deepEqual(snapshot.processes.filter(item=>item.task),originals.filter(item=>item.task));
  result.behaviorScenarios++;
  await reset();await evaluate('fixture.begin()');
  await reply({...response,stopped:['ui-process','installation'],failures:[{id:'api-process',name:'<img src=x onerror=alert(1)>',message:'Permission denied'}],processes:stopped.map(item=>item.id==='api-process'?originals[0]:item)});snapshot=await complete();
  assert.equal(snapshot.count,'1');assert.equal(snapshot.disabled,false);assert.equal(snapshot.statusState,'error');assert.match(snapshot.status,/Stopped 2 of 3 services/);assert.match(snapshot.status,/<img src=x onerror=alert\(1\)>: Permission denied/);assert.equal(await evaluate(`$('#services-stop-status').querySelector('img')`),null);
  result.behaviorScenarios++;
  await reset();await evaluate('fixture.begin()');await reply(null,'Reply lost');
  snapshot=await evaluate(`fixture.reply('/api/processes',${JSON.stringify(stopped)})`);snapshot=await complete();
  assert.equal(snapshot.calls.filter(call=>call.method==='POST').length,1);assert.equal(snapshot.calls.filter(call=>call.method==='GET').length,1);assert.equal(snapshot.count,'0');assert.match(snapshot.status,/Could not confirm Stop all/);assert.match(snapshot.status,/status has been refreshed/);assert.equal(snapshot.stopping,false);assert.deepEqual(snapshot.locks,[]);
  result.behaviorScenarios++;
  await reset();await evaluate('fixture.begin()');await reply(null,'Disconnected');await evaluate(`fixture.reply('/api/processes',null,'Still disconnected')`);snapshot=await complete();
  assert.match(snapshot.status,/Could not refresh status either/);assert.equal(snapshot.stopping,false);assert.equal(snapshot.count,'3');assert.equal(snapshot.calls.filter(call=>call.method==='POST').length,1);assert.deepEqual(snapshot.locks,[]);
  result.behaviorScenarios++;
  await reset();await evaluate('fixture.begin()');await reply({processes:[]});await evaluate(`fixture.reply('/api/processes',${JSON.stringify(originals)})`);snapshot=await complete();
  assert.match(snapshot.status,/invalid stop result/);assert.equal(snapshot.calls.filter(call=>call.method==='POST').length,1);assert.equal(snapshot.stopping,false);
  result.behaviorScenarios++;
  await reset();await evaluate('fixture.begin()');await evaluate(`serviceOperations.set('ui',{mode:'new-operation'});`);
  await reply({...response,processes:[...stopped,{id:'replacement',configurationId:'ui',status:'running',running:true}]});snapshot=await complete();
  assert.deepEqual(snapshot.locks,['ui']);assert.equal(snapshot.stopping,false);assert.equal(snapshot.count,'1');assert.match(snapshot.status,/started separately and is still active/);assert.equal(snapshot.disabled,true);
  result.behaviorScenarios++;
  assert.equal(unexpectedNetworkCount,0);
  console.log('STOP_SERVICES_UI_RESULT='+JSON.stringify({...result,unexpectedNetworkCount}));finish(0);
}).catch(error=>{console.error(error.stack||error);finish(1);});
