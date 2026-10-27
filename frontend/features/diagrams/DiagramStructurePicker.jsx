"use client";
import { useEffect, useState } from 'react';
import { STRUCTURE_KINDS, createStructureData, countStructureEntries } from './diagram-structures.mjs';
import { parseStructureCode } from './diagram-structure-parser.mjs';

export const STRUCTURE_DRAG_TYPE = 'application/x-argus-data-structure';
const searchAliases = { list: 'ArrayList Vector tuple', map: 'HashMap TreeMap LinkedHashMap ConcurrentHashMap dictionary dict', set: 'HashSet TreeSet LinkedHashSet', queue: 'LinkedBlockingQueue ConcurrentLinkedQueue', deque: 'ArrayDeque collections.deque', heap: 'PriorityQueue heapq', 'linked-list': 'LinkedList', bitset: 'BitSet', object: 'record class struct' };

export function StructureGlyph({ kind }) {
  const drawing = kind === 'map' || kind === 'object'
    ? <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M10 3v18M3 9h18M3 15h18"/></>
    : kind === 'stack' ? <><path d="M4 3v18h16V3M4 9h16M4 15h16"/><path d="m9 3 3 3 3-3M12 1v5"/></>
    : ['tree','bst','heap','trie'].includes(kind) ? <><circle cx="12" cy="4" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 6v5M5 17v-6h14v6"/></>
    : kind === 'graph' ? <><circle cx="5" cy="5" r="3"/><circle cx="19" cy="9" r="3"/><circle cx="9" cy="20" r="3"/><path d="m8 6 8 2M6 8l2 9M17 12l-6 6"/></>
    : ['queue','deque'].includes(kind) ? <><path d="M3 5h18M3 19h18M1 12h5m-2-2 2 2-2 2M18 12h5"/><path d="M8 7v10M13 7v10M18 7v10"/></>
    : <><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M8 6v12M15 6v12"/></>;
  return <svg className="diagram-structure-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{drawing}</svg>;
}

export function structureDragStart(event, data) {
  event.dataTransfer.setData(STRUCTURE_DRAG_TYPE, JSON.stringify(data));
  event.dataTransfer.effectAllowed = 'copy';
}

export default function DiagramStructurePicker({ onAdd }) {
  const [mode, setMode] = useState('containers'), [search, setSearch] = useState('');
  const [language, setLanguage] = useState('auto'), [source, setSource] = useState('');
  const [preview, setPreview] = useState(null), [error, setError] = useState(''), [pending,setPending] = useState(false);
  useEffect(() => {
    setPreview(null); setError('');
    if (!source.trim()) { setPending(false); return; }
    setPending(true);
    const timer = setTimeout(() => {
      try { setPreview(parseStructureCode(source, language)); }
      catch (failure) { setError(failure.message); }
      setPending(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [source, language]);
  const kinds = STRUCTURE_KINDS.filter(item => `${item.label} ${item.description} ${item.id} ${searchAliases[item.id] || ''}`.toLowerCase().includes(search.toLowerCase().trim()));
  return <div className="diagram-structure-picker">
    <div className="diagram-structure-picker-tabs" role="group" aria-label="Data structure input">
      <button aria-pressed={mode==='containers'} onClick={()=>setMode('containers')} title="Empty editable containers">Containers</button>
      <button aria-pressed={mode==='code'} onClick={()=>setMode('code')} title="Java, JavaScript or Python declarations">{'</>'} Code</button>
    </div>
    {mode==='containers' ? <>
      <input data-popover-autofocus aria-label="Find data structure" placeholder="Array, HashMap, queue, tree…" value={search} onChange={event=>setSearch(event.target.value)}/>
      <div className="diagram-structure-catalog">{kinds.map(item=><button key={item.id} draggable onDragStart={event=>structureDragStart(event,createStructureData(item.id))} onClick={()=>onAdd([createStructureData(item.id)])} title={`${item.description} · Click or drag to canvas`}><StructureGlyph kind={item.id}/><span>{item.label}</span></button>)}</div>
      {!kinds.length&&<p>No matching container. Use Object for custom fields.</p>}
      <p className="diagram-structure-help">Empty to start. Click or drag onto the canvas, then use + / − and edit cells for a manual dry run.</p>
    </> : <>
      <select aria-label="Code language" value={language} onChange={event=>setLanguage(event.target.value)}>{[['auto','Auto detect'],['java','Java'],['javascript','JavaScript / Node.js'],['python','Python']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      <textarea data-popover-autofocus aria-label="Data structure declarations" spellCheck={false} maxLength={20000} placeholder={'Map<String, Map<String, ArrayList<String>>>\nint[] nums = {1, 2, 3};'} value={source} onChange={event=>setSource(event.target.value)}/>
      <p className="diagram-structure-help">Types, declarations and literal values become editable containers, including nested collections. Parsed locally; unsupported expressions are reported, never executed.</p>
      {pending&&<p role="status">Reading declarations…</p>}
      {error&&<p className="diagram-structure-parser-error" role="status">{error}</p>}
      {preview?.warnings?.map((warning,index)=><p key={index} className="diagram-structure-parser-error">{warning}</p>)}
      <div className="diagram-structure-results">{preview?.structures?.map((data,index)=><button key={index} draggable onDragStart={event=>structureDragStart(event,data)} onClick={()=>onAdd([data])} title="Click or drag this container onto the canvas"><StructureGlyph kind={data.structureKind}/><span><strong>{data.name}</strong><small>{data.typeSignature || data.implementation || data.structureKind} · {countStructureEntries(data)} units{countStructureEntries(data)>data.entries.length?' including nested':''}</small></span><span aria-hidden="true">+</span></button>)}</div>
      {preview?.structures?.length>1&&<button className="diagram-structure-add-all" onClick={()=>onAdd(preview.structures)}>Add all {preview.structures.length}</button>}
    </>}
  </div>;
}
