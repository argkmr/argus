import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createPromptEditor, promptEditButton } from "../public/prompt-editor.js";
import { createPromptRevisionCoordinator } from "../public/prompt-revision-stop.mjs";
import { createPromptRevisionFlow } from "../public/prompt-revision-flow.mjs";

class Element {
  listeners = new Map(); nodes = new Map(); value = ""; textContent = ""; open = false; disabled = false; isConnected = true;
  setAttribute() {}
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  dispatch(event) { return this.listeners.get(event)?.({ preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
}
const task = { id: "task", scope: "repository", provider: "codex", repositoryId: "repo", messages: [{ id: "user1", role: "user", content: "Original <text>", attachments: [{ id: "file", name: "plan.pdf" }] }] };
function harness(submit = async () => {}) {
  let dialog;
  const document = { body: { append(element) { dialog = element; } }, createElement() { return new Element(); } };
  const editor = createPromptEditor({ document, loadTask: async () => structuredClone(task), submit });
  return { editor, get dialog() { return dialog; }, open: (scope = "repository") => editor.open({ scope, taskId: "task", messageId: "user1", trigger: new Element() }) };
}

test("Edit affordance is escaped and limited to persisted user messages", () => {
  assert.match(promptEditButton("global", task, task.messages[0]), /data-edit-scope="global"/);
  assert.match(promptEditButton("repository", { id: '\"<script>' }, { ...task.messages[0], id: '\"bad' }), /&quot;/);
  for (const message of [{ ...task.messages[0], role: "assistant" }, { ...task.messages[0], optimistic: true }, { role: "user" }]) assert.equal(promptEditButton("repository", task, message), "");
  assert.equal(promptEditButton("repository", { ...task, codeDiscussionTask: true }, task.messages[0]), "");
});

test("editor retains attachments, resends revised text and preserves source content", async () => {
  let received;
  const h = harness(async (input) => { received = input; });
  await h.open("global");
  assert.equal(h.dialog.querySelector("textarea").value, "Original <text>");
  assert.match(h.dialog.querySelector("[data-edit-attachments]").textContent, /plan.pdf/);
  h.dialog.querySelector("textarea").value = "Revised request";
  await h.dialog.querySelector("form").dispatch("submit");
  assert.equal(received.prompt, "Revised request");
  assert.equal(received.message.content, "Original <text>");
  assert.equal(received.scope, "global");
  assert.equal(h.dialog.open, false);
});

test("cancel makes no request; stale messages do not open an editor", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; });
  await h.open();
  h.dialog.querySelector("textarea").value = "unsent edit";
  h.dialog.querySelector("[data-cancel-edit]").dispatch("click");
  assert.equal(calls, 0);
  assert.equal(h.dialog.open, false);
  await assert.rejects(h.editor.open({ scope: "repository", taskId: "task", messageId: "missing" }), /no longer available/);
});

test("duplicate submits and Escape cannot interrupt an in-flight revision", async () => {
  let finish, calls = 0;
  const h = harness(async () => { calls++; await new Promise((resolve) => { finish = resolve; }); });
  await h.open();
  const pending = h.dialog.querySelector("form").dispatch("submit");
  await h.dialog.querySelector("form").dispatch("submit");
  h.dialog.dispatch("cancel");
  await h.open();
  assert.equal(calls, 1);
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.querySelector("textarea").disabled, true);
  finish(); await pending;
  assert.equal(h.dialog.open, false);
});

test("rejected revisions retain the unsaved edit and allow retry", async () => {
  const h = harness(async () => { throw new Error("Stop the current response first"); });
  await h.open();
  h.dialog.querySelector("textarea").value = "Keep this text";
  await h.dialog.querySelector("form").dispatch("submit");
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.querySelector("textarea").value, "Keep this text");
  assert.equal(h.dialog.querySelector("textarea").disabled, false);
  assert.match(h.dialog.querySelector("[data-edit-error]").textContent, /Stop/);
});

