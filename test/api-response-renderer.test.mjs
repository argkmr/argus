import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { formatJson, highlightedJson, renderResponseContent } from "../public/api-response-renderer.mjs";

const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&quot;": '"' };
const decodeOnce = text => text.replace(/&amp;|&lt;|&gt;|&#39;|&quot;/g, entity => entities[entity]);
const visibleLines = html => html.split('<span class="json-line">').slice(1)
  .map(line => decodeOnce(line.replace(/<\/?span\b[^>]*>/g, ""))).join("\n");
const count = (html, kind) => [...html.matchAll(new RegExp(`<span class="json-${kind}">`, "g"))].length;

function responseElement() {
  const classes = new Set();
  let markup = "", text = "";
  return {
    dataset: {},
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
    set innerHTML(value) { markup = value; text = visibleLines(value); }, get innerHTML() { return markup; },
    set textContent(value) { text = value; markup = ""; }, get textContent() { return text; },
  };
}

test("API error apostrophes stay readable and error-code digits remain part of the string", () => {
  const raw = JSON.stringify({ errors: [{ message: "FulfillmentException(errorCode=FS_500001, message=Can't perform operation, internal service error, action=REJECT_V2)" }] });
  const { formatted, html } = highlightedJson(raw);
  assert.equal(visibleLines(html), formatted);
  assert.match(html, /Can&#39;t perform operation/);
  assert.equal(count(html, "string"), 1);
  assert.equal(count(html, "key"), 2);
  assert.equal(count(html, "number"), 0);
  assert.equal(visibleLines(html).includes("&#39;"), false);
});

test("literal upstream HTML entities are preserved, never decoded into different response values", () => {
  const raw = JSON.stringify({ text: "&#39; &amp; &quot; &lt; &gt; &#x27; &amp;#39;" });
  const { formatted, html } = highlightedJson(raw);
  assert.equal(visibleLines(html), formatted);
  assert.match(html, /&amp;#39;/);
  assert.equal(count(html, "number"), 0);
});

test("quotes, backslashes, controls, Unicode and HTML-like payloads round-trip safely", () => {
  const cases = [
    `it's "quoted" & <tag>`, "true false null 123 -1.2e3", "C:\\work\\new\\file.json", "\\\"suffix",
    "line one\nline two\r\t\u0000\u001b", "हैलो 🌊 café → — \u2028\u2029", "\ud800",
    '</span><img src=x onerror="alert(1)"><script>alert(1)</script>',
    "&quot; onmouseover='alert(1)'", "", "<>&'\"".repeat(100),
  ];
  for (const value of cases) {
    const raw = JSON.stringify({ [value]: value, items: [value] });
    const { formatted, html } = highlightedJson(raw);
    assert.equal(visibleLines(html), formatted, value);
    assert.equal(count(html, "string"), 2, value);
    assert.equal(count(html, "number"), 0, value);
    assert.equal(count(html, "boolean"), 0, value);
    assert.equal(count(html, "null"), 0, value);
    assert.doesNotMatch(html.replace(/<\/?span\b[^>]*>/g, ""), /[<>]/);
  }
});

test("JSON keys, strings and primitives each receive the right token colour", () => {
  const { html, formatted } = highlightedJson('{"it\'s & \\"quoted\\"": ["true false null 42", true, false, null, -1.25, 1e+30, 5e-10]}');
  assert.equal(visibleLines(html), formatted);
  assert.equal(count(html, "key"), 1);
  assert.equal(count(html, "string"), 1);
  assert.equal(count(html, "boolean"), 2);
  assert.equal(count(html, "null"), 1);
  assert.equal(count(html, "number"), 3);
  assert.match(html, /json-number">-1\.25<\/span>/);
  assert.match(html, /json-number">1e\+30<\/span>/);
  assert.match(html, /json-number">5e-10<\/span>/);
});

test("root scalars and nested arrays/objects retain two-space pretty printing", () => {
  for (const raw of ['"Can\'t & true 42"', "true", "false", "null", "-42.5", "{}", "[]", '{"a":[1,{"b":null}]}']) {
    const rendered = highlightedJson(raw);
    assert.equal(rendered.formatted, JSON.stringify(JSON.parse(raw), null, 2));
    assert.equal(visibleLines(rendered.html), rendered.formatted);
    assert.equal(count(rendered.html, "line"), rendered.formatted.split("\n").length);
  }
});

test("body and header rendering keep valid copy text separate from HTML markup", () => {
  const element = responseElement();
  for (const value of [{ errors: [{ message: "Can't perform operation" }] }, { "x-note": ['filename="report & stats.json"', "it's ready"] }]) {
    const raw = JSON.stringify(value);
    assert.equal(renderResponseContent(element, raw), true);
    assert.equal(element.dataset.raw, formatJson(raw));
    assert.equal(element.textContent, formatJson(raw));
    assert.deepEqual(JSON.parse(element.dataset.raw), value);
    assert.equal(element.classList.contains("json-view"), true);
    renderResponseContent(element, element.dataset.raw);
    assert.equal(element.textContent, formatJson(raw), "Repeated formatting must not double-escape content");
  }
});

test("non-JSON responses clear highlighting and use textContent without HTML interpretation", () => {
  const element = responseElement();
  renderResponseContent(element, '{"ok":true}');
  for (const value of ["<html>Can't &amp; render this</html>", '{"unfinished":', "", "invalid JSON\nnew line", null]) {
    assert.equal(renderResponseContent(element, value), false);
    assert.equal(element.dataset.raw, value ?? "");
    assert.equal(element.textContent, value ?? "");
    assert.equal(element.classList.contains("json-view"), false);
    assert.equal(element.innerHTML, "");
  }
  renderResponseContent(element, '{"message":"literal"}', false);
  assert.equal(element.textContent, '{"message":"literal"}');
  assert.equal(element.classList.contains("json-view"), false);
});

test("invalid JSON is rejected by explicit formatting, not treated as a valid highlighted response", () => {
  for (const value of ["", "plain text", '{"bad":}', "undefined"]) {
    assert.throws(() => formatJson(value), SyntaxError);
    assert.throws(() => highlightedJson(value), SyntaxError);
  }
});

test("API Body and Headers share the safe renderer and copy from stored JSON text", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /import \{ formatJson, renderResponseContent \} from "\.\/api-response-renderer\.mjs\?v=/);
  assert.match(app, /renderResponseContent\(\$\("#api-response-body"\), response\.transportError \|\| response\.body/);
  assert.match(app, /renderResponseContent\(\$\("#api-response-headers"\), JSON\.stringify\(response\.headers/);
  assert.match(app, /navigator\.clipboard\.writeText\(response\.dataset\.raw \|\| response\.textContent\)/);
});

test("Format JSON reports invalid responses without damaging their text", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf('  $("#beautify-api-response").addEventListener');
  assert.ok(start >= 0);
  const handler = app.slice(start, app.indexOf('\n  $("#toggle-response-wrap")', start));
  const response = responseElement(), notices = [];
  let click;
  vm.runInNewContext(handler, {
    $: selector => selector === "#beautify-api-response" ? { addEventListener: (_event, callback) => { click = callback; } } : response,
    renderResponseContent, toast: (...args) => notices.push(args),
  });
  renderResponseContent(response, "<html>Server error & details</html>");
  click();
  assert.deepEqual(notices, [["Response body is not valid JSON", "error"]]);
  assert.equal(response.textContent, "<html>Server error & details</html>");
  notices.length = 0;
  renderResponseContent(response, '{"message":"Can\'t perform operation"}');
  click();
  assert.deepEqual(notices, []);
  assert.equal(JSON.parse(response.dataset.raw).message, "Can't perform operation");
});
