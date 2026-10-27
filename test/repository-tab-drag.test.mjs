import assert from "node:assert/strict";
import test from "node:test";
import { resolveRepositoryTabDrop, setupRepositoryTabDrag } from "../public/repository-tab-drag.mjs";

const repository = (id) => ({ type: "repository", id });
const group = (id) => ({ type: "group", id });
const hit = (target, extra = {}) => ({ ...target, left: 100, right: 200, ...extra });

test("repository drop uses tab midpoint and chip center or edges", () => {
  const source = repository("a");
  for (const [x, position] of [[101, "before"], [149, "before"], [150, "after"], [199, "after"]]) {
    assert.deepEqual(resolveRepositoryTabDrop({ source, hit: hit(repository("b")), clientX: x }), { source, target: repository("b"), position });
  }
  for (const [x, position] of [[110, "before"], [125, "inside"], [150, "inside"], [175, "inside"], [190, "after"]]) {
    assert.deepEqual(resolveRepositoryTabDrop({ source, hit: hit(group("g")), clientX: x }), { source, target: group("g"), position });
  }
});

test("dragged groups resolve a member or chip to the entire target block", () => {
  for (const target of [repository("member"), group("g")]) {
    for (const [x, position] of [[220, "before"], [360, "after"]]) {
      assert.deepEqual(resolveRepositoryTabDrop({ source: group("source"), hit: hit(target, { groupId: "g", groupLeft: 100, groupRight: 400 }), clientX: x }), {
        source: group("source"), target: group("g"), position,
      });
    }
  }
  assert.equal(resolveRepositoryTabDrop({ source: group("g"), hit: hit(repository("member"), { groupId: "g" }), clientX: 130 }), null);
  assert.equal(resolveRepositoryTabDrop({ source: repository("a"), hit: hit(repository("a")), clientX: 130 }), null);
  assert.equal(resolveRepositoryTabDrop({ source: repository("a"), hit: hit(repository("b"), { right: 100 }), clientX: 130 }), null);
});

function events(target = {}) {
  const handlers = new Map();
  return Object.assign(target, {
    handlers,
    addEventListener(type, callback) { const list = handlers.get(type) || []; list.push(callback); handlers.set(type, list); },
    removeEventListener(type, callback) { handlers.set(type, (handlers.get(type) || []).filter((item) => item !== callback)); },
    emit(type, values = {}) {
      const event = { target: this, pointerId: 1, isPrimary: true, button: 0, detail: 1, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; }, ...values };
      const results = [];
      for (const callback of handlers.get(type) || []) { results.push(callback(event)); if (event.stopped) break; }
      event.finished = Promise.all(results);
      return event;
    },
  });
}

