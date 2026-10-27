import assert from "node:assert/strict";
import test from "node:test";
import { createRepositoryTaskDrawer } from "../public/repository-task-drawer.mjs";

class EventSurface {
  listeners = new Map();
  addEventListener(type, listener, options) {
    const capture = options === true || Boolean(options?.capture);
    const listeners = this.listeners.get(type) || [];
    listeners.push({ listener, capture });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener, options) {
    const capture = options === true || Boolean(options?.capture);
    this.listeners.set(type, (this.listeners.get(type) || [])
      .filter(entry => entry.listener !== listener || entry.capture !== capture));
  }
}

function harness({ enabled = true } = {}) {
  const document = new EventSurface(), window = new EventSurface();
  const nodes = [], timers = new Map(), focusCalls = [], closeCalls = [];
  let nextTimer = 0;
  document.defaultView = window;
  window.setTimeout = (callback, delay) => {
    assert.equal(delay, 0);
    timers.set(++nextTimer, callback);
    return nextTimer;
  };
  window.clearTimeout = id => timers.delete(id);
  function node(id, parentNode = document, tagName = "DIV", className = "") {
    const element = Object.assign(new EventSurface(), {
      id, parentNode, tagName, className, modal: false, popoverOpen: false,
      contains(target) {
        for (let current = target; current; current = current.parentNode) {
          if (current === this) return true;
        }
        return false;
      },
      matches(selector) {
        if (selector.startsWith("#")) return selector.slice(1) === this.id;
        if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
        if (selector === "dialog:modal") return this.tagName === "DIALOG" && this.modal;
        if (selector === "[popover]:popover-open") return this.popoverOpen;
        return false;
      },
      closest(selector) {
        for (let current = this; current?.matches; current = current.parentNode) {
          if (current.matches(selector)) return current;
        }
        return null;
      },
      focus(options) { focusCalls.push({ element: this, options }); document.activeElement = this; },
    });
    nodes.push(element);
    return element;
  }
  document.querySelector = selector => nodes.find(element => selector.split(",")
    .some(part => element.matches(part.trim()))) || null;
  const panel = node("repository-task-sidebar");
  const rail = node("workspace-task-rail-toggle", document, "BUTTON");
  const close = node("repository-task-history-close", panel, "BUTTON");
  const task = node("task", panel, "BUTTON"), railIcon = node("rail-icon", rail);
  const rename = node("rename", panel, "INPUT", "task-title-input");
  const composer = node("composer", document, "TEXTAREA");
  const frame = node("editor-frame", document, "IFRAME");
  const dialog = node("dialog", document, "DIALOG"), popover = node("popover");
  document.activeElement = composer;
  const controller = createRepositoryTaskDrawer({
    document,
    getEnabled: () => enabled,
    onClose() { closeCalls.push(true); enabled = false; },
  });
  function dispatch(type, target, extra = {}) {
    const event = {
      type, target, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...extra,
    };
    const path = [];
    for (let current = target; current; current = current.parentNode) path.push(current);
    for (const capture of [true, false]) {
      for (const surface of capture ? [...path].reverse() : path) {
        for (const entry of surface.listeners.get(type) || []) {
          if (entry.capture === capture) entry.listener(event);
        }
        if (event.propagationStopped) return event;
      }
    }
    return event;
  }
  return { document, window, panel, rail, railIcon, close, task, rename, composer, frame, dialog, popover,
    controller, dispatch, timers, focusCalls, closeCalls, node,
    get enabled() { return enabled; }, open() { enabled = true; },
    flushTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    },
  };
}

test("creation preserves the current state and a disabled drawer ignores interaction", () => {
  for (const enabled of [false, true]) {
    const h = harness({ enabled });
    assert.equal(h.enabled, enabled);
    assert.equal(h.document.activeElement, h.composer);
    assert.deepEqual(h.closeCalls, []);
    assert.deepEqual(h.focusCalls, []);
    if (enabled) continue;
    h.dispatch("click", h.close);
    h.dispatch("pointerdown", h.composer);
    h.dispatch("focusin", h.composer);
    const escape = h.dispatch("keydown", h.composer, { key: "Escape" });
    assert.equal(escape.defaultPrevented, false);
    assert.equal(h.controller.dismiss({ restoreFocus: true }), false);
    assert.deepEqual(h.closeCalls, []);
    assert.deepEqual(h.focusCalls, []);
  }
});

