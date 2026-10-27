import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { attachmentCardMarkup } from "../public/context-attachment-view.mjs";
import vm from "node:vm";
import { composerDraftFunctions } from "./helpers/composer-draft-functions.mjs";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(app);
  assert.ok(match, `Missing production handler ${name}`);
  const end = app.indexOf("\n}", match.index);
  assert.ok(end > match.index);
  return app.slice(match.index, end + 2);
}
const json = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const prompt = "  Explain this method\n";
const jobFor = (scope) => ({ id: "captured-job", taskId: "original-task", repositoryId: scope === "global" ? "global" : "repo-one",
  prompt: prompt.trim(), startedAt: "2026-09-20T16:08:05Z", status: "running", attachments: [{ id: "sent-context" }] });

// Real event-handler source, synthetic state/API only. Nothing can reach the
// user's running Argus, repositories, provider, or saved conversations.
function harness(scope = "repository", { run = false, uploads = false, tray = false } = {}) {
  const h = { scope, calls: [], events: [], recoveries: [], toasts: [], submissions: [], focuses: [], job: jobFor(scope) };
  const state = h.state = {
    currentView: scope,
    activeRepository: { id: "repo-one" }, activeTaskByRepository: { "repo-one": "original-task" }, activeGlobalTaskId: "original-task",
    repositorySubmissions: {}, repositorySubmitting: {}, globalSubmission: null, globalSubmitting: false,
    repositoryDrafts: { "repo-one": prompt }, globalDraft: prompt,
    repositoryAttachments: { "repo-one": [{ id: "sent-context" }] }, globalAttachments: [{ id: "sent-context" }],
    repositoryJobs: [], globalJobs: [], activeJob: null, globalJob: null,
    providers: [{ id: "codex", name: "Codex", authenticated: true }], workspace: { repositories: [{ id: "repo-one" }] },
  };
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        value: selector.endsWith("-prompt") ? prompt : selector.endsWith("-provider") ? "codex" : selector.endsWith("-mode") ? "edit" : "",
        dataset: {}, style: {}, classList: {
          add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)),
          contains: name => classes.has(name), toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        }, focus() { h.focuses.push(selector); }, setAttribute() {},
        children: [], append(child) { this.children.push(child); },
        querySelector(child) { return $(`${selector} ${child}`); },
        set innerHTML(value) { this.markup = value; this.children = []; }, get innerHTML() { return this.markup || ""; },
      });
    }
    return elements.get(selector);
  };
  h.textarea = $(scope === "global" ? "#global-agent-prompt" : "#agent-prompt");
  h.button = $(scope === "global" ? "#run-global-agent" : "#run-agent");
  h.attachments = () => scope === "global" ? state.globalAttachments : state.repositoryAttachments[state.activeRepository.id];
  h.tray = () => $(scope === "global" ? "#global-context-tray .context-chips" : "#agent-context-tray .context-chips");
  h.submission = () => scope === "global" ? state.globalSubmission : state.repositorySubmissions["repo-one"];
  const context = h.context = vm.createContext({
    state, $, window: { argusNexusRepositoryIds: ["repo-one"] }, crypto: { randomUUID: () => "captured-request" },
    checkpointTasks: new Map(), modelDraftEpochs: new Map(), revisionIsBusy: () => false, retryRevisionFromComposer: async () => false,
    currentModelSelectionKey: () => "original-model-selection",
    selectedModelSettings: () => ({ model: "synthetic-model", effort: "high", speed: "standard" }),
    providerCanRun: () => true, modelSelectionError: () => "", validateComposerContext: () => true,
    selectedContextMode: () => "fresh", scopedAttachments: current => current === "global" ? state.globalAttachments : state.repositoryAttachments[state.activeRepository.id],
    document: { createElement: () => ({ listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } }) },
    selectedProvider: () => state.providers[0], providerSupportsContext: () => true,
    formatBytes: size => `${size} B`, escapeHtml: value => String(value || ""), btoa, attachmentCardMarkup,
    taskPromptNotes: {
      capture: () => ({ request: { promptNotes: [{ id: "note-one", text: "Explain only", enabled: true }] } }),
      submitted: () => h.events.push("notes-submitted"),
    },
    appendOptimisticUserMessage: (_scope, submission) => h.submissions.push(submission),
    setComposerPreparingState: () => h.events.push("preparing"),
    finishComposerPreparation: () => h.events.push("preparation-finished"),
    setComposerActionState: () => h.events.push("action-state"), resizeAgentComposer() {},
    runningAgentJob: () => h.job,
    api: async (url, options = {}) => {
      h.calls.push({ url, ...json(options) }); h.events.push(`${options.method || "GET"} ${url}`);
      if (h.onApi) return h.onApi(url, options);
      return { status: "cancelled", stopRequested: true };
    },
    recoverStoppedPrompt: async (current, source) => {
      h.recoveries.push({ scope: current, source: json(source), submitting: current === "global" ? state.globalSubmitting : Boolean(state.repositorySubmitting[source.repositoryId]) });
      if (h.onRecover) return h.onRecover(current, source);
      if (source.kind === "preparation") return context.restoreComposerDraft(source);
    },
    pollGlobalAgent: async () => h.events.push("poll-global"), pollAgent: async () => h.events.push("poll-repository"),
    toast: (...args) => h.toasts.push(args),
    refreshTasks: async (...args) => { h.events.push("refresh-tasks"); h.refreshArgs = args; if (h.onRefresh) return h.onRefresh(...args); },
    selectTask: async (...args) => { h.events.push("select-task"); if (h.onSelect) return h.onSelect(...args); },
    retainStartedTaskSelection: async () => { h.events.push("retain-selection"); if (h.onRetain) return h.onRetain(); },
    syncViewUrl() {}, renderContextTray() {},
    agentJobIsActive: job => ["starting", "running", "paused"].includes(job.status) || Boolean(job.completionPending),
    repositoryIdeBridge: { openCodeDiscussions() { throw Error("Unexpected code-discussion navigation"); } },
  });
  const names = ["activeTaskId", ...composerDraftFunctions, "composerSubmission", "stopAgent"];
  if (run) names.push("runAgent", "runGlobalAgent", "stopReturnedSubmission");
  if (uploads) names.push("attachPastedImages", "attachSelectedFiles", "handleComposerPaste", "attachLatestBrowserContext", "arrayBufferToBase64", "insertTextAtCursor");
  if (tray) names.push("renderContextTray");
  vm.runInContext(names.map(declaration).join("\n"), context);
  h.stop = () => context.stopAgent(scope);
  h.run = () => scope === "global" ? context.runGlobalAgent() : context.runAgent();
  return h;
}

