import test from "node:test";
import assert from "node:assert/strict";
import { pdfPageViewport, renderPdfDocument } from "../public/pdf-preview.js";

class Element {
  constructor(document, kind) { this.ownerDocument = document; this.kind = kind; this.children = []; this.style = {}; this.events = {}; this.clientWidth = 900; }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); }
  addEventListener(name, callback) { this.events[name] = callback; }
  click() { this.events.click?.(); }
  getContext() { return {}; }
}
function harness() {
  const document = { location: { origin: "http://127.0.0.1:4173" }, defaultView: { setTimeout, clearTimeout, devicePixelRatio: 2 }, createElement(kind) { return new Element(this, kind); } };
  const container = new Element(document, "container");
  const options = [], rendered = [], fetched = [];
  let destroyed = 0;
  const library = { AnnotationMode: { DISABLE: 0 }, getDocument(input) {
    options.push(input);
    return { destroy: async () => { destroyed++; }, promise: Promise.resolve({ numPages: 2, getPage: async (number) => ({ getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render: (configuration) => { rendered.push({ number, configuration }); return { promise: Promise.resolve(), cancel() {} }; }, cleanup() {} }) }) };
  } };
  const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
  const fetchFile = async (...args) => { fetched.push(args); return { ok: true, headers: new Headers({ "content-type": "application/pdf", "content-length": String(bytes.length) }), arrayBuffer: async () => bytes.buffer }; };
  return { document, container, options, rendered, fetched, library, fetchFile, destroyed: () => destroyed };
}
async function settle() { await new Promise((resolve) => setImmediate(resolve)); }

test("PDF pages are canvas-only with disabled script evaluation and annotations", async () => {
  const h = harness();
  const close = await renderPdfDocument(h.container, "/api/source-reference/content?target=plan.pdf", { loadLibrary: async () => h.library, fetchFile: h.fetchFile });
  assert.equal(h.options[0].isEvalSupported, false);
  assert.equal(h.options[0].enableXfa, false);
  assert(h.options[0].data instanceof Uint8Array);
  assert.equal(h.options[0].url, undefined);
  assert.equal(h.rendered[0].configuration.annotationMode, 0);
  assert.equal(h.fetched[0][1].redirect, "error");
  assert.equal(h.fetched[0][1].credentials, "same-origin");
  assert.equal(h.container.children[1].children[0].kind, "canvas");
  close(); close();
  assert.equal(h.destroyed(), 1);
  assert.equal(h.container.children.length, 0);
});

test("PDF page navigation renders one page at a time and enforces bounds", async () => {
  const h = harness();
  const close = await renderPdfDocument(h.container, "/api/source-reference/content?target=plan.pdf", { loadLibrary: async () => h.library, fetchFile: h.fetchFile });
  const [previous, status, next] = h.container.children[0].children;
  assert.equal(previous.disabled, true); assert.equal(next.disabled, false);
  next.click(); next.click();
  await settle();
  assert.deepEqual(h.rendered.map((page) => page.number), [1, 2]);
  assert.equal(status.textContent, "Page 2 of 2");
  assert.equal(previous.disabled, false); assert.equal(next.disabled, true);
  previous.click(); await settle();
  assert.deepEqual(h.rendered.map((page) => page.number), [1, 2, 1]);
  close();
});

test("closing a PDF releases rendering buffers and loading worker", async () => {
  const h = harness();
  const controller = new AbortController();
  const close = await renderPdfDocument(h.container, "/api/source-reference/content?target=plan.pdf", { signal: controller.signal, loadLibrary: async () => h.library, fetchFile: h.fetchFile });
  const canvas = h.container.children[1].children[0];
  controller.abort(); close();
  assert.equal(h.destroyed(), 1);
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  assert.equal(h.container.children.length, 0);
});

test("external endpoints, non-PDF responses and oversized pages fail safely", async () => {
  const h = harness();
  await assert.rejects(renderPdfDocument(h.container, "https://evil.test/api/source-reference/content", { loadLibrary: async () => h.library, fetchFile: h.fetchFile }), /Invalid local/);
  assert.equal(h.fetched.length, 0);
  await assert.rejects(renderPdfDocument(h.container, "/api/source-reference/content?target=plan.pdf", { loadLibrary: async () => h.library, fetchFile: async () => ({ ok: true, headers: new Headers({ "content-type": "text/html" }) }) }), /not a PDF/);
  assert.equal(h.options.length, 0);
  assert.equal(h.container.children.length, 0);
  assert.throws(() => pdfPageViewport({ getViewport: () => ({ width: 1, height: 1e20 }) }, 900), /unsupported proportions/);
  assert.throws(() => pdfPageViewport({ getViewport: () => ({ width: NaN, height: 1 }) }, 900), /invalid page dimensions/);
});

test("PDF backing canvases stay bounded on high-DPI large pages", () => {
  const result = pdfPageViewport({ getViewport: ({ scale }) => ({ width: 10000 * scale, height: 20000 * scale }) }, 5000, 6);
  assert(result.viewport.width <= 1600);
  assert(result.viewport.width * result.viewport.height * result.ratio ** 2 <= 8_000_001);
});
