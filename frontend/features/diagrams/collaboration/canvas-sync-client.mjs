import * as Y from 'yjs';
import { applyBoardChange, createBoardDoc, createLocalUndoManager, readBoardDoc, REMOTE_ORIGIN, validateBoardDoc } from './board-doc.mjs';

export const MAX_UPDATE_BYTES = 10_000_000;
const terminalCodes = new Set(['expired', 'revoked', 'unauthorized', 'forbidden', 'conflict']);
const normalizeRole = role => role === 'view' || role === 'read' ? 'view' : 'edit';
const copy = value => JSON.parse(JSON.stringify(value));
export function updateToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return globalThis.btoa(binary);
}
export function updateFromBase64(value, maxBytes = MAX_UPDATE_BYTES) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid or oversized collaboration update.');
  const binary = globalThis.atob(value);
  if (binary.length > maxBytes) throw new Error('Collaboration update exceeds the size limit.');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function normalizeSyncEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash) throw new Error('Use a collaboration server URL without credentials, query parameters, or fragments.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new Error('The collaboration server must use HTTPS.');
  return url.href.replace(/\/+$/, '');
}

/** Injectable storage keeps transport tests independent of browser globals. */
export function createMemoryDraftStorage() {
  const drafts = new Map();
  return { durable: false, async load(key) { return drafts.has(key) ? copy(drafts.get(key)) : null; }, async save(key, value) { drafts.set(key, copy(value)); }, async remove(key) { drafts.delete(key); } };
}

export function createIndexedDBDraftStorage(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return createMemoryDraftStorage();
  let connection;
  const database = () => connection ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('argus-canvas-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open browser draft storage.'));
  });
  const operation = async (mode, action) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('drafts', mode);
      const request = action(transaction.objectStore('drafts'));
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || request.error || new Error('Unable to store browser draft.'));
      transaction.onabort = () => reject(transaction.error || new Error('Browser draft transaction was aborted.'));
    });
  };
  return { durable: true, load: key => operation('readonly', store => store.get(key)), save: (key, value) => operation('readwrite', store => store.put(value, key)), remove: key => operation('readwrite', store => store.delete(key)) };
}

