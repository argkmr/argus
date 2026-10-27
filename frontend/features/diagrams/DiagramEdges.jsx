"use client";
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow } from '@xyflow/react';
import { connectionGeometry, insertConnectionBend, MAX_BENDS } from './diagram-connection-routing.mjs';
import { getSelfLoopGeometry } from './diagram-edge-geometry.mjs';
import { getSequenceLabelLayout } from './diagram-sequence.mjs';

export const DiagramEdgeActionsContext = createContext({ updateEdge() {} });

export function RelationEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data = {}, selected }) {
  const { updateEdge, readOnly, expandedRoutes, sequenceNodes } = useContext(DiagramEdgeActionsContext);
  const flow = useReactFlow(), [draft, setDraft] = useState(null), dragCleanup = useRef(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  useEffect(() => { if(readOnly || !selected || expandedRoutes) { dragCleanup.current?.(); setDraft(null); } }, [readOnly, selected, expandedRoutes]);
  data = { ...data, ...draft };
  const marker = useId().replace(/[^a-zA-Z0-9]/g, '');
  const relation = data.relation || 'association';
  const sequence = ['message','return','async'].includes(relation);
  const sequenceVisual = sequence && sequenceNodes?.get(source)?.type === 'participant' && sequenceNodes?.get(target)?.type === 'participant';
  let [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: data.curvature || .3 });
  if (sequence) { path = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`; labelX = (sourceX + targetX) / 2; labelY = (sourceY + targetY) / 2; }
  let selfSpan;
  if (source === target) {
    const loop=getSelfLoopGeometry({ sourceX, sourceY, targetX, targetY, sourcePosition, sequence, curvature: data.curvature });
    ({ path, labelX, labelY }=loop);
    selfSpan=Math.abs(loop.controls[1].x-sourceX);
  }
  const expandedRoute=expandedRoutes?.[id];
  if(expandedRoute)({path,labelX,labelY}=expandedRoute);
  const authored = !sequenceVisual && !expandedRoute && connectionGeometry(data, {x:sourceX,y:sourceY,direction:sourcePosition}, {x:targetX,y:targetY,direction:targetPosition});
  if(authored)({path,labelX,labelY}=authored);
  const editable = selected && !readOnly && !expandedRoute && !sequenceVisual && Boolean(authored);
  function drag(event, kind, index = -1, insert = false) {
    if(!editable || event.button!==0)return;
    event.preventDefault(); event.stopPropagation(); dragCleanup.current?.();
    const start=flow.screenToFlowPosition({x:event.clientX,y:event.clientY},{snapToGrid:false}), pointerId=event.pointerId, target=event.currentTarget;
    target.setPointerCapture?.(pointerId);
    const base=insert?insertConnectionBend(authored,start):authored.waypoints.map(p=>({...p}));
    if(insert)index=base.findIndex(p=>p.x===start.x&&p.y===start.y);
    if(kind==='bend'&&(index<0||index>=base.length))return;
    let patch=null,moved=false;
    const makePatch=position=>kind==='label'?{labelOffset:{x:(data.labelOffset?.x||0)+position.x-start.x,y:(data.labelOffset?.y||0)+position.y-start.y}}:{waypoints:base.map((p,i)=>i===index?{x:position.x,y:position.y}:p)};
    const move=event=>{if(event.pointerId!==pointerId)return;const position=flow.screenToFlowPosition({x:event.clientX,y:event.clientY},{snapToGrid:false});if(Math.hypot(position.x-start.x,position.y-start.y)>1)moved=true;patch=makePatch(position);setDraft(patch);};
    const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',escape,true);if(target.hasPointerCapture?.(pointerId))target.releasePointerCapture(pointerId);dragCleanup.current=null;};
    const cancel=()=>{cleanup();setDraft(null);};
    const up=event=>{if(event.pointerId!==pointerId)return;cleanup();setDraft(null);if(moved||insert)updateEdge(id,patch||makePatch(start));};
    const escape=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);window.addEventListener('keydown',escape,true);dragCleanup.current=cleanup;
  }
  function removeBend(index){updateEdge(id,{waypoints:authored.waypoints.filter((_,i)=>i!==index)});}
  const diamond = ['aggregation','composition'].includes(relation);
  const hollow = ['inheritance','implementation'].includes(relation);
  const dashed = ['dependency','implementation','return'].includes(relation);
  const color = sequenceVisual
    ? selected ? 'var(--diagram-sequence-accent, #55b9d8)' : 'var(--diagram-sequence-connector, var(--diagram-connector, var(--muted)))'
    : selected ? 'var(--accent)' : 'var(--diagram-connector, var(--muted))';
  const sequenceLabel = sequenceVisual && !expandedRoute ? getSequenceLabelLayout(data.label || '', source === target ? selfSpan : Math.abs(targetX - sourceX), { self: source === target }) : null;
  // An unlabelled message still needs an editable target. This is view-only;
  // neither the placeholder nor wrapping is written into the board document.
  if (sequenceLabel) sequenceLabel.height = Math.max(26, sequenceLabel.height);
  if (sequenceLabel && source === target) {
    const direction=sourcePosition==='left'?-1:1;
    labelX=sourceX+direction*Math.max(Math.abs(labelX-sourceX),sequenceLabel.width/2+10);
  }
  const labelTop = sequenceLabel ? labelY - sequenceLabel.height / 2 - 8 : labelY - (!expandedRoute && sequence ? 14 : 0);
  return <>
    <defs>
      <marker id={marker+'end'} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        {relation === 'async' || relation === 'return' ? <path d="M1 1 L11 6 L1 11" fill="none" stroke={color} strokeWidth="1.5"/> : <path d="M1 1 L11 6 L1 11 Z" fill={hollow ? 'var(--surface)' : color} stroke={color} strokeWidth="1.4"/>}
      </marker>
      <marker id={marker+'start'} viewBox="0 0 16 12" refX="0" refY="6" markerWidth="16" markerHeight="12" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 6 L8 1 L16 6 L8 11 Z" fill={relation === 'composition' ? color : 'var(--surface)'} stroke={color} strokeWidth="1.4"/></marker>
    </defs>
    <g onDoubleClick={event=>{
      if(editable&&authored.waypoints.length<MAX_BENDS){event.stopPropagation();updateEdge(id,{waypoints:insertConnectionBend(authored,flow.screenToFlowPosition({x:event.clientX,y:event.clientY},{snapToGrid:false}))});}
    }}><BaseEdge id={id} path={path} className={sequenceVisual ? 'diagram-sequence-edge' : undefined} markerEnd={diamond ? undefined : `url(#${marker}end)`} markerStart={diamond ? `url(#${marker}start)` : undefined} style={{ stroke: color, strokeWidth: selected ? 2.2 : sequenceVisual ? 1.6 : 1.7, strokeDasharray: dashed ? '7 5' : undefined }} interactionWidth={24}/></g>
    {editable && <EdgeLabelRenderer>
      {authored.waypoints.map((p,index)=><button key={'bend-'+index} className="diagram-bend-handle nodrag nopan nokey" aria-label={'Connection bend '+(index+1)} title="Drag to reshape; double-click or Delete to remove this bend" style={{transform:`translate(-50%,-50%) translate(${p.x}px,${p.y}px)`}} onPointerDown={event=>drag(event,'bend',index)} onClick={event=>event.stopPropagation()} onDoubleClick={event=>{event.preventDefault();event.stopPropagation();removeBend(index);}} onKeyDown={event=>{
        event.stopPropagation();
        if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();removeBend(index);}
        else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const delta=event.shiftKey?16:4;updateEdge(id,{waypoints:authored.waypoints.map((point,i)=>i===index?{x:point.x+(event.key==='ArrowRight'?delta:event.key==='ArrowLeft'?-delta:0),y:point.y+(event.key==='ArrowDown'?delta:event.key==='ArrowUp'?-delta:0)}:point)});}
      }}/>)}
      {authored.waypoints.length<MAX_BENDS && authored.points.slice(1).map((p,index)=>{const a=authored.points[index];return Math.hypot(p.x-a.x,p.y-a.y)>44?<button key={'segment-'+index} className="diagram-bend-handle is-insert nodrag nopan nokey" aria-label={'Add connection bend on segment '+(index+1)} title="Drag to add a bend" style={{transform:`translate(-50%,-50%) translate(${(p.x+a.x)/2}px,${(p.y+a.y)/2}px)`}} onPointerDown={event=>drag(event,'bend',-1,true)} onClick={event=>{event.stopPropagation();if(event.detail===0)updateEdge(id,{waypoints:insertConnectionBend(authored,{x:(p.x+a.x)/2,y:(p.y+a.y)/2})});}}>+</button>:null;})}
    </EdgeLabelRenderer>}
    {(!expandedRoute||expandedRoute.labelText&&!expandedRoute.unroutable)&&<EdgeLabelRenderer><div className={'diagram-edge-label nodrag nopan nokey' + (expandedRoute?' is-expanded':'') + (sequenceLabel?' is-sequence':'') + (selected ? ' is-selected' : '')} data-sequence-self={sequenceLabel ? source === target : undefined} style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelTop}px)` }}>
      {editable&&<button className="diagram-label-drag" aria-label="Move connection label" title="Drag the label independently of the arrow" onPointerDown={event=>drag(event,'label')} onKeyDown={event=>{event.stopPropagation();if(event.key==='Home'){event.preventDefault();updateEdge(id,{labelOffset:{x:0,y:0}});}}}>⠿</button>}
      {sequenceLabel ? <textarea aria-label="Connection label" title={readOnly ? 'Message label' : 'Edit message label'} value={data.label || ''} readOnly={readOnly} placeholder="Add message" maxLength={500} rows={sequenceLabel.lines.length || 1} style={{ width: sequenceLabel.width, height: sequenceLabel.height, fontSize: sequenceLabel.fontSize, lineHeight: `${sequenceLabel.lineHeight}px` }} onChange={event => { if (!readOnly) updateEdge(id, { label: event.target.value }); }} onKeyDown={event => event.stopPropagation()} /> : expandedRoute?<textarea aria-label="Connection label" title="Click to describe this relationship" value={data.label || ''} readOnly={readOnly} maxLength={500} style={{width:expandedRoute.labelWidth,height:expandedRoute.labelHeight}} onChange={event=>updateEdge(id,{label:event.target.value})} onKeyDown={event=>event.stopPropagation()}/>:<input aria-label="Connection label" title="Click to describe this relationship" value={data.label || ''} readOnly={readOnly} placeholder="Add label" maxLength={500} style={{ width: Math.min(340,Math.max(84,(data.label?.length || 0)*7.4+24)) }} onChange={event => updateEdge(id,{label:event.target.value})} onKeyDown={event => event.stopPropagation()} />}
    </div></EdgeLabelRenderer>}
  </>;
}
export const edgeTypes = { relation: RelationEdge };
