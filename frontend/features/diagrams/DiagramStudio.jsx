"use client";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, ConnectionMode, ViewportPortal, applyNodeChanges, applyEdgeChanges, useReactFlow, useNodesInitialized, getNodesBounds, getViewportForBounds } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './diagram-studio.css';
import './diagram-board-selection.css';
import './diagram-selection.css';
import { selectDiagramElements, deleteDiagramSelection, isDiagramShortcutTarget } from './diagram-selection.mjs';
import { nodeTypes as baseNodeTypes, DiagramNodeActionsContext } from './DiagramNodes';
import { DiagramGroupNode } from './DiagramGroupNode';
import { createGroup, fitGroup, ungroup, applyGroupMoves, sanitizeGroupMembership, GROUP_COLORS } from './diagram-groups.mjs';
import { expandedNotesGraph } from './diagram-expanded-layout.mjs';
import { getExpandedRoutes, getExpandedRouteBounds } from './diagram-expanded-routing.mjs';
import { DataStructureNode } from './DiagramStructureNode';
import DiagramStructurePicker, { STRUCTURE_DRAG_TYPE, StructureGlyph } from './DiagramStructurePicker';
import { cleanStructureData, getStructureSize } from './diagram-structures.mjs';
import { DIAGRAM_COMPONENTS, getDiagramComponent } from './diagram-catalog.mjs';
import DiagramInsertLibrary, { DIAGRAM_ITEM_DRAG_TYPE } from './DiagramInsertLibrary';
import { prefetchEraserIcons } from './eraser-icon-assets.mjs';
import { edgeTypes, DiagramEdgeActionsContext } from './DiagramEdges';
import { moveInternalConnectionRoutes } from './diagram-connection-routing.mjs';
import { cleanStructured, createDiagramHistory, duplicateSelection, emptySnapshot, exportBoard, makeNode, parseBoardImport, MAX_IMPORT_BYTES, RELATIONS, templateSnapshot, uid } from './diagram-model.mjs';
import { useDiagramDocument } from './useDiagramDocument';
import { useOwnerCanvasSharing } from './useOwnerCanvasSharing';
import { exportStructuredSvg, getStructuredBounds } from './diagram-svg.mjs';
import { arrangeSequence, getSequenceGeometry } from './diagram-sequence.mjs';
import useDiagramCanvasScale from './useDiagramCanvasScale';
import { useDiagramPopover } from './useDiagramPopover';
const Sketch = lazy(()=>{if(typeof window!=='undefined')window.EXCALIDRAW_ASSET_PATH='/assets/excalidraw/';return import('./DiagramSketch');});
const CanvasReadOnlyContext = createContext(false);
const nodeTypes = Object.fromEntries(Object.entries({ ...baseNodeTypes, group: DiagramGroupNode, dataStructure: DataStructureNode }).map(([name, Node]) => [name, function CanvasNode(props) {
  const readOnly = useContext(CanvasReadOnlyContext);
  const { expandedNotes } = useContext(DiagramNodeActionsContext);
  // Component notes are readable in guest view. Its mutation controls are
  // individually read-only; the other node types keep the blanket safeguard.
  if (name === 'component') return <Node {...props} selected={readOnly ? false : props.selected} isConnectable={!readOnly && props.isConnectable}/>;
  // A disabled fieldset reaches every nested DSA/member editor, including new
  // editors added later. Keep its layout transparent to React Flow measuring.
  return <fieldset disabled={readOnly} style={{display:'contents'}}><Node {...props} selected={readOnly || expandedNotes ? false : props.selected} isConnectable={!readOnly && !expandedNotes && props.isConnectable}/></fieldset>;
}]));

function download(name, content, type='application/json') {
  const url=URL.createObjectURL(content instanceof Blob ? content : new Blob([content],{type}));
  const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const filename = name => (name || 'diagram').replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,100) || 'diagram';

function StudioIcon({name}) {
  const paths={boards:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',plus:'M12 5v14 M5 12h14',chevron:'m6 9 6 6 6-6',close:'m6 6 12 12 M6 18 18 6',class:'M4 3h16v18H4z M4 9h16 M4 15h16',participant:'M4 3h16v6H4z M12 9v12 M9 13h6 M9 17h6',note:'M4 3h16v13l-5 5H4z M15 21v-5h5',import:'M12 3v12 m-4-4 4 4 4-4 M4 16v5h16v-5',export:'M12 15V3 m-4 4 4-4 4 4 M4 16v5h16v-5',archive:'M3 4h18v4H3z M5 8v13h14V8 M9 12h6',restore:'M3 10a9 9 0 1 1 2 9 M3 4v6h6',system:'M8 3h8v5H8z M3 16h6v5H3z M15 16h6v5h-6z M12 8v4 M6 16v-4h12v4',undo:'M9 5 4 10l5 5 M4 10h10a6 6 0 0 1 0 12',redo:'m15 5 5 5-5 5 M20 10H10a6 6 0 0 0 0 12',copy:'M8 8h13v13H8z M16 8V3H3v13h5',trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7'};
  return <svg className="diagram-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]||paths.boards}/></svg>;
}

export default function DiagramStudio({store, ...props}) {
  return store ? <DiagramStudioView store={store} {...props}/> : <LocalDiagramStudio {...props}/>;
}

function LocalDiagramStudio(props) {
  const store=useDiagramDocument();
  const sharing=useOwnerCanvasSharing(store);
  return <DiagramStudioView {...props} store={sharing.store} headerActions={sharing.headerActions} collaboration={sharing.collaboration}/>;
}

