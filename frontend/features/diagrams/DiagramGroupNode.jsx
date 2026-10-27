"use client";

import { memo, useContext, useRef, useState } from 'react';
import { NodeResizer } from '@xyflow/react';
import { DiagramNodeActionsContext } from './DiagramNodes';
import { cleanGroupData, GROUP_COLORS } from './diagram-groups.mjs';
import { useDiagramPopover } from './useDiagramPopover';
import './diagram-groups.css';

const stop = event => event.stopPropagation();
const icon = path => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>;

export const DiagramGroupNode = memo(function DiagramGroupNode({ id, data, selected }) {
  const { updateNode, fitGroup, ungroup, readOnly = false, expandedNotes = false } = useContext(DiagramNodeActionsContext);
  const [colorsOpen, setColorsOpen] = useState(false);
  const colorsPanel = useRef(null), colorsTrigger = useRef(null);
  const closeColors = useDiagramPopover(colorsOpen, setColorsOpen, colorsPanel, colorsTrigger);
  const group = cleanGroupData(data);
  return <div className={`diagram-group-node ${selected ? 'is-selected' : ''} ${colorsOpen ? 'is-color-open' : ''}`} style={{ '--group-color': group.color }}>
    <NodeResizer isVisible={selected && !readOnly && !expandedNotes} minWidth={180} minHeight={114} color={group.color}/>
    <header className="diagram-group-header">
      <span className="diagram-group-drag-mark" aria-hidden="true">{icon('M8 5h.01M8 12h.01M8 19h.01M14 5h.01M14 12h.01M14 19h.01')}</span>
      <input className="diagram-group-name nodrag nopan nowheel nokey" aria-label="Group name" value={data.name || ''} placeholder="Group" maxLength={240} readOnly={readOnly} onChange={event => updateNode(id, { name: event.target.value })} onPointerDown={stop} onClick={stop} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}/>
      {colorsOpen && !readOnly && <div ref={colorsPanel} className="diagram-group-colors nodrag nopan nokey" role="group" aria-label="Group colors" onPointerDown={stop} onClick={stop} onKeyDown={stop}>
        {GROUP_COLORS.map((color, index) => <button key={color} type="button" aria-label={`${['Blue', 'Green', 'Purple', 'Amber', 'Rose', 'Cyan'][index]} group`} aria-pressed={group.color.toLowerCase() === color} style={{ '--swatch': color }} onClick={() => { updateNode(id, { color }); closeColors(); }}/>) }
      </div>}
      {!readOnly && <div className="diagram-group-actions nodrag nopan nokey" onPointerDown={stop} onClick={stop} onKeyDown={stop}>
        <button ref={colorsTrigger} type="button" aria-label="Group color" title="Group color" aria-expanded={colorsOpen} onClick={() => setColorsOpen(open => !open)}>{icon('M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 .8-2.8H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3ZM7 10h.01M10 7h.01M15 7h.01M17 11h.01')}</button>
        {!colorsOpen && <><button type="button" aria-label="Fit group to contents" title={expandedNotes ? 'Switch to compact notes to fit the group' : 'Fit group to contents'} disabled={expandedNotes} onClick={() => fitGroup?.(id)}>{icon('M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8z')}</button>
        <button type="button" aria-label="Ungroup without deleting contents" title={expandedNotes ? 'Switch to compact notes to ungroup' : 'Ungroup; keep contents'} disabled={expandedNotes} onClick={() => ungroup?.(id)}>{icon('M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6M9 9h6v6H9z')}</button></>}
      </div>}
    </header>
    {!group.memberIds.length && <span className="diagram-group-empty">Group</span>}
  </div>;
});
