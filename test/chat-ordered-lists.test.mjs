import test from "node:test";
import assert from "node:assert/strict";
import { parseFragment } from "parse5";
import { renderChatMessage } from "../public/message-renderer.js";

const elements = node => (node.childNodes || []).filter(child => child.tagName);
const tags = node => elements(node).map(child => child.tagName);
const attribute = (node, name) => node.attrs.find(attribute => attribute.name === name)?.value;
const text = node => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(text).join("");
const render = source => parseFragment(renderChatMessage(source));

test("blank-separated numbered steps form one list, including repeated Markdown markers", () => {
  for (const source of ["1. First\n2. Second\n3. Third", "1. First\n\n2. Second\n\n3. Third",
    "1. First\n\n1. Second\n\n1. Third", "1) First\r\n \r\n2) Second\r\n\r\n3) Third"]) {
    const document = render(source);
    assert.deepEqual(tags(document), ["ol"], source);
    const [list] = elements(document);
    assert.deepEqual(tags(list), ["li", "li", "li"]);
    assert.deepEqual(elements(list).map(text), ["First", "Second", "Third"]);
    assert.equal(attribute(list, "start"), undefined);
  }
});

test("ordered lists preserve a non-one starting number and let the browser number siblings", () => {
  for (const [source, start] of [["4. Fourth\n\n5. Fifth", "4"], ["0) Zero\n\n1) One", "0"],
    ["007. Seven\n\n1. Eight", "7"]]) {
    const [list] = elements(render(source));
    assert.equal(attribute(list, "start"), start);
    assert.equal(elements(list).length, 2);
    assert.ok(elements(list).every(item => attribute(item, "value") === undefined));
  }
});

test("headings, unindented prose and marker changes separate lists without global numbering", () => {
  const document = render("3. First list\n\nExplanation outside the list.\n\n1. Second list\n\n## Next\n\n1. Third list\n\n2) Different delimiter\n\n- Bullet");
  assert.deepEqual(tags(document), ["ol", "p", "ol", "h4", "ol", "ol", "ul"]);
  assert.deepEqual(elements(document).filter(node => node.tagName === "ol").map(node => attribute(node, "start")), ["3", undefined, undefined, "2"]);
});

test("indented explanations and nested lists stay inside their numbered step", () => {
  const document = render([
    "1. First step", "   Continued explanation.", "", "   Second paragraph.", "",
    "   - Detail one", "   - Detail two", "", "   4. Nested fourth", "", "   1. Nested fifth",
    "", "2. Second step", "", "Outside paragraph.",
  ].join("\n"));
  assert.deepEqual(tags(document), ["ol", "p"]);
  const [list] = elements(document), [first, second] = elements(list);
  assert.equal(elements(list).length, 2);
  assert.deepEqual(tags(first), ["p", "p", "ul", "ol"]);
  assert.equal(attribute(elements(first)[3], "start"), "4");
  assert.equal(elements(elements(first)[3]).length, 2);
  assert.equal(text(second), "Second step");
  assert.match(renderChatMessage("1. First\n   Continued"), /First<br \/>Continued/);
});

test("quotes and lists retain safe links, inline code and escaped content", () => {
  const html = renderChatMessage("> 1. **First** [`file.ts`](/tmp/file.ts:3)\n>\n> 1. [Docs](https://example.invalid/docs)\n>    <img src=x onerror=evil()> [bad](javascript:evil())");
  const document = parseFragment(html), [quote] = elements(document), [list] = elements(quote);
  assert.deepEqual(tags(document), ["blockquote"]);
  assert.deepEqual(tags(quote), ["ol"]);
  assert.equal(elements(list).length, 2);
  assert.match(html, /<strong>First<\/strong>/);
  assert.match(html, /data-source-reference="\/tmp\/file.ts:3"/);
  assert.match(html, /<code class="chat-inline-code">file.ts<\/code>/);
  assert.match(html, /href="https:\/\/example.invalid\/docs"/);
  assert.match(html, /&lt;img src=x onerror=evil\(\)&gt;/);
  assert.doesNotMatch(html, /<img|href="javascript:/);
});

test("code blocks keep list-looking text literal and subsequent steps retain their start", () => {
  const html = renderChatMessage("1. Before\n\n```text\n1. Literal\n\n2. Literal\n```\n\n2. After\n\n```mermaid\nflowchart LR\nA-->B\n```");
  const document = parseFragment(html);
  assert.deepEqual(tags(document), ["ol", "section", "ol", "section"]);
  assert.equal(attribute(elements(document)[2], "start"), "2");
  assert.match(html, /<code data-language="text">1\. Literal\n\n2\. Literal<\/code>/);
  assert.match(html, /data-mermaid-complete="true"/);
  assert.match(renderChatMessage("1. Before\n\n```mermaid\nflowchart LR\nA-->"), /data-mermaid-complete="false"/);
});

test("streamed steps stay safe and settle into one list as markers arrive", () => {
  const source = "1. First\n\n2. <script>evil()</script>\n\n3. [bad](javascript:evil())";
  for (let end = 0; end <= source.length; end++) {
    const html = renderChatMessage(source.slice(0, end));
    assert.doesNotMatch(html, /<script|href="javascript:/);
    assert.ok(elements(parseFragment(html)).filter(node => node.tagName === "ol").length <= 1);
  }
  assert.equal(elements(elements(render(source))[0]).length, 3);
});

test("list nesting is bounded and excessive numeric markers remain escaped text", () => {
  const source = Array.from({ length: 100 }, (_, index) => `${"   ".repeat(index)}1. <script>level ${index}</script>`).join("\n");
  const html = renderChatMessage(source);
  assert.equal((html.match(/<ol /g) || []).length, 24);
  assert.match(html, /level 99/);
  assert.doesNotMatch(html, /<script/);
  const large = renderChatMessage("123456789012345678901234567890. <img src=x>");
  assert.doesNotMatch(large, /<ol|<img/);
  assert.match(large, /123456789012345678901234567890/);
});
