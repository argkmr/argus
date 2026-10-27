import test from "node:test";
import assert from "node:assert/strict";
import { JsonExplorer, jsonDocumentStats, jsonDocumentStatsAsync, searchJsonDocument, searchJsonDocumentAsync } from "../public/json-explorer.js";

test("JSON stats and search are iterative across deeply nested valid documents", async () => {
  let value = "needle";
  for (let depth = 0; depth < 12000; depth++) value = { child: value };
  assert.deepEqual(jsonDocumentStats(value), { nodes: 12001, maxDepth: 12000 });
  assert.equal(searchJsonDocument(value, "needle", "values").length, 1);
  let yields = 0;
  const options = { yieldWork: async () => { yields++; } };
  assert.deepEqual(await jsonDocumentStatsAsync(value, options), { nodes: 12001, maxDepth: 12000 });
  const matches = await searchJsonDocumentAsync(value, "needle", "values", options);
  assert.equal(matches.length, 1); assert.equal(matches[0].segments.length, 12000); assert.ok(yields >= 24);
});

test("async search keeps exact order and quoted keys, yielding even when there are no matches", async () => {
  const value = { "first.key": [{ "quote\"key": "needle" }, { next: "needle" }], last: "needle" };
  const actual = await searchJsonDocumentAsync(value, "needle", "values", { batchSize: 1, yieldWork: async () => {} });
  assert.deepEqual(actual.map(({ segments, ...match }) => match), searchJsonDocument(value, "needle", "values"));
  assert.deepEqual(actual[0].segments, ["first.key", "0", "quote\"key"]);
  let yields = 0;
  const none = await searchJsonDocumentAsync(Array.from({ length: 1500 }, (_, index) => index), "absent", "values", { yieldWork: async () => { yields++; } });
  assert.deepEqual(none, []); assert.equal(yields, 3);
});

test("Keys + values searches do not count descendants solely because an ancestor path matches", async () => {
  const value = { fulfillmentOrderId: { status: "ready", items: [123] } };
  assert.deepEqual(searchJsonDocument(value, "fulfillmentOrderId").map(match => match.path), ["$.fulfillmentOrderId"]);
  assert.deepEqual((await searchJsonDocumentAsync(value, "fulfillmentOrderId")).map(match => match.path), ["$.fulfillmentOrderId"]);
  assert.deepEqual(searchJsonDocument(value, "fulfillmentOrderId", "paths").map(match => match.path), [
    "$.fulfillmentOrderId", "$.fulfillmentOrderId.status", "$.fulfillmentOrderId.items", "$.fulfillmentOrderId.items[0]",
  ]);
});

test("async JSON work aborts at batch boundaries and immediately for an already cancelled request", async () => {
  for (const operation of [jsonDocumentStatsAsync, (value, options) => searchJsonDocumentAsync(value, "x", "all", options)]) {
    const controller = new AbortController(); let yields = 0;
    await assert.rejects(operation(Array(2000).fill("x"), { signal: controller.signal, batchSize: 20, yieldWork: async () => { yields++; controller.abort(); } }), { name: "AbortError" });
    assert.equal(yields, 1);
    await assert.rejects(operation({}, { signal: controller.signal }), { name: "AbortError" });
  }
});

function harness() {
  const elements = new Map(), notifications = [], previousDocument = globalThis.document;
  function node(tag = "div") {
    const classes = new Set(), events = new Map();
    return { tagName: tag.toUpperCase(), children: [], parentElement: null, dataset: {}, style: { setProperty() {} }, value: "", textContent: "", open: false, title: "",
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle(name, value) { if (value ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
      addEventListener(name, handler) { events.set(name, [...(events.get(name) || []), handler]); },
      emit(name, values = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...values }; for (const handler of events.get(name) || []) handler(event); },
      append(...children) { for (const child of children) { child.remove?.(); child.parentElement = this; this.children.push(child); } },
      insertBefore(child, before) { child.remove?.(); child.parentElement = this; const at = this.children.indexOf(before); if (at < 0) throw new Error("Missing insert target"); this.children.splice(at, 0, child); },
      replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; },
      querySelector(selector) { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); },
      querySelectorAll() { return []; },
      closest() { return null; }, focus() {}, select() {}, scrollIntoView() {},
    };
  }
  const document = node(); document.createElement = node;
  globalThis.document = document;
  const root = node(); root.ownerDocument = document;
  const explorer = new JsonExplorer(root, { notify: (...args) => notifications.push(args) });
  root.querySelector("#json-search-scope").value = "all";
  const load = value => { explorer.source.value = JSON.stringify(value); explorer.parse(); };
  return { root, explorer, notifications, load, close() { explorer.cancelWork(); clearTimeout(explorer.parseTimer); globalThis.document = previousDocument; } };
}

