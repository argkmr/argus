import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { latestTaskQuestion } from "../public/agent-question-cards.mjs";
import { createPromptNotesStore } from "../public/task-prompt-notes.mjs";
import { composerDraftFunctions } from "./helpers/composer-draft-functions.mjs";
import { createQueuedPromptSteering } from "../public/queued-prompt-steering.mjs";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function source(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(app);
  assert(match, `Missing ${name}`);
  return app.slice(match.index, app.indexOf("\n}", match.index) + 2);
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const item = (id = "queued-one", extra = {}) => ({ requestId: id, taskId: "task-a", repositoryId: "repo-a", repositoryIds: [], providerId: "codex", providerName: "Codex", mode: "edit", modelSettings: { model: "chosen", effort: "high", speed: "fast" }, contextMode: "fresh", prompt: `Prompt ${id}`, attachments: [{ id: "file-a" }], attachmentIds: ["file-a"], status: "queued", ...extra });

function harness({ processQueue = false, selectTask = false, api: handler, waitForPredecessor, refreshError = false } = {}) {
  const calls = [], renders = [], clears = [], pumps = [], waits = [], toasts = [];
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { value: "", classList: { add() {}, remove() {} }, focus() {} });
    return elements.get(selector);
  };
  element("#agent-prompt").value = "Original queued prompt";
  element("#global-agent-prompt").value = "Global queued prompt";
  for (const selector of ["#agent-provider", "#global-agent-provider"]) element(selector).value = "codex";
  for (const selector of ["#agent-mode", "#global-agent-mode"]) element(selector).value = "edit";
  const state = { activeRepository: { id: "repo-a" }, activeTaskByRepository: { "repo-a": "task-a" }, activeGlobalTaskId: "global-task", providers: [{ id: "codex", name: "Codex", authenticated: true }], repositoryPromptQueues: {}, globalPromptQueues: {}, repositoryAttachments: { "repo-a": [{ id: "file-a" }] }, globalAttachments: [{ id: "global-file" }], repositoryJobs: [{ id: "predecessor", taskId: "task-a", status: "running" }], globalJobs: [{ id: "global-predecessor", taskId: "global-task", status: "running" }], promptQueueProcessors: new Set(), promptQueuesLoaded: new Set(), promptQueueSaves: new Set(), promptQueueSaveRetries: new Map() };
  let sequence = 0;
  state.repositoryDrafts = {};
  const notes = createPromptNotesStore();
  const notesContext = (scope) => ({ scope, repositoryId: scope === "global" ? "global" : state.activeRepository.id, taskId: scope === "global" ? state.activeGlobalTaskId : state.activeTaskByRepository[state.activeRepository.id] });
  const context = {
    state, $, latestTaskQuestion, setTimeout, crypto: { randomUUID: () => `request-${++sequence}` }, window: { argusNexusRepositoryIds: ["repo-c", "repo-b"] },
    agentQuestionCards: { isSending: () => false },
    taskPromptNotes: { capture: (scope) => notes.capture(notesContext(scope)), submitted: (snapshot, taskId) => notes.submitted(snapshot, taskId) },
    activeTaskId: (scope) => scope === "global" ? state.activeGlobalTaskId : state.activeTaskByRepository[state.activeRepository.id],
    scopedAttachments: (scope) => scope === "global" ? state.globalAttachments : state.repositoryAttachments[state.activeRepository.id] || [],
    runningAgentJob: (scope) => (scope === "global" ? state.globalJobs : state.repositoryJobs).find((job) => job.status === "running"),
    agentJobIsActive: (job) => ["starting", "running", "paused"].includes(job.status),
    providerCanRun: () => true, modelSelectionError: () => "", validateComposerContext: () => true, revisionIsBusy: () => false,
    selectedModelSettings: () => ({ model: "chosen", effort: "high", speed: "fast" }), selectedContextMode: () => "fresh",
    resizeAgentComposer() {},
    renderContextTray() {}, appendOptimisticUserMessage: (...args) => renders.push(args), toast: (...args) => toasts.push(args),
    processPromptQueue: (...args) => pumps.push(args),
    waitForQueuedPredecessor: async (id) => { waits.push(id); await waitForPredecessor?.(id); },
    refreshTasks: async () => { if (refreshError) throw new Error("Refresh disconnected"); }, selectTask: async () => {},
    showGlobalJob() {}, showRepositoryJob() {}, renderAgentTabs() {}, renderTaskConversation: (...args) => renders.push(args),
    showTaskWorkspace: () => true, setTaskPanelCollapsed() {}, renderTaskList() {}, restoreTaskModelSettings() {}, syncViewUrl() {},
    acceptChatTaskSnapshot: () => true, chatRevisionState: { acceptsJob: () => true },
    composerSubmission: () => null, setComposerPreparingState() {}, setComposerActionState() {}, confirm: () => true,
  };
  function $(selector) { return element(selector); }
  context.api = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body && structuredClone(options.body) });
    if (handler) { const result = await handler(url, options, context); if (result !== undefined) return result; }
    if (url === "/api/prompt-queue" && options.method === "POST") return { ...options.body, status: "queued" };
    if (url === "/api/prompt-queue/resume" && options.method === "POST") return context.queuedPrompts(options.body.taskId === "global-task" ? "global" : "repository", options.body.taskId).map(({ recovered, pauseReason, ...record }) => record);
    if (url.startsWith("/api/prompt-queue?")) return [];
    if (url.endsWith("/claim")) return { dispatchToken: "owned-token", status: "dispatching" };
    if (url === "/api/agents/run") return { id: `job-${calls.filter((call) => call.url === url).length}`, taskId: options.body.taskId, status: "running" };
    if (url.startsWith("/api/ai-tasks/")) return { id: url.split("/").at(-1), repositoryId: "repo-a", messages: [{ id: "user", role: "user", content: "Original" }] };
    return { ok: true };
  };
  vm.createContext(context);
  state.promptQueueHolds = new Map();
  const functions = [...composerDraftFunctions, "queuedPrompts", "queuedRequestFromComposer", "queueCurrentPrompt", "startQueuedPrompt", "handleSavedQueueAction", "holdQueuedPrompt", "saveQueuedPromptEdit"];
  if (processQueue) functions.push("processPromptQueue");
  if (selectTask) functions.push("selectTask");
  vm.runInContext(functions.map(source).join("\n"), context);
  const takeDraft = context.takeComposerDraft;
  context.takeComposerDraft = scope => { clears.push(scope); return takeDraft(scope); };
  return { context, state, calls, renders, clears, pumps, waits, toasts, element, notes, notesContext };
}

