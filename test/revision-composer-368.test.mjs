import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createPromptRevisionFlow } from '../public/prompt-revision-flow.mjs';
import { createPromptRevisionCoordinator } from '../public/prompt-revision-stop.mjs';
import { composerDraftFunctions } from './helpers/composer-draft-functions.mjs';

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function declaration(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(app);
  return app.slice(match.index, app.indexOf('\n}', match.index) + 2);
}
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness(scope) {
  const repositoryId = scope === 'global' ? 'global' : 'repo';
  const h = { calls: [], toasts: [], selection: { repositoryIds: ['repo'], expectedRepositoryIds: ['old'] }, selections: [], clears: [], scopeCalls: [], accepted: [], active: 'task', failRun: false };
  h.task = { id: 'task', scope, repositoryId, repositoryIds: ['repo'], provider: 'codex', model: 'saved-model', effort: 'high', speed: 'fast', mode: 'edit', contextMode: 'fresh', revisionCount: 2,
    revisionDraft: { prompt: 'Saved edit', runRequestId: 'persisted-id', promptNotes: [{ id: 'note', text: 'Retained note', enabled: true }], attachments: [{ id: 'saved-file', name: 'context.txt' }] }, messages: [{ id: 'prior', role: 'assistant', content: 'Previous reply' }] };
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: selector.endsWith('prompt') ? '  Saved edit\n' : '', dataset: {}, focus() {}, classList: { add() {}, remove() {} } });
    return elements.get(selector);
  };
  h.text = $(scope === 'global' ? '#global-agent-prompt' : '#agent-prompt');
  h.elements = elements;
  const state = h.state = { activeRepository: { id: 'repo' }, globalAttachments: [], repositoryAttachments: { repo: [] }, providers: [{ id: 'codex', name: 'Codex', authenticated: true }], repositorySubmissions: {}, promptQueueSaves: new Set(), promptQueueProcessors: new Set() };
  h.workspace = { repositories: [{ id: 'repo', name: 'Connected repository' }] };
  const context = h.context = vm.createContext({ document: {}, $, state, createPromptRevisionFlow, createPromptRevisionCoordinator,
    loadWorkspaceSnapshot: () => h.context.api('/api/workspace', { dedupe: false, cache: 'no-store' }),
    createRevisionScopePicker: () => async selection => { h.scopeCalls.push(clone(selection)); if (h.scopeWait) await h.scopeWait.promise; return h.selection; },
    crypto: { randomUUID: () => 'unused-new-id' }, activeTaskId: () => h.active,
    composerRepositoryId: () => scope === 'global' ? 'global' : state.activeRepository.id,
    providerCanRun: () => true, queuedPrompts: () => [],
    acceptPromptRevision: (_scope, task) => { h.accepted.push(clone(task)); return true; },
    scopedAttachments: () => scope === 'global' ? state.globalAttachments : state.repositoryAttachments.repo,
    resizeAgentComposer() {}, renderContextTray() {},
    toast: (...args) => h.toasts.push(args), refreshTasks: async () => {}, selectTask: async (...args) => h.selections.push(args),
    startQueuedPrompt: async (_scope, request) => {
      h.calls.push({ method: 'RUN', body: clone(request) });
      if (h.runWait) await h.runWait.promise;
      if (h.onRun) await h.onRun(request);
      if (h.failRun) throw Object.assign(new Error('Scope rejected'), { status: 400 });
      h.task.revisionOf = { runRequestId: request.requestId };
      delete h.task.revisionDraft;
      return { id: 'job', taskId: 'task' };
    },
    api: async (path, options = {}) => {
      h.calls.push({ path, ...clone(options) });
      if (path === '/api/workspace') return clone(h.workspace);
      if (!options.method && path === '/api/ai-tasks/task') { if (h.readWait) await h.readWait.promise; return clone(h.task); }
      if (path.includes('/api/prompt-queue?') || path.includes('/api/agents/jobs?')) return [];
      if (path.endsWith('/revision-draft') && options.method === 'PATCH') {
        assert.equal(options.body.expectedRunRequestId, h.task.revisionDraft.runRequestId);
        assert.equal(options.body.expectedPrompt, h.task.revisionDraft.prompt);
        const body = options.body;
        if (body.prompt !== h.task.revisionDraft.prompt || body.repositoryIds) h.task.revisionDraft.runRequestId = 'returned-rotated-id';
        h.task.revisionDraft.prompt = body.prompt;
        if (body.promptNotes) h.task.revisionDraft.promptNotes = clone(body.promptNotes);
        if (body.repositoryIds) h.task.repositoryIds = body.repositoryIds.length ? clone(body.repositoryIds) : h.workspace.repositories.map(repo => repo.id);
        return { task: clone(h.task), attachments: clone(h.task.revisionDraft.attachments) };
      }
      throw new Error(`Unexpected API ${options.method} ${path}`);
    },
  });
  state.repositoryDrafts = {};
  vm.runInContext(composerDraftFunctions.map(declaration).join('\n'), context);
  const takeDraft = context.takeComposerDraft;
  context.takeComposerDraft = scope => { h.clears.push(h.text.value); return takeDraft(scope); };
  const flowSource = app.slice(app.indexOf('const coordinatePromptRevision ='), app.indexOf('\nconst promptEditor ='));
  vm.runInContext(flowSource, context);
  h.retry = () => context.retryRevisionFromComposer(scope);
  h.run = () => scope === 'global' ? context.runGlobalAgent() : context.runAgent();
  vm.runInContext(['runAgent', 'runGlobalAgent'].map(declaration).join('\n'), context);
  return h;
}

