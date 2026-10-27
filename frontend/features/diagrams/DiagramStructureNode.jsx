"use client";

import { forwardRef, memo, useContext, useEffect, useId, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, useUpdateNodeInternals } from '@xyflow/react';
import { DiagramNodeActionsContext } from './DiagramNodes';
import { MAX_STRUCTURE_ENTRIES, MAX_STRUCTURE_LINKS, MAX_STRUCTURE_POINTERS, STRUCTURE_KINDS } from './diagram-structures.mjs';
import { applyStructureType, createStructureEntry, countStructureEntries, isKnownScalarType, parseStructureType } from './diagram-structure-types.mjs';
import { getStructureLayout } from './diagram-structure-layout.mjs';
import { useDiagramPopover } from './useDiagramPopover';
import './diagram-structures.css';

const stop = event => event.stopPropagation();
const editKey = event => { if (event.key !== 'Escape') event.stopPropagation(); };
const inputProps = { className: 'diagram-inline-input nodrag nopan nowheel nokey', spellCheck: false, autoComplete: 'off', onPointerDown: stop, onClick: stop, onDoubleClick: stop, onKeyDown: editKey };
const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const graphKinds = new Set(['tree', 'bst', 'heap', 'trie', 'graph']);

const SmallButton = forwardRef(function SmallButton({ label, children, onClick, className = '', ...props }, ref) {
  return <button ref={ref} type="button" className={`diagram-structure-icon nodrag nopan nokey ${className}`} title={label} aria-label={label} onPointerDown={stop} onKeyDown={editKey} onDoubleClick={stop} onClick={event => { event.stopPropagation(); onClick?.(event); }} {...props}>{children}</button>;
});

function Icon({ name }) {
  return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'tools' ? <><path d="M3 5h14M3 10h14M3 15h14" /><circle cx="7" cy="5" r="2" /><circle cx="13" cy="10" r="2" /><circle cx="8" cy="15" r="2" /></> : name === 'back' ? <path d="m12 5-5 5 5 5" /> : name === 'next' ? <path d="m8 5 5 5-5 5" /> : name === 'reset' ? <><path d="M4 8a6 6 0 1 1 0 5M4 3v5h5" /></> : <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M7 4v12m6-12v12" /></>}
  </svg>;
}

