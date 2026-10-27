import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createCanvasService } from '../canvas-server/service.mjs';
import { CanvasSyncClient, createMemoryDraftStorage, MAX_UPDATE_BYTES, updateToBase64 } from '../frontend/features/diagrams/collaboration/canvas-sync-client.mjs';
import { createBoardDoc, readBoardDoc, applyBoardChange } from '../frontend/features/diagrams/collaboration/board-doc.mjs';
import { emptySnapshot, makeNode } from '../frontend/features/diagrams/diagram-model.mjs';

const ORIGIN = 'https://canvas-wire.example.test';
const copy = value => structuredClone(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, description, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail(`Timed out: ${description}`); await sleep(10); }
};

// ws exposes browser-compatible event properties; only Origin injection differs
// from a browser, which supplies it automatically on both fetch and WebSocket.
class BrowserSocket extends WebSocket {
  constructor(url) { super(url, { origin: ORIGIN }); }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-canvas-wire-'));
  const snapshot = emptySnapshot(); snapshot.structured.nodes = [makeNode('note', { x: 10, y: 20 }), makeNode('note', { x: 30, y: 40 })];
  const state = { board: { id: 'wire-board', name: 'Wire board', revision: 1, archived: false, schemaVersion: 1, snapshot }, saves: 0, save: null, sessionRequests: 0 };
  const callbacks = {
    loadBoard: async id => id === state.board.id ? copy(state.board) : null,
    saveBoard: async (candidate, expectedRevision) => {
      state.saves++;
      if (state.save) return state.save(candidate, expectedRevision);
      assert.equal(expectedRevision, state.board.revision);
      state.board = { ...copy(candidate), revision: expectedRevision + 1 }; return copy(state.board);
    },
  };
  let service = createCanvasService({ dataDir: directory, port: 0, ...callbacks });
  await service.start(); await service.configure({ frontendUrl: ORIGIN, allowedOrigins: [ORIGIN] }); await service.share(state.board);
  const port = service.status().port, endpoint = `http://127.0.0.1:${port}`, clients = [];
  t.after(async () => { for (const client of clients) client.destroy(); await Promise.allSettled(clients.map(client => client.persistChain)); await service.close(); await rm(directory, { recursive: true, force: true }); });
  const f = {
    directory, state, endpoint, get service() { return service; },
    async invitation(role = 'edit') { return service.createInvite(state.board.id, { role }); },
    async restart() { await service.close(); service = createCanvasService({ dataDir: directory, port, ...callbacks }); await service.start(); },
    async client(invitationOrSession, extra = {}) {
      const statuses = [], changes = [], presence = [];
      const client = new CanvasSyncClient({ endpoint, boardId: state.board.id, token: invitationOrSession.token, session: invitationOrSession.session, storageIdentity: invitationOrSession.storageIdentity, name: extra.name || 'Wire editor', storage: createMemoryDraftStorage(), WebSocketImpl: BrowserSocket, fetchImpl: (url, options) => {
        state.sessionRequests++; return fetch(url, { ...options, headers: { ...options.headers, Origin: ORIGIN } });
      }, reconnectBaseMs: 30, reconnectMaxMs: 100, onStatus: status => statuses.push(copy(status)), onChange: (board, meta) => changes.push({ board: copy(board), meta: copy(meta) }), onPresence: value => presence.push(copy(value)), ...extra });
      client.observed = { statuses, changes, presence }; clients.push(client); await client.start();
      if (!extra.expectTerminal) await until(() => client.ready || client.terminal, 'client receives initial sync');
      if (!extra.expectTerminal) assert.equal(client.terminal, false, JSON.stringify(client.status));
      return client;
    },
  };
  return f;
}

function change(client, mutate) {
  const previous = client.exportDraft(), next = copy(previous); mutate(next); client.setBoard(previous, next);
}

