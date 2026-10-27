// Render the real React Studio markup + production CSS, with only the engine
// and disk/network store replaced by inert synthetic fixtures. No live Argus.
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
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-diagram-layout-')) throw new Error('Isolated fixture directory required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0;
const timer = setTimeout(() => { console.error('Diagram layout timed out'); app.exit(1); }, 50_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };

app.whenReady().then(async () => {
  const model = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-model.mjs')));
  const catalog = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-catalog.mjs')));
  const structures = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-structures.mjs')));
  const groups = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-groups.mjs')));
  const expandedLayout = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-expanded-layout.mjs')));
  const expandedRouting = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-expanded-routing.mjs')));
  const sequence = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-sequence.mjs')));
  const selection = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-selection.mjs')));
  const source = await fs.readFile(path.join(root, 'frontend/features/diagrams/DiagramStudio.jsx'), 'utf8');
  const styles = await fs.readFile(path.join(root, 'frontend/features/diagrams/diagram-studio.css'), 'utf8') + await fs.readFile(path.join(root, 'frontend/features/diagrams/diagram-selection.css'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const board = { id:'synthetic', name:'Sequence design', updatedAt:'2026-10-12', snapshot:model.templateSnapshot('sequence') };
  const store = { documents:Array.from({length:70}, (_,i)=>({...board,id:String(i),name:'Architecture board '+i})), document:board, status:'Saved locally', busy:false, dirty:false };
  let index = 0, picker = 'closed';
  const jsx = require('react/jsx-runtime');
  const context = vm.createContext({ exports:{}, require(name) {
    if (name === 'react') return { ...React, useState(initial) { const position=index++; return React.useState(position === 4 && picker === 'boards' || position === 12 && picker === 'palette' ? true : initial); } };
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'next/dynamic') return () => () => null;
    if (name.endsWith('.css')) return {};
    if (name === '@xyflow/react') return { ReactFlow:()=>jsx.jsx('div',{className:'react-flow'}), ReactFlowProvider:({children})=>children, useReactFlow:()=>({}), useNodesInitialized:()=>false, ConnectionMode:{Loose:'loose'}, Background:()=>null, Controls:()=>null, MiniMap:()=>null };
    if (name === './DiagramNodes') return { nodeTypes:{}, DiagramNodeActionsContext:React.createContext({}), ComponentGlyph:()=>jsx.jsx('span',{className:'diagram-component-glyph'}) };
    if (name === './DiagramGroupNode') return { DiagramGroupNode:()=>null };
    if (name === './DiagramStructureNode') return { DataStructureNode:()=>null };
    if (name === './DiagramStructurePicker') return { __esModule:true, default:()=>null, StructureGlyph:()=>jsx.jsx('span',{className:'diagram-structure-glyph'}) };
    if (name === './DiagramInsertLibrary') return { __esModule:true, default:()=>jsx.jsx('input',{'aria-label':'Search architecture components'}), DIAGRAM_ITEM_DRAG_TYPE:'application/x-argus-diagram-item' };
    if (name === './eraser-icon-assets.mjs') return { prefetchEraserIcons:async()=>new Map() };
    if (name === './diagram-structures.mjs') return structures;
    if (name === './diagram-groups.mjs') return groups;
    if (name === './diagram-connection-routing.mjs') return { moveInternalConnectionRoutes:(_previous,next)=>next };
    if (name === './diagram-expanded-layout.mjs') return expandedLayout;
    if (name === './diagram-expanded-routing.mjs') return expandedRouting;
    if (name === './diagram-sequence.mjs') return sequence;
    if (name === './diagram-selection.mjs') return selection;
    if (name === './DiagramEdges') return { edgeTypes:{}, DiagramEdgeActionsContext:React.createContext({}) };
    if (name === './diagram-catalog.mjs') return catalog;
    if (name === './diagram-model.mjs') return model;
    if (name === './useDiagramDocument') return { useDiagramDocument:()=>store };
    if (name === './useOwnerCanvasSharing') return { useOwnerCanvasSharing:value=>({store:value,collaboration:{}}) };
    if (name === './useDiagramCanvasScale') return () => ({});
    if (name === './useDiagramPopover') return { useDiagramPopover:()=>()=>{} };
    if (name === './diagram-svg.mjs') return {};
    throw new Error('Unexpected import '+name);
  }});
  vm.runInContext(compiled, context);
  const layouts = {};
  for (picker of ['closed','boards','palette']) { index=0; layouts[picker]=renderToStaticMarkup(React.createElement(context.exports.default)); }
  assert.ok(!layouts.closed.includes('id="diagram-board-picker"') && !layouts.closed.includes('id="diagram-component-picker"'));
  assert.match(layouts.closed, /<option value="message" selected="">/, 'Sequence toolbar starts with its actual Message connection type');
  assert.ok(layouts.boards.includes('id="diagram-board-picker"')); assert.ok(layouts.palette.includes('id="diagram-component-picker"'));
  const isolated = session.fromPartition('diagram-layout-regression', { cache:false });
  isolated.setPermissionRequestHandler((_c,_p,callback)=>callback(false));
  isolated.webRequest.onBeforeRequest({ urls:['http://*/*','https://*/*'] }, (_d,callback)=>{networkRequests++;callback({cancel:true});});
  window = new BrowserWindow({show:false,width:1440,height:900,webPreferences:{session:isolated,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const shell = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>:root{--text:#eceff4;--bg:#101319;--surface:#171b22;--surface-2:#212833;--line:#303a48;--muted:#a0abba;--accent:#d5ff52}body{margin:0}#shell{position:absolute;inset:10px 0 0 54px;overflow:hidden}.react-flow{position:absolute;inset:0}${styles}</style></head><body><div id="shell"></div></body></html>`;
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(shell));
  let scenarios=0;
  for (const mode of ['native','body']) for (const width of [480,800,1440]) for (const zoom of [1,1.12,1.5]) {
    window.setContentSize(width,800); window.webContents.setZoomFactor(mode==='native'?zoom:1);
    for (const kind of ['closed','boards','palette']) {
      const bodyZoom=mode==='body'?zoom:1;
      const g=await window.webContents.executeJavaScript(`(async()=>{
        document.body.style.zoom=${bodyZoom};
        const shell=document.querySelector('#shell');shell.style.inset='10px 0 0 54px';shell.innerHTML=${JSON.stringify(layouts[kind])};
        document.querySelector('.diagram-studio').style.setProperty('--diagram-body-zoom',${bodyZoom});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const rect=s=>{const n=document.querySelector(s);if(!n)return null;const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,position:getComputedStyle(n).position};};
        const templates=[...document.querySelectorAll('.diagram-template-actions button')].map(n=>{const box=n.getBoundingClientRect();const range=document.createRange();range.selectNodeContents(n);const text=range.getBoundingClientRect();return {left:box.left,right:box.right,textLeft:text.left,textRight:text.right};});
        return {width:innerWidth,height:innerHeight,studio:rect('.diagram-studio'),main:rect('.diagram-main'),work:rect('.diagram-workarea'),flow:rect('.diagram-flow'),toolbar:rect('.diagram-toolbar'),boards:rect('.diagram-boards'),palette:rect('.diagram-palette'),templates,boardRow:rect('.diagram-board-item'),boardOpen:rect('.diagram-board-open'),boardDelete:rect('.diagram-board-delete'),deleteCount:document.querySelectorAll('.diagram-board-delete').length};
      })()`);
      const diagnostic=JSON.stringify({mode,width,zoom,kind,...g});
      assert.ok(Math.abs(g.studio.width-g.main.width)<1, 'Saved boards reserve a column: '+diagnostic);
      assert.ok(Math.abs(g.work.width-g.flow.width)<1, 'Component palette reserves a column: '+diagnostic);
      assert.ok(g.main.right<=g.width+1 && g.main.left>=0, 'Main escapes viewport: '+diagnostic);
      assert.ok(g.flow.height>150, 'Canvas lost usable height: '+diagnostic);
      assert.ok(g.toolbar.height<=52*bodyZoom, 'Toolbar is unnecessarily tall: '+diagnostic);
      for (const overlay of [g.boards,g.palette].filter(Boolean)) {
        assert.equal(overlay.position,'absolute',diagnostic);
        assert.ok(overlay.left>=-1 && overlay.right<=g.width+1 && overlay.top>=-1 && overlay.bottom<=g.height+1, 'Picker escapes viewport: '+diagnostic);
      }
      for (const control of g.templates) assert.ok(control.textLeft>=control.left-1 && control.textRight<=control.right+1, 'Template shortcut text is clipped: '+diagnostic);
      if (kind==='boards') {
        assert.equal(g.deleteCount,70,'Every board needs a delete action');
        assert.ok(g.boardOpen.right<=g.boardDelete.left && g.boardDelete.right<=g.boardRow.right+1,'Board actions overlap or escape the row: '+diagnostic);
        assert.ok(g.boardRow.scrollWidth<=g.boardRow.clientWidth+1,'Board row overflows: '+diagnostic);
        if (process.env.ARGUS_DIAGRAM_LAYOUT_CAPTURE==='1' && mode==='native' && zoom===1 && width===800) await fs.writeFile(path.join(temporary,'board-delete-controls.png'),(await window.webContents.capturePage()).toPNG());
      }
      if (kind==='closed') assert.ok(!g.boards&&!g.palette,diagnostic);
      scenarios++;
    }
  }
  assert.equal(networkRequests,0);
  console.log('DIAGRAM_LAYOUT_RESULT='+JSON.stringify({ok:true,scenarios,networkRequests})); finish(0);
}).catch(error=>{console.error(error.stack||error);finish(1);});
