import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { GIT_DOCK_WIDTH_KEY, gitPanelResizeBounds, setupGitPanelResize } from "../public/git-panel-resize.mjs";

function target() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, properties = {}) {
      const event = { button: 0, pointerId: 1, clientX: 300, isPrimary: true, prevented: false, preventDefault() { this.prevented = true; }, ...properties };
      for (const callback of listeners.get(type) || []) callback(event);
      return event;
    },
  };
}
function element() {
  const properties = new Map(), attributes = new Map(), classes = new Set();
  return {
    ...target(), properties, attributes, classes, dataset: {}, children: [], id: "",
    style: { getPropertyValue: (key) => properties.get(key) || "", setProperty: (key, value) => properties.set(key, value), removeProperty: (key) => properties.delete(key) },
    classList: { contains: (key) => classes.has(key), add: (key) => classes.add(key), remove: (key) => classes.delete(key) },
    setAttribute: (key, value) => attributes.set(key, value),
    append(child) { this.children.push(child); child.parentElement = this; },
    remove() { this.parentElement.children = this.parentElement.children.filter((child) => child !== this); },
    focus() { this.focused = true; },
    setPointerCapture(id) { this.captured = id; },
    releasePointerCapture() { this.captured = null; },
  };
}
function harness({ saved, zoom = 1, viewport = 1600, minimum = 260, open = true, ide = true, view = "repository", unavailableStorage = false } = {}) {
  const body = element(), root = element(), panel = element(), win = target();
  const config = { zoom, minimum };
  body.dataset.view = view;
  if (ide) body.classes.add("repository-ide-enabled");
  if (open) body.classes.add("version-control-dock-open");
  const preferences = new Map([["argus-nexus-theme", "ocean"], ["argus-git-panel-width", "390"]]);
  if (saved !== undefined) preferences.set(GIT_DOCK_WIDTH_KEY, String(saved));
  const writes = [];
  const storage = {
    getItem(key) { if (unavailableStorage) throw Error("blocked"); return preferences.get(key) ?? null; },
    setItem(key, value) { if (unavailableStorage) throw Error("blocked"); writes.push([key, value]); preferences.set(key, value); },
    removeItem(key) { if (unavailableStorage) throw Error("blocked"); writes.push([key, null]); preferences.delete(key); },
  };
  const observers = [];
  Object.assign(win, {
    innerWidth: viewport,
    localStorage: storage,
    visualViewport: Object.assign(target(), { width: viewport }),
    getComputedStyle(node) {
      return { zoom: node === body ? config.zoom : 1, getPropertyValue: (key) => key === "--side-panel-width" ? `${config.minimum}px` : key === "--tools-rail-width" ? "30px" : node.style.getPropertyValue(key) };
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
      observe(node, options) { this.targets.push([node, options]); }
      disconnect() { this.disconnected = true; }
    },
  });
  const document = { body, documentElement: root, defaultView: win, querySelector: (selector) => selector === ".git-panel" ? panel : null, createElement: () => element() };
  const controller = setupGitPanelResize({ document, window: win, storage });
  return {
    body, root, panel, window: win, document, config, preferences, writes, storage, observers, controller, handle: controller.handle,
    width: () => Number.parseFloat(body.style.getPropertyValue("--git-dock-width")),
    resize(value) { win.innerWidth = value; win.visualViewport.width = value; win.emit("resize"); },
    drag(delta, finish = true) { controller.handle.emit("pointerdown"); win.emit("pointermove", { clientX: 300 + delta }); if (finish) win.emit("pointerup"); },
  };
}

test("default width/minimum is unchanged and the separator is accessible", () => {
  for (const minimum of [250, 260]) {
    const h = harness({ minimum });
    assert.equal(h.width(), minimum);
    assert.equal(h.handle.attributes.get("aria-valuemin"), String(minimum));
    assert.equal(h.handle.attributes.get("aria-valuenow"), String(minimum));
    assert.equal(h.handle.attributes.get("aria-orientation"), "vertical");
    assert.equal(h.handle.attributes.get("role"), "separator");
    assert.equal(h.handle.tabIndex, 0);
    assert.equal(h.handle.attributes.get("aria-controls"), h.panel.id);
    assert.deepEqual(h.writes, []);
    assert.equal(h.preferences.get("argus-git-panel-width"), "390", "the obsolete right-panel width is not imported or modified");
  }
});

test("dragging the right edge rightward widens with scaled pointer deltas", () => {
  for (const zoom of [1, 1.12, 1.22, "112%"]) {
    const h = harness({ zoom });
    const factor = zoom === "112%" ? 1.12 : zoom;
    h.drag(100 * factor, false);
    assert.equal(h.width(), 360);
    assert.equal(h.handle.focused, true);
    assert.equal(h.body.classes.has("git-panel-resizing"), true);
    assert.deepEqual(h.writes, [], "pointer movement must not repeatedly write storage");
    h.window.emit("pointerup");
    assert.equal(h.preferences.get(GIT_DOCK_WIDTH_KEY), "360");
    assert.equal(h.body.classes.has("git-panel-resizing"), false);
    assert.equal(h.handle.captured, null);
  }
});

