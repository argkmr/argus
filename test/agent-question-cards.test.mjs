import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeAgentQuestion, latestTaskQuestion, chatQuestion, questionWasCancelled, questionIsActive, questionCardTitle, createAgentQuestionCards } from '../public/agent-question-cards.mjs';

const question = { id: 'job-one:question-one', source: 'structured', questions: [
  { id: 'bucket', question: 'Which private bucket should we use?', header: 'Storage', options: [{ label: 'Existing bucket', description: 'Reuse a private destination.' }, { label: 'New destination', description: 'Describe the approved destination below.' }] },
  { id: 'access', question: 'Do the services already have access?', options: [] },
] };
const assistant = { id: 'answer', role: 'assistant', status: 'completed', createdAt: '2026-09-10T12:00:02Z', question, execution: { jobId: 'job-one' } };
const task = { id: 'task-one', messages: [{ role: 'user', content: 'Investigate', createdAt: '2026-09-10T12:00:00Z' }, assistant] };
const job = { id: 'job-one', taskId: task.id, status: 'completed', completionPending: false, startedAt: '2026-09-10T12:00:01Z', question };

class Element {
  children = []; attributes = new Map(); listeners = new Map(); value = ''; textContent = ''; disabled = false; checked = false; className = ''; parentNode = null;
  constructor(tag = 'div') { this.tagName = tag.toLowerCase(); this.dataset = {}; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  get firstChild() { return this.children[0]; }
  append(...nodes) { for (const node of nodes) { if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((child) => child !== node); node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name) { return this.listeners.get(name)?.({ preventDefault() {} }); }
  querySelectorAll(tag) { return walk(this).filter((node) => node.tagName === tag); }
  focus() { this.focused = true; }
}
function walk(root) { return root.children.flatMap((node) => [node, ...walk(node)]); }
function nodes(root, className) { return walk(root).filter((node) => node.className.split(' ').includes(className)); }
function harness({ scope = 'repository', active = false, source = 'structured', api, onAnswered, onCancelled, createNoteFields, promptNotes } = {}) {
  let current = true, uuid = 0;
  const calls = [], accepted = [], cancelled = [];
  const manager = createAgentQuestionCards({ document: { createElement: (tag) => new Element(tag) },
    createNoteFields,
    api: async (...args) => { calls.push(args); return api ? api(...args) : { id: 'next-job', taskId: task.id }; },
    isCurrent: (actualScope, taskId) => current && actualScope === scope && taskId === task.id,
    onAnswered: async (...args) => { accepted.push(args); if (onAnswered) await onAnswered(...args); },
    onCancelled: async (...args) => { cancelled.push(args); if (onCancelled) await onCancelled(...args); }, randomUUID: () => `request-${++uuid}` });
  const host = new Element(), detail = { question: { ...question, source }, status: active ? 'running' : 'completed', active, promptNotes };
  const render = (next = detail) => manager.render(host, { scope, taskId: task.id, detail: next });
  render();
  return { manager, host, detail, render, calls, accepted, cancelled, setCurrent: (value) => current = value,
    get form() { return nodes(host, 'agent-question-form')[0]; }, get fields() { return nodes(host, 'agent-question-answer'); },
    get radios() { return walk(host).filter((node) => node.tagName === 'input'); },
    get error() { return nodes(host, 'agent-question-error')[0]?.textContent; },
    get button() { return nodes(host, 'agent-question-submit')[0]; },
    get cancel() { return nodes(host, 'agent-question-cancel')[0]; },
    get status() { return nodes(host, 'agent-question-status')[0]?.textContent; },
  };
}
const fill = (h) => h.fields.forEach((field, index) => { field.value = index ? 'Yes, access is configured' : 'private-fixture-bucket/replays'; field.dispatch('input'); });

test('reply notes are editable, frozen into idempotent requests, and kept through polling and failures', async () => {
  const defaults = [{ id: 'note-one', text: 'Run focused tests', enabled: true }];
  let notes, disabled, bad = false;
  const h = harness({ promptNotes: defaults, api: async () => { throw new Error('synthetic retry'); },
    createNoteFields: () => ({ set(value) { notes = structuredClone(value); }, get() { if (bad) throw new Error('Invalid note'); return structuredClone(notes); }, setBusy(value) { disabled = value; } }) });
  fill(h); assert.deepEqual(notes, defaults);
  notes[0].enabled = false;
  h.render({ ...h.detail, promptNotes: [] });
  assert.equal(notes[0].enabled, false, 'polling must not replace unsent reply edits');
  await h.form.dispatch('submit');
  const first = h.calls[0][1].body;
  assert.deepEqual(first.promptNotes, [{ ...defaults[0], enabled: false }]);
  assert.equal(disabled, false);
  await h.form.dispatch('submit');
  assert.equal(h.calls[1][1].body.requestId, first.requestId);
  notes[0].text = 'One-off revised note'; await h.form.dispatch('submit');
  assert.notEqual(h.calls[2][1].body.requestId, first.requestId);
  assert.equal(first.promptNotes[0].text, defaults[0].text, 'sent snapshots stay immutable');
  bad = true; await h.form.dispatch('submit');
  assert.equal(h.calls.length, 3); assert.match(h.error, /Invalid note/);
});

test('question metadata is narrowly normalized without interpreting its content', () => {
  assert.equal(normalizeAgentQuestion(question).questions.length, 2);
  for (const value of [null, { ...question, source: 'blocked' }, { ...question, questions: [] }, { ...question, questions: Array(4).fill(question.questions[0]) }, { ...question, questions: [question.questions[0], question.questions[0]] }]) assert.equal(normalizeAgentQuestion(value), null);
  assert.equal(normalizeAgentQuestion({ ...question, questions: [{ id: 'x', question: '<img onerror=alert(1)>', options: [] }] }).questions[0].question, '<img onerror=alert(1)>');
});

test('only the latest assistant question is offered, never historical or answered cards', () => {
  assert.equal(latestTaskQuestion(task).question.id, question.id);
  assert.equal(latestTaskQuestion({ ...task, messages: [...task.messages, { role: 'assistant', content: 'Finished' }] }), null);
  assert.equal(latestTaskQuestion({ ...task, messages: [...task.messages, { role: 'user', content: 'Continue' }] }), null);
  const answered = { ...task, messages: [...task.messages, { role: 'user', questionReply: { questionId: question.id }, createdAt: '2026-09-10T12:00:03Z' }] };
  assert.equal(chatQuestion(answered, job), null);
  assert.equal(chatQuestion({ ...task, messages: [...task.messages, { role: 'user', content: 'Change direction', createdAt: '2026-09-10T12:00:03Z' }] }, job), null);
  assert.equal(chatQuestion({ ...task, messages: [...task.messages, { role: 'assistant', content: 'Later answer', createdAt: '2026-09-10T12:00:05Z' }] }, job), null);
  for (const status of ['failed', 'cancelled']) {
    const unsuccessful = { ...task, messages: [{ ...assistant, status }] };
    assert.equal(latestTaskQuestion(unsuccessful), null);
    assert.equal(chatQuestion(unsuccessful, { ...job, status }), null);
  }
});

test('live and saved metadata produce one candidate; a newer run supersedes the previous card', () => {
  assert.equal(chatQuestion(task, job).question.id, question.id);
  assert.equal(chatQuestion({ ...task, messages: task.messages.slice(0, 1) }, { ...job, status: 'running' }).active, true);
  assert.equal(chatQuestion(task, { ...job, id: 'new-job', status: 'running', question: null, startedAt: '2026-09-10T12:00:03Z' }), null);
  assert.equal(chatQuestion(task, { ...job, taskId: 'another-task' }).question.id, question.id);
});

test('same-job steering cannot hide a live question or impersonate a later user turn', () => {
  const steer = { role: 'user', status: 'steered', content: 'Also inspect the cache', createdAt: '2026-09-10T12:00:03Z',
    steering: { requestId: 'queue-one', jobId: job.id, turnId: 'native-turn' } };
  const active = { ...job, status: 'running', nativeTurnId: 'native-turn' };
  const steeredTask = { ...task, messages: [task.messages[0], steer] };
  assert.equal(chatQuestion(steeredTask, active).question.id, question.id);
  assert.equal(chatQuestion(steeredTask, active).active, true);
  for (const extra of [{ ...steer, status: 'sent' }, { ...steer, steering: undefined },
    { ...steer, steering: { ...steer.steering, jobId: 'other' } }, { ...steer, steering: { ...steer.steering, turnId: 'other' } },
    { role: 'user', content: 'Start a new task', createdAt: '2026-09-10T12:00:04Z' }])
    assert.equal(chatQuestion({ ...steeredTask, messages: [...steeredTask.messages, extra] }, active), null);
});

test('durable cancellation suppresses saved and stale-live cards after reload, only for the same question', () => {
  for (const cancelledTask of [
    { ...task, questionCancellation: { status: 'cancelled', questionId: question.id, requestId: 'cancel-one' } },
    { ...task, messages: [...task.messages.slice(0, -1), { ...assistant, questionCancellation: { status: 'cancelled', questionId: question.id, requestId: 'cancel-one' } }] },
  ]) {
    assert.equal(questionWasCancelled(cancelledTask, question.id), true);
    assert.equal(latestTaskQuestion(cancelledTask), null);
    assert.equal(chatQuestion(cancelledTask, job), null);
    assert.equal(chatQuestion(cancelledTask, { ...job, status: 'running', completionPending: true }), null);
    const newerQuestion = { ...question, id: 'new-job:question-two' };
    const newerTask = { ...cancelledTask, messages: [...cancelledTask.messages, { ...assistant, question: newerQuestion, execution: { jobId: 'new-job' }, createdAt: '2026-09-10T12:00:06Z' }] };
    assert.equal(latestTaskQuestion(newerTask).question.id, newerQuestion.id);
    assert.equal(chatQuestion(newerTask, job).question.id, newerQuestion.id);
  }
  assert.equal(questionWasCancelled(null, question.id), false);
  assert.equal(questionWasCancelled({ ...task, questionCancellation: { status: 'cancelling', questionId: question.id } }, question.id), false);
  assert.equal(chatQuestion({ ...task, questionCancellation: { questionId: 'different-question' } }, job).question.id, question.id);
});

test('labels respect lifecycle and never declare suggested prose blocked', () => {
  for (const status of ['starting', 'running', 'paused']) assert.equal(questionIsActive({ status }), true);
  assert.equal(questionIsActive({ status: 'cancelled', completionPending: true }), true);
  assert.equal(questionIsActive({ status: 'completed', completionPending: false }), false);
  assert.equal(questionCardTitle({ question, active: true, status: 'running' }), 'Question from Argus');
  assert.equal(questionCardTitle({ question, active: false, status: 'completed' }), 'Your reply is needed');
  assert.equal(questionCardTitle({ question, active: false, status: 'failed' }), 'Reply to this question');
  assert.equal(questionCardTitle({ question: { ...question, source: 'suggested' }, active: false, status: 'completed' }), 'Reply to this question');
});

test('no options are preselected, free text always exists and all questions require user answers', async () => {
  const h = harness();
  assert.equal(h.fields.length, 2); assert.ok(h.radios.every((radio) => !radio.checked)); assert.ok(h.fields.every((field) => !field.value));
  await h.form.dispatch('submit'); assert.equal(h.calls.length, 0); assert.match(h.error, /answer each question/); assert.equal(h.fields[0].focused, true);
  h.radios[0].checked = true; h.radios[0].dispatch('change'); assert.equal(h.fields[0].value, 'Existing bucket');
  h.fields[0].value = 'My own destination'; h.fields[0].dispatch('input'); assert.ok(h.radios.every((radio) => !radio.checked));
});

test('polls and task switches preserve the exact form, answer text and choices', () => {
  const h = harness(); fill(h); const card = h.host.firstChild, field = h.fields[0];
  h.render({ ...h.detail, active: true }); assert.equal(h.host.firstChild, card); assert.equal(h.fields[0], field); assert.equal(h.fields[0].value, 'private-fixture-bucket/replays');
  h.manager.render(h.host, { scope: 'repository', taskId: 'different-chat', detail: null }); assert.equal(h.host.children.length, 0);
  h.render(); assert.equal(h.host.firstChild, card); assert.equal(h.fields[0], field); assert.equal(h.fields[0].value, 'private-fixture-bucket/replays');
});

for (const scope of ['repository', 'global']) test(`${scope} reply posts captured IDs and exact answers without touching a composer`, async () => {
  const h = harness({ scope }); fill(h); await h.form.dispatch('submit');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], '/api/agents/questions/answer');
  assert.deepEqual(h.calls[0][1].body, { requestId: 'request-1', taskId: 'task-one', questionId: question.id,
    answers: [{ id: 'bucket', answer: 'private-fixture-bucket/replays' }, { id: 'access', answer: 'Yes, access is configured' }] });
  assert.deepEqual(h.accepted[0][1], { scope, taskId: task.id, questionId: question.id });
  assert.equal(h.manager.answered(task.id, question.id), true);
  h.render(); assert.equal(h.host.children.length, 0, 'stale polling cannot restore an accepted card');
});