for (const scope of ["global", "repository"]) test(`${scope}: saved-but-unstarted edit stays open and next submit patches the returned pending draft`, async () => {
  const attempts = [];
  const h = harness(async input => {
    attempts.push(input);
    return attempts.length === 1 ? { status: "saved", task: { ...task, revisionCount: 1,
      revisionDraft: { prompt: input.prompt, runRequestId: "saved-run", attachments: task.messages[0].attachments, promptNotes: [] } },
    error: Object.assign(new Error("Repository disconnected"), { status: 400 }) } : { status: "started" };
  });
  await h.open(scope); h.dialog.querySelector("textarea").value = "Updated request";
  await h.dialog.querySelector("form").dispatch("submit");
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.querySelector("textarea").value, "Updated request");
  assert.match(h.dialog.querySelector("[data-edit-error]").textContent, /response was not started/);
  await h.dialog.querySelector("form").dispatch("submit");
  assert.equal(attempts[1].message.pendingRevision, true);
  assert.equal(attempts[1].message.content, "Updated request");
  assert.equal(attempts[1].task.revisionDraft.runRequestId, "saved-run");
  assert.equal(h.dialog.open, false);
});

test("cancelling scope confirmation keeps the editor draft open and editable", async () => {
  const h = harness(async () => ({ status: "cancelled" })); await h.open("global");
  h.dialog.querySelector("textarea").value = "Keep this edit";
  await h.dialog.querySelector("form").dispatch("submit");
  assert.equal(h.dialog.open, true); assert.equal(h.dialog.querySelector("textarea").value, "Keep this edit");
  assert.equal(h.dialog.querySelector("textarea").disabled, false);
});

test("uncertain retries reuse the revision identity; changing the edit creates a new attempt", async () => {
  const attempts = [];
  const h = harness(async (input) => { attempts.push(input); throw new Error("Connection lost"); });
  await h.open();
  h.dialog.querySelector("textarea").value = "Updated request";
  await h.dialog.querySelector("form").dispatch("submit");
  await h.dialog.querySelector("form").dispatch("submit");
  assert.ok(attempts[0].requestId);
  assert.equal(attempts[0].requestId, attempts[1].requestId);
  h.dialog.querySelector("textarea").value = "A different update";
  await h.dialog.querySelector("form").dispatch("submit");
  assert.notEqual(attempts[2].requestId, attempts[1].requestId);
  assert.match(h.dialog.innerHTML, /in this same chat/);
  assert.match(h.dialog.innerHTML, /Previous versions/);
  assert.doesNotMatch(h.dialog.innerHTML, /starts a revised chat/);
});

test("Save exposes stopping progress while retaining the edit and preventing duplicate actions", async () => {
  let finish;
  const h = harness(async ({ onProgress }) => {
    onProgress("Stopping current response…");
    await new Promise((resolve) => { finish = resolve; });
    throw new Error("Stopping timed out; your edit is kept.");
  });
  await h.open();
  assert.match(h.dialog.innerHTML, /automatically stops the current response/);
  h.dialog.querySelector("textarea").value = "Important unsaved edit";
  const pending = h.dialog.querySelector("form").dispatch("submit");
  assert.equal(h.dialog.querySelector("[data-edit-progress]").textContent, "Stopping current response…");
  assert.equal(h.dialog.querySelector("[data-save-edit]").disabled, true);
  finish(); await pending;
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.querySelector("textarea").value, "Important unsaved edit");
  assert.equal(h.dialog.querySelector("[data-edit-progress]").textContent, "");
});