test('real clients exchange concurrent edits, revisions and presence; flush resolves only after committed ACK', async t => {
  const f = await fixture(t), invitation = await f.invitation(), a = await f.client(invitation, { name: 'Alice' }), b = await f.client(invitation, { name: 'Bob' });
  assert.equal(a.status.state, 'saved'); assert.equal(b.revision, 1);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.state.save = async (candidate, revision) => { entered(); await gate; f.state.board = { ...copy(candidate), revision: revision + 1 }; return copy(f.state.board); };
  change(a, board => { board.snapshot.structured.nodes[0].position.x = 111; });
  change(b, board => { board.snapshot.structured.nodes[1].position.y = 222; });
  let aFlushed = false, bFlushed = false;
  const aFlush = a.flush().then(() => { aFlushed = true; }), bFlush = b.flush().then(() => { bFlushed = true; });
  await started; await sleep(30);
  assert.equal(aFlushed, false); assert.equal(bFlushed, false); assert.equal(a.pendingCount, 1); assert.equal(b.pendingCount, 1);
  release(); await Promise.all([aFlush, bFlush]);
  await until(() => a.revision === 3 && b.revision === 3 && JSON.stringify(a.exportDraft()) === JSON.stringify(b.exportDraft()), 'both replicas receive both committed changes');
  assert.equal(a.exportDraft().snapshot.structured.nodes[0].position.x, 111);
  assert.equal(b.exportDraft().snapshot.structured.nodes[1].position.y, 222);
  assert.equal(a.status.state, 'saved'); assert.equal(b.pendingCount, 0);
  const journal = JSON.parse(await readFile(path.join(f.directory, 'board-wire-board.json'), 'utf8'));
  assert.equal(journal.revision, 3); assert.equal(journal.pending, null);
  a.setPresence({ cursor: { x: 42, y: 55 }, mode: 'structured', color: '#cc3344' });
  await until(() => b.peers.has(a.clientId), 'presence crosses the actual transport');
  assert.equal(b.peers.get(a.clientId).name, 'Alice'); assert.deepEqual(b.peers.get(a.clientId).cursor, { x: 42, y: 55 });
  await a.stop(); await until(() => b.peers.size === 0, 'presence clears after disconnect');
});

test('a guest refreshes its ephemeral session after restart using the same invitation and resends retained offline edits', async t => {
  const f = await fixture(t), invitation = await f.invitation(), client = await f.client(invitation);
  const initialSession = client.session;
  change(client, board => { board.name = 'Before restart'; }); await client.flush();
  await f.service.close(); await until(() => !client.ready, 'client observes server shutdown');
  change(client, board => { board.snapshot.structured.nodes[0].position.y = 808; }); await client.persistChain;
  assert.equal(client.pendingCount, 1); assert.equal(client.terminal, false);
  await f.restart();
  await until(() => client.ready && client.pendingCount === 0 && client.revision === 3, 'restart authentication refresh and pending update commit');
  assert.notEqual(client.session, initialSession); assert.equal(f.state.sessionRequests, 2);
  assert.equal(client.status.state, 'saved'); assert.equal(f.state.board.name, 'Before restart');
  assert.equal(f.state.board.snapshot.structured.nodes[0].position.y, 808);
});

test('owner cache survives credential renewal but a new sharing generation cannot restore stale deleted objects', async t => {
  const f = await fixture(t), storage = createMemoryDraftStorage(), firstCredential = await f.service.ownerSession('wire-board');
  const first = await f.client(firstCredential, { storage, reconnectBaseMs: 10000, reconnectMaxMs: 10000 });
  await f.service.close(); await until(() => !first.ready, 'owner observes shutdown');
  change(first, board => { board.name = 'Owner offline draft'; }); await first.persistChain; await first.stop();
  await f.restart(); const renewedCredential = await f.service.ownerSession('wire-board');
  assert.notEqual(renewedCredential.session, firstCredential.session); assert.equal(renewedCredential.storageIdentity, firstCredential.storageIdentity);
  const renewed = await f.client(renewedCredential, { storage, reconnectBaseMs: 10000, reconnectMaxMs: 10000 });
  await renewed.flush(); assert.equal(f.state.board.name, 'Owner offline draft'); assert.equal(renewed.storageKey, first.storageKey);
  // Keep one unacknowledged old-generation draft in the same browser storage.
  renewed.socket.terminate(); await until(() => !renewed.ready, 'owner transport disconnects');
  change(renewed, board => { board.snapshot.structured.nodes[0].position.x = 999; }); await renewed.persistChain; await renewed.stop();
  const removedId = f.state.board.snapshot.structured.nodes[0].id;
  await f.service.stopSharing('wire-board'); f.state.board.snapshot.structured.nodes.shift(); f.state.board.revision++;
  await f.service.share(f.state.board); const freshCredential = await f.service.ownerSession('wire-board');
  assert.notEqual(freshCredential.storageIdentity, renewedCredential.storageIdentity);
  const stale = await f.client(renewedCredential, { storage, expectTerminal: true });
  await until(() => stale.terminal, 'old owner session is permanently rejected');
  assert.equal(stale.status.code, 'revoked'); assert.equal(stale.pendingCount, 1);
  const fresh = await f.client(freshCredential, { storage });
  assert.notEqual(fresh.storageKey, renewed.storageKey); assert.equal(fresh.pendingCount, 0);
  assert.equal(fresh.exportDraft().snapshot.structured.nodes.some(node => node.id === removedId), false);
  assert.equal(f.state.board.snapshot.structured.nodes.some(node => node.id === removedId), false);
});

