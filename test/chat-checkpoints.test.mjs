import assert from "node:assert/strict";
import test from "node:test";
import {
  checkpointNavigationState,
  conversationMessagesWithCheckpoints,
  createChatCheckpointNavigation,
  isCheckpointEligible,
} from "../public/chat-checkpoints.mjs";

const message = (id, minute = 0, extra = {}) => ({ id, role: "user", content: id,
  createdAt: `2026-09-08T10:${String(minute).padStart(2, "0")}:00Z`, ...extra });
const checkpoint = (entry, markedAt = "2026-09-09T12:00:00Z") => ({ messageId: entry.id, markedAt, message: entry });

test("only saved user and assistant messages can be checkpointed, not queue/draft/live placeholders", () => {
  assert.equal(isCheckpointEligible(message("u")), true);
  assert.equal(isCheckpointEligible(message("a", 0, { role: "assistant", status: "failed" })), true);
  for (const entry of [null, {}, message(""), message(" "), message("x", 0, { role: "system" }),
    message("x", 0, { optimistic: true }), message("x", 0, { queued: true }), message("x", 0, { pendingRevision: true })]) {
    assert.equal(isCheckpointEligible(entry), false);
  }
});

test("archived checkpoints merge at original message timestamps, never their later marking times", () => {
  const old = message("old", 1);
  const middle = message("middle", 3);
  const recent = message("recent", 5);
  const task = { messages: [message("two", 2), message("four", 4), recent], checkpoints: [
    checkpoint(middle, "2026-09-08T12:00:00Z"), checkpoint(old, "2026-09-09T12:00:00Z"), checkpoint(recent),
  ] };
  const before = JSON.stringify(task);
  const merged = conversationMessagesWithCheckpoints(task);
  assert.deepEqual(merged.map((item) => item.id), ["old", "two", "middle", "four", "recent"]);
  assert.equal(merged[0].checkpointArchived, true);
  assert.equal(merged[2].checkpointArchived, true);
  assert.equal(merged[4], recent);
  assert.equal(JSON.stringify(task), before, "the task data and original message objects are untouched");
});

test("live saved content wins over snapshots and duplicate/malformed snapshots are ignored", () => {
  const saved = message("a", 2, { content: "authoritative saved answer" });
  const old = message("b", 1);
  const merged = conversationMessagesWithCheckpoints({ messages: [saved], checkpoints: [
    checkpoint(message("a", 2, { content: "outdated snapshot" })), checkpoint(old), checkpoint(old),
    { messageId: "forged", message: message("another", 0) }, checkpoint(message("queued", 0, { queued: true })), null,
  ] });
  assert.deepEqual(merged.map((item) => item.id), ["b", "a"]);
  assert.equal(merged[1].content, "authoritative saved answer");
  assert.deepEqual(conversationMessagesWithCheckpoints(null), []);
  assert.deepEqual(conversationMessagesWithCheckpoints({ messages: {}, checkpoints: {} }), []);
});

test("merge preserves saved ordering and stable timestamp ties, including legacy missing dates", () => {
  const saved = [message("later", 4), message("earlier", 3)];
  const merged = conversationMessagesWithCheckpoints({ messages: saved, checkpoints: [
    checkpoint(message("tie-a", 2)), checkpoint(message("tie-b", 2)),
    checkpoint(message("undated-a", 0, { createdAt: undefined })),
    checkpoint(message("undated-b", 0, { createdAt: "not-a-date" })),
  ] });
  assert.deepEqual(merged.map((item) => item.id), ["undated-a", "undated-b", "tie-a", "tie-b", "later", "earlier"]);
});

const checkpoints = [{ id: "a", top: 40 }, { id: "b", top: 400 }, { id: "c", top: 880 }];
const dimensions = { checkpoints, scrollHeight: 1000, clientHeight: 200 };

test("checkpoint directions follow conversation position; bottom-up includes the newest visible checkpoint", () => {
  let state = checkpointNavigationState({ ...dimensions, scrollTop: 0 });
  assert.equal(state.previousIndex, -1);
  assert.equal(state.nextIndex, 0);
  state = checkpointNavigationState({ ...dimensions, scrollTop: 300 });
  assert.equal(state.previousIndex, 0);
  assert.equal(state.nextIndex, 1);
  state = checkpointNavigationState({ ...dimensions, scrollTop: 800 });
  assert.equal(state.previousIndex, 2);
  assert.equal(state.nextIndex, -1);
  assert.equal(state.atBottom, true);
  assert.equal(state.targets[2].targetTop, 800);
});

