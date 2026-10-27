import test from "node:test";
import assert from "node:assert/strict";
import { buildServiceCards, normalizeServiceCardOrder, moveServiceCard, createServiceCardOrder } from "../public/service-card-order.mjs";

const repos = ["a", "b", "c"].map(id => ({ id, name: id }));
const configs = [{ id: "a1", repositoryId: "a", name: "A" }, { id: "b1", repositoryId: "b", name: "B" }];
const keys = cards => cards.map(card => card.key);
const refs = cards => cards.map(({ key, repositoryId }) => ({ key, repositoryId }));
const initial = buildServiceCards(repos, configs);

test("card descriptors retain default layout and distinct configuration IDs without mutating inputs", () => {
  const before = JSON.stringify([repos, configs]);
  assert.deepEqual(keys(initial), ["configuration:a1", "configuration:b1", "repository:c"]);
  assert.equal(initial[0].configuration, configs[0]);
  assert.equal(initial[0].repository, repos[0]);
  assert.deepEqual(keys(buildServiceCards(repos, [...configs, configs[0], { id: "a2", repositoryId: "a" }])), ["configuration:a1", "configuration:b1", "configuration:a2", "repository:c"]);
  assert.equal(JSON.stringify([repos, configs]), before);
});

test("saved order wins over refreshed workspace order; new cards append and deleted cards vanish", () => {
  const saved = refs(initial).reverse();
  const next = buildServiceCards([...repos.slice().reverse(), { id: "d" }], configs.slice().reverse());
  assert.deepEqual(keys(normalizeServiceCardOrder(saved, next)), [...keys(saved), "repository:d"]);
  assert.deepEqual(keys(normalizeServiceCardOrder(saved, initial.filter(card => card.repositoryId !== "a"))), ["repository:c", "configuration:b1"]);
  assert.deepEqual(normalizeServiceCardOrder([null, {}, { key: "missing" }, ...saved, ...saved], initial), saved);
});

test("configuring a repository replaces its placeholder in place; deleting final config restores it in place", () => {
  const saved = refs(initial).reverse();
  const configured = buildServiceCards(repos, [...configs, { id: "c1", repositoryId: "c" }]);
  const after = normalizeServiceCardOrder(saved, configured);
  assert.deepEqual(keys(after), ["configuration:c1", "configuration:b1", "configuration:a1"]);
  assert.deepEqual(normalizeServiceCardOrder(after, initial), saved);
});

test("multiple configurations keep independent slots when another config is removed or added", () => {
  const cards = buildServiceCards(repos, [...configs, { id: "a2", repositoryId: "a" }]);
  const saved = refs([cards[0], cards[3], cards[1], cards[2]]);
  const remaining = buildServiceCards(repos, [configs[1], { id: "a2", repositoryId: "a" }]);
  assert.deepEqual(keys(normalizeServiceCardOrder(saved, remaining)), ["repository:c", "configuration:b1", "configuration:a2"]);
  const added = buildServiceCards(repos, [...configs, { id: "a2", repositoryId: "a" }, { id: "a3", repositoryId: "a" }]);
  assert.deepEqual(keys(normalizeServiceCardOrder(saved, added)), [...keys(saved), "configuration:a3"]);
});

test("pure move supports before/after and rejects stale or no-op drops", () => {
  const order = refs(initial);
  assert.deepEqual(keys(moveServiceCard(order, order[2].key, order[0].key)), [order[2].key, order[0].key, order[1].key]);
  assert.deepEqual(keys(moveServiceCard(order, order[0].key, order[2].key, "after")), [order[1].key, order[2].key, order[0].key]);
  for (const args of [["missing", order[0].key], [order[0].key, "missing"], [order[0].key, order[0].key], [order[0].key, order[1].key], [order[0].key, order[2].key, "invalid"]]) assert.equal(moveServiceCard(order, ...args), order);
  assert.deepEqual(order, refs(initial));
});

