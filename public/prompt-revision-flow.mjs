const fresh = { dedupe: false, cache: "no-store" };
const same = (left, right) => JSON.stringify(left ?? []) === JSON.stringify(right ?? []);

// One lifecycle for Edit and composer retries. In particular, a saved draft's
// durable run ID is not a new composer request ID, even after a failed launch.
export function createPromptRevisionFlow({ api, coordinate, isCurrent, validate, chooseScope,
  accept, dispatch, present, createRequestId = () => crypto.randomUUID() }) {
  const busy = new Set();
  const attempts = new Map();
  const check = task => { if (!isCurrent(task)) throw new Error("Return to the original chat before resending this edit."); };
  async function submit(input) {
    let { task, message, prompt, promptNotes, requestId = createRequestId(), onProgress } = input;
    if (busy.has(task.id)) return { status: "busy" };
    busy.add(task.id);
    try {
      check(task); validate(task);
      const attemptKey = `${task.id}:${requestId}`;
      const previous = attempts.get(attemptKey);
      if (previous?.task?.revisionDraft) {
        task = previous.task;
        message = { ...message, content: task.revisionDraft.prompt, pendingRevision: true };
      }
      const expectedRevisionCount = task.revisionCount || 0;
      const current = await api(`/api/ai-tasks/${encodeURIComponent(task.id)}`, fresh);
      check(task);
      const expectedRunRequestId = task.revisionDraft?.runRequestId;
      const replayPatch = message.pendingRevision && previous?.body
        && previous.body.expectedRunRequestId === expectedRunRequestId && previous.body.prompt === prompt
        && same(previous.body.promptNotes, promptNotes);
      if (message.pendingRevision) {
        if (!current.revisionDraft) {
          if (expectedRunRequestId && current.revisionOf?.runRequestId === expectedRunRequestId && current.revisionCount === task.revisionCount
            && prompt === task.revisionDraft.prompt && same(promptNotes ?? task.revisionDraft.promptNotes, task.revisionDraft.promptNotes)) {
            const result = { status: "started", task: current, alreadySubmitted: true };
            await present(result); return result;
          }
          throw new Error("This revised request already started or changed. Your text is kept; reopen Edit from the current chat.");
        }
        if ((!replayPatch && current.revisionDraft.runRequestId !== expectedRunRequestId) || (current.revisionCount || 0) !== expectedRevisionCount)
          throw new Error("This revised draft changed. Your text is kept; reopen Edit from the current chat.");
      }
      const scopeChange = replayPatch ? previous.scopeChange : await chooseScope(task);
      if (scopeChange === null) return { status: "cancelled" };
      check(task);
      // A different explicitly confirmed scope is a different POST operation.
      const scopeKey = JSON.stringify(scopeChange);
      if (previous) requestId = previous.scopeKey !== scopeKey ? createRequestId() : previous.requestId || requestId;
      attempts.set(attemptKey, { ...previous, scopeKey, requestId });
      const body = message.pendingRevision
        ? { expectedPrompt: message.content, expectedRevisionCount, expectedRunRequestId, prompt }
        : { requestId, expectedRevisionCount, messageId: message.id, expectedContent: message.content, prompt };
      if (promptNotes !== undefined) body.promptNotes = promptNotes;
      Object.assign(body, scopeChange);
      attempts.set(attemptKey, { ...previous, scopeKey, requestId, body, scopeChange });
      const mutate = async () => {
        try {
          return await api(`/api/ai-tasks/${encodeURIComponent(task.id)}/${message.pendingRevision ? "revision-draft" : "revisions"}`,
            { method: message.pendingRevision ? "PATCH" : "POST", body });
        } catch (error) {
          if (!message.pendingRevision || error.status) throw error;
          // A lost PATCH response may have saved a new ID. Recover only the
          // exact requested state; never reinterpret a different client's edit.
          const observed = await api(`/api/ai-tasks/${encodeURIComponent(task.id)}`, fresh).catch(() => null);
          const expectedIds = scopeChange.repositoryIds?.length ? scopeChange.repositoryIds : scopeChange.resolvedRepositoryIds || task.repositoryIds;
          if (!observed?.revisionDraft || (observed.revisionCount || 0) !== expectedRevisionCount
            || observed.revisionDraft.prompt !== prompt
            || !same(observed.revisionDraft.promptNotes, promptNotes ?? task.revisionDraft.promptNotes)
            || !same(observed.revisionDraft.attachments, task.revisionDraft.attachments)
            || !same(observed.repositoryIds, expectedIds)) throw error;
          return { task: observed, attachments: observed.revisionDraft.attachments || [] };
        }
      };
      // Pending drafts have already stopped/archived their predecessor. Never
      // cancel again: a lost /run response may still be preparing with this ID.
      const revision = message.pendingRevision || (current.revisionCount || 0) !== expectedRevisionCount
        ? await mutate() : await coordinate({ ...input, task, mutate, onProgress });
      const revised = revision.task;
      if (revised?.id !== task.id) throw new Error("Argus returned a different chat. Reload before retrying this edit.");
      if (accept(revised) === false) throw new Error("This chat was revised again while saving. Your previous version is preserved; reopen Edit from the current chat.");
      attempts.set(attemptKey, { task: revised, scopeKey, requestId });
      if (attempts.size > 100) attempts.delete(attempts.keys().next().value);
      const alreadySubmitted = revision.replayed && (!revised.revisionDraft || revised.revisionOf?.revisionId !== revision.revisionId);
      if (!alreadySubmitted && !revised.revisionDraft?.runRequestId)
        throw new Error("The edit was saved without a pending run identity. Reload this chat before retrying.");
      const attachments = revised.revisionDraft?.attachments ?? revision.attachments ?? message.attachments ?? [];
      let startError;
      try {
        if (!alreadySubmitted) await dispatch({
          requestId: revised.revisionDraft.runRequestId, taskId: revised.id, expectedRevisionCount: revised.revisionCount || 0,
          repositoryId: revised.repositoryId, repositoryIds: [...(revised.repositoryIds || [])],
          providerId: revised.provider, mode: revised.mode, modelSettings: { model: revised.model, effort: revised.effort, speed: revised.speed },
          contextMode: revised.contextMode, prompt: revised.revisionDraft.prompt,
          promptNotes: revised.revisionDraft.promptNotes ?? promptNotes ?? message.promptNotes ?? [],
          attachments, attachmentIds: attachments.map(item => item.id), createdAt: new Date().toISOString(),
        });
      } catch (error) { startError = error; }
      const result = { status: startError ? "saved" : "started", task: revised, alreadySubmitted, error: startError };
      await present(result);
      return result;
    } finally { busy.delete(input.task.id); }
  }
  return { submit, isBusy: taskId => busy.has(taskId) };
}