test("selected checkpoint moves strictly to its neighbor, including targets sharing the clamped bottom", () => {
  const marks = [...checkpoints, { id: "d", top: 940 }];
  let state = checkpointNavigationState({ ...dimensions, checkpoints: marks, scrollTop: 800, selectedId: "d" });
  assert.equal(state.selectedIndex, 3);
  assert.equal(state.previousIndex, 2);
  assert.equal(state.nextIndex, -1);
  state = checkpointNavigationState({ ...dimensions, checkpoints: marks, scrollTop: 800, selectedId: "c" });
  assert.equal(state.previousIndex, 1);
  assert.equal(state.nextIndex, 3);
  state = checkpointNavigationState({ ...dimensions, scrollTop: 28, selectedId: "a" });
  assert.equal(state.previousIndex, -1);
  assert.equal(state.nextIndex, 1);
});

test("manual scrolling invalidates an old cursor; deleted or missing IDs never block navigation", () => {
  const state = checkpointNavigationState({ ...dimensions, scrollTop: 200, selectedId: "c" });
  assert.equal(state.selectedIndex, -1);
  assert.equal(state.previousIndex, 0);
  assert.equal(state.nextIndex, 1);
  assert.equal(checkpointNavigationState({ ...dimensions, selectedId: "deleted" }).selectedIndex, -1);
});

test("empty, fitting and overscrolled conversations have safe bounds without inventing checkpoints", () => {
  assert.equal(checkpointNavigationState().count, 0);
  assert.equal(checkpointNavigationState().overflow, false);
  assert.equal(checkpointNavigationState().atBottom, true);
  assert.equal(checkpointNavigationState({ ...dimensions, scrollTop: -80 }).top, 0);
  assert.equal(checkpointNavigationState({ ...dimensions, scrollTop: 900 }).top, 800);
  assert.equal(checkpointNavigationState({ ...dimensions, scrollTop: 798 }).atBottom, true);
  const fitting = checkpointNavigationState({ checkpoints: [{ id: "a", top: 0 }], clientHeight: 200, scrollHeight: 180 });
  assert.equal(fitting.nextIndex, 0);
  assert.equal(fitting.previousIndex, -1);
  const selected = checkpointNavigationState({ checkpoints: [{ id: "a", top: 0 }], clientHeight: 200, scrollHeight: 180, selectedId: "a" });
  assert.equal(selected.nextIndex, -1);
  assert.equal(selected.previousIndex, -1);
});

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name) };
    this.textContent = "";
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  emit(name, event = {}) { this.listeners.get(name)?.(event); }
  closest() { return this; }
}

function setup({ tops = [40, 400, 880], zoom = 1 } = {}) {
  const scroller = new Element();
  Object.assign(scroller, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, offsetHeight: 200, clientTop: 0 });
  scroller.getBoundingClientRect = () => ({ top: 100, height: 200 * zoom });
  const scrollCalls = [];
  scroller.scrollTo = (options) => { scrollCalls.push(options); scroller.scrollTop = options.top; scroller.emit("scroll"); };
  const entries = tops.map((top, index) => {
    const element = new Element({ chatMessageId: String(index + 1), chatCheckpoint: "true" });
    element.top = top;
    element.getBoundingClientRect = () => ({ top: 100 + (element.top - scroller.scrollTop) * zoom });
    return element;
  });
  const conversation = new Element();
  conversation.querySelectorAll = () => entries.filter((entry) => entry.dataset.chatCheckpoint === "true");
  const rail = new Element();
  const previous = new Element({ chatNav: "previous" });
  const next = new Element({ chatNav: "next" });
  const bottom = new Element({ chatNav: "bottom" });
  const count = new Element();
  const status = new Element();
  rail.querySelector = (selector) => ({
    '[data-chat-nav="previous"]': previous, '[data-chat-nav="next"]': next, '[data-chat-nav="bottom"]': bottom,
    "[data-chat-checkpoint-count]": count, "[data-chat-checkpoint-status]": status,
  })[selector];
  rail.contains = (entry) => [previous, next, bottom, count, status].includes(entry);
  const view = new Element();
  const frames = new Map();
  let frameId = 0;
  view.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  view.cancelAnimationFrame = (id) => frames.delete(id);
  const observers = [];
  view.ResizeObserver = view.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.observed = []; observers.push(this); }
    observe(element) { this.observed.push(element); }
    disconnect() { this.disconnected = true; }
  };
  const navigations = [];
  const controller = createChatCheckpointNavigation({ scroller, conversation, rail, window: view, onNavigate: (event) => navigations.push(event) });
  controller.setTask("task-a");
  return { controller, scroller, conversation, rail, previous, next, bottom, count, status, entries, scrollCalls, navigations, frames, observers, view,
    flush() { for (const [id, callback] of frames) { frames.delete(id); callback(); } },
    click(button) { rail.emit("click", { target: button, preventDefault() {} }); },
  };
}

