"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { StructuredCanvas } from './DiagramStudio';
import { exportBoard } from './diagram-model.mjs';
import { CanvasSyncClient } from './collaboration/canvas-sync-client.mjs';
import { canvasStatusLabel, parseCanvasShareLink } from '../../../canvas-web/src/share-link.mjs';
import { configureEraserIconAssets } from './eraser-icon-assets.mjs';

const Sketch = lazy(() => import('./DiagramSketch'));

function readLink() {
  try { return { value: parseCanvasShareLink(window.location.hash) }; }
  catch (error) { return { error: error.message }; }
}

function rememberedName() {
  try { return localStorage.getItem('argus-canvas-display-name') || ''; }
  catch { return ''; }
}

export default function CanvasShareView() {
  const [link] = useState(readLink);
  const [name, setName] = useState(rememberedName);
  const [theme, setTheme] = useState(() => window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const [board, setBoard] = useState(null);
  const [mode, setMode] = useState('structured');
  const [sketchMounted, setSketchMounted] = useState(false);
  const [status, setStatus] = useState({ state: 'connecting', role: 'read', pending: 0 });
  const [participants, setParticipants] = useState([]);
  const [error, setError] = useState('');
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const client = useRef(null), currentBoard = useRef(null), attempt = useRef(0), abort = useRef(null);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => () => { attempt.current++; abort.current?.abort(); void client.current?.stop()?.catch(() => {}); configureEraserIconAssets({proxyBaseUrl:'/api/diagram-icons',headers:{}}); }, []);
  useEffect(() => { if (mode === 'sketch') setSketchMounted(true); client.current?.setPresence({mode,cursor:null}); }, [mode]);
  useEffect(() => {
    const warn = event => { if (status.pending > 0) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [status.pending]);

  const refreshHistory = useCallback(() => {
    const manager = client.current?.undoManager;
    setHistory({ canUndo: Boolean(manager?.undoStack.length), canRedo: Boolean(manager?.redoStack.length) });
  }, []);

  async function join(event) {
    event.preventDefault();
    if (!link.value || !name.trim() || joining) return;
    const thisAttempt = ++attempt.current;
    abort.current?.abort(); void client.current?.stop()?.catch(() => {});
    const controller = new AbortController(); abort.current = controller;
    setJoining(true); setError('');
    const { endpoint, boardId, token } = link.value;
    try {
      // Fetch never places invite/session capabilities in URLs, storage or logs.
      const response = await fetch(endpoint + '/v1/session', {
        method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' }, signal: controller.signal,
        body: JSON.stringify({ boardId, token, name: name.trim().slice(0, 80) }),
      });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 || response.status === 410 ? 'This invitation has expired or was revoked. Ask the board owner for a new link.' : 'The sharing server could not be reached. Check that the owner is online, then try again.');
      const session = await response.json();
      if (!session.session) throw new Error('The sharing server returned an invalid session.');
      if (attempt.current !== thisAttempt) return;
      try { localStorage.setItem('argus-canvas-display-name', name.trim().slice(0, 80)); } catch { /* optional preference */ }
      const connection = new CanvasSyncClient({
        endpoint, boardId, token, session: session.session, storageIdentity: token, role: session.role || 'view', name: name.trim().slice(0, 80),
        onChange(next) { if (attempt.current !== thisAttempt) return; currentBoard.current = next; setBoard(next); refreshHistory(); },
        onStatus(next) { if (attempt.current !== thisAttempt) return; setStatus(next); refreshHistory(); },
        onPresence(peers) { if (attempt.current === thisAttempt) setParticipants(peers); },
      });
      client.current = connection;
      configureEraserIconAssets({proxyBaseUrl:endpoint+'/v1/icons',headers:()=>({'Authorization':'Bearer '+(client.current?.session||''),'ngrok-skip-browser-warning':'true'})});
      connection.setPresence({mode:'structured',cursor:null});
      for (const eventName of ['stack-item-added','stack-item-popped','stack-cleared','stack-item-updated']) connection.undoManager?.on(eventName, refreshHistory);
      setJoined(true); setStatus({state:'connecting',role:session.role || 'read',pending:0});
      await connection.start();
    } catch (failure) {
      if (attempt.current === thisAttempt && failure.name !== 'AbortError') setError(failure.message || 'Could not join this board. Try again.');
    } finally { if (attempt.current === thisAttempt) setJoining(false); }
  }

  const readOnly = ['view', 'read'].includes(status.role) || ['expired', 'error', 'connecting', 'syncing'].includes(status.state);
  const change = useCallback(patch => {
    if (!client.current || !currentBoard.current || readOnly) return;
    const previous = currentBoard.current;
    const next = { ...previous, ...(typeof patch === 'function' ? patch(previous) : patch) };
    try { client.current.setBoard(previous, next); refreshHistory(); }
    catch (failure) { setError(failure.message || 'This change could not be saved.'); }
  }, [readOnly, refreshHistory]);
  const undo = useCallback(() => { client.current?.undo(); refreshHistory(); }, [refreshHistory]);
  const redo = useCallback(() => { client.current?.redo(); refreshHistory(); }, [refreshHistory]);
  const pointer = useCallback(state => client.current?.setPresence(state), []);

  function downloadDraft() {
    const draft = client.current?.exportDraft() || currentBoard.current;
    if (!draft) return;
    const url = URL.createObjectURL(new Blob([exportBoard(draft)], {type:'application/json'}));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = (draft.name || 'shared-board').replace(/[^a-zA-Z0-9 _-]/g,'').slice(0,100) + '.argus-diagram.json';
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const collaboration = { readOnly, isCollaborating: true, onUndo: undo, onRedo: redo, ...history, onPointerUpdate: pointer, presence: participants };

  if (!joined) return <main className="canvas-join"><div className="canvas-join-card"><div className="canvas-brand"><span aria-hidden="true">◇</span> Argus Canvas</div><h1>A place to think together.</h1><p>Open the shared board to explore diagrams, draw ideas, and work together live.</p>{link.error ? <div role="alert" className="canvas-notice">{link.error}</div> : <form onSubmit={join}><label htmlFor="canvas-display-name">Your display name</label><input id="canvas-display-name" autoComplete="nickname" value={name} onChange={event=>setName(event.target.value)} maxLength={80} placeholder="How should others see you?" required autoFocus disabled={joining}/><small>Visible to everyone on this board.</small><button type="submit" disabled={joining || !name.trim()}>{joining ? 'Joining board…' : 'Join shared board →'}</button>{error && <p role="alert" className="canvas-error">{error}</p>}</form>}<footer>Structured diagrams · HLD · LLD · DSA · Excalidraw</footer></div><button className="canvas-theme" onClick={()=>setTheme(theme==='dark'?'light':'dark')} aria-label="Toggle color theme">{theme==='dark'?'Light mode':'Dark mode'}</button></main>;

  return <div className="diagram-studio canvas-share-view"><header className="canvas-share-header"><a className="canvas-brand" href="#" onClick={event=>event.preventDefault()} aria-label="Argus Canvas"><span aria-hidden="true">◇</span><span>Canvas</span></a><div className="canvas-share-title"><input aria-label="Board name" maxLength={160} value={board?.name || 'Shared board'} readOnly={readOnly || !board} onChange={event=>change({name:event.target.value})}/><span role="status" data-state={status.state}>{canvasStatusLabel(status)}{status.pending>0?` · ${status.pending} pending`:''}</span></div><div className="diagram-mode-tabs" role="group" aria-label="Canvas mode"><button aria-pressed={mode==='structured'} onClick={()=>setMode('structured')}>Structured</button><button aria-pressed={mode==='sketch'} onClick={()=>setMode('sketch')}>Draw</button></div><div className="canvas-participants" aria-label={`${participants.length + 1} participants`}><span className="canvas-avatar canvas-self" title={`${name} (you)`}>{name.trim().slice(0,1).toUpperCase()}</span>{participants.slice(0,5).map(peer=><span key={peer.clientId} className="canvas-avatar" title={peer.name || 'Guest'} style={{background:peer.color||'#89a9ff'}}>{(peer.name||'?').slice(0,1).toUpperCase()}</span>)}{participants.length>5&&<span>+{participants.length-5}</span>}</div><span className="canvas-role">{readOnly?'View only':'Can edit'}</span><button disabled={!board} onClick={downloadDraft} title="Export a copy of this board">Export</button><button onClick={()=>setTheme(theme==='dark'?'light':'dark')} aria-label="Toggle color theme">{theme==='dark'?'☀':'☾'}</button></header>{(error || status.message || ['offline','expired','error'].includes(status.state))&&<div className="canvas-notice" role="status"><span>{error || status.message || (status.state==='offline'?'Connection lost. Your pending changes are kept in this browser and will sync after reconnecting.':'This board is no longer available for editing.')}</span>{board&&<button onClick={downloadDraft}>Export draft</button>}{error&&<button aria-label="Dismiss message" onClick={()=>setError('')}>×</button>}</div>}{!board?<div className="canvas-connecting" role="status"><span className="canvas-connecting-mark">◇</span><h2>Opening shared board…</h2><p>The owner’s sharing server needs to be online.</p></div>:<main className="diagram-editor-shell"><div className="diagram-mode-surface" hidden={mode!=='structured'}><ReactFlowProvider key={board.id}><StructuredCanvas document={board} visible={mode==='structured'} onChange={structured=>change(current=>({snapshot:{...current.snapshot,structured}}))} onError={setError} {...collaboration}/></ReactFlowProvider></div>{sketchMounted&&<div className="diagram-mode-surface diagram-sketch" hidden={mode!=='sketch'}><Suspense fallback={<div className="canvas-connecting">Loading drawing editor…</div>}><Sketch snapshot={board.snapshot.sketch} theme={theme} onChange={sketch=>change(current=>({snapshot:{...current.snapshot,sketch}}))} onError={setError} {...collaboration}/></Suspense></div>}</main>}</div>;
}
