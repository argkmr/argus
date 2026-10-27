import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const findSource = app.slice(app.indexOf("function visibleElement("), app.indexOf("const api = createApiClient"));

function harness({ nativeHighlight = true, editable = false } = {}) {
  let document;
  class Element {
    constructor(id = "") {
      this.id = id; this.value = ""; this.style = {}; this.classes = new Set(); this.listeners = new Map();
      this.children = []; this.isConnected = true; this.scrollTop = this.scrollLeft = 0;
      this.offsetWidth = this.clientWidth = 600; this.clientHeight = 300; this.focuses = 0;
      this.classList = { contains: key => this.classes.has(key), add: key => this.classes.add(key), remove: key => this.classes.delete(key) };
    }
    focus() { document.activeElement = this; this.focuses++; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    setSelectionRange() { throw new Error("Find must not change an editor or search-input selection"); }
    addEventListener(type, listener) { this.listeners.set(type, [...this.listeners.get(type) || [], listener]); }
    emit(type, values = {}) {
      const event = { key: "", prevented: false, preventDefault() { this.prevented = true; }, ...values };
      for (const listener of this.listeners.get(type) || []) listener(event);
      return event;
    }
    append(child) { child.parentElement = this; this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    remove() { this.removed = true; }
    getClientRects() { return [this.getBoundingClientRect()]; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 600, bottom: 300, width: 600, height: 300 }; }
    scrollBy(options) { this.scrolled = options; }
    closest(selector) { return this.excluded && selector.includes("#find-bar") ? this : null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  class Input extends Element {}
  class Textarea extends Element {}
  class Dialog extends Element {}
  const elements = new Map(["find-bar", "find-input", "find-status", "find-next", "find-previous", "find-close"].map(id => [id, id === "find-input" ? new Input(id) : new Element(id)]));
  const target = editable ? new Textarea() : new Element();
  const surface = new Element();
  const ranges = [], highlights = new Map();
  document = Object.assign(new Element(), {
    body: new Element(), activeElement: elements.get("find-input"),
    createElement: () => new Element(),
    querySelector: selector => elements.get(selector.slice(1)) || null,
    createTreeWalker(node) { let index = 0; return { nextNode: () => node.nodes?.[index++] || null }; },
    createRange() {
      const range = {
        setStart(node, offset) { this.start = { node, offset }; }, setEnd(node, offset) { this.end = { node, offset }; },
        getBoundingClientRect: () => ({ left: 15, top: 20, bottom: 40, right: 70, width: 55, height: 20 }),
        getClientRects() { return [this.getBoundingClientRect()]; },
      };
      ranges.push(range); return range;
    },
  });
  const window = Object.assign(new Element(), {
    CSS: nativeHighlight ? { highlights } : {},
    Highlight: class { constructor(range) { this.range = range; } },
    getSelection() { throw new Error("Find must not steal the user's DOM selection"); },
  });
  const state = { findTarget: target, findSurface: surface, findQuery: "", findMatchIndex: -1, findHighlightOverlay: null, findHighlightRange: null, findComposing: false };
  const context = vm.createContext({
    state, document, window, $: selector => document.querySelector(selector),
    HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLDialogElement: Dialog,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ paddingTop: "0", paddingLeft: "0" }),
    escapeHtml: value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;"), toast() {},
  });
  vm.runInContext(findSource, context);
  context.bindFindBar();
  const input = elements.get("find-input");
  function setSource(...parts) {
    target.nodes = parts.map(data => ({ data, parentElement: new Element() }));
    target.value = parts.join("");
  }
  function type(value, selectionStart = value.length, selectionEnd = selectionStart) {
    input.value = value; input.selectionStart = selectionStart; input.selectionEnd = selectionEnd;
    input.emit("input");
  }
  setSource("slack alphabet slack\nSLACK");
  return { context, document, window, state, target, surface, input, ranges, highlights, elements, setSource, type, status: () => elements.get("find-status").textContent };
}

test("read-only find preserves typing focus and caret, including editing/replacing in the middle", () => {
  const h = harness();
  for (const word of ["s", "sl", "sla", "slac", "slack"]) {
    h.type(word);
    assert.equal(h.input.value, word);
    assert.equal(h.input.selectionStart, word.length);
    assert.equal(h.document.activeElement, h.input);
  }
  h.type("slack", 2, 4);
  assert.equal(h.input.selectionStart, 2);
  assert.equal(h.input.selectionEnd, 4);
  assert.equal(h.input.focuses, 0, "live typing never refocuses the input");
  assert.equal(h.status(), "1 of 3");
  assert.equal(h.highlights.has("argus-find-active"), true);
});

test("Enter, Shift+Enter, buttons and Cmd/Ctrl+G move and wrap without changing the query", () => {
  const h = harness(); h.type("slack");
  assert.equal(h.input.emit("keydown", { key: "Enter" }).prevented, true);
  assert.equal(h.status(), "2 of 3");
  h.elements.get("find-next").emit("click"); assert.equal(h.status(), "3 of 3");
  h.document.emit("keydown", { key: "g", metaKey: true }); assert.equal(h.status(), "1 of 3");
  h.document.emit("keydown", { key: "g", ctrlKey: true, shiftKey: true }); assert.equal(h.status(), "3 of 3");
  h.input.emit("keydown", { key: "Enter", shiftKey: true }); assert.equal(h.status(), "2 of 3");
  h.elements.get("find-previous").emit("click"); assert.equal(h.status(), "1 of 3");
  assert.equal(h.input.value, "slack");
});

test("IME composition never searches, consumes Enter or resets composition selection until committed", () => {
  const h = harness(); h.setSource("日本 日本");
  h.input.emit("compositionstart");
  h.input.value = "日";
  h.input.emit("input", { isComposing: true });
  assert.equal(h.ranges.length, 0);
  assert.equal(h.input.emit("keydown", { key: "Enter", isComposing: true }).prevented, false);
  assert.equal(h.document.emit("keydown", { key: "Escape", isComposing: true }).prevented, false);
  h.input.value = "日本";
  h.input.emit("compositionend");
  assert.equal(h.status(), "1 of 2");
  h.input.emit("input");
  assert.equal(h.status(), "1 of 2", "the trailing committed input must not skip to the next match");
});

test("the toolbar and hidden text are excluded and ranges cross text nodes with original Unicode offsets", () => {
  const h = harness(); h.setSource("İ greeting sl", "ack\nslack");
  h.target.nodes.push({ data: "slack", parentElement: { closest: () => true } });
  h.type("slack");
  assert.equal(h.status(), "1 of 2");
  const range = h.ranges.at(-1);
  assert.equal(range.start.offset, "İ greeting ".length);
  assert.equal(range.end.offset, 3);
  h.setSource("a.b aXb [one] a.b"); h.type("a.b");
  assert.equal(h.status(), "1 of 2", "search is literal, not a regular expression");
  h.type("[one]"); assert.equal(h.status(), "1 of 1");
});

test("fallback browsers paint match rectangles without touching the user's selection", () => {
  const h = harness({ nativeHighlight: false }); h.type("slack", 2);
  assert.equal(h.status(), "1 of 3");
  assert.ok(h.state.findHighlightRange);
  assert.equal(h.state.findHighlightOverlay.children.length, 1);
  assert.equal(h.input.selectionStart, 2);
  assert.equal(h.document.activeElement, h.input);
  h.context.syncFindHighlight();
  assert.equal(h.state.findHighlightOverlay.children.length, 1);
});

test("editable/source-file search uses a paint overlay and does not overwrite editor or search selection", () => {
  const h = harness({ editable: true }); h.target.selectionStart = 5; h.target.selectionEnd = 9;
  h.type("slack", 2);
  assert.equal(h.status(), "1 of 3");
  assert.equal(h.target.selectionStart, 5);
  assert.equal(h.target.selectionEnd, 9);
  assert.equal(h.input.selectionStart, 2);
  assert.match(h.state.findHighlightOverlay.innerHTML, /<mark class="active">slack<\/mark>/);
});

test("no results, clearing, Escape and closed Cmd+G cleanly reset highlights without closing the dialog", () => {
  const h = harness(); h.type("slack"); h.type("missing");
  assert.equal(h.status(), "No results"); assert.equal(h.highlights.size, 0);
  h.type(""); assert.equal(h.status(), "Type to search");
  h.type("slack");
  assert.equal(h.document.emit("keydown", { key: "Escape" }).prevented, true);
  assert.equal(h.highlights.size, 0);
  assert.equal(h.elements.get("find-bar").classList.contains("hidden"), true);
  assert.equal(h.document.activeElement, h.target);
  assert.equal(h.state.findTarget, null);
  assert.equal(h.document.emit("keydown", { key: "g", metaKey: true }).prevented, false);
});