function harness({ afterMove, withLabel = false } = {}) {
  const frames = new Map(), moves = [], settlements = [];
  let frameId = 0, allowed = true, picked = null;
  const window = events({ requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); } });
  const document = { defaultView: window, elementFromPoint: () => picked || rail };
  function node(dataset = {}, left = 0, right = 100, classes = []) {
    const classNames = new Set(classes);
    const result = events({ dataset, children: [], parentElement: null, ownerDocument: document, disabled: false, style: {}, textContent: "", attributes: {}, offsetWidth: 100, offsetHeight: 32,
      classList: { add: (...values) => values.forEach((value) => classNames.add(value)), remove: (...values) => values.forEach((value) => classNames.delete(value)), contains: (value) => classNames.has(value) },
      getAttribute: () => null,
      setAttribute(name, value) { this.attributes[name] = value; },
      set innerHTML(_) { throw new Error("Drag feedback must use literal text"); },
      matches(selector) { return selector.split(",").some((part) => {
        part = part.trim();
        if (part.startsWith(".")) return classNames.has(part.slice(1));
        const attribute = part.match(/^\[data-([^\]]+)\]$/)?.[1]?.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return attribute && Object.hasOwn(dataset, attribute);
      }); },
      closest(selector) { for (let item = this; item; item = item.parentElement) if (item.matches(selector)) return item; return null; },
      contains(other) { for (let item = other; item; item = item.parentElement) if (item === this) return true; return false; },
      querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      focus() { document.activeElement = this; },
      scrollIntoView(options) { this.revealed = options; },
      getBoundingClientRect() { const scroll = result === rail ? 0 : rail.scrollLeft; return { left: left - scroll, right: right - scroll, width: right - left, top: 0, bottom: 40, height: 40 }; },
      append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; },
    });
    return result;
  }
  const rail = node({}, 0, 700);
  let labelParent;
  if (withLabel) {
    labelParent = node({}, 0, 700);
    Object.assign(labelParent, { clientWidth: 700, offsetWidth: 700, clientHeight: 40, offsetHeight: 40 });
    labelParent.append(rail);
    document.createElement = () => node();
  }
  Object.assign(rail, { scrollLeft: 0, scrollWidth: 1000, clientWidth: 700, captured: null,
    setPointerCapture(id) { this.captured = id; }, hasPointerCapture(id) { return this.captured === id; },
    releasePointerCapture(id) { this.captured = null; this.emit("lostpointercapture", { pointerId: id }); },
  });
  function tab(id, left, right, groupId) {
    const tab = node({ repositoryTab: id, ...(groupId ? { tabGroup: groupId } : {}) }, left, right);
    tab.main = node({ repositoryId: id }, left, right - 20, ["repo-tab-main"]);
    tab.close = node({ closeRepository: id }, right - 20, right);
    tab.append(tab.main, tab.close);
    return tab;
  }
  const a = tab("a", 0, 100), b = tab("b", 220, 300, "g"), c = tab("c", 310, 400, "g"), d = tab("d", 420, 510);
  const block = node({ tabGroupBlock: "g" }, 120, 400);
  const chip = node({ toggleTabGroup: "g", tabGroup: "g" }, 120, 210);
  block.append(chip, b, c);
  const otherBlock = node({ tabGroupBlock: "h" }, 530, 640);
  const otherChip = node({ toggleTabGroup: "h", tabGroup: "h" }, 530, 640);
  otherBlock.append(otherChip);
  rail.append(a, block, d, otherBlock);
  const controller = setupRepositoryTabDrag({ rail, canDrag: () => allowed, onMove(drop) {
    assert.equal(controller.isDragging(), false);
    assert.equal(rail.classList.contains("is-tab-dragging"), false);
    moves.push(drop);
    return afterMove?.(drop);
  }, onSettled() { settlements.push({ dragging: controller.isDragging(), captured: rail.captured }); } });
  return { rail, window, frames, moves, settlements, controller, a, b, c, d, block, chip, otherBlock, otherChip, labelParent,
    allow(value) { allowed = value; }, pick(value) { picked = value; },
    down(target, x, extra = {}) { return rail.emit("pointerdown", { target, clientX: x, clientY: 20, ...extra }); },
    move(x, y = 20, extra = {}) { return window.emit("pointermove", { clientX: x, clientY: y, ...extra }); },
    up(x, y = 20) { return window.emit("pointerup", { clientX: x, clientY: y }); },
    tick(timestamp = 16) { const current = [...frames.values()]; frames.clear(); current.forEach((callback) => callback(timestamp)); },
  };
}

test("normal clicks, close buttons, right clicks, and disabled navigation do not drag", () => {
  const h = harness();
  h.down(h.a.main, 20); h.move(25); h.up(25);
  assert.equal(h.rail.emit("click").prevented, false);
  assert.equal(h.settlements.length, 0);
  for (const [target, extra] of [[h.a.close, {}], [h.chip, { button: 2 }], [h.a.main, { isPrimary: false }]]) {
    h.down(target, 20, extra); h.move(170); h.up(170);
    assert.equal(h.controller.isDragging(), false);
  }
  h.allow(false); h.down(h.a.main, 20); h.move(170); h.up(170);
  assert.deepEqual(h.moves, []);
});

test("drag threshold captures the rail, shows a target, moves once, and consumes only its click", () => {
  const h = harness();
  h.down(h.a.main, 20);
  h.move(25);
  assert.equal(h.rail.captured, null);
  h.pick(h.b.main); h.move(260);
  assert.equal(h.rail.captured, 1);
  assert.equal(h.controller.isDragging(), true);
  assert.equal(h.a.classList.contains("repo-drag-source"), true);
  assert.equal(h.b.classList.contains("repo-drop-after"), true);
  h.up(260);
  assert.deepEqual(h.moves, [{ source: repository("a"), target: repository("b"), position: "after" }]);
  assert.deepEqual(h.settlements, [{ dragging: false, captured: null }]);
  assert.equal(h.a.classList.contains("repo-drag-source"), false);
  assert.equal(h.b.classList.contains("repo-drop-after"), false);
  assert.equal(h.rail.emit("click", { detail: 0 }).prevented, false, "keyboard activation remains available");
  assert.equal(h.rail.emit("click").prevented, true);
  assert.equal(h.rail.emit("click").prevented, false);
});

