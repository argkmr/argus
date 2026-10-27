import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { apiSnapshotHasContent, apiSnapshotKey, apiSnapshotRequestKey } from "../public/api-request-history.mjs";
import { normalizeRequestParameters, queryParametersFromUrl, requestParametersFromObject, requestParametersToObject } from "../public/api-request-parameters.js";
import { renderResponseContent } from "../public/api-response-renderer.mjs";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const declaration = name => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Production function ${name} exists`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
};
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const nodes = new Map(), notices = [], records = [], sends = [], historyLoads = [], sidebars = [];
  const rows = { query: [], headers: [] };
  const state = {
    apiRequests: [], apiCollections: [], apiEnvironments: [], activeApiEnvironmentId: "",
    activeApiRequest: null, apiResponse: null, apiResponseRequestKey: null, apiEditorReady: true, apiEditorGeneration: 1,
    apiEditorTransition: 0, apiActiveSend: null, apiHistoryLastKey: null,
    apiHistoryWrite: Promise.resolve(), apiHistoryFailedResponses: new Map(), apiHistoryPendingIds: new Set(),
  };
  const node = selector => {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, {
        value: "", dataset: {}, textContent: "", innerHTML: "", classes,
        classList: {
          add: (...names) => names.forEach(name => classes.add(name)),
          remove: (...names) => names.forEach(name => classes.delete(name)),
          contains: name => classes.has(name),
          toggle(name, enabled = !classes.has(name)) { enabled ? classes.add(name) : classes.delete(name); return enabled; },
        },
        setAttribute(name, value) { this[name] = value; }, focus() {},
      });
    }
    return nodes.get(selector);
  };
  const form = node("#api-request-form");
  form.elements = Object.fromEntries(["id", "name", "method", "url", "body", "collectionId", "queryParamsText", "headersText"].map(name => [name, node(`form:${name}`)]));
  let resets = 0, lists = 0;
  form.reset = () => {
    resets++;
    for (const field of Object.values(form.elements)) field.value = "";
    form.elements.method.value = "GET";
    form.elements.queryParamsText.value = "{}";
    form.elements.headersText.value = "{}";
  };
  form.reset(); resets = 0;
  for (const kind of ["query", "headers"]) node(`#api-${kind}-editor`).dataset.parameterView = "table";
  for (const kind of ["query", "headers", "body"]) {
    node(`[data-api-editor="${kind}"]`).dataset.apiEditor = kind;
    node(`[data-api-editor="${kind}"]`).classList.toggle("active", kind === "query");
  }
  for (const tab of ["body", "headers"]) {
    node(`[data-api-response="${tab}"]`).dataset.apiResponse = tab;
    node(`[data-api-response="${tab}"]`).classList.toggle("active", tab === "body");
  }
  node("#toggle-response-wrap").classList.add("active");
  const $ = selector => {
    if (selector === "[data-api-editor].active") return ["query", "headers", "body"].map(kind => node(`[data-api-editor="${kind}"]`)).find(item => item.classes.has("active"));
    if (selector === "[data-api-response].active") return ["body", "headers"].map(kind => node(`[data-api-response="${kind}"]`)).find(item => item.classes.has("active"));
    return node(selector);
  };
  const $$ = selector => {
    if (selector === "[data-api-response]") return ["body", "headers"].map(kind => node(`[data-api-response="${kind}"]`));
    if (selector === ".api-response-panel pre") return [node("#api-response-body"), node("#api-response-headers")];
    return [];
  };
  const controls = {
    record: async (_snapshot, id) => ({ id: id || `entry-${records.length}` }),
    send: async () => ({ status: 200, ok: true, body: '{"ok":true}', headers: {}, durationMs: 1, sizeBytes: 11 }),
    load: async () => { throw new Error("No fixture loaded"); },
    read: async path => path.endsWith("/location") ? { path: "isolated-fixture" } : [],
  };
  const apiRequestHistory = {
    async record(snapshot, id) { records.push({ snapshot: clone(snapshot), id }); return controls.record(snapshot, id); },
    async load(id) { historyLoads.push(id); return controls.load(id); },
  };
  const context = vm.createContext({
    $, $$, state, document: { activeElement: null }, localStorage: { setItem() {}, removeItem() {} }, apiSnapshotHasContent, apiSnapshotKey, apiSnapshotRequestKey, apiRequestHistory,
    normalizeRequestParameters, queryParametersFromUrl, requestParametersFromObject, requestParametersToObject,
    renderResponseContent, API_CLIENT_REPOSITORY_ID: "standalone-api-client", toast: (...args) => notices.push(args),
    apiParameterRows: (kind, raw = false) => clone(rows[kind]).map(item => raw ? item : { ...item, key: item.key.trim(), description: item.description.trim() }),
    renderApiParameterRows: (kind, values) => { rows[kind] = normalizeRequestParameters(values); },
    apiParameterJsonInput: kind => form.elements[kind === "query" ? "queryParamsText" : "headersText"],
    apiParameterContainer: kind => node(`#${kind}-rows`),
    setApiParameterView: (kind, view) => { node(`#api-${kind}-editor`).dataset.parameterView = view; },
    renderApiCollectionOptions() {}, renderApiRequestList() { lists++; }, renderApiUrlHighlight() {},
    showResolvedApiUrl() {}, renderApiEnvironmentSelector() {},
    selectApiSidebar: view => sidebars.push(view),
    apiRequestFromForm: () => ({ method: form.elements.method.value, url: form.elements.url.value, body: form.elements.body.value }),
    switchPrimaryView() {}, refreshApiRequestHistory() {}, setRefreshLoading() {}, skeletonRows: () => "loading",
    async api(path, options) {
      if (path === "/api/api-requests/send") { sends.push(clone(options.body)); return controls.send(options.body); }
      return controls.read(path);
    },
  });
  vm.runInContext([
    "resetApiResponse", "captureApiRequestSnapshot", "preserveApiEditor", "editApiRequest", "applyApiRequest",
    "renderApiResponse", "restoreApiRequestSnapshot", "openApiHistoryEntry", "sendApiRequest", "openApiClient", "refreshApiClientData",
  ].map(declaration).join("\n"), context);
  return { context, state, form, rows, node, notices, records, sends, controls, historyLoads, sidebars, get resets() { return resets; }, get lists() { return lists; } };
}

