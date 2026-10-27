import test from "node:test";
import assert from "node:assert/strict";
import { createQueuedPromptEditor, queuedPromptButtons } from "../public/queued-prompt-editor.js";

class Element {
  listeners = new Map(); nodes = new Map(); value = ""; textContent = ""; open = false; disabled = false; isConnected = true;
  setAttribute() {}
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  dispatch(event) { return this.listeners.get(event)?.({ preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
}
const item = { requestId: "queued", taskId: "task", status: "queued", prompt: "Original", attachments: [{ id: "file", title: "plan.pdf" }] };
function harness(save = async () => {}, load = async () => structuredClone(item), beforeOpen = () => true) {
  let dialog;
  const document = { body: { append(element) { dialog = element; } }, createElement() { return new Element(); } };
  const editor = createQueuedPromptEditor({ document, load, save, beforeOpen });
  return { editor, get dialog() { return dialog; }, open: () => editor.open({ scope: "global", taskId: "task", requestId: "queued", trigger: new Element() }) };
}

test("queued controls exist in both scopes only before dispatch and escape data attributes", () => {
  for (const scope of ["repository", "global"]) {
    const html = queuedPromptButtons(scope, 'task"<', item);
    assert.match(html, /Edit queued message/); assert.match(html, /Delete queued message/);
    assert.match(html, /task&quot;&lt;/); assert.match(html, new RegExp(`data-queue-scope="${scope}"`));
  }
  for (const status of ["dispatching", "interrupted", "started"]) assert.equal(queuedPromptButtons("global", "task", { ...item, status }), "");
});

test("editor saves exact whitespace and retains attachments without resending", async () => {
  let received;
  const h = harness(async input => { received = input; });
  const session = await h.open();
  assert.equal(h.dialog.querySelector("textarea").value, "Original");
  assert.match(h.dialog.querySelector("[data-edit-attachments]").textContent, /plan.pdf/);
  h.dialog.querySelector("textarea").value = "  indented code\n";
  await h.dialog.querySelector("form").dispatch("submit"); await session.closed;
  assert.equal(received.prompt, "  indented code\n"); assert.equal(received.request.prompt, "Original");
  assert.equal(h.dialog.open, false);
});

test("cancel releases the dispatch hold without saving", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; }); const session = await h.open();
  h.dialog.querySelector("textarea").value = "Unsent edit";
  h.dialog.querySelector("[data-cancel-queue-edit]").dispatch("click"); await session.closed;
  assert.equal(calls, 0); assert.equal(h.dialog.open, false);
});

test("stale or already-started messages and changed chats do not open", async () => {
  for (const changed of [null, { ...item, taskId: "other" }, { ...item, status: "dispatching" }]) {
    const h = harness(undefined, async () => changed);
    await assert.rejects(h.open(), /no longer waiting/); assert.equal(h.dialog, undefined);
  }
  const h = harness(undefined, undefined, () => { throw new Error("The active chat changed"); });
  await assert.rejects(h.open(), /active chat changed/); assert.equal(h.dialog, undefined);
});

test("duplicate submits and Escape cannot release an in-flight save", async () => {
  let finish, calls = 0, closed = false;
  const h = harness(async () => { calls++; await new Promise(resolve => { finish = resolve; }); });
  const session = await h.open(); session.closed.then(() => { closed = true; });
  const pending = h.dialog.querySelector("form").dispatch("submit");
  await h.dialog.querySelector("form").dispatch("submit"); h.dialog.dispatch("cancel");
  assert.equal(await h.open(), null); assert.equal(calls, 1); assert.equal(closed, false);
  finish(); await pending; await session.closed; assert.equal(h.dialog.open, false);
});

test("failed saves and empty edits keep the draft and modal available", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw new Error("Another window changed this message"); });
  const session = await h.open();
  h.dialog.querySelector("textarea").value = "   "; await h.dialog.querySelector("form").dispatch("submit");
  assert.equal(calls, 0);
  h.dialog.querySelector("textarea").value = "Keep this draft"; await h.dialog.querySelector("form").dispatch("submit");
  assert.equal(h.dialog.open, true); assert.equal(h.dialog.querySelector("textarea").value, "Keep this draft");
  assert.match(h.dialog.querySelector("[data-queue-edit-error]").textContent, /Another window/);
  h.dialog.dispatch("cancel"); await session.closed;
});

test("a delayed native close event cannot close a newly opened editing session", async () => {
  const h = harness(); const first = await h.open();
  h.dialog.dispatch("cancel"); await first.closed;
  const second = await h.open(); let closed = false; second.closed.then(() => { closed = true; });
  h.dialog.dispatch("close"); await Promise.resolve();
  assert.equal(closed, false); assert.equal(h.dialog.open, true);
  h.dialog.querySelector("textarea").value = "Second edit";
  await h.dialog.querySelector("form").dispatch("submit"); await second.closed;
});
