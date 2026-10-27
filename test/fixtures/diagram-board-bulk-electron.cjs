// Real Studio view and native mouse/keyboard input. All boards, removals and
// confirmations are synthetic memory-only objects; no backend/profile is used.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const temporary = process.argv[2], root = path.resolve(__dirname, '../..');
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-diagram-board-bulk-')) throw new Error('Isolated fixture directory required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0, scenarios = 0, screenshots = 0;
const errors = [], pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
const timer = setTimeout(() => { console.error('Bulk board fixture timed out'); app.exit(1); }, 55_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
async function poll(fn, label) { for (let i = 0; i < 80; i++) { if (await fn()) return; await pause(40); } throw new Error('Timed out: ' + label); }

app.whenReady().then(async () => {
  const directory = path.join(root, 'frontend/features/diagrams'), modules = {};
  for (const [name, file] of Object.entries({
    react: 'react/cjs/react.production.js', 'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js',
    'react-dom': 'react-dom/cjs/react-dom.production.js', 'react-dom/client': 'react-dom/cjs/react-dom-client.production.js',
    scheduler: 'scheduler/cjs/scheduler.production.js', '@xyflow/react': '@xyflow/react/dist/umd/index.js',
  })) modules[name] = await fs.readFile(path.join(root, 'node_modules', file), 'utf8');
  for (const file of await fs.readdir(directory)) {
    if (!/\.(jsx|js|mjs)$/.test(file)) continue;
    modules['./' + file.replace(/\.(jsx|js)$/, '')] = ts.transpileModule(await fs.readFile(path.join(directory, file), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  }
  const catalog = await import(pathToFileURL(path.join(directory, 'diagram-catalog.mjs'))), icons = await import('simple-icons');
  modules['simple-icons'] = 'module.exports=' + JSON.stringify(Object.fromEntries(Object.keys(icons).filter(key => Object.values(catalog.COMPONENT_BRAND_ICONS).includes(icons[key])).map(key => [key, icons[key]])));
  modules['./useDiagramDocument'] = 'exports.useDiagramDocument=()=>{throw new Error("Real store forbidden")};';
  modules['./useOwnerCanvasSharing'] = 'exports.useOwnerCanvasSharing=()=>{throw new Error("Real sharing forbidden")};';
  modules['./useDiagramCanvasScale'] = 'module.exports=()=>({});';
  modules['./eraser-icon-assets.mjs'] = 'exports.getCachedEraserIcon=()=>null;exports.isCachedEraserIconMonochrome=()=>false;exports.loadEraserIcon=async()=>null;exports.prefetchEraserIcons=async()=>({});exports.configureEraserIconAssets=()=>{};';
  modules['./DiagramSketch'] = 'exports.__esModule=true;exports.default=()=>require("react").createElement("div",{className:"synthetic-sketch"},"Synthetic drawing canvas");';
  modules['./DiagramStructurePicker'] = 'exports.__esModule=true;exports.default=()=>null;exports.StructureGlyph=()=>null;exports.STRUCTURE_DRAG_TYPE="application/x-argus-data-structure";';
  const styles = await fs.readFile(path.join(root, 'public/styles.css'), 'utf8')
    + await fs.readFile(path.join(root, 'node_modules/@xyflow/react/dist/style.css'), 'utf8')
    + (await Promise.all(['diagram-studio.css', 'diagram-board-selection.css', 'diagram-nodes.css', 'diagram-structures.css', 'diagram-groups.css'].map(file => fs.readFile(path.join(directory, file), 'utf8')))).join('\n');
  const isolated = session.fromPartition('diagram-board-bulk-regression', { cache: false });
  isolated.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 800, height: 800, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}#fixture{position:absolute;inset:0}.synthetic-sketch{padding:20px}</style></head><body><div id="fixture"></div></body></html>`;
  const fixtureHtml = path.join(temporary, 'bulk.html'); await fs.writeFile(fixtureHtml, html); await window.loadFile(fixtureHtml);
  const run = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nEvaluation: ' + code.slice(0, 700) + '\nRenderer: ' + errors.join('\n')); }
  };
  await run(`{
    const sources={${Object.entries(modules).map(([name, source]) => `${JSON.stringify(name)}:function(require,module,exports){${source}\n}`).join(',')}},cache={};
    const require=window.fixtureRequire=function require(name){if(name.endsWith('.css'))return {};if(cache[name])return cache[name].exports;if(!sources[name])throw new Error('Unexpected fixture import '+name);const module={exports:{}};cache[name]=module;sources[name](require,module,module.exports);return module.exports;};
    const React=require('react'),{createRoot}=require('react-dom/client'),{DiagramStudioView}=require('./DiagramStudio'),{emptySnapshot}=require('./diagram-model.mjs');
    const root=createRoot(document.querySelector('#fixture'));
    window.fixtureConfirm=false;window.confirm=message=>{fixtureCalls.prompts.push(message);return fixtureConfirm;};
    function Harness(){
      const [state,setState]=React.useState(()=>({documents:['Alpha','Beta','Gamma','Archive'].map((name,i)=>({id:name,name,updatedAt:'2026-10-23T08:00:00Z',archived:i===3,snapshot:emptySnapshot()})),active:'Alpha',error:''}));
      window.fixtureStoreState=state;
      const store={documents:state.documents,document:state.documents.find(item=>item.id===state.active)||null,busy:false,dirty:false,status:'Synthetic memory-only',error:state.error,
        flush:async()=>{},loadList:async()=>{},setError:error=>setState(current=>({...current,error})),
        open:async id=>{fixtureCalls.opens.push(id);setState(current=>({...current,active:id}));return true;},
        restore:async item=>{fixtureCalls.restores.push(item.id);return true;},archive:async()=>{fixtureCalls.archives++;},
        change:()=>{fixtureCalls.changes++;},
        create:async(name,snapshot)=>{fixtureCalls.creates.push({name,snapshot});const id='created-'+fixtureCalls.creates.length;setState(current=>({...current,active:id,documents:[...current.documents,{id,name,snapshot,archived:false,updatedAt:'2026-10-23T08:00:00Z'}]}));return true;},
        remove:item=>{fixtureCalls.removes.push(item.id);return new Promise(resolve=>{fixturePending.push({id:item.id,finish:accepted=>{if(accepted)setState(current=>{const documents=current.documents.filter(board=>board.id!==item.id);return {...current,documents,active:current.active===item.id?documents.find(board=>!board.archived)?.id:null};});resolve(accepted);}});});},
      };
      return React.createElement(DiagramStudioView,{store,headerActions:React.createElement('button',{id:'fixture-share',onClick:()=>fixtureCalls.shares++},'Share')});
    }
    window.fixtureMount=()=>{window.fixtureCalls={prompts:[],removes:[],opens:[],restores:[],creates:[],shares:0,changes:0,archives:0};window.fixturePending=[];root.render(React.createElement(Harness,{key:crypto.randomUUID()}));};
    window.fixtureRelease=accepted=>{const pending=fixturePending.shift();if(!pending)throw new Error('No synthetic deletion pending');pending.finish(accepted);};
    window.fixtureRect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    fixtureMount();
  }`);
  const exists = selector => run(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const mount = async () => { await run('fixtureMount()'); await poll(() => exists('.diagram-boards-trigger'), 'Studio mounted'); await pause(100); };
  const nativeClick = async selector => {
    const rect = await run(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing '+${JSON.stringify(selector)});return fixtureRect(node);})()`);
    const point = { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await pause();
  };
  const button = async (text, selector = 'button') => {
    await run(`(()=>{document.querySelector('[data-fixture-target]')?.removeAttribute('data-fixture-target');const target=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.textContent.trim()===${JSON.stringify(text)});if(!target)throw new Error('Missing '+${JSON.stringify(text)});target.setAttribute('data-fixture-target','true');})()`);
    await nativeClick('[data-fixture-target]');
  };
  const editSearch = async value => {
    await run('document.querySelector(\'[aria-label="Search saved boards"]\').focus();document.querySelector(\'[aria-label="Search saved boards"]\').select()');
    if (value) await window.webContents.insertText(value);
    else { window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' }); }
    await pause();
  };
  const selected = () => run('[...document.querySelectorAll(".diagram-board-checkbox:checked")].map(input=>input.getAttribute("aria-label"))');
  for (const theme of ['dark', 'light']) for (const width of [800, 480]) {
    window.setContentSize(width, 800); await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await mount();
    await nativeClick('.diagram-boards-trigger'); await poll(() => exists('#diagram-board-picker'), 'Boards menu opens');
    await button('Select boards'); await nativeClick('[aria-label="Select all visible boards"]');
    assert.equal((await selected()).length, 3);
    await run('document.querySelector(\'[aria-label="Select board Beta"]\').focus()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' }); await pause();
    assert.deepEqual(await selected(), ['Select board Alpha', 'Select board Gamma'], 'Native keyboard toggles the focused board checkbox');
    const metrics = await run(`(()=>{const rect=fixtureRect,picker=document.querySelector('#diagram-board-picker');return {picker:rect(picker),width:innerWidth,height:innerHeight,controls:[...picker.querySelectorAll('input[type="checkbox"],.diagram-board-selection button')].map(node=>({box:rect(node),type:node.type,padding:getComputedStyle(node).padding})),rows:[...picker.querySelectorAll('.diagram-board-item')].map(row=>({row:rect(row),check:rect(row.querySelector('input')),open:rect(row.querySelector('.diagram-board-open'))}))};})()`);
    assert.ok(metrics.picker.left >= 0 && metrics.picker.right <= metrics.width + 1 && metrics.picker.bottom <= metrics.height + 1, 'Board picker stays in the narrow viewport');
    for (const control of metrics.controls) {
      assert.ok(control.box.left >= metrics.picker.left && control.box.right <= metrics.picker.right + 1, 'Bulk control remains inside picker');
      if (control.type === 'checkbox') { assert.ok(control.box.width >= 14 && Math.abs(control.box.width - control.box.height) < 2, 'Checkbox is a usable square, not a full-width text field'); assert.equal(control.padding, '0px', 'Checkbox does not inherit text-field padding'); }
    }
    for (const row of metrics.rows) assert.ok(row.check.right <= row.open.left && row.open.right <= row.row.right + 1, 'Checkbox and board title do not overlap');
    await fs.writeFile(path.join(temporary, `bulk-boards-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG()); screenshots++; scenarios++;
  }
  window.setContentSize(800, 800); await mount();
  await nativeClick('.diagram-boards-trigger'); await button('Select boards'); await nativeClick('[aria-label="Select all visible boards"]');
  await button('Delete selected');
  assert.equal(await run('fixtureCalls.removes.length'), 0, 'Cancelling confirmation deletes nothing');
  assert.equal((await selected()).length, 3);
  const prompt = await run('fixtureCalls.prompts[0]');
  for (const name of ['Alpha', 'Beta', 'Gamma']) assert.ok(prompt.includes(name));
  assert.match(prompt, /structured canvas and drawing/); assert.match(prompt, /cannot be undone/); scenarios++;

  await run('fixtureConfirm=true'); await button('Delete selected');
  await poll(() => run('fixtureCalls.removes.length===1'), 'First deletion waits for synthetic completion');
  assert.equal(await run('fixturePending.length'), 1, 'Deletion is serial');
  assert.equal(await run(`[...document.querySelectorAll('.diagram-mode-tabs button,.diagram-file-actions button,.diagram-board-checkbox,.diagram-boards-trigger,[aria-label="Board name"],[aria-label="Search saved boards"]')].every(node=>node.disabled)`), true, 'Navigation, editing and selection controls lock during deletion');
  assert.equal(await run('[...document.querySelectorAll(".diagram-mode-surface,.diagram-header-actions-lock")].every(node=>node.inert)'), true, 'Canvas and injected Share action are inert');
  await nativeClick('#fixture-share');
  assert.equal(await run('fixtureCalls.shares'), 0, 'Native click cannot invoke inert Share'); scenarios++;

  await run('fixtureRelease(true)'); await poll(() => run('fixtureCalls.removes.length===2'), 'Next removal starts after first resolves');
  assert.equal(await run('fixturePending.length'), 1);
  await run('fixtureRelease(false)'); await poll(() => run('document.querySelector(".diagram-board-selection-status")?.textContent.includes("Stopped")'), 'Partial failure reported');
  assert.deepEqual(await run('fixtureCalls.removes'), ['Alpha', 'Beta']);
  assert.deepEqual(await selected(), ['Select board Beta', 'Select board Gamma']);
  assert.match(await run('document.querySelector(".diagram-board-selection-status").textContent'), /1 of 3 deleted.*2 still selected/);
  assert.equal(await run('document.querySelector(".diagram-boards-trigger").disabled'), false); scenarios++;

  await editSearch('Gamma'); assert.deepEqual(await selected(), []);
  await nativeClick('[aria-label="Select board Gamma"]'); assert.equal((await selected()).length, 1);
  await editSearch(''); await button('Archived', '.diagram-board-tabs button');
  assert.deepEqual(await selected(), []);
  assert.equal(await exists('[aria-label="Select board Archive"]'), true); scenarios++;

  await mount(); await button('Draw · Excalidraw', '.diagram-mode-tabs button'); await poll(() => exists('.synthetic-sketch'), 'Isolated sketch stub mounted');
  await nativeClick('.diagram-boards-trigger');
  assert.equal(await exists('.diagram-template-actions'), false, 'Draw does not offer structured templates');
  await button('New drawing', '.diagram-board-search button');
  await poll(() => run('fixtureCalls.creates.length===1'), 'New drawing created');
  const created = await run('fixtureCalls.creates[0]');
  assert.equal(created.name, 'Untitled drawing'); assert.deepEqual(created.snapshot.structured.nodes, []); assert.deepEqual(created.snapshot.structured.edges, []); assert.deepEqual(created.snapshot.sketch.elements, []);
  assert.equal(await run('[...document.querySelectorAll(".diagram-mode-tabs button")].find(button=>button.textContent.includes("Excalidraw")).getAttribute("aria-pressed")'), 'true', 'New drawing stays in Draw mode');
  await button('Structured', '.diagram-mode-tabs button'); await nativeClick('.diagram-boards-trigger');
  assert.equal(await run('document.querySelectorAll(".diagram-template-actions button").length'), 4, 'Structured templates remain available only in Structured mode'); scenarios++;
  assert.deepEqual(errors, []); assert.equal(networkRequests, 0);
  console.log('DIAGRAM_BOARD_BULK_RESULT=' + JSON.stringify({ ok: true, scenarios, screenshots, networkRequests, sandboxed: window.webContents.getLastWebPreferences().sandbox })); finish(0);
}).catch(async error => { if (window && !window.isDestroyed()) { try { await fs.writeFile(path.join(temporary, 'bulk-failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {} } console.error(error.stack || error); finish(1); });