// The injected store follows useDiagramDocument's interface; headerActions is
// the owner Share dialog slot. The browser client uses the same canvas exports.
export function DiagramStudioView({store, visible=true, headerActions, collaboration={}}) {
  const canvasScaleStyle=useDiagramCanvasScale();
  const [mode,setMode]=useState('structured'),[search,setSearch]=useState(''),[showArchived,setShowArchived]=useState(false),[theme,setTheme]=useState('dark');
  const importRef=useRef(null);
  const [boardsOpen,setBoardsOpen]=useState(false);
  const boardsRef=useRef(null),boardsTrigger=useRef(null);
  const closeBoards=useDiagramPopover(boardsOpen,value=>{if(!deletionRef.current)setBoardsOpen(value);},boardsRef,boardsTrigger);
  const [sketchBoard,setSketchBoard]=useState(null);
  useEffect(()=>{if(mode==='sketch'&&store.document)setSketchBoard(store.document.id);},[mode,store.document?.id]);
  useEffect(()=>{const sync=()=>setTheme(document.documentElement.dataset.theme==='light'?'light':'dark');sync();const observer=new MutationObserver(sync);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!visible){setBoardsOpen(false);void store.flush().catch(()=>{});}},[visible]);
  // Keep the existing useState ordering stable for canvas/picker consumers.
  const [selection,setSelection]=useReducer((state,patch)=>({...state,...(typeof patch==='function'?patch(state):patch)}),{active:false,ids:[],deleting:false,status:''});
  const deletionRef=useRef(false),latestStore=useRef(store);latestStore.current=store;
  const boards=store.documents.filter(item=>Boolean(item.archived)===showArchived&&item.name.toLowerCase().includes(search.toLowerCase()));
  const selectedIds=new Set(selection.ids),visibleIds=new Set(boards.map(item=>item.id));
  const selectedBoards=boards.filter(item=>selectedIds.has(item.id)),locked=store.busy||selection.deleting;
  useEffect(()=>{if(!deletionRef.current)setSelection(state=>({ids:state.ids.filter(id=>visibleIds.has(id))}));},[search,showArchived,store.documents]);
  function changeSearch(value){if(deletionRef.current)return;setSearch(value);setSelection({ids:[],status:''});}
  function changeArchiveFilter(value){if(deletionRef.current)return;setShowArchived(value);setSelection({ids:[],status:''});}
  function toggleBoard(id){if(deletionRef.current||store.busy)return;setSelection(state=>({ids:state.ids.includes(id)?state.ids.filter(value=>value!==id):[...state.ids,id],status:''}));}
  async function create(kind) {
    if(deletionRef.current)return;
    const drawing=mode==='sketch',name=drawing?'Untitled drawing':kind==='blank'?'Untitled board':kind==='class'?'Class design':kind==='sequence'?'Sequence design':kind==='dsa'?'DSA dry run':'System architecture';
    if(await store.create(name,drawing?emptySnapshot():templateSnapshot(kind))){setMode(drawing?'sketch':'structured');setSelection({active:false,ids:[],status:''});closeBoards();}
  }
  async function importFile(event) {
    const file=event.target.files?.[0];event.target.value='';if(!file||deletionRef.current)return;
    try { if(file.size>MAX_IMPORT_BYTES)throw new Error('Board imports are limited to 10 MB.');const imported=parseBoardImport(await file.text());if(deletionRef.current)return;if(await store.create(imported.name,imported.snapshot))setMode(imported.mode); } catch(error){store.setError(error.message);}
  }
  async function deleteBoard(item) {
    const name=store.document?.id===item.id?store.document.name:item.name;
    if(!window.confirm(`Permanently delete “${name}”?\n\nBoth its structured canvas and drawing will be removed. This cannot be undone. Use Archive instead if you may need it later.`))return;
    if(await store.remove(item))boardsRef.current?.querySelector('[data-popover-autofocus]')?.focus();
  }
  async function deleteSelectedBoards() {
    if(deletionRef.current||store.busy||!selectedBoards.length)return;
    const targets=selectedBoards.map(item=>({...item,name:store.document?.id===item.id?store.document.name:item.name}));
    deletionRef.current=true;
    try {
      const names=targets.map(item=>`• ${item.name}`).join('\n');
      if(!window.confirm(`Permanently delete ${targets.length} selected ${targets.length===1?'board':'boards'}?\n\n${names}\n\nBoth the structured canvas and drawing in every selected board will be removed. This cannot be undone.`))return;
      setSelection({deleting:true,status:`Deleting 0 of ${targets.length} boards…`});
      let deleted=0;
      for(const item of targets) {
        let removed=false;
        try { removed=await latestStore.current.remove(item); }
        catch(error){latestStore.current.setError(error?.message||'Could not delete the selected board.');}
        if(!removed){setSelection({status:`${deleted} of ${targets.length} deleted. Stopped at “${item.name}”. ${targets.length-deleted} still selected.`});return;}
        deleted++;
        setSelection(state=>({ids:state.ids.filter(id=>id!==item.id),status:`Deleting ${deleted} of ${targets.length} boards…`}));
      }
      setSelection({active:false,ids:[],status:`Deleted ${deleted} ${deleted===1?'board':'boards'} permanently.`});
    } finally {deletionRef.current=false;setSelection({deleting:false});}
  }
  const doc=store.document;
  return <div className="diagram-studio" style={canvasScaleStyle} aria-label="Diagram Studio">
    <main className="diagram-main" aria-busy={locked}>
      <header className="diagram-header">
        <div className="diagram-boards-anchor">
          <button ref={boardsTrigger} className="diagram-boards-trigger" aria-haspopup="dialog" aria-expanded={boardsOpen} aria-controls="diagram-board-picker" title={mode==='sketch'?'Saved boards':'Saved boards and templates'} disabled={selection.deleting} onClick={()=>{if(!deletionRef.current)setBoardsOpen(value=>!value);}}><StudioIcon name="boards"/><span>Boards</span><StudioIcon name="chevron"/></button>
          {boardsOpen&&<section ref={boardsRef} id="diagram-board-picker" className="diagram-boards diagram-popover" role="dialog" aria-label="Saved boards and templates">
            <header className="diagram-popover-heading"><strong>Diagram Studio</strong><button className="diagram-icon-button" aria-label="Close boards" disabled={selection.deleting} onClick={()=>closeBoards()}><StudioIcon name="close"/></button></header>
            <div className="diagram-board-search"><input data-popover-autofocus aria-label="Search saved boards" placeholder="Find a board…" value={search} disabled={selection.deleting} onChange={event=>changeSearch(event.target.value)}/><button className="diagram-new" disabled={locked} onClick={()=>create('blank')}><StudioIcon name="plus"/>{mode==='sketch'?'New drawing':'New'}</button></div>
            <div className="diagram-board-tabs"><button aria-pressed={!showArchived} disabled={selection.deleting} onClick={()=>changeArchiveFilter(false)}>Boards</button><button aria-pressed={showArchived} disabled={selection.deleting} onClick={()=>changeArchiveFilter(true)}>Archived</button></div>
            <div className="diagram-board-selection">
              {selection.active?<><label><input type="checkbox" aria-label="Select all visible boards" checked={boards.length>0&&selectedBoards.length===boards.length} disabled={locked||!boards.length} onChange={event=>{if(!deletionRef.current)setSelection({ids:event.target.checked?boards.map(item=>item.id):[],status:''});}}/>All visible</label><span>{selectedBoards.length} selected</span><button type="button" disabled={locked} onClick={()=>{if(!deletionRef.current)setSelection({active:false,ids:[],status:''});}}>Cancel</button><button type="button" className="diagram-delete-selected" disabled={locked||!selectedBoards.length} onClick={()=>void deleteSelectedBoards()}>Delete selected</button></>:<button type="button" disabled={locked||!boards.length} onClick={()=>setSelection({active:true,ids:[],status:''})}>Select boards</button>}
            </div>
            {selection.status&&<p className="diagram-board-selection-status" role="status" aria-live="polite">{selection.status}</p>}
            <nav aria-label="Saved diagrams">{boards.map(item=><div key={item.id} className={'diagram-board-item '+(doc?.id===item.id?'active':'')}>
              {selection.active&&<input className="diagram-board-checkbox" type="checkbox" aria-label={'Select board '+item.name} checked={selectedIds.has(item.id)} disabled={locked} onChange={()=>toggleBoard(item.id)}/>}
              <button className="diagram-board-open" disabled={locked||selection.active} onClick={()=>{if(deletionRef.current)return;closeBoards();void (item.archived?store.restore(item):store.open(item.id));}} title={item.archived?'Restore '+item.name:item.name}><StudioIcon name={item.archived?'restore':'boards'}/><strong>{item.name}</strong><small>{item.archived?'Restore':new Date(item.updatedAt).toLocaleDateString()}</small></button>
              {!selection.active&&<button className="diagram-icon-button diagram-board-delete" type="button" disabled={store.busy} aria-label={'Delete board '+item.name} title={'Delete '+item.name+' permanently'} onClick={()=>void deleteBoard(item)}><StudioIcon name="trash"/></button>}
            </div>)}{!boards.length&&<p className="diagram-empty-small">{showArchived?'No archived boards.':search?'No matching boards.':mode==='sketch'?'Start with a new drawing.':'Start with a new board or a template.'}</p>}</nav>
            {mode==='structured'&&<footer><span className="diagram-eyebrow">START WITH A TEMPLATE</span><div className="diagram-template-actions">{[['class','Class'],['sequence','Sequence'],['hld','HLD'],['dsa','DSA']].map(([key,label])=><button disabled={locked} key={key} onClick={()=>create(key)} title={'New '+label+' diagram'}>{key==='dsa'?<StructureGlyph kind="array"/>:<StudioIcon name={key==='hld'?'system':key==='sequence'?'participant':'class'}/ >}{label}</button>)}</div><small>Saved on this Mac · Share individual boards</small></footer>}
          </section>}
        </div>
        <div className="diagram-title">{doc?<input aria-label="Board name" value={doc.name} disabled={locked} maxLength={160} onChange={event=>{if(!deletionRef.current)store.change({name:event.target.value},doc.id);}} onBlur={()=>{if(!deletionRef.current&&!doc.name.trim())store.change({name:'Untitled board'},doc.id);}}/>:<strong>Your next idea starts here</strong>}<span role="status" className={store.dirty?'is-dirty':''}>{store.status}</span></div>
        <div className="diagram-mode-tabs" role="group" aria-label="Canvas mode"><button aria-pressed={mode==='structured'} disabled={selection.deleting} onClick={()=>{if(!deletionRef.current)setMode('structured');}}>Structured</button><button aria-pressed={mode==='sketch'} disabled={selection.deleting} onClick={()=>{if(!deletionRef.current)setMode('sketch');}}>Draw · Excalidraw</button></div>
        {headerActions&&<div className="diagram-header-actions-lock" inert={selection.deleting}>{headerActions}</div>}
        <div className="diagram-file-actions"><button className="diagram-icon-button" aria-label="Import board" title="Import board" onClick={()=>{if(!deletionRef.current)importRef.current?.click();}} disabled={locked}><StudioIcon name="import"/></button><button className="diagram-icon-button" aria-label="Export board" title="Export board" disabled={!doc||selection.deleting} onClick={()=>{if(!deletionRef.current)download(filename(doc.name)+'.argus-diagram.json',exportBoard(doc));}}><StudioIcon name="export"/></button><button className="diagram-icon-button" aria-label="Archive board" disabled={!doc||locked} title="Archive board · keeps its content locally" onClick={()=>{if(!deletionRef.current&&confirm('Archive this board? Its content is kept locally and can be restored from Archived.'))void store.archive();}}><StudioIcon name="archive"/></button></div>
        <input ref={importRef} type="file" accept=".json,.excalidraw" hidden onChange={importFile}/>
      </header>
      {store.error&&<div className="diagram-error" role="alert" inert={selection.deleting}><span>{store.error}</span><button disabled={locked} onClick={()=>store.flush().catch(()=>{})}>Retry save</button>{doc&&<button disabled={locked} onClick={()=>store.create(doc.name+' (recovered)',doc.snapshot,true)}>Save draft as copy</button>}<button disabled={locked} onClick={()=>store.loadList().catch(error=>store.setError(error.message))}>Refresh boards</button></div>}
      {!doc?<section className={'diagram-welcome'+(mode==='sketch'?' diagram-drawing-welcome':'')}><div className="diagram-welcome-mark">◇</div>{mode==='sketch'?<><h1>A blank canvas for your next idea.</h1><p>Sketch freely with Excalidraw.</p><div><button disabled={locked} onClick={()=>create('blank')}><strong>New drawing</strong><span>Start with an empty canvas.</span></button></div></>:<><h1>From a class to a whole system.</h1><p>Editable classes. Connected ideas. A canvas that stays with your work.</p><div>{[['class','Class diagrams','Three compartments. Every name, field and method editable in place.'],['sequence','Sequence diagrams','Participants, lifelines and labelled message connections.'],['hld','System architecture','Brand logos with symbols for databases, caches, topics and services.']].map(([key,title,description])=><button key={key} disabled={locked} onClick={()=>create(key)}><strong>{title}</strong><span>{description}</span><em>Start designing →</em></button>)}</div></>}<p className="diagram-empty-small">Structured and Draw are separate canvases inside the same saved board. Switch views without replacing either.</p></section>:
        <div className="diagram-editor-shell">{locked&&<div className="diagram-busy" role="status">{selection.deleting?'Deleting selected boards…':'Saving and opening board…'}</div>}
          <div className="diagram-mode-surface" hidden={mode!=='structured'} inert={locked}><ReactFlowProvider key={doc.id}><StructuredCanvas key={doc.id} document={doc} onChange={structured=>{if(!deletionRef.current)store.change(current=>({snapshot:{...current.snapshot,structured}}),doc.id);}} onError={store.setError} visible={visible&&mode==='structured'} {...collaboration}/></ReactFlowProvider></div>
          {(mode==='sketch'||sketchBoard===doc.id)&&<div className="diagram-mode-surface diagram-sketch" hidden={mode!=='sketch'} inert={locked}><Suspense fallback={<div className="diagram-loading">Loading the drawing editor…</div>}><Sketch key={doc.id} snapshot={doc.snapshot.sketch} theme={theme} onChange={sketch=>{if(!deletionRef.current)store.change(current=>({snapshot:{...current.snapshot,sketch}}),doc.id);}} onError={store.setError} {...collaboration}/></Suspense></div>}
        </div>}
    </main>
  </div>;
}