test("queued notes are frozen at enqueue and changing a one-off note changes retry identity", async () => {
  const h = harness({ api: (url) => { if (url === '/api/prompt-queue') throw new Error('Lost response'); } });
  const context = h.notesContext('repository');
  h.notes.override(context, [{ id: 'note-one', text: 'Original note', enabled: true }]);
  await h.context.queueCurrentPrompt('repository');
  h.notes.override(context, [{ id: 'note-one', text: 'Changed note', enabled: false }]);
  await h.context.queueCurrentPrompt('repository');
  const [first, second] = h.calls.filter(call => call.url === '/api/prompt-queue');
  assert.equal(first.body.promptNotes[0].text, 'Original note');
  assert.equal(second.body.promptNotes[0].text, 'Changed note');
  assert.equal(second.body.promptNotes[0].enabled, false);
  assert.notEqual(first.body.requestId, second.body.requestId);
});

test("queue dispatch carries its frozen notes and edits include a notes compare-and-swap", async () => {
  const original = [{ id: 'note-one', text: 'Original note', enabled: true }];
  const revised = [{ id: 'note-one', text: 'Revised note', enabled: false }];
  const request = item('with-notes', { promptNotes: original });
  const h = harness({ api: (url, options) => options.method === 'PATCH' ? { ...request, prompt: options.body.prompt, promptNotes: options.body.promptNotes } : undefined });
  await h.context.startQueuedPrompt('repository', request);
  assert.deepEqual(h.calls.find(call => call.url === '/api/agents/run').body.promptNotes, original);
  await h.context.saveQueuedPromptEdit({ scope: 'repository', request, prompt: 'Edited', promptNotes: revised });
  const patch = h.calls.find(call => call.method === 'PATCH');
  assert.deepEqual(patch.body.promptNotes, revised);
  assert.deepEqual(patch.body.expectedPromptNotes, original);
});

