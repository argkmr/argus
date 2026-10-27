"use client";
import { useEffect, useRef, useState } from 'react';
import { emptySnapshot } from './diagram-model.mjs';

export async function diagramApi(path = '', options = {}) {
  const response = await fetch('/api/diagrams' + path, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  let value;
  try { value = await response.json(); } catch { value = {}; }
  if (!response.ok) { const error = new Error(value.error || value.message || `Diagram request failed (${response.status}).`); error.status = response.status; throw error; }
  return value;
}

// One serialized save at a time. Edits made during a request stay dirty and are
// sent with the revision returned by that request, never its older snapshot.
export function useDiagramDocument() {
  const [document, setDocument] = useState(null), [documents, setDocuments] = useState([]);
  const [status, setStatus] = useState('Loading boards…'), [error, setError] = useState('');
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const current = useRef(null), generation = useRef(0), savedGeneration = useRef(0), timer = useRef(), pending = useRef(null), alive = useRef(true);
  const locked = useRef(false), navigation = useRef(0), listRequest = useRef(0);
  const update = next => { current.current = next; if (alive.current) setDocument(next); };
  const loadList = async () => { const request = ++listRequest.current; const result = await diagramApi('?archived=true'); if (alive.current && request === listRequest.current) setDocuments(result); return result; };
  const markDirty = value => { if (alive.current) setDirty(value); documentElementDirty(value); };
  const adopt = next => { clearTimeout(timer.current); generation.current = 0; savedGeneration.current = 0; update(next); markDirty(false); setStatus('Saved locally'); setError(''); };

  async function flush() {
    clearTimeout(timer.current);
    if (pending.current) { await pending.current; if (savedGeneration.current < generation.current) return flush(); return; }
    const doc = current.current;
    if (!doc || savedGeneration.current === generation.current) return;
    const version = generation.current;
    setStatus('Saving…'); setError('');
    // All callers await the acknowledgement AND revision bookkeeping together.
    const operation = (async () => { try {
      const saved = await diagramApi('/' + doc.id, { method: 'PUT', body: JSON.stringify({ name: doc.name, revision: doc.revision, snapshot: doc.snapshot }) });
      if (current.current?.id === doc.id) {
        savedGeneration.current = version;
        update({ ...current.current, revision: saved.revision, updatedAt: saved.updatedAt });
        markDirty(generation.current !== version);
        setStatus(generation.current === version ? 'Saved locally' : 'Unsaved changes');
        setDocuments(list => list.map(item => item.id === saved.id ? { ...item, name: saved.name, revision: saved.revision, updatedAt: saved.updatedAt } : item));
      }
    } catch (failure) {
      markDirty(true); setStatus('Not saved');
      setError(failure.status === 409 ? 'This board changed elsewhere. Your draft is preserved. Save a copy or export it before reloading.' : failure.message);
      throw failure;
    } })();
    pending.current = operation;
    try { await operation; } finally { if (pending.current === operation) pending.current = null; }
    if (savedGeneration.current < generation.current) return flush();
  }
  function change(patch, expectedBoardId = document?.id) {
    if (locked.current || !current.current || current.current.id !== expectedBoardId) return false;
    if (typeof patch === 'function') patch = patch(current.current);
    update({ ...current.current, ...patch }); generation.current++; markDirty(true); setStatus('Unsaved changes');
    clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => {}); }, 650);
    return true;
  }
  const remember = id => { try { localStorage.setItem('argus-diagram-last', id); } catch { /* persistence itself is on disk */ } };
  async function transition(action) {
    if (locked.current) return null;
    locked.current = true; navigation.current++; setBusy(true);
    try { return await action(); } catch (failure) { setError(failure.message); return null; }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function open(id) { return transition(async () => { await flush(); const next = await diagramApi('/' + id); adopt(next); remember(id); return next; }); }
  async function create(name = 'Untitled board', snapshot = emptySnapshot(), saveAsCopy = false) {
    return transition(async () => {
      // A copy is the explicit conflict-recovery path; it must not overwrite the original.
      if (!saveAsCopy) await flush(); else if (pending.current) await pending.current.catch(() => {});
      if (saveAsCopy && current.current) snapshot = current.current.snapshot;
      const next = await diagramApi('', { method: 'POST', body: JSON.stringify({ name, snapshot }) });
      adopt(next); remember(next.id); await loadList(); return next;
    });
  }
  async function archive() {
    if (!current.current) return;
    return transition(async () => { await flush(); const doc = current.current; await diagramApi(`/${doc.id}?revision=${doc.revision}`, { method: 'DELETE' }); adopt(null); await loadList(); setStatus('Archived locally'); });
  }
  async function restore(summary) {
    return transition(async () => { await flush(); const next = await diagramApi('/' + summary.id + '/restore', { method: 'POST', body: JSON.stringify({ revision: summary.revision }) }); adopt(next); remember(next.id); await loadList(); });
  }
  async function remove(summary) {
    if (!summary?.id) return false;
    return transition(async () => {
      const isCurrent = current.current?.id === summary.id;
      // Finish an in-flight save before deleting so its response cannot revive
      // the board, and never discard an unrelated board's unsaved draft.
      if (isCurrent) await flush();
      const revision = isCurrent ? current.current.revision : summary.revision;
      await diagramApi(`/${encodeURIComponent(summary.id)}/permanent?revision=${revision}`, { method: 'DELETE' });
      listRequest.current++; // Older listings must not put a deleted row back.
      setDocuments(list => list.filter(item => item.id !== summary.id));
      if (isCurrent) { adopt(null); setStatus('Board deleted'); }
      try { if (localStorage.getItem('argus-diagram-last') === summary.id) localStorage.removeItem('argus-diagram-last'); } catch { /* deletion itself is durable */ }
      try { await loadList(); } catch { setError('Board deleted. Could not refresh the other boards; use Refresh boards to try again.'); }
      return true;
    });
  }
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const initialNavigation = navigation.current;
    const isCurrent = () => !cancelled && alive.current && navigation.current === initialNavigation;
    void (async () => {
      try {
        const list = await loadList(); if (!isCurrent()) return;
        let last; try { last = localStorage.getItem('argus-diagram-last'); } catch { /* use first board */ }
        const target = list.find(item => item.id === last && !item.archived) || list.find(item => !item.archived);
        if (target) { const loaded = await diagramApi('/' + target.id); if (isCurrent()) adopt(loaded); }
        else setStatus('Local workspace');
      } catch (failure) { if (isCurrent()) { setStatus('Could not load boards'); setError(failure.message); } }
    })();
    const beforeUnload = event => { if (savedGeneration.current < generation.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { cancelled = true; alive.current = false; clearTimeout(timer.current); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
  // Collaboration is the sole writer while a board is shared. Adopting its
  // acknowledged/local view must never schedule a competing snapshot PUT.
  function adoptShared(next) {
    if (!next || current.current?.id !== next.id || pending.current || savedGeneration.current < generation.current) return false;
    update(next);
    setDocuments(list => list.map(item => item.id === next.id ? { ...item, name: next.name, revision: next.revision, updatedAt: next.updatedAt } : item));
    return true;
  }
  return { document, documents, status, error, dirty, busy, change, open, create, archive, restore, remove, flush, loadList, setError, adoptShared };
}
function documentElementDirty(dirty) { if (typeof document !== 'undefined') document.documentElement.dataset.argusDiagramDirty = String(dirty); }