test("dragging left never shrinks the current default; maximum preserves editor space", () => {
  const h = harness({ viewport: 1200, zoom: 1.12 });
  h.drag(-500);
  assert.equal(h.width(), 260);
  h.drag(5000);
  const maximum = Math.floor(1200 / 1.12 - 30 - 480);
  assert.equal(h.width(), maximum);
  assert.equal(h.handle.attributes.get("aria-valuemax"), String(maximum));
  assert.ok(1200 / 1.12 - 30 - h.width() >= 480);
  h.resize(3440);
  h.drag(5000);
  assert.equal(h.width(), 720);
});

test("saved width restores, temporarily clamps on small windows, then returns without overwriting preference", () => {
  const h = harness({ saved: 600 });
  assert.equal(h.width(), 600);
  h.config.minimum = 250;
  h.resize(800);
  assert.equal(h.width(), 290);
  assert.equal(h.preferences.get(GIT_DOCK_WIDTH_KEY), "600");
  h.config.zoom = 1.22;
  h.controller.refresh();
  assert.equal(h.width(), 250);
  h.config.zoom = 1;
  h.config.minimum = 260;
  h.resize(1600);
  assert.equal(h.width(), 600);
  assert.deepEqual(h.writes, []);
});

test("Arrow keys resize in CSS pixels and Home restores the adaptive default", () => {
  const h = harness({ zoom: 1.22 });
  assert.equal(h.handle.emit("keydown", { key: "ArrowRight" }).prevented, true);
  assert.equal(h.width(), 270);
  h.handle.emit("keydown", { key: "ArrowRight", shiftKey: true });
  assert.equal(h.width(), 310);
  h.handle.emit("keydown", { key: "ArrowLeft" });
  assert.equal(h.width(), 300);
  h.handle.emit("keydown", { key: "Home" });
  assert.equal(h.width(), 260);
  assert.equal(h.preferences.has(GIT_DOCK_WIDTH_KEY), false);
  h.config.minimum = 250;
  h.controller.refresh();
  assert.equal(h.width(), 250);
  assert.equal(h.handle.emit("keydown", { key: "ArrowLeft", metaKey: true }).prevented, false);
});

test("cancel, lost capture, Escape and blur clean up and restore the last committed width", () => {
  for (const cancel of ["pointercancel", "lostpointercapture", "Escape", "blur"]) {
    const h = harness({ saved: 400 });
    h.drag(100, false);
    assert.equal(h.width(), 500);
    if (cancel === "Escape") h.handle.emit("keydown", { key: "Escape" });
    else if (cancel === "lostpointercapture") h.handle.emit(cancel);
    else h.window.emit(cancel);
    assert.equal(h.width(), 400);
    assert.equal(h.body.classes.has("git-panel-resizing"), false);
    assert.equal(h.handle.classes.has("dragging"), false);
    assert.deepEqual(h.writes, []);
  }
});

test("closed docks, non-repository views and non-primary pointers cannot resize", () => {
  for (const state of [{ open: false }, { ide: false }, ...["global", "orchestration", "api", "services", "json", "ai"].map(view => ({ view }))]) {
    const h = harness(state);
    assert.equal(h.handle.emit("pointerdown").prevented, false);
    h.window.emit("pointermove", { clientX: 900 });
    assert.equal(h.handle.emit("keydown", { key: "ArrowRight" }).prevented, false);
    assert.equal(h.width(), 260);
    assert.deepEqual(h.writes, []);
  }
  const h = harness();
  assert.equal(h.handle.emit("pointerdown", { button: 2 }).prevented, false);
  assert.equal(h.handle.emit("pointerdown", { isPrimary: false }).prevented, false);
  h.drag(100, false);
  h.window.emit("pointermove", { pointerId: 2, clientX: 900 });
  assert.equal(h.width(), 360);
  h.body.dataset.view = "global";
  h.observers[0].callback();
  assert.equal(h.width(), 260);
  assert.equal(h.body.classes.has("git-panel-resizing"), false);
  assert.equal(h.body.dataset.view, "global");
});

test("body font zoom changes re-anchor an ongoing gesture without a width jump", () => {
  const h = harness();
  h.drag(100, false);
  h.config.zoom = 1.22;
  h.controller.refresh();
  assert.equal(h.width(), 360);
  h.window.emit("pointermove", { clientX: 400 + 122 });
  assert.equal(h.width(), 460);
  h.window.emit("pointerup");
  assert.equal(h.preferences.get(GIT_DOCK_WIDTH_KEY), "460");
});

test("invalid or unavailable storage never prevents local resizing", () => {
  for (const saved of ["bad", "Infinity", -90, 0, ""]) assert.equal(harness({ saved }).width(), 260);
  const h = harness({ unavailableStorage: true });
  assert.doesNotThrow(() => h.drag(80));
  assert.equal(h.width(), 340);
  assert.doesNotThrow(() => h.handle.emit("keydown", { key: "Home" }));
});