test("queue clears text and attachments immediately while double-click saves only once", async () => {
  const saved = deferred();
  const h = harness({ api: (url, options) => url === "/api/prompt-queue" && options.method === "POST" ? saved.promise : undefined });
  const first = h.context.queueCurrentPrompt("repository");
  const second = h.context.queueCurrentPrompt("repository");
  await settle();
  assert.equal(h.calls.length, 1); assert.equal(h.clears.length, 1);
  assert.equal(h.element("#agent-prompt").value, "");
  assert.equal(h.state.repositoryAttachments["repo-a"].length, 0);
  saved.resolve({ ...h.calls[0].body, status: "queued" }); await Promise.all([first, second]);
  assert.equal(h.clears.length, 1); assert.equal(h.pumps.length, 1);
  assert.equal(h.state.repositoryPromptQueues["task-a"].length, 1);
  assert.equal(h.state.repositoryAttachments["repo-a"].length, 0);
});

test("lost enqueue response preserves draft and reuses the request ID on unchanged retry", async () => {
  let attempt = 0;
  const h = harness({ api: (url, options) => { if (url === "/api/prompt-queue" && options.method === "POST" && ++attempt === 1) throw new Error("Lost save response"); } });
  await h.context.queueCurrentPrompt("repository");
  assert.equal(h.clears.length, 1); assert.equal(h.state.repositoryAttachments["repo-a"].length, 1);
  assert.equal(h.element("#agent-prompt").value, "Original queued prompt");
  await h.context.queueCurrentPrompt("repository");
  const saves = h.calls.filter((call) => call.url === "/api/prompt-queue");
  assert.equal(saves[0].body.requestId, saves[1].body.requestId);
  assert.equal(h.clears.length, 2);
});

test("new composer text and newly attached files survive an in-flight queue save", async () => {
  const saved = deferred();
  const h = harness({ api: (url, options) => url === "/api/prompt-queue" && options.method === "POST" ? saved.promise : undefined });
  const pending = h.context.queueCurrentPrompt("repository"); await settle();
  h.element("#agent-prompt").value = "New unsent draft";
  h.state.repositoryAttachments["repo-a"].push({ id: "new-file" });
  saved.resolve({ ...h.calls[0].body, status: "queued" }); await pending;
  assert.equal(h.element("#agent-prompt").value, "New unsent draft");
  assert.deepEqual(h.state.repositoryAttachments["repo-a"].map((file) => file.id), ["new-file"]);
});

for (const scope of ["global", "repository"]) test(`${scope}: a rejected queue save keeps newer input and exposes the original captured draft`, async () => {
  const response = deferred();
  const h = harness({ api: (url, options) => url === "/api/prompt-queue" && options.method === "POST" ? response.promise : undefined });
  const textarea = h.element(scope === "global" ? "#global-agent-prompt" : "#agent-prompt");
  const original = textarea.value;
  const attachments = scope === "global" ? h.state.globalAttachments : h.state.repositoryAttachments["repo-a"];
  const sentId = attachments[0].id;
  const pending = h.context.queueCurrentPrompt(scope);
  assert.equal(textarea.value, ""); assert.equal(attachments.length, 0);
  textarea.value = "New draft"; attachments.push({ id: "new-file" });
  response.reject(new Error("Queue save unavailable")); await pending;
  assert.equal(textarea.value, "New draft"); assert.equal(attachments[0].id, "new-file");
  const recovered = h.context.composerRecoveries(scope)[0];
  assert.equal(recovered.draft, original); assert.equal(recovered.attachments[0].id, sentId);
  assert.equal(h.state.promptQueueSaves.size, 0);
});

test("Nexus queue saves an immutable selected scope and leaves repository composer untouched", async () => {
  const h = harness(); await h.context.queueCurrentPrompt("global");
  const request = h.calls[0].body;
  assert.equal(request.repositoryId, "global"); assert.equal(request.taskId, "global-task");
  assert.deepEqual(request.repositoryIds, ["repo-c", "repo-b"]);
  assert.deepEqual(request.attachmentIds, ["global-file"]);
  assert.equal(request.modelSettings.model, "chosen");
  assert.equal(h.element("#agent-prompt").value, "Original queued prompt");
});