test('active lifecycle and stale task guards do not dispatch', async () => {
  const h = harness({ active: true }); fill(h); assert.equal(h.button.disabled, true); assert.equal(h.fields[0].disabled, false);
  await h.form.dispatch('submit'); assert.equal(h.calls.length, 0); assert.match(h.error, /finish/);
  h.render({ ...h.detail, active: false }); h.setCurrent(false); await h.form.dispatch('submit'); assert.equal(h.calls.length, 0); assert.match(h.error, /original chat/);
});

test('duplicate submission is blocked, in-flight navigation never changes captured request identity', async () => {
  let finish;
  const h = harness({ api: () => new Promise((resolve) => { finish = resolve; }) }); fill(h);
  const pending = h.form.dispatch('submit'); await h.form.dispatch('submit');
  assert.equal(h.calls.length, 1); assert.equal(h.manager.isSending(task.id), true); assert.ok(h.fields.every((field) => field.disabled));
  h.setCurrent(false); finish({ id: 'next-job', taskId: task.id }); await pending;
  assert.equal(h.calls[0][1].body.taskId, task.id); assert.equal(h.accepted[0][1].taskId, task.id);
});

test('failed replies retain answers and reuse the same UUID for an unchanged retry', async () => {
  let failures = 2;
  const h = harness({ api: async () => { if (failures--) throw new Error('Uncertain response; retry safely'); return { id: 'next-job' }; } }); fill(h);
  await h.form.dispatch('submit'); const request = h.calls[0][1].body;
  assert.match(h.error, /Uncertain/); assert.equal(h.fields[0].value, 'private-fixture-bucket/replays'); assert.equal(h.button.disabled, false);
  h.render(); await h.form.dispatch('submit'); assert.deepEqual(h.calls[1][1].body, request);
  h.fields[0].value = 'Changed destination'; await h.form.dispatch('submit'); assert.equal(h.calls[2][1].body.requestId, 'request-2');
});

