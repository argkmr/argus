import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { emptySnapshot } from '../frontend/features/diagrams/diagram-model.mjs';

const source = await fs.readFile(new URL('../frontend/features/diagrams/useDiagramDocument.js', import.meta.url), 'utf8');
const executable = source.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '').replace(/\bexport\s+/g, '') + '\nglobalThis.readDiagramHook = useDiagramDocument;';
const clone = value => JSON.parse(JSON.stringify(value));
const board = (id, name = id, revision = 1) => ({ id, name, revision, schemaVersion: 1, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', archived: false, snapshot: emptySnapshot() });
const summary = ({ snapshot, ...document }) => document;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Like the repository's existing VM state harnesses, this executes the real hook
// with deterministic stable hook cells and deferred HTTP responses. No app, DOM,
// installed Electron session, local datastore, or real network is involved.
function harness() {
  const states = [], refs = [], effects = [], requests = [], timers = new Map(), listeners = new Map();
  let stateIndex = 0, refIndex = 0, effectIndex = 0, timerId = 0, initialRender = true;
  const storage = new Map(), document = { documentElement: { dataset: {} } };
  const context = vm.createContext({
    emptySnapshot,
    structuredClone,
    AbortController,
    document,
    console,
    window: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    queueMicrotask,
    useState: initial => {
      const index = stateIndex++;
      if (initialRender) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: initial => {
      const index = refIndex++;
      if (initialRender) refs[index] = { current: initial };
      return refs[index];
    },
    useEffect: callback => {
      const index = effectIndex++;
      if (initialRender) effects[index] = { callback, cleanup: null };
    },
    useCallback: callback => callback,
    useMemo: callback => callback(),
    fetch: (url, options = {}) => new Promise(resolve => {
      const request = {
        url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined,
        answered: false,
        reply(value, status = 200) {
          assert.equal(request.answered, false, 'a deferred response must only resolve once');
          request.answered = true;
          resolve({ ok: status >= 200 && status < 300, status, json: async () => clone(value) });
        },
      };
      requests.push(request);
    }),
  });
  vm.runInContext(executable, context, { filename: 'useDiagramDocument.js' });
  const render = () => {
    stateIndex = 0; refIndex = 0; effectIndex = 0;
    const result = context.readDiagramHook();
    initialRender = false;
    return result;
  };
  render();
  for (const effect of effects) effect.cleanup = effect.callback();
  return {
    render, requests, document, timers, storage,
    pending: (method, url) => requests.filter(request => !request.answered && request.method === method && (!url || request.url === url)),
    replayEffects() { for (const effect of effects) effect.cleanup?.(); for (const effect of effects) effect.cleanup = effect.callback(); },
    dispose() { for (const effect of effects) effect.cleanup?.(); },
    async load(document = board('a')) {
      const listing = requests.find(request => request.method === 'GET' && request.url.includes('?archived=true'));
      assert.ok(listing, 'hook requests an initial board list');
      listing.reply([summary(document)]);
      await settle();
      const detail = this.pending('GET', '/api/diagrams/' + document.id)[0];
      assert.ok(detail, 'hook opens the remembered or first board');
      detail.reply(document);
      await settle();
      return render();
    },
  };
}

test('deleting the active board drains autosave, uses its new revision and clears only its remembered ID', async () => {
  const h = harness();
  try {
    await h.load();
    h.storage.set('argus-diagram-last', 'a');
    h.render().change({ name: 'Latest local name' });
    const saving = h.render().flush();
    const deleting = h.render().remove(summary(board('a')));
    await settle();
    assert.equal(h.pending('DELETE').length, 0);
    assert.equal(h.render().busy, true);
    assert.equal(h.render().change({ name: 'Too late' }), false);
    h.pending('PUT')[0].reply(board('a', 'Latest local name', 2));
    await saving; await settle();
    const removal = h.pending('DELETE', '/api/diagrams/a/permanent?revision=2')[0];
    assert.ok(removal);
    removal.reply({}, 204);
    await settle();
    assert.equal(h.render().document, null);
    assert.equal(h.render().documents.length, 0);
    assert.equal(h.render().dirty, false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.storage.has('argus-diagram-last'), false);
    h.pending('GET', '/api/diagrams?archived=true')[0].reply([]);
    assert.equal(await deleting, true);
    assert.equal(h.render().status, 'Board deleted');
    assert.equal(h.render().busy, false);
    assert.equal(h.requests.filter(request => request.method === 'PUT').length, 1);
  } finally { h.dispose(); }
});

test('deleting an archived board keeps another board and its unsaved edits intact', async () => {
  const h = harness();
  try {
    await h.load();
    h.render().change({ name: 'Keep my unsaved draft' });
    h.storage.set('argus-diagram-last', 'a');
    const deleting = h.render().remove({ ...summary(board('b', 'Archive', 4)), archived: true });
    await settle();
    assert.equal(h.pending('PUT').length, 0);
    h.pending('DELETE', '/api/diagrams/b/permanent?revision=4')[0].reply({}, 204);
    await settle();
    h.pending('GET', '/api/diagrams?archived=true')[0].reply([summary(board('a'))]);
    assert.equal(await deleting, true);
    assert.equal(h.render().document.name, 'Keep my unsaved draft');
    assert.equal(h.render().dirty, true);
    assert.equal(h.storage.get('argus-diagram-last'), 'a');
    assert.equal(h.timers.size, 1);
  } finally { h.dispose(); }
});

test('failed or stale deletion leaves the board selected and does not clear local storage', async () => {
  for (const status of [409, 500]) {
    const h = harness();
    try {
      await h.load();
      h.storage.set('argus-diagram-last', 'a');
      const deleting = h.render().remove(summary(board('a')));
      await settle();
      h.pending('DELETE')[0].reply({ error: 'Could not delete this revision' }, status);
      assert.equal(await deleting, null);
      assert.equal(h.render().document.id, 'a');
      assert.equal(h.render().documents.length, 1);
      assert.equal(h.storage.get('argus-diagram-last'), 'a');
      assert.match(h.render().error, /Could not delete/);
      assert.equal(h.render().busy, false);
    } finally { h.dispose(); }
  }
});

test('a failed save prevents deletion and preserves the dirty draft', async () => {
  const h = harness();
  try {
    await h.load(); h.render().change({ name: 'Preserve conflict' });
    const deleting = h.render().remove(summary(board('a')));
    await settle(); h.pending('PUT')[0].reply({ error: 'Changed elsewhere' }, 409);
    await deleting;
    assert.equal(h.requests.some(request => request.method === 'DELETE'), false);
    assert.equal(h.render().dirty, true);
    assert.equal(h.render().document.name, 'Preserve conflict');
  } finally { h.dispose(); }
});

test('deletion remains successful when refresh fails and stale list responses cannot restore its row', async () => {
  const h = harness();
  try {
    await h.load();
    const oldListing = h.render().loadList();
    const stale = h.pending('GET', '/api/diagrams?archived=true')[0];
    const deleting = h.render().remove(summary(board('a')));
    await settle(); h.pending('DELETE')[0].reply({}, 204); await settle();
    stale.reply([summary(board('a'))]); await oldListing;
    assert.equal(h.render().documents.length, 0);
    h.pending('GET', '/api/diagrams?archived=true')[0].reply({ error: 'Offline' }, 500);
    assert.equal(await deleting, true);
    assert.equal(h.render().document, null);
    assert.match(h.render().error, /Board deleted.*refresh/);
  } finally { h.dispose(); }
});

test('autosave serializes rapid edits and concurrent flush callers using each returned revision', async () => {
  const h = harness();
  try {
    await h.load();
    h.render().change({ name: 'First edit' });
    const firstFlush = h.render().flush();
    await settle();
    const first = h.pending('PUT')[0];
    assert.equal(first.body.name, 'First edit');
    assert.equal(first.body.revision, 1);
    h.render().change({ name: 'Latest edit' });
    const secondFlush = h.render().flush();
    await settle();
    assert.equal(h.pending('PUT').length, 1, 'a second PUT must wait for revision acknowledgement');
    first.reply(board('a', 'First edit', 2));
    await settle();
    const second = h.pending('PUT')[0];
    assert.ok(second, 'edit during a save remains queued');
    assert.equal(second.body.name, 'Latest edit');
    assert.equal(second.body.revision, 2);
    assert.equal(h.render().dirty, true);
    second.reply(board('a', 'Latest edit', 3));
    await Promise.all([firstFlush, secondFlush]);
    assert.equal(h.render().document.name, 'Latest edit');
    assert.equal(h.render().document.revision, 3);
    assert.equal(h.render().dirty, false);
    assert.equal(h.document.documentElement.dataset.argusDiagramDirty, 'false');
  } finally { h.dispose(); }
});

test('a conflicting save retains the local draft and never advances the save revision', async () => {
  const h = harness();
  try {
    await h.load();
    h.render().change({ name: 'Keep this draft' });
    const saving = h.render().flush();
    await settle();
    h.pending('PUT')[0].reply({ error: 'Changed elsewhere' }, 409);
    await assert.rejects(saving);
    assert.equal(h.render().document.name, 'Keep this draft');
    assert.equal(h.render().document.revision, 1);
    assert.equal(h.render().dirty, true);
    assert.match(h.render().error, /draft|changed/i);
    assert.equal(h.pending('PUT').length, 0, 'conflicts must not blindly retry');
  } finally { h.dispose(); }
});

test('a late startup response cannot replace a board created during startup', async () => {
  const h = harness();
  try {
    h.pending('GET')[0].reply([summary(board('old'))]);
    await settle();
    const oldDetail = h.pending('GET', '/api/diagrams/old')[0];
    assert.ok(oldDetail);
    const creating = h.render().create('New board', emptySnapshot());
    await settle();
    const post = h.pending('POST')[0];
    if (!post) {
      // A synchronous transition gate may intentionally wait for initial loading.
      oldDetail.reply(board('old'));
      await settle();
      await creating;
      assert.equal(h.render().document.id, 'old');
      return;
    }
    post.reply(board('new', 'New board'), 201);
    await settle();
    for (const listing of h.pending('GET', '/api/diagrams?archived=true')) listing.reply([summary(board('new', 'New board'))]);
    await settle();
    await creating;
    assert.equal(h.render().document.id, 'new');
    oldDetail.reply(board('old'));
    await settle();
    assert.equal(h.render().document.id, 'new', 'a stale startup detail must not overwrite a new board');
  } finally { h.dispose(); }
});

test('effect replay ignores startup responses belonging to the cleaned-up effect', async () => {
  const h = harness();
  try {
    const originalList = h.pending('GET')[0];
    h.replayEffects();
    const currentList = h.pending('GET').at(-1);
    assert.notEqual(originalList, currentList);
    currentList.reply([summary(board('new'))]);
    await settle();
    h.pending('GET', '/api/diagrams/new')[0].reply(board('new'));
    await settle();
    originalList.reply([summary(board('old'))]);
    await settle();
    for (const staleDetail of h.pending('GET', '/api/diagrams/old')) staleDetail.reply(board('old'));
    await settle();
    assert.equal(h.render().document.id, 'new');
  } finally { h.dispose(); }
});

test('opening a board cannot silently discard an edit accepted while its detail is loading', async () => {
  const h = harness();
  try {
    await h.load();
    const opening = h.render().open('b');
    await settle();
    const detail = h.pending('GET', '/api/diagrams/b')[0];
    assert.ok(detail);
    h.render().change({ name: 'Typed during open' });
    const accepted = h.render().document.name === 'Typed during open';
    detail.reply(board('b'));
    await settle();
    for (const request of h.pending('PUT')) request.reply(board('a', request.body.name, request.body.revision + 1));
    await settle();
    await opening;
    if (accepted) {
      const preservedInCurrent = h.render().document?.id === 'a' && h.render().document.name === 'Typed during open';
      const preservedOnDisk = h.requests.some(request => request.method === 'PUT' && request.body.name === 'Typed during open' && request.answered);
      assert.ok(preservedInCurrent || preservedOnDisk, 'accepted changes must survive the transition');
    } else {
      assert.equal(h.render().document.id, 'b', 'an edit gate permits a clean transition');
    }
  } finally { h.dispose(); }
});

test('archiving a board cannot silently discard edits accepted during the delete request', async () => {
  const h = harness();
  try {
    await h.load();
    const archiving = h.render().archive();
    await settle();
    const deletion = h.pending('DELETE')[0];
    assert.ok(deletion);
    h.render().change({ name: 'Typed during archive' });
    const accepted = h.render().document.name === 'Typed during archive';
    deletion.reply({ ...summary(board('a', 'a', 2)), archived: true });
    await settle();
    for (const listing of h.pending('GET', '/api/diagrams?archived=true')) listing.reply([]);
    await settle();
    await archiving;
    if (accepted) {
      assert.equal(h.render().document?.name, 'Typed during archive', 'accepted edits need a recoverable draft after archiving');
      assert.equal(h.render().dirty, true);
    } else {
      assert.equal(h.render().document, null);
    }
  } finally { h.dispose(); }
});

test('an old board callback cannot write into a newly opened board', async () => {
  const h = harness();
  try {
    const old = await h.load();
    const opening = h.render().open('b');
    await settle();
    h.pending('GET', '/api/diagrams/b')[0].reply(board('b'));
    await opening;
    // The renderer must associate edit callbacks with the board that created them.
    old.change({ name: 'Stale A callback' }, 'a');
    assert.equal(h.render().document.id, 'b');
    assert.equal(h.render().document.name, 'b');
    assert.equal(h.render().dirty, false);
  } finally { h.dispose(); }
});

test('saving a conflict recovery copy never retries or overwrites the original board', async () => {
  const h = harness();
  try {
    await h.load();
    h.render().change({ name: 'Recover my draft' });
    const saving = h.render().flush();
    await settle();
    h.pending('PUT')[0].reply({ error: 'Changed elsewhere' }, 409);
    await assert.rejects(saving);
    const draft = h.render().document;
    const copying = h.render().create(draft.name + ' (copy)', draft.snapshot, true);
    await settle();
    const copy = h.pending('POST')[0];
    assert.ok(copy, 'recovery creates a separate document');
    assert.equal(copy.body.name, 'Recover my draft (copy)');
    assert.equal(h.requests.filter(request => request.method === 'PUT').length, 1);
    copy.reply({ ...board('copy', copy.body.name), snapshot: copy.body.snapshot }, 201);
    await settle();
    for (const listing of h.pending('GET', '/api/diagrams?archived=true')) {
      listing.reply([summary(board('a')), summary(board('copy', copy.body.name))]);
    }
    await copying;
    assert.equal(h.render().document.id, 'copy');
    assert.equal(h.render().document.name, 'Recover my draft (copy)');
    assert.equal(h.render().dirty, false);
    assert.equal(h.requests.filter(request => request.method === 'PUT').length, 1);
  } finally { h.dispose(); }
});
