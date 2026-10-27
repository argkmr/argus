import test from "node:test";
import assert from "node:assert/strict";
import { indexJsonSource, jsonSourceMatchRanges } from "../public/json-source-ranges.mjs";

const immediate = { yieldWork: async () => {} };
const excerpts = (source, ranges) => ranges.map(({ start, end }) => source.slice(start, end));

test("source ranges preserve whitespace and exact JSONPath keys without rewriting input", async () => {
  const source = ' \n{ "simple" : [{ "a.b": true, "quote\\\"key": null }], "spaced key": -2.4e+3, "empty": {} }\t';
  const index = await indexJsonSource(source, immediate);
  assert.equal(index.size, 7);
  assert.equal(source.slice(index.get("$").value.start, index.get("$").value.end), source.trim());
  assert.deepEqual(excerpts(source, [index.get("$.simple").key]), ['"simple"']);
  assert.deepEqual(excerpts(source, [index.get('$.simple[0]["a.b"]').value]), ["true"]);
  assert.deepEqual(excerpts(source, [index.get('$.simple[0]["quote\\\"key"]').value]), ["null"]);
  assert.deepEqual(excerpts(source, [index.get('$["spaced key"]').value]), ["-2.4e+3"]);
  assert.equal(index.get("$.simple[0]").key, null);
  assert.deepEqual(excerpts(source, [index.get("$.empty").value]), ["{}"]);
});

test("duplicate keys use the last value and discard superseded descendants", async () => {
  const source = '{"item":{"old":1,"child":{"old":2}},"item":{"child":{"new":3}},"count":1,"count":2}';
  const index = await indexJsonSource(source, immediate);
  assert.deepEqual([...index.keys()], ["$", "$.item", "$.item.child", "$.item.child.new", "$.count"]);
  assert.equal(index.get("$.item").key.start, source.lastIndexOf('"item"'));
  assert.deepEqual(excerpts(source, [index.get("$.count").value]), ["2"]);
  const primitive = await indexJsonSource('{"a":{"orphan":1},"a":null}', immediate);
  assert.equal(primitive.has("$.a.orphan"), false);
});

test("BOM and outer Unicode whitespace match explorer parsing without shifting source offsets", async () => {
  const prefix = "\ufeff\u00a0\n", document = '{"target":"NEEDLE"}', suffix = "\u2003\t\ufeff";
  const source = prefix + document + suffix;
  assert.deepEqual(JSON.parse(source.trim()), { target: "NEEDLE" });
  const index = await indexJsonSource(source, immediate), record = index.get("$.target");
  assert.deepEqual(index.get("$").value, { start: prefix.length, end: prefix.length + document.length });
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "target", "keys")), ["target"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "needle", "values")), ["NEEDLE"]);
  assert.equal(source, prefix + document + suffix);
  for (const invalid of ['{\u00a0"target":1}', '{"target":\ufeff1}', '[1,\u20032]']) {
    assert.throws(() => JSON.parse(invalid.trim()), SyntaxError);
    await assert.rejects(indexJsonSource(invalid, immediate), SyntaxError);
  }
});

test("matching key and value substrings is case-insensitive and returns every exact occurrence", async () => {
  const source = '{"fulfillmentOrderId": "ID-id-ID", "number": 111, "other": "irrelevant"}';
  const index = await indexJsonSource(source, immediate), record = index.get("$.fulfillmentOrderId");
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, " ORDERid ", "keys")), ["OrderId"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "id", "values")), ["ID", "id", "ID"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "id")), ["Id", "ID", "id", "ID"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, index.get("$.number"), "1", "values")), ["1", "1", "1"]);
  assert.deepEqual(jsonSourceMatchRanges(source, record, "not here"), []);
  assert.deepEqual(jsonSourceMatchRanges(source, record, "   "), []);
});

test("escaped key/value text maps semantic matches back to the complete original escape sequence", async () => {
  const source = String.raw`{"fulfillment\u004frderId":"A\nB \u003ctag\u003e \"quote\" slash\\ end"}`;
  const index = await indexJsonSource(source, immediate), record = index.get("$.fulfillmentOrderId");
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "order", "keys")), ["\\u004frder"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "A\nB", "values")), ["A\\nB"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "<tag>", "values")), ["\\u003ctag\\u003e"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, '"quote"', "values")), ['\\"quote\\"']);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "slash\\", "values")), ["slash\\\\"]);
});

