import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createChatRevisionState } from "../public/chat-revision-state.mjs";
import { reconcileAgentJob } from "../public/agent-job-snapshot.mjs";

// Exercise the production event handlers with synthetic state and a fake API.
// No request is sent to a running Argus app or to a coding-agent provider.
const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(app);
  assert.ok(match, `Missing ${name}`);
  const end = app.indexOf("\n}", match.index);
  assert.ok(end >= match.index, `Unterminated ${name}`);
  return app.slice(match.index, end + 2);
}

const chatJob = (overrides = {}) => ({
  id: "nexus-job", taskId: "nexus-chat", repositoryId: "global", scope: "global",
  status: "running", systemJob: false, ...overrides,
});

function harness({ selectTask = false, openNexus = false, api: handler } = {}) {
  const calls = [], actions = [], notifications = [], selections = [], shownJobs = [], clearedTimers = [];
  const state = {
    activeRepository: { id: "repo-a" }, activeTaskByRepository: { "repo-a": "repo-chat" },
    activeGlobalTaskId: "nexus-chat", activeJob: null, globalJob: null,
    repositorySubmissions: {}, repositorySubmitting: {}, globalSubmission: null, globalSubmitting: false,
    globalJobs: [], repositoryJobs: [], globalTasks: [], promptQueuesLoaded: new Set(),
    promptQueueProcessors: new Set(), promptQueueSaves: new Set(), repositoryPromptQueues: {}, globalPromptQueues: {},
  };
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        classList: {
          add: (...names) => names.forEach((name) => classes.add(name)),
          remove: (...names) => names.forEach((name) => classes.delete(name)),
          contains: (name) => classes.has(name),
        },
        focus() {},
      });
    }
    return elements.get(selector);
  };
  const chatRevisionState = createChatRevisionState();
  const context = vm.createContext({
    state, $: element, reconcileAgentJob, revisionIsBusy: () => false,
    chatRevisionState, checkpointTasks: new Map(), acceptChatTaskSnapshot: (_scope, task) => chatRevisionState.accept(task),
    runGlobalAgent: () => actions.push("send-global"), runAgent: () => actions.push("send-repository"),
    pollGlobalAgent: async () => actions.push("poll-global"), pollAgent: async () => actions.push("poll-repository"),
    toast: (message) => notifications.push(message),
    api: async (url, options = {}) => {
      calls.push({ url, ...structuredClone(options) });
      if (handler) {
        const result = await handler(url, options);
        if (result !== undefined) return result;
      }
      if (url.startsWith("/api/ai-tasks/")) return { id: url.split("/").at(-1), repositoryId: "repo-a", messages: [] };
      if (url.startsWith("/api/prompt-queue?")) return [];
      return { ok: true };
    },
    showTaskWorkspace: () => true, setTaskPanelCollapsed() {}, renderTaskList() {},
    restoreTaskModelSettings() {}, renderTaskConversation() {}, renderContextTray() {}, syncViewUrl() {},
    setComposerPreparingState() {}, setComposerActionState() {}, renderAgentTabs() {}, renderModelControls() {},
    showGlobalJob: (job) => { state.globalJob = job; shownJobs.push(job.id); },
    showRepositoryJob: (job) => { state.activeJob = job; shownJobs.push(job.id); },
    switchPrimaryView: (view) => { state.currentView = view; },
    selectTask: async (scope, id) => selections.push({ scope, id }),
    clearInterval: (timer) => clearedTimers.push(timer),
  });
  const functions = [
    "reconcileAgentJobs", "activeTaskId", "agentJobIsActive", "isChatAgentJob", "jobBelongsToCurrentChat", "runningAgentJob",
    "composerRepositoryId", "composerSubmission", "composerIsSubmitting", "stopAgent", "handleComposerAction",
  ];
  if (selectTask) functions.push("selectTask");
  if (openNexus) functions.push("openGlobalCodex");
  vm.runInContext(functions.map(declaration).join("\n"), context);
  return { context, state, calls, actions, notifications, selections, shownJobs, clearedTimers, element };
}

