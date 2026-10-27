import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, stat, rm, mkdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createCanvasService } from '../canvas-server/service.mjs';
import { createBoardDoc, applyBoardChange, readBoardDoc } from '../frontend/features/diagrams/collaboration/board-doc.mjs';
import { emptySnapshot, makeNode } from '../frontend/features/diagrams/diagram-model.mjs';

const ORIGIN = 'https://canvas.example.test';
const copy = value => structuredClone(value);
const board = (id = 'board-a') => ({ id, name: 'Team board', revision: 1, archived: false, schemaVersion: 1, snapshot: { ...emptySnapshot(), structured: { nodes: [makeNode('note', { x: 10, y: 20 }), makeNode('note', { x: 30, y: 40 })], edges: [], viewport: { x: 77, y: 88, zoom: 2 } } } });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-canvas-test-'));
  const state = { board: board(), saves: 0, save: null };
  const callbacks = {
    loadBoard: async id => state.board?.id === id ? copy(state.board) : null,
    saveBoard: async (candidate, revision) => {
      state.saves++;
      if (state.save) return state.save(candidate, revision);
      assert.equal(revision, state.board.revision, 'backend enforces the revision precondition');
      state.board = { ...copy(candidate), revision: revision + 1 }; return copy(state.board);
    },
  };
  let service = createCanvasService({ dataDir: directory, port: 0, ...callbacks, ...options });
  await service.start(); await service.configure({ frontendUrl: ORIGIN, allowedOrigins: [ORIGIN] });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, state, get service() { return service; },
    get url() { return `http://127.0.0.1:${service.status().port}`; },
    async share(role = 'edit', hours = 24) { await service.share(state.board); return service.createInvite(state.board.id, { role, expiresInHours: hours }); },
    async restart() { await service.close(); service = createCanvasService({ dataDir: directory, port: 0, ...callbacks, ...options }); await service.start(); },
  };
}

