// The actual StructuredCanvas and XYFlow receive native pointer/keyboard events.
// Only synthetic, disposable state: no installed application, backend or profile.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const temporary = process.argv[2], root = path.resolve(__dirname, '../..');
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-diagram-selection-')) throw new Error('Isolated fixture directory required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0, scenarios = 0, screenshots = 0;
const errors = [];
const timer = setTimeout(() => { console.error('Selection browser regression timed out'); app.exit(1); }, 70_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label) { for (let attempt = 0; attempt < 80; attempt++) { if (await fn()) return; await pause(40); } throw new Error('Timed out: ' + label); }

app.whenReady().then(async () => {
  const directory = path.join(root, 'frontend/features/diagrams'), modules = {};
  for (const [name, file] of Object.entries({
    react: 'react/cjs/react.production.js', 'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js',
    'react-dom': 'react-dom/cjs/react-dom.production.js', 'react-dom/client': 'react-dom/cjs/react-dom-client.production.js',
    scheduler: 'scheduler/cjs/scheduler.production.js', '@xyflow/react': '@xyflow/react/dist/umd/index.js',
  })) modules[name] = await fs.readFile(path.join(root, 'node_modules', file), 'utf8');
  for (const file of await fs.readdir(directory)) {
    if (!/\.(jsx|js|mjs)$/.test(file)) continue;
    modules['./' + file.replace(/\.(jsx|js)$/, '')] = ts.transpileModule(await fs.readFile(path.join(directory, file), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
  }
  const catalog = await import(pathToFileURL(path.join(directory, 'diagram-catalog.mjs'))), icons = await import('simple-icons');
  modules['simple-icons'] = 'module.exports=' + JSON.stringify(Object.fromEntries(Object.keys(icons).filter(key => Object.values(catalog.COMPONENT_BRAND_ICONS).includes(icons[key])).map(key => [key, icons[key]])));
  modules['./useDiagramDocument'] = 'exports.useDiagramDocument=()=>{throw new Error("Live store must not be used")};';
  modules['./useOwnerCanvasSharing'] = 'exports.useOwnerCanvasSharing=()=>{throw new Error("Live sharing must not be used")};';
  modules['./useDiagramCanvasScale'] = 'module.exports=()=>({});';
  modules['./eraser-icon-assets.mjs'] = 'exports.getCachedEraserIcon=()=>null;exports.isCachedEraserIconMonochrome=()=>false;exports.loadEraserIcon=async()=>null;exports.prefetchEraserIcons=async()=>({});exports.configureEraserIconAssets=()=>{};';
  modules['./DiagramStructurePicker'] = 'exports.__esModule=true;exports.default=()=>null;exports.StructureGlyph=()=>null;exports.STRUCTURE_DRAG_TYPE="application/x-argus-data-structure";';
  const styles = await fs.readFile(path.join(root, 'node_modules/@xyflow/react/dist/style.css'), 'utf8')
    + (await Promise.all(['diagram-studio.css', 'diagram-nodes.css', 'diagram-structures.css', 'diagram-groups.css', 'diagram-selection.css'].map(file => fs.readFile(path.join(directory, file), 'utf8')))).join('\n');
  const hostStyles = await fs.readFile(path.join(root, 'public/styles.css'), 'utf8');
  const themeStyles = await fs.readFile(path.join(root, 'canvas-web/src/styles.css'), 'utf8');
  const isolated = session.fromPartition('diagram-selection-regression', { cache: false });
  isolated.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${hostStyles}\n${themeStyles}body{margin:0;font:12px system-ui}#fixture{position:absolute;inset:0}${styles}</style></head><body><div id="fixture" class="diagram-studio"></div></body></html>`;
  const fixtureHtml = path.join(temporary, 'selection.html'); await fs.writeFile(fixtureHtml, html); await window.loadFile(fixtureHtml);
  const run = code => window.webContents.executeJavaScript(code);
  await run(`{
    const sources={${Object.entries(modules).map(([name, source]) => `${JSON.stringify(name)}:function(require,module,exports){${source}\n}`).join(',')}},cache={};
    window.fixtureRequire=function require(name){if(name.endsWith('.css'))return {};if(cache[name])return cache[name].exports;if(!sources[name])throw new Error('Unexpected fixture import '+name);const module={exports:{}};cache[name]=module;sources[name](require,module,module.exports);return module.exports;};
    const React=fixtureRequire('react'),{createRoot}=fixtureRequire('react-dom/client'),xy=fixtureRequire('@xyflow/react'),{StructuredCanvas}=fixtureRequire('./DiagramStudio');
    const Capture=()=>{window.testFlow=xy.useReactFlow();return null;};
    window.fixtureRoot=createRoot(document.querySelector('#fixture'));
    window.fixtureInitial=(framed=false)=>({nodes:[
      ...(framed?[{id:'frame',type:'group',position:{x:50,y:60},style:{width:580,height:290},data:{name:'Application',color:'#78a9ff',memberIds:['a','b']}}]:[]),
      ...[['a','API',{x:80,y:120},'service'],['b','Cache',{x:390,y:120},'redis'],['c','Worker',{x:790,y:120},'worker'],['d','Database',{x:790,y:430},'database']].map(([id,name,position,componentKey])=>({id,type:'component',position,style:{width:200,height:180},data:{name,componentKey,replicas:1,description:'Synthetic notes for '+name}}))
    ],edges:[['ab','a','b','right','left'],['bc','b','c','right','left'],['cd','c','d','bottom','top']].map(([id,source,target,sourceHandle,targetHandle])=>({id,type:'relation',source,target,sourceHandle,targetHandle,data:{label:'',relation:'dependency',curvature:.3}})),viewport:{x:10,y:10,zoom:1}});
    window.fixtureMount=({framed=false,readOnly=false,visible=true,snapshot=null}={})=>{
      const board={id:crypto.randomUUID(),name:'Synthetic selection regression',snapshot:{structured:snapshot||fixtureInitial(framed)}};
      window.fixtureSaved=null;window.fixtureSaves=[];window.fixtureErrors=[];
      fixtureRoot.render(React.createElement(xy.ReactFlowProvider,{key:board.id},React.createElement(Capture),React.createElement(StructuredCanvas,{document:board,visible,readOnly,onChange:next=>{fixtureSaved=next;fixtureSaves.push(next);},onError:error=>fixtureErrors.push(error)})));
    };
    window.fixtureState=()=>({nodes:testFlow.getNodes().map(node=>({id:node.id,type:node.type,position:node.position,data:node.data,selected:Boolean(node.selected)})),edges:testFlow.getEdges(),viewport:testFlow.getViewport(),saved:fixtureSaved,saves:fixtureSaves.length,errors:fixtureErrors,undo:!document.querySelector('[aria-label="Undo"]').disabled});
    fixtureMount();
  }`);
  const state = () => run('fixtureState()');
  const selected = value => value.nodes.filter(node => node.selected).map(node => node.id).sort();
  const selectedEdges = value => value.edges.filter(edge => edge.selected).map(edge => edge.id).sort();
  const rect = selector => run(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})()`);
  const mount = async (options = {}) => {
    await run(`fixtureMount(${JSON.stringify(options)})`);
    await poll(() => run('testFlow.getNodes().length>=4&&testFlow.getNodes().every(node=>node.measured?.width>0)'), 'XYFlow mounted');
    await pause(180);
  };
  const at = async (point, modifiers = []) => {
    const common = { x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1, modifiers };
    window.webContents.sendInputEvent({ ...common, type: 'mouseMove' });
    window.webContents.sendInputEvent({ ...common, type: 'mouseDown' });
    window.webContents.sendInputEvent({ ...common, type: 'mouseUp' }); await pause();
  };
  const click = async selector => {
    await run(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'})`);
    const r = await rect(selector); await at({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  };
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause();
  };
  const focusCanvas = () => run('document.querySelector(".diagram-structured").focus()');
  const drag = async (from, to, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x), y: Math.round(from.y), modifiers });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(from.x), y: Math.round(from.y), button: 'left', clickCount: 1, modifiers });
    for (let i = 1; i <= 6; i++) { window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * i / 6), y: Math.round(from.y + (to.y - from.y) * i / 6), button: 'left', modifiers: [...modifiers, 'leftButtonDown'] }); await pause(12); }
    window.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(to.x), y: Math.round(to.y), button: 'left', clickCount: 1, modifiers }); await pause();
  };
  const modified = async (keyCode, modifier, action) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [modifier] }); await pause(30);
    await action([modifier]);
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [] }); await pause(30);
  };
  const nodeClick = async (id, modifiers = []) => { const r = await rect(`[data-id="${id}"] .diagram-architecture-symbol`); await at({ x: r.x + 30, y: r.y + 30 }, modifiers); };
  const edgeClick = async (id, modifiers = []) => {
    const point = await run(`(()=>{const p=document.querySelector('.react-flow__edge[data-id="${id}"] .react-flow__edge-path'),q=p.getPointAtLength(p.getTotalLength()*.28),s=new DOMPoint(q.x,q.y).matrixTransform(p.getScreenCTM());return {x:s.x,y:s.y};})()`);
    await at(point, modifiers);
  };
  const unchanged = async (message, nodes = []) => {
    const result = await state(); assert.equal(result.saves, 0, message + ': saved selection'); assert.equal(result.undo, false, message + ': created undo entry');
    if (nodes.length) assert.deepEqual(selected(result), nodes, message); return result;
  };
  await mount();

  // Arrow editing exercises the actual renderer with native pointer input.
  await edgeClick('ab');
  await run(`(()=>{const select=document.querySelector('[aria-label="Selected connection route"]');select.value='elbow';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await poll(()=>run('fixtureSaved?.edges[0]?.data.routing === "elbow"'),'route selection');
  let arrowState=await state(),beforeArrowSaves=arrowState.saves;
  const bend=await rect('[aria-label="Connection bend 1"]');
  await drag({x:bend.x+bend.width/2,y:bend.y+bend.height/2},{x:bend.x+bend.width/2+60,y:bend.y+bend.height/2-65});
  arrowState=await state();assert.ok(arrowState.edges[0].data.waypoints.length);assert.equal(arrowState.saves,beforeArrowSaves+1,'one bend drag must save once');
  const bent=arrowState.saved, bentPoints=bent.edges[0].data.waypoints;
  await click('[aria-label="Undo"]');assert.equal((await state()).edges[0].data.waypoints,undefined,'bend is one undo operation');
  await click('[aria-label="Redo"]');assert.deepEqual((await state()).edges[0].data.waypoints,bentPoints);
  await mount({snapshot:bent});await edgeClick('ab');
  const grip=await rect('[aria-label="Move connection label"]'),labelBefore=(await state()).saves;
  await drag({x:grip.x+grip.width/2,y:grip.y+grip.height/2},{x:grip.x+grip.width/2+35,y:grip.y+grip.height/2+45});
  arrowState=await state();assert.equal(arrowState.saves,labelBefore+1);assert.ok(Math.abs(arrowState.edges[0].data.labelOffset.x-35)<2);assert.ok(Math.abs(arrowState.edges[0].data.labelOffset.y-45)<2);
  const routed=arrowState.saved;
  await run('testFlow.setViewport({x:80,y:40,zoom:.65})');await pause(180);
  const zoomBend=await rect('[aria-label="Connection bend 1"]'),zoomBefore=(await state()).edges[0].data.waypoints[0];
  await drag({x:zoomBend.x+zoomBend.width/2,y:zoomBend.y+zoomBend.height/2},{x:zoomBend.x+zoomBend.width/2+26,y:zoomBend.y+zoomBend.height/2});
  assert.ok(Math.abs((await state()).edges[0].data.waypoints[0].x-zoomBefore.x-40)<2,'bend drag must account for zoom');
  for(const theme of ['dark','light']){
    await mount({snapshot:routed});await edgeClick('ab');await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await pause(150);
    await fs.writeFile(path.join(temporary,`arrow-routing-${theme}.png`),(await window.webContents.capturePage()).toPNG());
  }
  await mount({snapshot:routed,readOnly:true});await edgeClick('ab');assert.equal(await run('document.querySelectorAll(".diagram-bend-handle,.diagram-label-drag").length'),0,'read-only viewer exposes no bend controls');
  await mount({snapshot:routed});await click('[aria-label="Expand all component notes"]');await edgeClick('ab');assert.equal(await run('document.querySelectorAll(".diagram-bend-handle,.diagram-label-drag").length'),0,'expanded notes never overwrite compact routes');

  // All objects and connections are one batch, including framed contents.
  await mount({ framed: true });
  const original = await state();
  await click('[aria-label="Select all"]');
  let result = await unchanged('Select all', ['a', 'b', 'c', 'd', 'frame']);
  assert.deepEqual(selectedEdges(result), ['ab', 'bc', 'cd']);
  await click('[aria-label="Delete selection"]'); result = await state();
  assert.equal(result.nodes.length, 0); assert.equal(result.edges.length, 0); assert.equal(result.saves, 1);
  assert.equal(await run('document.querySelector(\'[aria-label="Select all"]\').disabled'), true);
  await click('[aria-label="Undo"]'); result = await state();
  assert.deepEqual(result.nodes.map(n => n.id), original.nodes.map(n => n.id)); assert.deepEqual(result.edges.map(e => e.id), original.edges.map(e => e.id));
  assert.equal(result.saves, 2); assert.equal(result.undo, false, 'Selection created an extra undo entry'); scenarios++;

  // Both platform command keys select all without changing document/history.
  for (const modifier of ['meta', 'control']) {
    await mount(); await focusCanvas(); await key('A', [modifier]);
    await unchanged(modifier + '+A', ['a', 'b', 'c', 'd']);
    await key('Backspace'); assert.equal((await state()).nodes.length, 0);
    await key('Z', [modifier]); result = await state(); assert.equal(result.nodes.length, 4); assert.equal(result.saves, 2); assert.equal(result.undo, false); scenarios++;
  }

  // Touch only a corner: partial marquee selection must not require enclosure.
  await mount(); await click('[aria-label="Select mode"]');
  const beforeBox = await state(), a = await rect('[data-id="a"]');
  await drag({ x: a.x - 18, y: a.y - 18 }, { x: a.x + 18, y: a.y + 18 });
  result = await unchanged('Partial selection', ['a']); assert.deepEqual(result.viewport, beforeBox.viewport); scenarios++;
  await focusCanvas(); await key('Escape'); assert.deepEqual(selected(await unchanged('Escape')), []); scenarios++;

  // Shift-drag remains available in default Pan mode.
  await mount(); const panBefore = await state(), p = await rect('[data-id="a"]');
  await modified('Shift', 'shift', modifiers => drag({ x: p.x - 18, y: p.y - 18 }, { x: p.x + 18, y: p.y + 18 }, modifiers));
  result = await unchanged('Shift marquee', ['a']); assert.deepEqual(result.viewport, panBefore.viewport); scenarios++;

  for (const [keyCode, modifier] of [['Shift', 'shift'], ['Meta', 'meta'], ...(process.platform === 'darwin' ? [] : [['Control', 'control']])]) {
    await mount(); await nodeClick('a');
    await modified(keyCode, modifier, modifiers => nodeClick('b', modifiers));
    await unchanged(modifier + ' additive click', ['a', 'b']);
    await modified(keyCode, modifier, modifiers => nodeClick('a', modifiers));
    await unchanged(modifier + ' toggle click', ['b']); scenarios++;
  }
  if (process.platform === 'darwin') {
    // macOS consumes native Control-click as a context-menu gesture. Preserve
    // that OS behavior; separately exercise a delivered primary Ctrl-click.
    await mount(); await nodeClick('a');
    await modified('Control', 'control', modifiers => nodeClick('b', modifiers));
    await unchanged('Native macOS Control-click', ['a']);
    await modified('Control', 'control', () => run('document.querySelector(\'[data-id="b"] .diagram-architecture-symbol\').dispatchEvent(new MouseEvent("click",{bubbles:true,button:0,ctrlKey:true}))'));
    await unchanged('Delivered primary Ctrl-click', ['a', 'b']); scenarios++;
  }

  // Explicit unrelated edges join selected nodes; incident edges are removed.
  await mount({ framed: true }); await nodeClick('a');
  await modified('Shift', 'shift', modifiers => edgeClick('cd', modifiers));
  result = await unchanged('Mixed selection', ['a']); assert.deepEqual(selectedEdges(result), ['cd']);
  await focusCanvas(); await key('Delete'); result = await state();
  assert.deepEqual(result.nodes.map(n => n.id).sort(), ['b', 'c', 'd', 'frame']);
  assert.deepEqual(result.edges.map(e => e.id), ['bc']); assert.deepEqual(result.nodes.find(n => n.id === 'frame').data.memberIds, ['b']); assert.equal(result.saves, 1);
  await key('Z', ['meta']); result = await state(); assert.equal(result.nodes.length, 5); assert.equal(result.edges.length, 3); assert.deepEqual(result.nodes.find(n => n.id === 'frame').data.memberIds, ['a', 'b']); assert.equal(result.undo, false); scenarios++;

  await mount(); await edgeClick('cd'); await unchanged('Edge-only selection');
  assert.deepEqual(selectedEdges(await state()), ['cd']); await focusCanvas(); await key('Delete'); result = await state();
  assert.equal(result.nodes.length, 4); assert.deepEqual(result.edges.map(e => e.id), ['ab', 'bc']); assert.equal(result.saves, 1); scenarios++;

  // A frame does not imply deleting its unselected children.
  await mount({ framed: true });
  const frame = await rect('[data-id="frame"] .diagram-group-drag-mark'); await at({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
  await unchanged('Frame selection', ['frame']); await focusCanvas(); await key('Backspace'); result = await state();
  assert.deepEqual(result.nodes.map(n => n.id).sort(), ['a', 'b', 'c', 'd']); assert.equal(result.edges.length, 3); assert.equal(result.saves, 1); scenarios++;

  // Editing an actual name field must keep native text-selection/delete behavior.
  await mount(); await click('[aria-label="Select all"]');
  await run('(()=>{const input=document.querySelector(\'[data-id="a"] [aria-label="Component name"]\');window.fixtureInputKeys=[];input.addEventListener("keydown",event=>fixtureInputKeys.push({key:event.key,prevented:event.defaultPrevented}));input.focus();})()');
  await key('A', ['meta']); await key('Backspace'); result = await state();
  assert.equal(result.nodes.length, 4); assert.equal(result.edges.length, 3);
  assert.deepEqual(selected(result), ['a', 'b', 'c', 'd']);
  assert.deepEqual(await run('fixtureInputKeys.map(event=>event.prevented)'), [false, false], 'Canvas captured inline editor shortcuts');
  await run('document.querySelector(\'[data-id="a"] [aria-label="Component name"]\').select()');
  await window.webContents.insertText('Renamed API'); await pause();
  assert.equal((await state()).nodes.find(n => n.id === 'a').data.name, 'Renamed API'); scenarios++;

  // Portaled notes dialogs bubble through React but are outside canvas scope.
  await mount(); await nodeClick('a'); await click('[aria-label="Notes for Cache"]');
  await run('document.querySelector(\'[aria-label="Close component notes"]\').focus()');
  await key('A', ['meta']); await key('Backspace'); await unchanged('Portaled dialog', ['a']);
  await click('[aria-label="Close component notes"]'); scenarios++;

  // Another editor (e.g. Draw) and contenteditable inputs never inherit shortcuts.
  await mount();
  await run('(()=>{const editor=document.createElement("div");editor.id="other-editor";editor.contentEditable="true";editor.textContent="Other canvas text";document.body.append(editor);editor.focus();})()');
  await key('A', ['meta']); await key('Backspace'); assert.deepEqual(selected(await unchanged('External editor')), []);
  await run('document.querySelector("#other-editor").remove()');
  await run('(()=>{const editor=document.createElement("div");editor.id="inline-editor";editor.contentEditable="true";editor.textContent="Inline text";document.querySelector(".diagram-structured").append(editor);editor.focus();})()');
  await key('A', ['meta']); await key('Backspace'); assert.deepEqual(selected(await unchanged('Contenteditable editor')), []);
  await run('document.querySelector("#inline-editor").remove()'); scenarios++;

  for (const options of [{ readOnly: true }, { expanded: true }, { visible: false }]) {
    await mount({ readOnly: Boolean(options.readOnly), visible: options.visible !== false });
    if (options.expanded) await click('[aria-label="Expand all component notes"]');
    await focusCanvas(); await key('A', ['meta']);
    if (options.visible === false) assert.deepEqual(selected(await state()), []);
    else { assert.equal(selected(await state()).length, 4); assert.equal(await run('document.querySelector(\'[aria-label="Delete selection"]\').disabled'), true); }
    await key('Delete'); result = await unchanged(JSON.stringify(options)); assert.equal(result.nodes.length, 4); assert.equal(result.edges.length, 3); scenarios++;
  }

  // First toolbar controls stay visible/aligned in both themes and narrow windows.
  for (const theme of ['dark', 'light']) for (const width of [1280, 480]) {
    window.setContentSize(width, 850); await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await mount({ framed: true }); await click('[aria-label="Select mode"]'); await click('[aria-label="Select all"]');
    const layout = await run(`(()=>{const controls=[...document.querySelectorAll('.diagram-selection-tools button')].map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return {label:n.getAttribute('aria-label'),left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,font:parseFloat(s.fontSize),text:n.textContent,scroll:n.scrollWidth,client:n.clientWidth};});return {controls,width:innerWidth,toolbar:document.querySelector('.diagram-toolbar').getBoundingClientRect().height,pressed:document.querySelector('[aria-label="Select mode"]').getAttribute('aria-pressed'),mode:document.querySelector('.diagram-structured').dataset.selectionMode};})()`);
    assert.equal(layout.controls.length, 4); assert.equal(layout.mode, 'select'); assert.equal(layout.pressed, 'true'); assert.ok(layout.toolbar <= 52);
    for (const control of layout.controls) { assert.ok(control.left >= 0 && control.right <= width, 'Control clipped: ' + JSON.stringify(layout)); assert.ok(control.height >= 26 && control.font >= 11); assert.ok(control.scroll <= control.client + 1, 'Control label clipped'); assert.ok(Math.abs(control.top - layout.controls[0].top) < 1); }
    await unchanged('Theme/layout selection'); await pause(200);
    await fs.writeFile(path.join(temporary, `selection-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG()); screenshots++; scenarios++;
  }
  assert.deepEqual((await state()).errors, []); assert.deepEqual(errors, []); assert.equal(networkRequests, 0);
  console.log('DIAGRAM_SELECTION_RESULT=' + JSON.stringify({ ok: true, sandboxed: true, scenarios, screenshots, networkRequests })); finish(0);
}).catch(error => { console.error(error.stack || error); finish(1); });