test("New request persists the current unsaved editor before clearing it", async () => {
  const h = harness(), gate = deferred();
  h.form.elements.url.value = "https://example.invalid/previous";
  h.form.elements.body.value = "unsaved body";
  h.controls.record = () => gate.promise;
  const opening = h.context.editApiRequest();
  await turn();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].snapshot.request.body, "unsaved body");
  assert.equal(h.resets, 0);
  assert.equal(h.form.elements.url.value, "https://example.invalid/previous");
  gate.resolve({ id: "kept" });
  assert.equal(await opening, true);
  assert.equal(h.resets, 1);
  assert.equal(h.form.elements.url.value, "");
  assert.deepEqual(h.sidebars, ["history"]);
});

test("storage failure keeps the current form and response intact", async () => {
  const h = harness();
  h.form.elements.url.value = "https://example.invalid/do-not-lose";
  h.state.apiResponse = { status: 500, body: "preserved response" };
  const before = clone(h.context.captureApiRequestSnapshot());
  h.controls.record = async () => { throw new Error("disk unavailable"); };
  assert.equal(await h.context.editApiRequest(), false);
  assert.equal(h.resets, 0);
  assert.deepEqual(clone(h.context.captureApiRequestSnapshot()), before);
  assert.match(h.notices.at(-1)[0], /current request is still here/);
});

test("New request archives text entered before the API editor has finished initial loading", async () => {
  const h = harness();
  h.state.apiEditorReady = false;
  h.form.elements.url.value = "https://example.invalid/first-draft";
  h.form.elements.body.value = "typed before first load completed";
  assert.equal(await h.context.editApiRequest(), true);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].snapshot.request.url, "https://example.invalid/first-draft");
  assert.equal(h.records[0].snapshot.request.body, "typed before first load completed");
  assert.equal(h.form.elements.body.value, "");
  assert.equal(h.state.apiEditorReady, true);
  assert.equal(h.resets, 1);
});

