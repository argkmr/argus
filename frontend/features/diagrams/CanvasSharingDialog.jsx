"use client";
import { useEffect, useRef, useState } from 'react';
import './canvas-sharing.css';

export default function CanvasSharingDialog({ board, service, supported, busy, onAction, onClose }) {
  const root = useRef(null);
  const [publicUrl, setPublicUrl] = useState(service?.publicUrl || '');
  const [frontendUrl, setFrontendUrl] = useState(service?.frontendUrl || '');
  const [role, setRole] = useState('edit'), [hours, setHours] = useState('24');
  const [error, setError] = useState(''), [link, setLink] = useState(''), [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const entry = service?.boards?.find(item => item.id === board?.id && item.shared);
  useEffect(() => { if (service) { setPublicUrl(service.publicUrl || ''); setFrontendUrl(service.frontendUrl || ''); } }, [service?.publicUrl, service?.frontendUrl]);
  useEffect(() => { const previous = document.activeElement; root.current?.querySelector('button')?.focus(); return () => previous?.focus?.(); }, []);
  async function run(operation) { setPending(true); setError(''); try { return await operation(); } catch (failure) { setError(failure.message); } finally { setPending(false); } }
  async function saveConfiguration() {
    const frontend = new URL(frontendUrl), backend = new URL(publicUrl);
    for (const url of [frontend, backend]) if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS URLs, or localhost for development.');
    return onAction({ action: 'configure', frontendUrl: frontend.href, publicUrl: backend.origin, allowedOrigins: [frontend.origin] });
  }
  async function invite() {
    await saveConfiguration();
    if (!entry) await onAction({ action: 'share' });
    const result = await onAction({ action: 'invite', role, expiresInHours: Number(hours) });
    setLink(result.url); setCopied(false);
  }
  function keyboard(event) {
    if (event.key === 'Escape' && !pending) { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const items = [...root.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')];
    if (!items.length) return;
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
  }
  return <div className="canvas-sharing-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <section ref={root} className="canvas-sharing-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-sharing-title" onKeyDown={keyboard}>
      <header><div><small>CANVAS SHARING</small><h2 id="canvas-sharing-title">{board?.name || 'Share board'}</h2></div><button aria-label="Close sharing" onClick={onClose} disabled={pending}>×</button></header>
      {!supported ? <p>Open this board in the Argus desktop app to manage sharing. The standalone server can also be configured from its CLI.</p> : <>
        <p className="canvas-sharing-note">Only this board is shared. Chats, code, terminal and AI kits stay private. Keep this Mac awake and Argus running.</p>
        <label>Canvas website URL<input type="url" placeholder="https://your-canvas.netlify.app" value={frontendUrl} onChange={event => setFrontendUrl(event.target.value)} /></label>
        <label>Public backend URL<input type="url" placeholder="https://your-endpoint.ngrok.app" value={publicUrl} onChange={event => setPublicUrl(event.target.value)} /></label>
        <p className="canvas-sharing-hint">Point ngrok at port <strong>{service?.port || 4186}</strong>, never Argus’s port 4173. Later you can use your own HTTPS domain here.</p>
        <div className="canvas-sharing-invite-options"><label>Access<select value={role} onChange={event => setRole(event.target.value)}><option value="edit">Can edit</option><option value="view">Can view</option></select></label><label>Expires<select value={hours} onChange={event => setHours(event.target.value)}><option value="1">1 hour</option><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option></select></label></div>
        <button className="canvas-sharing-primary" disabled={busy || pending || !board || !frontendUrl || !publicUrl} onClick={() => run(invite)}>{pending ? 'Working…' : 'Create invitation'}</button>
        {link && <div className="canvas-sharing-created"><label>Invitation link<input aria-label="Invitation link" readOnly value={link} onFocus={event => event.target.select()} /></label><button onClick={() => run(async () => { await navigator.clipboard.writeText(link); setCopied(true); })}>{copied ? 'Copied' : 'Copy link'}</button><small>Anyone holding this link has the selected access until expiry or revocation. Share it privately.</small></div>}
        {entry && <div className="canvas-sharing-invites"><strong>Active invitations</strong>{(entry.invites || []).filter(item => !item.revokedAt && item.expiresAt > Date.now()).map(item => <div key={item.id}><span>{item.role === 'view' ? 'Can view' : 'Can edit'}<small>Expires {new Date(item.expiresAt).toLocaleString()}</small></span><button disabled={busy || pending} onClick={() => run(() => onAction({ action: 'revoke', inviteId: item.id }))}>Revoke</button></div>)}<button className="canvas-sharing-stop" disabled={busy || pending} onClick={() => run(async () => { if (!confirm('Stop sharing this board and disconnect all guests? The board stays on this Mac.')) return; await onAction({ action: 'stop' }); setLink(''); })}>Stop sharing this board</button></div>}
      </>}
      {error && <p className="canvas-sharing-error" role="alert">{error}</p>}
    </section>
  </div>;
}
