import test from "node:test";
import assert from "node:assert/strict";
import { parseSourceReferenceTarget } from "../public/source-reference.js";
import { renderChatMessage } from "../public/message-renderer.js";

test("source references parse absolute, relative and encoded paths and source locations", () => {
  const examples = [
    ["/Users/me/project/IncomingFilter.java", "/Users/me/project/IncomingFilter.java", null, null, null],
    ["~/Documents/notes.md", "~/Documents/notes.md", null, null, null],
    ["src/SlackNotifier.java:39", "src/SlackNotifier.java", 39, null, null],
    ["./src/helper.ts:39:5", "./src/helper.ts", 39, 5, null],
    ["README.md", "README.md", null, null, null],
    ["README:10", "README", 10, null, null],
    ["</Users/me/My Project/file(thing).java:39>", "/Users/me/My Project/file(thing).java", 39, null, null],
    ["/Users/me/My%20Project/helper.ts#L20-L35", "/Users/me/My Project/helper.ts", 20, null, 35],
    ["src/helper.ts#L20-35", "src/helper.ts", 20, null, 35],
    ["src/helper.ts#L20", "src/helper.ts", 20, null, null],
    ["src/file\\(thing\\).ts:4", "src/file(thing).ts", 4, null, null],
    ["file:///Users/me/project/helper.ts:4", "/Users/me/project/helper.ts", 4, null, null],
    ["file://localhost/Users/me/project/helper.ts#L4", "/Users/me/project/helper.ts", 4, null, null],
  ];
  for (const [target, path, line, column, endLine] of examples) {
    assert.deepEqual(parseSourceReferenceTarget(target), { path, line, column, endLine }, target);
  }
});

test("source parsing rejects external/executable URLs, remote file hosts and invalid positions", () => {
  for (const target of [
    "", " ", null, {}, "https://example.com/file.ts", "http://example.com/file.ts:5",
    "javascript:alert(1)", "javascript:123", "data:text/html,hello", "vbscript:1",
    "mailto:user@example.com", "codex://file/path", "custom:example", "//server/file.ts",
    "file://server/path.ts", "file://localhost.evil/path.ts", "file://user@localhost/path.ts",
    "file://localhost:443/path.ts", "file:////server/path.ts", "file:/Users/me/file.ts",
    "C:\\Users\\me\\file.ts", "C:/Users/me/file.ts", "\\\\server\\file.ts",
    "%2F%2Fserver/file.ts", "%6Aavascript%3Aalert(1)", "/path%00file", "/path\nfile",
    "/path%1Ffile", "/path%5Cfile", "/malformed%encoding.ts", "#section", "?file=foo",
    "src/file.ts#section", "/file.ts:0", "/file.ts:12:0", "/file.ts#L0",
    "/file.ts#L9-L8", "/file.ts:999999999999999999999", "/file.ts#L1-L999999999999999999999",
  ]) assert.equal(parseSourceReferenceTarget(target), null, String(target));
});

test("source parsing leaves traversal visible for the server's scope checks", () => {
  assert.equal(parseSourceReferenceTarget("file:///Users/me/repo/../secret.txt").path, "/Users/me/repo/../secret.txt");
  assert.equal(parseSourceReferenceTarget("./src/%2e%2e/private.txt").path, "./src/../private.txt");
});

test("the screenshot's three source references become accessible buttons, including the line suffix", () => {
  const html = renderChatMessage("The key references are the [incoming capture and ownership filter](/Users/me/project/IncomingFilter.java), [outgoing capture filter](/Users/me/project/OutgoingFilter.java), and [Slack content selection](/Users/me/project/SlackNotifier.java:39). No code was changed.");
  assert.equal((html.match(/<button type="button" class="chat-file-reference"/g) || []).length, 3);
  assert.match(html, /data-source-reference="\/Users\/me\/project\/SlackNotifier.java:39"/);
  assert.match(html, /title="Open source: \/Users\/me\/project\/SlackNotifier.java:39"/);
  assert.match(html, />Slack content selection<\/button>/);
  assert.doesNotMatch(html, /<span class="chat-file-reference"/);
});

test("markdown citations support angle destinations, spaces, nested parentheses and escaped brackets", () => {
  const html = renderChatMessage(String.raw`[helper \[UI\]](</Users/me/My Project/helper(v2).ts:8>) [other](src/path(two(nested))/file.ts#L4-L7) [encoded](src/My%20File.ts:3) [escaped](src/helper\(v2\).ts)`);
  assert.equal((html.match(/data-source-reference=/g) || []).length, 4);
  assert.match(html, />helper \[UI\]<\/button>/);
  assert.match(html, /title="Open source: \/Users\/me\/My Project\/helper\(v2\).ts:8"/);
  assert.match(html, /data-source-reference="src\/path\(two\(nested\)\)\/file.ts#L4-L7"/);
  assert.match(html, /title="Open source: src\/My File.ts:3"/);
  assert.match(html, /title="Open source: src\/helper\(v2\).ts"/);
});