async function integrationHarness({ scope = "repository", queued = false, runError = false, refreshError = false, pendingRevision = false, switchDuringRun = false, running = false, stopError = false, currentRevisionCount = 0, replayed = false, consumed = false, superseded = false } = {}) {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("const coordinatePromptRevision ="), app.indexOf("\nconst promptEditor ="));
  const requests = [], stops = [], runs = [], selections = [], toasts = [];
  const source = { ...task, scope, model: "chosen-model", effort: "high", speed: "standard", mode: "edit", contextMode: "fresh", repositoryId: scope === "global" ? "global" : "repo", repositoryIds: ["r1", "r2"] };
  if (pendingRevision) source.revisionDraft = { prompt: task.messages[0].content, runRequestId: "original-run-id", attachments: task.messages[0].attachments };
  const textarea = { value: "existing unsent draft" };
  const jobs = running ? [{ id: "source-job", taskId: "task", repositoryId: source.repositoryId, status: "paused", completionPending: false }] : [];
  const context = {
    createPromptRevisionCoordinator, createPromptRevisionFlow, createRevisionScopePicker: () => async () => { throw new Error("Unexpected scope change"); }, document: {},
    loadWorkspaceSnapshot: () => context.api("/api/workspace", { dedupe: false, cache: "no-store" }),
    state: { activeRepository: { id: "repo" }, providers: [{ id: "codex", authenticated: true, name: "Codex" }], globalJobs: [], repositoryJobs: [], repositorySubmissions: {}, promptQueueSaves: new Set(), promptQueueProcessors: new Set() }, activeTaskId: () => "task",
    agentJobIsActive: () => false, composerSubmission: () => null, queuedPrompts: () => queued ? [{}] : [], providerCanRun: () => true,
    api: async (url, body) => {
      if (url === "/api/workspace") return { repositories: [{ id: "r1" }, { id: "r2" }] };
      if (url === "/api/ai-tasks/task" && !body?.method) return { ...source, revisionCount: currentRevisionCount };
      if (url.startsWith("/api/prompt-queue?")) return [];
      if (url.startsWith("/api/agents/jobs?")) return structuredClone(jobs);
      if (url === "/api/agents/jobs/source-job" && body.method === "DELETE") {
        stops.push({ url, body }); if (stopError) throw new Error("Could not stop source response");
        jobs[0].status = "cancelled"; return { ok: true };
      }
      requests.push({ url, body }); return { task: { ...source, revisionCount: 1, revisionOf: { revisionId: superseded ? "newer-revision" : "revision" }, ...(!consumed ? { revisionDraft: { prompt: "Edited", runRequestId: "persisted-run-id" } } : {}) }, revisionId: "revision", replayed, attachments: task.messages[0].attachments };
    },
    startQueuedPrompt: async (s, request) => { runs.push({ scope: s, request }); if (switchDuringRun) context.state.activeRepository = { id: "different-repo" }; if (runError) throw new Error("Provider unavailable"); return { id: "job" }; },
    refreshTasks: async () => { if (refreshError) throw new Error("Disconnected"); }, selectTask: async (...args) => selections.push(args),
    toast: (...args) => toasts.push(args), crypto: { randomUUID: () => "request-id" },
    acceptPromptRevision() {},
    $: () => textarea, scopedAttachments: () => [], storeComposerDraft() {}, resizeAgentComposer() {}, renderContextTray() {},
  };
  vm.createContext(context); vm.runInContext(`${fn};globalThis.revise=submitPromptRevision`, context);
  return { run: () => context.revise({ scope, task: source, message: { ...task.messages[0], pendingRevision }, prompt: "Edited" }), requests, stops, runs, selections, toasts, textarea, context };
}

for (const scope of ["repository", "global"]) test(`${scope} app wiring automatically stops before revision/run and preserves composer on failure`, async () => {
  const h = await integrationHarness({ scope, running: true }); await h.run();
  assert.equal(h.stops.length, 1); assert.equal(h.requests.length, 1); assert.equal(h.runs.length, 1);
  assert.equal(h.stops[0].body.headers["X-Argus-Cancel-Control"], `${scope}-prompt-edit`);
  assert.equal(h.textarea.value, "existing unsent draft");
  const failed = await integrationHarness({ scope, running: true, stopError: true });
  await assert.rejects(failed.run(), /Could not stop/);
  assert.equal(failed.requests.length, 0); assert.equal(failed.runs.length, 0);
  assert.equal(failed.textarea.value, "existing unsent draft");
});

for (const scope of ["repository", "global"]) test(`${scope} revision keeps exact chat configuration without overwriting composer`, async () => {
  const h = await integrationHarness({ scope }); await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.body.expectedContent, "Original <text>");
  const request = h.runs[0].request;
  assert.equal(request.taskId, "task");
  assert.equal(request.requestId, "persisted-run-id");
  assert.equal(request.expectedRevisionCount, 1);
  assert.equal(h.requests[0].body.body.requestId, "request-id");
  assert.equal(h.requests[0].body.body.expectedRevisionCount, 0);
  assert.equal(request.modelSettings.model, "chosen-model");
  assert.equal(request.modelSettings.effort, "high");
  assert.deepEqual(Array.from(request.repositoryIds), ["r1", "r2"]);
  assert.deepEqual(Array.from(request.attachmentIds), ["file"]);
  assert.equal(h.textarea.value, "existing unsent draft");
});