test("processors are single-flight and serialize successors behind the preceding job", async () => {
  const predecessor = deferred();
  const h = harness({ processQueue: true, waitForPredecessor: (id) => id === "predecessor" ? predecessor.promise : undefined });
  h.state.repositoryPromptQueues["task-a"] = [item(), item("queued-two")];
  const first = h.context.processPromptQueue("repository", "task-a", "predecessor");
  await h.context.processPromptQueue("repository", "task-a", "predecessor");
  await settle(); assert.equal(h.calls.filter((call) => call.url.endsWith("/claim")).length, 0);
  predecessor.resolve(); await first;
  assert.deepEqual(h.waits, ["predecessor", "job-1"]);
  assert.equal(h.calls.filter((call) => call.url.endsWith("/claim")).length, 2);
  assert.equal(h.calls.filter((call) => call.url === "/api/agents/run").length, 2);
  assert.equal(h.state.repositoryPromptQueues["task-a"].length, 0);
});

test("recovered or interrupted requests never auto-dispatch and interrupted queues cannot resume", async () => {
  const h = harness({ processQueue: true });
  for (const state of [{ recovered: true }, { status: "interrupted", recovered: true }]) {
    h.state.repositoryPromptQueues["task-a"] = [item("recovered", state)];
    await h.context.processPromptQueue("repository", "task-a");
  }
  await h.context.handleSavedQueueAction("repository", "task-a");
  assert.equal(h.calls.filter((call) => call.url.endsWith("/claim")).length, 0);
  assert.match(h.toasts.at(-1)[0], /interrupted request/);
});

test("durably cancelled queues stay paused even if the local recovered flag is absent", async () => {
  const h = harness({ processQueue: true });
  h.state.repositoryPromptQueues["task-a"] = [item("queued-one", { pauseReason: "question-cancelled" })];
  await h.context.processPromptQueue("repository", "task-a");
  assert.equal(h.calls.some((call) => call.url.endsWith("/claim") || call.url === "/api/agents/run"), false);
  assert.equal(h.state.repositoryPromptQueues["task-a"].length, 1);
});

test("question actions in flight pause the queue before claim and do not consume requests", async () => {
  const h = harness({ processQueue: true });
  h.context.agentQuestionCards.isSending = () => true;
  h.state.repositoryPromptQueues["task-a"] = [item()];
  await h.context.processPromptQueue("repository", "task-a");
  assert.equal(h.calls.some((call) => call.url.endsWith("/claim") || call.url === "/api/agents/run"), false);
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].recovered, true);
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].pauseReason, "question-action");
});

test("a cancellation beginning while claim is pending prevents dispatch and releases only its own failed-cancel claim", async () => {
  const claim = deferred();
  const h = harness({ processQueue: true, api: (url) => url.endsWith("/claim") ? claim.promise : url.startsWith("/api/prompt-queue?") ? [item("queued-one", { status: "interrupted" })] : undefined });
  h.state.repositoryPromptQueues["task-a"] = [item()];
  const pending = h.context.processPromptQueue("repository", "task-a"); await settle();
  h.context.agentQuestionCards.isSending = () => true;
  claim.resolve({ status: "dispatching", dispatchToken: "stale-token" }); await settle();
  assert.equal(h.calls.some((call) => call.url.endsWith("/interrupted")), false, "Do not race cancellation's queue barrier");
  h.context.agentQuestionCards.isSending = () => false; await pending;
  assert.equal(h.calls.some((call) => call.url === "/api/agents/run"), false);
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].recovered, true);
  assert.equal(h.calls.find((call) => call.url.endsWith("/interrupted")).body.dispatchToken, "stale-token");
});

test("successful cancellation retains a claim-race request as queued without reporting interruption", async () => {
  const claim = deferred();
  const h = harness({ processQueue: true, api: (url) => url.endsWith("/claim") ? claim.promise : url.startsWith("/api/prompt-queue?") ? [item("queued-one", { pauseReason: "question-cancelled" })] : undefined });
  h.state.repositoryPromptQueues["task-a"] = [item()];
  const pending = h.context.processPromptQueue("repository", "task-a"); await settle();
  h.context.agentQuestionCards.isSending = () => true; claim.resolve({ status: "dispatching", dispatchToken: "stale-token" }); await settle();
  h.state.repositoryPromptQueues["task-a"][0].pauseReason = "question-cancelled";
  h.context.agentQuestionCards.isSending = () => false; await pending;
  assert.equal(h.calls.some((call) => call.url === "/api/agents/run" || call.url.endsWith("/interrupted")), false);
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].status, "queued");
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].pauseReason, "question-cancelled");
});

