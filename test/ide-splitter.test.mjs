import test from "node:test";
import assert from "node:assert/strict";
import { createIdeSplitter } from "../public/ide-splitter.mjs";
import { createRepositoryWorkbenchResize } from "../public/repository-ide-resize.mjs";

function target() {
  const listeners = new Map();
  return { listeners,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, extra = {}) { const event = { button: 0, pointerId: 1, clientX: 300, clientY: 300, isPrimary: true, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra }; for (const fn of listeners.get(type) || []) fn(event); return event; },
  };
}
function element() {
  const styles = new Map(), attributes = new Map(), classes = new Set();
  return { ...target(), attributes, classes, dataset: {}, children: [], style: {
    setProperty: (key, value) => styles.set(key, value), getPropertyValue: key => styles.get(key) || "", removeProperty: key => styles.delete(key),
  }, classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
  setAttribute: (key, value) => attributes.set(key, value), focus() {}, setPointerCapture() {}, releasePointerCapture() {},
  append(child) { this.children.push(child); child.parent = this; },
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); },
  };
}
function harness({ saved, storageBlocked = false } = {}) {
  const container = element(), handle = element(), body = element(), window = target(), values = new Map(), writes = [];
  const state = { axis: "x", minimum: 120, maximum: 800, initial: 400, scale: 1, layout: true };
  if (saved !== undefined) values.set("split:a:x", saved);
  const storage = { getItem(key) { if (storageBlocked) throw Error("blocked"); return values.get(key); }, setItem(key, value) { if (storageBlocked) throw Error("blocked"); writes.push([key, value]); values.set(key, value); }, removeItem(key) { if (storageBlocked) throw Error("blocked"); writes.push([key, null]); values.delete(key); } };
  const observers = [];
  window.ResizeObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.stopped = true; } };
  container.offsetWidth = 1200; container.offsetHeight = 700;
  container.getBoundingClientRect = () => ({ width: container.offsetWidth * state.scale, height: container.offsetHeight * state.scale });
  const document = { body, defaultView: window, createElement: element };
  const controller = createIdeSplitter({ document, container, handle, storage, property: "--size", storageKey: "split", getLayout: () => state.layout ? state : null });
  const width = () => parseInt(container.style.getPropertyValue("--size"), 10);
  controller.setContext("a");
  const drag = (delta, commit = true) => { handle.emit("pointerdown"); window.emit("pointermove", state.axis === "x" ? { clientX: 300 + delta } : { clientY: 300 + delta }); if (commit) window.emit("pointerup"); };
  return { controller, document, container, handle, body, window, state, values, writes, observers, width, drag };
}