test("UTF-16, astral letters, surrogate escapes and lowercase expansions keep accurate offsets", async () => {
  const source = '{"text":"İ THEN 🦊 \\uD83D\\uDE00 𐐀 END"}';
  const index = await indexJsonSource(source, immediate), record = index.get("$.text");
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "then", "values")), ["THEN"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "😀", "values")), ["\\uD83D\\uDE00"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "𐐨", "values")), ["𐐀"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "end", "values")), ["END"]);
});

test("large plain ASCII strings highlight without per-character case folding or span allocations", async () => {
  const source = JSON.stringify({ text: "needle" + "x".repeat(1024 * 1024) + "NEEDLE" });
  const index = await indexJsonSource(source, immediate), record = index.get("$.text");
  const lowercase = String.prototype.toLocaleLowerCase;
  let folds = 0;
  try {
    String.prototype.toLocaleLowerCase = function (...args) { folds++; return lowercase.apply(this, args); };
    assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "needle", "values")), ["needle", "NEEDLE"]);
    assert.ok(folds < 10, `Expected constant-time fold calls, received ${folds}`);
  } finally { String.prototype.toLocaleLowerCase = lowercase; }
});

test("scope separates keys, values and paths, and composite hits use compact anchors", async () => {
  const source = '{"parent":{"child":[1e3,true,null,"yes"]}}';
  const index = await indexJsonSource(source, immediate), child = index.get("$.parent.child");
  assert.deepEqual(jsonSourceMatchRanges(source, child, "parent"), []);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, child, "parent", "paths")), ['"child"']);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, child, "array 4", "values")), ["["]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, child, "child", "keys")), ["child"]);
  assert.deepEqual(jsonSourceMatchRanges(source, child, "child", "values"), []);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, index.get("$.parent.child[0]"), "1000", "values")), ["1e3"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, index.get("$.parent.child[0]"), "0", "keys")), ["1e3"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, index.get("$.parent.child[1]"), "TRUE", "values")), ["true"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, index.get("$.parent.child[2]"), "null", "values")), ["null"]);
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, index.get("$"), "$", "paths")), ["{"]);
});

test("untrusted JSON strings only produce offsets and preserve prototype-named object properties", async () => {
  const source = '{"__proto__":{"constructor":"</mark><script>alert(1)</script>&#39;"}}';
  const index = await indexJsonSource(source, immediate), record = index.get("$.__proto__.constructor");
  const ranges = jsonSourceMatchRanges(source, record, "<script>", "values");
  assert.deepEqual(excerpts(source, ranges), ["<script>"]);
  assert.deepEqual(Object.keys(ranges[0]), ["start", "end"]);
  assert.equal({}.polluted, undefined);
});

test("large documents and individual strings yield even without matches and can be cancelled", async () => {
  let yields = 0;
  await indexJsonSource(JSON.stringify({ large: "x".repeat(20000) }), { batchSize: 200, yieldWork: async () => { yields++; } });
  assert.ok(yields >= 3);
  const controller = new AbortController(); yields = 0;
  await assert.rejects(indexJsonSource(JSON.stringify({ large: "x".repeat(20000) }), {
    signal: controller.signal, batchSize: 50, yieldWork: async () => { yields++; controller.abort(); },
  }), { name: "AbortError" });
  assert.equal(yields, 1);
  await assert.rejects(indexJsonSource("{}", { signal: controller.signal }), { name: "AbortError" });
});

test("source indexing is iterative at twelve thousand nested levels", async () => {
  const depth = 12000, source = "[".repeat(depth) + '"needle"' + "]".repeat(depth);
  const index = await indexJsonSource(source, immediate);
  assert.equal(index.size, depth + 1);
  const record = index.get("$" + "[0]".repeat(depth));
  assert.deepEqual(excerpts(source, jsonSourceMatchRanges(source, record, "needle", "values")), ["needle"]);
});

test("invalid source is rejected instead of exposing incorrect partial ranges", async () => {
  for (const source of ["", "{", "[1,]", '{"a":1,}', "true false", "01", "[1 2]", '{"a" 1}', '"unterminated', '"\\x"', '"\\uXYZ1"', '"line\nbreak"']) {
    await assert.rejects(indexJsonSource(source, immediate), SyntaxError, source);
  }
});