function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(name, handler) { const handlers = listeners.get(name) || []; handlers.push(handler); listeners.set(name, handlers); },
    removeEventListener(name, handler) { listeners.set(name, (listeners.get(name) || []).filter(item => item !== handler)); },
    emit(name, values = {}) {
      const event = { target: this, pointerId: 1, button: 0, detail: 1, clientX: 0, clientY: 0, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; }, ...values };
      for (const handler of listeners.get(name) || []) { handler(event); if (event.stopped) break; }
      return event;
    },
  });
}

function harness(options = {}) {
  const frames = new Map(); let frameId = 0;
  const window = events({ requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); } }), saved = [], announcements = [], errors = [], changes = [];
  const document = { defaultView: window, elementFromPoint: () => picked };
  let picked;
  function node(dataset = {}, x = 0) {
    const classes = new Set();
    return events({ ownerDocument: document, dataset, children: [], parentElement: null, attributes: {}, disabled: false,
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) },
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      getBoundingClientRect: () => ({ left: x, right: x + 100, top: 0, bottom: 100, width: 100, height: 100 }),
      matches(selector) { return selector === "[data-service-card]" ? "serviceCard" in dataset : selector === "[data-service-card-drag]" && "serviceCardDrag" in dataset; },
      closest(selector) { for (let item = this; item; item = item.parentElement) if (item.matches(selector)) return item; return null; },
      contains(target) { for (let item = target; item; item = item.parentElement) if (item === this) return true; return false; },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      append(child) { this.children.push(child); child.parentElement = this; },
      focus() { document.activeElement = this; }, scrollIntoView() {},
    });
  }
  const list = node(); list.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 100 });
  for (const [index, item] of initial.entries()) {
    const card = node({ serviceCard: item.key }, index * 110), handle = node({ serviceCardDrag: "" }, index * 110), action = node({}, index * 110);
    card.append(handle); card.append(action); list.append(card); card.handle = handle; card.action = action;
  }
  const controller = createServiceCardOrder({ list, save: async order => saved.push(order), onChange: order => changes.push(order), onError: error => errors.push(error), announce: text => announcements.push(text), ...options });
  controller.restore(refs(initial)); controller.arrange(initial);
  return { controller, list, window, document, saved, announcements, errors, changes, frames, pick: node => { picked = node; } };
}

test("only drag handles reorder; normal service actions and tiny clicks remain untouched", async () => {
  const h = harness(), [a, , c] = h.list.children;
  h.list.emit("pointerdown", { target: a.action }); h.pick(c);
  h.window.emit("pointermove", { clientX: 280, clientY: 50 }); h.window.emit("pointerup", { clientX: 280, clientY: 50 });
  assert.equal(h.changes.length, 0); assert.equal(h.controller.isDragging(), false);
  h.list.emit("pointerdown", { target: a.handle, clientX: 10, clientY: 10 });
  h.window.emit("pointermove", { clientX: 12, clientY: 10 }); h.window.emit("pointerup", { clientX: 12, clientY: 10 });
  assert.equal(h.changes.length, 0); assert.equal(h.list.emit("click", { target: a.action }).prevented, false);
  h.controller.destroy();
});

test("pointer drag reorders after target, persists once and suppresses synthetic action click", async () => {
  const h = harness(), [a, , c] = h.list.children;
  h.list.emit("pointerdown", { target: a.handle, clientX: 10, clientY: 10 }); h.pick(c);
  h.window.emit("pointermove", { clientX: 310, clientY: 50 });
  assert.equal(h.controller.isDragging(), true); assert.equal(c.classList.contains("service-drop-after"), true);
  h.window.emit("pointerup", { clientX: 310, clientY: 50 });
  assert.equal(h.controller.isDragging(), false);
  assert.deepEqual(keys(h.controller.snapshot()), ["configuration:b1", "repository:c", "configuration:a1"]);
  assert.equal(h.list.emit("click", { target: c.action }).stopped, true);
  await h.controller.flush(); assert.equal(h.saved.length, 1); assert.equal(h.announcements.length, 1);
  assert.equal(h.document.activeElement, a.handle); h.controller.destroy();
});

