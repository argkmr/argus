import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { chatRevisionCount, sameTaskRevision, createChatRevisionState } from '../public/chat-revision-state.mjs';

const boundary = '2026-09-18T12:00:00.000Z';
const oldTime = '2026-09-18T11:59:59.000Z';
const newTime = '2026-09-18T12:00:01.000Z';
const revised = (extra = {}) => ({ id: 'task', repositoryId: 'repo', revisionCount: 1,
  revisionOf: { taskId: 'task', createdAt: boundary }, messages: [], ...extra });
const job = (id = 'old', extra = {}) => ({ id, taskId: 'task', repositoryId: 'repo', startedAt: oldTime, status: 'running', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('revision count is monotonic per task and independent across tasks', () => {
  const state = createChatRevisionState();
  assert.equal(chatRevisionCount({}), 0);
  assert.equal(chatRevisionCount({ revisionCount: -1 }), 0);
  assert.equal(chatRevisionCount({ revisionCount: 1.5 }), 0);
  assert.equal(state.accept({ id: 'task' }), true);
  assert.equal(state.accept(revised()), true);
  assert.equal(state.accept({ id: 'task' }), false);
  assert.equal(state.accept(revised({ revisionCount: 2 })), true);
  assert.equal(state.accept(revised()), false);
  assert.equal(state.accept(revised({ id: 'other' })), true);
  assert.equal(state.accept({ messages: [] }), true);
});

test('same-task revisions reject pre-boundary jobs but keep new jobs and other task jobs', () => {
  const state = createChatRevisionState();
  state.accept(revised());
  assert.equal(state.acceptsJob(job()), false);
  assert.equal(state.acceptsJob(job('new', { startedAt: newTime })), true);
  assert.equal(state.acceptsJob(job('boundary', { startedAt: boundary })), true);
  assert.equal(state.acceptsJob(job('other', { taskId: 'other' })), true);
  assert.equal(state.acceptsJob(job('created', { startedAt: undefined, createdAt: newTime })), true);
  assert.equal(state.acceptsJob(null), false);
});

test('missing timestamps fail closed only for same-task revisions, never legacy forked chats', () => {
  const state = createChatRevisionState();
  const fork = revised({ revisionOf: { taskId: 'original', createdAt: boundary } });
  assert.equal(sameTaskRevision(fork), false);
  assert.equal(state.acceptsJob(job('legacy', { startedAt: undefined }), fork), true);
  assert.equal(state.acceptsJob(job('unknown', { startedAt: undefined }), revised()), false);
  assert.equal(state.acceptsJob(job('invalid'), revised({ revisionOf: { taskId: 'task', createdAt: 'invalid' } })), false);
});

test('stale candidate snapshots cannot weaken an accepted boundary', () => {
  const state = createChatRevisionState();
  state.accept(revised());
  assert.equal(state.acceptsJob(job(), { id: 'task', revisionCount: 0 }), false);
  const later = revised({ revisionCount: 2, revisionOf: { taskId: 'task', createdAt: '2026-09-18T12:05:00.000Z' } });
  assert.equal(state.acceptsJob(job('previous-revision', { startedAt: newTime }), later), false);
});

test('accepted boundary is detached from mutable task and revision objects', () => {
  const state = createChatRevisionState();
  const task = revised();
  state.accept(task);
  task.revisionOf.createdAt = oldTime;
  task.revisionCount = 0;
  assert.equal(state.acceptsJob(job()), false);
  assert.equal(state.accept(task), false);
});

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function source(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(app);
  assert(match, `Missing ${name}`);
  return app.slice(match.index, app.indexOf('\n}', match.index) + 2);
}

function harness(scope = 'repository') {
  const selectedKey = scope === 'global' ? 'globalJob' : 'activeJob';
  const repositoryId = scope === 'global' ? 'global' : 'repo';
  const old = job('old', { repositoryId });
  const events = [], calls = [], elements = new Map();
  const state = { activeRepository: { id: 'repo' }, activeTaskByRepository: { repo: 'task' }, activeGlobalTaskId: 'task',
    activeJob: scope === 'repository' ? old : null, globalJob: scope === 'global' ? old : null,
    repositoryJobs: scope === 'repository' ? [old] : [], globalJobs: scope === 'global' ? [old] : [],
    jobTimer: 'old-repo-timer', globalJobTimer: 'old-global-timer',
    promptQueuesLoaded: new Set(['task']), promptQueueProcessors: new Set(), promptQueueSaves: new Set(),
    currentView: scope === 'global' ? 'global' : 'repository' };
  const context = {
    state, chatRevisionState: createChatRevisionState(), checkpointTasks: new Map([[scope, { id: 'task', repositoryId }]]),
    checkpointActions: { ingest: task => task }, checkpointNavigation: new Map([[scope, { resetSelection: () => events.push('reset-navigation') }]]),
    activeTaskId: s => s === 'global' ? state.activeGlobalTaskId : state.activeTaskByRepository[state.activeRepository.id],
    isChatAgentJob: j => Boolean(j?.taskId && !j.systemJob && !j.orchestrationRunId),
    agentJobIsActive: j => ['starting', 'running', 'paused'].includes(j?.status),
    clearInterval: id => events.push(['clear-timer', id]),
    renderAgentQuestionForScope: () => events.push('question'), renderAgentTabs: () => events.push('tabs'), refreshQueuedSteeringControls() {},
    setComposerActionState: (...args) => events.push(['composer', ...args]),
    $: selector => { if (!elements.has(selector)) elements.set(selector, { classList: { add: value => events.push(['class', selector, value]) }, style: {}, focus() {} }); return elements.get(selector); },
    api: async (path, options) => { calls.push({ path, options }); return context.response; },
    showTaskWorkspace: () => true, setTaskPanelCollapsed() {}, renderTaskList() {}, restoreTaskModelSettings() {}, renderContextTray() {},
    renderTaskConversation: (...args) => events.push(['conversation', ...args]), syncViewUrl() {},
    showGlobalJob: j => events.push(['show', j]), showRepositoryJob: j => events.push(['show', j]),
    composerSubmission: () => null, setComposerPreparingState() {},
    mergeAgentJob: (a, b) => ({ ...a, ...b }),
    toast: (...args) => events.push(['toast', ...args]),
    refreshTasks: async () => events.push('refresh-tasks'), refreshActiveRepository: async () => events.push('refresh-repository'),
    importAgentApiRequests: async () => events.push('import-api'), renderProviderOptions: () => events.push('providers'),
  };
  vm.createContext(context);
  vm.runInContext(['setTextIfChanged', 'acceptChatTaskSnapshot', 'acceptPromptRevision', 'currentChatQuestionJob', 'jobBelongsToCurrentChat', 'selectTask', 'pollGlobalAgent', 'pollAgent'].map(source).join('\n'), context);
  return { context, state, old, selectedKey, events, calls, task: revised({ repositoryId }) };
}

for (const scope of ['repository', 'global']) {
  test(`${scope}: accepted revision clears old response/question and invalidates selection without touching another task`, () => {
    const h = harness(scope);
    const listKey = scope === 'global' ? 'globalJobs' : 'repositoryJobs';
    const other = job('other', { taskId: 'other' });
    h.state[listKey].push(other);
    const priorSelection = Symbol('old'); h.state.taskSelections = { [scope]: priorSelection };
    assert.equal(h.context.acceptPromptRevision(scope, h.task), true);
    assert.equal(h.state[h.selectedKey], null);
    assert.deepEqual(h.state[listKey], [other]);
    assert.notEqual(h.state.taskSelections[scope], priorSelection);
    assert.equal(h.context.checkpointTasks.get(scope), h.task);
    assert.ok(h.events.includes('reset-navigation'));
    // A subsequent jobs refresh must not make the prior question eligible again.
    h.state[listKey].unshift(h.old);
    assert.equal(h.context.currentChatQuestionJob(scope, 'task'), undefined);
    assert.equal(h.context.jobBelongsToCurrentChat(scope, h.old), false);
  });

  test(`${scope}: revision completion after navigation only updates the captured task boundary`, () => {
    const h = harness(scope);
    if (scope === 'global') h.state.activeGlobalTaskId = 'other';
    else { h.state.activeRepository = { id: 'other-repo' }; h.state.activeTaskByRepository['other-repo'] = 'other'; }
    const visible = { id: 'other' }; h.context.checkpointTasks.set(scope, visible);
    assert.equal(h.context.acceptPromptRevision(scope, h.task), true);
    assert.equal(h.context.checkpointTasks.get(scope), visible);
    assert.equal(h.state[h.selectedKey], h.old);
    assert.deepEqual(h.events, []);
    assert.equal(h.context.chatRevisionState.acceptsJob(h.old), false);
  });

  test(`${scope}: old in-flight selection cannot repaint the same task after revision`, async () => {
    const h = harness(scope), pending = deferred();
    h.context.api = async (path, options) => { h.calls.push({ path, options }); return pending.promise; };
    const selecting = h.context.selectTask(scope, 'task');
    h.context.acceptPromptRevision(scope, h.task);
    pending.resolve({ ...h.task, revisionCount: 0, revisionOf: undefined });
    await selecting;
    assert.equal(h.events.some(e => Array.isArray(e) && e[0] === 'conversation'), false);
    assert.equal(h.calls[0].options.dedupe, false);
    assert.equal(h.calls[0].options.cache, 'no-store');
  });

  test(`${scope}: stale post-revision GET and old locally running job are not selected`, async () => {
    const h = harness(scope);
    h.context.acceptPromptRevision(scope, h.task);
    h.context.response = { ...h.task, revisionCount: 0, revisionOf: undefined };
    await h.context.selectTask(scope, 'task');
    assert.equal(h.events.some(e => Array.isArray(e) && e[0] === 'conversation'), false);
    h.state[scope === 'global' ? 'globalJobs' : 'repositoryJobs'].push(h.old);
    h.context.response = h.task;
    await h.context.selectTask(scope, 'task');
    assert.equal(h.events.some(e => Array.isArray(e) && e[0] === 'show'), false);
    assert.equal(h.events.filter(e => Array.isArray(e) && e[0] === 'conversation').length, 1);
  });

  for (const rejects of [false, true]) test(`${scope}: late old poll ${rejects ? 'failure' : 'result'} cannot replace the new job or clear its timer`, async () => {
    const h = harness(scope), pending = deferred();
    h.context.api = () => pending.promise;
    const polling = h.context[scope === 'global' ? 'pollGlobalAgent' : 'pollAgent']();
    h.context.acceptPromptRevision(scope, h.task);
    const next = job('new', { startedAt: newTime, repositoryId: h.task.repositoryId });
    h.state[h.selectedKey] = next;
    const timerKey = scope === 'global' ? 'globalJobTimer' : 'jobTimer'; h.state[timerKey] = 'new-timer';
    h.events.length = 0;
    if (rejects) pending.reject(new Error('Old request disconnected')); else pending.resolve({ status: 'cancelled' });
    await polling;
    assert.equal(h.state[h.selectedKey], next);
    assert.equal(h.state[timerKey], 'new-timer');
    assert.deepEqual(h.events, []);
  });
}