function StructureTools({ data, entries, update, close, panelRef, panelId, nested = false }) {
  const [pointerLabel, setPointerLabel] = useState('i');
  const [pointerTarget, setPointerTarget] = useState(data.activeEntryId || entries[0]?.id || '');
  const [source, setSource] = useState(entries[0]?.id || '');
  const [target, setTarget] = useState(entries[1]?.id || entries[0]?.id || '');
  const [linkLabel, setLinkLabel] = useState('');
  const [typeDraft, setTypeDraft] = useState(data.typeSignature || data.implementation || '');
  const [typeError, setTypeError] = useState('');
  useEffect(() => { setTypeDraft(data.typeSignature || data.implementation || ''); setTypeError(''); }, [data.typeSignature, data.implementation]);
  const applyType = () => {
    try { const next = applyStructureType(data, typeDraft); update(next, true); setTypeError(''); close(); }
    catch (error) { setTypeError(error.message || 'Could not apply this container type. Your values have not changed.'); }
  };
  const active = entries.find(entry => entry.id === data.activeEntryId);
  const option = entry => `${entry.key || `[${entries.indexOf(entry)}]`}${entry.value ? ` · ${entry.value}` : ''}`;
  const links = data.links || [], pointers = data.pointers || [];
  const updateEntry = patch => update({ entries: entries.map(entry => entry.id === active?.id ? { ...entry, ...patch } : entry) });
  return <div ref={panelRef} id={panelId} className="diagram-structure-tools nodrag nopan nowheel nokey" role="dialog" aria-label="Data structure tools" onPointerDown={stop} onClick={stop} onKeyDown={editKey}>
    <div className="diagram-structure-tools-heading"><span>Dry run &amp; structure</span><SmallButton label="Close structure tools" onClick={() => close()}>×</SmallButton></div>
    <label>Active unit<select {...inputProps} data-popover-autofocus value={data.activeEntryId || ''} onChange={event => update({ activeEntryId: event.target.value }, true)}><option value="">None</option>{entries.map(entry => <option key={entry.id} value={entry.id}>{option(entry)}</option>)}</select></label>
    {active && <label>Annotation<input {...inputProps} maxLength={240} value={active.annotation || ''} placeholder="e.g. visited, current minimum" onChange={event => updateEntry({ annotation: event.target.value })} /></label>}
    {data.structureKind === 'matrix' && <label>Columns<input {...inputProps} type="number" min="1" max="16" value={data.columns || 4} onChange={event => update({ columns: Math.max(1, Math.min(16, Number(event.target.value) || 1)) })} /></label>}
    {nested ? <div className="diagram-structure-inherited-type" title={data.typeSignature || data.implementation}>Type: {data.typeSignature || data.implementation || data.structureKind}<span>Defined by the parent container.</span></div> : <div className="diagram-structure-type-editor"><label>Container type<div className="diagram-structure-type-apply"><input {...inputProps} aria-label="Container type" maxLength={2000} value={typeDraft} placeholder="e.g. Map&lt;String, List&lt;Integer&gt;&gt;" onChange={event => { setTypeDraft(event.target.value); setTypeError(''); }} onKeyDown={event => { editKey(event); if (event.key === 'Enter') { event.preventDefault(); applyType(); } }} /><button type="button" className="diagram-structure-apply nodrag nopan" disabled={!typeDraft.trim()} onPointerDown={stop} onKeyDown={editKey} onClick={event => { event.stopPropagation(); applyType(); }}>Apply</button></div></label>{typeError && <p role="alert" className="diagram-structure-type-error">{typeError}</p>}<p className="diagram-structure-type-hint">Apply or press Enter to reshape this container. Existing values are preserved; incompatible conversions are blocked.</p></div>}
    <label>Notes<input {...inputProps} maxLength={4000} value={data.description || ''} placeholder="Complexity, invariant, or purpose" onChange={event => update({ description: event.target.value })} /></label>
    <section aria-label="Dry-run pointers" className="diagram-structure-tool-section">
      <span className="diagram-structure-tool-label">Pointers</span>
      {pointers.map(pointer => <div className="diagram-structure-tool-row" key={pointer.id}>
        <input {...inputProps} aria-label="Pointer label" maxLength={40} value={pointer.label} onChange={event => update({ pointers: pointers.map(current => current.id === pointer.id ? { ...current, label: event.target.value } : current) })} />
        <select {...inputProps} aria-label={`${pointer.label || 'Pointer'} target`} value={pointer.target} onChange={event => update({ pointers: pointers.map(current => current.id === pointer.id ? { ...current, target: event.target.value } : current) }, true)}>{entries.map(entry => <option key={entry.id} value={entry.id}>{option(entry)}</option>)}</select>
        <SmallButton label={`Remove pointer ${pointer.label}`} onClick={() => update({ pointers: pointers.filter(current => current.id !== pointer.id) }, true)}>−</SmallButton>
      </div>)}
      <div className="diagram-structure-tool-row"><input {...inputProps} aria-label="New pointer label" maxLength={40} value={pointerLabel} onChange={event => setPointerLabel(event.target.value)} /><select {...inputProps} aria-label="New pointer target" value={pointerTarget} onChange={event => setPointerTarget(event.target.value)}><option value="">Choose unit</option>{entries.map(entry => <option key={entry.id} value={entry.id}>{option(entry)}</option>)}</select><SmallButton label="Add pointer" disabled={!pointerLabel.trim() || !entries.some(entry => entry.id === pointerTarget) || pointers.length >= MAX_STRUCTURE_POINTERS} onClick={() => { update({ pointers: [...pointers, { id: uid('pointer'), label: pointerLabel.trim(), target: pointerTarget }] }, true); close(); }}>+</SmallButton></div>
    </section>
    {graphKinds.has(data.structureKind) && <section aria-label="Structure links" className="diagram-structure-tool-section">
      <span className="diagram-structure-tool-label">Links</span>
      {links.map(link => <div className="diagram-structure-existing-link" key={link.id}><span title={`${option(entries.find(entry => entry.id === link.source) || {})} → ${option(entries.find(entry => entry.id === link.target) || {})}`}>{option(entries.find(entry => entry.id === link.source) || {})} → {option(entries.find(entry => entry.id === link.target) || {})}</span><input {...inputProps} aria-label="Link label" maxLength={120} placeholder="Label" value={link.label || ''} onChange={event => update({ links: links.map(current => current.id === link.id ? { ...current, label: event.target.value } : current) })} /><SmallButton label="Remove link" onClick={() => update({ links: links.filter(current => current.id !== link.id) }, true)}>−</SmallButton></div>)}
      <div className="diagram-structure-tool-row"><select {...inputProps} aria-label="Link source" value={source} onChange={event => setSource(event.target.value)}><option value="">From</option>{entries.map(entry => <option key={entry.id} value={entry.id}>{option(entry)}</option>)}</select><select {...inputProps} aria-label="Link target" value={target} onChange={event => setTarget(event.target.value)}><option value="">To</option>{entries.map(entry => <option key={entry.id} value={entry.id}>{option(entry)}</option>)}</select><SmallButton label="Add link" disabled={!source || !target || links.length >= MAX_STRUCTURE_LINKS} onClick={() => { update({ links: [...links, { id: uid('link'), source, target, label: linkLabel }] }, true); close(); }}>+</SmallButton></div>
      <input {...inputProps} aria-label="New link label" placeholder="Optional link label / weight" maxLength={120} value={linkLabel} onChange={event => setLinkLabel(event.target.value)} />
    </section>}
    <p className="diagram-structure-tool-help">Manual dry run. Edit values, move pointers, and step through units; no code is executed.</p>
  </div>;
}

