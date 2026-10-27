import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { CanvasSyncClient, createMemoryDraftStorage, normalizeSyncEndpoint, updateToBase64, updateFromBase64 } from '../frontend/features/diagrams/collaboration/canvas-sync-client.mjs';
import { createBoardDoc, readBoardDoc, applyBoardChange, REMOTE_ORIGIN } from '../frontend/features/diagrams/collaboration/board-doc.mjs';
import { emptySnapshot, makeNode } from '../frontend/features/diagrams/diagram-model.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the transport state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const board = () => ({ id: 'board-a', name: 'Board', snapshot: { ...emptySnapshot(), structured: { nodes: [{ ...makeNode('note'), id: 'note-a' }], edges: [] } } });
class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(message) { this.sent.push(JSON.parse(message)); }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}
function makeClient(options = {}) { return new CanvasSyncClient({ endpoint: 'https://sync.example.com', boardId: 'board-a', session: 'secret-session', WebSocketImpl: FakeSocket, storage: createMemoryDraftStorage(), reconnectBaseMs: 5, reconnectMaxMs: 10, ...options }); }
async function connect(client, server = createBoardDoc(board()), role = 'edit') {
  await client.start(); const socket = FakeSocket.instances.at(-1); socket.open();
  socket.message({ type: 'sync', update: updateToBase64(Y.encodeStateAsUpdate(server)), board: { id: 'board-a', revision: 1 }, role, clientId: 'local' });
  await client.messageChain; await tick(); return { socket, server };
}
function localEdit(client, name = 'Changed') { const previous = client.exportDraft(), next = structuredClone(previous); next.snapshot.structured.nodes[0].data.name = name; client.setBoard(previous, next); }

test('authentication stays out of URLs and saved status waits for durable ACK', async () => {
  const statuses = [], client = makeClient({ onStatus: status => statuses.push(status) });
  const { socket } = await connect(client);
  assert.equal(socket.url, 'wss://sync.example.com/v1/sync'); assert.deepEqual(socket.sent[0], { type: 'auth', session: 'secret-session' });
  localEdit(client); await client.persistChain; await tick();
  assert.equal(client.status.state, 'pending'); assert.equal(client.pendingCount, 1);
  const update = socket.sent.find(message => message.type === 'update'); assert.ok(update);
  let complete = false; const flushed = client.flush().then(() => { complete = true; }); await tick(); assert.equal(complete, false);
  socket.message({ type: 'ack', id: update.id, revision: 2 }); await client.messageChain; await flushed;
  assert.equal(client.status.state, 'saved'); assert.equal(client.status.revision, 2); assert.equal(client.pendingCount, 0); client.destroy();
});

test('offline draft reload replays pending deltas only and drops ACKed queue entries', async () => {
  const storage = createMemoryDraftStorage(), first = makeClient({ storage }), { socket, server } = await connect(first);
  localEdit(first, 'Pending edit'); await first.persistChain; await tick();
  const pending = socket.sent.find(message => message.type === 'update'); first.destroy();
  const second = makeClient({ storage }); const resumed = await connect(second, server);
  const replayed = resumed.socket.sent.filter(message => message.type === 'update');
  assert.deepEqual(replayed, [pending]);
  Y.applyUpdate(server, updateFromBase64(pending.update), REMOTE_ORIGIN);
  resumed.socket.message({ type: 'ack', id: pending.id }); await second.messageChain; second.destroy();
  const third = makeClient({ storage }); const final = await connect(third, server);
  assert.equal(final.socket.sent.filter(message => message.type === 'update').length, 0);
  assert.equal(third.exportDraft().snapshot.structured.nodes[0].data.name, 'Pending edit'); third.destroy();
});

test('revocation freezes retries and preserves an exportable draft', async () => {
  const client = makeClient(), { socket } = await connect(client);
  localEdit(client, 'Private pending'); await client.persistChain;
  socket.message({ type: 'error', code: 'revoked' }); await client.messageChain;
  assert.equal(client.status.state, 'expired'); assert.equal(client.status.terminal, true); assert.equal(client.reconnectTimer, null);
  assert.equal(client.exportDraft().snapshot.structured.nodes[0].data.name, 'Private pending');
  assert.throws(() => localEdit(client), /closed/); await assert.rejects(client.flush(), /Access has changed/); client.destroy();
});

test('view role blocks edits and never sends pending updates', async () => {
  const client = makeClient({ role: 'view' }), { socket } = await connect(client, createBoardDoc(board()), 'view');
  assert.equal(client.role, 'view'); assert.equal(client.status.state, 'read-only'); assert.throws(() => localEdit(client), /read-only/);
  assert.equal(socket.sent.filter(message => message.type === 'update').length, 0); client.destroy();
});

