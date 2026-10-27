import assert from "node:assert/strict";
import test from "node:test";
import { sourceReferenceSelection, sourceReferenceContentUrl } from "../public/source-reference-viewer.js";

test("source viewer selects the cited line after normalizing CRLF", () => {
  const selected = sourceReferenceSelection("first\r\nsecond\r\nthird", 2);
  assert.equal(selected.content.slice(selected.start, selected.end), "second");
  assert.equal(selected.line, 2);
  assert.equal(selected.lineCount, 3);
});

test("source viewer highlights ranges and optional columns", () => {
  const range = sourceReferenceSelection("first\nsecond\nthird\nfourth", 2, 3, 3);
  assert.equal(range.content.slice(range.start, range.end), "cond\nthird");
  const column = sourceReferenceSelection("one\ntwo", 2, 999);
  assert.equal(column.start, column.end);
});

test("source viewer handles empty files and citations beyond the current file", () => {
  assert.deepEqual(sourceReferenceSelection("", 39), { content: "", line: 1, lineCount: 1, start: 0, end: 0 });
  const selected = sourceReferenceSelection("one\ntwo", 39);
  assert.equal(selected.line, 2);
  assert.equal(selected.content.slice(selected.start, selected.end), "two");
});

test("source document URLs are restricted to the exact local content route", () => {
  const origin = "http://127.0.0.1:4173";
  const valid = "/api/source-reference/content?target=docs%2Fplan.pdf&download=true";
  assert.equal(sourceReferenceContentUrl(valid, origin), valid);
  assert.equal(sourceReferenceContentUrl(`${origin}${valid}`, origin), valid);
  for (const value of ["https://evil.test/api/source-reference/content", "//evil.test/api/source-reference/content", "file:///private/plan.pdf", "javascript:alert(1)", "/api/agents/run", "/api/source-reference/content#fragment", "/api/source-reference/content\n?token=1"]) assert.equal(sourceReferenceContentUrl(value, origin), null, value);
});

test("absolute local download targets retain their escaped paths and exact origin restriction", () => {
  const origin = "http://127.0.0.1:4173";
  const path = '/outside/My "files" & plans/guide.pdf';
  const url = `/api/source-reference/content?target=${encodeURIComponent(path)}&download=true`;
  assert.equal(sourceReferenceContentUrl(url, origin), url);
  assert.equal(sourceReferenceContentUrl(`${origin}${url}`, origin), url);
  assert.equal(new URL(sourceReferenceContentUrl(url, origin), origin).searchParams.get("target"), path);
  for (const base of ["https://evil.test", "http://127.0.0.1:4174", "https://127.0.0.1:4173", "//evil.test"]) {
    assert.equal(sourceReferenceContentUrl(`${base}${url}`, origin), null);
  }
});