test('presentation failure after accepted answer cannot cause another dispatch', async () => {
  const h = harness({ onAnswered: async () => { throw new Error('Refresh failed'); } }); fill(h);
  const form = h.form; await form.dispatch('submit'); await form.dispatch('submit');
  assert.equal(h.calls.length, 1); assert.equal(h.manager.answered(task.id, question.id), true);
});

for (const scope of ['repository', 'global']) test(`${scope} cancels an empty unanswered request without sending an answer`, async () => {
  const result = { ok: true, task: { ...task, questionCancellation: { status: 'cancelled', questionId: question.id } } };
  const h = harness({ scope, api: async () => result });
  const form = h.form, cancel = h.cancel;
  await cancel.dispatch('click');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], '/api/agents/questions/cancel');
  assert.deepEqual(h.calls[0][1], { method: 'POST', body: { requestId: 'request-1', taskId: task.id, questionId: question.id } });
  assert.deepEqual(h.cancelled[0], [result, { scope, taskId: task.id, questionId: question.id }]);
  assert.equal(h.accepted.length, 0); assert.equal(h.manager.answered(task.id, question.id), false);
  assert.equal(h.manager.cancelled(task.id, question.id), true); assert.equal(h.host.children.length, 0);
  h.render(); assert.equal(h.host.children.length, 0, 'stale polling cannot restore cancelled question');
  await cancel.dispatch('click'); await form.dispatch('submit'); assert.equal(h.calls.length, 1, 'detached card cannot dispatch again');
});