test("revision UI refuses pending queues and never repeats an edit after run/refresh failure", async () => {
  const busy = await integrationHarness({ queued: true }); await assert.rejects(busy.run(), /queued prompts/); assert.equal(busy.requests.length, 0);
  for (const options of [{ runError: true }, { refreshError: true }]) {
    const h = await integrationHarness(options); await h.run();
    assert.equal(h.requests.length, 1); assert.equal(h.runs.length, 1);
    assert.match(h.toasts.at(-1)[0], /Edit saved in this chat/);
    assert.equal(h.textarea.value, "existing unsent draft");
  }
});

for (const scope of ["repository", "global"]) test(`${scope}: recover accepted edit without stopping its newer run or resubmitting`, async () => {
  const h = await integrationHarness({ scope, running: true, currentRevisionCount: 1, replayed: true, consumed: true });
  await h.run();
  assert.equal(h.stops.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.selections, [[scope, "task"]]);
});

test("recover saved but unsubmitted same-chat edit with its persisted run ID", async () => {
  const h = await integrationHarness({ currentRevisionCount: 1, replayed: true });
  await h.run();
  assert.equal(h.stops.length, 0);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].request.requestId, "persisted-run-id");
});

test("replaying an older edit cannot dispatch a newer pending revision", async () => {
  const h = await integrationHarness({ currentRevisionCount: 2, replayed: true, superseded: true, running: true });
  await h.run();
  assert.equal(h.stops.length, 0);
  assert.equal(h.runs.length, 0);
  assert.match(h.toasts.at(-1)[0], /already saved/);
});

test("a newer revision observed while saving prevents old response dispatch", async () => {
  const h = await integrationHarness();
  h.context.acceptPromptRevision = () => false;
  await assert.rejects(h.run(), /revised again/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.runs.length, 0);
});

test("revised send carries its exact generation to the agent API without changing ordinary sends", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("async function startQueuedPrompt("), app.indexOf("\nasync function processPromptQueue("));
  const requests = [];
  const context = vm.createContext({ Number, state: { activeRepository: { id: "repo" }, repositoryJobs: [], globalJobs: [] },
    api: async (path, options) => { requests.push({ path, body: options.body }); return { id: `job-${requests.length}` }; },
    activeTaskId: () => "other-chat", renderAgentTabs() {},
  });
  vm.runInContext(source, context);
  const request = { requestId: "run-id", taskId: "task", repositoryId: "repo", providerId: "codex", prompt: "Edited", modelSettings: {} };
  await context.startQueuedPrompt("repository", { ...request, expectedRevisionCount: 2 });
  await context.startQueuedPrompt("repository", request);
  assert.equal(requests[0].path, "/api/agents/run");
  assert.equal(requests[0].body.expectedRevisionCount, 2);
  assert.equal(requests[0].body.requestId, "run-id");
  assert.equal("expectedRevisionCount" in requests[1].body, false);
});

test("stale editor conflict never cancels newer response", async () => {
  const h = await integrationHarness({ currentRevisionCount: 1, running: true });
  const api = h.context.api;
  h.context.api = async (url, options) => {
    if (url.endsWith("/revisions")) throw Object.assign(new Error("The chat changed; reopen Edit"), { status: 409 });
    return api(url, options);
  };
  await assert.rejects(h.run(), /chat changed/);
  assert.equal(h.stops.length, 0);
  assert.equal(h.runs.length, 0);
});

test("Nexus shortcut reuses existing navigation and modal drafts survive background selection", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /repository-toolbar[\s\S]*id="nexus-shortcut"[\s\S]*id="add-repo"/);
  assert.equal((html.match(/id="nexus-shortcut"/g) || []).length, 1);
  const workspaceTools = html.match(/<div id="app-menu-panel"[\s\S]*?<\/details>/)?.[0];
  assert.ok(workspaceTools);
  assert.doesNotMatch(workspaceTools, /Nexus|global-codex-toggle|nexus-shortcut/);
  assert.doesNotMatch(app, /#global-codex-toggle/);
  assert.match(app, /\$\("#nexus-shortcut"\)\.addEventListener\("click", \(\) => launchWorkspaceTool\(openGlobalCodex\)\)/);
  assert.match(app, /dialog\.id === exceptId \|\| dialog\.id === "prompt-edit-dialog"/);
});

