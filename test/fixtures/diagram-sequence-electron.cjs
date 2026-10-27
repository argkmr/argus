// Actual StructuredCanvas, nodes, edges, XYFlow and CSS; only disposable,
// synthetic state. No Argus backend, installed app, profile or external traffic.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const temporary = process.argv[2], root = path.resolve(__dirname, '../..');
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-diagram-sequence-')) throw new Error('Isolated fixture directory required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0, scenarios = 0, screenshots = 0;
const errors = [];
const timer = setTimeout(() => { console.error('Sequence browser regression timed out'); app.exit(1); }, 70_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label) { for (let attempt = 0; attempt < 100; attempt++) { if (await fn()) return; await pause(40); } throw new Error('Timed out: ' + label); }

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
    + (await Promise.all(['diagram-studio.css', 'diagram-nodes.css', 'diagram-structures.css', 'diagram-groups.css'].map(file => fs.readFile(path.join(directory, file), 'utf8')))).join('\n');
  const themeStyles = await fs.readFile(path.join(root, 'canvas-web/src/styles.css'), 'utf8');
  const hostStyles = await fs.readFile(path.join(root, 'public/styles.css'), 'utf8');
  const isolated = session.fromPartition('diagram-sequence-regression', { cache: false });
  isolated.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  // Keep complete host form rules, not just light overrides: for example the
  // native select arrow depends on its shared non-repeating background rules.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${hostStyles}\n${themeStyles}body{margin:0;font:12px system-ui}#fixture{position:absolute;inset:0}${styles}</style></head><body><div id="fixture" class="diagram-studio"></div></body></html>`;
  const fixtureHtml = path.join(temporary, 'sequence.html'); await fs.writeFile(fixtureHtml, html); await window.loadFile(fixtureHtml);
  const run = code => window.webContents.executeJavaScript(code);
  await run(`{
    const sources={${Object.entries(modules).map(([name, source]) => `${JSON.stringify(name)}:function(require,module,exports){${source}\n}`).join(',')}},cache={};
    window.fixtureRequire=function require(name){if(name.endsWith('.css'))return {};if(cache[name])return cache[name].exports;if(!sources[name])throw new Error('Unexpected fixture import '+name);const module={exports:{}};cache[name]=module;sources[name](require,module,module.exports);return module.exports;};
    const React=fixtureRequire('react'),{createRoot}=fixtureRequire('react-dom/client'),xy=fixtureRequire('@xyflow/react'),{StructuredCanvas}=fixtureRequire('./DiagramStudio');
    const Capture=()=>{window.testFlow=xy.useReactFlow();return null;};
    window.fixtureRoot=createRoot(document.querySelector('#fixture'));
    window.fixtureInitial=()=>({nodes:[
      ['client','Client','Browser',[]],
      ['api','Order API','Application',[{id:'api-call',startRow:0,endRow:7,depth:0},{id:'api-nested',startRow:2,endRow:3,depth:1}]],
      ['store','Order database','Persistence',[{id:'store-call',startRow:4,endRow:5,depth:0}]],
      ['queue','Event queue','Async delivery',[{id:'queue-call',startRow:6,endRow:8,depth:0}]],
    ].map(([id,name,role,activations],i)=>({id,type:'participant',position:{x:30+i*310,y:30},style:{width:220},data:{name,role,sequence:{rowGap:56,rowCount:10},activations}})),edges:[
      ['request','client','api','r-0','l-0','message','1. Submit order'],
      ['self','api','api','r-2','r-3','message','2. Validate'],
      ['persist','api','store','r-4','l-4','message','3. Persist the order and its idempotency key atomically'],
      ['stored','store','api','l-5','r-5','return','4. Order stored'],
      ['publish','api','queue','r-6','l-6','async','5. Publish order.created'],
      ['response','api','client','l-7','r-7','return','6. Order accepted'],
    ].map(([id,source,target,sourceHandle,targetHandle,relation,label])=>({id,type:'relation',source,target,sourceHandle,targetHandle,data:{relation,label,curvature:.3}})),viewport:{x:1,y:1,zoom:1}});
    window.fixtureMount=({snapshot=null,readOnly=false}={})=>{
      const board={id:crypto.randomUUID(),name:'Synthetic sequence regression',snapshot:{structured:snapshot||fixtureInitial()}};
      window.fixtureSaved=null;window.fixtureSaves=[];window.fixtureErrors=[];
      fixtureRoot.render(React.createElement(xy.ReactFlowProvider,{key:board.id},React.createElement(Capture),React.createElement(StructuredCanvas,{document:board,visible:true,readOnly,onChange:next=>{fixtureSaved=next;fixtureSaves.push(next);},onError:error=>fixtureErrors.push(error)})));
    };
    window.fixtureState=()=>({nodes:testFlow.getNodes().map(node=>({id:node.id,type:node.type,position:node.position,style:node.style,data:node.data})),edges:testFlow.getEdges(),viewport:testFlow.getViewport(),saved:fixtureSaved,saves:fixtureSaves.length,errors:fixtureErrors});
    window.fixtureRect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    fixtureMount();
  }`);
  const exists = selector => run(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const mount = async options => {
    await run(`fixtureMount(${JSON.stringify(options || {})})`);
    await poll(() => exists('[data-id="api"] .diagram-participant-header'), 'Participants mounted');
    await poll(() => run('testFlow.getNodes().every(node=>node.measured?.width>0)'), 'XYFlow measured participants');
    await pause(150);
  };
  const click = async selector => { await run(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(!target)throw new Error('Missing control '+${JSON.stringify(selector)});target.click();})()`); await pause(); };
  const clickText = async text => { await run(`(()=>{const target=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)});if(!target)throw new Error('Missing button '+${JSON.stringify(text)});target.click();})()`); await pause(); };
  const edit = async (selector, value) => {
    await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw new Error('Missing input '+${JSON.stringify(selector)});input.focus();input.select();})()`);
    await window.webContents.insertText(value); await pause(100);
  };
  const selectParticipant = async id => {
    const r = await run(`fixtureRect(document.querySelector('[data-id="${id}"] .diagram-participant-header'))`);
    const point = { x: Math.round(r.left + 4), y: Math.round(r.top + 4) };
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await pause(120);
  };

  await mount();
  for (const theme of ['dark', 'light']) for (const width of [1280, 800]) {
    window.setContentSize(width, 900);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};testFlow.fitView({padding:.12,maxZoom:1,duration:0})`); await pause(150);
    const metrics = await run(`(()=>{
      const rect=fixtureRect,style=node=>getComputedStyle(node);
      return {headers:[...document.querySelectorAll('.diagram-participant-header')].map(header=>({box:rect(header),name:rect(header.querySelector('[aria-label="Participant name"]')),nameFont:parseFloat(style(header.querySelector('[aria-label="Participant name"]')).fontSize),role:rect(header.querySelector('[aria-label="Participant role"]'))})),labels:[...document.querySelectorAll('.diagram-edge-label input,.diagram-edge-label textarea')].map(field=>({value:field.value,box:rect(field),font:parseFloat(style(field).fontSize),overflow:style(field).textOverflow,whiteSpace:style(field).whiteSpace,padding:style(field).padding,lineHeight:style(field).lineHeight,boxSizing:style(field).boxSizing,cssHeight:style(field).height,scrollHeight:field.scrollHeight,clientHeight:field.clientHeight,scrollWidth:field.scrollWidth,clientWidth:field.clientWidth,tag:field.tagName})),paths:[...document.querySelectorAll('.react-flow__edge')].map(edge=>{const path=edge.querySelector('.react-flow__edge-path'),marker=path.getAttribute('marker-end'),id=marker?.match(/#([^)]*)/)?.[1],arrow=id?document.getElementById(id)?.querySelector('path'):null;return {id:edge.dataset.id,d:path.getAttribute('d'),dash:style(path).strokeDasharray,arrow:arrow?.getAttribute('d'),fill:arrow?.getAttribute('fill')};}),flow:rect(document.querySelector('.diagram-flow')),viewportWidth:innerWidth};
    })()`);
    assert.equal(metrics.headers.length, 4); assert.equal(metrics.labels.length, 6);
    for (const header of metrics.headers) {
      assert.ok(header.nameFont >= 13, 'Participant names are readable');
      for (const text of [header.name, header.role]) assert.ok(text.left >= header.box.left - 1 && text.right <= header.box.right + 1 && text.top >= header.box.top - 1 && text.bottom <= header.box.bottom + 1, 'Header text stays inside its participant');
      assert.ok(header.name.bottom <= header.role.top + 1, 'Participant name and role do not overlap');
    }
    for (const label of metrics.labels) {
      assert.ok(label.font >= 13, 'Message labels are at least 13px: ' + JSON.stringify(label));
      assert.notEqual(label.overflow, 'ellipsis', 'Sequence messages must not use ellipsis');
      assert.ok(label.scrollHeight <= label.clientHeight + 1 && label.scrollWidth <= label.clientWidth + 1, 'Message text is not clipped: ' + JSON.stringify(label));
      for (const header of metrics.headers) {
        const a = label.box, b = header.box;
        assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, 'Message labels do not overlap participant headers');
      }
    }
    const long = metrics.labels.find(label => label.value.startsWith('3. Persist'));
    assert.equal(long.tag, 'TEXTAREA', 'Long message is an editable multiline label');
    assert.ok(long.clientHeight > long.font * 2, 'Long message wraps across readable lines');
    assert.equal(await run(`(()=>{const background=getComputedStyle(document.querySelector('.diagram-studio')).backgroundColor;return [...document.querySelectorAll('.diagram-edge-label.is-sequence textarea')].every(label=>getComputedStyle(label).backgroundColor===background);})()`), true, 'Message labels mask crossing lifelines with the canvas background');
    const crossingLabel = await run(`(()=>{const label=[...document.querySelectorAll('.diagram-edge-label textarea')].find(field=>field.value.startsWith('5. Publish')),box=fixtureRect(label),line=fixtureRect(document.querySelector('[data-id="store"] .diagram-lifeline')),hit=document.elementFromPoint(line.left+.5,(box.top+box.bottom)/2);return {reachable:hit===label,hit:hit?.className};})()`);
    assert.equal(crossingLabel.reachable, true, 'A crossing participant must not paint over or block the message label: ' + JSON.stringify(crossingLabel));
    for (let i = 0; i < metrics.labels.length; i++) for (let j = i + 1; j < metrics.labels.length; j++) {
      const a = metrics.labels[i].box, b = metrics.labels[j].box;
      assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, 'Message labels overlap');
    }
    for (const edge of metrics.paths) {
      const returned = ['stored', 'response'].includes(edge.id);
      assert.equal(edge.dash !== 'none', returned, 'Only return messages are dashed: ' + edge.id);
      assert.equal(edge.fill === 'none', returned || edge.id === 'publish', 'Call arrows are filled, return/async arrows open: ' + edge.id);
      if (edge.id === 'self') { assert.match(edge.d, /[HV]/, 'Self-message has square UML routing'); assert.doesNotMatch(edge.d, /C/, 'Self-message is not a Bézier loop'); }
    }
    const alignment = await run(`(()=>{
      const zoom=testFlow.getViewport().zoom,rect=fixtureRect;
      const activations=[...document.querySelectorAll('.diagram-sequence-activation')].map(bar=>{
        const participant=bar.closest('.diagram-participant-node'),node=participant.closest('.react-flow__node'),box=rect(bar),host=rect(participant),line=rect(participant.querySelector('.diagram-lifeline'));
        const geometry=fixtureRequire('./diagram-sequence.mjs').getSequenceGeometry(testFlow.getNode(node.dataset.id).data);
        return {id:node.dataset.id,start:Number(bar.dataset.startRow),end:Number(bar.dataset.endRow),depth:Number(bar.dataset.depth),expected:geometry.activations.find(item=>item.id===bar.dataset.activationId),x:(box.left+box.width/2-line.left)/zoom,y:(box.top-host.top)/zoom,width:box.width/zoom,height:box.height/zoom};
      });
      const endpoints=testFlow.getEdges().map(edge=>{
        const path=document.querySelector('.react-flow__edge[data-id="'+edge.id+'"] .react-flow__edge-path');
        const point=distance=>{const p=path.getPointAtLength(distance),screen=new DOMPoint(p.x,p.y).matrixTransform(path.getScreenCTM());return {x:screen.x,y:screen.y};};
        const handle=(id,name)=>{const r=rect(document.querySelector('.react-flow__node[data-id="'+id+'"] [data-handleid="'+name+'"]'));return {x:name.startsWith('l-')?r.left:r.right,y:(r.top+r.bottom)/2};};
        return {id:edge.id,start:point(0),end:point(path.getTotalLength()),source:handle(edge.source,edge.sourceHandle),target:handle(edge.target,edge.targetHandle)};
      });
      return {activations,endpoints};
    })()`);
    assert.equal(alignment.activations.length, 4, 'Only explicitly authored execution spans render');
    for (const bar of alignment.activations) {
      assert.ok(Math.abs(bar.y - bar.expected.y) < 1, 'Activation starts at its message row: ' + JSON.stringify(bar));
      assert.ok(Math.abs(bar.height - bar.expected.height) < 1, 'Activation ends at its message row');
      assert.ok(Math.abs(bar.width - 12) < 1, 'Activations stay slim');
      assert.ok(Math.abs(bar.x - bar.depth * 6) < 2, 'Nested activation is offset from the lifeline');
    }
    for (const edge of alignment.endpoints) for (const [actual, expected] of [[edge.start, edge.source], [edge.end, edge.target]]) {
      assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1.5, 'Message terminates on its actual activation/lifeline handle: ' + JSON.stringify(edge));
    }
    assert.ok(metrics.flow.left >= -1 && metrics.flow.right <= metrics.viewportWidth + 1, 'Canvas remains bounded at narrow width');
    await fs.writeFile(path.join(temporary, `sequence-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG()); screenshots++;
    scenarios += 2;
  }

  // Further interaction and activation checks below intentionally use the real
  // editor and onChange snapshots, not a test imitation of its update methods.
  window.setContentSize(1280, 900);
  await run('document.documentElement.dataset.theme="dark";testFlow.fitView({padding:.12,maxZoom:1,duration:0})'); await pause(100);
  await edit('[data-id="api"] [aria-label="Participant name"]', 'Checkout API');
  await poll(() => run('fixtureState().saved?.nodes.find(node=>node.id==="api").data.name==="Checkout API"'), 'Participant edit saved');
  await edit('.diagram-edge-label textarea', 'Submit order safely');
  await poll(() => run('fixtureState().saved?.edges.some(edge=>edge.data.label==="Submit order safely")'), 'Message label edit saved');
  const saved = await run('fixtureState().saved');
  await mount({ snapshot: saved });
  assert.equal(await run('document.querySelector(\'[data-id="api"] [aria-label="Participant name"]\').value'), 'Checkout API');
  assert.equal(await run('[...document.querySelectorAll(".diagram-edge-label textarea")].some(field=>field.value==="Submit order safely")'), true);
  scenarios += 2;

  await selectParticipant('api');
  await poll(() => exists('.diagram-sequence-inspector'), 'Sequence participant inspector opens');
  assert.equal(await run('fixtureState().nodes.find(node=>node.id==="api").data.activations.length'), 2);
  await clickText('Add activation');
  await poll(() => run('fixtureState().saved?.nodes.find(node=>node.id==="api").data.activations.length===3'), 'Explicit activation added');
  await edit('[aria-label="Start row 3"]', '2');
  await edit('[aria-label="End row 3"]', '6');
  await edit('[aria-label="Nesting 3"]', '1');
  const beforeFractional = await run('fixtureState().nodes.find(node=>node.id==="api").data.activations');
  await edit('[aria-label="Start row 3"]', '1.5');
  assert.deepEqual(await run('fixtureState().nodes.find(node=>node.id==="api").data.activations'), beforeFractional, 'A partially typed fractional row must not delete or alter the activation');
  const activationSave = await run('fixtureState().saved');
  const added = activationSave.nodes.find(node => node.id === 'api').data.activations[2];
  assert.deepEqual({ startRow: added.startRow, endRow: added.endRow, depth: added.depth }, { startRow: 1, endRow: 5, depth: 1 }, 'Inspector rows are one-based while persisted rows remain zero-based');
  await mount({ snapshot: activationSave });
  assert.deepEqual(await run('fixtureState().nodes.find(node=>node.id==="api").data.activations'), activationSave.nodes.find(node => node.id === 'api').data.activations, 'Authored activations survive remount');
  scenarios += 2;

  await mount({ snapshot: activationSave, readOnly: true });
  assert.equal(await run('[...document.querySelectorAll(\'[aria-label="Participant name"],[aria-label="Participant role"],.diagram-edge-label textarea\')].every(field=>field.readOnly||field.disabled)'), true, 'Read-only participants and messages expose immutable text fields');
  const beforeReadOnly = await run('fixtureState()');
  assert.equal(await run('[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Arrange sequence").disabled'), true, 'Viewer cannot rearrange the shared diagram');
  await selectParticipant('api');
  await poll(() => exists('.diagram-sequence-inspector'), 'Read-only activation inspector opens');
  assert.equal(await run('[...document.querySelectorAll(".diagram-sequence-inspector input,.diagram-sequence-inspector button")].every(field=>field.matches(":disabled"))'), true, 'Viewer activation controls are disabled');
  await run(`(()=>{for(const input of document.querySelectorAll('[aria-label="Participant name"],.diagram-edge-label textarea')){Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,'FORBIDDEN');input.dispatchEvent(new Event('input',{bubbles:true}));}})()`); await pause(100);
  const afterReadOnly = await run('fixtureState()');
  assert.equal(afterReadOnly.saves, beforeReadOnly.saves);
  assert.deepEqual(afterReadOnly.nodes, beforeReadOnly.nodes); assert.deepEqual(afterReadOnly.edges, beforeReadOnly.edges);
  scenarios++;

  // Old boards retain all original row identities/coordinates and gain no
  // fabricated activity bars just because their presentation was improved.
  const legacy = await run(`(()=>{const graph=fixtureInitial();graph.nodes=graph.nodes.slice(0,2).map(node=>({...node,data:{name:node.data.name,role:node.data.role,lifelineHeight:500}}));graph.edges=[{id:'legacy',type:'relation',source:'client',target:'api',sourceHandle:'r-15',targetHandle:'l-15',data:{relation:'return',label:'Legacy final row'}}];return graph;})()`);
  await mount({ snapshot: legacy });
  const legacyMetrics = await run(`(()=>[...document.querySelectorAll('.diagram-participant-node')].map(node=>({layout:node.dataset.sequenceLayout,rows:[...node.querySelectorAll('.diagram-message-slot')].map(row=>parseFloat(row.style.top)),activations:node.querySelectorAll('.diagram-sequence-activation').length})))()`);
  for (const participant of legacyMetrics) {
    assert.equal(participant.layout, 'legacy'); assert.equal(participant.activations, 0);
    assert.deepEqual(participant.rows, Array.from({ length: 16 }, (_, index) => 100 + index * 28));
  }
  assert.equal(await run('fixtureState().saves'), 0, 'Rendering a legacy board does not migrate or save it');
  scenarios++;

  const unaligned = await run('fixtureInitial()'); unaligned.nodes[1].position.y += 48;
  await mount({ snapshot: unaligned });
  const originalEdges = await run('fixtureState().edges.map(({id,type,source,target,sourceHandle,targetHandle,data})=>({id,type,source,target,sourceHandle,targetHandle,data}))');
  await clickText('Arrange sequence');
  await poll(() => run('Boolean(fixtureState().saved)'), 'Explicit arrangement saved');
  const arranged = await run('fixtureState().saved');
  assert.equal(new Set(arranged.nodes.map(node => node.position.y)).size, 1, 'Arrange aligns participant tops');
  assert.deepEqual(arranged.edges, originalEdges, 'Arrange preserves message identities and semantics');
  await click('[aria-label="Undo"]');
  await poll(() => run('fixtureState().nodes.find(node=>node.id==="api").position.y===' + unaligned.nodes[1].position.y), 'Undo restores authored layout');
  scenarios++;

  const mixed = structuredClone(unaligned);
  mixed.nodes.push({ id: 'note', type: 'note', position: { x: 0, y: 700 }, data: { name: 'Decision', description: 'Keep this placement.' } });
  await mount({ snapshot: mixed });
  assert.equal(await run('[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Arrange sequence").disabled'), true, 'Arrange is not applied to a mixed architecture board');
  scenarios++;
  assert.deepEqual(await run('fixtureState().errors'), []);
  assert.deepEqual(errors, []); assert.equal(networkRequests, 0);
  console.log('DIAGRAM_SEQUENCE_RESULT=' + JSON.stringify({ ok: true, scenarios, networkRequests, screenshots, sandboxed: window.webContents.getLastWebPreferences().sandbox }));
  finish(0);
}).catch(async error => {
  if (window && !window.isDestroyed()) {
    try { await fs.writeFile(path.join(temporary, 'sequence-failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
    try { console.error('SEQUENCE_FAILURE_STATE=' + JSON.stringify(await window.webContents.executeJavaScript('({nodes:testFlow?.getNodes().map(node=>({id:node.id,position:node.position})),saves:fixtureSaves?.map(graph=>({nodes:graph.nodes.map(node=>({id:node.id,position:node.position})),viewport:graph.viewport})),undoDisabled:document.querySelector(\'[aria-label="Undo"]\')?.disabled})'))); } catch {}
  }
  console.error(error.stack || error); finish(1);
});
