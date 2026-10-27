"use client";

import { useMemo, useRef, useState } from 'react';
import { ComponentGlyph } from './DiagramNodes';
import { DIAGRAM_COMPONENTS } from './diagram-catalog.mjs';

export const DIAGRAM_ITEM_DRAG_TYPE = 'application/x-argus-diagram-item';
export const INSERT_PAGE_SIZE = 36;
const sections = [['icons', 'Icons'], ['shapes', 'Shapes'], ['frames', 'Devices'], ['essentials', 'Essentials']];
const sectionOf = item => item.librarySection || (item.iconName ? 'icons' : item.visualKind === 'shape' ? 'shapes' : item.visualKind === 'frame' ? 'frames' : 'essentials');
const index = DIAGRAM_COMPONENTS.map(item => ({ item, section: sectionOf(item), text: [item.id, item.label, item.category, item.role, item.description].join(' ').toLowerCase() }));

export default function DiagramInsertLibrary({ onAdd }) {
  const [query, setQuery] = useState(''), [section, setSection] = useState('icons');
  const [category, setCategory] = useState('all'), [page, setPage] = useState(0), [active, setActive] = useState(0);
  const searchRef = useRef(null), listRef = useRef(null);
  const categories = useMemo(() => [...new Set(index.filter(row => row.section === section).map(row => row.item.category))], [section]);
  const matches = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    // Searching spans every visual family; a selected provider still narrows it.
    return index.filter(row => (terms.length || row.section === section) && (category === 'all' || row.item.category === category) && terms.every(term => row.text.includes(term)))
      .sort((left, right) => Number(right.section === section) - Number(left.section === section))
      .map(row => row.item);
  }, [section, query, category]);
  const pages = Math.max(1, Math.ceil(matches.length / INSERT_PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1), items = matches.slice(currentPage * INSERT_PAGE_SIZE, (currentPage + 1) * INSERT_PAGE_SIZE);
  const selected = Math.min(active, Math.max(0, items.length - 1));
  function reset() { setPage(0); setActive(0); if (listRef.current) listRef.current.scrollTop = 0; }
  function keyboard(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(0, Math.min(items.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
      setActive(next); listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && items[selected]) { event.preventDefault(); onAdd(items[selected].id); }
  }
  return <div className="diagram-insert-library">
    <div className="diagram-insert-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/></svg><input ref={searchRef} data-popover-autofocus aria-label="Search architecture components" aria-controls="diagram-insert-results" aria-activedescendant={items[selected] ? `insert-${items[selected].id}` : undefined} value={query} onKeyDown={keyboard} onChange={event => { setQuery(event.target.value); reset(); }} placeholder="Search icons, shapes, devices…"/>{query && <button aria-label="Clear library search" onClick={() => { setQuery(''); reset(); searchRef.current?.focus(); }}>×</button>}</div>
    <div className="diagram-insert-sections" role="group" aria-label="Visual library">{sections.map(([key, label]) => <button key={key} aria-pressed={section === key} onClick={() => { setSection(key); setCategory('all'); setQuery(''); reset(); }}>{label}</button>)}</div>
    <div className="diagram-insert-filter"><div className="diagram-insert-select"><select aria-label="Icon library" value={category} onChange={event => { setCategory(event.target.value); reset(); }}><option value="all">All {section === 'icons' ? 'icon libraries' : section}</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></div><span role="status" aria-label={`${matches.length.toLocaleString()} items`}><span>{matches.length.toLocaleString()}</span><span className="diagram-insert-count-label"> items</span></span></div>
    <div id="diagram-insert-results" ref={listRef} className="diagram-insert-grid" aria-label="Available visual items">{items.map((item, itemIndex) => <button id={`insert-${item.id}`} key={item.id} className={itemIndex === selected ? 'is-active' : ''} type="button" draggable onDragStart={event => { event.dataTransfer.setData(DIAGRAM_ITEM_DRAG_TYPE, item.id); event.dataTransfer.effectAllowed = 'copy'; }} onFocus={() => setActive(itemIndex)} onClick={() => onAdd(item.id)} title={`${item.label} · ${item.category}\n${item.description || ''}`}><ComponentGlyph componentKey={item.id} size={32}/><span>{item.label}</span></button>)}{!items.length && <p className="diagram-insert-empty">No matches. Try a technology name, “cylinder”, or “phone”.</p>}</div>
    {pages > 1 && <nav className="diagram-insert-pages" aria-label="Library pages"><button disabled={currentPage === 0} aria-label="Previous icon page" onClick={() => { setPage(currentPage - 1); setActive(0); listRef.current?.scrollTo(0, 0); }}>←</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage + 1 >= pages} aria-label="Next icon page" onClick={() => { setPage(currentPage + 1); setActive(0); listRef.current?.scrollTo(0, 0); }}>→</button></nav>}
    <footer><span>Click or drag to insert · ↑ ↓ Enter</span><small>Every item has editable notes. Eraser icons load online and are cached on this device.</small></footer>
  </div>;
}
