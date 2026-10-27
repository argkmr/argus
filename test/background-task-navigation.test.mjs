import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { renderRepositoryContextSummary } from "../public/repository-context-bar.mjs";
import { createChatRevisionState } from "../public/chat-revision-state.mjs";
import { reconcileAgentJob } from "../public/agent-job-snapshot.mjs";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");

function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ scope = "repository", running = false, messages = [] } = {}) {
  const calls = [], navigation = [], panels = [], conversations = [], routes = [], jobsShown = [], chatVisibility = [];
  const taskResponse = deferred(), taskRequested = deferred();
  const task = { id: "task-a", repositoryId: scope === "global" ? "global" : "repo-a", messages };
  const jobs = running ? [{ id: "job-a", taskId: "task-a", status: "running" }] : [];
  const state = {
    currentView: scope === "global" ? "global" : "repository", activeRepository: { id: "repo-a", name: "Service A" },
    activeTaskByRepository: { "repo-a": "task-a" }, activeGlobalTaskId: "task-a",
    repositoryJobs: scope === "repository" ? jobs : [], globalJobs: scope === "global" ? jobs : [],
    promptQueuesLoaded: new Set(["task-a"]), promptQueueProcessors: new Set(), promptQueueSaves: new Set(),
    repositoryPromptQueues: {}, globalPromptQueues: {}, repositoryTasks: {},
    repositorySubmitting: {}, repositorySubmissions: {}, repositoryDrafts: { "repo-a": "Unsent repository draft" },
    globalDraft: "Unsent Nexus draft", refreshToken: 0,
  };
  const document = { activeElement: null, querySelector: selector => element(selector) };
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        value: "", open: false, focusCount: 0, setAttribute() {},
        focus() { this.focusCount += 1; document.activeElement = this; },
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      });
    }
    return elements.get(selector);
  };
  document.body = element("body");
  const chatRevisionState = createChatRevisionState();
  const context = vm.createContext({
    state, $: element, document, reconcileAgentJob, renderRepositoryContextSummary,
    repositoryIdeBridge: { setChatVisible: visible => { chatVisibility.push(visible); if (visible) document.body.classList.remove("repository-ide-chat-hidden"); } },
    chatRevisionState, acceptChatTaskSnapshot: (_scope, task) => chatRevisionState.accept(task),
    api: async (url) => {
      calls.push(url);
      if (url === "/api/ai-tasks/task-a") { taskRequested.resolve(); return taskResponse.promise; }
      if (url.startsWith("/api/ai-tasks?")) return [task];
      if (url.startsWith("/api/agents/jobs?")) return jobs;
      if (url.endsWith("/history") || url.endsWith("/branches") || url.startsWith("/api/prompt-queue?")) return [];
      return {};
    },
    showTaskWorkspace: (scope) => {
      navigation.push(scope); state.currentView = scope === "global" ? "global" : "repository";
      element("#manage-repositories-dialog").open = false; return true;
    },
    setTaskPanelCollapsed: (...args) => panels.push(args), renderTaskList() {}, restoreTaskModelSettings() {},
    renderTaskConversation: (scope, selectedTask) => conversations.push({ scope, task: selectedTask }),
    syncViewUrl: (view) => routes.push(view), agentJobIsActive: (job) => job.status === "running",
    showRepositoryJob: (job) => jobsShown.push(job.id), showGlobalJob: (job) => jobsShown.push(job.id),
    composerSubmission: () => null, setComposerPreparingState() {}, setComposerActionState() {},
    activeTaskId: (scope) => scope === "global" ? state.activeGlobalTaskId : state.activeTaskByRepository[state.activeRepository.id],
    renderContextTray() {}, setRefreshLoading() {}, skeletonRows: () => "", renderGitStatus() {}, renderGitSyncState() {}, renderBranchCopyButton() {},
    renderHistory() {}, renderBranches() {}, renderAgentTabs() {}, renderModelControls() {},
    toast: (message) => assert.fail(message),
  });
  vm.runInContext(["agentJobIsActive", "isChatAgentJob", "reconcileAgentJobs", "selectTask", "refreshActiveRepository"].map(declaration).join("\n"), context);
  return { context, state, document, element, task, taskRequested: taskRequested.promise, calls, navigation, panels, conversations, routes, jobsShown, chatVisibility,
    respond: (response = task) => taskResponse.resolve(response),
    openManager() { element("#manage-repositories-dialog").open = true; element("#repository-manager-search").value = "typing a filter"; element("#repository-manager-search").focus(); },
  };
}