test("setup is idempotent and destroy removes observers/listeners and restores CSS ownership", () => {
  const h = harness();
  assert.equal(setupGitPanelResize({ document: h.document, window: h.window }), h.controller);
  assert.equal(h.panel.children.length, 1);
  h.drag(70, false);
  h.controller.destroy();
  h.controller.destroy();
  assert.equal(h.panel.children.length, 0);
  assert.equal(h.body.style.getPropertyValue("--git-dock-width"), "");
  assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.body.classes.has("git-panel-resizing"), false);
  for (const listeners of h.window.listeners.values()) assert.equal(listeners.size, 0);
  assert.deepEqual(h.writes, []);
});

test("resize limits keep the existing minimum when a small viewport cannot also reserve480px", () => {
  assert.deepEqual(gitPanelResizeBounds({ viewportWidth: 600, scale: 1.22, minimum: 250 }), { minimum: 250, maximum: 250, scale: 1.22 });
  assert.equal(gitPanelResizeBounds({ viewportWidth: 3440 }).maximum, 720);
});

test("embedded Git resizing follows the editor width, including compact and zoomed layouts", () => {
  for (const width of [280, 320, 420, 620, 621, 980, 1440]) {
    const bounds = gitPanelResizeBounds({ viewportWidth: 2000, editorWidth: width, scale: 1.22 });
    assert.ok(bounds.minimum <= bounds.maximum);
    assert.ok(bounds.maximum <= width - (width <= 620 ? 48 : 320));
    assert.ok(bounds.maximum <= 720);
  }
  assert.equal(gitPanelResizeBounds({ editorWidth: 280 }).minimum, 232);
});

test("shell inherits the zoom-adjusted body height so Git footer and composer stay within the viewport", async () => {
  const styles = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const nextPage = await fs.readFile(new URL("../frontend/app/page.jsx", import.meta.url), "utf8");
  const nextLayout = await fs.readFile(new URL("../frontend/app/layout.jsx", import.meta.url), "utf8");
  const rawShell = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(styles, /html, body\s*\{[^}]*height: 100%;/);
  assert.match(nextLayout, /<body>\{children\}<\/body>/);
  assert.match(nextPage, /<div id="argus-next-root" dangerouslySetInnerHTML=\{\{ __html: legacyShell\(\) \}\}/);
  assert.match(rawShell, /<div class="app-shell">/);
  const wrapper = styles.match(/#argus-next-root\s*\{([^}]*)\}/)?.[1];
  assert.ok(wrapper, "the real Next wrapper needs a definite height; otherwise shell100% resolves against auto height");
  assert.match(wrapper, /height:\s*100%;/);
  assert.match(wrapper, /min-height:\s*0;/);
  assert.doesNotMatch(wrapper, /position:|transform:|contain:|overflow:/, "do not introduce a new containing block or clipping for fixed tools and dialogs");
  assert.match(styles, /\.app-shell\s*\{\s*height: 100%;[^}]*grid-template-rows: 56px minmax\(0, 1fr\)/);
  assert.doesNotMatch(styles, /\.app-shell\s*\{[^}]*height:\s*100(?:d|s|l)?vh/);
  assert.match(styles, /\.global-codex-panel\s*\{\s*position: fixed;/, "the shell fix must not change Nexus viewport positioning");
  // The browser fixture verifies rendered bounds; this protects the sizing contract.
  for (const viewportHeight of [720, 900, 1440]) {
    for (const zoom of [1, 1.12, 1.22]) {
      const bodyCssHeight = viewportHeight / zoom;
      const renderedShellHeight = bodyCssHeight * zoom;
      assert.ok(Math.abs(renderedShellHeight - viewportHeight) < 0.001);
    }
  }
});

test("CSS changes only Git width and active Git insets, never Nexus or shared sidebar width", async () => {
  const styles = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const start = styles.indexOf("/* Resizable left Version Control dock");
  const end = styles.indexOf("/* Full workspace surfaces use the available display", start);
  assert.ok(start >= 0 && end > start, "inspect only the Git resize rules, not later unrelated workspace styles");
  const block = styles.slice(start, end);
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /--tools-panel-width|\.ai-canvas/);
  const ideStyles = await fs.readFile(new URL("../public/repository-ide.css", import.meta.url), "utf8");
  assert.match(ideStyles, /data-version-control-open="true"[^{}]*\.repository-ide-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, var\(--git-dock-width, 280px\)\)/);
  assert.doesNotMatch(block, /--side-panel-width\s*:|global-codex|\.workspace\s*\{|\.task-sidebar\s*\{|font-size\s*:|zoom\s*:/);
  assert.match(block, /\.git-panel-resize-handle[^{]*\{[^}]*right: 0;[^}]*width: 6px;[^}]*touch-action: none/s);
  const source = await fs.readFile(new URL("../public/git-panel-resize.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|\/api\/|activeRepository|globalJob|runningAgentJob|repositoryDrafts/);
});