test("chat eligibility excludes taskless PR reviews, orchestration-owned jobs and system jobs", () => {
  const h = harness();
  for (const job of [null, {}, chatJob({ taskId: "" }), chatJob({ orchestrationRunId: "review-run" }), chatJob({ systemJob: true })]) {
    assert.equal(h.context.isChatAgentJob(job), false);
  }
  assert.equal(h.context.isChatAgentJob(chatJob()), true);
});

test("Send in Nexus cannot cancel a legacy taskless PR or another chat's job", async () => {
  for (const overrides of [{ taskId: "" }, { taskId: "another-chat" }, { orchestrationRunId: "review-run" }, { systemJob: true }]) {
    const h = harness();
    h.state.globalJob = chatJob(overrides);
    assert.equal(h.context.runningAgentJob("global"), null);
    await h.context.handleComposerAction("global");
    assert.deepEqual(h.actions, ["send-global"]);
    assert.deepEqual(h.calls, []);
    assert.equal(h.state.globalJob.status, "running");
  }
});

test("an explicit Stop in the same Nexus chat targets only that job and labels its control", async () => {
  const h = harness();
  const ownJob = h.state.globalJob = chatJob();
  assert.equal(h.context.runningAgentJob("global"), ownJob);
  await h.context.handleComposerAction("global");
  assert.deepEqual(h.calls, [{
    url: "/api/agents/jobs/nexus-job", method: "DELETE",
    headers: { "X-Argus-Cancel-Control": "global-composer-stop" },
  }]);
  assert.deepEqual(h.actions, ["poll-global"]);
});

test("repository composer rejects a same-task job from another repository", async () => {
  const h = harness();
  h.state.activeJob = chatJob({ id: "foreign-job", scope: "repository", taskId: "repo-chat", repositoryId: "repo-b" });
  assert.equal(h.context.jobBelongsToCurrentChat("repository", h.state.activeJob), false);
  assert.equal(h.context.runningAgentJob("repository"), null);
  await h.context.handleComposerAction("repository");
  assert.deepEqual(h.actions, ["send-repository"]);
  assert.deepEqual(h.calls, []);
});

test("repository Stop retains the existing behavior for the selected repository and chat", async () => {
  const h = harness();
  h.state.activeJob = chatJob({ id: "repo-job", scope: "repository", taskId: "repo-chat", repositoryId: "repo-a" });
  await h.context.handleComposerAction("repository");
  assert.deepEqual(h.calls, [{
    url: "/api/agents/jobs/repo-job", method: "DELETE",
    headers: { "X-Argus-Cancel-Control": "repository-composer-stop" },
  }]);
  assert.deepEqual(h.actions, ["poll-repository"]);
});

test("a new draft with no active task cannot stop the previous job in either composer", async () => {
  for (const scope of ["global", "repository"]) {
    const h = harness();
    h.state.globalJob = chatJob();
    h.state.activeJob = chatJob({ taskId: "repo-chat", repositoryId: "repo-a" });
    h.state.activeGlobalTaskId = null;
    h.state.activeTaskByRepository["repo-a"] = null;
    assert.equal(h.context.runningAgentJob(scope), null);
    await h.context.stopAgent(scope);
    await h.context.handleComposerAction(scope);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.actions, [scope === "global" ? "send-global" : "send-repository"]);
  }
});

test("completed jobs never turn Send into Stop, while finalizing own jobs remain active", async () => {
  const h = harness();
  h.state.globalJob = chatJob({ status: "completed" });
  assert.equal(h.context.runningAgentJob("global"), null);
  await h.context.handleComposerAction("global");
  assert.deepEqual(h.actions, ["send-global"]);
  h.state.globalJob.completionPending = true;
  assert.equal(h.context.runningAgentJob("global"), h.state.globalJob);
});

