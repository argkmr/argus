import test from "node:test";
import assert from "node:assert/strict";
import { createChatContentRenderer } from "../public/chat-content-renderer.mjs";
import { createStableHtmlRenderer } from "../public/stable-html-renderer.mjs";
import { renderChatMessage } from "../public/message-renderer.js";

class ContentElement {
  childNodes = [];
  writes = 0;
  get innerHTML() { return this.html || ""; }
  set innerHTML(value) {
    this.writes++;
    this.html = value;
    this.childNodes = value ? [{ html: value, children: [], selected: false }] : [];
  }
}

test("identical job output retains its formatted DOM without running Markdown again", () => {
  const calls = [], target = new ContentElement();
  const render = createChatContentRenderer(source => { calls.push(source); return renderChatMessage(source); });
  assert.equal(render(target, "**Ready**"), true);
  const first = target.childNodes[0];
  assert.equal(render(target, "**Ready**"), false);
  assert.equal(render(target, "**Ready**"), false);
  assert.equal(target.childNodes[0], first);
  assert.equal(target.writes, 1);
  assert.deepEqual(calls, ["**Ready**"]);
});

test("nested diagram frames, code toggles and selections survive metadata-only polls", () => {
  const target = new ContentElement(), render = createChatContentRenderer(renderChatMessage);
  const source = "```mermaid\nflowchart LR\nA-->B\n```";
  render(target, source);
  const block = target.childNodes[0], diagram = { tagName: "IFRAME", title: "Mermaid diagram" };
  block.children.push(diagram);
  block.sourceHidden = false;
  block.selected = true;
  assert.equal(render(target, source), false);
  assert.equal(target.childNodes[0].children[0], diagram);
  assert.equal(target.childNodes[0].sourceHidden, false);
  assert.equal(target.childNodes[0].selected, true);
});

test("changed streaming text renders immediately and each element is independent", () => {
  const first = new ContentElement(), second = new ContentElement();
  const render = createChatContentRenderer(renderChatMessage);
  render(first, "Partial **response");
  const partial = first.childNodes[0];
  assert.equal(render(first, "Partial **response**"), true);
  assert.notEqual(first.childNodes[0], partial);
  assert.match(first.innerHTML, /<strong>response<\/strong>/);
  assert.equal(render(second, "Partial **response**"), true);
  assert.equal(second.writes, 1);
  assert.equal(render(first, "Partial **response**"), false);
});

test("source normalization changes do not rewrite identical formatted output", () => {
  const target = new ContentElement(), render = createChatContentRenderer(renderChatMessage);
  render(target, "First\r\nSecond");
  const first = target.childNodes[0];
  assert.equal(render(target, "First\nSecond"), true);
  assert.equal(target.childNodes[0], first);
  assert.equal(target.writes, 1);
  assert.equal(render(target, "First\nSecond"), false);
});

test("the shared safe-HTML renderer supports adapters and invalidates external root edits", () => {
  const target = new ContentElement(), render = createStableHtmlRenderer();
  assert.equal(render(target, "<p>Answer</p>"), true);
  assert.equal(render(target, "<p>Answer</p>"), false);
  target.innerHTML = "<p>Externally replaced</p>";
  assert.equal(render(target, "<p>Answer</p>"), true);
  assert.equal(target.innerHTML, "<p>Answer</p>");
  assert.equal(target.writes, 3);
  assert.equal(render(target, ""), true);
  assert.equal(render(target, null), false);
});

test("external clear or root replacement invalidates the previous response", () => {
  const target = new ContentElement(), render = createChatContentRenderer(renderChatMessage);
  render(target, "Saved response");
  target.innerHTML = "";
  assert.equal(render(target, "Saved response"), true);
  assert.match(target.innerHTML, /Saved response/);
  target.innerHTML = "Other content";
  assert.equal(render(target, "Saved response"), true);
  assert.match(target.innerHTML, /Saved response/);
});

test("replacement of an interior root child is detected even with unchanged count and edges", () => {
  const target = new ContentElement();
  Object.defineProperty(target, "innerHTML", {
    set(value) { this.html = value; this.writes++; this.childNodes = [{}, {}, {}]; },
  });
  const render = createChatContentRenderer(renderChatMessage);
  render(target, "One\n\nTwo\n\nThree");
  target.childNodes[1] = {};
  assert.equal(render(target, "One\n\nTwo\n\nThree"), true);
  assert.equal(target.writes, 2);
});

test("empty output is cached and a failed render or write remains retryable", () => {
  const target = new ContentElement(); let fail = true;
  const render = createChatContentRenderer(source => {
    if (fail) { fail = false; throw new Error("Formatting failed"); }
    return renderChatMessage(source);
  });
  assert.throws(() => render(target, "Ready"), /Formatting failed/);
  assert.equal(render(target, "Ready"), true);
  assert.equal(render(target, ""), true);
  assert.equal(render(target, ""), false);
  assert.equal(render(target, null), false);

  const broken = new ContentElement(); let writes = 0;
  Object.defineProperty(broken, "innerHTML", { set() { if (++writes === 1) throw new Error("Write failed"); this.childNodes = [{}]; } });
  assert.throws(() => render(broken, "Ready"), /Write failed/);
  assert.equal(render(broken, "Ready"), true);
  assert.equal(render(broken, "Ready"), false);
});

test("the shared Markdown renderer still escapes active content and rejects unsafe links", () => {
  const target = new ContentElement(), render = createChatContentRenderer(renderChatMessage);
  render(target, '<script>alert(1)</script> [click](javascript:alert(1))\n\n```html\n<img src=x onerror=bad()>\n```');
  assert.match(target.innerHTML, /&lt;script&gt;/);
  assert.match(target.innerHTML, /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.doesNotMatch(target.innerHTML, /<script|<img|href="javascript:/);
});

test("renderer instances do not share stale element snapshots", () => {
  const target = new ContentElement();
  const first = createChatContentRenderer(renderChatMessage), second = createChatContentRenderer(renderChatMessage);
  first(target, "Answer");
  assert.equal(second(target, "Answer"), true);
  assert.equal(first(target, "Answer"), true);
  assert.equal(first(target, "Answer"), false);
  assert.throws(() => createChatContentRenderer(), /safe chat message renderer/);
  assert.throws(() => first(null, "Answer"), /chat content element/);
});