test("first API load never replaces a draft entered before or during its fetch", async () => {
  const h = harness(), gate = deferred();
  h.state.apiEditorReady = false;
  h.form.elements.body.value = "text entered before fetching";
  const defaultRead = h.controls.read;
  h.controls.read = path => path.endsWith("/api-requests") ? gate.promise : defaultRead(path);
  const loading = h.context.openApiClient();
  await turn();
  h.form.elements.url.value = "{{base}}/still-editing";
  h.form.elements.body.value = "text edited while fetching";
  h.form.elements.headersText.value = '{"unfinished":';
  gate.resolve([{ id: "saved", name: "Saved request", url: "https://example.invalid/saved" }]);
  await loading;
  assert.equal(h.resets, 0);
  assert.equal(h.form.elements.url.value, "{{base}}/still-editing");
  assert.equal(h.form.elements.body.value, "text edited while fetching");
  assert.equal(h.form.elements.headersText.value, '{"unfinished":');
  assert.equal(h.state.activeApiRequest, null);
  assert.equal(h.state.apiEditorReady, true);
  assert.equal(h.records.length, 0, "A list fetch need not archive or clear an in-progress form");
});

test("edits made while History is saving are also saved before navigation", async () => {
  const h = harness(), gate = deferred();
  h.form.elements.body.value = "first draft";
  h.controls.record = async () => h.records.length === 1 ? gate.promise : { id: "latest" };
  const opening = h.context.editApiRequest();
  await turn();
  h.form.elements.body.value = "second draft typed during save";
  gate.resolve({ id: "first" });
  assert.equal(await opening, true);
  assert.equal(h.records.length, 2);
  assert.equal(h.records[1].snapshot.request.body, "second draft typed during save");
  assert.equal(h.form.elements.body.value, "");
});

test("a slower earlier navigation cannot overwrite the newest selected request", async () => {
  const h = harness(), gate = deferred();
  h.form.elements.body.value = "old draft";
  h.controls.record = () => gate.promise;
  const first = h.context.editApiRequest({ name: "Earlier", url: "https://example.invalid/earlier" });
  await turn();
  const second = h.context.editApiRequest({ name: "Latest", url: "https://example.invalid/latest" });
  gate.resolve({ id: "saved" });
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(h.form.elements.name.value, "Latest");
  assert.equal(h.resets, 1);
});

test("a delayed history load does not replace a newer New request editor", async () => {
  const h = harness(), gate = deferred();
  h.controls.load = () => gate.promise;
  const opening = h.context.openApiHistoryEntry("old-entry");
  await h.context.editApiRequest();
  h.form.elements.body.value = "new unsaved text";
  const snapshot = clone(h.context.captureApiRequestSnapshot());
  snapshot.request.body = "stale history";
  gate.resolve({ snapshot }); await opening;
  assert.equal(h.form.elements.body.value, "new unsaved text");
  assert.equal(h.resets, 1);
});

test("History reopens a deleted saved request as a safe unsaved draft without recreating its collection", async () => {
  const h = harness();
  const snapshot = clone(h.context.captureApiRequestSnapshot());
  snapshot.request = { ...snapshot.request, id: "deleted-request", name: "Archived request", collectionId: "deleted-collection", url: "https://example.invalid/archived" };
  h.controls.load = async () => ({ snapshot });
  await h.context.openApiHistoryEntry("archived-entry");
  assert.equal(h.form.elements.id.value, "");
  assert.equal(h.form.elements.collectionId.value, "");
  assert.equal(h.form.elements.name.value, "Archived request");
  assert.equal(h.form.elements.url.value, "https://example.invalid/archived");
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.state.apiCollections, []);
});

