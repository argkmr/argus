const terminal = new Set(['completed', 'failed', 'cancelled']);

export function normalizeAgentQuestion(value) {
  if (!value || typeof value.id !== 'string' || !value.id || !['structured', 'suggested'].includes(value.source)
      || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 3) return null;
  const ids = new Set();
  const questions = [];
  for (const item of value.questions) {
    if (typeof item?.id !== 'string' || !item.id || ids.has(item.id) || typeof item.question !== 'string' || !item.question.trim()) return null;
    ids.add(item.id);
    questions.push({ id: item.id, question: item.question, header: typeof item.header === 'string' ? item.header : '',
      options: (Array.isArray(item.options) ? item.options : []).filter((option) => typeof option?.label === 'string' && option.label.trim()).slice(0, 10)
        .map((option) => ({ label: option.label, description: typeof option.description === 'string' ? option.description : '' })) });
  }
  return { id: value.id, source: value.source, questions };
}

// Cancellation is persisted by the backend, rather than inferred from text or
// stored only in the UI. Match the occurrence ID so a later question can appear.
export function questionWasCancelled(task, questionId) {
  if (!task || !questionId) return false;
  const matches = (value) => value?.status === 'cancelled' && value.questionId === questionId;
  return matches(task.questionCancellation)
    || Boolean(task.messages?.some((message) => matches(message.questionCancellation)));
}

export function latestTaskQuestion(task) {
  const last = task?.messages?.at(-1);
  if (last?.role !== 'assistant' || ['failed', 'cancelled'].includes(last.status)) return null;
  const question = normalizeAgentQuestion(last.question);
  return question && !questionWasCancelled(task, question.id) ? { question, status: last.status || 'completed', message: last, active: false } : null;
}

export function questionIsActive(job) {
  return Boolean(job && (!terminal.has(job.status) || job.completionPending));
}

// Persisted questions belong only to the last assistant response. A previous
// job's retained metadata must never reopen its card after a user has replied.
export function chatQuestion(task, job = null) {
  const saved = latestTaskQuestion(task);
  if (!job || job.taskId !== task?.id || job.systemJob) return saved;
  const question = normalizeAgentQuestion(job.question);
  if (question && questionWasCancelled(task, question.id)) return saved;
  if (question && ['failed', 'cancelled'].includes(job.status)) return null;
  // A steered message is additional input to this job, not a newer turn that
  // supersedes its questions. Unknown/other-job user messages retain the guard.
  const last = [...(task.messages || [])].reverse().find(message => !(message.role === 'user'
    && message.status === 'steered' && message.steering?.jobId === job.id
    && message.steering.requestId && message.steering.turnId
    && (!job.nativeTurnId || message.steering.turnId === job.nativeTurnId)));
  if (question && task.messages?.some((message) => message.role === 'user' && message.questionReply?.questionId === question.id)) return saved;
  const started = Date.parse(job.startedAt || job.createdAt || '');
  const lastTime = Date.parse(last?.createdAt || '');
  if (question && last?.role === 'user' && Number.isFinite(started) && Number.isFinite(lastTime) && lastTime > started) return saved;
  if (saved && question?.id === saved.question.id) return { ...saved, active: questionIsActive(job), status: job.status };
  if (last?.role === 'assistant' && last.execution?.jobId !== job.id && Number.isFinite(started) && lastTime >= started) return saved;
  if (question) return { question, status: job.status, active: questionIsActive(job), job };
  // A newer run supersedes a saved question even while its user message has not
  // arrived in the task refresh yet. Never offer to answer an older response.
  if (saved && questionIsActive(job) && (last?.execution?.jobId !== job.id || started >= lastTime)) return null;
  return saved;
}

export function questionCardTitle({ question, active, status }) {
  if (active) return 'Question from Argus';
  return question?.source === 'structured' && status === 'completed' ? 'Your reply is needed' : 'Reply to this question';
}