async function session(f, invitation, overrides = {}, headers = {}) {
  const response = await fetch(`${f.url}/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: JSON.stringify({ boardId: invitation.boardId, token: invitation.token, name: 'Alice', ...overrides }) });
  return { status: response.status, ...(await response.json()) };
}

async function connect(f, credential, extraAuth = {}) {
  const ws = new WebSocket(`${f.url.replace('http:', 'ws:')}/v1/sync`, { origin: ORIGIN });
  const messages = [], waiting = new Set();
  ws.on('message', data => { const message = JSON.parse(data.toString()); messages.push(message); for (const check of [...waiting]) check(); });
  ws.on('error', () => {});
  await once(ws, 'open');
  const client = {
    ws, messages,
    send(message) { ws.send(JSON.stringify(message)); },
    next(type, predicate = () => true, timeout = 3000) {
      return new Promise((resolve, reject) => {
        const check = () => { const index = messages.findIndex(message => message.type === type && predicate(message)); if (index >= 0) { clearTimeout(timer); waiting.delete(check); resolve(messages.splice(index, 1)[0]); } };
        const timer = setTimeout(() => { waiting.delete(check); reject(new Error(`Timed out waiting for ${type}: ${JSON.stringify(messages)}`)); }, timeout);
        waiting.add(check); check();
      });
    },
    async close() { if (ws.readyState === WebSocket.CLOSED) return; const closed = once(ws, 'close'); ws.close(); await closed; },
  };
  client.send({ type: 'auth', session: credential.session, ...extraAuth });
  return client;
}

async function joined(f, invitation) {
  const credential = await session(f, invitation); assert.equal(credential.status, 200);
  const client = await connect(f, credential); const sync = await client.next('sync');
  client.doc = createBoardDoc(); Y.applyUpdate(client.doc, Buffer.from(sync.update, 'base64')); client.sync = sync;
  return client;
}

function edit(client, mutate, id = 'change-1') {
  const previous = readBoardDoc(client.doc), next = copy(previous), vector = Y.encodeStateVector(client.doc);
  mutate(next); applyBoardChange(client.doc, previous, next, 'test');
  const message = { type: 'update', id, update: Buffer.from(Y.encodeStateAsUpdate(client.doc, vector)).toString('base64') };
  client.send(message); return message;
}

test('two editors merge independent changes; ACK and broadcast wait for durable backend save', async t => {
  const f = await fixture(t);
  f.state.board.snapshot.sketch.appState = { scrollX: 35, scrollY: 80, zoom: { value: 1.25 } };
  f.state.board.snapshot.sketch.libraryItems = [{ id: 'local-library', status: 'published', elements: [] }];
  const invitation = await f.share();
  const a = await joined(f, invitation), b = await joined(f, invitation);
  let release, saving;
  const started = new Promise(resolve => { saving = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.state.save = async (candidate, revision) => { saving(); await gate; f.state.board = { ...copy(candidate), revision: revision + 1 }; return copy(f.state.board); };
  edit(a, value => { value.snapshot.structured.nodes[0].position.x = 101; }, 'a');
  await started; await wait(30);
  assert.equal(a.messages.some(message => message.type === 'ack'), false);
  assert.equal(b.messages.some(message => message.type === 'update'), false);
  release(); assert.equal((await a.next('ack')).revision, 2);
  edit(b, value => { value.snapshot.structured.nodes[1].position.y = 202; }, 'b');
  await b.next('ack');
  const fromA = await b.next('update'), fromB = await a.next('update');
  Y.applyUpdate(a.doc, Buffer.from(fromB.update, 'base64')); Y.applyUpdate(b.doc, Buffer.from(fromA.update, 'base64'));
  assert.deepEqual(readBoardDoc(a.doc), readBoardDoc(b.doc));
  assert.equal(f.state.board.snapshot.structured.nodes[0].position.x, 101);
  assert.equal(f.state.board.snapshot.structured.nodes[1].position.y, 202);
  assert.deepEqual(f.state.board.snapshot.structured.viewport, { x: 77, y: 88, zoom: 2 });
  assert.deepEqual(f.state.board.snapshot.sketch.appState, { scrollX: 35, scrollY: 80, zoom: { value: 1.25 } });
  assert.deepEqual(f.state.board.snapshot.sketch.libraryItems, [{ id: 'local-library', status: 'published', elements: [] }]);
  const stored = JSON.parse(await readFile(path.join(f.directory, 'board-board-a.json'), 'utf8'));
  assert.equal(stored.revision, 3); assert.equal(stored.pending, null);
  await a.close(); await b.close();
});

test('view sessions cannot write; presence is sanitized, scoped, and removed on disconnect', async t => {
  const f = await fixture(t), editInvitation = await f.share(), viewInvitation = await f.service.createInvite('board-a', { role: 'view' });
  const a = await joined(f, editInvitation), viewer = await joined(f, viewInvitation);
  assert.equal(viewer.sync.role, 'view');
  edit(viewer, value => { value.name = 'Forbidden'; });
  assert.equal((await viewer.next('error')).code, 'read_only'); assert.equal(f.state.saves, 0);
  viewer.send({ type: 'presence', state: { name: '<forged owner>', color: 'url(javascript:alert(1))', cursor: { x: Infinity, y: 1 }, mode: 'other', admin: true } });
  const presence = await a.next('presence');
  assert.deepEqual(presence.state, { name: 'Alice', color: '#6366f1', cursor: null, mode: 'structured' });
  assert.equal(presence.clientId, viewer.sync.clientId);
  await viewer.close(); assert.equal((await a.next('presence')).state, null); await a.close();
});

test('revocation immediately ends active sessions and is durable; invitation secrets are never stored', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  const closed = once(client.ws, 'close');
  await f.service.revokeInvite('board-a', invitation.id);
  assert.equal((await client.next('error')).code, 'revoked'); await closed;
  assert.equal((await session(f, invitation)).status, 403);
  const manifest = await readFile(path.join(f.directory, 'sharing.json'), 'utf8');
  assert.equal(manifest.includes(invitation.token), false);
  assert.equal((await stat(path.join(f.directory, 'sharing.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await f.service.listInvites('board-a'))[0].token, undefined);
  await f.restart(); assert.equal((await session(f, invitation)).status, 403);
});

test('public HTTP listener exposes only health/session; rejects untrusted origins, hosts and query credentials', async t => {
  const f = await fixture(t), invitation = await f.share();
  for (const route of ['/api/diagrams', '/api/diagrams/board-a', '/api/files', '/api/terminal', '/admin', '/v1/invites', '/v1/share', '/v1/forget', '/v1/session?token=secret', '/health?token=secret', '/%2e%2e/api/files']) {
    assert.equal((await fetch(`${f.url}${route}`, { headers: { Origin: ORIGIN } })).status, 404, route);
  }
  assert.equal((await fetch(`${f.url}/health`)).status, 200);
  const preflight = await fetch(`${f.url}/v1/session`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,ngrok-skip-browser-warning' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.ok(preflight.headers.get('access-control-allow-headers').includes('ngrok-skip-browser-warning'));
  const unsafePreflight = await fetch(`${f.url}/v1/session`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(unsafePreflight.status, 403);
  assert.equal((await session(f, invitation, {}, { Origin: 'https://evil.test' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.url}/health`, { headers: { Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await session(f, invitation, { boardId: 'board-other' })).status, 401);
  assert.equal((await session(f, invitation, { role: 'edit' })).status, 400);
  const noOrigin = await fetch(`${f.url}/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  for (const [route, origin, status] of [['/v1/sync?session=secret', ORIGIN, 404], ['/v1/sync', 'https://evil.test', 403], ['/api/diagrams', ORIGIN, 404]]) {
    const ws = new WebSocket(`${f.url.replace('http:', 'ws:')}${route}`, { origin });
    const response = await new Promise(resolve => { ws.on('unexpected-response', (_request, result) => { result.resume(); resolve(result.statusCode); }); ws.on('error', () => {}); });
    assert.equal(response, status); ws.terminate();
  }
});

test('shared icon endpoint requires trusted origin and a live session, including read-only viewers', async t => {
  const requests = [];
  const f = await fixture(t, { iconFetcher: async name => { requests.push(name); return '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10"/></svg>'; } });
  const invitation = await f.share('view'), credential = await session(f, invitation);
  const headers = { Origin: ORIGIN, Authorization: `Bearer ${credential.session}` };
  let response = await fetch(f.url + '/v1/icons/aws-ec2', { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match((await response.json()).svg, /<svg/); assert.deepEqual(requests, ['aws-ec2']);
  assert.equal((await fetch(f.url + '/v1/icons/aws-ec2', { headers: { Origin: ORIGIN } })).status, 401);
  assert.equal((await fetch(f.url + '/v1/icons/aws-ec2', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(f.url + '/v1/icons/aws-ec2?token=secret', { headers })).status, 404);
  assert.equal((await fetch(f.url + '/v1/icons/a%2fb', { headers })).status, 400);
  response = await fetch(f.url + '/v1/icons/aws-ec2', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,ngrok-skip-browser-warning' } });
  assert.equal(response.status, 204);
  await f.service.revokeInvite(invitation.boardId, invitation.id);
  assert.equal((await fetch(f.url + '/v1/icons/aws-ec2', { headers })).status, 403);
  assert.deepEqual(requests, ['aws-ec2']);
});

test('restart retains committed Yjs state and invites, but never persists ephemeral sessions', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  await f.service.configure({ publicUrl: 'https://tunnel.example.test' });
  const owner = await f.service.ownerSession('board-a'); assert.equal(owner.role, 'edit'); assert.equal(owner.endpoint, f.url);
  assert.equal((await f.service.ownerSession('board-a')).storageIdentity, owner.storageIdentity);
  edit(client, value => { value.name = 'Saved across restart'; }); await client.next('ack'); await client.close();
  await f.restart();
  assert.equal((await f.service.ownerSession('board-a')).storageIdentity, owner.storageIdentity);
  const old = await connect(f, owner); assert.equal((await old.next('error')).code, 'unauthorized'); await old.close();
  const restored = await joined(f, invitation);
  assert.equal(readBoardDoc(restored.doc).name, 'Saved across restart'); assert.equal(restored.sync.board.revision, 2);
  edit(restored, value => { value.snapshot.structured.nodes[0].position.y = 999; }, 'after-restart');
  await restored.next('ack'); assert.equal(f.state.board.revision, 3); await restored.close();
  await f.service.stopSharing('board-a'); await f.service.share(f.state.board);
  assert.notEqual((await f.service.ownerSession('board-a')).storageIdentity, owner.storageIdentity);
});

test('external revisions and archived/deleted boards freeze sharing without overwriting local changes', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  f.state.board.name = 'Independent local edit'; f.state.board.revision++;
  edit(client, value => { value.name = 'Stale remote edit'; });
  assert.equal((await client.next('error')).code, 'conflict'); assert.equal(f.state.saves, 0); assert.equal(f.state.board.name, 'Independent local edit');
  await client.close(); await f.restart(); assert.equal(f.service.status().boards[0].frozen, 'conflict');
  assert.equal((await session(f, invitation)).status, 409);
  await f.service.stopSharing('board-a'); f.state.board.archived = true;
  await assert.rejects(f.service.share(f.state.board), /active board/);
  f.state.board.archived = false; await f.service.share(f.state.board);
  const next = await f.service.createInvite('board-a', { role: 'edit' }), active = await joined(f, next);
  f.state.board = null; edit(active, value => { value.name = 'Deleted'; });
  assert.equal((await active.next('error')).code, 'unavailable'); assert.equal(f.state.saves, 0); await active.close();
});

test('backend failure sends no ACK or peer update; restart reconciles a definitely uncommitted journal', async t => {
  const f = await fixture(t), invitation = await f.share(), a = await joined(f, invitation), b = await joined(f, invitation);
  f.state.save = async () => { throw new Error('simulated local disk outage'); };
  edit(a, value => { value.name = 'Must not ACK'; });
  assert.equal((await a.next('error')).code, 'persistence_failed'); await wait(20);
  assert.equal(a.messages.some(message => message.type === 'ack'), false); assert.equal(b.messages.some(message => message.type === 'update'), false);
  assert.equal(f.state.board.name, 'Team board'); await a.close(); await b.close();
  f.state.save = null; await f.restart();
  const restored = await joined(f, invitation); assert.equal(readBoardDoc(restored.doc).name, 'Team board'); await restored.close();
});

test('restart recovers an ambiguous save only when the local revision and content match its durable journal', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  f.state.save = async (candidate, revision) => { f.state.board = { ...copy(candidate), revision: revision + 1 }; throw new Error('response lost after save'); };
  edit(client, value => { value.name = 'Committed before transport failed'; });
  assert.equal((await client.next('error')).code, 'persistence_failed'); await client.close();
  f.state.save = null; await f.restart(); const recovered = await joined(f, invitation);
  assert.equal(readBoardDoc(recovered.doc).name, 'Committed before transport failed'); assert.equal(recovered.sync.board.revision, 2); await recovered.close();
});

test('journal failure prevents backend writes and successful acknowledgements', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  const journal = path.join(f.directory, 'board-board-a.json');
  await unlink(journal); await mkdir(journal);
  edit(client, value => { value.name = 'Cannot persist'; });
  assert.equal((await client.next('error')).code, 'persistence_failed'); assert.equal(f.state.saves, 0); assert.equal(client.messages.some(message => message.type === 'ack'), false); await client.close();
});

test('malformed, cross-board, and extra-root updates never change or persist the authoritative board', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  client.send({ type: 'update', id: 'malformed', update: Buffer.from('not yjs').toString('base64') });
  assert.equal((await client.next('error')).code, 'invalid_update');
  let vector = Y.encodeStateVector(client.doc); client.doc.getMap('board').set('id', 'board-other');
  client.send({ type: 'update', id: 'cross-board', update: Buffer.from(Y.encodeStateAsUpdate(client.doc, vector)).toString('base64') });
  assert.equal((await client.next('error')).code, 'invalid_update');
  const clean = createBoardDoc(); Y.applyUpdate(clean, Buffer.from(client.sync.update, 'base64')); vector = Y.encodeStateVector(clean); clean.getMap('terminal').set('command', 'no');
  client.send({ type: 'update', id: 'extra-root', update: Buffer.from(Y.encodeStateAsUpdate(clean, vector)).toString('base64') });
  assert.equal((await client.next('error')).code, 'invalid_update'); assert.equal(f.state.saves, 0); assert.equal(f.state.board.name, 'Team board'); await client.close();
});

test('expiry disconnects active editors and stopping sharing invalidates every prior invitation/session', async t => {
  const f = await fixture(t), invitation = await f.share('edit'), client = await joined(f, invitation);
  const originalNow = Date.now;
  const shiftedNow = t.mock.method(Date, 'now', () => originalNow() + 25 * 3600000);
  const closed = once(client.ws, 'close');
  assert.equal((await client.next('error', message => message.code === 'expired', 2500)).code, 'expired'); await closed;
  assert.equal((await session(f, invitation)).status, 401);
  shiftedNow.mock.restore();
  const next = await f.service.createInvite('board-a', { role: 'edit' }), editor = await joined(f, next), owner = await f.service.ownerSession('board-a');
  await f.service.stopSharing('board-a'); assert.equal((await editor.next('error')).code, 'revoked'); await editor.close();
  assert.equal((await session(f, next)).status, 401);
  await f.service.share(f.state.board); const stale = await connect(f, owner); assert.equal((await stale.next('error')).code, 'revoked'); await stale.close();
});

test('unauthenticated sockets are rejected after five seconds', async t => {
  const f = await fixture(t), ws = new WebSocket(`${f.url.replace('http:', 'ws:')}/v1/sync`, { origin: ORIGIN });
  const messages = []; ws.on('message', data => messages.push(JSON.parse(data.toString()))); ws.on('error', () => {});
  await once(ws, 'close'); assert.equal(messages[0].code, 'unauthorized');
});

test('forget revokes active invitations and sessions and removes only the selected board journal', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation), owner = await f.service.ownerSession('board-a');
  const closed = once(client.ws, 'close');
  assert.deepEqual(await f.service.forget('board-a'), { boardId: 'board-a', shared: false, forgotten: true });
  assert.equal((await client.next('error')).code, 'revoked'); await closed;
  assert.equal((await session(f, invitation)).status, 401);
  await assert.rejects(stat(path.join(f.directory, 'board-board-a.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'sharing.json'), 'utf8')).boards['board-a'], undefined);
  assert.deepEqual(f.service.status().boards, []); assert.deepEqual(await f.service.listInvites('board-a'), []);
  const replay = await connect(f, owner); assert.equal((await replay.next('error')).code, 'unauthorized'); await replay.close();
  assert.equal(f.state.board.name, 'Team board', 'forget purges collaboration data; the caller separately deletes the Java board');
  await f.restart(); assert.deepEqual(f.service.status().boards, []); assert.equal((await session(f, invitation)).status, 401);
  await assert.rejects(f.service.forget('../sharing'), /identifier/);
});

test('forget also purges a previously stopped board after restart and is safely repeatable', async t => {
  const f = await fixture(t), invitation = await f.share();
  await f.service.stopSharing('board-a'); await f.restart();
  assert.deepEqual(f.service.status().boards, [], 'stopped journals are not loaded into active document memory');
  assert.ok(await stat(path.join(f.directory, 'board-board-a.json')));
  await f.service.forget('board-a'); await f.service.forget('board-a');
  await assert.rejects(stat(path.join(f.directory, 'board-board-a.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'sharing.json'), 'utf8')).boards['board-a'], undefined);
  assert.equal((await session(f, invitation)).status, 401);
});

test('forget drains an in-flight save before removing its journal so a late write cannot recreate deleted data', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.state.save = async (candidate, revision) => { entered(); await gate; f.state.board = { ...copy(candidate), revision: revision + 1 }; return copy(f.state.board); };
  edit(client, value => { value.name = 'Save already in flight'; }); await started;
  let finished = false; const purge = f.service.forget('board-a').then(result => { finished = true; return result; });
  assert.equal((await client.next('error')).code, 'revoked'); assert.equal(finished, false);
  assert.ok(await stat(path.join(f.directory, 'board-board-a.json')));
  release(); await purge;
  await assert.rejects(stat(path.join(f.directory, 'board-board-a.json')), { code: 'ENOENT' });
  assert.equal(client.messages.some(message => message.type === 'ack'), false); await client.close();
});

test('a failed forget reports the purge failure while retaining durable revocation and allows a retry', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  const journal = path.join(f.directory, 'board-board-a.json'); await unlink(journal); await mkdir(journal);
  await assert.rejects(f.service.forget('board-a'), cause => cause.code === 'purge_failed' && /cancelled/.test(cause.message));
  assert.equal((await client.next('error')).code, 'revoked'); await client.close();
  assert.equal((await session(f, invitation)).status, 401); assert.equal(f.service.status().boards[0].shared, false);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'sharing.json'), 'utf8')).boards['board-a'].shared, false);
  assert.equal((await stat(journal)).isDirectory(), true, 'failed unlink must not claim the journal was removed');
  await rm(journal, { recursive: true }); await f.service.forget('board-a');
  assert.deepEqual(f.service.status().boards, []);
});

test('archiving a board freezes sharing without automatically purging its recoverable journal', async t => {
  const f = await fixture(t), invitation = await f.share();
  f.state.board.archived = true; f.state.board.revision++;
  assert.equal((await session(f, invitation)).status, 409);
  assert.ok(await stat(path.join(f.directory, 'board-board-a.json')));
  assert.ok(JSON.parse(await readFile(path.join(f.directory, 'sharing.json'), 'utf8')).boards['board-a']);
});

test('session and socket rate limits reject floods without changing a board', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  const closed = once(client.ws, 'close');
  for (let index = 0; index < 121; index++) client.send({ type: 'ping' });
  assert.equal((await client.next('error')).code, 'rate_limited'); await closed;
  let last;
  for (let index = 0; index < 41; index++) last = await session(f, invitation, { token: 'invalid' });
  assert.equal(last.status, 429); assert.equal(f.state.saves, 0);
});

test('oversized socket packets are closed before decoding or persistence', async t => {
  const f = await fixture(t), invitation = await f.share(), client = await joined(f, invitation);
  const closed = once(client.ws, 'close');
  client.ws.send('x'.repeat(14 * 1024 * 1024 + 1));
  assert.equal((await closed)[0], 1009); assert.equal(f.state.saves, 0);
});

test('connections are capped before unauthenticated peers can consume unlimited slots', async t => {
  const f = await fixture(t), sockets = [];
  for (let index = 0; index < 32; index++) {
    const ws = new WebSocket(`${f.url.replace('http:', 'ws:')}/v1/sync`, { origin: ORIGIN });
    ws.on('error', () => {}); await once(ws, 'open'); sockets.push(ws);
  }
  const blocked = new WebSocket(`${f.url.replace('http:', 'ws:')}/v1/sync`, { origin: ORIGIN });
  const status = await new Promise(resolve => { blocked.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); }); blocked.on('error', () => {}); });
  assert.equal(status, 503); blocked.terminate(); for (const ws of sockets) ws.terminate();
});

test('standalone CLI manages invitations through trusted stdin with no public administrative route', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-canvas-cli-test-')), localBoard = board();
  const backend = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/api/diagrams/board-a') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(localBoard));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../canvas-server/cli.mjs', import.meta.url)), '--share', 'board-a', '--invite', 'view'], {
    env: { ...process.env, CANVAS_DATA_DIR: directory, CANVAS_PORT: '0', CANVAS_BACKEND_URL: `http://127.0.0.1:${backend.address().port}`, CANVAS_PUBLIC_URL: 'https://tunnel.example.test', CANVAS_FRONTEND_URL: ORIGIN },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending = '', errors = '';
  const output = [], listeners = new Set();
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  child.stdout.on('data', chunk => {
    pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) { if (line.startsWith('{')) output.push(JSON.parse(line)); }
    for (const check of [...listeners]) check();
  });
  const next = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`CLI response timed out: ${errors}`)); }, 10000);
    const check = () => { const index = output.findIndex(predicate); if (index >= 0) { clearTimeout(timer); listeners.delete(check); resolve(output.splice(index, 1)[0]); } };
    listeners.add(check); check();
  });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } await new Promise(resolve => backend.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const invitation = await next(value => value.token);
  assert.equal(invitation.role, 'view'); assert.equal(new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('invite'), invitation.token);
  child.stdin.write(`${JSON.stringify({ action: 'status' })}\n`);
  const status = (await next(value => value.action === 'status')).result;
  assert.equal((await fetch(`http://127.0.0.1:${status.port}/admin`)).status, 404);
  child.stdin.write(`${JSON.stringify({ action: 'revoke', boardId: 'board-a', inviteId: invitation.id })}\n`);
  assert.ok((await next(value => value.action === 'revoke')).result.revokedAt);
  child.stdin.write(`${JSON.stringify({ action: 'stop', boardId: 'board-a' })}\n`);
  assert.equal((await next(value => value.action === 'stop')).result.shared, false);
});