test("group drag highlights the whole source and destination and never nests groups", () => {
  const h = harness();
  h.down(h.otherChip, 560); h.pick(h.b.main); h.move(240);
  assert.equal(h.otherBlock.classList.contains("repo-drag-source"), true);
  assert.equal(h.block.classList.contains("repo-drop-before"), true);
  h.up(240);
  assert.deepEqual(h.moves, [{ source: group("h"), target: group("g"), position: "before" }]);
});

test("chip center appends while its edges ungroup a repository", () => {
  for (const [x, position] of [[130, "before"], [165, "inside"], [200, "after"]]) {
    const h = harness(); h.down(h.b.main, 240); h.pick(h.chip); h.move(x); h.up(x);
    assert.deepEqual(h.moves, [{ source: repository("b"), target: group("g"), position }]);
  }
});

test("self and adjacent drops are ignored while crossing a group remains meaningful", () => {
  for (const [sourceName, targetName, x] of [["b", "c", 320], ["c", "b", 295], ["a", "a", 60]]) {
    const h = harness(); const source = h[sourceName], target = h[targetName];
    h.down(source.main, source.getBoundingClientRect().left + 10); h.pick(target.main); h.move(x); h.up(x);
    assert.deepEqual(h.moves, []);
  }
  const h = harness(); h.down(h.a.main, 20); h.pick(h.d.main); h.move(430); h.up(430);
  assert.deepEqual(h.moves, [{ source: repository("a"), target: repository("d"), position: "before" }]);
  const own = harness(); own.down(own.c.main, 330); own.pick(own.chip); own.move(165); own.up(165);
  assert.deepEqual(own.moves, [], "the final group member is already appended");
});

test("outside drop, Escape, cancel, lost capture, blur, and offboarding clear every drag state", () => {
  for (const reason of ["outside", "Escape", "pointercancel", "lostpointercapture", "blur", "offboarding"]) {
    const h = harness(); h.down(h.a.main, 20); h.pick(h.b.main); h.move(260);
    if (reason === "outside") h.up(260, 90);
    else if (reason === "Escape") h.window.emit("keydown", { key: "Escape" });
    else if (reason === "blur") h.window.emit("blur");
    else if (reason === "offboarding") { h.allow(false); h.up(260); }
    else (reason === "lostpointercapture" ? h.rail : h.window).emit(reason);
    assert.equal(h.controller.isDragging(), false, reason);
    assert.equal(h.rail.captured, null, reason);
    assert.equal(h.rail.classList.contains("is-tab-dragging"), false, reason);
    assert.equal(h.a.classList.contains("repo-drag-source"), false, reason);
    assert.equal(h.b.classList.contains("repo-drop-after"), false, reason);
    assert.equal(h.frames.size, 0, reason);
    assert.deepEqual(h.moves, [], reason);
    assert.equal(h.settlements.length, 1, reason);
    h.up(260);
    assert.equal(h.settlements.length, 1, "settlement is not repeated after a cancellation");
  }
});

test("edge dragging scrolls in animation frames and stops immediately on cancel", () => {
  const h = harness(); h.down(h.a.main, 20); h.pick(h.rail); h.move(695);
  assert.equal(h.frames.size, 1);
  h.tick();
  assert.ok(h.rail.scrollLeft > 0);
  assert.equal(h.frames.size, 1);
  const previous = h.rail.scrollLeft;
  h.window.emit("pointercancel"); h.tick(32);
  assert.equal(h.rail.scrollLeft, previous);
  assert.equal(h.frames.size, 0);
  assert.deepEqual(h.moves, []);
});

test("a new normal pointer sequence clears stale click suppression and destroy removes listeners", () => {
  const h = harness(); h.down(h.a.main, 20); h.pick(h.b.main); h.move(260); h.window.emit("blur");
  h.down(h.d.close, 505); h.up(505);
  assert.equal(h.rail.emit("click", { target: h.d.close }).prevented, false);
  h.down(h.a.main, 20); h.move(260);
  h.controller.destroy(); h.controller.destroy();
  assert.equal(h.controller.isDragging(), false);
  assert.ok([...h.rail.handlers.values(), ...h.window.handlers.values()].every((handlers) => handlers.length === 0));
  assert.equal(h.frames.size, 0);
});

