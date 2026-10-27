import { renderChatMessage } from "./message-renderer.js";

const active = job => Boolean(job && (["starting", "running", "paused"].includes(job.status) || job.completionPending));
const busy = detail => active(detail?.job) || detail?.status === "preparing";
const text = value => typeof value === "string" ? value : "";
const route = id => `/api/repositories/${encodeURIComponent(id)}/code-discussions`;
let nextId = 0;

/** A repository-local, nonmodal discussion. Closing never cancels an AI request. */
export function createIdeCodeChat({ host, document: doc = host.ownerDocument, api, getModelSettings = () => ({}),
  onChanged = () => {}, onOpenTask, onError = () => {},
  randomUUID = () => crypto.randomUUID(), pollDelay = 1200 }) {
  const sessions = new Map(), pending = new Map();
  let view, epoch = 0, readSequence = 0, controller, timer, disposed = false, opener;
  const id = `ide-code-chat-${++nextId}`;
  const node = (tag, className, content) => {
    const result = doc.createElement(tag);
    if (className) result.className = className;
    if (content !== undefined) result.textContent = content;
    return result;
  };
  const button = (label, className, handler) => {
    const result = node("button", className, label); result.type = "button";
    result.addEventListener("click", handler); return result;
  };
  const labelled = (label, input) => {
    const wrapper = node("label", "ide-code-chat-field"); wrapper.append(node("span", "", label), input); return wrapper;
  };
  const card = node("section", "ide-code-chat"); card.hidden = true;
  card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "false"); card.setAttribute("aria-labelledby", `${id}-title`);
  const header = node("header", "ide-code-chat-header"), heading = node("h3", "", "Code discussion"); heading.id = `${id}-title`;
  const full = button("Open chat ↗", "ide-code-chat-open", async () => {
    const session = view;
    if (!session?.taskId) return;
    try { await onOpenTask?.({ repositoryId: session.repositoryId, taskId: session.taskId, discussionId: session.discussionId }); }
    catch (error) { report(session, error); }
  }); full.title = "Open the repository’s Code discussions task";
  const closeButton = button("×", "ide-code-chat-close", () => close()); closeButton.setAttribute("aria-label", "Close code discussion"); closeButton.title = "Close · Esc (request keeps running)";
  header.append(heading, full, closeButton);
  const selectors = node("div", "ide-code-chat-selectors");
  const select = node("select"); select.setAttribute("aria-label", "Code discussion");
  select.addEventListener("change", () => {
    const current = view;
    if (current) void open({ repositoryId: current.repositoryId, ...(select.value ? { discussionId: select.value } : { anchor: current.newAnchor }), position: current.position });
  });
  selectors.append(labelled("Discussion", select));
  const body = node("div", "ide-code-chat-body");
  const snapshot = node("details", "ide-code-chat-snapshot"), summary = node("summary");
  const source = node("pre"), snapshotNote = node("p", "ide-code-chat-snapshot-note"); snapshot.append(summary, snapshotNote, source);
  const transcript = node("div", "ide-code-chat-transcript"); transcript.setAttribute("aria-label", "Discussion messages");
  body.append(snapshot, transcript);
  const nexus = node("select"); nexus.setAttribute("aria-label", "Optional Nexus context");
  nexus.addEventListener("change", () => {
    if (view) {
      view.nexusTaskId = nexus.value || null; view.nexusEdited = true;
      contextTitle.textContent = view.nexusTaskId ? "Nexus context · linked" : "Nexus context · optional";
    }
  });
  const context = node("details", "ide-code-chat-context"), contextTitle = node("summary", "", "Nexus context · optional");
  const scopeNote = node("p", "ide-code-chat-scope", "Only the chosen Nexus chat is added as context. Replies stay in this repository’s Code discussions task.");
  const nexusError = node("p", "ide-code-chat-error");
  context.append(contextTitle, labelled("Link a Nexus chat", nexus), scopeNote, nexusError);
  const form = node("form", "ide-code-chat-composer");
  const prompt = node("textarea"); prompt.rows = 3; prompt.maxLength = 32_000;
  prompt.placeholder = "Ask about this code…"; prompt.setAttribute("aria-label", "Message about selected code");
  prompt.addEventListener("input", () => { if (view) { view.draft = prompt.value; paintControls(); } });
  prompt.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); void submit(); }
  });
  const status = node("p", "ide-code-chat-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const errorNode = node("p", "ide-code-chat-error"); errorNode.setAttribute("role", "alert");
  const modelLabel = node("p", "ide-code-chat-model");
  const actions = node("div", "ide-code-chat-actions");
  const refreshButton = button("Refresh", "ide-code-chat-refresh", () => refresh());
  const retry = button("Retry same request", "ide-code-chat-retry", () => submit(true));
  const stop = button("Stop", "ide-code-chat-stop", () => stopRequest());
  const send = node("button", "ide-code-chat-send", "Send"); send.type = "submit"; send.title = "Send · ⌘Enter / Ctrl+Enter";
  actions.append(refreshButton, retry, stop, send); form.append(context, prompt, status, errorNode, actions, modelLabel);
  form.addEventListener("submit", event => { event.preventDefault(); void submit(); });
  card.append(header, selectors, body, form); host.append(card);
  card.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(); }
  });

  function stopReads() {
    epoch++; readSequence++; controller?.abort(); controller = null; clearTimeout(timer); timer = null;
  }
  function isCurrent(session, revision = epoch) { return !disposed && !card.hidden && view === session && epoch === revision; }
  function notify(session) {
    if (disposed) return;
    try {
      onChanged({ repositoryId: session.repositoryId, taskId: session.taskId, discussionId: session.discussionId,
        discussion: session.detail?.discussion, job: session.detail?.job });
    } catch (error) {
      // A host refresh error cannot turn a confirmed submission into a retry.
      try { onError(error); } catch { /* The persisted request remains accepted. */ }
    }
  }
  function report(session, error) {
    if (error?.name === "AbortError") return;
    session.error = error?.message || "The discussion could not be loaded.";
    if (isCurrent(session)) { paintControls(); onError(error); }
  }
  function position() {
    if (card.hidden) return;
    const width = host.clientWidth || 420, height = host.clientHeight || 640, inset = Math.min(8, width / 4);
    const cardWidth = Math.min(420, width - inset * 2), cardHeight = Math.min(640, height - inset * 2);
    card.style.width = `${Math.max(0, cardWidth)}px`; card.style.maxHeight = `${Math.max(0, cardHeight)}px`;
    card.style.left = `${Math.max(inset, Math.min(view?.position?.left ?? width - cardWidth - inset, width - cardWidth - inset))}px`;
    card.style.top = `${Math.max(inset, Math.min(view?.position?.top ?? 50, height - Math.min(card.offsetHeight || cardHeight, cardHeight) - inset))}px`;
  }
  const Observer = doc.defaultView?.ResizeObserver || globalThis.ResizeObserver;
  const observer = Observer ? new Observer(position) : null; observer?.observe(host);
  function option(value, label) { const item = node("option", "", label); item.value = value; return item; }
  function discussionLabel(item) {
    const anchor = item.anchor;
    return text(item.title) || `${text(anchor?.path).split("/").at(-1) || "Code discussion"}${anchor?.line ? `:${anchor.line}` : ""}${anchor?.symbol ? ` · ${anchor.symbol}` : ""}`;
  }
  function paintSelectors() {
    const current = view; if (!current) return;
    select.replaceChildren(option("", current.newAnchor ? "New discussion at this selection" : "Select a saved discussion…"));
    const discussions = [...(current.discussions || [])];
    if (current.detail?.discussion && !discussions.some(item => item.id === current.discussionId)) discussions.unshift(current.detail.discussion);
    for (const item of discussions) if (item.id) select.append(option(item.id, discussionLabel(item)));
    select.value = current.discussionId || "";
    select.disabled = current.loading && !discussions.length;
    nexus.replaceChildren(option("", "No Nexus context"));
    for (const task of current.nexusTasks || []) if (task.id) nexus.append(option(task.id, text(task.title) || "Untitled Nexus chat"));
    if (current.nexusTaskId && !(current.nexusTasks || []).some(task => task.id === current.nexusTaskId)) nexus.append(option(current.nexusTaskId, "Previously linked Nexus chat"));
    nexus.value = current.nexusTaskId || "";
    nexusError.textContent = current.nexusError || "";
    contextTitle.textContent = current.nexusTaskId ? "Nexus context · linked" : "Nexus context · optional";
  }
  function paintTranscript() {
    const current = view; if (!current) return;
    const anchor = current.detail?.discussion?.anchor || current.anchor;
    snapshot.hidden = !anchor;
    if (anchor) {
      const side = anchor.side === "before" ? "Before diff" : anchor.side === "after" ? "After diff" : anchor.unsaved ? "Unsaved selection" : "Source selection";
      summary.textContent = `${side} · ${anchor.path}:${anchor.line}${anchor.endLine > anchor.line ? `–${anchor.endLine}` : ""}`;
      source.textContent = text(anchor.selection);
      snapshotNote.textContent = `Read-only ${current.discussionId ? "saved " : ""}snapshot${anchor.staged ? " · staged diff" : ""}. ${anchor.selectionTruncated ? "Selection was shortened; the saved range is larger." : "The file may have changed since this selection."}`;
    }
    const detail = current.detail || {}, messages = Array.isArray(detail.messages) ? detail.messages : [];
    const live = active(detail.job) ? text(detail.job.displayOutput) : "";
    const signature = JSON.stringify([current.discussionId, messages.map(({ id, role, content }) => ({ id, role, content })), live, current.loading]);
    if (current.transcriptSignature !== signature) {
      current.transcriptSignature = signature;
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 50;
      const nodes = [];
      for (const message of messages) {
        if (!["user", "assistant"].includes(message.role)) continue;
        const article = node("article", `ide-code-chat-message ide-code-chat-message-${message.role}`);
        const content = node("div", message.role === "user" ? "ide-code-chat-message-text" : "chat-message-content");
        if (message.role === "assistant") content.innerHTML = renderChatMessage(text(message.content));
        else content.textContent = text(message.content);
        article.append(node("strong", "ide-code-chat-speaker", message.role === "user" ? "You" : "Argus"), content);
        nodes.push(article);
      }
      if (live && !messages.some(message => message.role === "assistant" && message.content === live)) {
        const article = node("article", "ide-code-chat-message ide-code-chat-message-live");
        const content = node("div", "chat-message-content"); content.innerHTML = renderChatMessage(live);
        article.append(node("strong", "ide-code-chat-speaker", "Argus · working"), content); nodes.push(article);
      }
      if (!nodes.length) nodes.push(node("p", "ide-code-chat-empty", current.loading ? "Loading discussion…" : anchor
        ? "Ask a question about this snapshot. Your conversation is saved with this repository."
        : "Select code and choose Ask Argus to start a discussion, or reopen a saved discussion above."));
      transcript.replaceChildren(...nodes);
      if (nearBottom) body.scrollTop = body.scrollHeight;
    }
  }
  function paintControls() {
    const current = view; if (!current) return;
    const operation = pending.get(current.repositoryId), localOperation = operation?.session === current;
    const running = busy(current.detail), waiting = localOperation && operation.inFlight;
    send.disabled = Boolean(current.loading || operation || running || current.uncertain || (!current.anchor && !current.discussionId) || !current.draft.trim());
    prompt.disabled = Boolean(!current.anchor && !current.discussionId);
    nexus.disabled = Boolean(operation || running || current.uncertain);
    full.hidden = !onOpenTask; full.disabled = !current.taskId;
    stop.hidden = !running && !waiting; stop.disabled = Boolean(current.stopping);
    stop.textContent = current.stopping ? "Stopping…" : "Stop";
    retry.hidden = !current.uncertain; retry.disabled = Boolean(operation || running);
    refreshButton.hidden = !current.error || Boolean(current.uncertain); refreshButton.disabled = Boolean(current.loading);
    errorNode.textContent = current.error || "";
    const settings = getModelSettings(current.repositoryId) || {};
    modelLabel.textContent = `Read-only${settings.provider ? ` · ${settings.provider}` : ""}${settings.model ? ` / ${settings.model}` : ""}`;
    modelLabel.title = "Selected AI settings. This discussion can inspect code but cannot edit repository files.";
    status.textContent = current.stopping ? "Stopping this request…" : waiting ? "Preparing request… You can close this panel."
      : current.uncertain ? "Delivery is unconfirmed. Retry uses the same request ID; it will not create a second request."
      : operation ? "Another code discussion in this repository is preparing a request."
      : running ? (current.detail?.job?.status === "paused" ? "Waiting for your input. Open chat to continue." : current.detail?.status === "preparing" ? "Preparing request… You can close this panel." : "Argus is working… Closing this panel keeps the request running.")
      : (current.detail?.job?.status || current.detail?.status) === "failed" ? "Request failed. Your discussion is saved."
      : (current.detail?.job?.status || current.detail?.status) === "cancelled" ? "Request stopped. Your discussion is saved."
      : current.detail?.status === "interrupted" ? "Request interrupted. Your discussion is saved."
      : "Questions stay in this repository · ⌘Enter / Ctrl+Enter to send";
    card.setAttribute("aria-busy", String(Boolean(current.loading)));
  }
  function paint() { paintSelectors(); paintTranscript(); paintControls(); position(); }
  function accept(session, detail, announceTerminal = false) {
    const wasBusy = busy(session.detail);
    session.detail = detail; session.taskId = detail.taskId || session.taskId;
    session.discussionId = detail.discussion?.id || session.discussionId;
    session.anchor = detail.discussion?.anchor || session.anchor;
    if (!session.nexusEdited) session.nexusTaskId = detail.discussion?.nexusTaskId || null;
    if (session.discussionId && !disposed) sessions.set(`${session.repositoryId}:id:${session.discussionId}`, session);
    if (announceTerminal && wasBusy && !busy(detail)) notify(session);
  }
  function schedule(session) {
    clearTimeout(timer); timer = null;
    if (isCurrent(session) && busy(session.detail)) timer = setTimeout(() => void loadDetail(session), pollDelay);
  }
  async function loadDetail(session) {
    if (!isCurrent(session) || !session.discussionId) return;
    const revision = epoch, sequence = ++readSequence;
    try {
      const detail = await api(`${route(session.repositoryId)}/${encodeURIComponent(session.discussionId)}`, { method: "GET", signal: controller.signal, dedupe: false });
      if (!isCurrent(session, revision) || sequence !== readSequence) return;
      accept(session, detail, true); session.loading = false; session.error = text(detail.error); paint(); schedule(session);
    } catch (error) {
      if (!isCurrent(session, revision) || sequence !== readSequence) return;
      session.loading = false; report(session, error); paintControls();
    }
  }
  async function load(session) {
    const revision = epoch;
    session.loading = true; session.error = ""; paint();
    const nexusRead = api("/api/ai-tasks?scope=global&repositoryId=global", { method: "GET", signal: controller.signal }).then(tasks => {
      if (!isCurrent(session, revision)) return;
      session.nexusTasks = Array.isArray(tasks) ? tasks : []; session.nexusError = ""; paintSelectors();
    }).catch(error => {
      if (!isCurrent(session, revision) || error?.name === "AbortError") return;
      session.nexusError = "Nexus chats could not be loaded. You can still ask without linking one."; paintSelectors();
    });
    try {
      const data = await api(route(session.repositoryId), { method: "GET", signal: controller.signal, dedupe: false });
      if (!isCurrent(session, revision)) return;
      session.discussions = Array.isArray(data.discussions) ? data.discussions : []; session.taskId = data.taskId || session.taskId;
      if (session.discussionId) await loadDetail(session);
      else { session.loading = false; paint(); }
    } catch (error) { if (isCurrent(session, revision)) { session.loading = false; report(session, error); paint(); } }
    await nexusRead;
  }
  async function refresh() {
    if (!view || disposed) return;
    stopReads(); controller = new AbortController(); return load(view);
  }
  async function open({ repositoryId, anchor, discussionId, position: at } = {}) {
    if (disposed || !repositoryId) return false;
    stopReads(); controller = new AbortController();
    if (card.hidden) opener = doc.activeElement;
    const key = `${repositoryId}:${discussionId ? `id:${discussionId}` : anchor ? `anchor:${JSON.stringify(anchor)}` : "list"}`;
    let session = sessions.get(key);
    if (!session) { session = { repositoryId, discussionId, anchor, newAnchor: anchor, draft: "", nexusTaskId: null, detail: null }; sessions.set(key, session); }
    if (anchor) session.newAnchor = anchor;
    session.position = at; session.transcriptSignature = null; view = session; card.hidden = false;
    prompt.value = session.draft; context.open = Boolean(session.nexusTaskId); paint();
    (anchor || discussionId ? prompt : select).focus({ preventScroll: true });
    await load(session); return true;
  }
  function close(restoreFocus = true) {
    const focused = card.contains(doc.activeElement);
    stopReads(); card.hidden = true; view = null;
    if (restoreFocus && focused && opener?.isConnected) opener.focus({ preventScroll: true });
  }
  async function submit(retrying = false) {
    const session = view;
    if (!session || disposed || session.loading || pending.has(session.repositoryId) || busy(session.detail)) return;
    if (!retrying && (session.uncertain || !session.draft.trim() || (!session.anchor && !session.discussionId))) return;
    const settings = getModelSettings(session.repositoryId) || {};
    const body = retrying ? session.uncertain : { ...(session.discussionId ? { discussionId: session.discussionId } : { anchor: session.anchor }),
      prompt: session.draft.trim(), nexusTaskId: session.nexusTaskId || null, requestId: randomUUID(),
      ...Object.fromEntries(["provider", "model", "effort", "speed"].filter(key => settings[key] != null).map(key => [key, settings[key]])) };
    if (!body) return;
    const operation = { session, body, draft: retrying ? session.uncertainDraft : session.draft, inFlight: true, cancelled: false };
    pending.set(session.repositoryId, operation); session.error = ""; paintControls();
    try {
      // Deliberately no view-owned signal: closing/switching does not cancel submission.
      const detail = await api(`${route(session.repositoryId)}/ask`, { method: "POST", body });
      session.uncertain = null; session.nexusEdited = false;
      if (!["failed", "cancelled", "interrupted"].includes(detail.status) && session.draft === operation.draft) session.draft = "";
      accept(session, detail); session.error = text(detail.error);
      if (operation.cancelled && active(detail.job)) {
        try { await cancelJob(detail.job.id); } catch (error) { report(session, error); }
      }
      notify(session);
      if (isCurrent(session)) { readSequence++; session.loading = false; prompt.value = session.draft; paint(); schedule(session); }
    } catch (error) {
      // HTTP validation failures did not accept the request. Transport failures
      // may have done so: retain the immutable body and idempotency key for retry.
      if (!error?.status || error.status >= 500) { session.uncertain = body; session.uncertainDraft = operation.draft; }
      else session.uncertain = null;
      report(session, error);
    } finally {
      operation.inFlight = false;
      if (pending.get(session.repositoryId) === operation) pending.delete(session.repositoryId);
      if (view?.repositoryId === session.repositoryId) paintControls();
    }
  }
  const cancelHeaders = { "X-Argus-Cancel-Control": "ide-code-discussion-stop" };
  const cancelJob = jobId => api(`/api/agents/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", headers: cancelHeaders });
  async function stopRequest() {
    const session = view; if (!session || session.stopping) return;
    const operation = pending.get(session.repositoryId);
    const preparing = operation?.session === session && operation.inFlight;
    const requestId = preparing ? operation.body.requestId : session.detail?.status === "preparing" ? session.detail.requestId : null;
    if (!requestId && !active(session.detail?.job)) return;
    session.stopping = true; session.error = ""; paintControls();
    try {
      if (requestId) {
        if (preparing) operation.cancelled = true;
        await api(`/api/agents/preparations/${encodeURIComponent(requestId)}`, { method: "DELETE", headers: cancelHeaders });
      } else await cancelJob(session.detail.job.id);
      notify(session);
      if (isCurrent(session) && session.discussionId) await loadDetail(session);
    } catch (error) { report(session, error); }
    finally { session.stopping = false; if (isCurrent(session)) paintControls(); }
  }
  return { open, close, deactivate: () => close(false), dispose() { close(false); disposed = true; observer?.disconnect(); card.remove(); sessions.clear(); } };
}