export function StructuredCanvas({document:board,onChange,onError,visible=true,readOnly=false,onUndo,onRedo,canUndo,canRedo,onPointerUpdate,presence=[]}) {
  const [connectionRouting,setConnectionRouting]=useState('elbow');
  const firstObjectType=board.snapshot.structured.nodes.find(node=>node.type!=='group')?.type;
  const [graph,setGraph]=useState(()=>cleanStructured(board.snapshot.structured)),[palette,setPalette]=useState(()=>firstObjectType==='participant'?'sequence':firstObjectType==='component'?'hld':firstObjectType==='dataStructure'?'dsa':'class'),[showMap,setShowMap]=useState(false),[grid,setGrid]=useState(true),[connectionType,setConnectionType]=useState(()=>firstObjectType==='participant'?'message':'association');
  const [paletteOpen,setPaletteOpen]=useState(false),paletteRef=useRef(null),paletteTrigger=useRef(null);
  const [expandedNotes,setExpandedNotes]=useState(false),compactViewport=useRef(null),viewTransition=useRef(false);
  const closePalette=useDiagramPopover(paletteOpen,setPaletteOpen,paletteRef,paletteTrigger);
  useEffect(()=>{if(!visible)setPaletteOpen(false);},[visible]);
  const graphRef=useRef(graph),history=useRef(createDiagramHistory(graph)),[historyTick,setHistoryTick]=useState(0),clipboard=useRef(null),dragStart=useRef(null),flowRoot=useRef(null);
  const [selectionMode,setSelectionMode]=useReducer((_,mode)=>mode,'pan');
  const lastPublished=useRef(JSON.stringify(cleanStructured(graph)));
  useEffect(()=>{
    const incoming=cleanStructured(board.snapshot.structured),stamp=JSON.stringify(incoming);
    if(stamp===lastPublished.current)return;
    lastPublished.current=stamp;
    const local=graphRef.current;
    const nodeState=new Map(local.nodes.map(node=>[node.id,node]));
    const selectedEdges=new Set(local.edges.filter(edge=>edge.selected).map(edge=>edge.id));
    // Presence/selection and viewport belong to this participant. Remote edits
    // replace only persisted graph data and never publish a response snapshot.
    const next={...incoming,viewport:local.viewport,nodes:incoming.nodes.map(node=>({...node,selected:Boolean(nodeState.get(node.id)?.selected),...(nodeState.get(node.id)?.measured?{measured:nodeState.get(node.id).measured}:{})})),edges:incoming.edges.map(edge=>({...edge,selected:selectedEdges.has(edge.id)}))};
    graphRef.current=next;setGraph(next);
    if(!onUndo)history.current=createDiagramHistory(cleanStructured(next));
    setHistoryTick(value=>value+1);
  },[board.snapshot.structured,onUndo]);
  const flow=useReactFlow();
  const displayGraph=useMemo(()=>{
    const projected=expandedNotes?expandedNotesGraph(graph):graph;
    return {...projected,nodes:projected.nodes.map(node=>node.type==='group'?{...node,zIndex:-1,dragHandle:'.diagram-group-header'}:node)};
  },[graph,expandedNotes]);
  const expandedRoutes=useMemo(()=>expandedNotes?getExpandedRoutes(displayGraph):null,[displayGraph,expandedNotes]);
  const sequenceNodes=useMemo(()=>new Map(displayGraph.nodes.filter(node=>node.type==='participant').map(node=>[node.id,node])),[displayGraph.nodes]);
  const arrangedSequence=useMemo(()=>arrangeSequence(graph),[graph]);
  const expandedBounds=useMemo(()=>expandedNotes?getExpandedRouteBounds(displayGraph,expandedRoutes):null,[displayGraph,expandedNotes,expandedRoutes]);
  const unroutedCount=expandedRoutes?Object.values(expandedRoutes).filter(route=>route.unroutable).length:0;
  function toggleExpandedNotes(){
    viewTransition.current=true;
    if(!expandedNotes)compactViewport.current=flow.getViewport();
    closePalette(false);
    onPointerUpdate?.({mode:'structured',cursor:null});
    setExpandedNotes(value=>!value);
  }
  useEffect(()=>{
    if(!viewTransition.current)return;
    let second;
    const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{
      const operation=expandedNotes?flow.fitBounds(expandedBounds,{padding:.15,maxZoom:1,duration:0}):flow.setViewport(compactViewport.current||graphRef.current.viewport,{duration:0});
      Promise.resolve(operation).finally(()=>{viewTransition.current=false;});
    });});
    return()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);};
  },[expandedNotes,flow]);
  const nodesInitialized=useNodesInitialized(), viewportInitialized=useRef(false);
  useEffect(()=>{
    // An empty board has no measured nodes, but its viewport is ready to pan
    // and save. Do not fit/recenter it when the first object is added later.
    if(!visible||viewportInitialized.current||(graph.nodes.length>0&&!nodesInitialized))return;
    viewportInitialized.current=true;
    const viewport=board.snapshot.structured.viewport;
    if(graph.nodes.length&&(!viewport||viewport.x===0&&viewport.y===0&&viewport.zoom===1))void flow.fitView({padding:.25,maxZoom:1});
  },[visible,nodesInitialized,graph.nodes.length,flow]);
  const publish=useCallback((next,group='',record=true)=>{if(readOnly)return;if(record&&!onUndo)history.current.push(cleanStructured(next),group);graphRef.current=next;setGraph(next);setHistoryTick(value=>value+1);const snapshot=cleanStructured(next);lastPublished.current=JSON.stringify(snapshot);onChange(snapshot);},[onChange,readOnly,onUndo]);
  const mutate=fn=>publish(fn(graphRef.current));
  const selectedEdges=graph.edges.filter(edge=>edge.selected), selectedNodes=graph.nodes.filter(node=>node.selected);
  const currentEdge=selectedEdges.length===1?selectedEdges[0]:null;
  const currentParticipant=selectedNodes.length===1&&selectedNodes[0].type==='participant'?selectedNodes[0]:null;
  const participantGeometry=currentParticipant?getSequenceGeometry(currentParticipant.data):null;
  const updateNode=(id,patch,historyGroup='node:'+id)=>publish({...graphRef.current,nodes:graphRef.current.nodes.map(node=>{
    if(node.id!==id)return node;
    const next={...node,data:{...node.data,...patch}};
    if(node.type==='umlClass'&&(patch.fields||patch.methods)) {
      const height=Math.max(node.height||node.style?.height||0,146+28*Math.max(1,next.data.fields.length)+28*Math.max(1,next.data.methods.length));
      if(node.height||node.style?.height){next.height=height;next.style={...node.style,height};}
    }
    if(node.type==='dataStructure') {
      const minimum=getStructureSize(next.data);
      for(const axis of ['width','height'])if(Number.isFinite(node[axis])||Number.isFinite(node.style?.[axis])) {
        next[axis]=Math.max(node[axis]||0,node.style?.[axis]||0,minimum[axis]);
        next.style={...next.style,[axis]:next[axis]};
      }
    }
    return next;
  })},historyGroup);
  const updateEdge=(id,patch)=>publish({...graphRef.current,edges:graphRef.current.edges.map(edge=>edge.id===id?{...edge,data:{...edge.data,...patch}}:edge)},'edge:'+id);
  const actions={readOnly,expandedNotes,updateNode,fitGroup:id=>{if(!expandedNotes)mutate(state=>fitGroup(state,id));},ungroup:id=>{if(!expandedNotes)mutate(state=>ungroup(state,id));},addMember(id,section){const node=graphRef.current.nodes.find(node=>node.id===id);if(node&&(node.data[section]?.length||0)<100)updateNode(id,{[section]:[...(node.data[section]||[]),{id:uid(),text:section==='fields'?'- field: Type':'+ method(): void'}]});},removeMember(id,section,memberId){const node=graphRef.current.nodes.find(node=>node.id===id);if(node)updateNode(id,{[section]:node.data[section].filter(row=>row.id!==memberId)});}};
  const undo=()=>{if(readOnly)return;if(onUndo){onUndo();return;}const next=history.current.undo();if(next)publish(next,'',false);},redo=()=>{if(readOnly)return;if(onRedo){onRedo();return;}const next=history.current.redo();if(next)publish(next,'',false);};
  function arrangeParticipants() {
    if(readOnly||expandedNotes)return;
    const next=arrangeSequence(graphRef.current);
    if(next===graphRef.current)return;
    viewTransition.current=true;
    publish(next);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      Promise.resolve(flow.fitView({padding:.15,maxZoom:1})).finally(()=>{viewTransition.current=false;});
    }));
  }
  function editActivation(id,patch) {
    if(readOnly||!currentParticipant)return;
    if(Object.values(patch).some(value=>!Number.isInteger(value)))return;
    const activations=(currentParticipant.data.activations||[]).map(item=>{
      if(item.id!==id)return item;
      const next={...item,...patch};
      if(patch.startRow!==undefined)next.endRow=Math.max(next.startRow,next.endRow);
      if(patch.endRow!==undefined)next.startRow=Math.min(next.startRow,next.endRow);
      return next;
    });
    updateNode(currentParticipant.id,{activations});
  }
  function focusCanvas() { flowRoot.current?.closest('.diagram-structured')?.focus({preventScroll:true}); }
  function selectAll(selected=true) {
    const next=selectDiagramElements(graphRef.current,selected);
    if(next!==graphRef.current){graphRef.current=next;setGraph(next);}
    focusCanvas();
  }
  function chooseSelectionMode(mode) { setSelectionMode(mode);closePalette(false);focusCanvas(); }
  function removeSelected() {
    if(readOnly||expandedNotes)return;
    const next=deleteDiagramSelection(graphRef.current);
    if(next!==graphRef.current)publish(next);
    focusCanvas();
  }
  function groupSelection() {
    if(readOnly||expandedNotes)return;
    if(graphRef.current.nodes.length>=2000){onError('The board object limit is 2,000.');return;}
    mutate(state=>createGroup(state,state.nodes.filter(node=>node.selected).map(node=>node.id),{color:GROUP_COLORS[state.nodes.filter(node=>node.type==='group').length%GROUP_COLORS.length]}));
    closePalette(false);
  }
  function duplicate(fromClipboard=false) {
    const source=fromClipboard?clipboard.current:graphRef.current;if(!source)return;
    const extra=duplicateSelection(source.nodes,source.edges);if(!extra.nodes.length)return;
    if(graphRef.current.nodes.length+extra.nodes.length>2000){onError('The board object limit is 2,000.');return;}
    if(graphRef.current.edges.length+extra.edges.length>5000){onError('The board connection limit is 5,000.');return;}
    publish({...graphRef.current,nodes:[...graphRef.current.nodes.map(node=>({...node,selected:false})),...extra.nodes],edges:[...graphRef.current.edges,...extra.edges]});
  }
  function add(type,key,patch={},screenPoint) {
    if(readOnly||expandedNotes)return;
    if(graphRef.current.nodes.length>=2000){onError('The board object limit is 2,000.');return;}
    const rect=flowRoot.current?.getBoundingClientRect();const point=flow.screenToFlowPosition(screenPoint||{x:(rect?.left||0)+(rect?.width||700)/2,y:(rect?.top||0)+(rect?.height||500)/2});
    const node=makeNode(type,{x:point.x-120,y:point.y-70},key);node.selected=true;
    if(type==='participant') {
      const timeline=graphRef.current.nodes.find(item=>item.type==='participant'&&item.data.sequence);
      if(timeline) {
        node.data.sequence={...timeline.data.sequence};
        node.position.y=timeline.position.y;
        node.style={width:180,height:getSequenceGeometry(node.data).height};
      }
    }
    if(node.style)node.position={x:point.x-node.style.width/2,y:point.y-node.style.height/2};
    if(type==='participant'&&node.data.sequence)node.position.y=graphRef.current.nodes.find(item=>item.type==='participant'&&item.data.sequence).position.y;
    if(type==='component')node.data.name=DIAGRAM_COMPONENTS.find(item=>item.id===key)?.label||key;
    node.data={...node.data,...patch};
    publish({...graphRef.current,nodes:[...graphRef.current.nodes.map(node=>({...node,selected:false})),node]});
    closePalette(false);
    flowRoot.current?.closest('.diagram-structured')?.focus();
  }
  function addStructures(values, screenPoint) {
    if(readOnly||expandedNotes)return;
    try {
      if(!Array.isArray(values)||!values.length||values.length>20)throw new Error('Add between 1 and 20 containers at a time.');
      if(graphRef.current.nodes.length+values.length>2000)throw new Error('The board object limit is 2,000.');
      const rect=flowRoot.current?.getBoundingClientRect();
      const point=flow.screenToFlowPosition(screenPoint||{x:(rect?.left||0)+(rect?.width||700)/2,y:(rect?.top||0)+(rect?.height||500)/2});
      // Click-to-add must not bury the new container under the existing one.
      // Explicit drops retain the user's chosen position.
      const existing=flow.getNodes();
      const bounds=existing.length?getNodesBounds(existing):null;
      const origin=!screenPoint&&bounds?{x:bounds.x+bounds.width+48,y:bounds.y}:{x:point.x-120,y:point.y-70};
      let x=origin.x,y=origin.y,rowHeight=0;
      const nodes=values.map((value,index)=>{
        const data=cleanStructureData(value),size=getStructureSize(data);
        if(index&&index%3===0){x=origin.x;y+=rowHeight+48;rowHeight=0;}
        const node={id:uid(),type:'dataStructure',position:{x,y},data,selected:true};
        x+=size.width+40;rowHeight=Math.max(rowHeight,size.height);return node;
      });
      publish({...graphRef.current,nodes:[...graphRef.current.nodes.map(node=>({...node,selected:false})),...nodes]});
      if(!screenPoint){const size=getStructureSize(nodes[0].data);flow.setCenter(nodes[0].position.x+size.width/2,nodes[0].position.y+size.height/2,{zoom:Math.min(flow.getZoom(),1),duration:180});}
      closePalette(false);flowRoot.current?.closest('.diagram-structured')?.focus();
    }catch(error){onError(error.message);}
  }
  function dropStructure(event) {
    if(readOnly||expandedNotes)return;
    if(event.dataTransfer.types.includes(DIAGRAM_ITEM_DRAG_TYPE)) {
      event.preventDefault();
      const key=event.dataTransfer.getData(DIAGRAM_ITEM_DRAG_TYPE);
      if(key.length<=160&&DIAGRAM_COMPONENTS.some(item=>item.id===key))add('component',key,{}, {x:event.clientX,y:event.clientY});
      return;
    }
    if(!event.dataTransfer.types.includes(STRUCTURE_DRAG_TYPE))return;
    event.preventDefault();
    try { const raw=event.dataTransfer.getData(STRUCTURE_DRAG_TYPE);if(raw.length>200000)throw new Error('This container is too large.');addStructures([JSON.parse(raw)],{x:event.clientX,y:event.clientY}); }
    catch(error){onError('Could not add container: '+error.message);}
  }
  function align(axis) { if(selectedNodes.length<2||expandedNotes)return;const coordinate=Math.min(...selectedNodes.map(node=>node.position[axis]));onNodesChange(selectedNodes.map(node=>({type:'position',id:node.id,position:{...node.position,[axis]:coordinate}}))); }
  function onNodesChange(changes) {
    if(expandedNotes)changes=changes.filter(change=>change.type==='select');
    if(readOnly)changes=changes.filter(change=>change.type==='select'||(change.type==='dimensions'&&!change.resizing));
    if(!changes.length)return;
    const previous=graphRef.current;
    let next={...previous,nodes:applyNodeChanges(changes,previous.nodes)};
    next=applyGroupMoves(previous,next,changes);
    next=moveInternalConnectionRoutes(previous,next);
    const removed=new Set(changes.filter(change=>change.type==='remove').map(change=>change.id));if(removed.size){next.edges=next.edges.filter(edge=>!removed.has(edge.source)&&!removed.has(edge.target));next.nodes=sanitizeGroupMembership(next.nodes);}
    if(changes.every(change=>change.type==='select'||(change.type==='dimensions'&&!change.resizing))){graphRef.current=next;setGraph(next);return;}
    if(changes.some(change=>change.type==='position'&&change.dragging)){graphRef.current=next;setGraph(next);return;}
    publish(next,changes.some(change=>change.type==='dimensions')?'resize':'');
  }
  function onEdgesChange(changes) { if(readOnly)changes=changes.filter(change=>change.type==='select');const next={...graphRef.current,edges:applyEdgeChanges(changes,graphRef.current.edges)};if(changes.every(change=>change.type==='select')){graphRef.current=next;setGraph(next);}else publish(next); }
  function onConnect(connection) { if(readOnly||expandedNotes)return;if(graphRef.current.edges.length>=5000){onError('The board connection limit is 5,000.');return;}const source=graphRef.current.nodes.find(node=>node.id===connection.source);const target=graphRef.current.nodes.find(node=>node.id===connection.target);const sequence=source?.type==='participant'&&target?.type==='participant';const relation=sequence&&!['message','return','async'].includes(connectionType)?'message':connectionType;mutate(state=>({...state,edges:[...state.edges,{...connection,id:uid(),type:'relation',data:{label:'',relation,curvature:.3,...(!sequence?{routing:connectionRouting}: {})}}]})); }
  function keyboard(event) {
    if(!visible||!isDiagramShortcutTarget(event,event.currentTarget)||event.altKey)return;
    const command=event.metaKey||event.ctrlKey;
    let action;
    if(event.key==='Escape')action=()=>selectAll(false);
    else if(command&&event.key.toLowerCase()==='a')action=()=>selectAll();
    else if(readOnly||expandedNotes)return;
    else if(!command&&event.key==='/')action=()=>{setPalette('hld');setPaletteOpen(true);};
    else if(command&&event.key.toLowerCase()==='z')action=()=>event.shiftKey?redo():undo();
    else if(command&&event.key.toLowerCase()==='y')action=redo;
    else if(command&&event.key.toLowerCase()==='d')action=()=>duplicate();
    else if(command&&event.key.toLowerCase()==='g')action=groupSelection;
    else if(command&&event.key.toLowerCase()==='c')action=()=>{clipboard.current=structuredClone(graphRef.current);};
    else if(command&&event.key.toLowerCase()==='v')action=()=>duplicate(true);
    else if(event.key==='Delete'||event.key==='Backspace')action=removeSelected;
    if(action){event.preventDefault();event.stopPropagation();action();}
  }
  async function imageExport(kind) {
    try {
      if(!graph.nodes.length)throw new Error('Add an object before exporting.');
      const iconNames=[...new Set(flow.getNodes().filter(node=>node.type==='component').map(node=>getDiagramComponent(node.data.componentKey).iconName).filter(Boolean))];
      const iconAssets=await prefetchEraserIcons(iconNames,{color:getComputedStyle(flowRoot.current).getPropertyValue('--text').trim()||'#18202b'});
      if(iconNames.some(name=>!(iconAssets instanceof Map?iconAssets.get(name):iconAssets?.[name])))throw new Error('Some Eraser icons could not be loaded. Reconnect to load them before exporting; no incomplete image was downloaded.');
      if(kind==='svg') {
        const colors=getComputedStyle(flowRoot.current);
        download(filename(board.name)+'.svg',exportStructuredSvg({nodes:flow.getNodes(),edges:flow.getEdges()},{background:colors.getPropertyValue('--bg').trim(),foreground:colors.getPropertyValue('--text').trim(),line:colors.getPropertyValue('--diagram-connector').trim(),iconAssets:iconAssets instanceof Map?Object.fromEntries(iconAssets):iconAssets}),'image/svg+xml;charset=utf-8');
        return;
      }
      const viewport=flowRoot.current?.querySelector('.react-flow__viewport');if(!viewport)return;
      await window.document.fonts.ready;
      const bounds=expandedBounds||(graph.nodes.some(node=>node.type==='participant')||graph.edges.some(edge=>edge.data?.routing||edge.data?.waypoints?.length)?getStructuredBounds({nodes:flow.getNodes(),edges:flow.getEdges()}):getNodesBounds(flow.getNodes()));if(!graph.nodes.length)throw new Error('Add an object before exporting.');
      const width=Math.min(4096,Math.max(1200,Math.ceil(bounds.width+120))),height=Math.min(4096,Math.max(800,Math.ceil(bounds.height+120)));
      const transform=getViewportForBounds(bounds,width,height,.05,2,.1);
      const {toBlob}=await import('html-to-image');
      const output=await toBlob(viewport,{width,height,pixelRatio:1,backgroundColor:getComputedStyle(flowRoot.current).getPropertyValue('--bg').trim()||'#111419',style:{width:`${width}px`,height:`${height}px`,transform:`translate(${transform.x}px,${transform.y}px) scale(${transform.zoom})`},filter:node=>!node.classList?.contains('react-flow__handle')&&!node.classList?.contains('react-flow__resize-control')&&!node.matches?.('button,.diagram-structure-tools,.diagram-structure-stepper,.diagram-structure-inline-error')});
      if(!output)throw new Error('The browser could not create a PNG image. Try again or export SVG.');
      download(filename(board.name)+'.'+kind,output);
    }catch(error){onError('Could not export image: '+error.message);}
  }
  const blockReadOnlyInput=event=>{if(readOnly&&event.target.closest('.diagram-flow input,.diagram-flow textarea,.diagram-flow select,[contenteditable="true"]')){event.preventDefault();event.stopPropagation();if(event.type==='focus')event.target.blur();}};
  return <div className="diagram-structured" data-read-only={readOnly} data-selection-mode={selectionMode} onKeyDownCapture={keyboard} onBeforeInputCapture={blockReadOnlyInput} onFocusCapture={blockReadOnlyInput} onPointerDownCapture={blockReadOnlyInput} tabIndex={-1}>
    <div className="diagram-toolbar" role="toolbar" aria-label="Structured diagram tools">
      <div className="diagram-selection-tools" role="group" aria-label="Canvas selection">
        <button aria-label="Pan mode" aria-pressed={selectionMode==='pan'} title="Drag empty canvas to pan. Shift-drag selects a region." onClick={()=>chooseSelectionMode('pan')}>Pan</button>
        <button aria-label="Select mode" aria-pressed={selectionMode==='select'} title="Drag empty canvas to select a region. Use Shift-click, Cmd-click on Mac, or Ctrl-click on Windows/Linux to add or remove items. Hold Space or middle/right-drag to pan." onClick={()=>chooseSelectionMode('select')}>Select</button>
        <button aria-label="Select all" disabled={!graph.nodes.length&&!graph.edges.length} title="Select all objects and connections (⌘/Ctrl A)" onClick={()=>selectAll()}>Select all</button>
        <button className="diagram-selection-delete" disabled={readOnly||expandedNotes||(!selectedNodes.length&&!selectedEdges.length)} aria-label="Delete selection" title="Delete selected objects and connections (Delete / Backspace). Unselected frame contents stay. Undo restores the deletion." onClick={removeSelected}><StudioIcon name="trash"/>Delete</button>
        {(selectedNodes.length>0||selectedEdges.length>0)&&<span className="diagram-selection-count" role="status" title={`${selectedNodes.length} objects and ${selectedEdges.length} connections selected`}>{selectedNodes.length+selectedEdges.length} selected</span>}
      </div>
      <div className="diagram-palette-tabs" role="group" aria-label="Component category">{[['class','LLD'],['sequence','Sequence'],['hld','HLD'],['dsa','DSA']].map(([key,label])=><button key={key} disabled={expandedNotes} aria-pressed={palette===key} title={key==='dsa'?'Data structures and manual dry runs':label} onClick={()=>{setPalette(key);setPaletteOpen(true);}}>{label}</button>)}</div>
      <button ref={paletteTrigger} disabled={readOnly||expandedNotes} className="diagram-add-trigger" aria-haspopup="dialog" aria-expanded={paletteOpen} aria-controls="diagram-component-picker" onClick={()=>setPaletteOpen(value=>!value)}><StudioIcon name="plus"/>Add<span className="diagram-add-label"> objects</span><StudioIcon name="chevron"/></button>
      <label className="diagram-relation-picker"><span>Connect</span><select aria-label="New connection type" value={connectionType} onChange={event=>setConnectionType(event.target.value)}>{RELATIONS.map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
      <label className="diagram-relation-picker"><span>Route</span><select aria-label="New connection route" disabled={readOnly||expandedNotes} value={connectionRouting} onChange={event=>setConnectionRouting(event.target.value)}><option value="elbow">Elbow</option><option value="straight">Straight</option><option value="curve">Arc</option></select></label>
      <div className="diagram-tool-group"><button className="diagram-icon-button" disabled={readOnly||!(onUndo?canUndo:history.current.canUndo)} aria-label="Undo" title="Undo (⌘/Ctrl Z)" onClick={undo}><StudioIcon name="undo"/></button><button className="diagram-icon-button" disabled={readOnly||!(onRedo?canRedo:history.current.canRedo)} aria-label="Redo" title="Redo (⌘/Ctrl Shift Z)" onClick={redo}><StudioIcon name="redo"/></button><button className="diagram-icon-button" disabled={readOnly||expandedNotes||!selectedNodes.length} onClick={()=>duplicate()} aria-label="Duplicate selection" title="Duplicate selection (⌘/Ctrl D)"><StudioIcon name="copy"/></button></div>
      <div className="diagram-tool-group"><button disabled={readOnly||expandedNotes||selectedNodes.length<2} onClick={()=>align('x')}>Align left</button><button disabled={readOnly||expandedNotes||selectedNodes.length<2} onClick={()=>align('y')}>Align top</button><button aria-pressed={grid} onClick={()=>setGrid(!grid)}>Snap</button><button aria-pressed={showMap} onClick={()=>setShowMap(!showMap)}>Map</button></div>
      {sequenceNodes.size>0&&<button disabled={readOnly||expandedNotes||arrangedSequence===graph} title="Align participants and fit message spacing. Available for sequence-only boards; Undo restores the previous layout." onClick={arrangeParticipants}>Arrange sequence</button>}
      <div className="diagram-tool-group"><button disabled={readOnly||expandedNotes||!selectedNodes.length} className="diagram-icon-button" aria-label="Group selection" title="Group selection in a colored frame (⌘/Ctrl G)" onClick={groupSelection}><StudioIcon name="boards"/></button><button className="diagram-notes-view-toggle" aria-label={expandedNotes?'Collapse component notes':'Expand all component notes'} aria-pressed={expandedNotes} disabled={!graph.nodes.some(node=>node.type==='component')} title={expandedNotes?'Return to your saved compact layout':'Show all notes beside their icons in a spaced reading layout'} onClick={toggleExpandedNotes}><StudioIcon name="note"/>{expandedNotes?'Compact':'Expand notes'}</button></div>
      <div className="diagram-tool-group diagram-export-group"><button onClick={()=>imageExport('png')}>PNG</button><button title="Portable SVG with vector shapes and selectable text" onClick={()=>imageExport('svg')}>SVG</button></div>
    </div>
    <div className="diagram-workarea" onDragOver={event=>{if(!readOnly&&event.dataTransfer.types.includes(DIAGRAM_ITEM_DRAG_TYPE)){event.preventDefault();event.dataTransfer.dropEffect='copy';}}}>
      {paletteOpen&&!readOnly&&<section ref={paletteRef} id="diagram-component-picker" className={'diagram-palette diagram-popover'+(palette==='hld'?' diagram-palette-library':'')} role="dialog" aria-label="Add diagram objects">
        <header className="diagram-popover-heading"><strong>{palette==='class'?'Class design':palette==='sequence'?'Interactions':palette==='dsa'?'Data structures':'Component library'}</strong><button className="diagram-icon-button" aria-label="Close component library" onClick={()=>closePalette()}><StudioIcon name="close"/></button></header>
        {palette==='class'&&<><button data-popover-autofocus onClick={()=>add('umlClass')}><StudioIcon name="class"/><strong>UML class</strong><small>Name · fields · methods</small></button><p>Edit text in place. Use + / − for members and side handles to connect classes.</p></>}
        {palette==='sequence'&&<><button data-popover-autofocus onClick={()=>add('participant')}><StudioIcon name="participant"/><strong>Participant</strong><small>Header · lifeline · activation bars</small></button><p>Connect matching row numbers for a shared timeline. Choose Message, Return or Async. Select a participant to add activation bars; Arrange sequence aligns and spaces a sequence-only board.</p></>}
        {palette==='hld'&&<><DiagramInsertLibrary onAdd={key=>add('component',key)}/><button className="diagram-replica-shortcut" onClick={()=>add('component','worker',{name:'Workers',replicas:3})} title="A stack of worker pods with an editable replica count"><StudioIcon name="copy"/><strong>Worker replicas</strong><small>One group · editable pod count</small></button></>}
        {palette==='dsa'&&<DiagramStructurePicker onAdd={addStructures}/>}
        <button onClick={()=>add('note')}><StudioIcon name="note"/><strong>Note</strong><small>Decisions and annotations</small></button>
        <button disabled={!selectedNodes.length} onClick={groupSelection}><StudioIcon name="boards"/><strong>Colored group</strong><small>{selectedNodes.length?'Frame the selected objects · moves together':'Select objects, then group · ⌘/Ctrl G'}</small></button>
        <details className="diagram-palette-help"><summary>Canvas shortcuts</summary><p>Pan mode drags empty canvas; Select mode drags a selection box. Shift-drag also selects a region. Use Shift-click, Cmd-click on Mac, or Ctrl-click on Windows/Linux to add or remove objects and connections. Cmd/Ctrl A selects all; Delete/Backspace deletes the selection; Cmd/Ctrl Z undoes it; Escape clears selection. Hold Space or middle/right-drag to pan. Cmd/Ctrl C, V and D copy, paste and duplicate within this canvas.</p></details>
      </section>}
    <div ref={flowRoot} className="diagram-flow" data-notes-view={expandedNotes?'expanded':'compact'} data-selection-mode={selectionMode}
      onPointerMove={event=>{if(onPointerUpdate&&!expandedNotes)onPointerUpdate({mode:'structured',cursor:flow.screenToFlowPosition({x:event.clientX,y:event.clientY})});}}
      onPointerLeave={()=>onPointerUpdate?.({mode:'structured',cursor:null})}
      onDragOver={event=>{if(!readOnly&&!expandedNotes&&event.dataTransfer.types.includes(STRUCTURE_DRAG_TYPE)){event.preventDefault();event.dataTransfer.dropEffect='copy';}}} onDrop={dropStructure}>
      <CanvasReadOnlyContext.Provider value={readOnly}><DiagramNodeActionsContext.Provider value={actions}><DiagramEdgeActionsContext.Provider value={{updateEdge,readOnly,expandedRoutes,sequenceNodes}}>
        <ReactFlow nodes={displayGraph.nodes} edges={displayGraph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} connectionMode={ConnectionMode.Loose}
          onReconnect={(old,connection)=>{if(!readOnly&&!expandedNotes)mutate(state=>({...state,edges:state.edges.map(edge=>edge.id===old.id?{...edge,...connection}:edge)}));}}
          onNodeDragStart={()=>{dragStart.current=graphRef.current;}}
          onNodeDragStop={()=>{if(!expandedNotes)publish(graphRef.current);dragStart.current=null;}}
          onMoveEnd={(event,viewport)=>{if(visible&&viewportInitialized.current&&!expandedNotes&&!viewTransition.current){if(!event||onUndo||readOnly){graphRef.current={...graphRef.current,viewport};}else publish({...graphRef.current,viewport},'viewport');}}}
          defaultViewport={graph.viewport} snapToGrid={grid} snapGrid={[16,16]} minZoom={.1} maxZoom={3} deleteKeyCode={null}
          panOnDrag={selectionMode==='select'?[1,2]:[0,1,2]} selectionOnDrag={selectionMode==='select'} selectionMode="partial" selectionKeyCode="Shift" multiSelectionKeyCode={['Shift','Meta','Control']} zoomOnDoubleClick={false}
          nodesDraggable={!board.archived&&!readOnly&&!expandedNotes} nodesConnectable={!readOnly&&!expandedNotes} edgesReconnectable={!readOnly&&!expandedNotes}
          onlyRenderVisibleElements={false} onPaneClick={focusCanvas} onSelectionEnd={focusCanvas}>
          <Background gap={20} size={.75} color="var(--diagram-grid)"/>
          <Controls showInteractive={false} fitViewOptions={{padding:.25,maxZoom:1}} onFitView={()=>{if(expandedBounds)void flow.fitBounds(expandedBounds,{padding:.15,maxZoom:1});}}/>
          {showMap&&<MiniMap pannable zoomable nodeColor="var(--blue)" maskColor="color-mix(in srgb,var(--bg) 70%,transparent)"/>}
          <ViewportPortal>{presence.filter(peer=>!expandedNotes&&peer.mode==='structured'&&Number.isFinite(peer.cursor?.x)&&Number.isFinite(peer.cursor?.y)).map(peer=><div key={peer.clientId} style={{position:'absolute',transform:`translate(${peer.cursor.x}px,${peer.cursor.y}px)`,pointerEvents:'none',zIndex:1000,color:peer.color||'#78a9ff'}}><svg width="18" height="22" viewBox="0 0 18 22" fill="currentColor"><path d="M1 1v17l5-5 4 8 3-2-4-8h8Z" stroke="white"/></svg><span style={{background:peer.color||'#78a9ff',color:'#10141c',borderRadius:4,padding:'2px 5px',fontSize:11,whiteSpace:'nowrap'}}>{peer.name||'Guest'}</span></div>)}</ViewportPortal>
        </ReactFlow>
      </DiagramEdgeActionsContext.Provider></DiagramNodeActionsContext.Provider></CanvasReadOnlyContext.Provider>
      {currentEdge&&<section className="diagram-edge-inspector" aria-label="Selected relationship"><strong>Relationship</strong><select disabled={readOnly||expandedNotes} aria-label="Selected connection type" value={currentEdge.data.relation} onChange={event=>updateEdge(currentEdge.id,{relation:event.target.value})}>{RELATIONS.map(([key,label])=><option value={key} key={key}>{label}</option>)}</select>
        {!(sequenceNodes.get(currentEdge.source)?.type==='participant'&&sequenceNodes.get(currentEdge.target)?.type==='participant')&&<><label>Route<select aria-label="Selected connection route" disabled={readOnly||expandedNotes} value={currentEdge.data.routing||'curve'} onChange={event=>updateEdge(currentEdge.id,{routing:event.target.value})}><option value="elbow">Elbow</option><option value="straight">Straight</option><option value="curve">Arc</option></select></label><button disabled={readOnly||expandedNotes} onClick={()=>updateEdge(currentEdge.id,{routing:currentEdge.data.routing||'curve',waypoints:[],labelOffset:{x:0,y:0}})}>Reset arrow route</button><small>Drag a round handle to bend. Drag + or double-click the line to add bends. Double-click a bend to remove it. Drag the label grip to reposition text.</small></>}
        {(!currentEdge.data.routing||currentEdge.data.routing==='curve')&&<label>Curve<input disabled={readOnly||expandedNotes} type="range" min="0.05" max="1.2" step="0.05" value={currentEdge.data.curvature} onChange={event=>updateEdge(currentEdge.id,{curvature:Number(event.target.value)})}/></label>}<small>{readOnly?'This board is read-only.':expandedNotes?'Return to Compact to edit arrow routes.':'Escape cancels a bend drag; Undo restores the previous route.'}</small></section>}
      {!currentEdge&&currentParticipant&&<section className="diagram-edge-inspector diagram-sequence-inspector" aria-label="Participant activations">
        <strong>Execution / activation</strong><small>Mark the rows where this participant is executing. Bars are authored, not inferred from messages.</small>
        {(currentParticipant.data.activations||[]).map((activation,index)=><fieldset key={activation.id} disabled={readOnly}>
          <legend>Activation {index+1}</legend>
          <label>Start row<input aria-label={`Start row ${index+1}`} type="number" min="1" max={participantGeometry.rowCount} value={activation.startRow+1} onChange={event=>{if(event.target.value!=='')editActivation(activation.id,{startRow:Math.max(0,Math.min(participantGeometry.rowCount-1,Number(event.target.value)-1))});}}/></label>
          <label>End row<input aria-label={`End row ${index+1}`} type="number" min="1" max={participantGeometry.rowCount} value={activation.endRow+1} onChange={event=>{if(event.target.value!=='')editActivation(activation.id,{endRow:Math.max(0,Math.min(participantGeometry.rowCount-1,Number(event.target.value)-1))});}}/></label>
          <label>Nesting<input aria-label={`Nesting ${index+1}`} type="number" min="0" max="8" value={activation.depth||0} onChange={event=>{if(event.target.value!=='')editActivation(activation.id,{depth:Math.max(0,Math.min(8,Number(event.target.value)))});}}/></label>
          <button aria-label={`Remove activation ${index+1}`} onClick={()=>updateNode(currentParticipant.id,{activations:currentParticipant.data.activations.filter(item=>item.id!==activation.id)})}>Remove</button>
        </fieldset>)}
        <button disabled={readOnly||(currentParticipant.data.activations||[]).length>=64} onClick={()=>updateNode(currentParticipant.id,{activations:[...(currentParticipant.data.activations||[]),{id:uid(),startRow:0,endRow:Math.min(2,participantGeometry.rowCount-1),depth:0}]})}>Add activation</button>
      </section>}
      {!graph.nodes.length&&<div className="diagram-canvas-hint"><strong>Make the first connection.</strong><span>Choose LLD, Sequence, HLD or DSA above, then add your first object.</span></div>}
      <div className="diagram-canvas-caption">{graph.nodes.length} objects · {graph.edges.length} connections <span role={unroutedCount?'status':undefined}>{unroutedCount?`${unroutedCount} connections could not be routed here · switch to Compact to see them`:expandedNotes?'Expanded notes · edit notes here; arrange in Compact':'Structured canvas · independent from Draw'}</span></div>
    </div></div>
  </div>;
}
