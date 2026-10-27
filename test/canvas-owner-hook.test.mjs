import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { emptySnapshot } from '../frontend/features/diagrams/diagram-model.mjs';

const source = await fs.readFile(new URL('../frontend/features/diagrams/useOwnerCanvasSharing.jsx', import.meta.url), 'utf8');
const executable = source.replace(/^import\s+[^;]+;\s*$/gm, '').replace(/^    headerActions: .*$/m, '    headerActions: null, action,').replace(/\bexport\s+/g, '') + '\nglobalThis.ownerHook = useOwnerCanvasSharing;';
const clone = value => structuredClone(value);
const makeBoard = (id = 'a', revision = 1) => ({ id, name: 'Board ' + id, revision, snapshot: emptySnapshot() });
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness({ shared = true, supported = true, statusResponse, recoveryResponse, forgetError } = {}) {
  const states = [], refs = [], effects = [], clients = [], calls = [], listeners = new Map();
  let stateIndex = 0, refIndex = 0, effectIndex = 0, initial = true, latest;
  const local = {
    document: makeBoard(), documents: [makeBoard()], busy: false, dirty: false, status: 'Saved locally', error: '',
    adoptShared(next) { if (next.id !== local.document?.id) return false; local.document = clone(next); calls.push(['adopt', next.revision]); return true; },
    setError(message) { local.error = message; }, async flush() { calls.push(['local-flush']); },
    change(patch) { calls.push(['local-change']); local.document = { ...local.document, ...(typeof patch === 'function' ? patch(local.document) : patch) }; return true; },
    async loadList() { calls.push(['list']); },
    async open(id) { calls.push(['open', id]); local.document = makeBoard(id); return local.document; },
    async create(name, snapshot, copy) { calls.push(['create', name, clone(snapshot), copy]); local.document = { ...makeBoard('copy'), name, snapshot: clone(copy ? local.document.snapshot : snapshot) }; return local.document; },
    async archive() { calls.push(['archive', local.document.revision]); local.document = null; return true; },
    async remove(item) { calls.push(['remove', item.id, item.revision]); return true; },
  };
  class Client {
    constructor(options) { this.options = options; this.status = { state: 'syncing', role: 'edit' }; this.role = 'edit'; this.pendingCount = 0; this.canUndo = true; this.canRedo = true; clients.push(this); }
    async start() { calls.push(['start']); }
    async flush() { calls.push(['sync-flush']); if (this.flushResponse) return this.flushResponse.promise; if (this.status.terminal || this.offline) throw new Error('Offline'); }
    destroy() { this.destroyed = true; calls.push(['destroy']); }
    setBoard(previous, next) { if (this.rejectChange) throw new Error('Rejected edit'); this.board = clone(next); this.pendingCount++; this.options.onChange(next, { revision: previous.revision, remote: false }); this.emitStatus({ state: 'pending', pending: this.pendingCount }); }
    setPresence() {}
    undo() { if (!this.status.terminal && this.role !== 'view') calls.push(['undo']); }
    redo() { if (!this.status.terminal && this.role !== 'view') calls.push(['redo']); }
    exportDraft() { return clone(this.board); }
    emit(next = local.document, revision = next.revision) { this.board = clone(next); this.options.onChange(next, { revision, remote: true }); }
    emitStatus(value) { this.status = { ...this.status, ...value }; this.pendingCount = value.pending ?? this.pendingCount; this.options.onStatus(this.status); }
  }
  const context = vm.createContext({
    console, CanvasSyncClient: Client,
    window: {
      argusDesktop: supported ? { async canvasSharing(request) {
        calls.push(['ipc', request.action, request.boardId]);
        if (request.action === 'status') return statusResponse ? statusResponse.promise : { endpoint: 'http://127.0.0.1:4186', boards: shared ? [{ id: 'a', shared: true }] : [] };
        if (request.action === 'session') return { session: 'session', storageIdentity: 'epoch-owner' };
        if (request.action === 'stop') { shared = false; return {}; }
        if (request.action === 'share') { shared = true; return {}; }
        if (request.action === 'forget' && forgetError) throw new Error(forgetError);
        return {};
      } } : undefined,
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
    },
    document: { documentElement: { dataset: {} } },
    diagramApi: async (path, options = {}) => {
      calls.push(['api', options.method || 'GET', path, options.body && JSON.parse(options.body)]);
      if (options.method === 'POST') return recoveryResponse ? recoveryResponse.promise : { ...makeBoard('recovery'), name: JSON.parse(options.body).name };
      return makeBoard('a', 7);
    },
    useRef(value) { const index = refIndex++; if (initial) refs[index] = { current: value }; return refs[index]; },
    useState(value) { const index = stateIndex++; if (initial) states[index] = typeof value === 'function' ? value() : value; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useEffect(callback, deps) {
      const index = effectIndex++, prior = effects[index];
      const changed = !prior || !deps || deps.some((value, offset) => value !== prior.deps[offset]);
      if (changed) effects[index] = { callback, deps, cleanup: prior?.cleanup, pending: true };
    },
  });
  vm.runInContext(executable, context, { filename: 'useOwnerCanvasSharing.jsx' });
  function render() {
    stateIndex = refIndex = effectIndex = 0; latest = context.ownerHook(local); initial = false;
    for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.callback(); }
    return latest;
  }
  render();
  return { local, clients, calls, render, async connect() { await settle(); const client = clients.at(-1); assert.ok(client); client.emit(); client.emitStatus({ state: 'saved', pending: 0, revision: 1 }); return render(); }, dispose() { effects.forEach(effect => effect.cleanup?.()); } };
}