test('cancel remains available during working and finalization and waits for the backend receipt', async () => {
  for (const status of ['running', 'completed']) {
    let finish;
    const h = harness({ active: true, api: () => new Promise((resolve) => { finish = resolve; }) });
    h.render({ ...h.detail, active: true, status });
    assert.equal(h.cancel.disabled, false); assert.equal(h.button.disabled, true);
    const cancel = h.cancel, form = h.form, pending = cancel.dispatch('click');
    assert.equal(h.manager.cancelled(task.id, question.id), false); assert.equal(h.manager.isSending(task.id), true);
    assert.equal(cancel.textContent, 'Cancelling…'); assert.match(h.status, /Cancelling this request/);
    assert.ok(h.fields.every((field) => field.disabled)); assert.equal(cancel.disabled, true);
    await cancel.dispatch('click'); await form.dispatch('submit'); assert.equal(h.calls.length, 1);
    h.setCurrent(false); finish({ ok: true, task }); await pending;
    assert.equal(h.cancelled[0][1].taskId, task.id); assert.equal(h.manager.cancelled(task.id, question.id), true);
  }
});

test('cancellation failure keeps the draft and reuses one cancellation UUID even after editing', async () => {
  let fail = true;
  const h = harness({ api: async () => { if (fail) { fail = false; throw new Error('Synthetic cancellation failed'); } return { ok: true, task }; } });
  fill(h); await h.cancel.dispatch('click');
  const request = h.calls[0][1].body;
  assert.match(h.error, /cancellation failed/); assert.equal(h.fields[0].value, 'private-fixture-bucket/replays');
  assert.equal(h.cancel.disabled, false); assert.equal(h.button.disabled, false); assert.equal(h.manager.cancelled(task.id, question.id), false);
  h.fields[0].value = 'Changed answer draft'; h.render(); await h.cancel.dispatch('click');
  assert.deepEqual(h.calls[1][1].body, request);
});