test("malformed raw JSON and disabled duplicate parameter rows reopen without normalization loss", async () => {
  const h = harness();
  h.form.elements.url.value = "{{base}}/orders? unfinished=%";
  h.form.elements.body.value = '{"partial":';
  h.form.elements.queryParamsText.value = '{"unfinished query":';
  h.form.elements.headersText.value = '{"unfinished header":';
  h.node("#api-query-editor").dataset.parameterView = "json";
  h.node("#api-headers-editor").dataset.parameterView = "json";
  h.rows.query = [
    { key: " duplicate ", value: "first", enabled: false, description: "  keep spaces  " },
    { key: " duplicate ", value: "second", enabled: true, description: "second" },
  ];
  h.rows.headers = [
    { key: "X-Test", value: "one", enabled: false, description: "" },
    { key: "X-Test", value: "two", enabled: true, description: "" },
  ];
  const before = clone(h.context.captureApiRequestSnapshot());
  assert.equal(await h.context.editApiRequest(), true);
  assert.equal(await h.context.editApiRequest(before.request, { snapshot: before }), true);
  const restored = clone(h.context.captureApiRequestSnapshot());
  assert.deepEqual(restored, before);
  assert.equal(h.form.elements.url.dataset.template, before.request.url);
  assert.equal(h.sends.length, 0, "Reopening must never send a request");
});

test("response tabs, wrapping, environment and prior response return with History", async () => {
  const h = harness();
  h.form.elements.url.value = "{{origin}}/data";
  h.state.activeApiEnvironmentId = "qa-environment";
  h.state.apiResponse = { status: 500, statusText: "Internal Server Error", ok: false, headers: { "x-note": "it's ready" }, body: '{"message":"Can\'t perform operation"}', durationMs: 12, sizeBytes: 42 };
  h.node('[data-api-response="body"]').classList.remove("active");
  h.node('[data-api-response="headers"]').classList.add("active");
  h.node("#toggle-response-wrap").classList.remove("active");
  const saved = clone(h.context.captureApiRequestSnapshot());
  await h.context.editApiRequest();
  await h.context.editApiRequest(saved.request, { snapshot: saved });
  assert.deepEqual(clone(h.state.apiResponse), saved.response);
  assert.equal(h.state.activeApiEnvironmentId, "qa-environment");
  assert.equal(h.node("#api-response-body").classes.has("hidden"), true);
  assert.equal(h.node("#api-response-headers").classes.has("hidden"), false);
  assert.equal(h.node("#api-response-body").classes.has("no-wrap"), true);
  assert.equal(h.node("#toggle-response-wrap").textContent, "No wrap");
});

test("refreshing API client lists never resets an existing draft or response", async () => {
  const h = harness();
  h.form.elements.body.value = "unsaved draft";
  h.form.elements.headersText.value = '{"unfinished":';
  h.state.apiResponse = { status: 200, body: "last response" };
  const before = clone(h.context.captureApiRequestSnapshot());
  await h.context.openApiClient();
  await h.context.refreshApiClientData();
  assert.equal(h.resets, 0);
  assert.deepEqual(clone(h.context.captureApiRequestSnapshot()), before);
  assert.equal(h.records.length, 0);
  assert.equal(h.lists, 2);
});

test("late send responses stay in their original History entry and never replace a newer editor", async () => {
  const h = harness(), gate = deferred();
  h.form.elements.url.value = "https://example.invalid/first";
  h.state.activeApiEnvironmentId = "original-environment";
  h.controls.send = () => gate.promise;
  const sending = h.context.sendApiRequest({ preventDefault() {} });
  await turn();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].environmentId, "original-environment");
  await h.context.editApiRequest();
  h.form.elements.body.value = "new draft";
  h.state.activeApiEnvironmentId = "another-environment";
  const oldResponse = { status: 201, body: "old response", headers: {} };
  gate.resolve(oldResponse); await sending;
  assert.equal(h.form.elements.body.value, "new draft");
  assert.equal(h.state.apiResponse, null);
  assert.equal(h.records.at(-1).id, "entry-1");
  assert.deepEqual(h.records.at(-1).snapshot.response, oldResponse);
  assert.equal(h.records.at(-1).snapshot.environmentId, "original-environment");
  assert.equal(h.node("#send-api-request").disabled, false);
});

test("failed initial History persistence prevents network dispatch", async () => {
  const h = harness();
  h.form.elements.url.value = "https://example.invalid/write";
  h.form.elements.body.value = "do not lose";
  h.controls.record = async () => { throw new Error("storage failed"); };
  await h.context.sendApiRequest({ preventDefault() {} });
  assert.equal(h.sends.length, 0);
  assert.equal(h.form.elements.body.value, "do not lose");
  assert.equal(h.node("#send-api-request").disabled, false);
  assert.match(h.notices.at(-1)[0], /Nothing was sent/);
});