for (const scope of ["global", "repository"]) {
  test(`${scope}: a deferred run clears and renders its attachments immediately, preserving a reattached same-ID file`, async () => {
    const h = harness(scope, { run: true, tray: true });
    const response = deferred(); h.onApi = () => response.promise;
    const running = h.run(); await settle();
    assert.equal(h.textarea.value, "");
    assert.deepEqual(h.attachments(), []);
    assert.equal(h.tray().innerHTML, "");
    assert.deepEqual(json(h.calls[0].body.attachmentIds), ["sent-context"]);
    assert.deepEqual(json(h.submissions[0].attachments), [{ id: "sent-context" }]);
    assert.equal(h.submissions[0].draft, prompt);
    h.textarea.value = "New prompt";
    h.attachments().push({ id: "sent-context", title: "Explicitly attached again" });
    response.resolve({ ...jobFor(scope) }); await running;
    assert.equal(h.textarea.value, "New prompt");
    assert.equal(h.attachments()[0].title, "Explicitly attached again");
  });

  test(`${scope}: failed submissions restore exact text and attachments when the composer is empty`, async () => {
    const h = harness(scope, { run: true });
    const response = deferred(); h.onApi = () => response.promise;
    const running = h.run(); await settle();
    assert.equal(h.textarea.value, ""); assert.equal(h.attachments().length, 0);
    response.reject(new Error("Unavailable")); await running;
    assert.equal(h.textarea.value, prompt);
    assert.deepEqual(json(h.attachments()), [{ id: "sent-context" }]);
  });

  test(`${scope}: failure recovery swaps with a newer draft without losing either prompt or its files`, async () => {
    const h = harness(scope, { run: true, tray: true });
    const response = deferred(); h.onApi = () => response.promise;
    const running = h.run(); await settle();
    h.textarea.value = "New draft"; h.context.storeComposerDraft(scope);
    h.attachments().push({ id: "new-context" });
    response.reject(new Error("Unavailable")); await running;
    assert.equal(h.textarea.value, "New draft");
    assert.deepEqual(json(h.attachments()), [{ id: "new-context" }]);
    assert.equal(h.tray().children[0].textContent, "Restore unsent request");
    h.tray().children[0].listeners.click();
    assert.equal(h.textarea.value, prompt);
    assert.deepEqual(json(h.attachments()), [{ id: "sent-context" }]);
    h.tray().children[0].listeners.click();
    assert.equal(h.textarea.value, "New draft");
    assert.deepEqual(json(h.attachments()), [{ id: "new-context" }]);
  });

  test(`${scope}: task switching during a failed run keeps the original draft recoverable only in its task`, async () => {
    const h = harness(scope, { run: true, tray: true });
    const response = deferred(); h.onApi = () => response.promise;
    const running = h.run(); await settle();
    if (scope === "global") h.state.activeGlobalTaskId = "other-task";
    else h.state.activeTaskByRepository["repo-one"] = "other-task";
    h.textarea.value = "Other task draft";
    response.reject(new Error("Unavailable")); await running;
    assert.equal(h.textarea.value, "Other task draft");
    assert.equal(h.context.composerRecoveries(scope).length, 0);
    if (scope === "global") h.state.activeGlobalTaskId = "original-task";
    else h.state.activeTaskByRepository["repo-one"] = "original-task";
    h.context.renderContextTray(scope);
    assert.equal(h.tray().children[0].textContent, "Restore unsent request");
  });

  for (const kind of ["image", "file", "paste", "browser"]) {
    test(`${scope}: ${kind} finishing after submit cannot repopulate the cleared composer`, async () => {
      const h = harness(scope, { uploads: true });
      const response = deferred(); h.onApi = () => response.promise;
      const file = { name: "test.png", type: "image/png", size: 10, arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
      let prevented = false;
      const event = { currentTarget: h.textarea, preventDefault() { prevented = true; }, clipboardData: {
        items: kind === "image" ? [{ kind: "file", type: "image/png", getAsFile: () => file }] : [], getData: () => "x".repeat(4_001),
      } };
      const pending = kind === "image" || kind === "paste" ? h.context.handleComposerPaste(event, scope)
        : kind === "file" ? h.context.attachSelectedFiles([file], scope) : h.context.attachLatestBrowserContext(scope);
      if (kind === "image" || kind === "paste") assert.equal(prevented, true, "paste default is prevented before yielding");
      event.currentTarget = null;
      await settle();
      h.context.takeComposerDraft(scope);
      response.resolve({ id: "late-context", title: "Late file", size: 10 }); await pending;
      assert.equal(h.textarea.value, ""); assert.equal(h.attachments().length, 0);
      assert.deepEqual(json(h.context.composerRecoveries(scope)[0].attachments), [{ id: "late-context", title: "Late file", size: 10 }]);
    });
  }

  test(`${scope}: upload completion after a task switch never adds context or autofill to the other task`, async () => {
    const h = harness(scope, { uploads: true });
    const response = deferred(); h.onApi = () => response.promise;
    const pending = h.context.attachLatestBrowserContext(scope);
    if (scope === "global") h.state.activeGlobalTaskId = "other-task";
    else h.state.activeTaskByRepository["repo-one"] = "other-task";
    h.textarea.value = "Different task";
    response.resolve({ id: "late-browser", title: "Browser" }); await pending;
    assert.equal(h.textarea.value, "Different task");
    assert.deepEqual(json(h.attachments()), [{ id: "sent-context" }]);
    assert.equal(h.context.composerRecoveries(scope).length, 0);
    const original = { repositoryId: scope === "global" ? "global" : "repo-one", taskId: "original-task" };
    assert.equal(h.context.composerRecoveries(scope, original)[0].attachments[0].id, "late-browser");
  });

  for (const timing of ["before", "after"]) test(`${scope}: upload finishing ${timing} first-submit acceptance stays recoverable in the created task`, async () => {
    const h = harness(scope, { run: true, uploads: true, tray: true });
    if (scope === "global") h.state.activeGlobalTaskId = null;
    else h.state.activeTaskByRepository["repo-one"] = null;
    const upload = deferred(), run = deferred();
    h.onApi = url => url === "/api/browser-context/latest" ? upload.promise : run.promise;
    const uploading = h.context.attachLatestBrowserContext(scope);
    const running = h.run(); await settle();
    if (timing === "before") { upload.resolve({ id: "late-browser", title: "Browser" }); await uploading; }
    run.resolve({ ...jobFor(scope), taskId: "created-task" }); await running;
    if (timing === "after") { upload.resolve({ id: "late-browser", title: "Browser" }); await uploading; }
    assert.equal(h.context.activeTaskId(scope), "created-task");
    assert.equal(h.textarea.value, "");
    assert.equal(h.attachments().length, 0);
    assert.equal(h.context.composerRecoveries(scope)[0].attachments[0].id, "late-browser");
    assert.equal(h.tray().children[0].textContent, "Restore unsent request");
    assert.equal(h.state.composerUploads.size, 0);
    h.tray().children[0].listeners.click();
    assert.equal(h.attachments()[0].id, "late-browser");
  });

  test(`${scope}: restoring a partly uploaded file batch attaches later files once to that restored draft`, async () => {
    const h = harness(scope, { uploads: true, tray: true });
    const uploads = [deferred(), deferred()]; let index = 0;
    h.onApi = () => uploads[index++].promise;
    const file = name => ({ name, size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer });
    const uploading = h.context.attachSelectedFiles([file("first.txt"), file("second.txt")], scope);
    await settle(); h.context.takeComposerDraft(scope);
    uploads[0].resolve({ id: "first", title: "first.txt" }); await settle();
    h.tray().children[0].listeners.click();
    assert.deepEqual(json(h.attachments().map(item => item.id)), ["first"]);
    uploads[1].resolve({ id: "second", title: "second.txt" }); await uploading;
    assert.deepEqual(json(h.attachments().map(item => item.id)), ["first", "second"]);
    assert.equal(h.context.composerRecoveries(scope).length, 0);
  });

  test(`${scope}: cancelled preparation remains recoverable when the stop editor cannot open`, async () => {
    const h = harness(scope, { run: true, tray: true });
    h.onRecover = async () => false;
    h.onApi = async () => { h.submission().cancelled = true; h.state.currentView = "services"; throw Error("Cancelled"); };
    await h.run();
    assert.equal(h.context.composerRecoveries(scope)[0].draft, prompt);
    assert.equal(h.context.composerRecoveries(scope)[0].attachments[0].id, "sent-context");
    assert.equal(h.tray().children[0].textContent, "Restore stopped request");
  });

  test(`${scope}: accepted Stop opens editing only for the captured job and keeps a newer draft`, async () => {
    for (const receipt of [{ status: "cancelled" }, { status: "running", stopRequested: true }]) {
      const h = harness(scope); h.textarea.value = "A newer unsent prompt";
      h.onApi = async () => { h.job.prompt = "Mutated after await"; return receipt; };
      await h.stop();
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].url, "/api/agents/jobs/captured-job");
      assert.equal(h.calls[0].method, "DELETE");
      assert.equal(h.calls[0].headers["X-Argus-Cancel-Control"], `${scope === "global" ? "global" : "repository"}-composer-stop`);
      assert.equal(h.calls[0].body, undefined);
      assert.equal(h.recoveries.length, 1);
      assert.equal(h.recoveries[0].source.prompt, prompt.trim());
      assert.equal(h.recoveries[0].source.taskId, "original-task");
      assert.equal(h.textarea.value, "A newer unsent prompt");
      assert.equal(h.button.classList.contains("is-stopping"), false);
    }
  });

  test(`${scope}: completion winning the Stop race does not open Edit`, async () => {
    for (const receipt of [{ status: "completed" }, { status: "failed" }, {}, null]) {
      const h = harness(scope); h.onApi = async () => receipt;
      await h.stop();
      assert.deepEqual(h.recoveries, []);
      assert.ok(h.events.includes(scope === "global" ? "poll-global" : "poll-repository"));
    }
  });

  test(`${scope}: failed cancellation neither restores nor opens the prompt`, async () => {
    const h = harness(scope); h.onApi = async () => { throw Error("Cancellation unavailable"); };
    await h.stop();
    assert.deepEqual(h.recoveries, []);
    assert.equal(h.textarea.value, prompt);
    assert.equal(h.toasts[0]?.[0], "Cancellation unavailable");
    assert.equal(h.button.classList.contains("is-stopping"), false);
  });

  test(`${scope}: preparation Stop targets the captured request and waits for its submit result to recover`, async () => {
    const h = harness(scope);
    const submission = { taskId: "original-task", repositoryId: scope === "global" ? "global" : "repo-one", requestId: "preparation-one", cancelled: false };
    if (scope === "global") h.state.globalSubmission = submission;
    else h.state.repositorySubmissions["repo-one"] = submission;
    await h.stop();
    assert.equal(submission.cancelled, true);
    assert.equal(h.calls[0].url, "/api/agents/preparations/preparation-one");
    assert.deepEqual(h.recoveries, []);
    assert.equal(h.button.classList.contains("is-stopping"), false);
  });

  test(`${scope}: draft recovery protects the newer textarea and cached draft`, () => {
    const h = harness(scope); h.textarea.value = "new draft";
    if (scope === "global") h.state.globalDraft = "new draft";
    else h.state.repositoryDrafts["repo-one"] = "new draft";
    const restored = h.context.restoreComposerDraft({ ...jobFor(scope), draft: "old draft" });
    assert.equal(restored, false);
    assert.equal(h.textarea.value, "new draft");
    assert.equal(scope === "global" ? h.state.globalDraft : h.state.repositoryDrafts["repo-one"], "new draft");
    assert.deepEqual(h.focuses, []);
  });

  test(`${scope}: draft recovery requires the exact task and repository`, () => {
    for (const changed of [{ taskId: "different-task" }, { repositoryId: "different-repo" }]) {
      const h = harness(scope); h.textarea.value = "";
      assert.equal(h.context.restoreComposerDraft({ ...jobFor(scope), draft: "old draft", ...changed }), false);
      assert.equal(h.textarea.value, "");
      assert.equal(scope === "global" ? h.state.globalDraft : h.state.repositoryDrafts["repo-one"], prompt);
    }
  });

  test(`${scope}: a safe empty composer receives the exact original draft without trimming`, () => {
    const h = harness(scope); h.textarea.value = "";
    (scope === "global" ? h.state.globalAttachments : h.state.repositoryAttachments["repo-one"]).length = 0;
    assert.equal(h.context.restoreComposerDraft({ ...jobFor(scope), draft: prompt }), true);
    assert.equal(h.textarea.value, prompt);
    assert.equal(scope === "global" ? h.state.globalDraft : h.state.repositoryDrafts["repo-one"], prompt);
    assert.equal(h.focuses.length, 1);
  });

  test(`${scope}: cancelled preparation failure restores through captured recovery after clearing submission flags`, async () => {
    const h = harness(scope, { run: true });
    h.onApi = async () => { h.submission().cancelled = true; throw Error("Response preparation was cancelled"); };
    await h.run();
    assert.equal(h.recoveries.length, 1);
    const recovery = h.recoveries[0];
    assert.equal(recovery.source.kind, "preparation");
    assert.equal(recovery.source.taskId, "original-task");
    assert.equal(recovery.source.draft, prompt);
    assert.equal(recovery.submitting, false);
    assert.equal(h.submission() == null, true);
    assert.equal(h.refreshArgs[1], false);
    assert.equal(h.refreshArgs[2].preserveSelection, true);
    assert.deepEqual(json(scope === "global" ? h.state.globalAttachments : h.state.repositoryAttachments["repo-one"]), [{ id: "sent-context" }]);
  });

  test(`${scope}: cancelled preparation result cannot recover into a later selected chat`, async () => {
    const h = harness(scope, { run: true });
    h.onApi = async () => {
      h.submission().cancelled = true;
      if (scope === "global") h.state.activeGlobalTaskId = "newer-task";
      else h.state.activeTaskByRepository["repo-one"] = "newer-task";
      h.textarea.value = "newer draft";
      throw Error("Response preparation was cancelled");
    };
    await h.run();
    assert.deepEqual(h.recoveries, []);
    assert.equal(h.textarea.value, "newer draft");
    assert.equal(h.events.includes("refresh-tasks"), false);
  });

  test(`${scope}: a late accepted job is stopped before UI refreshes can fail`, async () => {
    const h = harness(scope, { run: true });
    h.onApi = async (url, options) => {
      if (options.method === "POST") { h.submission().cancelled = true; return { ...jobFor(scope) }; }
      if (options.method === "DELETE") return { ...jobFor(scope), status: "cancelled", stopRequested: true };
      throw Error(`Unexpected request ${url}`);
    };
    h.onRefresh = async () => { throw Error("Refresh unavailable"); };
    await h.run();
    const stop = h.events.indexOf("DELETE /api/agents/jobs/captured-job");
    const retain = h.events.indexOf("retain-selection");
    assert.ok(stop >= 0, "cancelled preparation must stop its returned job even when refresh fails");
    assert.ok(retain < 0 || stop < retain, "stop must precede the first async UI bookkeeping");
    assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
    assert.equal(h.calls.find(call => call.method === "DELETE").headers["X-Argus-Cancel-Control"], `${scope === "global" ? "global" : "repository"}-composer-stop`);
    assert.equal(h.recoveries.length, 1, "confirmed cancellation must still recover the original prompt after a presentation refresh fails");
    assert.equal(h.recoveries[0].source.taskId, "original-task");
  });

  for (const phase of ["post", "retain"]) {
    test(`${scope}: cancelled POST success cannot reselect the old chat after navigation during ${phase}`, async () => {
      const h = harness(scope, { run: true });
      const navigate = () => {
        if (scope === "global") h.state.activeGlobalTaskId = "newer-task";
        else h.state.activeTaskByRepository["repo-one"] = "newer-task";
        h.textarea.value = "A draft in the newer chat";
      };
      h.onApi = async (_url, options) => {
        if (options.method === "POST") {
          h.submission().cancelled = true;
          if (phase === "post") navigate();
          return { ...jobFor(scope) };
        }
        return { ...jobFor(scope), status: "cancelled", stopRequested: true };
      };
      if (phase === "retain") h.onRetain = async () => navigate();
      await h.run();
      assert.equal(scope === "global" ? h.state.activeGlobalTaskId : h.state.activeTaskByRepository["repo-one"], "newer-task");
      assert.equal(h.textarea.value, "A draft in the newer chat");
      assert.equal(h.events.includes("select-task"), false, "late completion must not navigate back to its original chat");
      assert.deepEqual(h.recoveries, []);
      assert.equal(scope === "global" ? h.state.globalJob : h.state.activeJob, null);
      assert.equal((scope === "global" ? h.state.globalJobs : h.state.repositoryJobs).some(job => job.id === "captured-job"), true, "background job remains available in its own scope");
      assert.equal(h.calls.filter(call => call.method === "DELETE").length, 1);
      assert.equal(h.submission() == null, true);
    });
  }

  test(`${scope}: ordinary accepted submission never issues a cancellation or reopens its prompt`, async () => {
    const h = harness(scope, { run: true });
    h.onApi = async () => ({ ...jobFor(scope) });
    await h.run();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, "POST");
    assert.deepEqual(h.recoveries, []);
  });

  test(`${scope}: context added while submission is starting is retained after acceptance`, async () => {
    const h = harness(scope, { run: true });
    h.onApi = async () => {
      const attachments = scope === "global" ? h.state.globalAttachments : h.state.repositoryAttachments["repo-one"];
      attachments.push({ id: "newer-context" });
      return { ...jobFor(scope) };
    };
    await h.run();
    assert.deepEqual(json(scope === "global" ? h.state.globalAttachments : h.state.repositoryAttachments["repo-one"]), [{ id: "newer-context" }]);
  });

  test(`${scope}: cancellation during acceptance bookkeeping still stops the exact returned job`, async () => {
    const h = harness(scope, { run: true });
    h.onApi = async (_url, options) => options.method === "POST"
      ? { ...jobFor(scope) } : { ...jobFor(scope), status: "cancelled", stopRequested: true };
    h.onRetain = async () => { h.submission().cancelled = true; };
    await h.run();
    assert.equal(h.calls.filter(call => call.method === "DELETE").length, 1);
    assert.equal(h.calls.find(call => call.method === "DELETE").url, "/api/agents/jobs/captured-job");
    assert.equal(h.recoveries[0]?.source.taskId, "original-task");
    assert.equal(h.recoveries[0]?.submitting, false);
  });
}