test("a preparation belonging to another chat cannot be cancelled from this composer", async () => {
  for (const scope of ["global", "repository"]) {
    const h = harness();
    const submission = { requestId: "other-preparation", taskId: "other-chat", cancelled: false };
    if (scope === "global") {
      h.state.globalSubmission = submission;
      h.state.globalSubmitting = true;
    } else {
      h.state.repositorySubmissions["repo-a"] = submission;
      h.state.repositorySubmitting["repo-a"] = true;
    }
    assert.equal(h.context.composerSubmission(scope), null);
    await h.context.handleComposerAction(scope);
    await h.context.stopAgent(scope);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.actions, []);
    assert.equal(submission.cancelled, false);
    assert.match(h.notifications[0], /Another chat is still preparing/);
  }
});

test("Stop still cancels preparation for this chat or its unsaved draft", async () => {
  for (const taskId of ["nexus-chat", null]) {
    const h = harness();
    h.state.activeGlobalTaskId = taskId;
    const submission = h.state.globalSubmission = { requestId: "own-preparation", taskId, cancelled: false };
    h.state.globalSubmitting = true;
    assert.equal(h.context.composerSubmission("global"), submission);
    await h.context.handleComposerAction("global");
    assert.equal(submission.cancelled, true);
    assert.deepEqual(h.calls, [{
      url: "/api/agents/preparations/own-preparation", method: "DELETE",
      headers: { "X-Argus-Cancel-Control": "global-composer-stop" },
    }]);
    assert.deepEqual(h.actions, []);
  }
});

test("opening Nexus excludes PR/system jobs and preserves the selected chat over another running chat", async () => {
  const jobs = [chatJob({ id: "pr-job", taskId: "" }), chatJob({ id: "system-job", systemJob: true }), chatJob({ id: "other-chat-job", taskId: "other-chat" })];
  const h = harness({ openNexus: true, api: (url) => {
    if (url === "/api/agents/jobs?repositoryId=global") return jobs;
    if (url === "/api/ai-tasks?scope=global&repositoryId=global") return [{ id: "nexus-chat" }, { id: "other-chat" }];
  } });
  await h.context.openGlobalCodex();
  assert.deepEqual(Array.from(h.state.globalJobs, (job) => job.id), ["other-chat-job"]);
  assert.deepEqual(h.selections, [{ scope: "global", id: "nexus-chat" }]);
  assert.deepEqual(h.shownJobs, []);
  assert.ok(h.calls.every((call) => !call.method || call.method === "GET"));
});

test("opening empty Nexus does not adopt a running taskless PR review", async () => {
  const h = harness({ openNexus: true, api: (url) => {
    if (url === "/api/agents/jobs?repositoryId=global") return [chatJob({ id: "pr-job", taskId: "" })];
    if (url === "/api/ai-tasks?scope=global&repositoryId=global") return [];
  } });
  h.state.globalJob = chatJob({ taskId: "" });
  h.state.globalJobTimer = "old-poll-timer";
  await h.context.openGlobalCodex();
  assert.equal(h.state.globalJob, null);
  assert.equal(h.state.activeGlobalTaskId, null);
  assert.deepEqual(h.clearedTimers, ["old-poll-timer"]);
  await h.context.handleComposerAction("global");
  assert.deepEqual(h.actions, ["send-global"]);
  assert.ok(h.calls.every((call) => !call.method || call.method === "GET"));
});

test("switching from a running chat to an idle chat cannot cancel the former chat", async () => {
  for (const scope of ["global", "repository"]) {
    const h = harness({ selectTask: true });
    const oldJob = chatJob({ id: "old-chat-job", taskId: "old-chat", repositoryId: scope === "global" ? "global" : "repo-a" });
    if (scope === "global") {
      h.state.globalJob = oldJob;
      h.state.globalJobs = [oldJob];
    } else {
      h.state.activeJob = oldJob;
      h.state.repositoryJobs = [oldJob];
    }
    await h.context.selectTask(scope, "idle-chat");
    assert.equal(h.context.activeTaskId(scope), "idle-chat");
    assert.equal(h.context.runningAgentJob(scope), null);
    await h.context.handleComposerAction(scope);
    assert.deepEqual(h.actions, [scope === "global" ? "send-global" : "send-repository"]);
    assert.ok(h.calls.every((call) => !call.method || call.method === "GET"));
    assert.equal(oldJob.status, "running");
  }
});