test("drag expands and shrinks across iframe shield, persists only on release, correct under zoom", () => {
  for (const scale of [1, 1.12, 1.22]) {
    const h = harness(); h.state.scale = scale;
    h.drag(100 * scale, false); assert.equal(h.width(), 500); assert.equal(h.body.children.length, 1); assert.deepEqual(h.writes, []);
    h.window.emit("pointerup"); assert.equal(h.body.children.length, 0); assert.equal(h.values.get("split:a:x"), "500");
    h.drag(-70 * scale); assert.equal(h.width(), 430);
  }
});
test("bounds clamp without destroying saved size when window gets smaller", () => {
  const h = harness({ saved: "700" }); assert.equal(h.width(), 700);
  h.state.maximum = 450; h.controller.refresh(); assert.equal(h.width(), 450); assert.equal(h.values.get("split:a:x"), "700");
  h.state.maximum = 800; h.controller.refresh(); assert.equal(h.width(), 700);
  h.drag(900); assert.equal(h.width(), 800); h.drag(-1000); assert.equal(h.width(), 120);
});
test("bottom tool dock grows upwards and preserves its height across collapse and zoom", () => {
  const h = harness(); h.state.axis = "y"; h.state.reverse = true; h.state.scale = 1.25; h.controller.refresh();
  h.drag(-125); assert.equal(h.width(), 500); assert.equal(h.values.get("split:a:y"), "500");
  h.handle.emit("keydown", { key: "ArrowUp" }); assert.equal(h.width(), 510);
  h.handle.emit("keydown", { key: "ArrowDown" }); assert.equal(h.width(), 500);
  h.controller.setContext("a", false); assert.equal(h.handle.hidden, true);
  h.controller.setContext("a", true); assert.equal(h.width(), 500);
  h.drag(125); assert.equal(h.width(), 400); h.controller.dispose();
});
test("separate repository and orientation preferences restore without bleeding across layouts", () => {
  const h = harness(); h.drag(100); h.controller.setContext("b"); assert.equal(h.width(), 400);
  h.drag(-50); h.controller.setContext("a"); assert.equal(h.width(), 500);
  h.state.axis = "y"; h.controller.refresh(); assert.equal(h.width(), 400); h.drag(-80); assert.equal(h.width(), 320);
  assert.equal(h.handle.attributes.get("aria-orientation"), "horizontal");
  h.state.axis = "x"; h.controller.refresh(); assert.equal(h.width(), 500);
  assert.equal(h.values.get("split:a:y"), "320"); assert.equal(h.values.get("split:b:x"), "350");
});
test("cancelling restores committed size and removes overlay/listeners on disposal", () => {
  for (const action of ["pointercancel", "blur", "Escape", "lostpointercapture", "disabled", "dispose"]) {
    const h = harness({ saved: "420" }); h.drag(100, false);
    if (action === "Escape") h.window.emit("keydown", { key: "Escape" });
    else if (action === "lostpointercapture") h.handle.emit(action);
    else if (action === "disabled") h.controller.setContext("a", false);
    else if (action === "dispose") h.controller.dispose(); else h.window.emit(action);
    assert.equal(h.body.children.length, 0); assert.deepEqual(h.writes, []);
    if (action !== "dispose") assert.equal(h.width(), 420);
    h.controller.dispose(); assert.equal(h.container.style.getPropertyValue("--size"), "");
    for (const group of h.window.listeners.values()) assert.equal(group.size, 0);
    assert.ok(h.observers[0].stopped);
  }
});
test("keyboard supports arrows, Home/End and double-click reset with ARIA", () => {
  const h = harness(); h.handle.emit("keydown", { key: "ArrowRight" }); assert.equal(h.width(), 410);
  h.handle.emit("keydown", { key: "ArrowLeft", shiftKey: true }); assert.equal(h.width(), 370);
  h.handle.emit("keydown", { key: "End" }); assert.equal(h.width(), 800);
  h.handle.emit("keydown", { key: "Home" }); assert.equal(h.width(), 400); assert.equal(h.values.has("split:a:x"), false);
  h.drag(100); h.handle.emit("dblclick"); assert.equal(h.width(), 400);
  assert.equal(h.handle.attributes.get("role"), "separator"); assert.equal(h.handle.attributes.get("aria-valuenow"), "400");
  h.state.axis = "y"; h.controller.refresh(); h.handle.emit("keydown", { key: "ArrowDown" }); assert.equal(h.width(), 410);
});
test("storage failures remain usable; invalid values are ignored; inactive/nonprimary controls are inert", () => {
  for (const saved of ["oops", "Infinity", "-20", "0"]) assert.equal(harness({ saved }).width(), 400);
  const h = harness({ storageBlocked: true }); h.drag(60); assert.equal(h.width(), 460);
  h.controller.setContext("b"); h.controller.setContext("a"); assert.equal(h.width(), 460);
  h.controller.setContext("a", false); assert.equal(h.handle.hidden, true); assert.equal(h.handle.emit("pointerdown").prevented, undefined);
  h.controller.setContext("a"); assert.equal(h.handle.emit("pointerdown", { button: 2 }).prevented, undefined); assert.equal(h.handle.emit("pointerdown", { isPrimary: false }).prevented, undefined);
});
test("viewport orientation switch or repository switch cancels a drag rather than saving the wrong context", () => {
  const h = harness(); h.drag(100, false); h.state.axis = "y"; h.controller.refresh(); assert.equal(h.body.children.length, 0); assert.equal(h.width(), 400); assert.deepEqual(h.writes, []);
  h.drag(100, false); h.controller.setContext("b"); assert.equal(h.body.children.length, 0); assert.deepEqual(h.writes, []);
});
test("workbench docks chat on the right and reserves usable width for both panes", () => {
  const h = harness(); h.controller.dispose(); const host = element(); host.after = item => h.container.append(item);
  h.container.clientWidth = 1000; h.container.clientHeight = 650;
  h.document.querySelector = selector => selector === "#repository-workbench" ? h.container : host;
  const controller = createRepositoryWorkbenchResize({ document: h.document }); controller.setContext("a");
  const handle = h.container.children[0]; assert.equal(handle.attributes.get("aria-label"), "Resize editor and AI chat");
  assert.equal(handle.attributes.get("aria-valuemin"), "280"); assert.equal(handle.attributes.get("aria-valuemax"), "634");
  assert.equal(handle.attributes.get("aria-orientation"), "vertical");
  assert.equal(h.container.dataset.chatLayout, "split");
  assert.equal(h.container.style.getPropertyValue("--ide-chat-width"), "358px");
  handle.emit("keydown", { key: "ArrowRight" });
  assert.equal(h.container.style.getPropertyValue("--ide-chat-width"), "348px");
  handle.emit("keydown", { key: "ArrowDown" });
  assert.equal(h.container.style.getPropertyValue("--ide-chat-width"), "348px");
  h.container.clientWidth = 420; controller.refresh();
  assert.equal(h.container.dataset.chatLayout, "overlay"); assert.equal(handle.hidden, true);
  assert.equal(h.container.style.getPropertyValue("--ide-chat-width"), "348px");
  h.container.clientWidth = 1000; h.container.clientHeight = 250; controller.refresh();
  assert.equal(h.container.dataset.chatLayout, "split"); assert.equal(handle.hidden, false);
  assert.equal(h.container.style.getPropertyValue("--ide-chat-width"), "348px", "short windows retain a side-by-side split");
  controller.dispose(); assert.equal(h.container.children.length, 0); assert.equal(h.container.dataset.chatLayout, undefined);
});
test("workbench ignores old height preferences and restores chat width after hiding or switching repositories", () => {
  const h = harness(); h.controller.dispose(); const host = element(); host.after = item => h.container.append(item);
  h.container.clientWidth = 1000; h.container.clientHeight = 650;
  h.document.querySelector = selector => selector === "#repository-workbench" ? h.container : host;
  h.values.set("argus-ide-editor-size:a:x", "600");
  h.values.set("argus-ide-editor-size:a:y", "300");
  h.values.set("argus.repositoryIde.editorHeight.v1:a:y", "500");
  const storage = { getItem: key => h.values.get(key), setItem: (key, value) => h.values.set(key, value) };
  const controller = createRepositoryWorkbenchResize({ document: h.document, storage }); controller.setContext("a");
  const handle = h.container.children[0], width = () => h.container.style.getPropertyValue("--ide-chat-width");
  assert.equal(width(), "358px");
  handle.emit("keydown", { key: "ArrowLeft", shiftKey: true });
  assert.equal(width(), "398px");
  assert.equal(h.values.get("argus.repositoryIde.chatWidth.v1:a:x"), "398");
  assert.equal(h.values.get("argus.repositoryIde.editorHeight.v1:a:y"), "500", "legacy preferences are not rewritten");
  controller.setContext("b"); assert.equal(width(), "358px");
  controller.setContext("a"); assert.equal(width(), "398px");
  h.body.classList.add("repository-ide-chat-hidden"); controller.refresh();
  assert.equal(handle.hidden, true);
  assert.equal(handle.emit("pointerdown").prevented, undefined);
  h.body.classList.remove("repository-ide-chat-hidden"); controller.refresh();
  assert.equal(handle.hidden, false); assert.equal(width(), "398px");
  controller.setContext("a", false); assert.equal(handle.hidden, true);
  controller.setContext("a", true); assert.equal(width(), "398px");
  controller.dispose();
});

