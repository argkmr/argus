import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createPromptNotesStore, createTaskPromptNotes, promptNotesKey, validatePromptNotes, promptNoteRows, sentPromptNotesMarkup } from '../public/task-prompt-notes.mjs';

const note = (text = 'Run the tests', enabled = true) => ({ id: 'note-one', text, enabled });
const repo = { scope: 'repository', repositoryId: 'repo-one', taskId: 'task-one' };
const nexus = { scope: 'global', repositoryId: 'global', taskId: 'nexus-one' };
const task = (context = repo, notes = [note()], updatedAt = '2026-09-14T12:00:00Z') => ({ id: context.taskId, repositoryId: context.repositoryId, promptNotes: notes, updatedAt });
const storage = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }; };

test('task keys isolate repositories, task IDs and Nexus; drafts do not share defaults', () => {
  const store = createPromptNotesStore();
  store.ingest(repo, task());
  for (const context of [nexus, { ...repo, taskId: 'task-two' }, { ...repo, repositoryId: 'repo-two' }, { ...repo, taskId: null }]) {
    assert.notEqual(promptNotesKey(context), promptNotesKey(repo));
    assert.deepEqual(store.view(context).effective, []);
  }
});

test('unknown existing task defaults defer to backend, not an explicit false empty override', () => {
  const store = createPromptNotesStore();
  assert.deepEqual(store.capture(repo).request, {});
  store.ingest(repo, task());
  assert.deepEqual(store.capture(repo).request, { promptNotes: [note()] });
  store.override(repo, []);
  assert.deepEqual(store.capture(repo).request, { promptNotes: [] });
});

test('one-prompt edits and disabling do not change defaults; successful send resets only its override', () => {
  const store = createPromptNotesStore(); store.ingest(repo, task());
  store.override(repo, [note('One-off', false)]);
  const captured = store.capture(repo);
  assert.deepEqual(store.view(repo).defaults, [note()]);
  store.submitted(captured, repo.taskId);
  assert.deepEqual(store.view(repo).effective, [note()]);
  assert.deepEqual(captured.request.promptNotes, [note('One-off', false)]);
});

test('editing notes while a request is in flight preserves the next-prompt override', () => {
  const store = createPromptNotesStore(); store.ingest(repo, task());
  store.override(repo, [note('First')]); const captured = store.capture(repo);
  store.override(repo, [note('Next')]); store.submitted(captured, repo.taskId);
  assert.deepEqual(store.view(repo).effective, [note('Next')]);
  assert.deepEqual(captured.request.promptNotes, [note('First')]);
});

test('saving or permanently deleting defaults cannot mutate captured/queued snapshots', () => {
  const store = createPromptNotesStore(); store.ingest(repo, task());
  const captured = store.capture(repo);
  store.save(repo, [], task(repo, [], '2026-09-14T12:01:00Z'));
  assert.deepEqual(store.view(repo).effective, []);
  assert.deepEqual(captured.request.promptNotes, [note()]);
  store.ingest(repo, task());
  assert.deepEqual(store.view(repo).defaults, [], 'old polling response cannot resurrect a removed default');
});

test('new task can send an override while saving different defaults, then resets next new draft', () => {
  const store = createPromptNotesStore(), draft = { ...repo, taskId: null };
  store.save(draft, [note('Default')]); store.override(draft, [note('Once')]);
  const captured = store.capture(draft);
  assert.deepEqual(captured.request, { promptNotes: [note('Once')], taskPromptNotes: [note('Default')] });
  store.submitted(captured, 'created-task');
  assert.deepEqual(store.view({ ...repo, taskId: 'created-task' }).defaults, [note('Default')]);
  assert.deepEqual(store.view(draft).effective, []);
});

test('first-send acceptance migrates newer draft overrides into the created task, consuming only the sent override', () => {
  for (const base of [repo, nexus]) {
    const store = createPromptNotesStore(), draft = { ...base, taskId: null }, created = { ...base, taskId: 'created' };
    store.save(draft, [note('Default')]); store.override(draft, [note('Sent once')]);
    const captured = store.capture(draft);
    store.override(draft, [note('Next prompt')]);
    store.submitted(captured, created.taskId);
    assert.deepEqual(store.view(created).effective, [note('Next prompt')]);
    assert.deepEqual(store.view(created).defaults, [note('Default')]);
    assert.deepEqual(store.view(draft).effective, []);
    assert.deepEqual(captured.request.promptNotes, [note('Sent once')]);
  }
});