test("the outer group gap ungroups its final member and permits drops past a trailing group", () => {
  const h = harness(); h.down(h.c.main, 330); h.pick(h.rail); h.move(405); h.up(405);
  assert.deepEqual(h.moves, [{ source: repository("c"), target: group("g"), position: "after" }]);
  const before = harness(); before.down(before.b.main, 240); before.pick(before.rail); before.move(115); before.up(115);
  assert.deepEqual(before.moves, [{ source: repository("b"), target: group("g"), position: "before" }]);
  const end = harness(); end.down(end.a.main, 20); end.pick(end.rail); end.move(680); end.up(680);
  assert.deepEqual(end.moves, [{ source: repository("a"), target: group("h"), position: "after" }]);
});

test("Alt+Shift+arrows move groups by whole blocks and repositories through visible destinations", async () => {
  for (const [sourceName, direction, expected] of [
    ["chip", "ArrowLeft", { source: group("g"), target: repository("a"), position: "before" }],
    ["chip", "ArrowRight", { source: group("g"), target: repository("d"), position: "after" }],
    ["b", "ArrowLeft", { source: repository("b"), target: group("g"), position: "before" }],
    ["b", "ArrowRight", { source: repository("b"), target: repository("c"), position: "after" }],
    ["a", "ArrowRight", { source: repository("a"), target: group("g"), position: "inside" }],
    ["d", "ArrowRight", { source: repository("d"), target: group("h"), position: "inside" }],
  ]) {
    const h = harness(), source = h[sourceName];
    const event = h.rail.emit("keydown", { target: source.main || source, key: direction, altKey: true, shiftKey: true });
    await event.finished;
    assert.equal(event.prevented, true);
    assert.deepEqual(h.moves, [expected]);
    assert.equal(h.settlements.length, 1);
    assert.equal(h.rail.ownerDocument.activeElement, source.main || source);
    assert.equal(source.revealed.inline, "nearest");
  }
});

test("keyboard movement waits for saving, ignores repeated requests, and leaves normal arrows alone", async () => {
  let resolve;
  const saved = new Promise((done) => { resolve = done; });
  const h = harness({ afterMove: () => saved });
  const first = h.rail.emit("keydown", { target: h.b.main, key: "ArrowRight", altKey: true, shiftKey: true });
  const second = h.rail.emit("keydown", { target: h.b.main, key: "ArrowRight", altKey: true, shiftKey: true });
  assert.equal(h.moves.length, 1);
  assert.equal(h.settlements.length, 0);
  assert.equal(h.rail.ownerDocument.activeElement, undefined);
  assert.equal(h.rail.emit("keydown", { target: h.b.main, key: "ArrowRight" }).prevented, false);
  resolve(); await first.finished; await second.finished;
  assert.equal(h.settlements.length, 1);
  assert.equal(h.rail.ownerDocument.activeElement, h.b.main);
  const disabled = harness(); disabled.allow(false);
  await disabled.rail.emit("keydown", { target: disabled.b.main, key: "ArrowRight", altKey: true, shiftKey: true }).finished;
  assert.deepEqual(disabled.moves, []);
});

test("floating label starts at the drag threshold, stays literal and zoom-clamped, and always cleans up", () => {
  for (const ending of ["drop", "cancel", "destroy"]) {
    const h = harness({ withLabel: true });
    h.a.main.textContent = '<img src=x onerror="bad()">Repository';
    h.labelParent.getBoundingClientRect = () => ({ left: 10, top: 0, width: 854, height: 48.8 });
    h.down(h.a.main, 20); h.move(25);
    assert.equal(h.labelParent.querySelector(".repo-tab-drag-label"), null);
    h.pick(h.b.main); h.move(260);
    const label = h.labelParent.querySelector(".repo-tab-drag-label");
    assert.equal(label.textContent, h.a.main.textContent);
    assert.equal(label.attributes["aria-hidden"], "true");
    assert.equal(label.style.pointerEvents, "none");
    assert.ok(Math.abs(Number.parseFloat(label.style.left) - ((260 - 10) / 1.22 + 12)) < .001);
    h.move(1000);
    assert.equal(label.style.left, "596px");
    assert.ok(Number.parseFloat(label.style.top) >= 2);
    assert.ok(Number.parseFloat(label.style.top) + label.offsetHeight <= h.labelParent.clientHeight);
    if (ending === "drop") h.up(260);
    else if (ending === "cancel") h.window.emit("pointercancel");
    else h.controller.destroy();
    assert.equal(h.labelParent.querySelector(".repo-tab-drag-label"), null, ending);
    assert.equal(label.parentElement, null, ending);
  }
});