function StructureEditor({ data, selected, layout, update, rootCount, nested = false, pathLabel = '', nodeBindings }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [entryError, setEntryError] = useState('');
  const rootRef = useRef(null), panelRef = useRef(null), toolsTrigger = useRef(null), focusEntry = useRef(null);
  const marker = `structure-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const panelId = `${marker}-tools`;
  const close = useDiagramPopover(toolsOpen, setToolsOpen, panelRef, toolsTrigger);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const kind = STRUCTURE_KINDS.find(current => current.id === data.structureKind);
  let scalar = false;
  try { scalar = Boolean(data.typeSignature && isKnownScalarType(parseStructureType(data.typeSignature))); } catch { /* Legacy display-only implementation notes are not schemas. */ }
  const addBlocked = rootCount >= MAX_STRUCTURE_ENTRIES || scalar && entries.length > 0;
  useEffect(() => { if (!selected) setToolsOpen(false); }, [selected]);
  useEffect(() => { setEntryError(''); }, [data.typeSignature, data.implementation]);
  useEffect(() => {
    if (!focusEntry.current) return;
    const entry = [...(rootRef.current?.querySelectorAll('[data-entry-id]') || [])].find(element => element.dataset.entryId === focusEntry.current);
    const input = entry?.querySelector('input[data-entry-value]'); input?.focus(); input?.select(); focusEntry.current = null;
  }, [entries.length]);
  function addEntry() {
    if (addBlocked) return;
    try {
    const entry = createStructureEntry(data);
    if (scalar) { entry.key = 'value'; entry.annotation = data.typeSignature || ''; }
    if (!entry.key && (graphKinds.has(data.structureKind) || data.structureKind === 'union-find')) entry.key = String(entries.length);
    if (!entry.value && data.structureKind === 'bitset') entry.value = '0';
    const links = [...(data.links || [])];
    if (entries.length && ['tree', 'bst', 'heap', 'trie'].includes(data.structureKind) && links.length < MAX_STRUCTURE_LINKS) {
      const parent = data.structureKind === 'trie' ? entries.at(-1) : entries[Math.floor((entries.length - 1) / 2)];
      links.push({ id: uid('link'), source: parent.id, target: entry.id, label: '' });
    }
    focusEntry.current = entry.id;
    update({ entries: [...entries, entry], links, activeEntryId: entry.id }, true);
    setEntryError('');
    } catch (error) { setEntryError(error.message || 'Could not add this unit. Check the container type in tools.'); }
  }
  function removeEntry(entryId) {
    update({ entries: entries.filter(entry => entry.id !== entryId), links: (data.links || []).filter(link => link.source !== entryId && link.target !== entryId), pointers: (data.pointers || []).filter(pointer => pointer.target !== entryId), activeEntryId: data.activeEntryId === entryId ? '' : data.activeEntryId }, true);
  }
  const step = delta => {
    const current = entries.findIndex(entry => entry.id === data.activeEntryId);
    const next = current < 0 ? (delta < 0 ? entries.length - 1 : 0) : (current + delta + entries.length) % entries.length;
    update({ activeEntryId: entries[next]?.id || '' }, true);
  };
  const updateEntry = (entryId, patch) => update({ entries: entries.map(entry => entry.id === entryId ? { ...entry, ...patch } : entry) });
  const labelFor = label => nested ? `${label} in ${pathLabel}` : label;
  const typeText = data.typeSignature || data.implementation || '';
  let unappliedType = false;
  if (!data.typeSignature && data.implementation) {
    try { const schema = parseStructureType(data.implementation); unappliedType = Boolean(schema.structureKind || isKnownScalarType(schema)); } catch { /* Constructor labels and custom class names are not unapplied schemas. */ }
  }
  return <div ref={rootRef} data-structure-path={pathLabel || data.name || 'structure'} data-structure-kind={data.structureKind} className={`diagram-node diagram-structure-node structure-${layout.shape} ${nested ? 'is-embedded' : ''} ${selected && !nested ? 'is-selected' : ''}`} style={{ minWidth: layout.width, minHeight: layout.height, '--structure-header-height': `${layout.headerHeight}px` }}>
    {nodeBindings}
    <header className={`diagram-structure-heading ${typeText ? 'has-type' : ''}`}>
      <span className="diagram-structure-kind" title={`${kind?.label || data.structureKind}${data.implementation ? ` · ${data.implementation}` : ''}`}><Icon name="structure" /></span>
      {nested ? <span className="diagram-structure-embedded-type" title={typeText || kind?.label}>{typeText || kind?.label || data.structureKind}</span> : <div className="diagram-structure-title"><input {...inputProps} className={`${inputProps.className} diagram-node-name`} aria-label="Data structure name" maxLength={240} value={data.name || ''} placeholder={kind?.label || 'Structure'} onChange={event => update({ name: event.target.value })} />{typeText && <span className={`diagram-structure-type-signature${unappliedType ? ' is-unapplied' : ''}`} title={unappliedType ? `Label only — apply this container type in tools: ${typeText}` : typeText}>{unappliedType ? `Label only · ${typeText}` : typeText}</span>}</div>}
      <span className="diagram-structure-count" title={`${entries.length} units`}>{entries.length}</span>
      {selected && entries.length > 0 && !nested && <div className="diagram-structure-stepper nodrag nopan"><SmallButton label="Previous dry-run unit" onClick={() => step(-1)}><Icon name="back" /></SmallButton><SmallButton label="Next dry-run unit" onClick={() => step(1)}><Icon name="next" /></SmallButton><SmallButton label="Clear active unit" disabled={!data.activeEntryId} onClick={() => update({ activeEntryId: '' }, true)}><Icon name="reset" /></SmallButton></div>}
      <SmallButton label={rootCount >= MAX_STRUCTURE_ENTRIES ? `Limit of ${MAX_STRUCTURE_ENTRIES} total units` : scalar && entries.length ? 'Scalar values use one unit' : `Add unit to ${nested ? pathLabel : data.name || kind?.label || 'structure'}`} disabled={addBlocked} onClick={addEntry}>+</SmallButton>
      {selected && <SmallButton label={labelFor('Data structure tools')} ref={toolsTrigger} aria-expanded={toolsOpen} aria-controls={panelId} onClick={() => setToolsOpen(open => !open)}><Icon name="tools" /></SmallButton>}
    </header>
    {entryError && <div className="diagram-structure-inline-error nodrag nopan" role="alert" style={{ top:layout.headerHeight + 4 }}><span>{entryError}</span><SmallButton label={labelFor('Dismiss container error')} onClick={() => setEntryError('')}>×</SmallButton></div>}
    <svg className="diagram-structure-lines" width={layout.width} height={layout.height} aria-hidden="true">
      <defs><marker id={`${marker}-arrow`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto-start-reverse"><path d="M0,0 L6,3 L0,6" fill="none" stroke="currentColor" strokeWidth="1" /></marker></defs>
      {layout.decorations.map((item, index) => <path key={index} className="diagram-structure-container" d={item.type === 'stack' ? `M${item.x},${item.y} V${item.y + item.height} H${item.x + item.width} V${item.y}` : `M${item.x + 6},${item.y} H${item.x + item.width - 6} M${item.x + 6},${item.y + item.height} H${item.x + item.width - 6} M${item.x + 6},${item.y} C${item.x - 4},${item.y} ${item.x - 4},${item.y + item.height} ${item.x + 6},${item.y + item.height} M${item.x + item.width - 6},${item.y} C${item.x + item.width + 4},${item.y} ${item.x + item.width + 4},${item.y + item.height} ${item.x + item.width - 6},${item.y + item.height}`} />)}
      {layout.edges.map((edge, index) => <g key={`${edge.id || index}`}><path className="diagram-structure-edge" d={edge.path} markerEnd={`url(#${marker}-arrow)`} markerStart={edge.double ? `url(#${marker}-arrow)` : undefined} />{edge.label && <text className="diagram-structure-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle"><title>{edge.label}</title>{edge.label.length > 18 ? `${edge.label.slice(0, 17)}…` : edge.label}</text>}</g>)}
      {layout.labels.map((label, index) => <text key={index} className="diagram-structure-label" x={label.x} y={label.y} textAnchor={label.align || 'middle'}>{label.text}</text>)}
      {layout.pointers.map((pointer, index) => <g key={pointer.id || index} className="diagram-structure-pointer"><path d={pointer.path} markerEnd={`url(#${marker}-arrow)`} /><text x={pointer.labelX} y={pointer.labelY} textAnchor="middle"><title>{pointer.label}</title>{pointer.label.length > 12 ? `${pointer.label.slice(0, 11)}…` : pointer.label}</text></g>)}
    </svg>
    {!entries.length && <div className="diagram-structure-empty" style={{ top: layout.headerHeight + 30 }}>Empty {kind?.label?.toLowerCase() || 'container'}<SmallButton label={labelFor('Add first unit')} disabled={addBlocked} onClick={addEntry}>+</SmallButton></div>}
    {layout.cells.map(cell => {
      const entry = entries[cell.index];
      if (!entry) return null;
      const graph = layout.shape === 'graph';
      const indexLabel = data.structureKind === 'matrix' ? `${Math.floor(cell.index / (data.columns || 4))},${cell.index % (data.columns || 4)}` : cell.index;
      const hasChildren = Boolean(cell.keyContainer || cell.valueContainer);
      const childEditor = (side, placement) => {
        if (!placement) return null;
        const childPath = `${pathLabel || data.name || 'structure'} · unit ${cell.index + 1} ${side}`;
        return <div className="diagram-structure-nested-placement" style={{ left: placement.x - cell.x, top: placement.y - cell.y, width: placement.width, height: placement.height }}>
          <StructureEditor data={placement.data || entry[`${side}Container`]} layout={placement.layout} nested selected={selected} rootCount={rootCount} pathLabel={childPath} update={(patch, discrete = false) => update({ entries: entries.map(current => current.id === cell.id ? { ...current, [`${side}Container`]: { ...current[`${side}Container`], ...patch } } : current) }, discrete)} />
        </div>;
      };
      const keyWidth = cell.keyWidth || cell.width / 2;
      return <div key={cell.id} data-entry-id={cell.id} className={`diagram-structure-cell ${layout.shape === 'table' ? 'is-table' : ''} ${graph ? 'is-graph' : ''} ${hasChildren ? 'has-containers' : ''} ${data.activeEntryId === cell.id ? 'is-active' : ''}`} style={{ left: cell.x, top: cell.y, width: cell.width, height: cell.height }} title={entry.annotation || undefined}>
        {(layout.shape === 'table' || graph) && !cell.keyContainer && <input {...inputProps} className={`${inputProps.className} diagram-structure-key`} style={layout.shape === 'table' && cell.keyWidth ? { width:keyWidth, height:'100%' } : undefined} aria-label={labelFor(`Unit ${cell.index + 1} key`)} maxLength={500} value={entry.key || ''} placeholder={graph ? String(cell.index) : 'key'} onChange={event => updateEntry(cell.id, { key: event.target.value })} />}
        {!cell.valueContainer && <input {...inputProps} data-entry-value className={`${inputProps.className} diagram-structure-value`} style={layout.shape === 'table' && cell.keyWidth ? { position:'absolute', left:keyWidth, width:cell.width-keyWidth, height:'100%' } : undefined} aria-label={labelFor(`Unit ${cell.index + 1} value`)} maxLength={2000} value={entry.value || ''} placeholder={data.structureKind === 'bitset' ? '0' : 'value'} onChange={event => updateEntry(cell.id, { value: event.target.value })} />}
        {childEditor('key', cell.keyContainer)}{childEditor('value', cell.valueContainer)}
        <SmallButton label={labelFor(`Remove unit ${cell.index + 1}`)} className="diagram-structure-remove" onClick={() => removeEntry(cell.id)}>−</SmallButton>
        {['array', 'list', 'matrix', 'bitset'].includes(data.structureKind) && <span className="diagram-structure-index">{indexLabel}</span>}
        {entry.annotation && <span className={`diagram-structure-annotation ${['array', 'list', 'matrix', 'bitset'].includes(data.structureKind) ? 'below-index' : ''}`} title={entry.annotation}>{entry.annotation}</span>}
      </div>;
    })}
    {selected && toolsOpen && <StructureTools data={data} entries={entries} update={update} close={close} panelRef={panelRef} panelId={panelId} nested={nested} />}
  </div>;
}

export const DataStructureNode = memo(function DataStructureNode({ id, data, selected, isConnectable }) {
  const { updateNode } = useContext(DiagramNodeActionsContext);
  const updateInternals = useUpdateNodeInternals();
  const layout = getStructureLayout(data);
  useEffect(() => { updateInternals(id); }, [id, layout.width, layout.height, updateInternals]);
  const nodeBindings = <><NodeResizer isVisible={selected} minWidth={layout.width} minHeight={layout.height} handleClassName="diagram-resize-handle" lineClassName="diagram-resize-line" />{[["top", Position.Top], ["right", Position.Right], ["bottom", Position.Bottom], ["left", Position.Left]].map(([handle, position]) => <Handle key={handle} id={handle} type="source" position={position} isConnectable={isConnectable} className="diagram-node-handle" aria-label={`${handle} connection`} />)}</>;
  return <StructureEditor data={data} selected={selected} layout={layout} rootCount={countStructureEntries(data)} nodeBindings={nodeBindings} update={(patch, discrete = false) => updateNode(id, patch, discrete ? '' : `node:${id}`)} />;
});
