import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as model from '../frontend/features/diagrams/diagram-model.mjs';
import * as sketchModel from '../frontend/features/diagrams/diagram-sketch-model.mjs';
import * as groups from '../frontend/features/diagrams/diagram-groups.mjs';
import * as expandedLayout from '../frontend/features/diagrams/diagram-expanded-layout.mjs';
import * as expandedRouting from '../frontend/features/diagrams/diagram-expanded-routing.mjs';
import * as sequence from '../frontend/features/diagrams/diagram-sequence.mjs';
import * as selection from '../frontend/features/diagrams/diagram-selection.mjs';
import { parseCanvasShareLink, canvasStatusLabel } from '../canvas-web/src/share-link.mjs';

const jsx = (type, props) => ({ type, props });
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  return [].concat(node.props?.children || []).flat(Infinity).map(child => find(child, predicate)).find(Boolean);
}
function compile(filename, imports, globals = {}) {
  const source = fs.readFileSync(new URL('../frontend/features/diagrams/' + filename, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(compiled.diagnostics.length, 0);
  const context = vm.createContext({ exports: {}, structuredClone, window: {}, ...globals, require: name => {
    if (name.endsWith('.css')) return {};
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    assert.ok(name in imports, 'Unexpected module: ' + name);
    return imports[name];
  }});
  vm.runInContext(compiled.outputText, context);
  return context.exports;
}

test('share links use fragment capabilities and reject unsafe server URLs', () => {
  assert.deepEqual(parseCanvasShareLink('#server=https%3A%2F%2Fcanvas.example&board=board-1&invite=secret'), { endpoint:'https://canvas.example', boardId:'board-1', token:'secret' });
  assert.equal(parseCanvasShareLink('#server=http%3A%2F%2F127.0.0.1%3A4173&board=test&invite=abc').endpoint, 'http://127.0.0.1:4173');
  for (const server of ['http://remote.example', 'javascript:alert(1)', 'https://name:secret@host.example', 'https://host.example?secret=abc', 'https://host.example/#secret']) {
    assert.throws(() => parseCanvasShareLink('#' + new URLSearchParams({server,board:'test',invite:'abc'})));
  }
  assert.throws(() => parseCanvasShareLink(''));
  assert.match(canvasStatusLabel({state:'offline'}), /draft kept/);
});

function sketchHarness(props = {}) {
  const refs = [], effects = [], emitted = [], calls = [];
  let index = 0, tree, editor;
  const view = { scrollX:100, scrollY:80, zoom:{value:1.4}, selectedElementIds:{shape:true} };
  const shape = (version, x = version) => ({id:'shape',type:'rectangle',version,versionNonce:version,x,y:1});
  const Excalidraw = 'Excalidraw';
  const Menu = Object.assign(() => {}, { Item:'MenuItem', Separator:'Separator', DefaultItems:new Proxy({}, {get:(_,key)=>key}) });
  const { default: Sketch } = compile('DiagramSketch.jsx', {
    react:{ Component:class {}, useRef:value => refs[index++] ||= {current:value}, useCallback:fn=>fn, useEffect:fn=>effects.push(fn) },
    '@excalidraw/excalidraw':{ Excalidraw, MainMenu:Menu, WelcomeScreen:Object.assign(()=>{}, {Hints:{ToolbarHint:'ToolbarHint',MenuHint:'MenuHint',HelpHint:'HelpHint'}}), MIME_TYPES:{}, CaptureUpdateAction:{NEVER:'NEVER',IMMEDIATELY:'IMMEDIATELY'}, restoreElements:elements=>elements },
    './diagram-sketch-model.mjs':sketchModel,
  });
  let current = {elements:[shape(1)],files:{},appState:view,libraryItems:[]};
  const api = {
    getAppState:()=>view, getSceneElements:()=>current.elements, addFiles:()=>{},
    updateScene(scene) { calls.push(scene); if (scene.elements) { current={...current,elements:scene.elements}; editor.onChange(scene.elements,view,current.files); } },
    updateLibrary:async scene=>{ current.libraryItems=scene.libraryItems; editor.onLibraryChange(scene.libraryItems); },
    history:{clear:()=>calls.push('clear-history')},
  };
  function render(snapshot=current, extra={}) {
    index=0; effects.length=0;
    tree=Sketch({snapshot,onChange:value=>emitted.push(value),isCollaborating:true,...props,...extra});
    editor=find(tree,node=>node.type===Excalidraw).props;
    editor.excalidrawAPI(api);
    effects.forEach(effect=>effect());
  }
  render();
  editor.onLibraryChange([]); editor.onChange(current.elements,view,{});
  return {render,emitted,calls,shape,view,get editor(){return editor;},get tree(){return tree;}};
}

test('remote sketches apply without echoing, moving the view, or entering local undo', () => {
  const h=sketchHarness();
  h.render({elements:[h.shape(2,250)],files:{},appState:{scrollX:9999},libraryItems:[]});
  const update=h.calls.find(call=>call.elements?.[0]?.version===2);
  assert.ok(update);
  assert.equal(update.captureUpdate,'NEVER');
  assert.equal(update.appState,undefined,'remote viewport is never applied');
  assert.ok(h.calls.includes('clear-history'));
  assert.equal(h.emitted.length,0,'applying the remote scene never creates a new local transaction');
  h.editor.onChange([h.shape(2,250)],{...h.view,scrollX:500},{});
  assert.equal(h.emitted.length,0,'panning is local presence, not a board edit');
  h.editor.onChange([h.shape(3,300)],h.view,{});
  assert.equal(h.emitted.length,1,'a real local scene change is emitted once');
});

test('read-only sketch blocks clipboard, drops and shared undo', () => {
  let undo=0, prevented=0;
  const h=sketchHarness({readOnly:true,onUndo:()=>undo++});
  assert.equal(h.editor.viewModeEnabled,true);
  assert.equal(h.editor.onPaste({elements:[h.shape(2)]}),false);
  h.tree.props.onKeyDownCapture({metaKey:true,key:'z',preventDefault:()=>prevented++,stopPropagation(){}});
  h.tree.props.onDropCapture({preventDefault:()=>prevented++,stopPropagation(){}});
  h.editor.onChange([h.shape(2)],h.view,{});
  assert.equal(undo,0); assert.equal(prevented,2); assert.equal(h.emitted.length,0);
});

test('shared drawing updates preserve personal libraries', () => {
  const h=sketchHarness();
  h.editor.onLibraryChange([{id:'personal-library',status:'unpublished',elements:[]}]);
  h.render({elements:[h.shape(2)],files:{},appState:{},libraryItems:[]});
  h.editor.onChange([h.shape(3)],h.view,{});
  assert.equal(h.emitted.at(-1).libraryItems[0].id,'personal-library');
});

function structuredHarness(extra={}) {
  let cursor=0, pending=[], tree, dirty=false;
  const hooks=[], saves=[];
  const state = initial => { const slot=cursor++; if (!(slot in hooks)) hooks[slot]=typeof initial==='function'?initial():initial; return [hooks[slot],value=>{hooks[slot]=typeof value==='function'?value(hooks[slot]):value;dirty=true;}]; };
  const ref = value => { const slot=cursor++; return hooks[slot] ||= {current:value}; };
  const effect = (fn,deps) => {const slot=cursor++,previous=hooks[slot];if(!previous||deps.some((value,i)=>value!==previous[i])){hooks[slot]=deps;pending.push(fn);}};
  const flow={fitView(){},getNodes:()=>[],getEdges:()=>[],getZoom:()=>1,screenToFlowPosition:point=>point};
  const context=()=>({Provider:'Provider'});
  const nodeChanges=(changes,nodes)=>nodes.map(node=>{const update=changes.find(change=>change.id===node.id);return update?{...node,...(update.type==='select'?{selected:update.selected}:update.type==='position'?{position:update.position}:{})}:node;});
  const {StructuredCanvas}=compile('DiagramStudio.jsx', {
    react:{useState:state,useReducer:(reducer,initial)=>{const [value,set]=state(initial);return [value,action=>set(previous=>reducer(previous,action))];},useRef:ref,useEffect:effect,useMemo:fn=>fn(),useCallback:fn=>fn,createContext:context,useContext:()=>false,lazy:()=> 'Sketch',Suspense:'Suspense'},
    '@xyflow/react':{ReactFlow:'ReactFlow',ReactFlowProvider:'ReactFlowProvider',Background:'Background',Controls:'Controls',MiniMap:'MiniMap',ViewportPortal:'ViewportPortal',ConnectionMode:{Loose:'loose'},SelectionMode:{Partial:'partial',Full:'full'},applyNodeChanges:nodeChanges,applyEdgeChanges:(_changes,edges)=>edges,useReactFlow:()=>flow,useNodesInitialized:()=>false},
    './DiagramNodes':{nodeTypes:{},DiagramNodeActionsContext:context(),ComponentGlyph:'Glyph'},
    './DiagramGroupNode':{DiagramGroupNode:'DiagramGroupNode'},
    './diagram-groups.mjs':groups,
    './diagram-expanded-layout.mjs':expandedLayout,
    './diagram-expanded-routing.mjs':expandedRouting,
    './diagram-sequence.mjs':sequence,
    './diagram-selection.mjs':selection,
    './DiagramStructureNode':{DataStructureNode:'DataStructureNode'},
    './DiagramStructurePicker':{default:'Picker',STRUCTURE_DRAG_TYPE:'structure',StructureGlyph:'StructureGlyph'},
    './DiagramInsertLibrary':{default:'InsertLibrary',DIAGRAM_ITEM_DRAG_TYPE:'application/x-argus-diagram-item'},
    './eraser-icon-assets.mjs':{prefetchEraserIcons:async()=>new Map()},
    './diagram-structures.mjs':{cleanStructureData:value=>value,getStructureSize:()=>({width:200,height:200})},
    './diagram-catalog.mjs':{DIAGRAM_COMPONENTS:[]},
    './DiagramEdges':{edgeTypes:{},DiagramEdgeActionsContext:context()},
    './diagram-model.mjs':model,
    './useDiagramDocument':{useDiagramDocument() {assert.fail('Injected editor never loads local boards');}},
    './useOwnerCanvasSharing':{},'./diagram-svg.mjs':{},'./useDiagramCanvasScale':{},'./useDiagramPopover':{useDiagramPopover:()=>()=>{}},
  });
  let board={id:'board',name:'Shared',snapshot:model.templateSnapshot('class')};
  function render(next=board) {
    board=next;
    for(let pass=0;pass<5;pass++){
      cursor=0;pending=[];dirty=false;
      tree=StructuredCanvas({document:board,onChange:value=>saves.push(value),onError:error=>assert.fail(error),visible:false,...extra});
      pending.forEach(fn=>fn());if(!dirty)break;
    }
    return find(tree,node=>node.type==='ReactFlow').props;
  }
  render();
  return {render,saves,get board(){return board;},get tree(){return tree;}};
}

test('incoming structured edits preserve local selection and do not publish stale snapshots', () => {
  const h=structuredHarness();
  const flow=h.render(),id=flow.nodes[0].id;
  flow.onNodesChange([{id,type:'select',selected:true}]);h.render();
  const remote=structuredClone(h.board);remote.snapshot.structured.nodes[0].data.name='Changed remotely';
  const updated=h.render(remote);
  assert.equal(updated.nodes[0].data.name,'Changed remotely');
  assert.equal(updated.nodes[0].selected,true);
  assert.equal(h.saves.length,0);
  assert.equal(find(h.tree,node=>node.props?.['aria-label']==='Undo').props.disabled,true,'remote snapshot resets standalone history');
});

test('read-only structured views block graph mutations and route undo to the shared manager', () => {
  const read=structuredHarness({readOnly:true});const flow=read.render();
  assert.equal(flow.nodesDraggable,false);assert.equal(flow.nodesConnectable,false);
  flow.onNodesChange([{id:flow.nodes[0].id,type:'position',position:{x:999,y:999}}]);
  assert.equal(read.saves.length,0);
  assert.equal(find(read.tree,node=>node.props?.['aria-label']==='Delete selection').props.disabled,true);
  let count=0;const edit=structuredHarness({onUndo:()=>count++,canUndo:true});
  find(edit.tree,node=>node.props?.['aria-label']==='Undo').props.onClick();
  assert.equal(count,1);assert.equal(edit.saves.length,0);
});
