import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { createBoardDoc, readBoardDoc, validateBoardDoc } from '../frontend/features/diagrams/collaboration/board-doc.mjs';
import { fetchEraserIcon } from './icon-assets.mjs';

const MAX_PACKET = 14 * 1024 * 1024;
const MAX_UPDATE_BYTES = 10_000_000; // Match the browser transport's decoded update limit.
const MAX_DOCUMENT = 20 * 1024 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const DEFAULT_ORIGINS = ['http://127.0.0.1:4173', 'http://localhost:4173'];
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const clone = value => structuredClone(value);
const safeName = value => String(value || 'Guest').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80).trim() || 'Guest';
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const requireId = value => { if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw error('invalid_request', 'Invalid board identifier.'); return value; };

function originUrl(value, label) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw error('invalid_configuration', `Invalid ${label}.`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.pathname !== '/') {
    throw error('invalid_configuration', `${label} must be an HTTPS origin (HTTP is allowed for localhost).`);
  }
  return url.origin;
}

/** Durable, private files. Temporary files and the containing directory are synced before ACK. */
async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, filename);
    const directory = await open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function decodeUpdate(value, maximum = MAX_PACKET) {
  if (typeof value !== 'string' || value.length > maximum || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw error('invalid_update', 'Invalid board update.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) throw error('invalid_update', 'Invalid board update.');
  return bytes;
}

function cloneDocument(doc) {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(doc));
  return result;
}

function boardFingerprint(board) {
  const doc = createBoardDoc(board);
  try { return JSON.stringify(readBoardDoc(doc)); } finally { doc.destroy(); }
}

function presenceState(state, name) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw error('invalid_presence', 'Invalid presence.');
  const cursor = state.cursor && Number.isFinite(state.cursor.x) && Number.isFinite(state.cursor.y)
    ? { x: Math.max(-1000000, Math.min(1000000, state.cursor.x)), y: Math.max(-1000000, Math.min(1000000, state.cursor.y)) } : null;
  return { name, color: /^#[a-f0-9]{6}$/i.test(state.color) ? state.color : '#6366f1', cursor, mode: state.mode === 'sketch' ? 'sketch' : 'structured' };
}

/** Board-only listener. Administrative operations exist exclusively on this in-process object. */
export function createCanvasService({ dataDir, port = 4186, host = '127.0.0.1', loadBoard, saveBoard, origins = DEFAULT_ORIGINS, iconFetcher = fetchEraserIcon } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Canvas dataDir must be an absolute path.');
  if (typeof loadBoard !== 'function' || typeof saveBoard !== 'function') throw new Error('Canvas requires board load and revision-checked save callbacks.');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Canvas must bind to loopback; expose only this listener through your tunnel.');
  const manifestPath = path.join(dataDir, 'sharing.json');
  let configuration = { publicUrl: '', frontendUrl: '', allowedOrigins: [...new Set(origins.map(value => originUrl(value, 'origin')))] };
  let manifest = { version: 1, configuration, boards: {} };
  let server, websocketServer, interval, running = false, initialization;
  let administration = Promise.resolve();
  const rows = new Map(), sessions = new Map(), clients = new Set(), rateLimits = new Map();
  const boardPath = id => path.join(dataDir, `board-${requireId(id)}.json`);
  const serializeAdmin = fn => { const result = administration.then(fn); administration = result.catch(() => {}); return result; };
  const serializeBoard = (row, fn) => { const result = row.queue.then(fn); row.queue = result.catch(() => {}); return result; };
  const saveManifest = next => atomicJson(manifestPath, next);
  const record = row => ({ version: 1, id: row.id, revision: row.revision, update: Buffer.from(Y.encodeStateAsUpdate(row.doc)).toString('base64'), pending: row.pending || null, frozen: row.frozen || null });
  const saveRow = row => atomicJson(boardPath(row.id), record(row));
  const send = (client, value) => {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > MAX_PACKET * 2) { client.ws.terminate(); return; }
    client.ws.send(JSON.stringify(value));
  };
  const rejectClient = (client, code, message) => { send(client, { type: 'error', code, message }); client.ws.close(1008, code); };
  const broadcast = (row, value, except) => { for (const client of clients) if (client !== except && client.row === row && client.authenticated) send(client, value); };
  const freeze = (row, code = 'conflict', message = 'The local board changed outside this sharing session. Stop sharing and share it again.') => {
    row.frozen = code;
    for (const client of clients) if (client.row === row) rejectClient(client, code, message);
  };
  const boardMeta = row => ({ id: row.id, name: readBoardDoc(row.doc).name, revision: row.revision });
  const localEndpoint = () => server?.listening ? `http://${host === '::1' ? '[::1]' : host}:${server.address().port}` : '';
  const endpoint = () => configuration.publicUrl || localEndpoint();
  const inviteMeta = invitation => ({ id: invitation.id, role: invitation.role, createdAt: invitation.createdAt, expiresAt: invitation.expiresAt, revokedAt: invitation.revokedAt || null });
  function activeSession(session) {
    if (!session) throw error('unauthorized', 'Invalid session.', 401);
    if (session.expiresAt <= Date.now()) throw error('expired', 'This session has expired.', 401);
    const sharing = manifest.boards[session.boardId];
    if (!sharing?.shared || sharing.epoch !== session.epoch) throw error('revoked', 'Sharing has stopped.', 403);
    if (session.inviteId) {
      const invitation = sharing.invites.find(item => item.id === session.inviteId);
      if (!invitation || invitation.revokedAt) throw error('revoked', 'This invitation was revoked.', 403);
      if (invitation.expiresAt <= Date.now()) throw error('expired', 'This invitation has expired.', 401);
    }
    const row = rows.get(session.boardId);
    if (!row || row.frozen) throw error(row?.frozen || 'unavailable', 'The board is unavailable. Ask its owner to restart sharing.', 409);
    return row;
  }
  async function verifyLocal(row) {
    let latest;
    try { latest = await loadBoard(row.id); } catch (cause) {
      if (cause.status === 404 || cause.code === 'not_found') freeze(row, 'unavailable', 'This board no longer exists.');
      throw error(row.frozen || 'unavailable', 'The local board could not be loaded.', 503);
    }
    if (!latest || latest.id !== row.id || latest.archived || latest.deleted) {
      freeze(row, 'unavailable', 'This board is archived or no longer exists.');
      throw error('unavailable', 'This board is archived or no longer exists.', 409);
    }
    if (latest.revision !== row.revision || boardFingerprint(latest) !== JSON.stringify(readBoardDoc(row.doc))) {
      freeze(row);
      throw error('conflict', 'The local board changed outside this sharing session.', 409);
    }
    return latest;
  }
  function consumeRate(key, maximum, windowMs = 60000) {
    const now = Date.now();
    let rate = rateLimits.get(key);
    if (!rate || rate.until <= now) { rate = { count: 0, until: now + windowMs }; rateLimits.set(key, rate); }
    if (++rate.count > maximum || rateLimits.size > 2048) throw error('rate_limited', 'Too many requests. Please wait.', 429);
  }
  function issueSession(row, role, name, invitation) {
    for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key);
    if (sessions.size >= 512) throw error('busy', 'The sharing service has reached its session limit.', 503);
    const token = secret();
    sessions.set(digest(token), { boardId: row.id, role, name: safeName(name), inviteId: invitation?.id, epoch: manifest.boards[row.id].epoch, expiresAt: Math.min(Date.now() + SESSION_TTL, invitation?.expiresAt || Infinity) });
    return { session: token, boardId: row.id, role, endpoint: endpoint(), board: boardMeta(row) };
  }
  function allowedOrigin(request) { return typeof request.headers.origin === 'string' && configuration.allowedOrigins.includes(request.headers.origin); }
  function allowedHost(request) {
    const accepted = new Set([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`, `[::1]:${server.address().port}`]);
    if (configuration.publicUrl) accepted.add(new URL(configuration.publicUrl).host.toLowerCase());
    return typeof request.headers.host === 'string' && accepted.has(request.headers.host.toLowerCase());
  }
  function httpReply(response, status, value, origin) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer' };
    if (origin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    response.writeHead(status, headers); response.end(value === undefined ? undefined : JSON.stringify(value));
  }
  async function httpBody(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw error('invalid_request', 'JSON content type required.', 415);
    const chunks = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 4096) throw error('too_large', 'Request too large.', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('invalid_request', 'Invalid JSON.'); }
  }
  async function handleHttp(request, response) {
    let cors;
    try {
      if (!allowedHost(request)) throw error('forbidden', 'Invalid host.', 403);
      // Exact raw paths reject query-string credentials, encoded routes, and all Argus endpoints.
      if (request.url === '/health' && request.method === 'GET') { httpReply(response, 200, { ok: true, service: 'argus-canvas' }); return; }
      // Public icon bytes, but only for an active board session. This is not a
      // URL proxy: the helper accepts names from our pinned catalog only.
      if (request.url.startsWith('/v1/icons/') && !request.url.includes('?') && ['GET', 'OPTIONS'].includes(request.method)) {
        if (!allowedOrigin(request)) throw error('forbidden_origin', 'This origin is not allowed.', 403);
        cors = request.headers.origin;
        if (request.method === 'OPTIONS') {
          consumeRate(`icon-preflight:${request.socket.remoteAddress}`, 16384);
          if (request.headers['access-control-request-method'] !== 'GET' || String(request.headers['access-control-request-headers'] || '').split(',').some(header => header.trim() && !['authorization', 'ngrok-skip-browser-warning'].includes(header.trim().toLowerCase()))) throw error('forbidden', 'Unsupported request.', 403);
          response.writeHead(204, { 'Access-Control-Allow-Origin': cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization, ngrok-skip-browser-warning', 'Access-Control-Max-Age': '600', Vary: 'Origin', 'Cache-Control': 'no-store' }); response.end(); return;
        }
        const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
        if (!TOKEN.test(token)) throw error('unauthorized', 'Invalid session.', 401);
        const sessionKey = digest(token), session = sessions.get(sessionKey); activeSession(session);
        // Tunnel viewers share a loopback IP. Budget authenticated loads per
        // session, allowing a full 2,000-object board without starving peers.
        consumeRate(`icons-session:${sessionKey}`, 4096);
        let name;
        try { name = decodeURIComponent(request.url.slice('/v1/icons/'.length)); } catch { throw error('invalid_request', 'Invalid icon name.'); }
        if (!name || name.length > 160 || name.includes('/')) throw error('invalid_request', 'Invalid icon name.');
        const svg = await iconFetcher(name);
        // Recheck revocation after a potentially slow upstream fetch.
        activeSession(session);
        httpReply(response, 200, { svg }, cors); return;
      }
      if (request.url !== '/v1/session' || !['POST', 'OPTIONS'].includes(request.method)) { httpReply(response, 404, { error: 'not_found' }); return; }
      if (!allowedOrigin(request)) throw error('forbidden_origin', 'This origin is not allowed.', 403);
      cors = request.headers.origin;
      consumeRate(`http:${request.socket.remoteAddress}`, 40);
      if (request.method === 'OPTIONS') {
        if (request.headers['access-control-request-method'] !== 'POST' || String(request.headers['access-control-request-headers'] || '').split(',').some(header => header.trim() && !['content-type', 'ngrok-skip-browser-warning'].includes(header.trim().toLowerCase()))) throw error('forbidden', 'Unsupported request.', 403);
        response.writeHead(204, { 'Access-Control-Allow-Origin': cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, ngrok-skip-browser-warning', Vary: 'Origin', 'Cache-Control': 'no-store' }); response.end(); return;
      }
      const body = await httpBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['boardId', 'token', 'name'].includes(key))) throw error('invalid_request', 'Invalid session request.');
      const id = requireId(body.boardId);
      if (typeof body.token !== 'string' || !TOKEN.test(body.token)) throw error('unauthorized', 'Invalid invitation.', 401);
      const sharing = manifest.boards[id];
      const hashed = Buffer.from(digest(body.token), 'hex');
      const invitation = sharing?.invites.find(item => timingSafeEqual(Buffer.from(item.tokenHash, 'hex'), hashed));
      if (!sharing?.shared || !invitation) throw error('unauthorized', 'Invalid invitation.', 401);
      if (invitation.revokedAt) throw error('revoked', 'This invitation was revoked.', 403);
      if (invitation.expiresAt <= Date.now()) throw error('expired', 'This invitation has expired.', 401);
      const row = rows.get(id);
      if (!row || row.frozen) throw error(row?.frozen || 'unavailable', 'This board is unavailable.', 409);
      const result = await serializeBoard(row, async () => { await verifyLocal(row); return issueSession(row, invitation.role, body.name, invitation); });
      httpReply(response, 200, result, cors);
    } catch (cause) { httpReply(response, cause.status || 500, { error: cause.code || 'unavailable', message: cause.code ? cause.message : 'The sharing service could not complete this request.' }, cors); }
  }

  async function commitUpdate(client, message) {
    const row = activeSession(client.session);
    if (client.session.role !== 'edit') throw error('read_only', 'This invitation allows viewing only.', 403);
    if (typeof message.id !== 'string' || !/^[\w:.-]{1,160}$/.test(message.id)) throw error('invalid_update', 'An update identifier is required.');
    const update = decodeUpdate(message.update);
    if (update.length > MAX_UPDATE_BYTES) throw error('too_large', 'This edit exceeds the upload limit.');
    await serializeBoard(row, async () => {
      activeSession(client.session);
      const latest = await verifyLocal(row);
      let candidate = cloneDocument(row.doc);
      try {
        Y.applyUpdate(candidate, update);
        if (candidate.store.pendingStructs || candidate.store.pendingDs) throw error('invalid_update', 'Update dependencies are missing. Reconnect before editing.');
        if ([...candidate.share.keys()].some(key => key !== 'board')) throw error('invalid_update', 'Only board data can be synchronized.');
        const board = validateBoardDoc(candidate);
        if (board.id !== row.id) throw error('invalid_update', 'An update cannot change the board identifier.');
        const encoded = Y.encodeStateAsUpdate(candidate);
        if (encoded.length > MAX_DOCUMENT) throw error('too_large', 'This shared board has reached its size limit.');
        // Preserve the owner's personal viewport/preferences; they are deliberately outside the CRDT.
        board.snapshot.structured.viewport = latest.snapshot.structured.viewport;
        board.snapshot.sketch.appState = latest.snapshot.sketch.appState;
        board.snapshot.sketch.libraryItems = latest.snapshot.sketch.libraryItems;
        row.pending = { update: Buffer.from(encoded).toString('base64'), baseRevision: row.revision };
        try { await saveRow(row); } catch { row.pending = null; throw error('persistence_failed', 'The board could not be saved to disk.'); }
        let saved;
        try {
          activeSession(client.session);
          saved = await saveBoard({ ...latest, ...board, revision: row.revision }, row.revision);
          if (!saved || saved.id !== row.id || !Number.isSafeInteger(saved.revision) || saved.revision <= row.revision || saved.archived || boardFingerprint(saved) !== JSON.stringify(readBoardDoc(candidate))) throw error('conflict', 'The local board save did not confirm this update.', 409);
        } catch (cause) {
          // A failed/ambiguous backend write is never ACKed. Keep the journal for safe restart reconciliation.
          freeze(row, cause.status === 409 || cause.code === 'conflict' ? 'conflict' : 'persistence_failed', 'The board save could not be confirmed. Ask its owner to restart sharing.');
          await saveRow(row).catch(() => {});
          throw error(row.frozen, 'The board save could not be confirmed.', 409);
        }
        const previousDoc = row.doc, previousRevision = row.revision;
        row.doc = candidate; row.revision = saved.revision; row.pending = null;
        try { await saveRow(row); }
        catch {
          row.doc = previousDoc; row.revision = previousRevision;
          row.pending = { update: Buffer.from(encoded).toString('base64'), baseRevision: previousRevision };
          freeze(row, 'persistence_failed', 'The local save succeeded but the sharing journal could not be confirmed. Restart sharing.');
          throw error('persistence_failed', 'The sharing journal could not be saved.');
        }
        candidate = null; previousDoc.destroy();
        broadcast(row, { type: 'update', update: Buffer.from(update).toString('base64'), board: boardMeta(row), revision: row.revision }, client);
        send(client, { type: 'ack', id: message.id, revision: row.revision });
      } catch (cause) {
        if (!cause.code) throw error('invalid_update', 'Invalid board update.');
        throw cause;
      } finally { candidate?.destroy(); }
    });
  }
  function attachSocket(ws, request) {
    const client = { ws, origin: request.headers.origin, alive: true, authenticated: false, row: null, session: null, clientId: randomUUID(), state: null, queue: Promise.resolve(), messages: 0, bytes: 0, windowAt: Date.now() };
    clients.add(client);
    client.authTimer = setTimeout(() => rejectClient(client, 'unauthorized', 'Authenticate within five seconds.'), 5000); client.authTimer.unref();
    ws.on('error', () => {});
    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => { clearTimeout(client.authTimer); clients.delete(client); if (client.row && client.authenticated) broadcast(client.row, { type: 'presence', clientId: client.clientId, state: null }, client); });
    ws.on('message', (data, binary) => {
      if (Date.now() - client.windowAt > 1000) { client.messages = 0; client.windowAt = Date.now(); }
      if (++client.messages > 120 || (client.bytes += data.length) > 40 * 1024 * 1024) { rejectClient(client, 'rate_limited', 'Too many messages.'); return; }
      client.queue = client.queue.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        let message;
        try {
          if (binary) throw error('invalid_request', 'JSON messages are required.');
          try { message = JSON.parse(data.toString()); } catch { throw error('invalid_request', 'Invalid JSON.'); }
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw error('invalid_request', 'Invalid message.');
          if (!client.authenticated) {
            if (message.type !== 'auth' || typeof message.session !== 'string' || !TOKEN.test(message.session) || Object.keys(message).some(key => !['type', 'session'].includes(key))) throw error('unauthorized', 'Session authentication required.', 401);
            client.session = sessions.get(digest(message.session));
            const row = activeSession(client.session);
            if ([...clients].filter(other => other.row === row).length >= 24) throw error('busy', 'This board has reached its connection limit.', 503);
            await serializeBoard(row, async () => {
              await verifyLocal(row); activeSession(client.session);
              client.row = row; client.authenticated = true; clearTimeout(client.authTimer);
              send(client, { type: 'sync', update: Buffer.from(Y.encodeStateAsUpdate(row.doc)).toString('base64'), board: boardMeta(row), role: client.session.role, clientId: client.clientId });
              for (const other of clients) if (other !== client && other.row === row && other.state) send(client, { type: 'presence', clientId: other.clientId, state: other.state });
            });
            return;
          }
          activeSession(client.session);
          if (message.type === 'update' && Object.keys(message).every(key => ['type', 'id', 'update'].includes(key))) await commitUpdate(client, message);
          else if (message.type === 'presence' && Object.keys(message).every(key => ['type', 'state'].includes(key))) { client.state = presenceState(message.state, client.session.name); broadcast(client.row, { type: 'presence', clientId: client.clientId, state: client.state }, client); }
          else if (message.type === 'ping') send(client, { type: 'pong' });
          else throw error('invalid_request', 'Unsupported message.');
        } catch (cause) {
          send(client, { type: 'error', code: cause.code || 'unavailable', ...(message?.id ? { id: String(message.id).slice(0, 160) } : {}), message: cause.code ? cause.message : 'This request could not be completed.' });
          if (!client.authenticated || ['expired', 'revoked', 'unauthorized', 'conflict', 'unavailable', 'persistence_failed'].includes(cause.code)) ws.close(1008, cause.code || 'unavailable');
        }
      }).catch(() => ws.close(1011, 'unavailable'));
    });
  }
  async function initialize() {
    await mkdir(dataDir, { recursive: true, mode: 0o700 }); await chmod(dataDir, 0o700);
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.version !== 1 || !manifest.boards || typeof manifest.boards !== 'object') throw new Error('Invalid Canvas sharing configuration.');
      configuration = { publicUrl: originUrl(manifest.configuration.publicUrl, 'public URL'), frontendUrl: originUrl(manifest.configuration.frontendUrl, 'frontend URL'), allowedOrigins: manifest.configuration.allowedOrigins.map(value => originUrl(value, 'origin')) };
      manifest.configuration = configuration;
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; await saveManifest(manifest); }
    for (const [id, sharing] of Object.entries(manifest.boards)) {
      requireId(id);
      if (!sharing.shared) continue;
      const stored = JSON.parse(await readFile(boardPath(id), 'utf8'));
      if (stored.id !== id || stored.version !== 1 || !Number.isSafeInteger(stored.revision)) throw new Error('Invalid Canvas sharing journal.');
      const doc = new Y.Doc(); Y.applyUpdate(doc, decodeUpdate(stored.update, MAX_DOCUMENT * 2)); validateBoardDoc(doc);
      const row = { id, doc, revision: stored.revision, pending: stored.pending, frozen: null, queue: Promise.resolve() }; rows.set(id, row);
      if (row.pending) {
        const candidate = new Y.Doc();
        try {
          Y.applyUpdate(candidate, decodeUpdate(row.pending.update, MAX_DOCUMENT * 2)); validateBoardDoc(candidate);
          const latest = await loadBoard(id);
          if (latest && !latest.archived && latest.revision === row.pending.baseRevision + 1 && boardFingerprint(latest) === JSON.stringify(readBoardDoc(candidate))) {
            doc.destroy(); row.doc = candidate; row.revision = latest.revision; row.pending = null;
          } else { candidate.destroy(); row.pending = null; }
        } catch { candidate.destroy(); row.frozen = 'unavailable'; }
      }
      try { await verifyLocal(row); } catch (cause) { row.frozen = cause.code || 'unavailable'; }
      await saveRow(row);
    }
  }
  const ensureInitialized = () => initialization ||= initialize();

  return {
    async start() {
      await ensureInitialized();
      if (running) return this.status();
      server = http.createServer((request, response) => { void handleHttp(request, response); });
      server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 30;
      websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PACKET, perMessageDeflate: false });
      server.on('upgrade', (request, socket, head) => {
        try {
          if (!allowedHost(request) || !allowedOrigin(request)) throw error('forbidden', 'Origin denied.', 403);
          if (request.url !== '/v1/sync') throw error('not_found', 'Not found.', 404);
          consumeRate(`ws:${request.socket.remoteAddress}`, 40);
          if (clients.size >= 64 || [...clients].filter(client => client.ws._socket?.remoteAddress === request.socket.remoteAddress).length >= 32) throw error('busy', 'Connection limit.', 503);
          websocketServer.handleUpgrade(request, socket, head, ws => attachSocket(ws, request));
        } catch (cause) { socket.end(`HTTP/1.1 ${cause.status || 403} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      running = true;
      let ticks = 0;
      interval = setInterval(() => {
        for (const client of clients) { if (!client.authenticated) continue; try { activeSession(client.session); } catch (cause) { rejectClient(client, cause.code, cause.message); } }
        for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key);
        for (const [key, value] of rateLimits) if (value.until <= Date.now()) rateLimits.delete(key);
        if (++ticks % 60 === 0) for (const client of clients) client.bytes = 0;
        if (ticks % 30 === 0) for (const client of clients) { if (!client.alive) client.ws.terminate(); else { client.alive = false; client.ws.ping(); } }
        // Archive/delete/external edits also stop existing viewers promptly.
        if (ticks % 5 === 0) for (const row of rows.values()) if (manifest.boards[row.id]?.shared && !row.frozen) void serializeBoard(row, () => verifyLocal(row)).catch(() => {});
      }, 1000); interval.unref();
      return this.status();
    },
    async close() {
      clearInterval(interval); running = false;
      for (const client of clients) client.ws.terminate();
      await administration; await Promise.all([...rows.values()].map(row => row.queue));
      if (websocketServer) await new Promise(resolve => websocketServer.close(resolve));
      if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      sessions.clear();
    },
    status() {
      return { running, host, port: server?.listening ? server.address().port : port, endpoint: endpoint(), ...clone(configuration), boards: [...rows.values()].map(row => ({ ...boardMeta(row), shared: !!manifest.boards[row.id]?.shared, frozen: row.frozen || null, connections: [...clients].filter(client => client.row === row && client.authenticated).length, invites: manifest.boards[row.id]?.invites.map(inviteMeta) || [] })) };
    },
    async configure({ publicUrl = configuration.publicUrl, frontendUrl = configuration.frontendUrl, allowedOrigins = configuration.allowedOrigins } = {}) {
      await ensureInitialized();
      return serializeAdmin(async () => {
        const next = { publicUrl: originUrl(publicUrl, 'public URL'), frontendUrl: originUrl(frontendUrl, 'frontend URL'), allowedOrigins: [...new Set([...DEFAULT_ORIGINS, ...allowedOrigins.map(value => originUrl(value, 'origin')), ...(frontendUrl ? [originUrl(frontendUrl, 'frontend URL')] : [])])] };
        if (next.allowedOrigins.length > 20) throw error('invalid_configuration', 'At most 20 origins are allowed.');
        const nextManifest = { ...manifest, configuration: next }; await saveManifest(nextManifest); manifest = nextManifest; configuration = next;
        for (const client of clients) if (!next.allowedOrigins.includes(client.origin)) rejectClient(client, 'forbidden_origin', 'This origin is no longer allowed.');
        return this.status();
      });
    },
    async share(board) {
      await ensureInitialized(); const id = requireId(board?.id);
      return serializeAdmin(async () => {
        const existing = rows.get(id);
        if (manifest.boards[id]?.shared && existing) { await serializeBoard(existing, () => verifyLocal(existing)); if (existing.frozen) throw error(existing.frozen, 'Stop sharing before restarting this board.', 409); return { ...boardMeta(existing), shared: true }; }
        const latest = await loadBoard(id);
        if (!latest || latest.id !== id || latest.archived || latest.deleted) throw error('unavailable', 'Only an existing, active board can be shared.', 409);
        if (!Number.isSafeInteger(latest.revision) || latest.revision < 1 || (board.revision !== undefined && board.revision !== latest.revision) || boardFingerprint(board) !== boardFingerprint(latest)) throw error('conflict', 'Save the board before sharing it.', 409);
        const doc = createBoardDoc(latest); validateBoardDoc(doc);
        const row = { id, doc, revision: latest.revision, pending: null, frozen: null, queue: Promise.resolve() };
        await saveRow(row);
        const next = clone(manifest); next.boards[id] = { shared: true, epoch: secret(), invites: [] }; await saveManifest(next); manifest = next;
        existing?.doc.destroy(); rows.set(id, row); return { ...boardMeta(row), shared: true };
      });
    },
    async listInvites(boardId) { await ensureInitialized(); return (manifest.boards[requireId(boardId)]?.invites || []).map(inviteMeta); },
    async createInvite(boardId, { role = 'view', expiresInHours = 24 } = {}) {
      await ensureInitialized(); requireId(boardId);
      if (!['view', 'edit'].includes(role) || !Number.isFinite(expiresInHours) || expiresInHours <= 0 || expiresInHours > 24 * 30) throw error('invalid_request', 'Choose view/edit access and an expiry within 30 days.');
      return serializeAdmin(async () => {
        const row = rows.get(boardId);
        if (!manifest.boards[boardId]?.shared || !row || row.frozen) throw error('unavailable', 'Share this board before inviting people.', 409);
        await serializeBoard(row, () => verifyLocal(row));
        if (manifest.boards[boardId].invites.length >= 100) throw error('busy', 'Restart sharing to create more invitations.', 409);
        const token = secret(), now = Date.now();
        const invitation = { id: randomUUID(), tokenHash: digest(token), role, createdAt: now, expiresAt: now + expiresInHours * 3600000, revokedAt: null };
        const next = clone(manifest); next.boards[boardId].invites.push(invitation); await saveManifest(next); manifest = next;
        const fragment = new URLSearchParams({ board: boardId, invite: token, server: endpoint() }).toString();
        return { ...inviteMeta(invitation), token, boardId, url: configuration.frontendUrl ? `${configuration.frontendUrl}/#${fragment}` : '' };
      });
    },
    async revokeInvite(boardId, inviteId) {
      await ensureInitialized(); requireId(boardId);
      return serializeAdmin(async () => {
        const next = clone(manifest), invitation = next.boards[boardId]?.invites.find(item => item.id === inviteId);
        if (!invitation) throw error('not_found', 'Invitation not found.', 404);
        invitation.revokedAt ||= Date.now(); await saveManifest(next); manifest = next;
        for (const client of clients) if (client.session?.boardId === boardId && client.session.inviteId === inviteId) rejectClient(client, 'revoked', 'This invitation was revoked.');
        const row = rows.get(boardId); if (row) await row.queue;
        return inviteMeta(invitation);
      });
    },
    async stopSharing(boardId) {
      await ensureInitialized(); requireId(boardId);
      return serializeAdmin(async () => {
        if (!manifest.boards[boardId]) return { boardId, shared: false };
        const next = clone(manifest); next.boards[boardId].shared = false; next.boards[boardId].epoch = secret(); await saveManifest(next); manifest = next;
        for (const client of clients) if (client.session?.boardId === boardId) rejectClient(client, 'revoked', 'The owner stopped sharing this board.');
        const row = rows.get(boardId); if (row) await row.queue;
        return { boardId, shared: false };
      });
    },
    async forget(boardId) {
      await ensureInitialized(); requireId(boardId);
      return serializeAdmin(async () => {
        // Revoke durably before draining writes or removing any saved content.
        // A failed purge therefore leaves sharing stopped and can safely retry.
        if (manifest.boards[boardId]) {
          const stopped = clone(manifest);
          stopped.boards[boardId].shared = false; stopped.boards[boardId].epoch = secret();
          await saveManifest(stopped); manifest = stopped;
        }
        for (const client of clients) if (client.session?.boardId === boardId) rejectClient(client, 'revoked', 'The owner permanently deleted this shared board.');
        const row = rows.get(boardId); if (row) await row.queue;
        for (const [key, session] of sessions) if (session.boardId === boardId) sessions.delete(key);
        try {
          // boardPath accepts a validated identifier and always targets one file
          // within the dedicated sharing directory; there is no recursive delete.
          await unlink(boardPath(boardId)).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
          const next = clone(manifest); delete next.boards[boardId];
          // Atomic manifest persistence also fsyncs the directory after unlink.
          await saveManifest(next); manifest = next;
        } catch {
          throw error('purge_failed', 'Sharing was stopped, but removing its saved board data could not be confirmed. Permanent deletion was cancelled.', 503);
        }
        rows.delete(boardId); row?.doc.destroy();
        return { boardId, shared: false, forgotten: true };
      });
    },
    async ownerSession(boardId) {
      await ensureInitialized(); requireId(boardId);
      const row = rows.get(boardId);
      if (!running || !manifest.boards[boardId]?.shared || !row || row.frozen) throw error('unavailable', 'This board is not available for sharing.', 409);
      return serializeBoard(row, async () => { await verifyLocal(row); return { ...issueSession(row, 'edit', 'Owner'), endpoint: localEndpoint(), storageIdentity: `owner:${digest(manifest.boards[boardId].epoch)}` }; });
    },
  };
}
