// The production StructuredCanvas, nodes, edges and actual XYFlow engine run
// with native mouse/keyboard input in an isolated, network-blocked profile.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const temporary = process.argv[2], root = path.resolve(__dirname, '../..');
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-diagram-gestures-')) throw new Error('Isolated fixture directory required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0;
const timer = setTimeout(() => { console.error('Diagram gestures timed out'); app.exit(1); }, 50_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const directory = path.join(root, 'frontend/features/diagrams');
  const modules = {};
  for (const [name, file] of Object.entries({
    react:'react/cjs/react.production.js', 'react/jsx-runtime':'react/cjs/react-jsx-runtime.production.js',
    'react-dom':'react-dom/cjs/react-dom.production.js', 'react-dom/client':'react-dom/cjs/react-dom-client.production.js',
    scheduler:'scheduler/cjs/scheduler.production.js', '@xyflow/react':'@xyflow/react/dist/umd/index.js',
  })) modules[name] = await fs.readFile(path.join(root, 'node_modules', file), 'utf8');
  for (const file of (await fs.readdir(directory)).filter(file=>/\.(jsx|js|mjs)$/.test(file))) {
    const name = './' + file.replace(/\.(jsx|js)$/, '');
    let source = await fs.readFile(path.join(directory, file), 'utf8');
    // Test-only access; production never exposes or changes this component.
    modules[name] = ts.transpileModule(source, { compilerOptions:{ jsx:ts.JsxEmit.ReactJSX, module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true } }).outputText;
  }
  const catalog = await import(pathToFileURL(path.join(directory, 'diagram-catalog.mjs')));
  const icons = await import('simple-icons');
  modules['simple-icons'] = 'module.exports=' + JSON.stringify(Object.fromEntries(Object.keys(icons).filter(key => Object.values(catalog.COMPONENT_BRAND_ICONS).some(icon => icon === icons[key])).map(key => [key, icons[key]])));
  modules['next/dynamic'] = 'module.exports=()=>()=>null;';
  modules['./useDiagramDocument'] = 'exports.useDiagramDocument=()=>{throw new Error("Live store must not be used")};';
  modules['./useOwnerCanvasSharing'] = 'exports.useOwnerCanvasSharing=()=>{throw new Error("Live sharing must not be used")};';
  modules['./useDiagramCanvasScale'] = 'module.exports=()=>({});';
  modules['./DiagramStructurePicker'] = 'exports.__esModule=true;exports.default=()=>null;exports.StructureGlyph=()=>null;exports.STRUCTURE_DRAG_TYPE="application/x-argus-data-structure";';
  modules['./diagram-svg.mjs'] = 'module.exports={};';
  const styles = (await Promise.all(['diagram-studio.css', 'diagram-nodes.css', 'diagram-structures.css'].map(file => fs.readFile(path.join(directory, file), 'utf8')))).join('\n') + await fs.readFile(path.join(root, 'node_modules/@xyflow/react/dist/style.css'), 'utf8');
  const isolated = session.fromPartition('diagram-gestures-regression', { cache:false });
  isolated.setPermissionRequestHandler((_c,_p,callback) => callback(false));
  isolated.webRequest.onBeforeRequest({urls:['http://*/*', 'https://*/*']}, (_d, callback) => { networkRequests++; callback({cancel:true}); });
  window = new BrowserWindow({show:false,width:1200,height:850,webPreferences:{session:isolated,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.webContents.on('console-message', event => { if(event.level==='error') console.error(event.message); });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>:root{--text:#eceff4;--bg:#101319;--surface:#171b22;--surface-2:#212833;--surface-3:#28313e;--line:#303a48;--muted:#a0abba;--muted-2:#718099;--accent:#d5ff52;--blue:#83b6ff;--red:#ff6875}body{margin:0;font:12px system-ui;background:var(--bg)}#fixture{position:absolute;inset:0}${styles}</style></head><body><div id="fixture"></div></body></html>`;
  const fixtureHtml = path.join(temporary, 'gestures.html'); await fs.writeFile(fixtureHtml, html); await window.loadFile(fixtureHtml);
  await window.webContents.executeJavaScript(`{
    const sources={${Object.entries(modules).map(([name,source])=>`${JSON.stringify(name)}:function(require,module,exports){${source}\n}`).join(',')}}, cache={};
    window.fixtureRequire=function require(name){if(name.endsWith('.css'))return {};if(cache[name])return cache[name].exports;if(!sources[name])throw new Error('Unexpected fixture import '+name);const module={exports:{}};cache[name]=module;sources[name](require,module,module.exports);return module.exports;};
    const React=fixtureRequire('react'),{createRoot}=fixtureRequire('react-dom/client'),xy=fixtureRequire('@xyflow/react'),model=fixtureRequire('./diagram-model.mjs'),{StructuredCanvas}=fixtureRequire('./DiagramStudio');
    const Capture=()=>{window.testFlow=xy.useReactFlow();return null;};
    window.fixtureRoot=createRoot(document.querySelector('#fixture'));
    window.fixtureMount=({empty=false,kind='umlClass',viewport={x:20,y:20,zoom:1},snapshot=null}={})=>{
      const nodes=empty?[]:[{...model.makeNode(kind,{x:180,y:120},'array'),id:'a'},{...model.makeNode('umlClass',{x:580,y:120}),id:'b'}];
      if(nodes.length){nodes[0].data.name='FirstClass';nodes[1].data.name='SecondClass';}
      const board={id:crypto.randomUUID(),name:'Gesture fixture',snapshot:{structured:snapshot||{nodes,edges:[],viewport}}};
      window.fixtureSaved=null;window.fixtureSaves=[];window.fixtureErrors=[];
      fixtureRoot.render(React.createElement(xy.ReactFlowProvider,{key:board.id},React.createElement(Capture),React.createElement(StructuredCanvas,{document:board,visible:true,onChange:next=>{fixtureSaved=next;fixtureSaves.push(next);},onError:error=>fixtureErrors.push(error)})));
    };
    window.fixtureState=()=>({viewport:testFlow.getViewport(),nodes:testFlow.getNodes().map(node=>({id:node.id,position:node.position,selected:node.selected,data:node.data})),edges:testFlow.getEdges(),saved:fixtureSaved,errors:fixtureErrors});
    fixtureMount();
  }`);
  const run = code => window.webContents.executeJavaScript(code);
  const state = () => run('fixtureState()');
  const box = selector => run(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing '+${JSON.stringify(selector)});const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})()`);
  const equalViewport = (actual, expected, message) => { for (const key of ['x','y','zoom']) assert.ok(Math.abs(actual[key]-expected[key])<.01, message + ': ' + JSON.stringify({actual,expected})); };
  const drag = async (from, to, button='left', modifiers=[]) => {
    window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(from.x),y:Math.round(from.y)});
    window.webContents.sendInputEvent({type:'mouseDown',x:Math.round(from.x),y:Math.round(from.y),button,clickCount:1,modifiers});
    for(let index=1;index<=6;index++){window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(from.x+(to.x-from.x)*index/6),y:Math.round(from.y+(to.y-from.y)*index/6),button,modifiers:[...modifiers,button+'ButtonDown']});await pause(12);}
    window.webContents.sendInputEvent({type:'mouseUp',x:Math.round(to.x),y:Math.round(to.y),button,clickCount:1,modifiers});await pause();
  };
  const key = async (type, keyCode, modifiers=[]) => {window.webContents.sendInputEvent({type,keyCode,modifiers});await pause(40);};
  const mount = async options => {await run(`fixtureMount(${JSON.stringify(options)})`);await pause(250);};
  await pause(400); let scenarios=0;
  // All three mouse buttons pan blank canvas; zoom and nodes remain unchanged.
  for(const button of ['left','middle','right']) {
    const before=await state();await drag({x:80,y:650},{x:150,y:695},button);const after=await state();
    assert.ok(Math.abs(after.viewport.x-before.viewport.x-70)<2 && Math.abs(after.viewport.y-before.viewport.y-45)<2, button+' does not pan');
    assert.equal(after.viewport.zoom,before.viewport.zoom);assert.deepEqual(after.nodes.map(node=>node.position),before.nodes.map(node=>node.position));equalViewport(after.saved.viewport,after.viewport,'Pan was not persisted');scenarios++;
  }
  // Left dragging a node still moves the node, not the viewport.
  await mount({});let before=await state(),node=await box('[data-id="a"] .diagram-class-header');
  await drag({x:node.x+5,y:node.y+12},{x:node.x+69,y:node.y+60});let after=await state();
  equalViewport(after.viewport,before.viewport,'Node drag pans');assert.notDeepEqual(after.nodes[0].position,before.nodes[0].position);scenarios++;
  // Shift + left drag remains box selection, and Shift-click adds selection.
  await mount({});before=await state();node=await box('[data-id="a"]');
  await key('keyDown','Shift',['shift']);await drag({x:node.x-20,y:node.y-20},{x:node.right+20,y:node.bottom+20},'left',['shift']);await key('keyUp','Shift');after=await state();
  equalViewport(after.viewport,before.viewport,'Shift selection pans');assert.equal(after.nodes.filter(n=>n.selected).length,1);assert.equal(after.nodes.find(n=>n.selected).id,'a');scenarios++;
  const second=await box('[data-id="b"] .diagram-class-header');await key('keyDown','Shift',['shift']);await drag({x:second.x+5,y:second.y+12},{x:second.x+5,y:second.y+12},'left',['shift']);await key('keyUp','Shift');after=await state();
  assert.equal(after.nodes.filter(n=>n.selected).length,2,'Shift-click did not extend selection');scenarios++;
  // Inline text selection and editing are not canvas/node dragging.
  await mount({});before=await state();const input=await box('[data-id="a"] [aria-label="Class name"]');
  await drag({x:input.x+30,y:input.y+12},{x:input.x+110,y:input.y+12});after=await state();
  equalViewport(after.viewport,before.viewport,'Text selection pans');assert.deepEqual(after.nodes[0].position,before.nodes[0].position);
  await run('document.querySelector(\'[data-id="a"] [aria-label="Class name"]\').select()');await window.webContents.insertText('EditedClass');await pause();
  assert.equal((await state()).nodes[0].data.name,'EditedClass');scenarios++;
  // Holding Shift before entering an input must not let XYFlow capture its
  // pointer event for box selection. The inline editor must receive focus.
  await mount({});await drag({x:80,y:650},{x:80,y:650});before=await state();const shiftedInput=await box('[data-id="a"] [aria-label="Class name"]');
  await key('keyDown','Shift',['shift']);await drag({x:shiftedInput.x+100,y:shiftedInput.y+12},{x:shiftedInput.x+185,y:shiftedInput.y+12},'left',['shift']);await key('keyUp','Shift');after=await state();
  equalViewport(after.viewport,before.viewport,'Shift-text drag pans');assert.deepEqual(after.nodes.map(n=>({position:n.position,selected:n.selected})),before.nodes.map(n=>({position:n.position,selected:n.selected})));
  const textSelection=await run('(()=>{const input=document.querySelector(\'[data-id="a"] [aria-label="Class name"]\');return {focused:document.activeElement===input,start:input.selectionStart,end:input.selectionEnd,canvas:!!document.querySelector(".react-flow__selection")};})()');
  assert.ok(textSelection.focused&&!textSelection.canvas,'Shift-text drag was swallowed by canvas selection: '+JSON.stringify(textSelection));scenarios++;
  // Handles still create connections instead of dragging the viewport.
  await mount({});before=await state();const source=await box('[data-id="a"] [data-handleid="right"]'),target=await box('[data-id="b"] [data-handleid="left"]');
  await drag({x:source.x+source.width/2,y:source.y+source.height/2},{x:target.x+target.width/2,y:target.y+target.height/2});after=await state();
  equalViewport(after.viewport,before.viewport,'Connection drag pans');assert.equal(after.edges.length,1);assert.equal(after.edges[0].source,'a');assert.equal(after.edges[0].target,'b');scenarios++;
  // Edge-label editing is protected by the same capture-phase exclusion.
  await run('document.querySelector(\'[aria-label="Connection label"]\').focus()');await window.webContents.insertText('calls');await pause();before=await state();await drag({x:80,y:650},{x:80,y:650});const edgeInput=await box('[aria-label="Connection label"]');
  await key('keyDown','Shift',['shift']);await drag({x:edgeInput.x+8,y:edgeInput.y+edgeInput.height/2},{x:edgeInput.right-8,y:edgeInput.y+edgeInput.height/2},'left',['shift']);await key('keyUp','Shift');
  assert.equal(await run('document.activeElement.getAttribute("aria-label")'),'Connection label');equalViewport((await state()).viewport,before.viewport,'Shift edge text pans');assert.equal((await state()).edges[0].data.label,'calls');scenarios++;
  // Data-structure + controls and nested inline fields are also nokey-safe.
  await mount({kind:'dataStructure'});await drag({x:80,y:650},{x:80,y:650});before=await state();const add=await box('[data-id="a"] [aria-label="Add unit to FirstClass"]');
  await key('keyDown','Shift',['shift']);await drag({x:add.x+add.width/2,y:add.y+add.height/2},{x:add.x+add.width/2,y:add.y+add.height/2},'left',['shift']);await key('keyUp','Shift');after=await state();
  assert.equal(after.nodes[0].data.entries.length,1,'Shift-click could not add a unit');equalViewport(after.viewport,before.viewport,'Shift-add unit pans');
  await run('document.querySelector(\'[data-id="a"] [aria-label="Unit 1 value"]\').focus()');await window.webContents.insertText('value');await pause();await drag({x:80,y:650},{x:80,y:650});const valueInput=await box('[data-id="a"] [aria-label="Unit 1 value"]');
  await key('keyDown','Shift',['shift']);await drag({x:valueInput.x+8,y:valueInput.y+valueInput.height/2},{x:valueInput.right-8,y:valueInput.y+valueInput.height/2},'left',['shift']);await key('keyUp','Shift');
  assert.equal(await run('document.activeElement.getAttribute("aria-label")'),'Unit 1 value');equalViewport((await state()).viewport,before.viewport,'Shift structure text pans');scenarios++;
  // Existing wheel zoom stays available.
  before=await state();window.webContents.sendInputEvent({type:'mouseWheel',x:80,y:650,deltaY:100,deltaX:0,canScroll:true});await pause(300);after=await state();assert.notEqual(after.viewport.zoom,before.viewport.zoom);scenarios++;
  // Empty-board pan survives save/reopen and adding its first object.
  await mount({empty:true,viewport:{x:0,y:0,zoom:1}});await drag({x:80,y:650},{x:200,y:700});after=await state();
  assert.ok(after.saved,'An empty board never enabled viewport saves');equalViewport(after.saved.viewport,after.viewport,'Empty pan was not saved');const saved=after.saved;scenarios++;
  await mount({snapshot:saved});equalViewport((await state()).viewport,saved.viewport,'Reopen reset empty viewport');scenarios++;
  await run('document.querySelector(\'[aria-label="Component category"] button\').click()');await pause();await run('document.querySelector(\'#diagram-component-picker [data-popover-autofocus]\').click()');await pause(300);
  after=await state();assert.equal(after.nodes.length,1);equalViewport(after.viewport,saved.viewport,'First object reset panned viewport');scenarios++;
  assert.deepEqual(after.errors,[]);assert.equal(networkRequests,0);
  console.log('DIAGRAM_GESTURES_RESULT='+JSON.stringify({ok:true,scenarios,networkRequests}));finish(0);
}).catch(error=>{console.error(error.stack||error);finish(1);});
