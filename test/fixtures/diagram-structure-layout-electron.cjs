// Production node JSX/CSS, isolated Chromium profile; no real Argus state.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const temporary = process.argv[2], root = path.resolve(__dirname, '../..');
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-structure-layout-')) throw new Error('Isolated fixture required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0;
const timer = setTimeout(() => { console.error('Structure layout timed out'); app.exit(1); }, 50_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };

app.whenReady().then(async () => {
  const structures = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-structures.mjs')));
  const types = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-structure-types.mjs')));
  const geometry = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-structure-layout.mjs')));
  const source = await fs.readFile(path.join(root, 'frontend/features/diagrams/DiagramStructureNode.jsx'), 'utf8');
  const styles = (await Promise.all(['diagram-nodes.css','diagram-structures.css'].map(file => fs.readFile(path.join(root, 'frontend/features/diagrams', file), 'utf8')))).join('\n');
  const compiled = ts.transpileModule(source, { compilerOptions:{ jsx:ts.JsxEmit.ReactJSX, module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true } }).outputText;
  const actions = React.createContext({ updateNode() {} });
  let stateIndex = 0, open = false;
  const context = vm.createContext({ exports:{}, require(name) {
    if (name === 'react') return { ...React, useState(initial) { return React.useState(stateIndex++ === 0 && open ? true : initial); } };
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@xyflow/react') return { Handle:() => null, NodeResizer:() => null, Position:{ Top:'top', Right:'right', Bottom:'bottom', Left:'left' }, useUpdateNodeInternals:() => () => {} };
    if (name === './DiagramNodes') return { DiagramNodeActionsContext:actions };
    if (name === './diagram-structures.mjs') return structures;
    if (name === './diagram-structure-types.mjs') return types;
    if (name === './diagram-structure-layout.mjs') return geometry;
    if (name === './useDiagramPopover') return { useDiagramPopover:() => () => {} };
    if (name.endsWith('.css')) return {};
    throw new Error('Unexpected import '+name);
  }});
  vm.runInContext(compiled, context);
  const isolated = session.fromPartition('structure-layout-regression', { cache:false });
  isolated.setPermissionRequestHandler((_c,_p,callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls:['http://*/*','https://*/*'] }, (_d,callback) => { networkRequests++; callback({cancel:true}); });
  window = new BrowserWindow({show:false,width:1600,height:1100,webPreferences:{session:isolated,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const shell = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>:root{--text:#eceff4;--surface:#171b22;--surface-2:#212833;--surface-3:#28313e;--line:#303a48;--muted:#a0abba;--muted-2:#718099;--accent:#d5ff52;--orange:#ffbb77;--blue:#83b6ff;--red:#ff6875}body{margin:0;font:12px system-ui;background:#101319}#shell{position:absolute;left:20px;top:20px}${styles}</style></head><body><div id="shell"></div></body></html>`;
  const fixtureHtml=path.join(temporary,'structure-layout.html');await fs.writeFile(fixtureHtml,shell);await window.loadFile(fixtureHtml);
  let scenarios = 0;
  for (const kind of structures.STRUCTURE_KINDS) for (const count of [0, 3, 128]) {
    const data = { ...structures.createStructureData(kind.id), name:'A very long structure name that must never force the header outside its node', entries:Array.from({length:count}, (_,i) => ({id:`e${i}`,key:`key_${i}`,value:`long value ${i} stays in the cell`,annotation:i === 0 ? 'visited' : ''})), columns:kind.id === 'matrix' ? 1 : 4, activeEntryId:count ? 'e0' : '' };
    if (count) data.pointers = [{id:'p1',label:'i',target:'e0'},{id:'p2',label:'j',target:'e0'}];
    data.links = data.entries.slice(1).map((entry,i) => ({id:`l${i}`,source:data.entries[Math.floor(i/2)].id,target:entry.id,label:''}));
    const size = geometry.getStructureSize(data);
    for (const zoom of [1, 1.5]) {
      open = false; stateIndex = 0;
      const markup = renderToStaticMarkup(React.createElement(context.exports.DataStructureNode, {id:'test',data,selected:true,isConnectable:true}));
      const result = await window.webContents.executeJavaScript(`(async()=>{
        document.body.style.zoom=${zoom}; const shell=document.querySelector('#shell'); shell.style.width='${size.width}px'; shell.style.height='${size.height}px'; shell.innerHTML=${JSON.stringify(markup)};
        await new Promise(r=>requestAnimationFrame(r));
        const bounds=document.querySelector('.diagram-structure-node').getBoundingClientRect();
        const inside=n=>{const r=n.getBoundingClientRect();return r.left>=bounds.left-1 && r.right<=bounds.right+1 && r.top>=bounds.top-1 && r.bottom<=bounds.bottom+1;};
        return {width:bounds.width,height:bounds.height,cells:document.querySelectorAll('.diagram-structure-cell').length,fit:[...document.querySelectorAll('.diagram-structure-cell,.diagram-structure-heading,.diagram-structure-heading input,.diagram-structure-heading button,.diagram-structure-index,.diagram-structure-annotation')].every(inside),outside:[...document.querySelectorAll('.diagram-structure-cell,.diagram-structure-heading,.diagram-structure-heading input,.diagram-structure-heading button,.diagram-structure-index,.diagram-structure-annotation')].filter(n=>!inside(n)).map(n=>n.className)};
      })()`);
      assert.equal(result.cells,count,kind.id); assert.ok(result.fit,JSON.stringify({kind:kind.id,count,zoom,result}));
      assert.ok(Math.abs(result.width-size.width*zoom)<1 && Math.abs(result.height-size.height*zoom)<1,JSON.stringify({kind:kind.id,count,zoom,size,result}));
      scenarios++;
    }
  }
  for (const kind of structures.STRUCTURE_KINDS) for (const zoom of [1,1.5]) {
    open=true; stateIndex=0;
    const data={...structures.createStructureData(kind.id),entries:[{id:'e0',key:'0',value:'value',annotation:''}]};
    const size=geometry.getStructureSize(data), markup=renderToStaticMarkup(React.createElement(context.exports.DataStructureNode,{id:'test',data,selected:true,isConnectable:true}));
    const result=await window.webContents.executeJavaScript(`(()=>{document.body.style.zoom=${zoom};const shell=document.querySelector('#shell');shell.style.width='${size.width}px';shell.style.height='${size.height}px';shell.innerHTML=${JSON.stringify(markup)};const node=document.querySelector('.diagram-structure-node').getBoundingClientRect(),panel=document.querySelector('.diagram-structure-tools'),r=panel.getBoundingClientRect();return {fits:r.left>=node.left&&r.right<=node.right,scroll:panel.scrollWidth<=panel.clientWidth+1,height:r.height/${zoom}}})()`);
    assert.ok(result.fits&&result.scroll&&result.height<=390,JSON.stringify({kind:kind.id,zoom,result}));scenarios++;
  }
  for (const signature of ['Map<String, Map<String, ArrayList<String>>>','Map<List<String>, Queue<Integer>>','ArrayList<Queue<Integer>>','Tree<Map<String, List<Integer>>>']) {
    const data=types.applyStructureType({...structures.createStructureData('object'),name:'lookup'},signature);
    const fill=(container,depth=0)=>{container.entries=[types.createStructureEntry(container)];const entry=container.entries[0];entry.key='key';if(entry.keyContainer){entry.key='';if(depth<2)fill(entry.keyContainer,depth+1);}if(entry.valueContainer){if(depth<2)fill(entry.valueContainer,depth+1);}else entry.value='content';};fill(data);
    for(const zoom of [1,1.5]) {
      open=false;stateIndex=0;const size=geometry.getStructureSize(data),markup=renderToStaticMarkup(React.createElement(context.exports.DataStructureNode,{id:'test',data,selected:true,isConnectable:true}));
      const result=await window.webContents.executeJavaScript(`(async()=>{document.body.style.zoom=${zoom};const shell=document.querySelector('#shell');shell.style.width='${size.width}px';shell.style.height='${size.height}px';shell.innerHTML=${JSON.stringify(markup)};await new Promise(r=>requestAnimationFrame(r));const outside=[...document.querySelectorAll('.diagram-structure-cell,.diagram-structure-heading,.diagram-structure-heading input,.diagram-structure-heading button,.diagram-structure-nested-placement')].filter(n=>{const parent=n.closest('.diagram-structure-node'),a=parent.getBoundingClientRect(),b=n.getBoundingClientRect();return b.left<a.left-1||b.right>a.right+1||b.top<a.top-1||b.bottom>a.bottom+1}).map(n=>n.className);return{outside,children:document.querySelectorAll('.is-embedded').length}})()`);
      assert.deepEqual(result.outside,[],JSON.stringify({signature,zoom,result}));assert.ok(result.children>0,signature);scenarios++;
    }
  }
  // Run the actual React event handlers in Chromium, with only ReactFlow's
  // engine replaced by inert bindings. A tiny local CJS loader avoids any
  // server, browser download, executable user input, or persistent profile.
  const modules={};
  for(const [name,file] of Object.entries({'react':'react/cjs/react.production.js','react/jsx-runtime':'react/cjs/react-jsx-runtime.production.js','react-dom':'react-dom/cjs/react-dom.production.js','react-dom/client':'react-dom/cjs/react-dom-client.production.js','scheduler':'scheduler/cjs/scheduler.production.js'})) modules[name]=await fs.readFile(path.join(root,'node_modules',file),'utf8');
  for(const [name,file] of Object.entries({'./DiagramStructureNode':'DiagramStructureNode.jsx','./diagram-structures.mjs':'diagram-structures.mjs','./diagram-structure-layout.mjs':'diagram-structure-layout.mjs','./diagram-structure-types.mjs':'diagram-structure-types.mjs','./useDiagramPopover':'useDiagramPopover.js'})) modules[name]=ts.transpileModule(await fs.readFile(path.join(root,'frontend/features/diagrams',file),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  modules['./DiagramNodes']='exports.DiagramNodeActionsContext=require("react").createContext({updateNode(){}});';
  modules['@xyflow/react']='exports.Handle=()=>null;exports.NodeResizer=()=>null;exports.Position={Top:"top",Right:"right",Bottom:"bottom",Left:"left"};exports.useUpdateNodeInternals=()=>()=>{};';
  const bundle=`(()=>{const modules={${Object.entries(modules).map(([key,value])=>`${JSON.stringify(key)}:function(module,exports,require){${value}\n}`).join(',')}};const cache={};function require(name){if(name.endsWith('.css'))return{};if(cache[name])return cache[name].exports;if(!modules[name])throw new Error('Unexpected browser module '+name);const module=cache[name]={exports:{}};modules[name](module,module.exports,require);return module.exports;}const React=require('react'),{createRoot}=require('react-dom/client'),{DataStructureNode}=require('./DiagramStructureNode'),{DiagramNodeActionsContext}=require('./DiagramNodes');const shell=document.querySelector('#shell');document.body.style.zoom=1;shell.style.width='auto';shell.style.height='auto';shell.innerHTML='';const root=createRoot(shell);let version=0;function Fixture({initial}){const[data,setData]=React.useState(initial);window.testStructureData=data;return React.createElement(DiagramNodeActionsContext.Provider,{value:{updateNode(id,patch,group){window.testStructureChanges.push({patch,group});setData(current=>({...current,...patch}));}}},React.createElement(DataStructureNode,{id:'fixture',data,selected:true,isConnectable:true}));}window.mountStructureFixture=initial=>{window.testStructureChanges=[];root.render(React.createElement(Fixture,{initial,key:++version}));};window.clickStructureControl=label=>{const n=[...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')===label);if(!n)throw new Error('Missing control '+label);n.click();};window.writeStructureInput=(label,value)=>{const n=[...document.querySelectorAll('input')].find(n=>n.getAttribute('aria-label')===label);if(!n)throw new Error('Missing input '+label);n.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}));};window.paintStructure=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`;
  await window.webContents.executeJavaScript(bundle);
  const typed=types.applyStructureType({...structures.createStructureData('map'),name:'lookup'},'Map<String, Map<String, ArrayList<String>>>');
  const interactionResult=await window.webContents.executeJavaScript(`(async()=>{
    let interactions=0;mountStructureFixture(${JSON.stringify(typed)});await paintStructure();
    clickStructureControl('Add unit to lookup');await paintStructure();if(testStructureData.entries[0]?.valueContainer?.structureKind!=='map')throw new Error('Outer + did not create a map: '+JSON.stringify(testStructureData));interactions++;
    clickStructureControl('Add unit to lookup · unit 1 value');await paintStructure();if(testStructureData.entries[0]?.valueContainer?.entries[0]?.valueContainer?.structureKind!=='list')throw new Error('Nested + did not create list: '+JSON.stringify(testStructureData));interactions++;
    clickStructureControl('Add unit to lookup · unit 1 value · unit 1 value');await paintStructure();interactions++;
    writeStructureInput('Unit 1 value in lookup · unit 1 value · unit 1 value','hello nested');await paintStructure();if(testStructureData.entries[0].valueContainer.entries[0].valueContainer.entries[0].value!=='hello nested')throw new Error('Nested value edit lost');interactions++;
    clickStructureControl('Remove unit 1 in lookup · unit 1 value · unit 1 value');await paintStructure();if(testStructureData.entries[0].valueContainer.entries[0].valueContainer.entries.length!==0)throw new Error('Nested remove failed');interactions++;
    mountStructureFixture(${JSON.stringify({...structures.createStructureData('map'),name:'legacy',entries:[{id:'old',key:'key',value:'xyz',annotation:''}]})});await paintStructure();clickStructureControl('Data structure tools');await paintStructure();writeStructureInput('Container type','Map<String, Map<String, ArrayList<String>>>');await paintStructure();if(testStructureChanges.length)throw new Error('Typing mutated the schema before Apply');interactions++;
    const type=document.querySelector('[aria-label="Container type"]');type.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await paintStructure();if(testStructureData.entries[0].value!=='xyz'||testStructureChanges.length)throw new Error('Failed conversion changed data');if(!document.querySelector('[role="alert"]')?.textContent.includes('existing text cannot be converted'))throw new Error('Missing actionable conversion error');if(type.value!=='Map<String, Map<String, ArrayList<String>>>')throw new Error('Failed conversion discarded draft');interactions++;
    clickStructureControl('Close structure tools');await paintStructure();writeStructureInput('Unit 1 value','');await paintStructure();clickStructureControl('Data structure tools');await paintStructure();writeStructureInput('Container type','Map<String, Map<String, ArrayList<String>>>');await paintStructure();document.querySelector('[aria-label="Container type"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await paintStructure();if(!testStructureData.entries[0].valueContainer||document.querySelector('.diagram-structure-tools'))throw new Error('Apply did not reshape or close');interactions++;
    clickStructureControl('Data structure tools');await paintStructure();document.querySelector('[aria-label="Container type"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await paintStructure();if(document.querySelector('.diagram-structure-tools'))throw new Error('Escape did not dismiss tools');interactions++;
    if(!document.querySelector('.diagram-structure-type-signature')?.textContent.includes('Map<String, Map<String, ArrayList<String>>>'))throw new Error('Canonical type not visible');interactions++;
    return interactions;
  })()`);
  assert.equal(interactionResult,10);assert.equal(networkRequests,0);console.log('STRUCTURE_LAYOUT_RESULT='+JSON.stringify({ok:true,scenarios,interactions:interactionResult,networkRequests}));finish(0);
}).catch(error=>{console.error(error.stack||error);finish(1);});
