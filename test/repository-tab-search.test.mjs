import test from "node:test";
import assert from "node:assert/strict";
import { createRepositoryTabSearch } from "../public/repository-tab-search.mjs";

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, detail = {}) { const event = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...detail }; for (const fn of this.listeners.get(name) || []) fn(event); return event; }
}
class Element extends Target {
  constructor(document, tag = "div") { super(); this.document = document; this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.dataset = {}; this.style = {}; this.textContent = ""; this.className = ""; this.value = ""; this.hidden = false; this.disabled = false; }
  get offsetWidth() { return Math.min(320, parseFloat(this.style.maxWidth) || Infinity); }
  set innerHTML(_) { throw Error("Repository metadata must not become HTML"); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  replaceChildren(...children) { if (this.contains(this.document.activeElement)) this.document.activeElement = this.document.body; for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  focus() { if (!this.disabled) this.document.activeElement = this; }
  click() { if (!this.disabled) this.emit("click"); }
  matches(selector) { return selector === ":popover-open" && Boolean(this.open); }
  showPopover() { this.emit("beforetoggle", { oldState: "closed", newState: "open" }); this.open = true; this.emit("toggle", { oldState: "closed", newState: "open" }); }
  hidePopover() { this.emit("beforetoggle", { oldState: "open", newState: "closed" }); this.open = false; this.emit("toggle", { oldState: "open", newState: "closed" }); }
  getBoundingClientRect() { if (this.anchor) return this.anchor; const scale = this.document.scale || 1, width = Math.min(this.offsetWidth, parseFloat(this.style.maxWidth) || Infinity) * scale, height = Math.min(240, parseFloat(this.style.maxHeight) || Infinity) * scale; return { left: 0, right: width, top: 0, bottom: height, width, height }; }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness({ onSelect = async () => true, onError, repositories, groups } = {}) {
  const document = new Target(), win = new Target(), observers = [], errors = [], selections = [];
  const nodes = {};
  document.createElement = tag => new Element(document, tag); document.body = document.createElement("body"); document.activeElement = document.body;
  document.documentElement = { clientWidth: 900, clientHeight: 600 };
  document.querySelector = selector => nodes[selector.slice("#repository-tab-search-".length)] || null;
  class Observer { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  win.ResizeObserver = win.MutationObserver = Observer; document.defaultView = win;
  for (const suffix of ["toggle", "popover", "input", "results", "status", "close"]) nodes[suffix] = document.createElement(["toggle", "close"].includes(suffix) ? "button" : suffix === "input" ? "input" : "div");
  nodes.toggle.anchor = { left: 790, right: 830, bottom: 44, width: 40, height: 32 };
  nodes.popover.append(nodes.input, nodes.results, nodes.status, nodes.close); document.body.append(nodes.toggle, nodes.popover);
  let values = repositories || [{ id: "alpha", name: "Alpha API", path: "/work/services/orders" }, { id: "beta", name: "Beta UI", path: "/work/web" }, { id: "gamma", name: "Gamma Worker", path: "/work/jobs" }];
  let groupValues = groups || [{ id: "platform", name: "Platform tools", repositoryIds: ["alpha", "gamma"], collapsed: true }], active = "beta";
  const controller = createRepositoryTabSearch({ document, getRepositories: () => values, getGroups: () => groupValues, getActiveRepositoryId: () => active,
    onSelect: id => { selections.push(id); return onSelect(id); }, onError: error => { errors.push(error); return onError?.(error); } });
  const key = (target, key, extra = {}) => nodes.popover.emit("keydown", { target, key, ...extra });
  const search = value => { nodes.input.value = value; nodes.input.emit("input"); };
  const rows = () => nodes.results.children.filter(row => row.tagName === "BUTTON");
  const text = node => [node.textContent, ...node.children.map(text)].join(" ");
  return { controller, document, nodes, observers, errors, selections, key, search, rows, text, open: () => nodes.popover.showPopover(), repositories: value => { values = value; }, groups: value => { groupValues = value; }, active: value => { active = value; } };
}

test("local repository search is inert until opened and includes collapsed groups in supplied order", () => {
  const h = harness(); h.controller.refresh(); assert.equal(h.rows().length, 0); assert.deepEqual(h.selections, []);
  h.open(); assert.equal(h.document.activeElement, h.nodes.input); assert.equal(h.nodes.toggle.getAttribute("aria-expanded"), "true");
  assert.deepEqual(h.rows().map(row => row.dataset.repositoryId), ["alpha", "beta", "gamma"]);
  assert.match(h.text(h.rows()[0]), /Platform tools · tabs hidden/);
  assert.equal(h.rows()[1].getAttribute("aria-current"), "page"); assert.equal(h.rows()[0].getAttribute("aria-current"), "false");
  h.search("ORDERS platform API"); assert.deepEqual(h.rows().map(row => row.dataset.repositoryId), ["alpha"]);
  h.search("TOOLS gamma"); assert.deepEqual(h.rows().map(row => row.dataset.repositoryId), ["gamma"]);
  h.search("unknown"); assert.equal(h.rows().length, 0); assert.match(h.text(h.nodes.results), /No repositories match/); assert.equal(h.nodes.status.textContent, "0 repositories found.");
  h.controller.dispose();
});

test("malicious metadata remains plain DOM text and duplicate or invalid identities are ignored", () => {
  const name = '<img src=x onerror="alert(1)">', path = "/work/<script>danger</script>";
  const h = harness({ repositories: [{ id: "evil", name, path }, { id: "evil", name: "duplicate" }, {}, null, { id: "", name: "empty" }], groups: [{ name: "<iframe>", collapsed: true, repositoryIds: ["evil"] }] });
  h.open(); assert.equal(h.rows().length, 1);
  const copy = h.rows()[0].children[0]; assert.equal(copy.className, "repository-tab-search-copy");
  assert.equal(copy.children[0].textContent, name); assert.equal(copy.children[1].textContent, path); assert.equal(copy.children[2].textContent, "<iframe> · tabs hidden");
  assert.deepEqual(copy.children.map(node => node.tagName), ["STRONG", "SMALL", "EM"]); h.controller.dispose();
});

test("empty workspace explains onboarding; fresh open resets the previous query", () => {
  const h = harness({ repositories: [] }); h.open(); assert.match(h.text(h.nodes.results), /No repositories connected.*Tab tools/);
  h.search("old query"); h.controller.close(); h.repositories([{ id: "new", name: "New repo" }]); h.open();
  assert.equal(h.nodes.input.value, ""); assert.deepEqual(h.rows().map(row => row.dataset.repositoryId), ["new"]); h.controller.dispose();
});

test("keyboard uses native input editing, navigates rows, and Escape restores trigger focus", async () => {
  const h = harness(); h.open(); const input = h.nodes.input;
  assert.equal(h.key(input, "Home").prevented, undefined); assert.equal(h.key(input, "End").prevented, undefined);
  assert.equal(h.key(input, "ArrowDown", { shiftKey: true }).prevented, undefined);
  assert.equal(h.key(input, "ArrowDown").prevented, true); assert.equal(h.document.activeElement, h.rows()[0]);
  h.key(h.rows()[0], "ArrowUp"); assert.equal(h.document.activeElement, h.rows()[2]);
  h.key(h.rows()[2], "ArrowDown"); assert.equal(h.document.activeElement, h.rows()[0]);
  h.key(h.rows()[0], "End"); assert.equal(h.document.activeElement, h.rows()[2]);
  h.key(h.rows()[2], "Home"); assert.equal(h.document.activeElement, h.rows()[0]);
  input.focus(); h.key(input, "ArrowUp"); assert.equal(h.document.activeElement, h.rows()[2]);
  assert.equal(h.key(h.rows()[2], "Enter").prevented, undefined, "native result button Enter dispatches its click exactly once");
  h.rows()[2].click(); await flush(); assert.deepEqual(h.selections, ["gamma"]); assert.equal(h.nodes.popover.open, false);
  h.open(); const event = h.key(input, "Escape"); assert.equal(event.prevented, true); assert.equal(event.stopped, true); assert.equal(h.nodes.popover.open, false); assert.equal(h.document.activeElement, h.nodes.toggle);
  h.controller.dispose();
});

test("input Enter selects first match and IME composition never submits", async () => {
  const h = harness(); h.open(); h.search("beta");
  h.key(h.nodes.input, "Enter", { isComposing: true }); h.key(h.nodes.input, "Enter", { keyCode: 229 }); assert.deepEqual(h.selections, []);
  h.key(h.nodes.input, "Enter"); await flush(); assert.deepEqual(h.selections, ["beta"]); assert.equal(h.nodes.popover.open, false); h.controller.dispose();
});

test("selection is single-flight and cancellation keeps query and panel available", async () => {
  const pending = deferred(), h = harness({ onSelect: () => pending.promise }); h.open(); h.search("API");
  h.key(h.nodes.input, "Enter"); h.key(h.nodes.input, "Enter"); h.rows()[0].click();
  assert.deepEqual(h.selections, ["alpha"]); assert.equal(h.nodes.results.getAttribute("aria-busy"), "true"); assert.equal(h.rows()[0].disabled, true);
  pending.resolve(false); await flush(); assert.equal(h.nodes.popover.open, true); assert.equal(h.nodes.input.value, "API"); assert.equal(h.rows()[0].disabled, false);
  assert.match(h.nodes.status.textContent, /cancelled/); h.controller.dispose();
});

test("selection failure is reported and can retry without closing or losing the filter", async () => {
  let attempt = 0; const error = Error("Selection failed");
  const h = harness({ onSelect: async () => { if (!attempt++) throw error; return true; }, onError() { throw Error("Reporter failed"); } });
  h.open(); h.search("beta"); h.key(h.nodes.input, "Enter"); await flush();
  assert.equal(h.nodes.popover.open, true); assert.equal(h.nodes.input.value, "beta"); assert.deepEqual(h.errors, [error]); assert.match(h.nodes.status.textContent, /Could not open/);
  h.key(h.nodes.input, "Enter"); await flush(); assert.equal(h.nodes.popover.open, false); assert.deepEqual(h.selections, ["beta", "beta"]); h.controller.dispose();
});

test("removed repositories cannot be activated even through a stale result button", async () => {
  const h = harness(); h.open(); const removed = h.rows()[0];
  h.repositories([{ id: "beta", name: "Remaining" }]); removed.click(); await flush();
  assert.deepEqual(h.selections, []); assert.equal(h.nodes.popover.open, true); assert.deepEqual(h.rows().map(row => row.dataset.repositoryId), ["beta"]); h.controller.dispose();
});

test("refresh preserves input and row focus; removed focused rows safely return to input", () => {
  const h = harness(); h.open(); const row = h.rows()[1]; row.focus();
  h.controller.refresh(); assert.equal(h.rows()[1], row); assert.equal(h.document.activeElement, row);
  h.repositories([{ id: "beta", name: "Renamed" }, { id: "alpha", name: "Alpha" }]); h.controller.refresh();
  assert.equal(h.rows()[0], row); assert.equal(h.document.activeElement, row); assert.match(h.text(row), /Renamed/);
  h.nodes.input.focus(); h.active("alpha"); h.controller.refresh(); assert.equal(h.document.activeElement, h.nodes.input); assert.equal(h.rows()[1].getAttribute("aria-current"), "page");
  row.focus(); h.repositories([{ id: "alpha", name: "Alpha" }]); h.controller.refresh(); assert.equal(h.document.activeElement, h.nodes.input);
  h.nodes.close.focus(); h.controller.refresh(); assert.equal(h.document.activeElement, h.nodes.close); h.controller.dispose();
});

test("native light-dismiss does not steal outside focus; explicit close returns to toggle", () => {
  const h = harness(); h.open(); const outside = h.document.createElement("button"); h.document.body.append(outside); outside.focus();
  h.nodes.popover.hidePopover(); assert.equal(h.document.activeElement, outside); assert.equal(h.nodes.toggle.getAttribute("aria-expanded"), "false");
  h.open(); h.nodes.close.click(); assert.equal(h.document.activeElement, h.nodes.toggle); h.controller.dispose();
});

test("late selection cannot close a reopened search or resurrect disposed handlers", async () => {
  const pending = deferred(), h = harness({ onSelect: () => pending.promise }); h.open(); h.key(h.nodes.input, "Enter");
  h.controller.close(); h.open(); h.search("beta"); pending.resolve(true); await flush();
  assert.equal(h.nodes.popover.open, true); assert.equal(h.nodes.input.value, "beta"); assert.equal(h.rows()[0].disabled, false);
  h.controller.dispose(); h.controller.dispose(); assert.equal(h.nodes.popover.open, false); assert.ok(h.observers.every(observer => observer.disconnected));
  h.open(); h.search("alpha"); h.key(h.nodes.input, "Enter"); await flush(); assert.deepEqual(h.selections, ["alpha"]);
});

test("position stays clamped under body zoom and updates on viewport changes", () => {
  const h = harness(); h.document.scale = 1.5; h.document.documentElement = { clientWidth: 380, clientHeight: 320 }; h.nodes.toggle.anchor = { right: 360, bottom: 48 }; h.open();
  const panel = h.nodes.popover, scale = h.document.scale, bounds = panel.getBoundingClientRect();
  assert.ok(parseFloat(panel.style.right) * scale >= 12); assert.ok(parseFloat(panel.style.right) * scale + bounds.width <= 380 - 12 + .01);
  assert.ok(parseFloat(panel.style.top) * scale >= 12); assert.ok(parseFloat(panel.style.top) * scale + bounds.height <= 320 - 12 + .01);
  h.document.documentElement.clientWidth = 280; h.document.defaultView.emit("resize"); assert.equal(panel.style.maxWidth, `${256 / 1.5}px`);
  h.document.documentElement.clientHeight = 1600; h.document.defaultView.emit("resize"); assert.equal(panel.style.maxHeight, "480px", "large windows retain the compact design cap");
  h.document.scale = .8; h.document.defaultView.emit("resize"); assert.equal(panel.style.maxHeight, "480px", "zooming out does not expand the picker beyond its design cap");
  h.controller.dispose();
});