test("controller supports both scopes independently, navigates messages and separately jumps to bottom", () => {
  const repository = setup();
  const nexus = setup();
  nexus.controller.setTask("task-nexus");
  repository.click(repository.next);
  assert.equal(repository.scroller.scrollTop, 28);
  assert.equal(repository.count.textContent, "1 / 3");
  assert.equal(repository.previous.disabled, true);
  assert.equal(repository.status.textContent, "Checkpoint 1 of 3");
  assert.equal(repository.entries[0].classes.has("checkpoint-navigation-target"), true);
  repository.click(repository.next);
  assert.equal(repository.scroller.scrollTop, 388);
  repository.click(repository.bottom);
  assert.equal(repository.scroller.scrollTop, 800);
  assert.equal(repository.bottom.disabled, true);
  assert.equal(repository.count.textContent, "3");
  repository.click(repository.previous);
  assert.equal(repository.count.textContent, "3 / 3");
  repository.click(repository.previous);
  assert.equal(repository.scroller.scrollTop, 388);
  assert.equal(nexus.scroller.scrollTop, 0);
  assert.equal(nexus.navigations.length, 0);
  assert.deepEqual(repository.navigations[0], { taskId: "task-a", action: "next", messageId: "1", index: 0, count: 3 });
});

test("same-task repaint restores a checkpoint cue on replacement DOM without moving scroll; task switch resets it", () => {
  const fixture = setup();
  fixture.click(fixture.next);
  const original = fixture.entries[0];
  const replacement = new Element({ ...original.dataset });
  replacement.getBoundingClientRect = original.getBoundingClientRect;
  fixture.entries[0] = replacement;
  fixture.controller.setTask("task-a");
  assert.equal(fixture.scrollCalls.length, 1);
  assert.equal(original.classes.has("checkpoint-navigation-target"), false);
  assert.equal(replacement.classes.has("checkpoint-navigation-target"), true);
  fixture.controller.setTask("task-b");
  assert.equal(fixture.count.textContent, "3");
  assert.equal(fixture.status.textContent, "");
  assert.equal(replacement.classes.has("checkpoint-navigation-target"), false);
  fixture.flush();
  fixture.click(fixture.next);
  assert.equal(fixture.navigations.at(-1).taskId, "task-b");
});

test("explicit jump-to-latest resets the checkpoint cursor without moving scroll by itself", () => {
  const fixture = setup();
  fixture.click(fixture.bottom);
  fixture.click(fixture.previous);
  assert.equal(fixture.count.textContent, "3 / 3");
  const calls = fixture.scrollCalls.length;
  fixture.controller.resetSelection();
  assert.equal(fixture.scroller.scrollTop, 800);
  assert.equal(fixture.scrollCalls.length, calls);
  assert.equal(fixture.count.textContent, "3");
  assert.equal(fixture.status.textContent, "");
  fixture.click(fixture.previous);
  assert.equal(fixture.count.textContent, "3 / 3", "latest-up no longer skips the final checkpoint");
});

test("zoomed panes use CSS scroll coordinates and no animation even with reduced motion", () => {
  const fixture = setup({ zoom: 1.5 });
  fixture.view.matchMedia = () => ({ matches: true });
  fixture.click(fixture.next);
  fixture.click(fixture.next);
  assert.equal(fixture.scroller.scrollTop, 388);
  assert.deepEqual(fixture.scrollCalls, [{ top: 28, behavior: "instant" }, { top: 388, behavior: "instant" }]);
});