test("large arrays render only one 100-row batch, and collapsed object descendants remain lazy", () => {
  const h = harness();
  try {
    h.load(Array.from({ length: 10000 }, (_, index) => ({ index, nested: { value: "data" } })));
    assert.equal(h.explorer.rows.size, 101);
    const root = h.explorer.rows.get("$"); assert.ok(root.more); assert.equal(root.rendered.size, 100);
    const first = h.explorer.rows.get("$[0]"); assert.equal(first.rendered.size, 0);
    first.details.open = true; first.details.emit("toggle");
    assert.equal(first.rendered.size, 2); assert.equal(h.explorer.rows.size, 103);
    root.more.emit("click"); assert.equal(root.rendered.size, 200); assert.equal(h.explorer.rows.size, 203);
    assert.equal(h.explorer.code.textContent, h.explorer.source.value);
  } finally { h.close(); }
});

test("search reveals a far-away match and its ancestors without rendering unrelated siblings", async () => {
  const h = harness();
  try {
    const values = Array.from({ length: 3000 }, () => ({ value: "ordinary" })); values[2900] = { "nested.key": { answer: "needle" } };
    h.load(values); h.root.querySelector("#json-search-input").value = "needle";
    await h.explorer.search();
    assert.equal(h.explorer.matches.length, 1);
    assert.equal(h.explorer.currentMatchRow, h.explorer.rows.get('$[2900]["nested.key"].answer').row);
    assert.equal(h.explorer.rows.size, 104);
    assert.equal(h.explorer.rows.get("$").rendered.size, 101);
    h.explorer.loadChildren(h.explorer.rows.get("$"));
    const indices = [...h.explorer.rows.get("$").children.children].filter(child => child.dataset.jsonPath).map(child => Number(child.dataset.jsonPath.match(/^\$\[(\d+)\]/)?.[1]));
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  } finally { h.close(); }
});

test("superseded searches cannot replace newer matches, including clearing search while work runs", async () => {
  const h = harness();
  try {
    h.load(Array.from({ length: 3000 }, (_, index) => ({ value: `item ${index}` })));
    h.root.querySelector("#json-search-input").value = "item";
    const old = h.explorer.search();
    h.root.querySelector("#json-search-input").value = "item 2999";
    await h.explorer.search(); await old;
    assert.equal(h.explorer.matches.length, 1); assert.equal(h.explorer.matches[0].value, "item 2999");
    h.root.querySelector("#json-search-input").value = "item";
    const pending = h.explorer.search(); h.explorer.closeSearch(); await pending;
    assert.equal(h.explorer.matches.length, 0); assert.equal(h.root.querySelector("#json-search-count").textContent, "0 results");
  } finally { h.close(); }
});

test("Expand all is incremental, Collapse all cancels it, and small documents still fully expand", async () => {
  const h = harness();
  try {
    h.load(Array.from({ length: 3000 }, () => ({ child: { value: 1 } })));
    const expansion = h.explorer.setExpanded(true); await h.explorer.setExpanded(false); await expansion;
    assert.ok(h.explorer.rows.size <= 201);
    assert.equal([...h.explorer.rows.values()].some(record => record.details?.open), false);
    h.load({ a: { b: [1, 2] }, c: { d: true } });
    await h.explorer.setExpanded(true);
    assert.equal(h.explorer.rows.size, 7);
    assert.equal([...h.explorer.rows.values()].filter(record => record.details).every(record => record.details.open), true);
  } finally { h.close(); }
});

test("clearing a document cancels delayed parse so it cannot resurrect old data", async () => {
  const h = harness();
  try {
    h.explorer.source.value = '{"value":1}'; h.explorer.source.emit("input"); h.explorer.clear();
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(h.explorer.hasDocument, false); assert.equal(h.explorer.rows.size, 0);
  } finally { h.close(); }
});

test("a slow file read cannot overwrite a newer document or a clear action", async () => {
  const h = harness();
  try {
    let finish;
    const pending = h.explorer.openFile({ name: "old.json", text: () => new Promise(resolve => { finish = resolve; }) });
    h.load({ current: true }); finish('{"old":true}'); await pending;
    assert.deepEqual(h.explorer.value, { current: true });
    const next = h.explorer.openFile({ name: "old.json", text: () => new Promise(resolve => { finish = resolve; }) });
    h.explorer.clear(); finish('{"old":true}'); await next;
    assert.equal(h.explorer.hasDocument, false); assert.equal(h.explorer.source.value, "");
  } finally { h.close(); }
});