function cleanPresence(state = {}) {
  const result = { name: typeof state.name === 'string' ? state.name.slice(0, 80) : '', color: /^#[\da-f]{6}$/i.test(state.color || '') ? state.color : '#6366f1', mode: state.mode === 'sketch' ? 'sketch' : 'structured' };
  if (Number.isFinite(state.cursor?.x) && Number.isFinite(state.cursor?.y) && Math.abs(state.cursor.x) <= 1_000_000 && Math.abs(state.cursor.y) <= 1_000_000) result.cursor = { x: state.cursor.x, y: state.cursor.y };
  return result;
}

async function identityHash(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Authenticated JSON WebSocket transport. ACK means the Mac committed to disk. */
export class CanvasSyncClient {
  constructor({ endpoint, boardId, session, token, storageIdentity, name = '', role = 'edit', doc, onChange = () => {}, onStatus = () => {}, onPresence = () => {}, storage, WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch, reconnectBaseMs = 500, reconnectMaxMs = 30_000, maxUpdateBytes = MAX_UPDATE_BYTES }) {
    this.endpoint = normalizeSyncEndpoint(endpoint);
    if (typeof boardId !== 'string' || !boardId) throw new Error('A board ID is required.');
    this.boardId = boardId; this.session = session; this.token = token; this.storageIdentity = storageIdentity; this.name = name;
    this.role = normalizeRole(role); this.doc = doc || createBoardDoc();
    this.onChange = onChange; this.onStatus = onStatus; this.onPresence = onPresence;
    this.storage = storage || createIndexedDBDraftStorage(); this.WebSocketImpl = WebSocketImpl; this.fetchImpl = fetchImpl;
    this.reconnectBaseMs = reconnectBaseMs; this.reconnectMaxMs = reconnectMaxMs; this.maxUpdateBytes = maxUpdateBytes;
    this.localOrigin = {}; this.undoManager = createLocalUndoManager(this.doc, this.localOrigin);
    this.pending = new Map(); this.peers = new Map(); this.sent = new Set(); this.waiters = new Set();
    this.status = { state: 'connecting', pending: 0, role: this.role, localPersisted: false };
    this.started = false; this.stopped = false; this.terminal = false; this.ready = false; this.attempt = 0;
    this.persistChain = Promise.resolve(); this.messageChain = Promise.resolve();
    this._onDocUpdate = (update, origin) => {
      if (origin === REMOTE_ORIGIN) return;
      if (origin !== this.localOrigin && origin !== this.undoManager) return;
      if (this.role === 'view' || this.terminal || this.stopped) return;
      const id = globalThis.crypto.randomUUID();
      this.pending.set(id, { id, update: updateToBase64(update) });
      this.localPersisted = false;
      this._emitChange(false);
      if (update.length > this.maxUpdateBytes) {
        this._persist().catch(() => {});
        this._freeze('oversized', 'This edit exceeds the upload limit. Export your draft to keep a copy.'); return;
      }
      this._setStatus(this.ready ? 'pending' : 'offline');
      this._persist().then(() => {
        if (!this.terminal && !this.stopped) this._setStatus(this.ready ? 'pending' : 'offline');
        this._sendPending();
      }).catch(() => {});
    };
    this.doc.on('update', this._onDocUpdate);
  }

  get pendingCount() { return this.pending.size; }
  get canUndo() { return this.undoManager.undoStack.length > 0; }
  get canRedo() { return this.undoManager.redoStack.length > 0; }

  async start() {
    if (this.started) return this;
    this.started = true; this.stopped = false;
    this.storageKey = `${this.endpoint}|${this.boardId}|${await identityHash(this.storageIdentity || this.token || this.session || '')}`;
    try {
      const cached = await this.storage.load(this.storageKey);
      if (cached?.snapshot) {
        Y.applyUpdate(this.doc, updateFromBase64(cached.snapshot, MAX_UPDATE_BYTES * 4), REMOTE_ORIGIN);
        if (this.doc.getMap('board').size) validateBoardDoc(this.doc);
        for (const update of cached.pending || []) {
          if (typeof update.id !== 'string') throw new Error('Invalid cached draft update.');
          updateFromBase64(update.update, MAX_UPDATE_BYTES * 4);
          this.pending.set(update.id, update);
        }
        this.localPersisted = this.storage.durable !== false;
        this._emitChange(true);
      }
    } catch {
      this._freeze('draft-storage', 'The browser draft could not be loaded. Existing draft data was retained.');
      return this;
    }
    if (this.stopped) return this;
    if (!this.session) {
      try {
        const response = await this.fetchImpl(`${this.endpoint}/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' }, body: JSON.stringify({ boardId: this.boardId, token: this.token, name: this.name }) });
        const data = await response.json();
        if (!response.ok || typeof data.session !== 'string') {
          this._freeze(data.code || data.error || (response.status === 401 || response.status === 403 ? 'unauthorized' : 'session'), 'Unable to authorize this board. Export your draft to keep a copy.');
          return this;
        }
        this.session = data.session;
        if (data.role) this.role = normalizeRole(data.role);
      } catch {
        this._setStatus('offline', { message: this._offlineMessage() });
        this.started = false;
        if (!this.stopped && !this.terminal) {
          const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(this.attempt++, 8));
          this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.start(); }, delay);
        }
        return this;
      }
    }
    this._connect();
    return this;
  }

  _connect() {
    if (this.stopped || this.terminal) return;
    this._setStatus('connecting');
    const url = new URL(`${this.endpoint}/v1/sync`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try { socket = new this.WebSocketImpl(url.href); }
    catch { this._scheduleReconnect(); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped || this.terminal) return;
      this._setStatus('syncing');
      socket.send(JSON.stringify({ type: 'auth', session: this.session }));
    };
    socket.onmessage = event => {
      if (this.socket !== socket || this.stopped || this.terminal) return;
      this.messageChain = this.messageChain.then(() => this._handleMessage(event.data)).catch(() => this._freeze('protocol', 'The server sent an invalid collaboration update. Your browser draft is retained.'));
    };
    socket.onerror = () => {};
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.ready = false; this.sent.clear(); this.peers.clear(); this.onPresence([]);
      if (this.stopped || this.terminal) return;
      if ([4001, 4003, 4401, 4403].includes(event.code)) { this._freeze('unauthorized', 'Access has expired or was revoked. Export your draft to keep a copy.'); return; }
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this.stopped || this.terminal || this.reconnectTimer) return;
    this.ready = false; this._setStatus('offline', { message: this._offlineMessage() });
    this._rejectWaiters(new Error('The Mac is offline; pending edits remain in the browser.'));
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(this.attempt++, 8));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, delay + Math.floor(delay * .2 * Math.random()));
  }

  async _handleMessage(raw) {
    if (typeof raw !== 'string' || raw.length > Math.ceil(MAX_UPDATE_BYTES * 4 / 3) * 4 + 16_384) throw new Error('Invalid server message.');
    const message = JSON.parse(raw);
    if (message.type === 'sync') {
      if (message.board?.id && message.board.id !== this.boardId) throw new Error('Board mismatch.');
      Y.applyUpdate(this.doc, updateFromBase64(message.update, MAX_UPDATE_BYTES * 4), REMOTE_ORIGIN);
      const board = validateBoardDoc(this.doc);
      if (board.id !== this.boardId) throw new Error('Board mismatch.');
      this.role = normalizeRole(message.role);
      this.clientId = message.clientId; this.revision = message.board?.revision ?? message.revision ?? this.revision;
      this.ready = true; this.attempt = 0; this.refreshAttempted = false; this.sent.clear();
      this._emitChange(true);
      await this._persist();
      if (this.role === 'view' && this.pending.size) { this._freeze('forbidden', 'This board is now read-only. Export your pending draft to keep a copy.'); return; }
      this._setStatus(this.pending.size ? 'pending' : this.role === 'view' ? 'read-only' : 'saved');
      this._sendPending();
      if (this.presence) this._send({ type: 'presence', state: this.presence });
      this._resolveWaiters();
    } else if (message.type === 'update') {
      if (!this.ready) throw new Error('Update before sync.');
      Y.applyUpdate(this.doc, updateFromBase64(message.update, this.maxUpdateBytes), REMOTE_ORIGIN);
      validateBoardDoc(this.doc);
      this.revision = message.board?.revision ?? message.revision ?? this.revision;
      this._emitChange(true); await this._persist();
    } else if (message.type === 'ack') {
      if (!this.ready || typeof message.id !== 'string' || !this.pending.has(message.id)) return;
      this.pending.delete(message.id); this.sent.delete(message.id); this.revision = message.board?.revision ?? message.revision ?? this.revision;
      await this._persist();
      this._setStatus(this.pending.size ? 'pending' : this.role === 'view' ? 'read-only' : 'saved');
      this._resolveWaiters();
    } else if (message.type === 'presence') {
      if (!this.ready || typeof message.clientId !== 'string' || message.clientId === this.clientId) return;
      if (message.state === null) this.peers.delete(message.clientId);
      else this.peers.set(message.clientId, { clientId: message.clientId, ...cleanPresence(message.state) });
      this.onPresence([...this.peers.values()]);
    } else if (message.type === 'error') {
      if (message.code === 'unauthorized' && !this.ready && this.token && !this.refreshAttempted) {
        this.refreshAttempted = true;
        const previousSocket = this.socket; this.socket = null; previousSocket?.close();
        clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
        this.sent.clear(); this.session = undefined; this.started = false;
        await this.persistChain;
        await this.start();
        return;
      }
      if (terminalCodes.has(message.code)) this._freeze(message.code, 'Access has changed. Export your browser draft to keep a copy.');
      else this._freeze(message.code || 'server', 'The Mac rejected an update. Export your browser draft to keep a copy.');
    }
  }

  _send(message) {
    if (!this.ready || !this.socket || this.socket.readyState !== 1 || this.terminal || this.stopped) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }
  _sendPending() {
    if (this.role === 'view' || this.terminal) return;
    for (const [id, item] of this.pending) {
      if (item.update.length > Math.ceil(this.maxUpdateBytes / 3) * 4) { this._freeze('oversized', 'This draft exceeds the upload limit. Export it to keep a copy.'); return; }
      if (!this.sent.has(id) && this._send({ type: 'update', ...item })) this.sent.add(id);
    }
  }
  _emitChange(remote) {
    if (!this.doc.getMap('board').size) return;
    this.onChange(readBoardDoc(this.doc), { role: this.role, revision: this.revision, clientId: this.clientId, remote });
  }
  _setStatus(state, extras = {}) {
    this.status = { state, pending: this.pending.size, role: this.role, revision: this.revision, terminal: this.terminal, localPersisted: !!this.localPersisted, ...extras };
    this.onStatus(this.status);
  }
  _offlineMessage() {
    return this.localPersisted ? 'Saved in this browser; waiting for the Mac.' : 'The Mac is offline. Keep this page open or export a draft to retain unsaved edits.';
  }
  _persist() {
    if (!this.storageKey) return Promise.resolve();
    const draft = { snapshot: updateToBase64(Y.encodeStateAsUpdate(this.doc)), pending: [...this.pending.values()], savedAt: Date.now() };
    this.persistChain = this.persistChain.then(async () => {
      await this.storage.save(this.storageKey, draft); this.localPersisted = this.storage.durable !== false;
    });
    return this.persistChain.catch(error => { this._freeze('draft-storage', 'The browser could not save this draft. Export it before closing the page.'); throw error; });
  }
  _freeze(code, message) {
    if (this.terminal) return;
    this.terminal = true; this.ready = false;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    clearTimeout(this.presenceTimer); this.presenceTimer = null;
    this._setStatus(['expired', 'revoked', 'unauthorized', 'forbidden'].includes(code) ? 'expired' : 'error', { code, message });
    this.socket?.close(); this._rejectWaiters(new Error(message));
  }

  setBoard(previous, next) {
    if (this.role === 'view') throw new Error('This board is read-only.');
    if (this.terminal || this.stopped) throw new Error('This collaboration session is closed. Export your draft before reconnecting.');
    return applyBoardChange(this.doc, previous, next, this.localOrigin);
  }
  undo() { if (this.role !== 'view' && !this.terminal && !this.stopped) return this.undoManager.undo(); return null; }
  redo() { if (this.role !== 'view' && !this.terminal && !this.stopped) return this.undoManager.redo(); return null; }
  setPresence(state) {
    this.presence = cleanPresence({ name: this.name, ...state });
    if (this.presenceTimer || this.terminal || this.stopped) return;
    this.presenceTimer = setTimeout(() => { this.presenceTimer = null; this._send({ type: 'presence', state: this.presence }); }, 50);
  }
  exportDraft() { return readBoardDoc(this.doc); }
  flush({ timeoutMs = 15_000 } = {}) {
    if (this.terminal || this.stopped || !this.ready) return Promise.reject(new Error(this.status.message || 'The Mac is offline; pending edits remain in the browser.'));
    if (!this.pending.size) return this.persistChain;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error('The Mac has not acknowledged every pending edit.')); }, timeoutMs);
      this.waiters.add(waiter); this._sendPending();
    });
  }
  _resolveWaiters() {
    if (this.pending.size || !this.ready || this.terminal) return;
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.resolve(); }
    this.waiters.clear();
  }
  _rejectWaiters(error) {
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters.clear();
  }
  stop() {
    this.stopped = true; this.ready = false;
    clearTimeout(this.reconnectTimer); clearTimeout(this.presenceTimer);
    this.reconnectTimer = null; this.presenceTimer = null;
    this.socket?.close(); this.peers.clear(); this.onPresence([]);
    this._rejectWaiters(new Error('The collaboration session was closed.'));
    return this.persistChain;
  }
  destroy() { this.stop(); this.doc.off('update', this._onDocUpdate); this.undoManager.destroy(); }
}