test("Resume queue requires a successful server acknowledgement before unpausing or pumping", async () => {
  const response = deferred();
  const h = harness({ api: (url) => url === "/api/prompt-queue/resume" ? response.promise : undefined });
  h.state.repositoryPromptQueues["task-a"] = [item("queued-one", { recovered: true, pauseReason: "question-cancelled" })];
  const pending = h.context.handleSavedQueueAction("repository", "task-a"); await settle();
  await h.context.handleSavedQueueAction("repository", "task-a");
  assert.equal(h.calls.filter((call) => call.url === "/api/prompt-queue/resume").length, 1);
  assert.equal(h.pumps.length, 0); assert.equal(h.state.repositoryPromptQueues["task-a"][0].recovered, true);
  response.resolve([item()]); await pending;
  const resume = h.calls.find((call) => call.url === "/api/prompt-queue/resume");
  assert.deepEqual(resume.body, { taskId: "task-a" }); assert.equal(resume.method, "POST");
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].recovered, false); assert.equal(h.pumps.length, 1);
});

test("failed resume keeps cancellation-paused messages and cannot restart the chat", async () => {
  const h = harness({ api: (url) => { if (url === "/api/prompt-queue/resume") throw new Error("Resume failed"); } });
  h.state.repositoryPromptQueues["task-a"] = [item("queued-one", { recovered: true, pauseReason: "question-cancelled" })];
  await h.context.handleSavedQueueAction("repository", "task-a");
  assert.equal(h.pumps.length, 0); assert.equal(h.state.repositoryPromptQueues["task-a"][0].pauseReason, "question-cancelled");
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].recovered, true); assert.match(h.toasts.at(-1)[0], /Resume failed/);
});

test("Resume cannot race an in-flight cancellation", async () => {
  const h = harness(); h.context.agentQuestionCards.isSending = () => true;
  h.state.repositoryPromptQueues["task-a"] = [item("queued-one", { recovered: true })];
  await h.context.handleSavedQueueAction("repository", "task-a");
  assert.equal(h.calls.some((call) => call.url === "/api/prompt-queue/resume"), false); assert.equal(h.pumps.length, 0);
  assert.match(h.toasts.at(-1)[0], /cancellation to finish/);
});

test("losing claim does not mutate another client's dispatch journal", async () => {
  const h = harness({ processQueue: true, api: (url) => { if (url.endsWith("/claim")) throw new Error("Already claimed"); if (url.startsWith("/api/prompt-queue?")) return [item("queued-one", { status: "dispatching" })]; } });
  h.state.repositoryPromptQueues["task-a"] = [item()];
  await h.context.processPromptQueue("repository", "task-a");
  assert.equal(h.calls.filter((call) => call.url.endsWith("/interrupted")).length, 0);
  assert.equal(h.calls.filter((call) => call.url === "/api/agents/run").length, 0);
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].recovered, true);
});

test("lost run response retains an interrupted request with its owned claim token", async () => {
  const h = harness({ processQueue: true, api: (url) => { if (url === "/api/agents/run") throw new Error("Lost run response"); } });
  h.state.repositoryPromptQueues["task-a"] = [item()];
  await h.context.processPromptQueue("repository", "task-a");
  const report = h.calls.find((call) => call.url.endsWith("/interrupted"));
  assert.equal(report.body.dispatchToken, "owned-token");
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].status, "interrupted");
  await h.context.processPromptQueue("repository", "task-a");
  assert.equal(h.calls.filter((call) => call.url === "/api/agents/run").length, 1);
});

test("chat refresh failure after dispatch does not repeat a completed queue request", async () => {
  const h = harness({ processQueue: true, refreshError: true });
  h.state.repositoryPromptQueues["task-a"] = [item()];
  await h.context.processPromptQueue("repository", "task-a");
  assert.equal(h.calls.filter((call) => call.url === "/api/agents/run").length, 1);
  assert.equal(h.calls.filter((call) => call.url.endsWith("/interrupted")).length, 0);
  assert.equal(h.state.repositoryPromptQueues["task-a"].length, 0);
});