test('changed draft defaults become pending durable task defaults; stale polling and save acknowledgements cannot overwrite newer edits', () => {
  const store = createPromptNotesStore(), draft = { ...repo, taskId: null }, created = { ...repo, taskId: 'created' };
  store.save(draft, [note('Original')]); const captured = store.capture(draft);
  store.save(draft, [note('New defaults')]); store.override(draft, [note('One-off next')]);
  const migration = store.submitted(captured, created.taskId);
  assert.deepEqual(migration.pendingDefaults.notes, [note('New defaults')]);
  store.ingest(created, task(created, [note('Original')]));
  assert.deepEqual(store.view(created).defaults, [note('New defaults')]);
  const newer = store.stageDefaults(created, [note('Newer defaults')]);
  store.override(created, [note('Newest one-off')]);
  assert.equal(store.acknowledgeDefaults(migration.pendingDefaults, task(created, [note('New defaults')])), false);
  assert.deepEqual(store.view(created).defaults, [note('Newer defaults')]);
  assert.equal(store.acknowledgeDefaults(newer, task(created, [note('Newer defaults')])), true);
  assert.deepEqual(store.view(created).effective, [note('Newest one-off')]);
  assert.equal(store.view(created).pendingDefaults, false);
});

test('explicitly reset/new drafts reject old captures and cannot inherit their late acceptance', () => {
  const store = createPromptNotesStore(), draft = { ...repo, taskId: null };
  store.save(draft, [note('Old draft')]); const captured = store.capture(draft);
  store.resetDraft(draft); store.save(draft, [note('Replacement draft')]);
  assert.equal(store.submitted(captured, 'old-created-task'), null);
  assert.deepEqual(store.view(draft).defaults, [note('Replacement draft')]);
  assert.equal(store.view({ ...repo, taskId: 'old-created-task' }).known, false);
});

test('a newer edit made directly in the created task wins over delayed draft promotion', () => {
  const store = createPromptNotesStore(), draft = { ...repo, taskId: null }, created = { ...repo, taskId: 'created' };
  store.save(draft, [note('Draft')]); const captured = store.capture(draft);
  store.override(draft, [note('Draft next')]);
  store.save(created, [note('Created task defaults')], task(created));
  store.override(created, [note('Created next')]);
  store.submitted(captured, created.taskId);
  assert.deepEqual(store.view(created).effective, [note('Created next')]);
  assert.deepEqual(store.view(created).defaults, [note('Created task defaults')]);
});

test('pending migrated defaults survive reload and do not get replaced by older persisted task defaults', () => {
  const disk = storage(), store = createPromptNotesStore(disk), draft = { ...nexus, taskId: null }, created = { ...nexus, taskId: 'created' };
  const captured = store.capture(draft); store.save(draft, [note('Keep pending')]);
  store.submitted(captured, created.taskId);
  const restored = createPromptNotesStore(disk);
  restored.ingest(created, task(created, []));
  assert.deepEqual(restored.view(created).defaults, [note('Keep pending')]);
  assert.deepEqual(restored.pendingDefaults(created).notes, [note('Keep pending')]);
});

test('task timestamps compare chronologically with variable precision, nanoseconds and timezone offsets', () => {
  const store = createPromptNotesStore();
  for (const [index, timestamp] of [
    '2026-09-14T12:00:00Z', '2026-09-14T12:00:00.1Z', '2026-09-14T12:00:00.11Z',
    '2026-09-14T12:00:00.110001Z', '2026-09-14T12:00:00.110001001Z', '2026-09-14T17:30:00.110001002+05:30',
  ].entries()) {
    store.ingest(repo, task(repo, [note(`Version ${index}`)], timestamp));
    assert.equal(store.view(repo).defaults[0].text, `Version ${index}`);
  }
  store.ingest(repo, task(repo, [note('Stale by one nanosecond')], '2026-09-14T12:00:00.110001001Z'));
  assert.equal(store.view(repo).defaults[0].text, 'Version 5');
});

