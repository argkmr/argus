// Production React nodes, StructuredCanvas, XYFlow and styles. All board state
// is synthetic and in memory; no Argus backend, profile or network is accessed.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const temporary = process.argv[2], root = path.resolve(__dirname, '../..');
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-diagram-hld-')) throw new Error('Isolated fixture directory required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0, scenarios = 0;
const errors = [];
const timer = setTimeout(() => { console.error('HLD browser regression timed out'); app.exit(1); }, 70_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label) { for (let attempt = 0; attempt < 100; attempt++) { if (await fn()) return; await pause(50); } throw new Error('Timed out: ' + label); }

app.whenReady().then(async () => {
  const directory = path.join(root, 'frontend/features/diagrams');
  const modules = {};
  for (const [name, file] of Object.entries({
    react: 'react/cjs/react.production.js', 'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js',
    'react-dom': 'react-dom/cjs/react-dom.production.js', 'react-dom/client': 'react-dom/cjs/react-dom-client.production.js',
    scheduler: 'scheduler/cjs/scheduler.production.js', '@xyflow/react': '@xyflow/react/dist/umd/index.js',
  })) modules[name] = await fs.readFile(path.join(root, 'node_modules', file), 'utf8');
  // Compile local diagram helpers so a new pure helper import does not silently
  // replace production behavior with a mock. Modules load only when requested.
  for (const file of await fs.readdir(directory)) {
    if (!/\.(jsx|js|mjs)$/.test(file)) continue;
    const name = './' + file.replace(/\.(jsx|js)$/, '');
    modules[name] = ts.transpileModule(await fs.readFile(path.join(directory, file), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  }
  const catalog = await import(pathToFileURL(path.join(directory, 'diagram-catalog.mjs')));
  const icons = await import('simple-icons');
  modules['simple-icons'] = 'module.exports=' + JSON.stringify(Object.fromEntries(Object.keys(icons).filter(key => Object.values(catalog.COMPONENT_BRAND_ICONS).some(icon => icon === icons[key])).map(key => [key, icons[key]])));
  modules['./useDiagramDocument'] = 'exports.useDiagramDocument=()=>{throw new Error("Live store must not be used")};';
  modules['./useOwnerCanvasSharing'] = 'exports.useOwnerCanvasSharing=()=>{throw new Error("Live sharing must not be used")};';
  modules['./useDiagramCanvasScale'] = 'module.exports=()=>({});';
  // Exercise the actual image/mask rendering without touching Eraser or the
  // user's server. Transport/cache security has its own deterministic tests.
  const fixtureIcon = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="#f90"/><path d="M8 8h8v8H8z" fill="#fff"/></svg>').toString('base64');
  modules['./eraser-icon-assets.mjs'] = `const asset=${JSON.stringify(fixtureIcon)};exports.getCachedEraserIcon=()=>asset;exports.isCachedEraserIconMonochrome=name=>['database','github'].includes(name);exports.loadEraserIcon=async()=>asset;exports.prefetchEraserIcons=async names=>Object.fromEntries(names.map(name=>[name,asset]));exports.configureEraserIconAssets=()=>{};`;
  modules['./DiagramStructurePicker'] = 'exports.__esModule=true;exports.default=()=>null;exports.StructureGlyph=()=>null;exports.STRUCTURE_DRAG_TYPE="application/x-argus-data-structure";';
  // Keep the same cascade as DiagramStudio: library defaults first, then the
  // production node and workspace overrides (especially custom group frames).
  const styles = await fs.readFile(path.join(root, 'node_modules/@xyflow/react/dist/style.css'), 'utf8')
    + (await Promise.all(['diagram-studio.css', 'diagram-nodes.css', 'diagram-structures.css', 'diagram-groups.css'].map(file => fs.readFile(path.join(directory, file), 'utf8')))).join('\n');
  const themeStyles = await fs.readFile(path.join(root, 'canvas-web/src/styles.css'), 'utf8');
  // Include the desktop host's light input rules too: the standalone canvas
  // alone cannot catch generic workspace styles repainting inline labels.
  const hostStyles = await fs.readFile(path.join(root, 'public/styles.css'), 'utf8');
  const hostInputStyles = [...hostStyles.matchAll(/[^{}]*:root\[data-theme="light"\][^{}]*\{[^{}]*\}/g)].map(match=>match[0]).filter(rule=>/input|textarea|select/.test(rule)).join('\n');
  const isolated = session.fromPartition('diagram-hld-regression', { cache: false });
  isolated.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${themeStyles}:root{--surface-3:var(--surface-2);--muted-2:var(--muted);--orange:#d39b57}body{font:12px system-ui}#fixture{position:absolute;inset:0}${styles}\n${hostInputStyles}</style></head><body><div id="fixture" class="diagram-studio"></div></body></html>`;
  const fixtureHtml = path.join(temporary, 'hld.html'); await fs.writeFile(fixtureHtml, html); await window.loadFile(fixtureHtml);
  await window.webContents.executeJavaScript(`{
    const sources={${Object.entries(modules).map(([name, source]) => `${JSON.stringify(name)}:function(require,module,exports){${source}\n}`).join(',')}},cache={};
    window.fixtureRequire=function require(name){if(name.endsWith('.css'))return {};if(cache[name])return cache[name].exports;if(!sources[name])throw new Error('Unexpected fixture import '+name);const module={exports:{}};cache[name]=module;sources[name](require,module,module.exports);return module.exports;};
    const React=fixtureRequire('react'),{createRoot}=fixtureRequire('react-dom/client'),xy=fixtureRequire('@xyflow/react'),model=fixtureRequire('./diagram-model.mjs'),{StructuredCanvas}=fixtureRequire('./DiagramStudio');
    const Capture=()=>{window.testFlow=xy.useReactFlow();return null;};
    window.fixtureRoot=createRoot(document.querySelector('#fixture'));
    window.fixtureInitial=()=>({nodes:[
      {id:'client',type:'component',position:{x:80,y:100},style:{width:180,height:180},data:{name:'Customer UI',componentKey:'react',description:'Browser sends authenticated requests.',replicas:1}},
      {id:'api',type:'component',position:{x:400,y:100},style:{width:240,height:190},data:{name:'Order API',componentKey:'spring',description:'Validates orders before persistence.\\nRetries are idempotent.',replicas:3}},
      {id:'mongo',type:'component',position:{x:790,y:80},style:{width:220,height:180},data:{name:'Order documents',componentKey:'mongodb',description:'Canonical order data.',replicas:1}},
      {id:'redis',type:'component',position:{x:790,y:350},style:{width:220,height:180},data:{name:'Hot cache',componentKey:'redis',description:'TTL 30 seconds.',replicas:1}},
      {id:'topic',type:'component',position:{x:400,y:410},style:{width:240,height:180},data:{name:'order.created',componentKey:'kafka-topic',description:'Partitioned by order id.',replicas:1}},
      {id:'worker',type:'component',position:{x:1080,y:350},style:{width:180,height:180},data:{name:'Fulfilment workers',componentKey:'worker',description:'',replicas:4}},
    ],edges:[['a','client','api','right','left','HTTPS'],['b','api','mongo','right','left','Persist'],['c','api','redis','right','left','Read-through'],['d','api','topic','bottom','top','Publish'],['e','topic','worker','right','left','Consume']].map(([id,source,target,sourceHandle,targetHandle,label])=>({id,type:'relation',source,target,sourceHandle,targetHandle,data:{relation:'dependency',label,curvature:.3}})),viewport:{x:20,y:10,zoom:1}});
    window.fixtureMount=({readOnly=false,snapshot=null}={})=>{
      const board={id:crypto.randomUUID(),name:'HLD regression',snapshot:{structured:snapshot||fixtureInitial()}};
      window.fixtureSaved=null;window.fixtureSaves=[];window.fixtureErrors=[];
      fixtureRoot.render(React.createElement(xy.ReactFlowProvider,{key:board.id},React.createElement(Capture),React.createElement(StructuredCanvas,{document:board,visible:true,readOnly,onChange:next=>{fixtureSaved=next;fixtureSaves.push(next);},onError:error=>fixtureErrors.push(error)})));
    };
    window.fixtureState=()=>({viewport:testFlow.getViewport(),nodes:testFlow.getNodes().map(node=>({id:node.id,type:node.type,position:node.position,style:node.style,selected:node.selected,data:node.data})),edges:testFlow.getEdges(),saved:fixtureSaved,saves:fixtureSaves.length,errors:fixtureErrors});
    window.fixtureGlyphMetrics=selector=>{
      const glyph=document.querySelector(selector);
      if(!glyph)throw new Error('Missing glyph '+selector);
      const box=node=>{if(!node)return null;const r=node.getBoundingClientRect(),style=getComputedStyle(node);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,contentWidth:r.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth),contentHeight:r.height-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)-parseFloat(style.borderTopWidth)-parseFloat(style.borderBottomWidth),display:style.display,color:style.color};};
      const role=glyph.querySelector(':scope > .diagram-role-glyph'),brand=glyph.querySelector(':scope > .diagram-brand-glyph');
      return {glyph:box(glyph),role:box(role),brand:box(brand),viewBox:brand?.getAttribute('viewBox'),paths:brand?[...brand.querySelectorAll('path')].map(path=>({d:path.getAttribute('d'),fill:path.getAttribute('fill')})):[]};
    };
    fixtureMount();
  }`);
  const run = code => window.webContents.executeJavaScript(code);
  const click = async selector => { await run(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing '+${JSON.stringify(selector)});node.click();})()`); await pause(); };
  const exists = selector => run(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const box = selector => run(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing '+${JSON.stringify(selector)});const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})()`);
  const drag = async (from, to, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x), y: Math.round(from.y) });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(from.x), y: Math.round(from.y), button: 'left', clickCount: 1, modifiers });
    for (let index = 1; index <= 6; index++) { window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * index / 6), y: Math.round(from.y + (to.y - from.y) * index / 6), button: 'left', modifiers: [...modifiers, 'leftButtonDown'] }); await pause(12); }
    window.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(to.x), y: Math.round(to.y), button: 'left', clickCount: 1, modifiers }); await pause(100);
  };
  const nativeClick = async selector => {
    const target = await box(selector), point = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    const hit = await run(`(()=>{const expected=document.querySelector(${JSON.stringify(selector)}),actual=document.elementFromPoint(${Math.round(point.x)},${Math.round(point.y)});return {matches:expected===actual||expected.contains(actual),actual:actual?.outerHTML?.slice(0,700),actualPointerEvents:actual&&getComputedStyle(actual).pointerEvents,target:expected?.outerHTML?.slice(0,350),targetPointerEvents:expected&&getComputedStyle(expected).pointerEvents,viewport:testFlow.getViewport()};})()`);
    assert.ok(hit.matches, 'Native control must be reachable: ' + selector + ' ' + JSON.stringify({target, hit}));
    await drag(point, point);
  };
  const panel = '[role="dialog"][aria-label="Notes for Order API"]';
  const noteButton = '[data-id="api"] button[aria-label="Notes for Order API"]';
  const notesField = panel + ' textarea[aria-label="Component notes"]';
  const mount = async options => { await run(`fixtureMount(${JSON.stringify(options)})`); await poll(() => exists('[data-id="api"] .diagram-architecture-face'), 'HLD nodes mounted'); await pause(100); };
  const assertShapeFirst = (metric, shapeSize, brandSize, label) => {
    assert.ok(metric.role, label + ' is missing its functional architecture shape');
    assert.equal(metric.role.width, shapeSize, label + ' shape width');
    assert.equal(metric.role.height, shapeSize, label + ' shape height');
    if (brandSize === null) { assert.equal(metric.brand, null, label + ' must not gain an unrelated brand badge'); return; }
    assert.ok(metric.brand, label + ' is missing its product badge');
    assert.equal(metric.brand.contentWidth, brandSize, label + ' product artwork width');
    assert.equal(metric.brand.contentHeight, brandSize, label + ' product artwork height');
    assert.ok(metric.role.width >= metric.brand.contentWidth * 2, label + ' architecture shape must dominate the product logo');
    assert.ok(metric.brand.left >= metric.role.left + shapeSize / 2 && metric.brand.top >= metric.role.top + shapeSize / 2, label + ' badge belongs at the lower-right');
    assert.ok(metric.brand.left < metric.role.right && metric.brand.top < metric.role.bottom, label + ' badge must overlay the shape corner, not sit beside it');
    assert.ok(Math.max(metric.role.right, metric.brand.right) - Math.min(metric.role.left, metric.brand.left) <= shapeSize + 8, label + ' composition must stay compact');
  };
  await poll(() => exists('[data-id="api"] .diagram-architecture-face'), 'HLD initial render');
  await pause(150);

  // Existing dimensions/positions/connection identities must survive changing
  // visual presentation; HLD remains an architecture graph, not a flow of cards.
  const initial = await run('fixtureState()');
  assert.equal(initial.nodes.length, 6); assert.equal(initial.edges.length, 5);
  const visuals = await run(`(()=>[...document.querySelectorAll('.diagram-architecture-face')].map(face=>{
    const style=getComputedStyle(face),glyph=face.querySelector('.diagram-component-glyph'),r=glyph.getBoundingClientRect();
    return {background:style.backgroundColor,shadow:style.boxShadow,border:style.borderTopWidth,glyphWidth:r.width,glyphHeight:r.height,notes:face.querySelectorAll('[aria-label="Component notes"]').length};
  }))()`);
  for (const visual of visuals) {
    assert.equal(visual.background, 'rgba(0, 0, 0, 0)', 'HLD face is still a filled card');
    assert.equal(visual.shadow, 'none', 'HLD face retains a card shadow');
    assert.ok(visual.glyphWidth >= 60 && visual.glyphHeight >= 60, 'Functional architecture shape must be prominent');
    assert.equal(visual.notes, 0, 'Notes must not occupy canvas space before opening');
  }
  assert.ok(await exists('[data-id="api"] .diagram-brand-glyph'));
  assert.equal(await run(`(()=>[...document.querySelectorAll('.diagram-architecture-node')].every(node=>{
    const note=node.querySelector('.diagram-component-notes-trigger').getBoundingClientRect();
    const handle=node.querySelector('.react-flow__handle-right').getBoundingClientRect();
    return note.right<=handle.left||note.left>=handle.right||note.bottom<=handle.top||note.top>=handle.bottom;
  }))()`), true, 'Notes buttons must not overlap connection handle hit targets');
  assert.ok(await exists('[data-id="worker"] .diagram-role-glyph'));
  assert.equal(await run(`document.querySelectorAll('[data-id="api"] .diagram-replica-layers > span').length`), 2);
  scenarios++;

  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await pause();
    for (const id of ['client', 'api', 'mongo', 'redis', 'topic', 'worker']) {
      assertShapeFirst(await run(`fixtureGlyphMetrics('[data-id="${id}"] .diagram-architecture-symbol > .diagram-component-glyph')`), 64, id === 'worker' ? null : 24, theme + ' canvas ' + id);
    }
    assert.equal(await run(`(()=>[...document.querySelectorAll('.diagram-architecture-symbol')].every(symbol=>{
      const note=symbol.querySelector('.diagram-component-notes-trigger').getBoundingClientRect();
      return [...symbol.querySelectorAll(':scope > .diagram-component-glyph > svg')].every(glyph=>{const r=glyph.getBoundingClientRect();return note.right<=r.left||note.left>=r.right||note.bottom<=r.top||note.top>=r.bottom;});
    }))()`), true, theme + ' notes controls must not overlap either the shape or product badge');
    const replicas = await run(`(()=>[...document.querySelectorAll('[data-id="api"] .diagram-replica-layers .diagram-component-glyph')].map(glyph=>({role:getComputedStyle(glyph.querySelector('.diagram-role-glyph')).display,brand:getComputedStyle(glyph.querySelector('.diagram-brand-glyph')).display})))()`);
    assert.equal(replicas.length, 2);
    for (const replica of replicas) { assert.notEqual(replica.role, 'none', 'Replica ghost repeats the functional shape'); assert.equal(replica.brand, 'none', 'Replica ghosts do not repeat vendor marks'); }
    const redis = await run(`fixtureGlyphMetrics('[data-id="redis"] .diagram-architecture-symbol > .diagram-component-glyph')`);
    const redisIcon = catalog.COMPONENT_BRAND_ICONS.Redis;
    assert.equal(redis.viewBox, redisIcon.viewBox);
    assert.deepEqual(redis.paths, redisIcon.paths.map(({ d, fill }) => ({ d, fill })), 'The canvas keeps the bundled Redis product artwork and its original colors');
    assert.ok(redis.paths.length > 3 && new Set(redis.paths.map(path => path.fill)).size >= 3, 'Redis is the multicolor stacked-block mark, not a single-color wordmark');
    scenarios++;
  }

  // Exercise the real insertion palette, and the supported compact catalog
  // styling, rather than inferring sizes from CSS source declarations.
  await click('.diagram-palette-tabs button[title="HLD"]');
  await poll(() => exists('.diagram-insert-library'), 'Component library opens');
  await click('.diagram-insert-sections button:last-child');
  await poll(() => exists('#insert-redis'), 'Built-in architecture essentials render');
  await run(`{
    const React=fixtureRequire('react'),{ComponentGlyph}=fixtureRequire('./DiagramNodes');
    window.compactFixture=document.createElement('div');compactFixture.className='diagram-studio';compactFixture.style.cssText='position:absolute;left:-10000px;top:0;width:340px';document.body.append(compactFixture);
    window.compactRoot=fixtureRequire('react-dom/client').createRoot(compactFixture);
    compactRoot.render(React.createElement('div',{className:'diagram-catalog'},...['redis','worker'].map(key=>React.createElement('button',{key,'data-compact-key':key},React.createElement(ComponentGlyph,{componentKey:key}),React.createElement('strong',null,key),React.createElement('small',null,'Architecture component')))));
  }`);
  await poll(() => exists('[data-compact-key="redis"] .diagram-brand-glyph'), 'Compact catalog mounts');
  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await pause();
    for (const key of ['redis', 'rabbitmq', 'docker', 'kubernetes', 'worker', 'cloud']) {
      assertShapeFirst(await run(`fixtureGlyphMetrics('#insert-${key} .diagram-component-glyph')`), 32, ['worker', 'cloud'].includes(key) ? null : 14, theme + ' picker ' + key);
    }
    for (const key of ['redis', 'worker']) assertShapeFirst(await run(`fixtureGlyphMetrics('[data-compact-key="${key}"] .diagram-component-glyph')`), 28, key === 'worker' ? null : 12, theme + ' compact ' + key);
    assert.equal(await run(`(()=>[...compactFixture.querySelectorAll('button')].every(button=>{
      const label=button.querySelector('strong').getBoundingClientRect();
      return [...button.querySelectorAll('.diagram-component-glyph>svg')].every(svg=>svg.getBoundingClientRect().right<=label.left);
    }))()`), true, 'Compact glyphs must not overlap labels');
    await fs.writeFile(path.join(temporary, 'hld-picker-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
    scenarios++;
  }
  await run('compactRoot.unmount();compactFixture.remove();');
  await click('[aria-label="Close component library"]');

  await click(noteButton); await poll(() => exists(panel), 'Notes opened');
  await poll(() => run(`document.activeElement?.getAttribute('aria-label')==='Component notes'`), 'Notes focused');
  assert.equal(await run(`document.querySelector(${JSON.stringify(notesField)}).value`), 'Validates orders before persistence.\nRetries are idempotent.');
  scenarios++;
  const editedNotes = 'Validate once.\nPersist to Mongo; publish order.created. <not executable>';
  await run(`(()=>{const input=document.querySelector(${JSON.stringify(notesField)});input.focus();input.select();})()`);
  await window.webContents.insertText(editedNotes);
  await poll(() => run(`fixtureState().nodes.find(node=>node.id==='api').data.description===${JSON.stringify(editedNotes)}`), 'Notes update');
  const afterNotes = await run('fixtureState()');
  assert.deepEqual(afterNotes.nodes.map(node => node.position), initial.nodes.map(node => node.position));
  assert.deepEqual(afterNotes.edges.map(edge => [edge.id, edge.source, edge.target]), initial.edges.map(edge => [edge.id, edge.source, edge.target]));
  assert.ok(afterNotes.saved, 'Notes update must be saved through the existing board channel');
  scenarios++;

  await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await poll(async () => !(await exists(panel)), 'Escape dismisses notes');
  assert.equal(await run(`document.activeElement===document.querySelector(${JSON.stringify(noteButton)})`), true);
  scenarios++;
  await click(noteButton);
  await run(`document.querySelector('.react-flow__pane').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  await poll(async () => !(await exists(panel)), 'Outside pointer dismisses notes');
  scenarios++;

  await click('[aria-label="Add replica to Order API"]');
  await poll(() => run(`fixtureState().nodes.find(node=>node.id==='api').data.replicas===4`), 'Add replica');
  await click('[aria-label="Remove replica from Order API"]');
  await poll(() => run(`fixtureState().nodes.find(node=>node.id==='api').data.replicas===3`), 'Remove replica');
  scenarios++;

  const saved = await run('fixtureState().saved');
  await mount({ snapshot: saved });
  await click(noteButton);
  assert.equal(await run(`document.querySelector(${JSON.stringify(notesField)}).value`), editedNotes, 'Existing descriptions must survive closing and reopening board');
  scenarios++;
  // Measure the actual popover, not just its CSS. Opening notes must not change
  // the node dimensions, move arrows, or require a permanent side panel.
  const geometry = await run(`(()=>{const panel=document.querySelector(${JSON.stringify(panel)}),r=panel.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`);
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height, 'Notes popover escaped viewport: ' + JSON.stringify(geometry));
  scenarios++;

  const themeBackgrounds = [];
  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await pause(100);
    const colors = await run(`(()=>{const panel=document.querySelector(${JSON.stringify(panel)});return {text:getComputedStyle(panel).color,background:getComputedStyle(panel).backgroundColor};})()`);
    assert.notEqual(colors.text, colors.background, 'Notes must have readable foreground in ' + theme);
    themeBackgrounds.push(colors.background);
    await fs.writeFile(path.join(temporary, 'hld-notes-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`); await pause();
    await fs.writeFile(path.join(temporary, 'hld-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
    await click(noteButton); scenarios++;
  }
  assert.notEqual(themeBackgrounds[0], themeBackgrounds[1], 'An open notes popover must follow theme changes');

  await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));testFlow.setViewport({x:10,y:10,zoom:.2})`); await pause();
  await click(noteButton); await poll(() => exists(panel), 'Zoomed-out notes opened');
  const zoomedNotes = await run(`(()=>{const panel=document.querySelector(${JSON.stringify(panel)}),r=panel.getBoundingClientRect();return {width:r.width,fontSize:parseFloat(getComputedStyle(panel.querySelector('textarea')).fontSize)};})()`);
  assert.ok(zoomedNotes.width >= 280 && zoomedNotes.fontSize >= 12, 'Notes should remain readable at architecture overview zoom: ' + JSON.stringify(zoomedNotes));
  scenarios++;

  // Desktop font scaling uses CSS zoom on body independently of XYFlow's
  // viewport scale. A screen-space notes panel must cancel that inherited
  // scale, remain readable, and fit a small window even when already open.
  for (const [width, height] of [[1440, 960], [480, 640]]) {
    window.setSize(width, height);
    await pause(100);
    for (const zoom of [.8, 1.25, 2]) {
      await run(`document.body.style.zoom=${JSON.stringify(String(zoom))}`);
      await pause(150);
      const measured = await run(`(()=>{
        const panel=document.querySelector(${JSON.stringify(panel)}),r=panel.getBoundingClientRect(),field=panel.querySelector('textarea');
        const effectiveZoom=r.width/panel.offsetWidth;
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,viewportWidth:innerWidth,viewportHeight:innerHeight,fontPixels:parseFloat(getComputedStyle(field).fontSize)*effectiveZoom,bodyZoom:getComputedStyle(document.body).zoom};
      })()`);
      const detail = JSON.stringify({ width, height, zoom, measured });
      assert.ok(measured.left >= -.5 && measured.right <= measured.viewportWidth + .5 && measured.top >= -.5 && measured.bottom <= measured.viewportHeight + .5, 'Scaled notes escaped viewport: ' + detail);
      assert.ok(measured.width >= 280 && measured.width <= 322, 'Body font scale changed notes screen-space width: ' + detail);
      assert.ok(measured.fontPixels >= 12, 'Body font scale made notes unreadable: ' + detail);
      await fs.writeFile(path.join(temporary, `hld-notes-${width}-zoom-${zoom}.png`), (await window.webContents.capturePage()).toPNG());
      scenarios++;
    }
  }
  await run('document.body.style.zoom="1"'); window.setSize(1440, 960); await pause(100);

  await mount({ readOnly: true, snapshot: saved });
  assert.equal(await run(`document.querySelector(${JSON.stringify(noteButton)}).matches(':disabled')`), false, 'Viewer must be able to read notes');
  await click(noteButton); await poll(() => exists(panel), 'Viewer notes opened');
  assert.equal(await run(`/notes/i.test(document.querySelector(${JSON.stringify(panel)}).textContent)`), true);
  assert.equal(await run(`(()=>{const field=document.querySelector(${JSON.stringify(notesField)});return field?field.readOnly||field.matches(':disabled'):document.querySelector(${JSON.stringify(panel)}).textContent.includes(${JSON.stringify(editedNotes)});})()`), true, 'Viewer notes must be readable but immutable');
  assert.equal(await run(`Boolean(document.querySelector('[data-id="api"] [aria-label="Component name"]')?.readOnly||document.querySelector('[data-id="api"] [aria-label="Component name"]')?.matches(':disabled'))`), true);
  const viewerBefore = await run('fixtureState()');
  await run(`(()=>{const input=document.querySelector(${JSON.stringify(notesField)});if(input){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'FORBIDDEN');input.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('[aria-label="Add replica to Order API"]')?.click();})()`); await pause();
  const viewerAfter = await run('fixtureState()');
  assert.equal(viewerAfter.saves, viewerBefore.saves, 'Viewer actions must never persist');
  assert.deepEqual(viewerAfter.nodes, viewerBefore.nodes);
  scenarios++;

  // Expanded notes is a reversible reading projection, not a destructive
  // relayout. Editing a note must still save only the original compact graph.
  await mount({ snapshot: saved });
  const compactBefore = await run('fixtureState()');
  await click('[aria-label="Expand all component notes"]');
  await poll(() => run(`document.querySelectorAll('.diagram-component-inline-notes').length===6`), 'All component notes expand');
  await pause(160);
  assert.equal(await run(`document.querySelector('[aria-label="Collapse component notes"]').getAttribute('aria-pressed')`), 'true');
  assert.equal(await run('fixtureState().saves'), compactBefore.saves, 'Entering expanded view must not persist its projection');
  assert.equal(await run(`document.querySelector('[data-id="api"] .diagram-component-inline-notes').value`), editedNotes);
  for (const label of ['Group selection', 'Duplicate selection', 'Delete selection']) assert.equal(await run(`document.querySelector('[aria-label="${label}"]').disabled`), true, 'Arrangement actions are disabled in expanded view');
  const expandedNote = 'Validate once. Preserve idempotency while processing each order.\n' + 'Persist to Mongo, publish order.created, then retry failed delivery without duplicating business effects. '.repeat(5);
  await run(`document.querySelector('[data-id="api"] .diagram-component-inline-notes').focus();document.querySelector('[data-id="api"] .diagram-component-inline-notes').select();`);
  await window.webContents.insertText(expandedNote);
  await poll(() => run(`fixtureState().saved?.nodes.find(node=>node.id==='api').data.description===${JSON.stringify(expandedNote)}`), 'Expanded note saves through board channel');
  const expandedSaved = await run('fixtureState().saved');
  assert.deepEqual(expandedSaved.nodes.map(node => [node.id, node.position, node.style]), saved.nodes.map(node => [node.id, node.position, node.style]), 'Editing expanded notes must not save display-only positions or dimensions');
  assert.ok(expandedSaved.nodes.every(node => !node.data.expandedNotes), 'Display-only expansion metadata never enters persisted board data');
  assert.deepEqual(expandedSaved.edges, saved.edges);
  // Re-entering after the long edit must fit all regions. Do not require an
  // automatic zoom while typing, which would move the editor under the cursor.
  await click('[aria-label="Collapse component notes"]');
  await click('[aria-label="Expand all component notes"]');
  await poll(() => exists('.diagram-component-inline-notes'), 'Expanded view reopens after long note edit'); await pause(160);
  const expandedColors = [];
  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await pause(100);
    const notes = await run(`(()=>[...document.querySelectorAll('.diagram-component-inline-notes')].map(field=>{
      const r=field.getBoundingClientRect(),face=field.closest('.diagram-architecture-face'),fr=face.getBoundingClientRect(),glyph=face.querySelector('.diagram-component-glyph').getBoundingClientRect(),style=getComputedStyle(field);
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,face:{left:fr.left,right:fr.right,top:fr.top,bottom:fr.bottom},glyphRight:glyph.right,scrollHeight:field.scrollHeight,clientHeight:field.clientHeight,color:style.color,background:style.backgroundColor};
    }))()`);
    for (const note of notes) {
      assert.ok(note.left > note.glyphRight && note.left >= note.face.left && note.right <= note.face.right + .5 && note.top >= note.face.top && note.bottom <= note.face.bottom + .5, 'Expanded note stays beside its own shape within its allocated region');
      assert.ok(note.scrollHeight <= note.clientHeight + 2, 'Expanded note must not truncate or hide overflow');
      assert.notEqual(note.color, note.background, 'Expanded notes remain readable in ' + theme);
      assert.equal(note.background, 'rgba(0, 0, 0, 0)', 'Expanded notes preserve the canvas or colored-group background');
    }
    const faces = notes.map(note => note.face);
    for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
      const a = faces[i], b = faces[j];
      assert.ok(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom, 'Expanded note regions must not overlap');
    }
    const routedLabels = await run(`(()=>{
      const bounds=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
      return {canvas:bounds(document.querySelector('.diagram-flow')),labels:[...document.querySelectorAll('.diagram-edge-label')].map(label=>{
        const field=label.querySelector('[aria-label="Connection label"]'),style=getComputedStyle(field);
        return {...bounds(label),text:field.value,scrollHeight:field.scrollHeight,clientHeight:field.clientHeight,scrollWidth:field.scrollWidth,clientWidth:field.clientWidth,style:{font:style.font,fontSize:style.fontSize,lineHeight:style.lineHeight,padding:style.padding,border:style.border,boxSizing:style.boxSizing,width:style.width,height:style.height}};
      })};
    })()`);
    await fs.writeFile(path.join(temporary, 'hld-expanded-labels-' + theme + '.json'), JSON.stringify(routedLabels, null, 2));
    assert.deepEqual(routedLabels.labels.map(label => label.text).sort(), saved.edges.map(edge => edge.data.label).sort(), 'Expanded routes retain every relationship label');
    const apart = (a, b) => a.right <= b.left + .5 || a.left >= b.right - .5 || a.bottom <= b.top + .5 || a.top >= b.bottom - .5;
    for (let index = 0; index < routedLabels.labels.length; index++) {
      const label = routedLabels.labels[index], diagnostic = theme + ' expanded edge ' + JSON.stringify(label);
      for (const face of faces) assert.ok(apart(label, face), 'Relationship label overlaps a component/notes region: ' + diagnostic);
      for (const other of routedLabels.labels.slice(index + 1)) assert.ok(apart(label, other), 'Relationship labels overlap each other: ' + diagnostic);
      assert.ok(label.scrollHeight <= label.clientHeight + 1 && label.scrollWidth <= label.clientWidth + 1, 'Relationship label text must remain fully readable: ' + diagnostic);
      assert.ok(label.left >= routedLabels.canvas.left - .5 && label.right <= routedLabels.canvas.right + .5 && label.top >= routedLabels.canvas.top - .5 && label.bottom <= routedLabels.canvas.bottom + .5, 'Expanded fit must include routed label extents: ' + diagnostic);
    }
    expandedColors.push(notes[0].color);
    await fs.writeFile(path.join(temporary, 'hld-expanded-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
    scenarios++;
  }
  assert.notEqual(expandedColors[0], expandedColors[1]);
  await click('[aria-label="Collapse component notes"]');
  await poll(async () => !(await exists('.diagram-component-inline-notes')), 'Compact view restores'); await pause(160);
  const compactAfter = await run('fixtureState()');
  assert.deepEqual(compactAfter.nodes.map(node => [node.id, node.position, node.style]), compactBefore.nodes.map(node => [node.id, node.position, node.style]), 'Collapse restores the exact compact node geometry');
  for (const key of ['x', 'y', 'zoom']) assert.ok(Math.abs(compactAfter.viewport[key] - compactBefore.viewport[key]) < .01, 'Collapse restores saved viewport ' + key);
  assert.equal(compactAfter.nodes.find(node => node.id === 'api').data.description, expandedNote);
  await mount({ snapshot: expandedSaved, readOnly: true });
  await click('[aria-label="Expand all component notes"]');
  await poll(() => exists('.diagram-component-inline-notes'), 'Read-only viewer can expand notes');
  assert.equal(await run(`document.querySelector('[data-id="api"] .diagram-component-inline-notes').value`), expandedNote);
  assert.equal(await run(`[...document.querySelectorAll('.diagram-component-inline-notes')].every(field=>field.readOnly||field.matches(':disabled'))`), true);
  await click('[aria-label="Collapse component notes"]');
  assert.equal(await run('fixtureState().saves'), 0, 'Viewer note expansion/collapse never persists');
  scenarios++;

  // Colored groups remain background frames: their contents and relations
  // retain their identities, and moving a frame moves every member together.
  await mount({ snapshot: saved });
  const selectNode = async (id, extend = false) => {
    const target = await box(`[data-id="${id}"] .diagram-architecture-symbol > .diagram-component-glyph`), point = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    if (extend) window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] });
    await drag(point, point, extend ? ['shift'] : []);
    if (extend) window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
  };
  await selectNode('client'); await selectNode('api', true);
  await poll(() => run(`fixtureState().nodes.filter(node=>node.selected).length===2`), 'Two components selected for grouping');
  const beforeGroup = await run('fixtureState()');
  await click('[aria-label="Group selection"]');
  await poll(() => exists('.diagram-group-node'), 'Colored group created');
  const grouped = await run('fixtureState()'), group = grouped.nodes.find(node => node.type === 'group');
  assert.ok(group);
  assert.deepEqual([...group.data.memberIds].sort(), ['api', 'client']);
  assert.deepEqual(grouped.nodes.filter(node => node.type !== 'group').map(node => [node.id, node.position]), beforeGroup.nodes.map(node => [node.id, node.position]), 'Grouping must not reposition existing components');
  assert.deepEqual(grouped.edges, beforeGroup.edges, 'Grouping must not replace connections');
  const groupSelector = `[data-id="${group.id}"]`;
  const groupWrapper = await run(`(()=>{const style=getComputedStyle(document.querySelector(${JSON.stringify(groupSelector)}));return {background:style.backgroundColor,border:style.borderTopWidth,padding:style.paddingTop};})()`);
  assert.deepEqual(groupWrapper, { background: 'rgba(0, 0, 0, 0)', border: '0px', padding: '0px' }, 'Custom colored frame must not acquire XYFlow default group-card chrome');
  await nativeClick(groupSelector + ' [aria-label="Group color"]');
  await nativeClick(groupSelector + ' [aria-label="Green group"]');
  assert.equal(await run(`fixtureState().nodes.find(node=>node.id===${JSON.stringify(group.id)}).data.color`), await run(`fixtureRequire('./diagram-groups.mjs').GROUP_COLORS[1]`));
  assert.equal(await exists(groupSelector + ' .diagram-group-colors'), false, 'Color picker dismisses after selection');
  scenarios++;

  const beforeMove = await run('fixtureState()'), grip = await box(groupSelector + ' .diagram-group-drag-mark');
  await drag({ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, { x: grip.x + grip.width / 2 + 64, y: grip.y + grip.height / 2 + 48 });
  const afterMove = await run('fixtureState()'), movedGroup = afterMove.nodes.find(node => node.id === group.id);
  const delta = { x: movedGroup.position.x - group.position.x, y: movedGroup.position.y - group.position.y };
  assert.ok(Math.abs(delta.x) > 16 && Math.abs(delta.y) > 16, 'Native group-header drag must move the frame');
  for (const prior of beforeMove.nodes.filter(node => node.type !== 'group')) {
    const next = afterMove.nodes.find(node => node.id === prior.id), member = group.data.memberIds.includes(prior.id);
    assert.deepEqual(next.position, { x: prior.position.x + (member ? delta.x : 0), y: prior.position.y + (member ? delta.y : 0) }, 'Group movement preserves every member offset without moving unrelated nodes');
  }
  assert.deepEqual(afterMove.edges, beforeMove.edges);
  scenarios++;

  const apiGlyph = await box('[data-id="api"] .diagram-architecture-symbol > .diagram-component-glyph');
  await drag({ x: apiGlyph.x + apiGlyph.width / 2, y: apiGlyph.y + apiGlyph.height / 2 }, { x: apiGlyph.x + apiGlyph.width / 2 + 176, y: apiGlyph.y + apiGlyph.height / 2 + 96 });
  const beforeFit = await run('fixtureState()');
  assert.notDeepEqual(beforeFit.nodes.find(node => node.id === 'api').position, afterMove.nodes.find(node => node.id === 'api').position, 'Visible component glyph remains draggable independently of its group');
  await nativeClick(groupSelector + ' [aria-label="Fit group to contents"]');
  const afterFit = await run('fixtureState()');
  assert.deepEqual(afterFit.nodes.filter(node => node.type !== 'group').map(node => [node.id, node.position]), beforeFit.nodes.filter(node => node.type !== 'group').map(node => [node.id, node.position]), 'Fit group may resize its frame but never move members');
  const frame = await box(groupSelector);
  for (const id of group.data.memberIds) {
    const painted = await run(`(()=>{
      const node=document.querySelector('[data-id="${id}"]'),rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
      const parts=[...node.querySelectorAll('.diagram-architecture-symbol .diagram-component-glyph>svg,.diagram-component-notes-trigger,.diagram-replica-count,.diagram-replica-actions')].filter(element=>{const style=getComputedStyle(element);return style.display!=='none'&&Number(style.opacity)>0;}).map(element=>({kind:element.getAttribute('class'),...rect(element)}));
      // Textarea editing hit areas deliberately remain wide. Measure its paint
      // with the same font/wrapping, not that transparent editor rectangle.
      const field=node.querySelector('.diagram-node-name'),style=getComputedStyle(field),fieldRect=field.getBoundingClientRect(),mirror=document.createElement('span');
      Object.assign(mirror.style,{position:'fixed',display:'block',left:fieldRect.left+'px',top:fieldRect.top+'px',width:fieldRect.width+'px',height:'auto',boxSizing:style.boxSizing,padding:style.padding,font:style.font,lineHeight:style.lineHeight,letterSpacing:style.letterSpacing,textAlign:style.textAlign,whiteSpace:'pre-wrap',overflowWrap:'break-word'});
      mirror.textContent=field.value;document.body.append(mirror);const text=document.createRange();text.selectNodeContents(mirror);parts.push({kind:'name text',...rect(text)});mirror.remove();return parts;
    })()`);
    for (const part of painted) assert.ok(part.left > frame.x && part.top > frame.y + 30 && part.right < frame.right && part.bottom < frame.bottom, 'Fit group encloses painted ' + id + ' content below its header: ' + JSON.stringify({ frame, part }));
  }
  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await pause();
    assert.equal(await run(`getComputedStyle(document.querySelector(${JSON.stringify(groupSelector + ' .diagram-group-node')})).getPropertyValue('--group-color').trim()`), afterFit.nodes.find(node => node.id === group.id).data.color);
    await fs.writeFile(path.join(temporary, 'hld-group-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
    scenarios++;
  }
  const groupSnapshot = await run('fixtureState().saved');
  await mount({ snapshot: groupSnapshot, readOnly: true });
  assert.equal(await exists(groupSelector + ' [aria-label="Group color"]'), false);
  assert.equal(await run(`document.querySelector(${JSON.stringify(groupSelector + ' [aria-label="Group name"]')}).readOnly`), true);
  assert.equal(await run('fixtureState().saves'), 0, 'Viewing grouped board cannot mutate it');
  await mount({ snapshot: groupSnapshot });
  const beforeUngroup = await run('fixtureState()');
  await nativeClick(groupSelector + ' [aria-label="Ungroup without deleting contents"]');
  await poll(async () => !(await exists('.diagram-group-node')), 'Ungroup removes only background frame');
  const afterUngroup = await run('fixtureState()');
  assert.deepEqual(afterUngroup.nodes.map(node => [node.id, node.position, node.data]), beforeUngroup.nodes.filter(node => node.type !== 'group').map(node => [node.id, node.position, node.data]));
  assert.deepEqual(afterUngroup.edges, beforeUngroup.edges);
  scenarios++;

  // Legacy boards may retain a very large transparent component wrapper. A
  // tightly fitted frame must surround the painted symbol, not that wrapper,
  // and its header controls must still receive actual mouse input.
  const legacySnapshot = { nodes: [{ id: 'api', type: 'component', position: { x: 160, y: 120 }, style: { width: 500, height: 400 }, data: { name: 'Hot cache', componentKey: 'redis', description: 'Legacy board geometry remains untouched.', replicas: 1 } }], edges: [], viewport: { x: 20, y: 10, zoom: 1 } };
  await mount({ snapshot: legacySnapshot });
  await selectNode('api');
  await click('[aria-label="Group selection"]');
  await poll(() => exists('.diagram-group-node'), 'Oversized legacy component can be grouped');
  const legacyGroup = (await run('fixtureState()')).nodes.find(node => node.type === 'group');
  const legacyGroupSelector = `[data-id="${legacyGroup.id}"]`;
  assert.ok(legacyGroup.style.width < 260 && legacyGroup.style.height < 260, 'Group bounds fit painted content rather than legacy 500 by 400 wrapper');
  await nativeClick(legacyGroupSelector + ' [aria-label="Group color"]');
  await nativeClick(legacyGroupSelector + ' [aria-label="Purple group"]');
  await nativeClick(legacyGroupSelector + ' [aria-label="Fit group to contents"]');
  const legacyAfterFit = await run('fixtureState()');
  assert.deepEqual(legacyAfterFit.nodes.find(node => node.id === 'api').style, legacySnapshot.nodes[0].style, 'Tight groups do not rewrite oversized saved component geometry');
  const legacyGrip = await box(legacyGroupSelector + ' .diagram-group-drag-mark');
  await drag({ x: legacyGrip.x + legacyGrip.width / 2, y: legacyGrip.y + legacyGrip.height / 2 }, { x: legacyGrip.x + legacyGrip.width / 2 + 64, y: legacyGrip.y + legacyGrip.height / 2 + 48 });
  assert.notDeepEqual((await run('fixtureState()')).nodes.find(node => node.id === 'api').position, legacySnapshot.nodes[0].position, 'Legacy component travels with its visible group-header drag');
  await fs.writeFile(path.join(temporary, 'hld-group-legacy-light.png'), (await window.webContents.capturePage()).toPNG());
  await nativeClick(legacyGroupSelector + ' [aria-label="Ungroup without deleting contents"]');
  await poll(async () => !(await exists('.diagram-group-node')), 'Legacy component group can be removed with native input');
  assert.equal((await run('fixtureState()')).nodes.length, 1);
  scenarios++;

  // All documented visual forms use their real silhouette, share the notes
  // contract, and place connections on that silhouette instead of a hidden
  // generic architecture card. No existing board is involved in this test.
  await run(`{
    const visuals=fixtureRequire('./diagram-visuals.mjs').DIAGRAM_VISUALS;
    window.visualSnapshot={nodes:[...visuals.map((item,index)=>({id:'visual-'+index,type:'component',position:{x:(index%4)*400,y:Math.floor(index/4)*400},style:{width:item.width,height:item.height},data:{name:item.label,componentKey:item.id,description:'Notes for '+item.label,replicas:1}})),{id:'eraser-cloud',type:'component',position:{x:0,y:1650},style:{width:240,height:180},data:{name:'Cloud function',componentKey:'eraser:aws-lambda',description:'On-demand compute',replicas:1}},{id:'eraser-general',type:'component',position:{x:400,y:1650},style:{width:240,height:180},data:{name:'Generic database',componentKey:'eraser:database',description:'Canonical data',replicas:1}}],edges:visuals.slice(1).map((item,index)=>({id:'visual-edge-'+index,source:'visual-'+index,target:'visual-'+(index+1),sourceHandle:'right',targetHandle:'left',type:'relation',data:{relation:'association',label:'Connect'}})),viewport:{x:20,y:40,zoom:.42}};
    visualSnapshot.nodes.push({id:'eraser-redis',type:'component',position:{x:800,y:1650},style:{width:240,height:180},data:{name:'Redis tech mark',componentKey:'eraser:redis',description:'Saved Redis ID uses the classic product mark',replicas:1}},{id:'eraser-vendor',type:'component',position:{x:1200,y:1650},style:{width:240,height:180},data:{name:'GitHub tech mark',componentKey:'eraser:github',description:'Monochrome vendor mark',replicas:1}});
    fixtureMount({snapshot:visualSnapshot});
  }`);
  await poll(() => run(`document.querySelectorAll('.diagram-visual-node').length===16`), 'All shape and frame nodes rendered'); await pause(150);
  const visualGeometry = await run(`(()=>{
    const {getVisualGeometry}=fixtureRequire('./diagram-visuals.mjs'),{getDiagramComponent}=fixtureRequire('./diagram-catalog.mjs');
    return [...document.querySelectorAll('.diagram-visual-node')].map(node=>{
      const id=node.closest('[data-id]').dataset.id,item=testFlow.getNode(id),component=getDiagramComponent(item.data.componentKey),geo=getVisualGeometry(component,item.measured?.width||item.width||item.style.width,item.measured?.height||item.height||item.style.height);
      return {id,kind:node.dataset.visualKind,form:node.dataset.visualForm,background:getComputedStyle(node).backgroundColor,label:node.querySelector('[aria-label="Component name"]').value,outline:node.querySelector('.diagram-visual-outline')?.getAttribute('viewBox'),expectedOutline:'0 0 '+geo.width+' '+geo.height,ports:[...node.querySelectorAll('.react-flow__handle')].map(handle=>({side:handle.dataset.handleid,left:parseFloat(handle.style.left),top:parseFloat(handle.style.top),expected:geo.ports[handle.dataset.handleid]}))};
    });
  })()`);
  for (const visual of visualGeometry) {
    assert.equal(visual.background, 'rgba(0, 0, 0, 0)', `${visual.form} retains a card background`);
    assert.equal(visual.outline, visual.expectedOutline, `${visual.form} geometry dimensions`);
    assert.ok(visual.label);
    for (const port of visual.ports) { assert.ok(Math.abs(port.left - port.expected[0]) < .01); assert.ok(Math.abs(port.top - port.expected[1]) < .01); }
    await click(`[data-id="${visual.id}"] .diagram-component-notes-trigger`);
    await poll(() => run(`Boolean(document.querySelector('.diagram-component-notes textarea'))`), `${visual.form} notes open`);
    assert.equal(await run(`document.querySelector('.diagram-component-notes textarea').value`), 'Notes for ' + visual.label);
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`); await pause(20);
    scenarios++;
  }
  await click('[data-id="visual-0"] .diagram-component-notes-trigger');
  await poll(() => run(`document.activeElement?.getAttribute('aria-label')==='Component notes'`), 'Shape notes focus');
  await run(`document.querySelector('.diagram-component-notes textarea').select()`); await window.webContents.insertText('Edited shape notes, saved with the board.');
  await poll(() => run(`fixtureState().nodes.find(node=>node.id==='visual-0').data.description==='Edited shape notes, saved with the board.'`), 'Shape notes persist');
  await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  const savedVisuals = await run('fixtureState().saved');
  assert.equal(savedVisuals.edges.length, 15);
  assert.equal(await exists('[data-id="eraser-cloud"] img.diagram-eraser-icon'), true);
  assert.equal(await exists('[data-id="eraser-general"] .diagram-eraser-monochrome'), true);
  assert.equal(await exists('[data-id="eraser-vendor"] .diagram-eraser-monochrome'), true, 'Monochrome tech/vendor marks use actual asset paint metadata, not just the General category');
  assert.equal(await exists('[data-id="eraser-vendor"] img.diagram-eraser-icon'), false);
  const savedRedis = await run(`fixtureGlyphMetrics('[data-id="eraser-redis"] .diagram-architecture-symbol > .diagram-component-glyph')`);
  assert.ok(savedRedis.role, 'Existing Redis IDs gain the same large cache shape');
  assert.equal(savedRedis.viewBox, catalog.COMPONENT_BRAND_ICONS.Redis.viewBox);
  assert.deepEqual(savedRedis.paths, catalog.COMPONENT_BRAND_ICONS.Redis.paths.map(({ d, fill }) => ({ d, fill })), 'Existing Redis IDs retain the stacked product artwork without a remote dependency');
  assert.equal(await exists('[data-id="eraser-redis"] .diagram-eraser-icon'), false);
  assert.equal(await run(`document.querySelectorAll('[data-id="eraser-cloud"] .diagram-role-glyph').length`), 0, 'Eraser asset must not gain a second unrelated role icon');
  const iconInks = [];
  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await pause(100);
    const ink = await run(`getComputedStyle(document.querySelector('[data-id="eraser-general"] .diagram-eraser-monochrome')).backgroundColor`);
    const vendorInk = await run(`getComputedStyle(document.querySelector('[data-id="eraser-vendor"] .diagram-eraser-monochrome')).backgroundColor`);
    assert.equal(vendorInk, ink, 'Monochrome vendor marks follow the same theme ink as general icons');
    iconInks.push(ink);
    assert.notEqual(ink, 'rgba(0, 0, 0, 0)');
    await fs.writeFile(path.join(temporary, 'visual-library-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
    scenarios++;
  }
  assert.notEqual(iconInks[0], iconInks[1], 'Monochrome icons must follow dark/light text ink');
  await run(`fixtureMount({readOnly:true,snapshot:${JSON.stringify(savedVisuals)}})`);
  await poll(() => exists('[data-id="visual-0"] .diagram-visual-face'), 'Read-only visual board'); await pause(100);
  await click('[data-id="visual-0"] .diagram-component-notes-trigger');
  await poll(() => exists('.diagram-component-notes-readonly'), 'Viewer shape notes');
  assert.equal(await run(`document.querySelector('.diagram-component-notes-readonly').textContent`), 'Edited shape notes, saved with the board.');
  assert.equal(await run(`[...document.querySelectorAll('.diagram-visual-node [aria-label="Component name"]')].every(input=>input.readOnly)`), true);
  assert.equal(await run('fixtureState().saves'), 0, 'Read-only shape notes cannot mutate the shared board');
  scenarios++;

  await run(`{
    const keys=['sharding','consistent-hashing','load-balancer-l4','load-balancer-l7'],catalog=fixtureRequire('./diagram-catalog.mjs');
    window.conceptSnapshot={nodes:keys.map((key,index)=>({id:key,type:'component',position:{x:40+index*300,y:180},style:{width:260,height:200},data:{name:catalog.getDiagramComponent(key).label,componentKey:key,description:catalog.getDiagramComponent(key).description,replicas:1}})),edges:[],viewport:{x:20,y:40,zoom:1}};
    fixtureMount({snapshot:conceptSnapshot});
  }`);
  await poll(() => run(`document.querySelectorAll('[data-architecture-symbol]').length===4`), 'All four offline architecture concepts rendered'); await pause(100);
  const conceptInks = {};
  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await pause(100);
    const glyphs = await run(`(()=>[...document.querySelectorAll('[data-architecture-symbol]')].map(glyph=>{
      const box=glyph.getBoundingClientRect(),face=glyph.closest('.diagram-architecture-face');
      return {key:glyph.dataset.architectureSymbol,width:box.width,height:box.height,color:getComputedStyle(glyph).color,background:getComputedStyle(face).backgroundColor,paths:[...glyph.querySelectorAll('path')].map(path=>path.getAttribute('d')).join('|'),text:glyph.textContent};
    }))()`);
    assert.equal(new Set(glyphs.map(glyph => glyph.paths)).size, 4, 'The four concepts cannot be aliases for the same generic symbol');
    for (const glyph of glyphs) {
      assert.equal(glyph.width, 64); assert.equal(glyph.height, 64);
      assert.equal(glyph.background, 'rgba(0, 0, 0, 0)');
      if (theme === 'dark') conceptInks[glyph.key] = glyph.color;
      else assert.notEqual(glyph.color, conceptInks[glyph.key], glyph.key + ' adapts its ink in light mode');
      if (glyph.key.startsWith('load-balancer-')) assert.equal(glyph.text, glyph.key.endsWith('l4') ? 'L4' : 'L7');
    }
    await fs.writeFile(path.join(temporary, 'architecture-concepts-' + theme + '.png'), (await window.webContents.capturePage({ x: 20, y: 180, width: 1340, height: 350 })).toPNG());
    scenarios++;
  }
  for (const key of ['sharding', 'consistent-hashing', 'load-balancer-l4', 'load-balancer-l7']) {
    await click(`[data-id="${key}"] .diagram-component-notes-trigger`);
    await poll(() => exists('.diagram-component-notes textarea'), key + ' notes open');
    assert.match(await run(`document.querySelector('.diagram-component-notes textarea').value`), /Vendor-neutral architecture symbol/);
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`); await pause(20);
    scenarios++;
  }
  await click('[data-id="sharding"] .diagram-component-notes-trigger');
  await poll(() => run(`document.activeElement?.getAttribute('aria-label')==='Component notes'`), 'Sharding notes focus');
  await run(`document.querySelector('.diagram-component-notes textarea').select()`); await window.webContents.insertText('Shard by customer id; keep this design note.');
  await poll(() => run(`fixtureState().nodes.find(node=>node.id==='sharding').data.description==='Shard by customer id; keep this design note.'`), 'Sharding notes saved');
  const savedConcepts = await run('fixtureState().saved');
  await run(`fixtureMount({readOnly:true,snapshot:${JSON.stringify(savedConcepts)}})`);
  await poll(() => exists('[data-id="sharding"] [data-architecture-symbol="sharding"]'), 'Read-only concept board'); await pause(80);
  await click('[data-id="sharding"] .diagram-component-notes-trigger');
  await poll(() => exists('.diagram-component-notes-readonly'), 'Read-only concept notes');
  assert.equal(await run(`document.querySelector('.diagram-component-notes-readonly').textContent`), 'Shard by customer id; keep this design note.');
  assert.equal(await run('fixtureState().saves'), 0);
  scenarios++;
  assert.deepEqual(await run('fixtureErrors'), []);
  assert.deepEqual(errors.filter(error => /ReferenceError|TypeError|Minified React error|Refused to/.test(error)), []);
  assert.equal(networkRequests, 0);
  console.log('DIAGRAM_HLD_RESULT=' + JSON.stringify({ ok: true, scenarios, networkRequests, screenshots: temporary })); finish(0);
}).catch(async error => {
  console.error(error.stack || error); console.error(JSON.stringify(errors));
  if (window && !window.isDestroyed()) {
    console.error(await window.webContents.executeJavaScript(`JSON.stringify({active:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label'),panel:document.querySelector('.diagram-component-notes')?.outerHTML})`).catch(() => 'Diagnostic unavailable'));
    await fs.writeFile(path.join(temporary, 'hld-failure.png'), (await window.webContents.capturePage()).toPNG()).catch(() => {});
  }
  finish(1);
});