// Reuse each form's actual DOM nodes when polling or switching chats. The host
// can be reattached without replacing focused inputs, selections or answer text.
export function createAgentQuestionCards({ document, api, isCurrent, createNoteFields, onAnswered = async () => {}, onCancelled = async () => {},
  randomUUID = () => crypto.randomUUID() }) {
  const sessions = new Map();
  let serial = 0;
  const element = (name, className, text) => {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const keyFor = (taskId, questionId) => `${taskId}\n${questionId}`;
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function paint(session) {
    const { card, detail, inputs, submit, cancel, status, title, errorNode } = session;
    text(title, questionCardTitle(detail));
    card.dataset.questionSource = detail.question.source;
    card.setAttribute('aria-busy', String(session.busy));
    text(status, session.cancelled ? 'Request cancelled. This chat has stopped.'
      : session.accepted ? 'Reply sent. Argus is continuing.' : session.busyOperation === 'cancel' ? 'Cancelling this request…'
      : session.busy ? 'Sending your reply…'
      : detail.active ? 'Argus is still working. You can prepare your reply below and send it when this response finishes.'
      : detail.question.source === 'structured' ? 'Answer below to continue this chat. Your composer draft stays unchanged.'
      : 'This response appears to ask a question. Reply here if you want to continue; Argus is not marked as blocked.');
    for (const input of inputs) input.disabled = session.busy || session.accepted || session.cancelled;
    session.noteFields?.setBusy(session.busy || session.accepted || session.cancelled);
    submit.disabled = Boolean(detail.active || session.busy || session.accepted || session.cancelled);
    text(submit, session.busyOperation === 'answer' ? 'Sending…' : session.accepted ? 'Reply sent' : 'Send reply');
    cancel.disabled = Boolean(session.busy || session.accepted || session.cancelled);
    text(cancel, session.busyOperation === 'cancel' ? 'Cancelling…' : session.cancelled ? 'Request cancelled' : 'Cancel this request');
    text(errorNode, session.error || '');
  }
  function build(scope, taskId, detail) {
    const question = detail.question;
    const card = element('section', 'agent-question-card');
    card.dataset.agentQuestionId = question.id;
    const title = element('h3', 'agent-question-title');
    title.id = `agent-question-heading-${++serial}`;
    card.setAttribute('aria-labelledby', title.id);
    const header = element('header', 'agent-question-header');
    header.append(element('span', 'agent-question-symbol', '?'), title);
    const status = element('p', 'agent-question-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const form = element('form', 'agent-question-form');
    const inputs = [], fields = [];
    for (const [index, item] of question.questions.entries()) {
      const fieldset = element('fieldset', 'agent-question-field');
      const legend = element('legend', 'agent-question-label', item.question);
      fieldset.append(legend);
      if (item.header) fieldset.append(element('small', 'agent-question-hint', item.header));
      const text = element('textarea', 'agent-question-answer');
      text.id = `agent-question-answer-${serial}-${index}`;
      text.rows = 2; text.maxLength = 10000;
      text.placeholder = item.options.length ? 'Choose an option above or write your own answer…' : 'Write your answer…';
      text.setAttribute('aria-label', `Your answer: ${item.question}`);
      const options = element('div', 'agent-question-options');
      for (const [optionIndex, option] of item.options.entries()) {
        const label = element('label', 'agent-question-option');
        const radio = element('input'); radio.type = 'radio'; radio.name = `agent-question-choice-${serial}-${index}`;
        radio.value = String(optionIndex);
        const content = element('span'); content.append(element('strong', '', option.label));
        if (option.description) content.append(element('small', '', option.description));
        label.append(radio, content); options.append(label); inputs.push(radio);
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          text.value = option.label;
          session.error = ''; paint(session);
        });
      }
      if (item.options.length) fieldset.append(options);
      text.addEventListener('input', () => {
        for (const radio of options.querySelectorAll('input')) radio.checked = false;
        session.error = ''; // Do not repaint the live status region on every key.
        session.errorNode.textContent = '';
      });
      inputs.push(text); fields.push({ id: item.id, text });
      fieldset.append(text); form.append(fieldset);
    }
    let noteFields;
    if (createNoteFields) {
      const noteSection = element('details', 'agent-question-notes');
      noteSection.append(element('summary', '', 'NOTE for this reply'));
      noteSection.append(element('p', '', 'These notes apply only to this reply. To change future prompts, use the task’s NOTE settings.'));
      const noteHost = element('div', 'task-note-fields'); noteSection.append(noteHost); form.append(noteSection);
      noteFields = createNoteFields(noteHost);
      noteFields.set(detail.promptNotes || detail.job?.promptNotes || detail.message?.questionContext?.promptNotes || []);
    }
    const error = element('p', 'agent-question-error'); error.setAttribute('role', 'alert');
    const footer = element('footer', 'agent-question-footer');
    const cancel = element('button', 'agent-question-cancel', 'Cancel this request'); cancel.type = 'button';
    const submit = element('button', 'primary-button agent-question-submit', 'Send reply'); submit.type = 'submit';
    footer.append(cancel, submit); form.append(error, footer); card.append(header, status, form);
    const session = { scope, taskId, questionId: question.id, detail, card, title, status, form, inputs, fields, noteFields, submit, cancel, error: '', errorNode: error,
      busy: false, busyOperation: null, accepted: false, cancelled: false, cancelRequestId: null, attempts: new Map(), host: null };
    cancel.addEventListener('click', async () => {
      if (session.busy || session.accepted || session.cancelled) return;
      if (!isCurrent(session.scope, session.taskId)) {
        session.error = 'Open the original chat to cancel this request. Your answers are kept here.'; paint(session); return;
      }
      // A retry must target the same cancellation, even if draft answers change.
      session.cancelRequestId ||= randomUUID();
      const request = { requestId: session.cancelRequestId, taskId: session.taskId, questionId: session.questionId };
      session.busy = true; session.busyOperation = 'cancel'; session.error = ''; paint(session);
      try {
        const result = await api('/api/agents/questions/cancel', { method: 'POST', body: request });
        session.cancelled = true;
        // The backend receipt, not a click or a status guess, ends this card.
        if (session.host?.firstChild === card) session.host.replaceChildren();
        try { await onCancelled(result, { scope: session.scope, taskId: session.taskId, questionId: session.questionId }); }
        catch { session.error = 'Your request was cancelled. Refresh this chat to see its latest status.'; }
      } catch (error) { session.error = error.message || 'Could not cancel this request. Your answers are kept here.'; }
      finally { session.busy = false; session.busyOperation = null; paint(session); }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (session.busy || session.accepted || session.cancelled) return;
      if (!isCurrent(session.scope, session.taskId)) {
        session.error = 'Open the original chat to send this reply. Your answers are kept here.'; paint(session); return;
      }
      if (session.detail.active) { session.error = 'Wait for this response to finish before sending your reply.'; paint(session); return; }
      const answers = fields.map((field) => ({ id: field.id, answer: field.text.value.trim() }));
      const empty = answers.findIndex((answer) => !answer.answer);
      if (empty >= 0) { session.error = 'Please answer each question before sending.'; paint(session); fields[empty].text.focus(); return; }
      let promptNotes;
      try { promptNotes = noteFields?.get(); }
      catch (error) { session.error = error.message; paint(session); return; }
      const fingerprint = JSON.stringify({ answers, ...(promptNotes ? { promptNotes } : {}) });
      if (!session.attempts.has(fingerprint)) session.attempts.set(fingerprint, randomUUID());
      const request = { requestId: session.attempts.get(fingerprint), taskId: session.taskId, questionId: session.questionId, answers, ...(promptNotes ? { promptNotes } : {}) };
      session.busy = true; session.busyOperation = 'answer'; session.error = ''; paint(session);
      try {
        const job = await api('/api/agents/questions/answer', { method: 'POST', body: request });
        session.accepted = true;
        // A UI-refresh failure must not turn an accepted answer into another
        // dispatch. Keep the receipt/session accepted even if presentation fails.
        try { await onAnswered(job, { scope: session.scope, taskId: session.taskId, questionId: session.questionId }); }
        catch { session.error = 'Your reply was sent. Refresh this chat to see the continuing response.'; }
      } catch (error) { session.error = error.message || 'Could not send the reply. Your answers are kept here.'; }
      finally { session.busy = false; session.busyOperation = null; paint(session); }
    });
    paint(session);
    return session;
  }
  return {
    render(host, { scope, taskId, detail }) {
      if (!host) return;
      if (!taskId || !detail?.question) { if (host.firstChild) host.replaceChildren(); return; }
      const question = normalizeAgentQuestion(detail.question);
      if (!question) { if (host.firstChild) host.replaceChildren(); return; }
      const key = keyFor(taskId, question.id);
      let session = sessions.get(key);
      if (!session) { session = build(scope, taskId, { ...detail, question }); sessions.set(key, session); }
      session.host = host;
      session.detail = { ...detail, question };
      if (session.accepted || session.cancelled) { if (host.firstChild) host.replaceChildren(); return; }
      paint(session);
      if (host.firstChild !== session.card) host.replaceChildren(session.card);
    },
    answered(taskId, questionId) { return Boolean(sessions.get(keyFor(taskId, questionId))?.accepted); },
    cancelled(taskId, questionId) { return Boolean(sessions.get(keyFor(taskId, questionId))?.cancelled); },
    isSending(taskId) { return [...sessions.values()].some((session) => session.taskId === taskId && session.busy); },
  };
}