test("Close and Escape dismiss once and return focus to the task rail without scrolling", () => {
  for (const action of ["close", "escape"]) {
    const h = harness();
    const event = action === "close" ? h.dispatch("click", h.close)
      : h.dispatch("keydown", h.composer, { key: "Escape" });
    assert.equal(h.enabled, false);
    assert.equal(h.closeCalls.length, 1);
    assert.deepEqual(h.focusCalls, [{ element: h.rail, options: { preventScroll: true } }]);
    if (action === "escape") {
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.propagationStopped, true);
    }
    assert.equal(h.controller.dismiss({ restoreFocus: true }), false);
    assert.equal(h.closeCalls.length, 1);
    assert.equal(h.focusCalls.length, 1);
  }
});

test("pointer and focus stay inside the drawer or its rail until the user moves outside", () => {
  for (const type of ["pointerdown", "focusin"]) {
    const h = harness();
    for (const target of [h.panel, h.task, h.rename, h.rail, h.railIcon]) h.dispatch(type, target);
    assert.equal(h.enabled, true);
    assert.deepEqual(h.closeCalls, []);
    h.document.activeElement = h.composer;
    const event = h.dispatch(type, h.composer);
    assert.equal(h.enabled, false);
    assert.equal(h.closeCalls.length, 1);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    assert.equal(h.document.activeElement, h.composer);
    assert.deepEqual(h.focusCalls, []);
  }
});

test("Escape leaves renaming and keys consumed by local controls alone", () => {
  const h = harness();
  for (const [target, extra] of [
    [h.rename, { key: "Escape" }],
    [h.composer, { key: "Escape", defaultPrevented: true }],
    [h.composer, { key: "Enter" }],
  ]) {
    const event = h.dispatch("keydown", target, extra);
    assert.equal(event.propagationStopped, false);
  }
  const consume = event => { event.preventDefault(); event.stopPropagation(); };
  h.composer.addEventListener("keydown", consume);
  h.dispatch("keydown", h.composer, { key: "Escape" });
  assert.equal(h.enabled, true);
  assert.deepEqual(h.closeCalls, []);
  h.composer.removeEventListener("keydown", consume);
  h.dispatch("keydown", h.composer, { key: "Escape" });
  assert.equal(h.enabled, false);
});

test("native modals and open popovers get dismissal priority while explicit dismissal still works", () => {
  for (const layer of ["dialog", "popover"]) {
    const h = harness();
    if (layer === "dialog") h.dialog.modal = true;
    else h.popover.popoverOpen = true;
    h.dispatch("pointerdown", h.composer);
    h.dispatch("focusin", h.composer);
    const escape = h.dispatch("keydown", h.composer, { key: "Escape" });
    h.document.activeElement = h.frame;
    h.dispatch("blur", h.window);
    h.flushTimers();
    assert.equal(escape.defaultPrevented, false);
    assert.equal(escape.propagationStopped, false);
    assert.equal(h.enabled, true);
    assert.deepEqual(h.closeCalls, []);
    assert.equal(h.controller.dismiss(), true);
    assert.equal(h.closeCalls.length, 1);
    assert.deepEqual(h.focusCalls, []);
  }
});

test("window blur waits for settled focus and dismisses only for an outside iframe", () => {
  const h = harness();
  h.dispatch("blur", h.window);
  h.flushTimers();
  assert.equal(h.enabled, true, "switching applications does not close the drawer");
  h.document.activeElement = h.node("inside-frame", h.panel, "IFRAME");
  h.dispatch("blur", h.window);
  h.flushTimers();
  assert.equal(h.enabled, true, "an iframe within the drawer is still inside");
  h.dispatch("blur", h.window);
  h.dispatch("blur", h.window);
  assert.equal(h.timers.size, 1, "repeated blur keeps only one pending focus check");
  assert.equal(h.enabled, true, "blur does not dismiss synchronously");
  h.document.activeElement = h.frame;
  h.flushTimers();
  assert.equal(h.enabled, false);
  assert.equal(h.closeCalls.length, 1);
  assert.equal(h.document.activeElement, h.frame);
  assert.deepEqual(h.focusCalls, []);
});

test("dispose cancels pending iframe checks and removes every interaction listener", () => {
  const h = harness();
  h.document.activeElement = h.frame;
  h.dispatch("blur", h.window);
  assert.equal(h.timers.size, 1);
  h.controller.dispose();
  h.controller.dispose();
  assert.equal(h.timers.size, 0);
  for (const surface of [h.document, h.window, h.close]) {
    assert.ok([...surface.listeners.values()].every(listeners => listeners.length === 0));
  }
  h.flushTimers();
  h.dispatch("click", h.close);
  h.dispatch("pointerdown", h.composer);
  h.dispatch("focusin", h.composer);
  h.dispatch("keydown", h.composer, { key: "Escape" });
  h.dispatch("blur", h.window);
  assert.equal(h.controller.dismiss({ restoreFocus: true }), false);
  assert.equal(h.enabled, true);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.closeCalls, []);
  assert.deepEqual(h.focusCalls, []);
});