test("right-hand chat grows when its divider is dragged left and restores its saved width", () => {
  const h = harness(); h.controller.dispose(); const host = element(); host.after = item => h.container.append(item);
  h.container.clientWidth = 1000; h.container.clientHeight = 650;
  h.document.querySelector = selector => selector === "#repository-workbench" ? h.container : host;
  const storage = { getItem: key => h.values.get(key), setItem: (key, value) => h.values.set(key, value) };
  let controller = createRepositoryWorkbenchResize({ document: h.document, storage }); controller.setContext("a");
  let handle = h.container.children[0];
  handle.emit("pointerdown"); h.window.emit("pointermove", { clientX: 220 }); h.window.emit("pointerup");
  assert.equal(h.container.style.getPropertyValue("--ide-chat-width"), "438px");
  assert.equal(h.values.get("argus.repositoryIde.chatWidth.v1:a:x"), "438");
  controller.dispose();
  controller = createRepositoryWorkbenchResize({ document: h.document, storage }); controller.setContext("a");
  assert.equal(h.container.style.getPropertyValue("--ide-chat-width"), "438px");
  handle = h.container.children[0]; handle.emit("pointerdown"); h.window.emit("pointermove", { clientX: 350 }); h.window.emit("pointerup");
  assert.equal(h.container.style.getPropertyValue("--ide-chat-width"), "388px");
  controller.dispose();
});

test("workbench sizing subtracts the tools rail and never loses a saved width while compact", () => {
  const h = harness(); h.controller.dispose(); const host = element(); host.after = item => h.container.append(item);
  h.container.clientWidth = 1000; h.container.clientHeight = 650;
  h.document.querySelector = selector => selector === "#repository-workbench" ? h.container : host;
  h.window.getComputedStyle = () => ({ paddingLeft: "48px", paddingRight: "0px" });
  const storage = { getItem: key => h.values.get(key), setItem: (key, value) => h.values.set(key, value) };
  h.values.set("argus.repositoryIde.chatWidth.v1:a:x", "500");
  const controller = createRepositoryWorkbenchResize({ document: h.document, storage }); controller.setContext("a");
  const handle = h.container.children[0];
  assert.equal(handle.attributes.get("aria-valuemax"), "586");
  h.container.clientWidth = 750; controller.refresh(); assert.equal(h.container.dataset.chatLayout, "overlay");
  assert.equal(h.values.get("argus.repositoryIde.chatWidth.v1:a:x"), "500");
  h.container.clientWidth = 1000; controller.refresh(); assert.equal(h.container.style.getPropertyValue("--ide-chat-width"), "500px");
  controller.dispose();
});