for (const scope of ['global', 'repository']) {
  test(`${scope}: revision dispatch clears submitted text and files before its deferred response`, async () => {
    const h = harness(scope); h.runWait = deferred();
    const attachments = scope === 'global' ? h.state.globalAttachments : h.state.repositoryAttachments.repo;
    attachments.push({ id: 'saved-file' });
    const running = h.run();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.filter(call => call.method === 'RUN').length, 1);
    assert.equal(h.text.value, ''); assert.equal(attachments.length, 0);
    h.text.value = 'Newer prompt'; attachments.push({ id: 'new-file' });
    h.runWait.resolve(); await running;
    assert.equal(h.text.value, 'Newer prompt'); assert.equal(attachments[0].id, 'new-file');
  });

  for (const edited of [false, true]) test(`${scope}: composer retries pending ${edited ? 'changed' : 'unchanged'} prompt with returned identity, saved notes/files and same task`, async () => {
    const h = harness(scope); if (edited) h.text.value = 'Different revised text';
    await h.run();
    const patch = h.calls.find(call => call.method === 'PATCH');
    const run = h.calls.find(call => call.method === 'RUN');
    assert.equal(patch.body.expectedRevisionCount, 2);
    assert.equal(patch.body.expectedRunRequestId, 'persisted-id');
    assert.equal(run.body.requestId, edited ? 'returned-rotated-id' : 'persisted-id');
    assert.equal(run.body.taskId, 'task'); assert.equal(run.body.expectedRevisionCount, 2);
    assert.deepEqual(run.body.attachmentIds, ['saved-file']); assert.equal(run.body.promptNotes[0].text, 'Retained note');
    assert.equal(run.body.modelSettings.model, 'saved-model'); assert.equal(h.text.value, '');
    assert.equal(h.task.messages.length, 1, 'no duplicate optimistic/saved prompt');
    assert.equal(h.calls.some(call => call.method === 'DELETE' || call.path?.endsWith('/revisions')), false);
  });
  test(`${scope}: deterministic launch failure keeps captured draft, successful changed retry replaces pending prompt once`, async () => {
    const h = harness(scope); h.failRun = true;
    await h.run(); assert.equal(h.text.value, '  Saved edit\n'); assert.equal(h.clears.length, 1);
    assert.match(h.toasts.at(-1)[0], /response was not started/);
    h.failRun = false; h.text.value = 'Now explain variables'; await h.run();
    assert.equal(h.calls.filter(call => call.method === 'RUN').length, 2);
    assert.equal(h.calls.at(-1).body.requestId, 'returned-rotated-id');
    assert.equal(h.task.messages.length, 1); assert.equal(h.text.value, '');
  });
  test(`${scope}: new attachments and per-prompt note overrides get actionable guards without loss`, async () => {
    const h = harness(scope); const attachments = scope === 'global' ? h.state.globalAttachments : h.state.repositoryAttachments.repo;
    attachments.push({ id: 'new-file' }); await h.run();
    assert.equal(h.calls.filter(call => call.method).length, 0); assert.equal(attachments[0].id, 'new-file');
    assert.match(h.toasts.at(-1)[0], /Remove new composer attachments/);
    attachments.length = 0;
    h.elements.set(scope === 'global' ? '#global-task-notes' : '#repository-task-notes', { dataset: { noteOverride: 'true' } });
    await h.run(); assert.match(h.toasts.at(-1)[0], /saved notes/); assert.equal(h.text.value, '  Saved edit\n');
  });
  test(`${scope}: double send during fresh read or dispatch does not cancel, queue or send twice`, async () => {
    const h = harness(scope); h.readWait = deferred();
    const first = h.run(); const second = h.run(); await second;
    assert.equal(h.calls.length, 1); h.readWait.resolve(); await first;
    assert.equal(h.calls.filter(call => call.method === 'RUN').length, 1);
    assert.equal(h.calls.some(call => call.method === 'DELETE'), false);
  });
  test(`${scope}: navigation and newer text during preflight/launch stay untouched`, async () => {
    const h = harness(scope); h.readWait = deferred();
    const first = h.run(); h.active = 'another-task'; h.readWait.resolve(); await first;
    assert.equal(h.calls.filter(call => call.method).length, 0); assert.equal(h.text.value, '  Saved edit\n');
    const launched = harness(scope); launched.onRun = () => { launched.text.value = 'A newer draft'; };
    await launched.run(); assert.equal(launched.text.value, 'A newer draft');
  });
  test(`${scope}: uncertain accepted run is recovered without duplicate, and different follow-up is not trapped`, async () => {
    const h = harness(scope);
    h.onRun = request => { h.task.revisionOf = { runRequestId: request.requestId }; delete h.task.revisionDraft; throw new Error('Response lost'); };
    await h.run(); assert.equal(h.text.value, '  Saved edit\n');
    await h.run(); assert.equal(h.calls.filter(call => call.method === 'RUN').length, 1); assert.equal(h.text.value, '');
    const followup = harness(scope); followup.onRun = request => { followup.task.revisionOf = { runRequestId: request.requestId }; delete followup.task.revisionDraft; throw new Error('Response lost'); };
    await followup.run(); followup.text.value = 'Different follow up';
    assert.equal(await followup.retry(), false, 'ordinary follow-up can use ordinary pipeline after verified consumption');
  });
  test(`${scope}: a newer consumed revision clears only the stale local retry marker and requires a fresh explicit send`, async () => {
    const h = harness(scope);
    h.onRun = () => { throw new Error('Response lost'); };
    await h.run();
    h.task.revisionCount = 3;
    h.task.revisionOf = { runRequestId: 'different-client-run' };
    delete h.task.revisionDraft;
    h.text.value = 'Keep my intended next message';
    const mutations = () => h.calls.filter(call => call.method).length;
    const before = mutations();
    assert.equal(await h.retry(), true);
    assert.match(h.toasts.at(-1)[0], /chat changed.*text is kept/);
    assert.equal(h.text.value, 'Keep my intended next message');
    assert.equal(mutations(), before);
    const reads = h.calls.filter(call => call.path === '/api/ai-tasks/task').length;
    assert.equal(await h.retry(), false);
    assert.equal(h.calls.filter(call => call.path === '/api/ai-tasks/task').length, reads + 1);
    assert.equal(h.text.value, 'Keep my intended next message');
    assert.equal(mutations(), before);
  });
}