test("top-bar Nexus remains the active navigation control when entering and leaving Nexus", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const switchView = app.slice(app.indexOf("function switchPrimaryView("), app.indexOf("async function restoreRoute("));
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) {
      const classes = new Set(), attributes = new Map();
      elements.set(selector, { classes, attributes, classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); } }, setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); } });
    }
    return elements.get(selector);
  }
  const body = { ...element("body"), dataset: {} };
  const context = vm.createContext({ $: element, $$: () => [], state: { activeRepository: { id: "repo" } }, document: { body }, repositoryTabGroups: () => [], closeOpenDialogs: () => true, setVersionControlDockOpen() {}, syncWorkspaceRail() {}, syncViewUrl() {}, renderServices() {}, refreshRuntimeDetections() {}, refreshProcesses() {} });
  vm.runInContext(switchView, context);
  // A workspace-tool launch preserves local tasks before switching views.
  body.classes.add("workspace-tool-active");
  element(".ai-canvas").classes.add("repository-sidebar-open");
  assert.equal(context.switchPrimaryView("global"), true);
  assert.equal(body.classes.has("workspace-tool-active"), false);
  assert.equal(body.dataset.view, "global");
  assert.deepEqual([...element(".ai-canvas").classes], ["repository-sidebar-open"]);
  assert.equal(element("#nexus-shortcut").classes.has("view-active"), true);
  assert.equal(element("#nexus-shortcut").attributes.get("aria-current"), "page");
  assert.equal(element("#global-codex-panel").classes.has("hidden"), false);
  assert.equal(context.switchPrimaryView("repository"), true);
  assert.equal(element("#nexus-shortcut").classes.has("view-active"), false);
  assert.equal(element("#nexus-shortcut").attributes.has("aria-current"), false);
  assert.equal(element("#global-codex-panel").classes.has("hidden"), true);
  assert.deepEqual([...element(".ai-canvas").classes], ["repository-sidebar-open"]);
  assert.equal(elements.has("#global-codex-toggle"), false);
  assert.equal(context.switchPrimaryView("services"), true);
  assert.equal(body.classes.has("workspace-tool-active"), true);
});

test("Nexus owns task navigation and hides only the repository underlay", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const scopeFunction = app.slice(app.indexOf("function activeTaskPanelScope("), app.indexOf("function syncWorkspaceRail("));
  const state = { workspace: { repositories: [{ id: "repo" }] }, activeRepository: { id: "repo" }, currentView: "global" };
  const context = vm.createContext({ state, document: { body: { classList: { contains: () => true } } } });
  vm.runInContext(scopeFunction, context);
  assert.equal(context.activeTaskPanelScope(), "global", "even transient tool-launch state must target Nexus tasks");
  state.currentView = "services";
  assert.equal(context.activeTaskPanelScope(), "repository", "other tools still preserve the local task dock");
  state.currentView = "repository";
  assert.equal(context.activeTaskPanelScope(), "repository");
  state.workspace.repositories = [];
  assert.equal(context.activeTaskPanelScope(), null);
  assert.match(css, /body\[data-view="global"\] \.app-shell > #workspace\s*\{\s*display:\s*none;\s*\}/);
});

test("saved revision drafts retry through CAS instead of creating another fork", async () => {
  const h = await integrationHarness({ pendingRevision: true }); await h.run();
  assert.match(h.requests[0].url, /revision-draft$/);
  assert.equal(h.requests[0].body.method, "PATCH");
  assert.equal(h.requests[0].body.body.expectedPrompt, "Original <text>");
});

test("repository changes never select a revision under another repository", async () => {
  const before = await integrationHarness();
  before.context.state.activeRepository.id = "different-repo";
  await assert.rejects(before.run(), /original chat/);
  assert.equal(before.requests.length, 0);
  const during = await integrationHarness({ switchDuringRun: true }); await during.run();
  assert.equal(during.runs.length, 1);
  assert.equal(during.selections.length, 0);
  assert.match(during.toasts.at(-1)[0], /original chat/);
});

test("async editor load validates the active chat before showing stale content", async () => {
  let resolveTask, mounted = false, active = true;
  const editor = createPromptEditor({ document: { createElement() { mounted = true; return new Element(); } },
    loadTask: () => new Promise((resolve) => { resolveTask = resolve; }),
    beforeOpen: () => { if (!active) throw new Error("The active chat changed"); return true; }, submit: async () => {},
  });
  const loading = editor.open({ scope: "repository", taskId: "task", messageId: "user1" });
  active = false; resolveTask(task);
  await assert.rejects(loading, /active chat changed/);
  assert.equal(mounted, false);
});
