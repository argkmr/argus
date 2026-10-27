import test from "node:test";
import assert from "node:assert/strict";
import { captureCodeAnchor, resolveCodeAnchor } from "../public/ide-code-anchors.mjs";

const path = "src/ReviewService.java";
const code = ["package sample;", "", "class ReviewService {", "  // Takes a review", "  Review createReview(Request input) {", "    return save(input);", "  }", "}", ""].join("\n");
const capture = (options = {}) => captureCodeAnchor({ path, content: code, line: 5, column: 10, endLine: 5, endColumn: 22, ...options });
const resolve = (anchor, options = {}) => resolveCodeAnchor(anchor, { path, content: code, ...options });

test("captures a selected method name with bounded context and UTF-16 coordinates", () => {
  const anchor = capture({ symbol: "createReview", contentHash: "canonical-file-sha", unsaved: true });
  assert.equal(anchor.path, path);
  assert.equal(anchor.selection, "createReview");
  assert.equal(anchor.line, 5);
  assert.equal(anchor.column, 10);
  assert.equal(anchor.endColumn, 22);
  assert.equal(anchor.side, "source");
  assert.equal(anchor.staged, false);
  assert.equal(anchor.selectionTruncated, false);
  assert.equal(anchor.symbol, "createReview");
  assert.equal(anchor.contentHash, "canonical-file-sha");
  assert.equal(anchor.unsaved, true);
  assert.match(anchor.snapshotHash, /^context-fnv1a32:[a-f\d]{8}$/);
  assert.match(anchor.contextBefore, /Takes a review/);
  assert.match(anchor.contextAfter, /return save/);
  assert.deepEqual(resolve(anchor), { line: 5, column: 10, endLine: 5, endColumn: 22, status: "exact" });
  assert.deepEqual(capture({ symbol: "createReview", contentHash: "canonical-file-sha", unsaved: true }), anchor);
});

test("cursor-only actions capture the entire line, including a cursor at line end", () => {
  const anchor = capture({ column: 12, endLine: undefined, endColumn: undefined });
  assert.equal(anchor.selection, "  Review createReview(Request input) {");
  assert.equal(anchor.column, 1);
  assert.equal(anchor.endColumn, anchor.selection.length + 1);
  assert.equal(resolve(anchor).status, "exact");
  assert.deepEqual(capture({ column: 99, endLine: undefined, endColumn: undefined }), anchor);
});

test("unambiguous anchored code follows inserted lines without name-only guessing", () => {
  const anchor = capture();
  const next = "// Copyright\n// Extra header\n" + code;
  assert.deepEqual(resolve(anchor, { content: next }), { line: 7, column: 10, endLine: 7, endColumn: 22, status: "moved" });
  assert.equal(resolve(anchor, { content: code.replace("createReview", "createReviewV2") }).status, "outdated");
  assert.equal(resolve(anchor, { content: code.replace("return save(input)", "return reject(input)") }).status, "outdated");
});

test("ambiguous duplicate text and context never receives a gutter location", () => {
  const anchor = capture();
  assert.equal(resolve(anchor, { content: code + code }).status, "outdated");
  // A same-name method is not a match when the captured implementation differs.
  const unrelated = code.replace("Takes a review", "Deletes a review").replace("return save(input)", "return delete(input)");
  assert.equal(resolve(anchor, { content: unrelated }).status, "outdated");
  assert.equal(resolve(anchor, { content: unrelated + code }).status, "moved");
});

test("diff discussions remain isolated to their original path, side and staged snapshot kind", () => {
  const anchor = capture({ side: "before", staged: true });
  assert.equal(resolve(anchor, { side: "before", staged: true }).status, "exact");
  assert.equal(resolve(anchor, { side: "after", staged: true }), null);
  assert.equal(resolve(anchor, { side: "source" }), null);
  assert.equal(resolve(anchor, { side: "before", staged: false }), null);
  assert.equal(resolve(anchor, { path: "src/Other.java", side: "before", staged: true }), null);
  assert.equal(capture({ staged: true }).staged, false, "source files do not inherit a stale staged flag");
});

test("CRLF and LF snapshots produce the same coordinates and anchors", () => {
  const anchor = capture();
  assert.deepEqual(capture({ content: code.replaceAll("\n", "\r\n") }), anchor);
  assert.equal(resolve(anchor, { content: code.replaceAll("\n", "\r\n") }).status, "exact");
  const multi = capture({ line: 5, column: 3, endLine: 7, endColumn: 4 });
  assert.equal(multi.selection, "Review createReview(Request input) {\n    return save(input);\n  }");
  assert.deepEqual(resolve(multi), { line: 5, column: 3, endLine: 7, endColumn: 4, status: "exact" });
});

