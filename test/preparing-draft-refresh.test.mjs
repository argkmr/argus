import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { reconcileAgentJob } from "../public/agent-job-snapshot.mjs";
import { renderRepositoryContextSummary } from "../public/repository-context-bar.mjs";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Missing ${name}`);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}

function harness(scope, { preparing = true, selectedTask = null } = {}) {
  const repositoryId = scope === "global" ? "global" : "repo-a";
  const submission = { taskId: null, requestId: "first-prompt-preparation", repositoryId, providerName: "Codex" };
  const newTask = { id: "server-created-task", repositoryId, messages: [] };
  const selected = selectedTask ? { id: selectedTask, repositoryId, messages: [] } : null;
  const tasks = [newTask, ...(selected ? [selected] : [])];
  const calls = [], prepared = [], actions = [], selections = [], conversations = [];
  const state = {
    activeRepository: { id: "repo-a", name: "Service A" },
    activeGlobalTaskId: scope === "global" ? selectedTask : null,
    activeTaskByRepository: { "repo-a": scope === "repository" ? selectedTask : null },
    globalSubmitting: scope === "global" && preparing,
    globalSubmission: scope === "global" ? submission : null,
    repositorySubmitting: { "repo-a": scope === "repository" && preparing },
    repositorySubmissions: scope === "repository" ? { "repo-a": submission } : {},
    globalJobs: [], globalTasks: [], repositoryJobs: [], repositoryTasks: {},
    currentView: scope === "global" ? "global" : "repository", refreshToken: 0,
  };
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", innerHTML: "", setAttribute() {}, classList: { add() {}, remove() {}, contains: () => false } });
    return elements.get(selector);
  };
  const context = vm.createContext({
    state, $: element, document: { querySelector: element, body: element("body") }, reconcileAgentJob, renderRepositoryContextSummary,
    api: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (url.includes("/api/ai-tasks?")) return tasks;
      if (url.includes("/api/agents/jobs?")) return [];
      return {};
    },
    switchPrimaryView() {}, renderTaskList() {}, renderAgentTabs() {}, renderModelControls() {},
    renderContextTray() {}, setRefreshLoading() {}, skeletonRows: () => "", renderGitStatus() {}, renderGitSyncState() {}, renderBranchCopyButton() {}, renderHistory() {}, renderBranches() {},
    selectTask: async (scope, id) => selections.push({ scope, id }),
    showGlobalJob: () => assert.fail("Preparing draft cannot adopt an unrelated job"),
    showRepositoryJob: () => assert.fail("Preparing draft cannot adopt an unrelated job"),
    renderTaskConversation: (scope, task) => conversations.push({ scope, task }),
    setComposerPreparingState: (scope, value, provider) => prepared.push({ scope, value, provider }),
    setComposerActionState: (scope, running) => actions.push({ scope, running }),
    clearInterval() {}, toast: message => assert.fail(message),
    pollGlobalAgent() {}, pollAgent() {},
  });
  vm.runInContext([
    "reconcileAgentJobs", "activeTaskId", "composerRepositoryId", "composerSubmission", "composerIsSubmitting",
    "isChatAgentJob", "jobBelongsToCurrentChat", "agentJobIsActive", "runningAgentJob",
    "refreshTasks", "refreshActiveRepository", "openGlobalCodex", "stopAgent",
  ].map(declaration).join("\n"), context);
  return { context, state, submission, calls, prepared, actions, selections, conversations };
}

test("task-list refresh retains the first prompt's draft until the run returns its task ID", async () => {
  for (const scope of ["global", "repository"]) {
    const h = harness(scope);
    await h.context.refreshTasks(scope, true);
    assert.equal(h.context.activeTaskId(scope), null);
    assert.equal(h.context.composerSubmission(scope), h.submission);
    await h.context.stopAgent(scope);
    const stop = h.calls.find(call => call.method === "DELETE");
    assert.equal(stop.url, "/api/agents/preparations/first-prompt-preparation");
    assert.equal(stop.headers["X-Argus-Cancel-Control"], scope === "global" ? "global-composer-stop" : "repository-composer-stop");
  }
});

test("reopening Nexus keeps an unassigned preparation visible and stoppable", async () => {
  const h = harness("global");
  await h.context.openGlobalCodex();
  assert.equal(h.state.activeGlobalTaskId, null);
  assert.equal(h.context.composerSubmission("global"), h.submission);
  assert.deepEqual(h.selections, []);
  assert.deepEqual(h.prepared, [{ scope: "global", value: true, provider: "Codex" }]);
  assert.deepEqual(h.actions, []);
  assert.equal(h.conversations.at(-1).scope, "global");
});

test("repository refresh keeps an unassigned preparation visible and stoppable", async () => {
  const h = harness("repository");
  await h.context.refreshActiveRepository();
  assert.equal(h.state.activeTaskByRepository["repo-a"], null);
  assert.equal(h.context.composerSubmission("repository"), h.submission);
  assert.deepEqual(h.selections, []);
  assert.deepEqual(h.prepared, [{ scope: "repository", value: true, provider: "Codex" }]);
  assert.deepEqual(h.actions, []);
});

test("completed preparation does not prevent ordinary latest-task restoration", async () => {
  for (const scope of ["global", "repository"]) {
    const h = harness(scope, { preparing: false });
    await h.context.refreshTasks(scope);
    assert.equal(h.context.activeTaskId(scope), "server-created-task");
    assert.equal(h.context.composerSubmission(scope), null);
  }
});

test("an explicitly selected existing chat does not inherit an unassigned draft's Stop", async () => {
  for (const scope of ["global", "repository"]) {
    const h = harness(scope, { selectedTask: "existing-chat" });
    await h.context.refreshTasks(scope);
    assert.equal(h.context.activeTaskId(scope), "existing-chat");
    assert.equal(h.context.composerSubmission(scope), null);
    await h.context.stopAgent(scope);
    assert.ok(h.calls.every(call => !call.method));
  }
});