test('cancel does not dispatch from another visible chat or while an answer is in flight', async () => {
  const stale = harness(); stale.setCurrent(false); await stale.cancel.dispatch('click');
  assert.equal(stale.calls.length, 0); assert.match(stale.error, /original chat to cancel/);
  let finish;
  const h = harness({ api: () => new Promise((resolve) => { finish = resolve; }) });
  fill(h); const cancel = h.cancel, pending = h.form.dispatch('submit');
  assert.equal(cancel.disabled, true); await cancel.dispatch('click'); assert.equal(h.calls.length, 1);
  finish({ id: 'next-job' }); await pending; await cancel.dispatch('click'); assert.equal(h.calls.length, 1);
});

test('presentation failure after cancellation never revives or resubmits the request', async () => {
  const h = harness({ onCancelled: async () => { throw new Error('Refresh failed'); } });
  const cancel = h.cancel; await cancel.dispatch('click'); await cancel.dispatch('click'); h.render();
  assert.equal(h.calls.length, 1); assert.equal(h.manager.cancelled(task.id, question.id), true); assert.equal(h.host.children.length, 0);
});

test('question text uses text nodes rather than HTML interpolation', () => {
  const h = harness();
  h.manager.render(h.host, { scope: 'repository', taskId: 'unsafe', detail: { question: { id: 'unsafe', source: 'suggested', questions: [{ id: 'x', question: '<img src=x onerror=alert(1)>', options: [{ label: '<script>danger</script>', description: '<b>description</b>' }] }] } } });
  assert.equal(nodes(h.host, 'agent-question-label')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(walk(h.host).some((node) => ['img', 'script'].includes(node.tagName)), false);
});

test('production integration keeps question hosts outside rerendered chat/live output and handles both scopes', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const layout = await fs.readFile(new URL('../frontend/app/layout.jsx', import.meta.url), 'utf8');
  assert.match(html, /agent-question-cards\.css/);
  assert.match(layout, /\/legacy\/agent-question-cards\.css\?v=\$\{argusBuild\}/);
  assert.equal((html.match(/id="agent-question-card-host"/g) || []).length, 1);
  assert.equal((html.match(/id="global-agent-question-card-host"/g) || []).length, 1);
  assert.match(app, /renderAgentQuestionForScope\("repository"\)/); assert.match(app, /renderAgentQuestionForScope\("global"\)/);
  const accept = app.slice(app.indexOf('async function acceptAgentQuestionAnswer('), app.indexOf('\nconst checkpointNavigation'));
  assert.doesNotMatch(accept, /selectTask\(|takeComposerDraft|consumeSubmittedAttachments|restoreComposerDraft/);
  assert.match(accept, /stillVisible\(\)/);
  assert.match(app, /onCancelled: acceptAgentQuestionCancellation/);
});

for (const scope of ['repository', 'global']) test(`${scope} cancellation updates only the captured chat and keeps queued messages paused`, async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('async function acceptAgentQuestionCancellation('), app.indexOf('\nconst checkpointNavigation'));
  const queue = [{ requestId: 'queued-one', prompt: 'Keep this request', status: 'queued' }];
  const cancelledTask = { ...task, repositoryId: 'repo-one', questionCancellation: { status: 'cancelled', questionId: question.id } };
  const cancelledJob = { ...job, status: 'cancelled' };
  const rendered = [], shown = [], toasts = [], calls = [];
  const state = { currentView: scope === 'global' ? 'global' : 'repository', activeRepository: { id: 'repo-one' }, repositoryJobs: [job], globalJobs: [job], promptQueuesLoaded: new Set() };
  const checkpointTasks = new Map([[scope, task]]);
  const context = { state, checkpointTasks, activeTaskId: () => task.id, queuedPrompts: () => queue,
    api: async (path) => { calls.push(path); return [{ requestId: 'queued-one', prompt: 'Keep this request', status: 'queued', pauseReason: 'question-cancelled' }]; },
    showRepositoryJob: (value) => shown.push(value), showGlobalJob: (value) => shown.push(value),
    renderTaskConversation: (...args) => rendered.push(args), renderAgentTabs() {}, toast: (message) => toasts.push(message) };
  vm.createContext(context); vm.runInContext(source, context);
  await context.acceptAgentQuestionCancellation({ ok: true, task: cancelledTask, job: cancelledJob }, { scope, taskId: task.id, questionId: question.id });
  assert.equal(checkpointTasks.get(scope), cancelledTask); assert.equal(shown[0], cancelledJob);
  assert.equal((scope === 'global' ? state.globalJobs : state.repositoryJobs)[0], cancelledJob);
  assert.equal(queue.length, 1); assert.equal(queue[0].prompt, 'Keep this request');
  assert.equal(queue[0].pauseReason, 'question-cancelled'); assert.equal(queue[0].recovered, true);
  assert.match(toasts.at(-1), /Request cancelled.*kept and paused.*Resume queue/);
  assert.equal(calls.some((path) => path.includes('/run') || path.includes('/resume') || path.includes('/claim')), false);
  assert.ok(rendered.every(([, value]) => value.id === task.id));
});