function notesUI(saveTask = async (context, notes) => task(context, notes)) {
  const elements = new Map(), errors = [], disk = storage();
  let context = { ...repo, taskId: null }, dialog;
  class Element {
    constructor(selector) { this.selector = selector; this.listeners = new Map(); this.dataset = {}; this.children = []; this.isConnected = true; this.open = false; }
    set innerHTML(value) { this.html = value; if (this.selector === '.task-note-rows') this.children = [...value.matchAll(/<article[^>]*data-note-id="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(([,id,body]) => row({ id, enabled: /data-note-enabled checked/.test(body), text: body.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1] || '' })); }
    get innerHTML() { return this.html || ''; }
    querySelector(selector) { return element(selector); }
    querySelectorAll(selector) { return selector === '[data-note-id]' ? this.children : []; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, target = this) { return this.listeners.get(type)?.({ target, preventDefault() {} }); }
    setAttribute() {} focus() { this.focused = true; } showModal() { this.open = true; } close() { this.open = false; }
    append(child) { this.children.push(child); if (child.selector === 'dialog') dialog = child; }
  }
  function element(selector) { if (!elements.has(selector)) elements.set(selector, new Element(selector)); return elements.get(selector); }
  function row(note) {
    const fields = {
      '[data-note-text]': { value: note.text, setAttribute() {} },
      '[data-note-enabled]': { checked: note.enabled },
      '[data-remove-note]': { setAttribute() {} },
      label: { lastChild: { textContent: '' } },
    };
    return { dataset: { noteId: note.id }, querySelector: selector => fields[selector] };
  }
  const document = { querySelector: element, createElement: tag => new Element(tag), body: element('body') };
  const component = createTaskPromptNotes({ document, storage: disk, getContext: scope => ({ ...context, scope, repositoryId: scope === 'global' ? 'global' : context.repositoryId }), loadTask: async id => task({ ...context, taskId: id }), saveTask, onError: error => errors.push(error.message) });
  return {
    component, errors, elements, element, disk,
    context: () => context,
    promote(id = 'created') { context = { ...context, taskId: id }; },
    edit(notes) { element('.task-note-rows').children = notes.map(row); },
    open: (scope = 'repository') => component.open(scope, element('opener')),
    save: () => element('form').emit('submit'), use: () => element('[data-use-notes]').emit('click'),
    dialog: () => dialog,
    retry: () => element('#repository-task-notes').emit('click', { closest: selector => selector === '[data-retry-task-notes]' ? {} : null }),
  };
}

test('collapsed composer context can summarize effective notes without exposing note text', async () => {
  for (const scope of ['repository', 'global']) {
    const h = notesUI();
    h.component.render(scope);
    const host = h.element(`#${scope === 'global' ? 'global' : 'repository'}-task-notes`);
    assert.deepEqual(host.dataset, { enabledNoteCount: '0', noteCount: '0', noteOverride: 'false' });
    await h.open(scope); h.edit([note('Private instruction'), { ...note('Not enabled', false), id: 'note-two' }]); await h.use();
    assert.deepEqual(host.dataset, { enabledNoteCount: '1', noteCount: '2', noteOverride: 'true' });
    assert.doesNotMatch(JSON.stringify(host.dataset), /Private instruction|Not enabled/);
  }
});

test('notes return focus to the context trigger when their popover has closed in either composer', async () => {
  for (const scope of ['repository', 'global']) {
    const h = notesUI(), summary = h.element('context-summary'), opener = h.element('opener');
    opener.closest = selector => selector === '.composer-context-menu' ? { querySelector: () => summary } : null;
    opener.checkVisibility = () => false;
    h.element('[data-edit-task-notes]').checkVisibility = () => false;
    await h.open(scope); await h.use();
    assert.equal(summary.focused, true);
    assert.equal(opener.focused, undefined);
    assert.equal(h.element('[data-edit-task-notes]').focused, undefined);
  }
});

test('notes focus their replacement button when context remains visible after applying', async () => {
  const h = notesUI(), opener = h.element('opener');
  await h.open(); opener.isConnected = false; await h.use();
  assert.equal(h.element('[data-edit-task-notes]').focused, true);
  assert.equal(opener.focused, undefined);
});

test('an open first-draft modal rebinds to the created task without replacing its unsaved fields', async () => {
  const saves = [], h = notesUI(async (context, notes) => { saves.push({ context, notes }); return task(context, notes); });
  const captured = h.component.capture('repository');
  await h.open(); h.edit([note('Typed while preparing')]);
  h.promote(); await h.component.submitted(captured, 'created');
  await h.save();
  assert.equal(saves.length, 1); assert.equal(saves[0].context.taskId, 'created');
  assert.deepEqual(saves[0].notes, [note('Typed while preparing')]);
  assert.equal(h.dialog().open, false);
});

test('saved defaults changed during first preparation persist into the task and serialize before newer modal saves', async () => {
  const saves = []; let release;
  const h = notesUI((context, notes) => { saves.push({ context, notes }); return saves.length === 1 ? new Promise(resolve => { release = () => resolve(task(context, notes)); }) : Promise.resolve(task(context, notes)); });
  await h.open(); h.edit([note('Original')]); await h.save();
  const captured = h.component.capture('repository');
  await h.open(); h.edit([note('Changed during preparation')]); await h.save();
  h.promote(); const promoted = h.component.submitted(captured, 'created');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(saves.length, 1); assert.equal(saves[0].context.taskId, 'created');
  await h.open(); h.edit([note('Newest saved defaults')]); const newerSave = h.save();
  assert.equal(saves.length, 1, 'newer save waits for the in-flight migration write');
  release(); await promoted; await newerSave;
  assert.equal(saves.length, 2); assert.deepEqual(saves[1].notes, [note('Newest saved defaults')]);
  assert.deepEqual(h.component.capture('repository').request.promptNotes, [note('Newest saved defaults')]);
});

test('failed migration stays visible and cached; explicit retry persists it without losing next-prompt edits', async () => {
  let fail = true; const saves = [];
  const h = notesUI(async (context, notes) => { saves.push({ context, notes }); if (fail) throw Error('offline'); return task(context, notes); });
  const captured = h.component.capture('repository');
  await h.open(); h.edit([note('Durable once online')]); await h.save();
  h.promote(); await h.component.submitted(captured, 'created');
  assert.match(h.errors[0], /kept locally/);
  assert.match(h.elements.get('#repository-task-notes').innerHTML, /Defaults not saved/);
  assert.match(h.elements.get('#repository-task-notes').innerHTML, /Retry save/);
  await h.open(); h.edit([note('Next prompt override')]); await h.use();
  fail = false; h.retry();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(saves.length, 2);
  assert.deepEqual(h.component.capture('repository').request.promptNotes, [note('Next prompt override')]);
});

test('reset draft generation prevents an old modal from applying notes to a replacement draft', async () => {
  const saves = [], h = notesUI(async (...args) => saves.push(args));
  const captured = h.component.capture('repository');
  await h.open(); h.edit([note('Old modal edit')]);
  h.component.resetDraft('repository');
  await h.component.submitted(captured, 'old-created');
  await h.save();
  assert.equal(saves.length, 0);
  assert.equal(h.dialog().open, true);
  assert.match(h.elements.get('.task-notes-error').textContent, /draft was replaced/);
  assert.deepEqual(h.component.capture('repository').request.promptNotes, []);
});

test('overrides and unsent draft defaults survive local reload; saved task defaults come from server', () => {
  const disk = storage(), first = createPromptNotesStore(disk), draft = { ...nexus, taskId: null };
  first.ingest(repo, task()); first.override(repo, [note('One-off')]); first.save(draft, [note('Draft')]);
  const next = createPromptNotesStore(disk);
  assert.deepEqual(next.view(repo).effective, [note('One-off')]);
  assert.equal(next.view(repo).known, false);
  next.ingest(repo, task()); next.resetOverride(repo);
  assert.deepEqual(next.view(repo).effective, [note()]);
  assert.deepEqual(next.view(draft).effective, [note('Draft')]);
  next.resetDraft(draft); assert.deepEqual(next.view(draft).effective, []);
});

test('invalid notes fail rather than truncating user instructions or inventing IDs', () => {
  for (const notes of [null, [note(' ')], [note('a\0b')], [note('a'.repeat(4001))], [note(), note()], [{ ...note(), id: '<id>' }], [{ ...note(), enabled: 'false' }], Array.from({ length: 21 }, (_, i) => ({ ...note(), id: `note-${i}` })), Array.from({ length: 6 }, (_, i) => ({ ...note('a'.repeat(4000)), id: `note-${i}` }))]) assert.throws(() => validatePromptNotes(notes));
  assert.deepEqual(validatePromptNotes([note('  valid\nnotes  ', false)]), [note('valid\nnotes', false)]);
});

test('notes markup escapes instructions and numbers newly added controls correctly', () => {
  const markup = promptNoteRows([note('<script>not executable</script>')], 3);
  assert.match(markup, /Note 4 text/); assert.match(markup, /Remove note 4/);
  assert.ok(!markup.includes('<script>'));
  assert.match(sentPromptNotesMarkup([note('<b>plain text</b>'), { ...note('off', false), id: 'two' }]), /1 instruction included/);
  assert.equal(sentPromptNotesMarkup(undefined), '');
});

test('notes modal opts out of the legacy full-screen dark overlay in both themes', async () => {
  const css = await fs.readFile(new URL('../public/task-prompt-notes.css', import.meta.url), 'utf8');
  const modal = css.match(/#task-notes-dialog\[open\]\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(modal, /height:\s*fit-content\s*!important/);
  assert.match(modal, /background:\s*var\(--surface\)\s*!important/);
  assert.match(modal, /backdrop-filter:\s*none\s*!important/);
  assert.match(css, /\.task-notes-bar\[hidden\]\s*\{\s*display:\s*none/);
});

test('both real composer run paths capture notes before sending and only consume on acceptance', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const [name, scope] of [['runAgent', 'repository'], ['runGlobalAgent', 'global']]) {
    const start = source.indexOf(`async function ${name}()`), end = source.indexOf('\n}\n', start);
    const body = source.slice(start, end);
    assert.match(body, new RegExp(`taskPromptNotes.capture\\("${scope}"\\)`));
    assert.match(body, /\.\.\.notesCapture.request/);
    assert.ok(body.indexOf('taskPromptNotes.submitted') > body.indexOf('catch (error)'));
  }
});