test('view access is enforced by both the client and server, and revocation freezes real clients', async t => {
  const f = await fixture(t), invitation = await f.invitation('view'), viewer = await f.client(invitation);
  assert.equal(viewer.role, 'view'); assert.equal(viewer.status.state, 'read-only');
  assert.throws(() => change(viewer, board => { board.name = 'Forbidden'; }), /read-only/);
  // Bypass the public client guard to demonstrate independent server enforcement.
  const forgedDoc = createBoardDoc(); Y.applyUpdate(forgedDoc, Y.encodeStateAsUpdate(viewer.doc));
  const previous = readBoardDoc(forgedDoc), next = { ...previous, name: 'Forged write' }, vector = Y.encodeStateVector(forgedDoc);
  applyBoardChange(forgedDoc, previous, next, 'attacker');
  viewer.socket.send(JSON.stringify({ type: 'update', id: 'forged', update: updateToBase64(Y.encodeStateAsUpdate(forgedDoc, vector)) }));
  await until(() => viewer.terminal, 'client understands real read_only server response');
  assert.equal(viewer.status.code, 'read_only'); assert.equal(f.state.saves, 0); forgedDoc.destroy();
  const editInvitation = await f.invitation(), editor = await f.client(editInvitation);
  await f.service.revokeInvite('wire-board', editInvitation.id);
  await until(() => editor.terminal, 'editor processes invitation revocation');
  assert.equal(editor.status.code, 'revoked'); assert.equal(editor.reconnectTimer, null);
});

test('real persistence errors permanently freeze the client with its draft retained and no successful flush', async t => {
  const f = await fixture(t), invitation = await f.invitation(), client = await f.client(invitation);
  f.state.save = async () => { throw new Error('simulated backend save failure'); };
  change(client, board => { board.name = 'Retained unsaved draft'; });
  const flush = assert.rejects(client.flush(), /draft|Access|rejected/i);
  await until(() => client.terminal, 'client freezes on persistence_failed'); await flush;
  assert.equal(client.status.code, 'persistence_failed'); assert.equal(client.pendingCount, 1); assert.equal(client.reconnectTimer, null);
  assert.equal(client.exportDraft().name, 'Retained unsaved draft'); assert.equal(f.state.board.name, 'Wire board');
  const savedDraft = await client.storage.load(client.storageKey); assert.equal(savedDraft.pending.length, 1);
});

test('the server rejects decoded updates above the real client limit before broadcasting them', async t => {
  const f = await fixture(t), invitation = await f.invitation(), sender = await f.client(invitation), peer = await f.client(invitation);
  // This fits the transport packet ceiling; it must fail the decoded limit before
  // Yjs parsing, so a sender cannot force every normal peer into a protocol error.
  sender.socket.send(JSON.stringify({ type: 'update', id: 'oversized', update: Buffer.alloc(MAX_UPDATE_BYTES + 1).toString('base64') }));
  await until(() => sender.terminal, 'oversized sender receives permanent rejection');
  assert.equal(sender.status.code, 'too_large'); assert.equal(peer.terminal, false); assert.equal(peer.status.state, 'saved'); assert.equal(f.state.saves, 0);
});