test("source labels and attributes cannot inject HTML", () => {
  const html = renderChatMessage(`[<img src=x onerror=alert(1)>](/Users/me/evil'\".ts:4)`);
  assert.match(html, /data-source-reference="\/Users\/me\/evil&#039;&quot;.ts:4"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|<script|data-source-reference="[^"]*"\.ts/);
});

test("HTTP links remain external anchors and source links do not occur inside code", () => {
  const html = renderChatMessage([
    "[site](https://example.com/path(v2)?q=yes) [angle](<https://example.com/a%20b>) https://example.com/plain.",
    "`[not a link](/Users/me/file.ts)`",
    "```mermaid",
    "flowchart LR",
    " A[\"[not a source](/Users/me/file.ts)\"] --> B",
    "```",
  ].join("\n"));
  assert.equal((html.match(/class="chat-link"/g) || []).length, 3);
  assert.match(html, /href="https:\/\/example.com\/path\(v2\)\?q=yes" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /data-mermaid-complete="true"/);
  assert.doesNotMatch(html, /data-source-reference=/);
});

test("unsafe and partially streamed markdown never become clickable file references", () => {
  for (const text of [
    "[unsafe](javascript:alert(1))", "[remote](//server/file.ts)",
    "[remote](file://server/file.ts)", "[pending](/Users/me/path(thing).ts",
    "[pending](</Users/me/thing.ts)", String.raw`\[escaped](/Users/me/file.ts)`,
    "![image](/Users/me/file.png)", "[[[unclosed",
  ]) {
    const html = renderChatMessage(text);
    assert.doesNotMatch(html, /data-source-reference=/, text);
    assert.doesNotMatch(html, /href="(?:javascript|file|data):/, text);
  }
});

test("inline-code labels render inside source and HTTP links without leaking placeholders", () => {
  const html = renderChatMessage("[`file.ts`](/Users/me/file.ts:12) [Read `the docs`](https://example.com/docs) [safe `<script>alert(1)</script>`](/Users/me/safe.ts)");
  assert.match(html, /data-source-reference="\/Users\/me\/file.ts:12"[^>]*><code class="chat-inline-code">file.ts<\/code><\/button>/);
  assert.match(html, /href="https:\/\/example.com\/docs"[^>]*>Read <code class="chat-inline-code">the docs<\/code><\/a>/);
  assert.match(html, /safe <code class="chat-inline-code">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/button>/);
  assert.doesNotMatch(html, /ARGUS|[\uE000\uE001]|<script>/);
});

test("user-supplied placeholder text cannot inject generated renderer HTML", () => {
  const forged = "\uE000ARGUS0\uE001";
  const html = renderChatMessage(`${forged} [${forged}](/Users/me/file.ts) \`safe\` [\`${forged}\`](https://example.com) \uE000ARGUSX0\uE001`);
  assert.equal((html.match(/<code class="chat-inline-code">/g) || []).length, 2);
  assert.equal((html.match(/<button type="button" class="chat-file-reference"/g) || []).length, 1);
  assert.equal((html.match(/<a class="chat-link"/g) || []).length, 1);
  assert.match(html, new RegExp(`>${forged}<\\/button>`));
  assert.match(html, new RegExp(`<code class="chat-inline-code">${forged}<\\/code>`));
  assert.match(html, /\uE000ARGUSX0\uE001/);
  assert.doesNotMatch(html, /\uE000ARGUSXX/);
});

test("inline-code destinations stay inert rather than leaking a placeholder into link attributes", () => {
  const html = renderChatMessage("[invalid](`/Users/me/file.ts`) [also invalid](https://example.com/`file.ts`)");
  assert.doesNotMatch(html, /data-source-reference=|ARGUS|[\uE000\uE001]/);
  assert.match(html, /class="chat-inline-code">\/Users\/me\/file.ts<\/code>/);
});

test("an unclosed link before a newline does not prevent later valid links from rendering", () => {
  const html = renderChatMessage("[pending](/Users/me/unclosed\n[`valid.ts`](/Users/me/valid.ts:2) and [docs](https://example.com/docs)\n[another pending\n[next](src/next.ts)");
  assert.equal((html.match(/data-source-reference=/g) || []).length, 2);
  assert.equal((html.match(/class="chat-link"/g) || []).length, 1);
  assert.match(html, /\[pending\]\(\/Users\/me\/unclosed<br \/>/);
  assert.match(html, /<code class="chat-inline-code">valid.ts<\/code>/);
  assert.doesNotMatch(html, /ARGUS|[\uE000\uE001]/);
});