test("editing an in-flight request does not attach the older response to the changed draft", async () => {
  const h = harness(), gate = deferred();
  h.form.elements.url.value = "https://example.invalid/original";
  h.form.elements.body.value = "original body";
  h.state.activeApiEnvironmentId = "original-environment";
  h.controls.send = () => gate.promise;
  const sending = h.context.sendApiRequest({ preventDefault() {} });
  await turn();
  h.form.elements.url.value = "https://example.invalid/changed";
  h.form.elements.body.value = "new body typed while sending";
  h.state.activeApiEnvironmentId = "another-environment";
  gate.resolve({ status: 200, body: "original response", headers: {} });
  await sending;
  assert.equal(h.form.elements.body.value, "new body typed while sending");
  assert.equal(h.state.apiResponse, null, "An older response must not be paired with a changed request");
  assert.equal(h.context.captureApiRequestSnapshot().response, null);
  await h.context.editApiRequest();
  const changedDraft = h.records.find(item => item.snapshot.request.url === "https://example.invalid/changed");
  assert.ok(changedDraft);
  assert.equal(changedDraft.snapshot.kind, "draft");
  assert.equal(changedDraft.snapshot.response, null);
  const result = h.records.find(item => item.id && item.snapshot.response);
  assert.equal(result.snapshot.request.url, "https://example.invalid/original");
  assert.equal(result.snapshot.environmentId, "original-environment");
  assert.equal(result.snapshot.response.body, "original response");
});

test("a changed draft cannot recapture an already displayed response from the previous request", async () => {
  const h = harness();
  h.form.elements.url.value = "https://example.invalid/original";
  await h.context.sendApiRequest({ preventDefault() {} });
  assert.ok(h.state.apiResponse);
  h.form.elements.body.value = "different request body";
  const draft = h.context.captureApiRequestSnapshot();
  assert.equal(draft.response, null);
  assert.equal(draft.kind, "draft");
  await h.context.editApiRequest();
  const recorded = h.records.at(-1).snapshot;
  assert.equal(recorded.request.body, "different request body");
  assert.equal(recorded.response, null);
  assert.equal(recorded.kind, "draft");
});

test("changing only response tabs and wrapping while sending does not discard the valid response", async () => {
  const h = harness(), gate = deferred();
  h.form.elements.url.value = "https://example.invalid/same";
  h.controls.send = () => gate.promise;
  const sending = h.context.sendApiRequest({ preventDefault() {} });
  await turn();
  h.node('[data-api-response="body"]').classList.remove("active");
  h.node('[data-api-response="headers"]').classList.add("active");
  h.node('[data-api-editor="query"]').classList.remove("active");
  h.node('[data-api-editor="body"]').classList.add("active");
  h.node("#toggle-response-wrap").classList.remove("active");
  const response = { status: 200, body: "valid response", headers: {} };
  gate.resolve(response); await sending;
  assert.deepEqual(clone(h.state.apiResponse), response);
  const captured = h.context.captureApiRequestSnapshot();
  assert.deepEqual(clone(captured.response), response);
  assert.equal(captured.editor.responseTab, "headers");
  assert.equal(captured.editor.tab, "body");
  assert.equal(captured.editor.wrap, false);
});

test("failed response writes remain in memory and retry before New request", async () => {
  const h = harness();
  h.form.elements.url.value = "https://example.invalid/read";
  let failing = true;
  h.controls.record = async (_snapshot, id) => { if (id && failing) throw new Error("disk busy"); return { id: id || "sent-entry" }; };
  await h.context.sendApiRequest({ preventDefault() {} });
  assert.equal(h.state.apiHistoryFailedResponses.size, 1);
  assert.equal(await h.context.editApiRequest(), false, "Cannot lose unpersisted responses when retry fails");
  assert.equal(h.resets, 0);
  failing = false;
  assert.equal(await h.context.editApiRequest(), true);
  assert.equal(h.state.apiHistoryFailedResponses.size, 0);
  assert.ok(h.records.some(item => item.id === "sent-entry" && item.snapshot.response));
});