test("revision resend uses the run pipeline without queue claim credentials", async () => {
  const h = harness();
  const request = item("revision-request", { taskId: "fork-task" });
  await h.context.startQueuedPrompt("repository", request);
  const body = h.calls.find((call) => call.url === "/api/agents/run").body;
  assert.equal(body.taskId, "fork-task");
  assert.equal(body.queueRequestId, undefined); assert.equal(body.queueDispatchToken, undefined);
  assert.equal(h.calls.filter((call) => call.url.includes("prompt-queue")).length, 0);
});

test("reload marks saved requests paused and never starts a processor", async () => {
  const h = harness({ selectTask: true, api: (url) => url.startsWith("/api/prompt-queue?") ? [item()] : undefined });
  await h.context.selectTask("repository", "task-a");
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].recovered, true);
  assert.equal(h.pumps.length, 0);
});

test("a stale queue GET cannot overwrite a save that completed while loading the chat", async () => {
  const loading = deferred();
  const h = harness({ selectTask: true, api: (url) => url.startsWith("/api/prompt-queue?") ? loading.promise : undefined });
  const selecting = h.context.selectTask("repository", "task-a"); await settle();
  await h.context.queueCurrentPrompt("repository");
  const acceptedId = h.state.repositoryPromptQueues["task-a"][0].requestId;
  loading.resolve([]); await selecting;
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].requestId, acceptedId);
});

test("deleting the waiting head never claims its stale reference and preserves the next request", async () => {
  const predecessor = deferred();
  const h = harness({ processQueue: true, waitForPredecessor: () => predecessor.promise });
  h.state.repositoryPromptQueues["task-a"] = [item(), item("queued-two")];
  const processing = h.context.processPromptQueue("repository", "task-a", "predecessor");
  await h.context.handleSavedQueueAction("repository", "task-a", "queued-one");
  predecessor.resolve(); await processing;
  assert.deepEqual(h.calls.filter(call => call.url.endsWith("/claim")).map(call => call.url), ["/api/prompt-queue/queued-two/claim"]);
  assert.equal(h.calls.find(call => call.url === "/api/agents/run").body.prompt, "Prompt queued-two");
  assert.equal(h.state.promptQueueHolds.size, 0);
});

test("steering a queued item preserves FIFO and does not release waiting work before its active job", async () => {
  const predecessor = deferred();
  const h = harness({ processQueue: true, waitForPredecessor: () => predecessor.promise });
  const queue = h.state.repositoryPromptQueues["task-a"] = [item(), item("steered"), item("last")];
  const processing = h.context.processPromptQueue("repository", "task-a", "predecessor");
  const controller = createQueuedPromptSteering({
    api: async () => ({ accepted: true, requestId: "steered", jobId: "predecessor", turnId: "turn", task: { id: "task-a", messages: [] } }),
    getQueue: () => queue, getJob: () => ({ id: "predecessor", taskId: "task-a", repositoryId: "repo-a", provider: "codex", status: "running", nativeTurnId: "turn", steering: { supported: true, available: true } }),
    hold: id => h.context.holdQueuedPrompt(id), isCurrent: () => true,
  });
  await controller.steer("repository", "task-a", "steered");
  assert.deepEqual(queue.map(request => request.requestId), ["queued-one", "last"]);
  assert.equal(h.calls.some(call => call.url.endsWith("/claim") || call.url === "/api/agents/run"), false);
  predecessor.resolve(); await processing;
  assert.deepEqual(h.calls.filter(call => call.url.endsWith("/claim")).map(call => call.url), ["/api/prompt-queue/queued-one/claim", "/api/prompt-queue/last/claim"]);
  assert.equal(h.state.promptQueueHolds.size, 0);
});

test("queue predecessor wait includes completionPending after a terminal provider event", async () => {
  let calls = 0, waits = 0;
  const context = { api: async () => (++calls === 1 ? { status: "completed", completionPending: true } : { status: "completed", completionPending: false }),
    setTimeout: callback => { waits++; callback(); } };
  vm.createContext(context); vm.runInContext([source("agentJobIsActive"), source("waitForQueuedPredecessor")].join("\n"), context);
  await context.waitForQueuedPredecessor("predecessor");
  assert.equal(calls, 2); assert.equal(waits, 1);
});