test('cancellation receipt cannot navigate back over a newer chat while refreshing the queue', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('async function acceptAgentQuestionCancellation('), app.indexOf('\nconst checkpointNavigation'));
  let finish, current = task.id;
  const queue = [{ requestId: 'queued-one', status: 'queued' }], rendered = [], toasts = [];
  const state = { currentView: 'repository', activeRepository: { id: 'repo-one' }, repositoryJobs: [job], globalJobs: [], promptQueuesLoaded: new Set() };
  const checkpointTasks = new Map([['repository', task]]);
  const context = { state, checkpointTasks, activeTaskId: () => current, queuedPrompts: () => queue,
    api: () => new Promise((resolve) => { finish = resolve; }), showRepositoryJob() {}, showGlobalJob() {},
    renderTaskConversation: (...args) => rendered.push(args), renderAgentTabs() {}, toast: (message) => toasts.push(message) };
  vm.createContext(context); vm.runInContext(source, context);
  const pending = context.acceptAgentQuestionCancellation({ ok: true, task: { ...task, repositoryId: 'repo-one' } }, { scope: 'repository', taskId: task.id, questionId: question.id });
  current = 'new-chat'; checkpointTasks.set('repository', { id: current }); const rendersBeforeNavigation = rendered.length;
  finish([{ requestId: 'queued-one', status: 'queued', pauseReason: 'question-cancelled' }]); await pending;
  assert.equal(checkpointTasks.get('repository').id, 'new-chat'); assert.equal(rendered.length, rendersBeforeNavigation); assert.equal(toasts.length, 0);
  assert.equal(queue[0].recovered, true);
});

