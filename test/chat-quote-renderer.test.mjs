import test from "node:test";
import assert from "node:assert/strict";
import { renderChatMessage } from "../public/message-renderer.js";

const count = (html, tag) => (html.match(new RegExp(`<${tag}(?: |>)`, "g")) || []).length;

test("multi-paragraph quote is one continuous container without empty shaded bands", () => {
  const html = renderChatMessage([
    "You can post:", "", "> Hi @here,", ">", "> The synthetic alert is **ready**.",
    ">", ">", "> It records the initiating user and trace details.", "> Wrapped continuation.",
    ">", "> Investigate each downstream error independently.", ">", "", "Outside the quote.",
  ].join("\n"));
  assert.equal(count(html, "blockquote"), 1);
  assert.equal(count(html, "p"), 6);
  assert.match(html, /<p class="chat-paragraph">Hi @here,<\/p>/);
  assert.match(html, /<strong>ready<\/strong>/);
  assert.match(html, /trace details\.<br \/>Wrapped continuation\./);
  assert.doesNotMatch(html, /<(?:blockquote|p)[^>]*>\s*<\/(?:blockquote|p)>/);
  assert.match(html, /<\/blockquote><p class="chat-paragraph">Outside the quote\.<\/p>$/);
});

test("unmarked blank lines and prose separate distinct quoted blocks", () => {
  const html = renderChatMessage("> First quote\n\n> Second quote\nOutside text\n> Third quote");
  assert.equal(count(html, "blockquote"), 3);
  assert.match(html, /<\/blockquote><p class="chat-paragraph">Outside text<\/p><blockquote/);
});

test("empty quote markers are not rendered and CRLF paragraphs remain grouped", () => {
  for (const source of [">", "> \n>\n>   ", "> >\n> > ", "   >\r\n   > "])
    assert.equal(renderChatMessage(source), "", source);
  const html = renderChatMessage("  > One\r\n  >\r\n  > Two\r\n");
  assert.equal(count(html, "blockquote"), 1);
  assert.equal(count(html, "p"), 2);
});

test("quote content retains lists, tables, links, inline code and nested quotations", () => {
  const html = renderChatMessage([
    "> ## Summary", ">", "> - **One**", "> - `two`", ">", "> | Key | Value |",
    "> | --- | --- |", "> | State | Ready |", ">", "> [Source](/tmp/example.ts:2)",
    "> [Reference](https://example.invalid/guide)", ">", "> > Nested quotation", ">", "> End.",
  ].join("\n"));
  assert.equal(count(html, "blockquote"), 2);
  assert.equal(count(html, "ul"), 1);
  assert.equal(count(html, "table"), 1);
  assert.match(html, /class="chat-heading">Summary/);
  assert.match(html, /<code class="chat-inline-code">two<\/code>/);
  assert.match(html, /data-source-reference="\/tmp\/example.ts:2"/);
  assert.match(html, /href="https:\/\/example.invalid\/guide" target="_blank" rel="noopener noreferrer"/);
});

test("quoted fenced code and streaming diagrams retain their safe block lifecycle", () => {
  const source = "> Intro\n>\n> ```js\n> const tag = '<img onerror=evil()>';\n> ```\n>\n> End";
  const html = renderChatMessage(source);
  assert.equal(count(html, "blockquote"), 1);
  assert.equal(count(html, "section"), 1);
  assert.match(html, /data-copy-chat-code/);
  assert.match(html, /&lt;img onerror=evil\(\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(renderChatMessage("> ```mermaid\n> graph TD\n> A-->B"), /data-mermaid-complete="false"/);
  assert.match(renderChatMessage("> ```mermaid\n> graph TD\n> A-->B\n> ```"), /data-mermaid-complete="true"/);
  const literal = renderChatMessage("```text\n> A quoted-looking code line\n>\n``` ");
  assert.equal(count(literal, "blockquote"), 0);
  assert.match(literal, /&gt; A quoted-looking code line/);
});

test("streamed prefixes never produce an empty quote or leak raw markup", () => {
  const source = "> First paragraph\n>\n> <script>alert(1)</script> [bad](javascript:evil())\n>\n> End";
  for (let end = 0; end <= source.length; end++) {
    const html = renderChatMessage(source.slice(0, end));
    assert.doesNotMatch(html, /<script|href="javascript:|<blockquote[^>]*>\s*<\/blockquote>/);
    assert.ok(count(html, "blockquote") <= 1);
  }
});

test("deep quote nesting is bounded and remaining content is kept as escaped text", () => {
  const html = renderChatMessage("> ".repeat(1000) + "<script>kept as text</script>");
  assert.ok(count(html, "blockquote") <= 24);
  assert.match(html, /&gt; .*&lt;script&gt;kept as text&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/);
});