test("escape, cancellation, outside drops, and dispose do not commit a drag", async () => {
  for (const end of [h => h.list.emit("keydown", { key: "Escape" }), h => h.window.emit("pointercancel"), h => h.window.emit("pointerup", { clientX: 900, clientY: 50 }), h => h.controller.destroy()]) {
    const h = harness(), [a, , c] = h.list.children;
    h.list.emit("pointerdown", { target: a.handle }); h.pick(c); h.window.emit("pointermove", { clientX: 310, clientY: 50 }); end(h);
    assert.equal(h.controller.isDragging(), false); assert.deepEqual(h.controller.snapshot(), refs(initial));
    await h.controller.flush(); assert.equal(h.saved.length, 0); h.controller.destroy();
  }
});

test("dragging near viewport edges scrolls long service lists and cancels animation on finish", () => {
  const scrollContainer = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100, getBoundingClientRect: () => ({ left: 0, right: 400, top: 0, bottom: 100 }) };
  const h = harness({ scrollContainer }), [a, , c] = h.list.children;
  h.list.emit("pointerdown", { target: a.handle }); h.pick(c);
  h.window.emit("pointermove", { clientX: 310, clientY: 95 });
  assert.equal(h.frames.size, 1);
  const [id, callback] = h.frames.entries().next().value; h.frames.delete(id); callback(16);
  assert.ok(scrollContainer.scrollTop > 0); assert.equal(h.frames.size, 1);
  h.window.emit("pointercancel"); assert.equal(h.frames.size, 0); h.controller.destroy();
});

test("Alt+Shift+arrows move focused handles accessibly without running card actions", async () => {
  const h = harness(), [, b] = h.list.children;
  const ignored = h.list.emit("keydown", { target: b.action, key: "ArrowLeft", altKey: true, shiftKey: true });
  assert.equal(ignored.prevented, false);
  const moved = h.list.emit("keydown", { target: b.handle, key: "ArrowUp", altKey: true, shiftKey: true });
  assert.equal(moved.stopped, true); assert.deepEqual(keys(h.controller.snapshot()), ["configuration:b1", "configuration:a1", "repository:c"]);
  assert.equal(h.document.activeElement, b.handle);
  h.list.emit("keydown", { target: b.handle, key: "ArrowLeft", altKey: true, shiftKey: true });
  await h.controller.flush(); assert.equal(h.saved.length, 1); h.controller.destroy();
});

test("rapid moves serialize persistence and stale workspace restore cannot overwrite local order", async () => {
  const calls = []; let release;
  const h = harness({ save: order => { calls.push(order); return new Promise(resolve => { release = resolve; }); } });
  h.controller.move("configuration:a1", "repository:c", "after"); await Promise.resolve();
  h.controller.move("repository:c", "configuration:b1", "before");
  h.controller.restore(refs(initial));
  assert.equal(calls.length, 1); release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 2); release(); await h.controller.flush();
  assert.deepEqual(calls[1], h.controller.snapshot());
  h.controller.restore(refs(initial)); assert.deepEqual(calls[1], h.controller.snapshot()); h.controller.destroy();
});

test("failed save is reported honestly, retains local order, and next move retries persistence", async () => {
  let fail = true;
  const h = harness({ save: async () => { if (fail) throw new Error("offline"); } });
  h.controller.move("configuration:a1", "repository:c", "after"); await h.controller.flush();
  assert.equal(h.errors[0].message, "offline"); assert.equal(h.controller.snapshot().at(-1).key, "configuration:a1");
  fail = false; h.controller.move("configuration:a1", "configuration:b1", "before"); await h.controller.flush();
  assert.deepEqual(h.controller.snapshot(), refs(initial)); h.controller.destroy();
});

test("arrange prunes stale preferences asynchronously, and a restored session reproduces the layout", async () => {
  const h = harness(); h.controller.move("repository:c", "configuration:a1", "before"); await h.controller.flush();
  const persisted = h.saved.at(-1);
  const restarted = harness(); restarted.controller.restore(persisted, { force: true });
  assert.deepEqual(keys(restarted.controller.arrange(initial.slice().reverse())), keys(persisted));
  restarted.controller.arrange(initial.filter(card => card.repositoryId !== "a")); await restarted.controller.flush();
  assert.deepEqual(keys(restarted.saved.at(-1)), ["repository:c", "configuration:b1"]);
  h.controller.destroy(); restarted.controller.destroy();
});