test("a deferred repository refresh paints the selected chat without dismissing the manager or taking its focus", async () => {
  for (const running of [false, true]) {
    const h = harness({ running });
    const refresh = h.context.refreshActiveRepository();
    await h.taskRequested;
    h.openManager();
    h.respond();
    await refresh;
    assert.equal(h.element("#manage-repositories-dialog").open, true);
    assert.equal(h.document.activeElement, h.element("#repository-manager-search"));
    assert.equal(h.element("#repository-manager-search").value, "typing a filter");
    assert.equal(h.state.currentView, "repository");
    assert.equal(h.element("#agent-prompt").focusCount, 0);
    assert.equal(h.state.repositoryDrafts["repo-a"], "Unsent repository draft");
    assert.deepEqual(h.navigation, []);
    assert.deepEqual(h.panels, []);
    assert.equal(h.conversations.length, 1);
    assert.equal(h.conversations[0].task.id, "task-a");
    assert.deepEqual(h.jobsShown, running ? ["job-a"] : []);
  }
});

test("background task selection for either chat scope renders without navigating, expanding panels or focusing an empty composer", async () => {
  for (const scope of ["repository", "global"]) {
    const h = harness({ scope });
    h.openManager();
    const selecting = h.context.selectTask(scope, "task-a", { background: true });
    await h.taskRequested;
    h.respond();
    await selecting;
    assert.equal(h.element("#manage-repositories-dialog").open, true);
    assert.equal(h.document.activeElement, h.element("#repository-manager-search"));
    assert.deepEqual(h.navigation, []);
    assert.deepEqual(h.panels, []);
    assert.equal(h.conversations.length, 1);
    assert.equal(h.conversations[0].scope, scope);
    assert.equal(h.conversations[0].task, h.task);
    assert.equal(h.element(scope === "global" ? "#global-agent-prompt" : "#agent-prompt").focusCount, 0);
  }
});

test("a delayed background selection cannot replace a newer primary view or reopen the chat over the Git dock", async () => {
  for (const { scope, view, dock } of [
    { scope: "repository", view: "global" }, { scope: "repository", view: "services" },
    { scope: "global", view: "repository" }, { scope: "repository", view: "repository", dock: true },
  ]) {
    const h = harness({ scope });
    const selecting = h.context.selectTask(scope, "task-a", { background: true });
    await h.taskRequested;
    h.state.currentView = view;
    if (dock) h.document.body.classList.add("version-control-dock-open");
    h.respond();
    await selecting;
    assert.equal(h.state.currentView, view);
    assert.deepEqual(h.navigation, []);
    assert.deepEqual(h.panels, []);
    assert.deepEqual(h.conversations, []);
    assert.deepEqual(h.routes, []);
    assert.equal(h.document.body.classList.contains("version-control-dock-open"), Boolean(dock));
  }
});

test("task selection opens chat without changing either sidebar's disclosure state", async () => {
  for (const scope of ["repository", "global"]) {
    const h = harness({ scope });
    h.state.currentView = "services";
    h.openManager();
    const selecting = h.context.selectTask(scope, "task-a");
    await h.taskRequested;
    h.respond();
    await selecting;
    assert.deepEqual(h.navigation, [scope]);
    assert.deepEqual(h.panels, []);
    assert.equal(h.state.currentView, scope === "global" ? "global" : "repository");
    assert.equal(h.element("#manage-repositories-dialog").open, false);
    assert.equal(h.conversations[0].task.id, "task-a");
    const prompt = h.element(scope === "global" ? "#global-agent-prompt" : "#agent-prompt");
    assert.equal(prompt.focusCount, 1);
    assert.equal(h.document.activeElement, prompt);
  }
});