test("fractional zoomed border-box heights retain exact anchors across long chat jumps", () => {
  const zoom = 1.22;
  const fixture = setup({ zoom, tops: [40, 14000, 18800] });
  const cssHeight = 494.546875 / zoom;
  fixture.scroller.offsetHeight = 405;
  fixture.scroller.clientHeight = 405;
  fixture.scroller.scrollHeight = 20000;
  fixture.scroller.getBoundingClientRect = () => ({ top: 100, height: 494.546875 });
  fixture.view.getComputedStyle = () => ({ height: `${cssHeight}px`, boxSizing: "border-box" });
  fixture.controller.refresh();
  fixture.click(fixture.next);
  fixture.click(fixture.next);
  assert.ok(Math.abs(fixture.scroller.scrollTop - 13988) < 0.01);
  assert.equal(fixture.count.textContent, "2 / 3");
  fixture.click(fixture.next);
  assert.ok(Math.abs(fixture.scroller.scrollTop - 18788) < 0.01);
  assert.equal(fixture.count.textContent, "3 / 3");
  fixture.click(fixture.previous);
  assert.ok(Math.abs(fixture.scroller.scrollTop - 13988) < 0.01);
  assert.equal(fixture.count.textContent, "2 / 3", "one up click reaches the preceding checkpoint");
});

test("zoom scale includes resolved content-box padding and borders, with an offset fallback for unresolved height", () => {
  const zoom = 1.22;
  const fixture = setup({ zoom, tops: [40, 14000, 18800] });
  const cssHeight = 405.366291;
  fixture.scroller.offsetHeight = 405;
  fixture.scroller.clientHeight = 403;
  fixture.scroller.scrollHeight = 20000;
  fixture.scroller.getBoundingClientRect = () => ({ top: 100, height: cssHeight * zoom });
  fixture.view.getComputedStyle = () => ({ height: `${cssHeight - 15}px`, boxSizing: "content-box",
    paddingTop: "5px", paddingBottom: "8px", borderTopWidth: "1px", borderBottomWidth: "1px" });
  fixture.controller.refresh();
  fixture.click(fixture.next);
  fixture.click(fixture.next);
  assert.ok(Math.abs(fixture.scroller.scrollTop - 13988) < 0.01);
  assert.equal(fixture.count.textContent, "2 / 3");
  const fallback = setup({ zoom });
  fallback.view.getComputedStyle = () => ({ height: "auto", boxSizing: "border-box" });
  fallback.click(fallback.next);
  assert.ok(Math.abs(fallback.scroller.scrollTop - 28) < 0.01);
});

test("manual scroll gestures clear navigation selection without touching messages or task state", () => {
  for (const event of ["wheel", "pointerdown", "touchstart", "keydown"]) {
    const fixture = setup();
    fixture.click(fixture.bottom);
    fixture.click(fixture.previous);
    assert.equal(fixture.count.textContent, "3 / 3");
    fixture.scroller.emit(event, { key: "PageUp" });
    fixture.flush();
    assert.equal(fixture.count.textContent, "3", event);
    assert.equal(fixture.entries[2].classes.has("checkpoint-navigation-target"), false);
    assert.equal(fixture.scrollCalls.length, 2);
  }
});

test("mark removal updates count/directions; growing live output activates the bottom control", () => {
  const fixture = setup({ tops: [40] });
  fixture.click(fixture.next);
  fixture.entries[0].dataset.chatCheckpoint = "false";
  fixture.controller.refresh();
  assert.equal(fixture.count.textContent, "0");
  assert.equal(fixture.previous.disabled, true);
  assert.equal(fixture.next.disabled, true);
  fixture.scroller.scrollHeight = 200;
  fixture.scroller.scrollTop = 0;
  fixture.controller.refresh();
  assert.equal(fixture.rail.hidden, true);
  fixture.scroller.scrollHeight = 450;
  fixture.observers[1].callback();
  fixture.observers[1].callback();
  assert.equal(fixture.frames.size, 1, "live changes share one pending frame");
  fixture.flush();
  assert.equal(fixture.rail.hidden, false);
  assert.equal(fixture.bottom.disabled, false);
});

test("disabled/foreign controls do nothing and destroy disconnects every observer and queued refresh", () => {
  const fixture = setup();
  fixture.click(fixture.previous);
  fixture.click(new Element({ chatNav: "next" }));
  assert.equal(fixture.scrollCalls.length, 0);
  fixture.scroller.emit("scroll");
  assert.equal(fixture.frames.size, 1);
  fixture.controller.destroy();
  assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.rail.listeners.size, 0);
  assert.equal(fixture.scroller.listeners.size, 0);
  assert.equal(fixture.view.listeners.size, 0);
  assert.equal(fixture.observers.every((observer) => observer.disconnected), true);
  fixture.click(fixture.next);
  assert.equal(fixture.scrollCalls.length, 0);
  assert.doesNotThrow(() => createChatCheckpointNavigation().setTask("missing-dom"));
});
