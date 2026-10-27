"use client";
import { useEffect, useRef, useState } from 'react';
import { CanvasSyncClient } from './collaboration/canvas-sync-client.mjs';
import { diagramApi } from './useDiagramDocument';
import CanvasSharingDialog from './CanvasSharingDialog';

const invoke = request => window.argusDesktop.canvasSharing(request);
function preservePersonal(next, previous) {
  if (!previous?.snapshot) return next;
  return { ...previous, ...next, snapshot: {
    ...next.snapshot,
    structured: { ...next.snapshot.structured, viewport: previous.snapshot.structured.viewport },
    sketch: { ...next.snapshot.sketch, appState: previous.snapshot.sketch.appState, libraryItems: previous.snapshot.sketch.libraryItems },
  } };
}

export function useOwnerCanvasSharing(localStore) {
  const local = useRef(localStore); local.current = localStore;
  const client = useRef(null), board = useRef(null), generation = useRef(0);
  const readyBoard = useRef(null), operations = useRef(0), recovered = useRef(null);
  const [service, setService] = useState(null), [dialog, setDialog] = useState(false);
  const [shared, setShared] = useState(null), [sync, setSync] = useState(null), [presence, setPresence] = useState([]);
  const [checked, setChecked] = useState(null), [checkingError, setCheckingError] = useState(''), [working, setWorking] = useState(false);
  const [reload, setReload] = useState(0);
  const id = localStore.document?.id;
  const supported = typeof window !== 'undefined' && Boolean(window.argusDesktop?.canvasSharing);

  async function refresh() { const value = await invoke({ action: 'status' }); setService(value); return value; }
  useEffect(() => {
    const version = ++generation.current;
    let current;
    readyBoard.current = null;
    setShared(null); setSync(null); setPresence([]); setCheckingError(''); board.current = null; recovered.current = null;
    if (!supported || !id) { readyBoard.current = id; setChecked(id); return; }
    void (async () => {
      const status = await invoke({ action: 'status' });
      if (version !== generation.current) return;
      setService(status);
      const entry = status.boards?.find(item => item.id === id && item.shared);
      if (!entry) { readyBoard.current = id; setChecked(id); return; }
      if (entry.frozen) throw new Error('Sharing is paused because the local board changed outside this session. Stop sharing before editing locally.');
      const session = await invoke({ action: 'session', boardId: id });
      if (version !== generation.current) return;
      current = new CanvasSyncClient({ ...session, endpoint: session.endpoint || status.endpoint, boardId: id, storageIdentity: session.storageIdentity || 'owner', name: 'Owner',
        onChange(next, metadata) {
          if (version !== generation.current) return;
          const previous = board.current || local.current.document;
          const merged = preservePersonal({ ...next, revision: metadata.revision ?? previous?.revision }, previous);
          board.current = merged; readyBoard.current = id;
          setShared(merged); local.current.adoptShared?.(merged); setChecked(id);
        },
        onStatus(value) {
          if (version !== generation.current) return;
          setSync(value);
          if (board.current && Number.isSafeInteger(value.revision) && value.revision >= (board.current.revision || 0)) {
            const next = { ...board.current, revision: value.revision };
            board.current = next; setShared(next); local.current.adoptShared?.(next);
          }
          if (value.terminal) setChecked(id);
        },
        onPresence(value) { if (version === generation.current) setPresence(Array.isArray(value) ? value : []); },
      });
      client.current = current;
      await current.start();
    })().catch(error => { if (version === generation.current) { setCheckingError(error.message); setChecked(id); } });
    return () => { generation.current++; current?.destroy(); if (client.current === current) client.current = null; };
  }, [id, reload, supported]);

  const pending = (sync?.pending || 0) > 0;
  useEffect(() => {
    if (!shared) return;
    document.documentElement.dataset.argusDiagramDirty = String(pending);
    const guard = event => { if (client.current?.pendingCount) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => { window.removeEventListener('beforeunload', guard); document.documentElement.dataset.argusDiagramDirty = 'false'; };
  }, [Boolean(shared), pending]);

  async function flush() {
    if (client.current) await client.current.flush();
    else await local.current.flush();
  }
  async function action(request, internal = false) {
    if (operations.current && !internal) throw new Error('Wait for the current board operation to finish.');
    operations.current++;
    setWorking(true);
    let recovery;
    try {
      if (request.action === 'share') { readyBoard.current = null; setChecked(null); await local.current.flush(); }
      if (request.action === 'stop') {
        const active = client.current;
        if (active) {
          try { await active.flush(); }
          catch (error) {
            if (active.pendingCount) {
              const draft = preservePersonal(active.exportDraft(), board.current);
              const fingerprint = JSON.stringify({ name: draft.name, snapshot: draft.snapshot });
              if (recovered.current?.fingerprint === fingerprint) recovery = recovered.current;
              else {
                const saved = await diagramApi('', { method: 'POST', body: JSON.stringify({ name: `${draft.name} — recovered draft`.slice(0, 160), snapshot: draft.snapshot }) });
                recovery = { fingerprint, id: saved.id, name: saved.name }; recovered.current = recovery;
              }
            }
          }
        }
      }
      const result = await invoke({ ...request, boardId: id });
      await refresh();
      if (request.action === 'share' || request.action === 'stop') {
        if (request.action === 'stop') {
          generation.current++;
          client.current?.destroy(); client.current = null;
          const saved = await diagramApi('/' + id);
          board.current = saved; local.current.adoptShared?.(saved);
          setShared(null); setSync(null); setPresence([]);
          if (recovery) {
            await local.current.loadList?.().catch(() => {});
            local.current.setError(`Unsaved shared edits were preserved in “${recovery.name}”. The original board now shows its last acknowledged save.`);
          }
        }
        setReload(value => value + 1);
      }
      return result;
    } catch (error) {
      if (request.action === 'share') setReload(value => value + 1);
      throw error;
    } finally { operations.current--; setWorking(operations.current > 0); }
  }
  async function navigate(method, ...args) {
    if (operations.current) return null;
    operations.current++; setWorking(true);
    try {
      const saveCopy = method === 'create' && args[2] === true;
      const unrelatedRemoval = method === 'remove' && args[0]?.id !== id;
      if (saveCopy && board.current) local.current.adoptShared?.(board.current);
      if (!saveCopy && !unrelatedRemoval) await flush();
      if (['archive', 'remove'].includes(method) && (method === 'archive' || args[0]?.id === id)) {
        if (shared) await action({ action: 'stop' }, true);
        const saved = await diagramApi('/' + id);
        local.current.adoptShared?.(saved);
        if (method === 'remove') args[0] = saved;
      }
      // Permanent deletion also removes the target's sharing journal. Resolve
      // this from the selected row, not the currently open board: deleting an
      // archived or inactive row must leave the active draft untouched.
      if (method === 'remove' && supported && args[0]?.id) await invoke({ action: 'forget', boardId: args[0].id });
      return await local.current[method](...args);
    } catch (error) { local.current.setError(error.message); return null; }
    finally { operations.current--; setWorking(operations.current > 0); }
  }
  const documentValue = shared?.id === id ? shared : localStore.document;
  const statusLabels = { connecting: 'Connecting to sharing service…', syncing: 'Syncing…', saved: 'Saved on this Mac', offline: 'Offline · waiting for this Mac', pending: 'Saving to this Mac…', expired: 'Sharing access ended', error: 'Sharing paused', 'read-only': 'View only' };
  const store = {
    ...localStore, document: documentValue,
    busy: localStore.busy || working || Boolean(supported && id && checked !== id) || Boolean(client.current && !shared && !sync?.terminal),
    dirty: shared ? pending : localStore.dirty,
    error: checkingError || (sync?.terminal ? sync.message : '') || localStore.error,
    status: shared ? (statusLabels[sync?.state] || 'Connecting…') : localStore.status,
    change(patch, expected = id) {
      if (operations.current || (supported && readyBoard.current !== id) || expected !== id) return false;
      if (!client.current) return checkingError ? false : local.current.change(patch, expected);
      if (expected !== board.current?.id || client.current.status.terminal || client.current.role === 'view') return false;
      const previous = board.current;
      const change = typeof patch === 'function' ? patch(previous) : patch;
      const next = { ...previous, ...change };
      board.current = next; setShared(next);
      try { client.current.setBoard(previous, next); local.current.adoptShared?.(board.current); return true; }
      catch (error) { board.current = previous; setShared(previous); local.current.setError(error.message); return false; }
    },
    flush,
    open: (...args) => navigate('open', ...args), create: (...args) => navigate('create', ...args),
    archive: (...args) => navigate('archive', ...args), restore: (...args) => navigate('restore', ...args), remove: (...args) => navigate('remove', ...args),
  };
  return {
    store,
    collaboration: shared ? {
      active: true, isCollaborating: true, readOnly: Boolean(sync?.terminal || sync?.role === 'view' || working), presence,
      onPointerUpdate: state => client.current?.setPresence({ ...state, name: 'Owner' }),
      onUndo: () => { if (!operations.current) client.current?.undo(); }, onRedo: () => { if (!operations.current) client.current?.redo(); },
      canUndo: Boolean(client.current?.canUndo), canRedo: Boolean(client.current?.canRedo),
    } : { readOnly: Boolean(checkingError || sync?.terminal || working || (supported && id && checked !== id)) },
    headerActions: <><button className="diagram-share-trigger" disabled={!id || localStore.busy} onClick={() => { setDialog(true); if (supported) void refresh().catch(error => setCheckingError(error.message)); }} title="Share only this board">{shared ? '● Shared' : 'Share'}</button>{dialog && <CanvasSharingDialog board={documentValue} service={service} supported={supported} busy={working} onAction={action} onClose={() => setDialog(false)} />}</>,
  };
}