test('remote updates do not enqueue local saves and presence remains outside the document', async () => {
  const peers = [], client = makeClient({ onPresence: value => peers.push(value) }), { socket, server } = await connect(client);
  const state = Y.encodeStateVector(server), previous = readBoardDoc(server), next = structuredClone(previous); next.name = 'Peer name'; applyBoardChange(server, previous, next, {});
  socket.message({ type: 'update', update: updateToBase64(Y.encodeStateAsUpdate(server, state)), board: { revision: 2 } });
  socket.message({ type: 'presence', clientId: 'peer', state: { name: 'Peer', color: '#abcdef', cursor: { x: 1, y: 2 }, mode: 'sketch', secret: 'not shared' } });
  await client.messageChain; assert.equal(client.pendingCount, 0); assert.equal(client.exportDraft().name, 'Peer name'); assert.equal(client.revision, 2);
  assert.equal(peers.at(-1)[0].secret, undefined); assert.equal(client.exportDraft().presence, undefined);
  socket.message({ type: 'presence', clientId: 'peer', state: null }); await client.messageChain; assert.deepEqual(peers.at(-1), []); client.destroy();
});

test('disconnect backs off, rejects flush and reconnects with only queued updates', async () => {
  const client = makeClient(), { socket } = await connect(client); localEdit(client); await client.persistChain; await tick();
  const flush = client.flush(); socket.close(1006); await assert.rejects(flush, /offline/); assert.equal(client.status.state, 'offline');
  await waitFor(() => FakeSocket.instances.at(-1) !== socket); client.destroy();
});

test('owner storage identity survives session rotation without sending cached state', async () => {
  const storage = createMemoryDraftStorage(), first = makeClient({ storage, storageIdentity: 'owner', session: 'session-1' }), connected = await connect(first);
  localEdit(first); await first.persistChain; first.destroy();
  const second = makeClient({ storage, storageIdentity: 'owner', session: 'session-2' }), resumed = await connect(second, connected.server);
  assert.equal(second.pendingCount, 1); assert.equal(resumed.socket.sent[0].session, 'session-2');
  assert.equal(resumed.socket.sent.filter(message => message.type === 'update').length, 1); second.destroy();
});

test('session exchange uses body credentials and retries network outages', async () => {
  let calls = 0, request;
  const client = makeClient({ session: undefined, token: 'invite-secret', fetchImpl: async (url, options) => { calls++; request = { url, options }; if (calls === 1) throw new Error('Offline'); return { ok: true, json: async () => ({ session: 'session-after-retry', role: 'view' }) }; } });
  await client.start(); assert.equal(client.status.state, 'offline');
  await waitFor(() => calls === 2 && client.role === 'view');
  assert.equal(calls, 2); assert.equal(request.url, 'https://sync.example.com/v1/session'); assert.equal(request.options.headers['ngrok-skip-browser-warning'], 'true');
  assert.equal(JSON.parse(request.options.body).token, 'invite-secret'); assert.equal(client.role, 'view'); client.destroy();
});

test('a forgotten server session exchanges a new session once without dropping pending edits', async () => {
  let exchanges = 0;
  const client = makeClient({ token: 'invitation', fetchImpl: async () => { exchanges++; return { ok: true, json: async () => ({ session: 'renewed-session', role: 'edit' }) }; } });
  const { socket, server } = await connect(client); localEdit(client, 'Survives server restart'); await client.persistChain;
  socket.close(1006); await waitFor(() => FakeSocket.instances.at(-1) !== socket);
  const stale = FakeSocket.instances.at(-1); stale.open(); stale.message({ type: 'error', code: 'unauthorized' }); await client.messageChain;
  const renewed = FakeSocket.instances.at(-1); renewed.open();
  assert.equal(exchanges, 1); assert.equal(renewed.sent[0].session, 'renewed-session');
  renewed.message({ type: 'sync', update: updateToBase64(Y.encodeStateAsUpdate(server)), board: { id: 'board-a' }, role: 'edit' }); await client.messageChain;
  assert.equal(client.pendingCount, 1); assert.equal(client.exportDraft().snapshot.structured.nodes[0].data.name, 'Survives server restart');
  assert.equal(renewed.sent.filter(message => message.type === 'update').length, 1); client.destroy();
});

test('memory-only storage never claims a durable browser draft while offline', async () => {
  const client = makeClient(), { socket } = await connect(client); localEdit(client); await client.persistChain; socket.close(1006);
  assert.equal(client.status.localPersisted, false); assert.doesNotMatch(client.status.message, /Saved in this browser/); assert.match(client.status.message, /Keep this page open/); client.destroy();
});

test('unsafe endpoints and oversized updates fail closed without discarding the draft', async () => {
  assert.throws(() => normalizeSyncEndpoint('http://public.example.com'), /HTTPS/);
  assert.throws(() => normalizeSyncEndpoint('https://example.com?token=secret'), /query/);
  assert.equal(normalizeSyncEndpoint('http://127.0.0.1:5020/'), 'http://127.0.0.1:5020');
  const client = makeClient({ maxUpdateBytes: 8 }); await connect(client); localEdit(client, 'A retained oversized edit'); await client.persistChain;
  assert.equal(client.status.terminal, true); assert.equal(client.status.code, 'oversized');
  assert.equal(client.exportDraft().snapshot.structured.nodes[0].data.name, 'A retained oversized edit'); client.destroy();
});
