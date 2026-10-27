import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

test("bookmark repaint updates the same control nodes and preserves scroll in both scopes", () => {
  for (const scope of ["repository", "global"]) {
    const attributes = {}, label = {}, button = { querySelector: () => label, setAttribute: (key, value) => { attributes[key] = value; } };
    Object.defineProperty(button, "outerHTML", { set() { assert.fail("Must not replace focused/scroll-anchored controls"); } });
    const article = { dataset: { chatMessageId: "message" }, querySelector: () => button };
    const task = { id: "chat", messages: [{ id: "message" }], checkpoints: [] };
    const scroller = { scrollTop: 10804.9, scrollHeight: 12000, clientHeight: 405 };
    let refreshes = 0;
    const context = vm.createContext({
      checkpointTasks: new Map([[scope, task]]), activeTaskId: () => "chat",
      checkpointActions: { ingest: (task) => ({ ...task, checkpoints: [{ messageId: "message" }] }), isPending: () => false },
      conversationScroller: () => scroller,
      captureLiveScroll: (element) => ({ top: element.scrollTop }),
      restoreLiveScroll: (element, snapshot) => { element.scrollTop = snapshot.top; },
      $: () => ({ querySelectorAll: () => [article] }),
      checkpointNavigation: new Map([[scope, { refresh: () => refreshes++ }]]),
    });
    vm.runInContext(declaration("paintCheckpointChanges"), context);
    context.paintCheckpointChanges(scope, "chat");
    assert.equal(attributes["aria-pressed"], "true");
    assert.equal(attributes["aria-label"], "Remove checkpoint");
    assert.equal(article.dataset.chatCheckpoint, "true");
    assert.equal(label.textContent, "Checkpoint");
    assert.equal(scroller.scrollTop, 10804.9);
    assert.equal(refreshes, 1);
  }
});

test("late bookmark repaint does not paint a newly selected chat", () => {
  const context = vm.createContext({
    checkpointTasks: new Map([["global", { id: "new-chat" }]]), activeTaskId: () => "new-chat",
    checkpointActions: { ingest: () => assert.fail("Should not paint a different chat") },
  });
  vm.runInContext(declaration("paintCheckpointChanges"), context);
  context.paintCheckpointChanges("global", "old-chat");
});

test("scheduled jump to latest cannot scroll a newly selected chat and clears the old checkpoint cursor", () => {
  let id = "first", scheduled, cleared = 0;
  const scroller = { scrollTop: 10, scrollHeight: 5000 };
  const context = vm.createContext({
    activeTaskId: () => id, requestAnimationFrame: (callback) => { scheduled = callback; },
    conversationScroller: () => scroller,
    checkpointNavigation: new Map([["global", { resetSelection: () => cleared++ }]]),
  });
  vm.runInContext(declaration("scrollConversationToBottom"), context);
  context.scrollConversationToBottom("global"); id = "second"; scheduled();
  assert.equal(scroller.scrollTop, 10); assert.equal(cleared, 0);
  context.scrollConversationToBottom("global"); scheduled();
  assert.equal(scroller.scrollTop, 5000); assert.equal(cleared, 1);
});