test('Nexus disconnected scope confirmation cancellation is read-only; explicit repair stays in same task', async () => {
  const h = harness('global'); h.task.repositoryIds = ['old']; h.selection = null;
  await h.run(); assert.equal(h.scopeCalls.length, 1); assert.equal(h.calls.filter(call => call.method).length, 0);
  assert.equal(h.text.value, '  Saved edit\n');
  h.selection = { repositoryIds: ['repo'], expectedRepositoryIds: ['old'] }; await h.run();
  const patch = h.calls.find(call => call.method === 'PATCH');
  assert.deepEqual(patch.body.repositoryIds, ['repo']); assert.deepEqual(patch.body.expectedRepositoryIds, ['old']);
  const run = h.calls.find(call => call.method === 'RUN'); assert.equal(run.body.taskId, 'task'); assert.deepEqual(run.body.repositoryIds, ['repo']);
});

test('all composer/queue event paths honor the shared revision lock before stop or enqueue', async () => {
  for (const name of ['handleComposerAction', 'handleComposerKeydown', 'queueCurrentPrompt', 'runAgent', 'runGlobalAgent']) {
    const fn = declaration(name); assert.match(fn, /revisionIsBusy/);
    const context = vm.createContext({ revisionIsBusy: () => true }); vm.runInContext(fn, context);
    if (name === 'handleComposerKeydown') context[name]({ key: 'Enter', preventDefault() {} }, 'global');
    else await context[name]('global');
  }
});