test('initial sharing lookup blocks stale editor writes and does not start local autosave', async () => {
  const status = deferred(), h = harness({ statusResponse: status });
  assert.equal(h.render().store.change({ name: 'During lookup' }), false);
  assert.equal(h.calls.some(call => call[0] === 'local-change'), false);
  status.resolve({ boards: [] }); await settle(); assert.equal(h.render().store.change({ name: 'Now local' }), true); h.dispose();
});

test('sharing locks edits while local saves finish and until the shared session loads', async () => {
  const h = harness({ shared: false }); await settle(); h.render(); const saving = deferred();
  h.local.flush = () => saving.promise;
  const sharing = h.render().action({ action: 'share' });
  assert.equal(h.render().store.change({ name: 'During share' }), false);
  saving.resolve(); await sharing;
  assert.equal(h.render().store.change({ name: 'Before initial sync' }), false);
  await settle(); const active = h.clients.at(-1); assert.ok(active); active.emit(); active.emitStatus({ state: 'saved', revision: 1 });
  assert.equal(h.render().store.change({ name: 'Shared edit' }), true); assert.equal(h.calls.some(call => call[0] === 'local-change'), false); h.dispose();
});

test('ACK revisions reach the owner board without a new document update', async () => {
  const h = harness(); await h.connect(); const client = h.clients[0];
  client.emitStatus({ state: 'saved', pending: 0, revision: 9 });
  assert.equal(h.render().store.document.revision, 9); assert.equal(h.local.document.revision, 9);
  client.emitStatus({ state: 'saved', pending: 0, revision: 8 }); assert.equal(h.render().store.document.revision, 9); h.dispose();
});

test('rejected edits restore the prior owner view and guarded undo cannot edit a frozen session', async () => {
  const h = harness(); await h.connect(); const client = h.clients[0]; client.rejectChange = true;
  assert.equal(h.render().store.change({ name: 'Rejected' }), false); assert.equal(h.render().store.document.name, 'Board a');
  client.emitStatus({ terminal: true, state: 'error' }); h.render().collaboration.onUndo(); h.render().collaboration.onRedo();
  assert.equal(h.calls.some(call => ['undo', 'redo'].includes(call[0])), false); assert.equal(h.render().collaboration.readOnly, true); h.dispose();
});

test('navigation waits for ACK and blocks edits during the wait', async () => {
  const h = harness(); await h.connect(); const client = h.clients[0]; client.flushResponse = deferred();
  const opening = h.render().store.open('b');
  assert.equal(h.render().store.change({ name: 'Late edit' }), false); assert.equal(h.calls.some(call => call[0] === 'open'), false);
  client.flushResponse.resolve(); await opening; h.render(); assert.equal(client.destroyed, true); assert.equal(h.render().store.document.id, 'b'); h.dispose();
});

test('late callbacks from a departed board cannot replace the newly opened board', async () => {
  const h = harness(); await h.connect(); const old = h.clients[0];
  await h.render().store.open('b'); h.render(); await settle();
  old.emit({ ...makeBoard('a'), name: 'Late stale update' }); old.emitStatus({ revision: 99 });
  assert.equal(h.render().store.document.id, 'b'); assert.equal(h.local.document.id, 'b'); h.dispose();
});

test('failed shared save can be recovered as a local copy without waiting for ACK', async () => {
  const h = harness(); await h.connect(); const client = h.clients[0];
  h.render().store.change({ name: 'Pending name' }); client.emitStatus({ terminal: true, state: 'error' });
  const copied = await h.render().store.create('Recovered copy', h.render().store.document.snapshot, true);
  assert.equal(copied.id, 'copy'); assert.equal(h.calls.some(call => call[0] === 'sync-flush'), false); h.render(); assert.equal(client.destroyed, true); h.dispose();
});