test("an open queue edit pauses local dispatch and the edited prompt is sent once after closing", async () => {
  const h = harness({ processQueue: true });
  h.state.repositoryPromptQueues["task-a"] = [item()];
  const hold = h.context.holdQueuedPrompt("queued-one");
  const processing = h.context.processPromptQueue("repository", "task-a");
  await settle();
  assert.equal(h.calls.filter(call => call.url.endsWith("/claim")).length, 0);
  h.state.repositoryPromptQueues["task-a"][0].prompt = "Edited while waiting";
  hold.release(); await processing;
  const starts = h.calls.filter(call => call.url === "/api/agents/run");
  assert.equal(starts.length, 1); assert.equal(starts[0].body.prompt, "Edited while waiting");
});

for (const scope of ["repository", "global"]) test(`${scope} save edits only the exact queued prompt without consuming the composer`, async () => {
  const request = item("queued-one", scope === "global" ? { taskId: "global-task", repositoryId: "global" } : {});
  const h = harness({ api: (url, options) => options.method === "PATCH" ? { ...request, prompt: options.body.prompt } : undefined });
  const queues = scope === "global" ? h.state.globalPromptQueues : h.state.repositoryPromptQueues;
  queues[request.taskId] = [{ ...request, recovered: true }];
  await h.context.saveQueuedPromptEdit({ scope, request, prompt: "Revised message" });
  const patch = h.calls.find(call => call.method === "PATCH");
  assert.deepEqual(patch.body, { taskId: request.taskId, expectedPrompt: request.prompt, prompt: "Revised message" });
  assert.equal(queues[request.taskId][0].prompt, "Revised message");
  assert.equal(queues[request.taskId][0].recovered, true);
  assert.deepEqual(queues[request.taskId][0].attachmentIds, ["file-a"]);
  assert.equal(h.calls.some(call => call.url === "/api/agents/run"), false);
  assert.equal(h.element("#agent-prompt").value, "Original queued prompt");
  assert.equal(h.element("#global-agent-prompt").value, "Global queued prompt");
});

test("queue save failure leaves the old queue intact, and wrong-chat edits never mutate", async () => {
  const h = harness({ api: (url, options) => { if (options.method === "PATCH") throw new Error("Message already started"); } });
  h.state.repositoryPromptQueues["task-a"] = [item()];
  await assert.rejects(h.context.saveQueuedPromptEdit({ scope: "repository", request: item(), prompt: "New" }), /already started/);
  assert.equal(h.state.repositoryPromptQueues["task-a"][0].prompt, "Prompt queued-one");
  h.state.activeTaskByRepository["repo-a"] = "different";
  const calls = h.calls.length;
  await assert.rejects(h.context.saveQueuedPromptEdit({ scope: "repository", request: item(), prompt: "New" }), /original chat/);
  assert.equal(h.calls.length, calls);
});

test("a delete that loses a claim race retains the message and releases the local hold", async () => {
  const h = harness({ api: (url, options) => { if (options.method === "DELETE") throw new Error("Already dispatching"); } });
  h.state.repositoryPromptQueues["task-a"] = [item()];
  await h.context.handleSavedQueueAction("repository", "task-a", "queued-one");
  assert.equal(h.state.repositoryPromptQueues["task-a"].length, 1);
  assert.equal(h.state.promptQueueHolds.size, 0);
  assert.match(h.toasts.at(-1)[0], /Already dispatching/);
});

test("a lost edit response is accepted only when a fresh read proves that exact edit is saved", async () => {
  for (const matches of [true, false]) {
    let lookupOptions;
    const h = harness({ api: (url, options) => {
      if (options.method === "PATCH") throw new Error("Response lost");
      if (url.startsWith("/api/prompt-queue?")) { lookupOptions = options; return [item("queued-one", { prompt: matches ? "New" : "Someone else's edit" })]; }
    } });
    h.state.repositoryPromptQueues["task-a"] = [item()];
    const editing = h.context.saveQueuedPromptEdit({ scope: "repository", request: item(), prompt: "New" });
    if (matches) await editing; else await assert.rejects(editing, /Response lost/);
    assert.equal(h.state.repositoryPromptQueues["task-a"][0].prompt, matches ? "New" : "Prompt queued-one");
    assert.equal(lookupOptions.dedupe, false); assert.equal(lookupOptions.cache, "no-store");
    assert.equal(h.calls.filter(call => call.method === "PATCH").length, 1);
  }
});
