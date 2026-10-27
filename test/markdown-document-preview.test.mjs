import test from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import fs from "node:fs/promises";
import { createMarkdownDocumentRenderer, markdownLocalReference, markdownDocumentLink, renderMarkdownDocument } from "../public/markdown-preview.js";
import { wordPreviewEndpoint } from "../public/word-preview.js";

const render = createMarkdownDocumentRenderer(MarkdownIt, { path: "/repo/docs/plan.md" });
test("Markdown documents render headings, nested lists, tables, emphasis and fenced Mermaid", () => {
  const html = render("# Plan\n\n## Detail\n\n**bold** and *italic*\n\n- Parent\n  - Child\n\n| Flow | State |\n| --- | --- |\n| Review | Ready |\n\n```mermaid\ngraph TD\n A-->B\n```\n");
  for (const pattern of [/<h1 /, /<h2 /, /<strong>bold/, /<em>italic/, /<li>Parent\n<ul>/, /<table>/, /data-mermaid-complete="true"/, /A--&gt;B/]) assert.match(html, pattern);
});
test("Markdown blocks active HTML, dangerous links and implicit external image requests", () => {
  const html = render('<script>evil()</script>\n\n[bad](javascript:alert(1))\n\n![secret](https://tracker.example/pixel)\n\n[web](https://example.com)');
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /rel="noopener noreferrer"/);
});
test("Markdown references resolve relative to the document before server validation", () => {
  assert.equal(markdownLocalReference("../src/Flow.java:2:3", "/repo/docs/plan.md"), "/repo/src/Flow.java:2:3");
  assert.equal(markdownLocalReference("./a%20b.md#L2-L4", "/repo/docs/plan.md"), "/repo/docs/a%20b.md#L2-L4");
  for (const href of ["javascript:alert(1)", "https://example.com", "//evil.test/path", "#section"]) assert.equal(markdownLocalReference(href, "/repo/docs/a.md"), null);
  assert.match(render("[Code](../src/Flow.java:2)"), /data-source-reference="\/repo\/src\/Flow.java#L2"/);
});
test("Markdown outside repositories resolves local links and escapes literal path characters", () => {
  const path = '/outside/My "files" & plans/index.md';
  const localRender = createMarkdownDocumentRenderer(MarkdownIt, { path, scope: "local", repositoryId: null, repositoryName: null });
  const html = localRender("[Setup](guide.md#setup) [Source](../notes.txt:2)");
  assert.match(html, /data-source-reference="\/outside\/My%20%22files%22%20%26%20plans\/guide.md"/);
  assert.match(html, /data-source-markdown-anchor="setup"/);
  assert.match(html, /data-source-reference="\/outside\/notes.txt#L2"/);
  assert.doesNotMatch(html, /aria-disabled|href="file:|href="\/outside|repositoryId|repositoryName/);
});
test("Markdown home references retain their home root, escapes, and cited positions", () => {
  for (const [input, expected] of [
    ["~/Documents/notes.md", "~/Documents/notes.md"],
    ["~/Documents/notes.md:2:3", "~/Documents/notes.md:2:3"],
    ["~/Documents/a%20b.md#L2-L4", "~/Documents/a%20b.md#L2-L4"],
    ["%7E/Documents/a%2520b.md:5", "~/Documents/a%2520b.md#L5"],
    ["~/Documents/../notes.md", "~/Documents/../notes.md"],
  ]) assert.equal(markdownLocalReference(input, "/outside/docs/index.md"), expected, input);
  // A literal tilde directory explicitly relative to the document stays relative.
  assert.equal(markdownLocalReference("./~/notes.md", "/outside/docs/index.md"), "/outside/docs/~/notes.md");
  assert.deepEqual(markdownDocumentLink("~/Documents/a%20b.md#setup", "/outside/docs/index.md"), { reference: "~/Documents/a%20b.md", anchor: "setup" });
  assert.deepEqual(markdownDocumentLink("~/Documents/notes.md#L2", "/outside/docs/index.md"), { reference: "~/Documents/notes.md#L2", anchor: null });
  const html = render("[Setup](~/Documents/a%20b.md#setup) [Code](~/Documents/helper.ts:2:3)");
  assert.match(html, /data-source-reference="~\/Documents\/a%20b.md"/);
  assert.match(html, /data-source-markdown-anchor="setup"/);
  assert.match(html, /data-source-reference="~\/Documents\/helper.ts:2:3"/);
  assert.doesNotMatch(html, /aria-disabled|\/repo\/docs\/~|href="~\//);
});
test("Markdown cross-document heading links retain scoped files and separate heading fragments", () => {
  assert.deepEqual(markdownDocumentLink("guide.md#setup", "/repo/docs/index.md"), { reference: "/repo/docs/guide.md", anchor: "setup" });
  assert.deepEqual(markdownDocumentLink("../a%20b.markdown#d%C3%A9tails", "/repo/docs/index.md"), { reference: "/repo/a%20b.markdown", anchor: "d%C3%A9tails" });
  const html = render("[Setup](guide.md#setup)");
  assert.match(html, /data-source-reference="\/repo\/docs\/guide.md"/);
  assert.match(html, /data-source-markdown-anchor="setup"/);
  assert.doesNotMatch(html, /aria-disabled/);
  assert.deepEqual(markdownDocumentLink("guide.md#L2", "/repo/docs/index.md"), { reference: "/repo/docs/guide.md#L2", anchor: null });
  for (const value of ["https://evil.test/a.md#setup", "//evil.test/a.md#setup", "javascript:alert(1)#setup", "guide.pdf#setup", "guide.md#%FF", "guide.md#%00"]) assert.equal(markdownDocumentLink(value, "/repo/docs/index.md"), null, value);
});
test("a cross-document Markdown heading scrolls only after its article is attached", async () => {
  let attached = false;
  let scrolled = 0;
  const heading = { dataset: { markdownHeading: "détails" }, scrollIntoView(options) { assert.equal(attached, true); assert.deepEqual(options, { block: "start" }); scrolled++; } };
  const article = { addEventListener() {}, remove() {}, querySelectorAll: () => [heading] };
  const container = { ownerDocument: { createElement: () => article }, append() { attached = true; } };
  await renderMarkdownDocument(container, { path: "/repo/guide.md", content: "# Détails" }, { anchor: "d%C3%A9tails", loadLibrary: async () => ({ default: MarkdownIt }) });
  assert.equal(scrolled, 1);
});
test("Markdown heading anchors are stable and duplicate headings are distinct", () => {
  const first = render("# A heading\n\n# A heading");
  assert.match(first, /data-markdown-heading="a-heading"/);
  assert.match(first, /data-markdown-heading="a-heading-1"/);
  assert.equal(first, render("# A heading\n\n# A heading"));
});
test("large valid fenced blocks do not exceed JavaScript argument limits", () => {
  assert.match(render("~~~text\n" + "` ".repeat(150_000) + "\n~~~"), /data-language="text"/);
});
test("malformed Markdown anchor escapes do not throw from the click handler", async () => {
  let click;
  const article = { addEventListener(_name, listener) { click = listener; }, remove() {}, querySelectorAll() { throw new Error("Invalid anchors must stop before querying"); } };
  const container = { ownerDocument: { createElement: () => article }, append() {} };
  await renderMarkdownDocument(container, { content: "[bad](#%FF)" }, { loadLibrary: async () => ({ default: MarkdownIt }) });
  assert.doesNotThrow(() => click({ target: { closest: () => ({ dataset: { markdownAnchor: "%FF" } }) }, preventDefault() {} }));
});
test("Word previews require the exact validated local content mode", () => {
  const origin = "http://127.0.0.1:4173";
  assert.equal(wordPreviewEndpoint("/api/source-reference/content?target=a.doc&preview=docx", origin).origin, origin);
  for (const value of ["https://evil.test/api/source-reference/content?preview=docx", "/api/source-reference/content?target=a.doc", "/api/source-reference/content?preview=docx&download=true", "/api/source-reference/content?preview=docx#fragment"]) assert.throws(() => wordPreviewEndpoint(value, origin));
});
test("Word renderer stays opaque, network-blocked and disables active document HTML", async () => {
  const html = await fs.readFile(new URL("../public/word-preview-frame.html", import.meta.url), "utf8");
  const parent = await fs.readFile(new URL("../public/word-preview.js", import.meta.url), "utf8");
  const child = await fs.readFile(new URL("../public/word-preview-frame.js", import.meta.url), "utf8");
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /frame-src 'none'; object-src 'none'/);
  assert.match(parent, /setAttribute\("sandbox", "allow-scripts"\)/);
  assert.doesNotMatch(parent, /allow-same-origin|allow-popups|allow-top-navigation/);
  assert.match(child, /renderAltChunks: false/);
  assert.match(child, /event.source !== parent/);
  assert.match(parent, /event.source !== frame.contentWindow/);
});