test('stopping a failed session confirms a durable recovery copy before revoking sharing', async () => {
  const recovery = deferred(), h = harness({ recoveryResponse: recovery }); await h.connect(); const client = h.clients[0];
  h.render().store.change({ name: 'Pending name' }); client.emitStatus({ terminal: true, state: 'error' });
  const stopping = h.render().action({ action: 'stop' }); await settle();
  assert.equal(h.calls.some(call => call[0] === 'api' && call[1] === 'POST'), true);
  assert.equal(h.calls.some(call => call[0] === 'ipc' && call[1] === 'stop'), false);
  recovery.resolve({ ...makeBoard('recovered'), name: 'Pending name — recovered draft' }); await stopping;
  assert.equal(h.calls.some(call => call[0] === 'ipc' && call[1] === 'stop'), true);
  assert.match(h.local.error, /preserved in/); assert.equal(h.local.document.revision, 7); assert.equal(client.destroyed, true); h.dispose();
});

test('a failed recovery copy leaves sharing and the exportable draft intact', async () => {
  const recovery = deferred(), h = harness({ recoveryResponse: recovery }); await h.connect(); const client = h.clients[0];
  h.render().store.change({ name: 'Keep me' }); client.emitStatus({ terminal: true, state: 'error' });
  const stopping = h.render().action({ action: 'stop' }); await settle(); recovery.reject(new Error('Disk unavailable'));
  await assert.rejects(stopping, /Disk unavailable/);
  assert.equal(h.calls.some(call => call[0] === 'ipc' && call[1] === 'stop'), false); assert.equal(client.destroyed, undefined); assert.equal(h.render().store.document.name, 'Keep me'); h.dispose();
});

test('archive stops sharing and uses the final disk revision', async () => {
  const h = harness(); await h.connect(); await h.render().store.archive();
  const stopIndex = h.calls.findIndex(call => call[0] === 'ipc' && call[1] === 'stop'), archiveIndex = h.calls.findIndex(call => call[0] === 'archive');
  assert.ok(stopIndex >= 0 && stopIndex < archiveIndex); assert.equal(h.calls[archiveIndex][1], 7);
  assert.equal(h.calls.some(call => call[0] === 'ipc' && call[1] === 'forget'), false); h.dispose();
});

test('inactive permanent deletion purges only its target without flushing the active draft', async () => {
  const h = harness(); await h.connect(); const client = h.clients[0];
  h.render().store.change({ name: 'Keep active draft' }); client.offline = true;
  const target = { ...makeBoard('archived-b', 4), archived: true };
  assert.equal(await h.render().store.remove(target), true);
  assert.equal(h.calls.some(call => call[0] === 'sync-flush'), false);
  const forget = h.calls.findIndex(call => call[0] === 'ipc' && call[1] === 'forget');
  const remove = h.calls.findIndex(call => call[0] === 'remove');
  assert.equal(h.calls[forget][2], 'archived-b'); assert.ok(forget < remove);
  assert.deepEqual(h.calls[remove], ['remove', 'archived-b', 4]);
  assert.equal(h.render().store.document.name, 'Keep active draft'); assert.equal(client.pendingCount, 1); assert.equal(client.destroyed, undefined); h.dispose();
});

test('current permanent deletion flushes, stops, purges and deletes the final saved revision', async () => {
  const h = harness(); await h.connect(); await h.render().store.remove(makeBoard('a'));
  const index = name => h.calls.findIndex(call => call[0] === 'ipc' && call[1] === name);
  const remove = h.calls.findIndex(call => call[0] === 'remove');
  assert.ok(h.calls.findIndex(call => call[0] === 'sync-flush') < index('stop'));
  assert.ok(index('stop') < index('forget') && index('forget') < remove);
  assert.equal(h.calls[index('forget')][2], 'a'); assert.deepEqual(h.calls[remove], ['remove', 'a', 7]); h.dispose();
});

test('failed journal purge prevents permanent deletion and leaves the active draft intact', async () => {
  const h = harness({ forgetError: 'Journal could not be removed' }); await h.connect();
  assert.equal(await h.render().store.remove(makeBoard('b')), null);
  assert.equal(h.calls.some(call => call[0] === 'remove'), false); assert.equal(h.local.document.id, 'a');
  assert.match(h.local.error, /Journal could not be removed/); h.dispose();
});

test('local-only editing remains available without desktop sharing support', () => {
  const h = harness({ supported: false }); assert.equal(h.render().store.change({ name: 'Local edit' }), true); assert.equal(h.local.document.name, 'Local edit'); h.dispose();
});