test("astral characters preserve Monaco UTF-16 columns and never split surrogate pairs", () => {
  const content = "// 😀\nconst example = '🥭';\n";
  const anchor = capture({ content, line: 2, column: 18, endLine: 2, endColumn: 19 });
  assert.equal(anchor.selection, "🥭");
  assert.equal(anchor.column, 18);
  assert.equal(anchor.endColumn, 20);
  assert.deepEqual(resolve(anchor, { content }), { line: 2, column: 18, endLine: 2, endColumn: 20, status: "exact" });
  assert.equal(capture({ content, line: 2, column: 19, endLine: 2, endColumn: 20 }).selection, "🥭");
  const unicodePath = capture({ path: "src/评价/🥭.java", symbol: { name: "評価" } });
  assert.equal(unicodePath.symbol, "評価");
});

test("large selections and huge single lines stay bounded and are not falsely relocated", () => {
  const content = "x".repeat(2_000_000);
  const anchor = capture({ content, line: 1, column: 1, endLine: 1, endColumn: content.length + 1, symbol: "a".repeat(10_000) });
  assert.equal(anchor.selection.length, 8_000);
  assert.equal(anchor.selectedLength, content.length);
  assert.equal(anchor.selectionTruncated, true);
  assert.equal(anchor.contextBefore.length, 0);
  assert.equal(anchor.contextAfter.length, 0);
  assert.equal(anchor.symbol.length, 240);
  assert.ok(JSON.stringify(anchor).length < 10_000);
  assert.equal(resolve(anchor, { content }).status, "outdated");
  const middle = capture({ content, line: 1, column: 100_000, endLine: 1, endColumn: 100_001 });
  assert.equal(middle.contextBefore.length, 800);
  assert.equal(middle.contextAfter.length, 800);
  assert.equal(resolve(middle, { content }).status, "outdated", "repeated long-line fragments are ambiguous");
  const astral = capture({ content: "x".repeat(7_999) + "😀" + "x".repeat(20), line: 1, column: 1, endLine: 1, endColumn: 8_022 });
  assert.equal(astral.selection.length, 7_999);
  assert.equal(astral.selectionTruncated, true);
});

test("empty files and blank lines have exact, conservative anchors", () => {
  const empty = capture({ content: "", line: 1, column: 1, endLine: undefined, endColumn: undefined });
  assert.equal(empty.selection, "");
  assert.equal(resolve(empty, { content: "" }).status, "exact");
  assert.equal(resolve(empty, { content: "new code" }).status, "outdated");
  const blank = capture({ content: "before\n\nafter", line: 2, column: 1, endLine: undefined, endColumn: undefined });
  assert.equal(blank.selection, "");
  assert.deepEqual(resolve(blank, { content: "before\n\nafter" }), { line: 2, column: 1, endLine: 2, endColumn: 1, status: "exact" });
  assert.equal(resolve(blank, { content: "before\nremoved\nafter" }).status, "outdated");
  assert.equal(resolve(blank, { content: "before\n\nafter\nbefore\n\nafter" }).status, "outdated");
});

test("file boundaries are not treated as empty-context wildcards", () => {
  const anchor = capture({ content: "example", line: 1, column: 1, endLine: 1, endColumn: 8 });
  assert.equal(resolve(anchor, { content: "example" }).status, "exact");
  assert.equal(resolve(anchor, { content: "example elsewhere" }).status, "outdated");
  assert.equal(resolve(anchor, { content: "elsewhere example" }).status, "outdated");
});

test("validates repository paths and discards malformed or oversized persisted metadata", () => {
  assert.equal(capture({ path: "src\\ReviewService.java" }).path, path);
  for (const badPath of ["", "/private/file", "../file", "src/../file", "src//file", "src/./file", "C:\\file", "file:///tmp/file", "bad\0file", "a".repeat(4_097)]) {
    assert.throws(() => capture({ path: badPath }), /repository-relative/);
    assert.equal(resolve(capture(), { path: badPath }), null);
  }
  assert.throws(() => capture({ side: "working" }), /snapshot side/);
  for (const extra of [{ version: 2 }, { line: 0 }, { column: 1.5 }, { selection: null }, { contextBefore: "x".repeat(801) }, { contextAfter: null }, { selection: "x".repeat(8_001) }]) {
    assert.equal(resolve({ ...capture(), ...extra }), null);
  }
  assert.equal(resolve({ ...capture(), selectedLength: 99 }).status, "outdated");
  assert.equal(capture({ contentHash: "x".repeat(257) }).contentHash, undefined);
});

test("range inputs clamp safely and reversed selections retain logical order", () => {
  const reverse = capture({ line: 7, column: 4, endLine: 5, endColumn: 3 });
  const forward = capture({ line: 5, column: 3, endLine: 7, endColumn: 4 });
  assert.deepEqual(reverse, forward);
  const beyond = capture({ line: 100_000, column: 100_000, endLine: undefined, endColumn: undefined });
  assert.equal(beyond.line, 9);
  assert.equal(beyond.column, 1);
  assert.equal(beyond.endLine, 9);
  assert.equal(resolve(beyond).status, "exact");
});