test('persisted cancellation changes job labels without reopening pending question state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function agentJobStatusLabel('), app.indexOf('\nasync function acceptAgentQuestionAnswer('));
  const context = { normalizeAgentQuestion, questionWasCancelled, questionCardTitle, agentJobIsActive: questionIsActive,
    checkpointTasks: new Map([['repository', { ...task, questionCancellation: { status: 'cancelled', questionId: question.id } }]]),
    agentQuestionCards: { answered: () => false, cancelled: () => false } };
  vm.createContext(context); vm.runInContext(source, context);
  assert.equal(context.agentJobStatusLabel(job), 'Request cancelled');
  assert.equal(context.agentJobStatusLabel({ ...job, status: 'running' }), 'Working');
});

test('structured questions pause queued work before claim; suggested prose does not', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('async function processPromptQueue('), app.indexOf('\nasync function runAgent('));
  for (const type of ['structured', 'suggested']) {
    const queue = [{ requestId: 'queued-one', taskId: task.id, status: 'queued', recovered: false }], calls = [];
    const context = { state: { promptQueueProcessors: new Set(), promptQueueHolds: new Map(), activeRepository: null },
      queuedPrompts: () => queue, waitForQueuedPredecessor: async () => {}, latestTaskQuestion,
      agentQuestionCards: { isSending: () => false },
      api: async (path) => { calls.push(path); if (path.startsWith('/api/ai-tasks/')) return { ...task, messages: [{ ...assistant, question: { ...question, source: type } }] }; if (path.endsWith('/claim')) return { dispatchToken: 'token' }; return {}; },
      startQueuedPrompt: async () => ({ id: 'next' }), activeTaskId: () => null, toast() {}, renderTaskConversation() {},
    };
    vm.createContext(context); vm.runInContext(source, context); await context.processPromptQueue('global', task.id, 'old-job');
    if (type === 'structured') { assert.equal(queue.length, 1); assert.equal(queue[0].recovered, true); assert.equal(queue[0].pauseReason, 'question'); assert.equal(calls.some((path) => path.endsWith('/claim')), false); }
    else { assert.equal(queue.length, 0); assert.equal(calls.some((path) => path.endsWith('/claim')), true); }
  }
});