test("Nexus prompt resubmission and active-job refresh preserve the user's sidebar choice", async () => {
  for (const running of [false, true]) {
    const h = harness({ scope: "global", running, messages: [{ role: "user", content: "Keep this conversation" }] });
    h.respond();
    for (const background of [false, true, false]) await h.context.selectTask("global", "task-a", { background, dismissTaskHistory: true });
    assert.deepEqual(h.panels, [], "neither foreground selections nor background job updates may reopen or collapse Nexus history");
    assert.equal(h.conversations.length, 3);
    assert.equal(h.state.activeGlobalTaskId, "task-a");
    assert.equal(h.state.globalDraft, "Unsent Nexus draft");
    assert.equal(h.state.globalJobs.length, running ? 1 : 0);
    assert.deepEqual(h.jobsShown, running ? ["job-a", "job-a", "job-a"] : []);
  }
});

test("repeated prompt and job selections never force the IDE task drawer open or closed", async () => {
  for (const running of [false, true]) {
    const h = harness({ running, messages: [{ role: "user", content: "Keep this conversation" }] });
    h.document.body.classList.add("repository-ide-enabled");
    h.respond();
    for (let refresh = 0; refresh < 3; refresh++) await h.context.selectTask("repository", "task-a");
    assert.deepEqual(h.panels, [], "automatic selections must preserve both a closed drawer and a manually opened picker");
    assert.equal(h.conversations.length, 3);
    assert.equal(h.state.activeTaskByRepository["repo-a"], "task-a");
    assert.equal(h.state.repositoryDrafts["repo-a"], "Unsent repository draft");
  }
});

test("choosing a history row dismisses only the IDE picker, not the ordinary chat dock", async () => {
  for (const ide of [false, true]) {
    const h = harness({ messages: [{ role: "user", content: "Existing conversation" }] });
    if (ide) h.document.body.classList.add("repository-ide-enabled");
    h.respond();
    await h.context.selectTask("repository", "task-a", { dismissTaskHistory: true });
    assert.deepEqual(h.panels, ide ? [["repository", true, false]] : []);
    assert.equal(h.conversations[0].task.id, "task-a");
  }
});

test("cancelled or stale history selection cannot dismiss the current picker", async () => {
  const h = harness();
  h.document.body.classList.add("repository-ide-enabled");
  const selecting = h.context.selectTask("repository", "task-a", { dismissTaskHistory: true, isCurrent: () => false });
  await h.taskRequested;
  h.respond();
  await selecting;
  assert.deepEqual(h.panels, []);
  assert.deepEqual(h.conversations, []);
});

test("choosing a history task reveals hidden AI chat, but automatic selections never restore it", async () => {
  for (const dismissTaskHistory of [false, true]) {
    const h = harness({ running: true });
    h.document.body.classList.add("repository-ide-enabled");
    h.document.body.classList.add("repository-ide-chat-hidden");
    h.respond();
    await h.context.selectTask("repository", "task-a", { dismissTaskHistory });
    assert.deepEqual(h.chatVisibility, dismissTaskHistory ? [true] : []);
    assert.equal(h.document.body.classList.contains("repository-ide-chat-hidden"), !dismissTaskHistory);
    assert.equal(h.state.activeTaskByRepository["repo-a"], "task-a");
  }
});

test("creating a repository draft dismisses history and reveals chat without changing saved conversations", () => {
  const h = harness();
  h.document.body.classList.add("repository-ide-enabled");
  h.document.body.classList.add("repository-ide-chat-hidden");
  Object.assign(h.context, {
    composerIsSubmitting: () => false,
    taskPromptNotes: { resetDraft() {} },
    currentModelSelectionKey: () => "draft", modelDraftEpochs: new Map(),
    chatContextPreference: { reset() {} },
    repositoryTaskDrawer: { dismiss: () => h.panels.push(["repository", true, false]) },
    storeComposerDraft: (_scope, draft) => { h.state.repositoryDrafts["repo-a"] = draft; },
    resizeAgentComposer() {}, renderContextMode() {}, toast() {},
  });
  vm.runInContext(declaration("startTaskDraft"), h.context);
  h.context.startTaskDraft("repository");
  assert.deepEqual(h.panels, [["repository", true, false]]);
  assert.deepEqual(h.chatVisibility, [true]);
  assert.equal(h.state.activeTaskByRepository["repo-a"], null);
  assert.equal(h.element("#agent-prompt").focusCount, 1);
  assert.equal(h.element("#agent-context-mode").value, "history");
  assert.deepEqual(h.calls, [], "starting a draft must not delete or rewrite any saved task");
});
