import test from "node:test";
import assert from "node:assert/strict";
import { apiSnapshotHasContent, apiSnapshotKey, createApiRequestHistory } from "../public/api-request-history.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const snapshot = (extra = {}) => ({ version: 1, kind: "draft", request: { name: "", method: "GET", url: "", body: "" }, editor: { queryRows: [], headerRows: [], queryText: "{}", headersText: "{}" }, environmentId: "", response: null, ...extra });
const entry = (id, updatedAt = "2026-09-23T09:00:00Z") => ({ id, updatedAt, name: id, method: "GET", url: "https://example.test" });

test("blank New request never produces junk history; incomplete and malformed drafts are preserved", () => {
  assert.equal(apiSnapshotHasContent(snapshot()), false);
  assert.equal(apiSnapshotHasContent(snapshot({ editor: { queryText: " { } ", headersText: "\n{}" } })), false);
  for (const request of [{ name: "Unsaved" }, { url: "{{base}}/" }, { body: " " }, { method: "POST" }, { id: "saved" }, { collectionId: "collection" }, { variables: { host: "localhost" } }]) {
    assert.equal(apiSnapshotHasContent(snapshot({ request })), true, JSON.stringify(request));
  }
  for (const headersText of ['{"partial":', "null", "[]", "42", "false", '"a"']) {
    assert.equal(apiSnapshotHasContent(snapshot({ editor: { headersText } })), true, headersText);
  }
  assert.equal(apiSnapshotHasContent(snapshot({ editor: { headerRows: [{ key: "Authorization", value: "secret", enabled: false }] } })), true);
  assert.equal(apiSnapshotHasContent(snapshot({ response: { status: 500, body: "Error" } })), true);
});

test("snapshot keys detect raw form or response edits and retain unknown metadata", () => {
  const first = snapshot({ request: { url: "{{host}}", variables: { host: "example.test" }, postman: { body: { mode: "raw" } } } });
  assert.equal(apiSnapshotKey(first), apiSnapshotKey(JSON.parse(JSON.stringify(first))));
  assert.notEqual(apiSnapshotKey(first), apiSnapshotKey({ ...first, editor: { ...first.editor, headersText: '{"unfinished":' } }));
  assert.notEqual(apiSnapshotKey(first), apiSnapshotKey({ ...first, response: { status: 200 } }));
});

test("durable records are indexed only after successful save; response updates replace metadata without duplicates", async () => {
  const calls = [], publications = [];
  const history = createApiRequestHistory({ api: async (path, options) => {
    calls.push({ path, options });
    if (options.body.snapshot.request.name === "fail") throw new Error("Disk full");
    return { ...entry(options.body.id || "first"), status: options.body.snapshot.response?.status ?? null };
  }, onChange: rows => publications.push(rows) });
  const value = snapshot({ request: { name: "Can’t lose me", headers: { Authorization: "private" } }, editor: { headersText: "{partial" } });
  await history.record(value);
  assert.deepEqual(calls[0], { path: "/api/api-request-history", options: { method: "POST", body: { snapshot: value } } });
  await history.record({ ...value, response: { status: 500, body: "Can’t do it" } }, "first");
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].status, 500);
  await assert.rejects(history.record(snapshot({ request: { name: "fail" } })), /Disk full/);
  assert.equal(history.entries.length, 1);
  assert.equal(publications.length, 2);
});

test("refresh sorts latest first and cannot erase records saved while loading", async () => {
  const loading = deferred();
  const history = createApiRequestHistory({ api: (_path, options) => options?.method === "POST" ? entry("new") : loading.promise });
  const refresh = history.refresh();
  await history.record(snapshot());
  loading.resolve([entry("stale")]);
  await refresh;
  assert.deepEqual(history.entries.map(row => row.id), ["new"]);
  const sorted = createApiRequestHistory({ api: async () => [entry("old", "2026-01-01"), entry("latest", "2026-09-23")] });
  await sorted.refresh();
  assert.deepEqual(sorted.entries.map(row => row.id), ["latest", "old"]);
});

test("an older refresh cannot win a newer refresh or undo deletion", async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const history = createApiRequestHistory({ api: (_path, options) => options?.method === "DELETE" ? {} : (++reads === 1 ? first.promise : second.promise) });
  const one = history.refresh(), two = history.refresh();
  second.resolve([entry("new")]); await two;
  await history.remove("new");
  first.resolve([entry("old")]); await one;
  assert.deepEqual(history.entries, []);
});

test("history load and delete target only the selected ID, and failed operations keep the index", async () => {
  let fail = false; const calls = [];
  const history = createApiRequestHistory({ api: async (path, options) => {
    calls.push({ path, options });
    if (fail) throw new Error("Offline");
    if (options?.method === "DELETE") return { ok: true };
    if (path === "/api/api-request-history") return [entry("keep"), entry("remove")];
    return { ...entry("keep"), snapshot: snapshot() };
  } });
  await history.refresh();
  await history.load("../unsafe?");
  assert.equal(calls.at(-1).path, "/api/api-request-history/..%2Funsafe%3F");
  assert.equal(calls.at(-1).options.dedupe, false);
  fail = true;
  await assert.rejects(history.remove("remove"));
  await assert.rejects(history.refresh());
  assert.equal(history.entries.length, 2);
  fail = false; await history.remove("remove");
  assert.deepEqual(history.entries.map(row => row.id), ["keep"]);
});
