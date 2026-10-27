import test from "node:test";
import assert from "node:assert/strict";
import { attachmentCardMarkup, attachmentPresentation } from "../public/context-attachment-view.mjs";
import { attachmentContentUrl, localPreviewEndpoint } from "../public/local-preview-url.mjs";
import { wordPreviewEndpoint } from "../public/word-preview.js";
import { renderAttachmentMedia } from "../public/context-attachment-viewer.mjs";

const origin = "http://127.0.0.1:4173", id = "11111111-2222-3333-4444-555555555555";
const url = `/api/context/${id}/content`;

test("attachment cards escape every label and ID, with separate named native preview and remove buttons", () => {
  const item = { id: 'id" onclick="bad()', title: '<img src=x onerror="bad()">.png', size: 20_000, kind: "image" };
  const markup = attachmentCardMarkup(item, { removable: true, scope: 'global" onfocus="bad()' });
  assert.doesNotMatch(markup, /<img|\s(?:onclick|onerror|onfocus)="/);
  assert.match(markup, /&lt;img/);
  assert.equal((markup.match(/<button /g) || []).length, 2);
  assert.ok(markup.indexOf("</button>") < markup.indexOf('class="attachment-remove"'));
  assert.match(markup, /data-preview-context/); assert.match(markup, /aria-label="Preview /);
  assert.match(markup, /aria-label="Remove /); assert.match(markup, /20 KB/);
  assert.doesNotMatch(attachmentCardMarkup(item), /data-remove-context/);
});

test("files retain their actual names and unnamed pasted inputs are recognisable", () => {
  assert.equal(attachmentPresentation({ title: "日志 QA.env", kind: "file" }).name, "日志 QA.env");
  assert.equal(attachmentPresentation({ kind: "paste", size: 19000 }).description, "Pasted text · 19 KB");
  assert.equal(attachmentPresentation({ kind: "paste" }).name, "Pasted text");
  assert.equal(attachmentPresentation({ kind: "image" }).name, "Pasted image");
  assert.equal(attachmentPresentation({ mimeType: "video/mp4", title: "demo.mp4" }).kind, "video");
});

test("attachment URLs are exact same-origin saved-ID capabilities, not file paths or arbitrary APIs", () => {
  assert.equal(attachmentContentUrl(url, origin, id), url);
  assert.equal(attachmentContentUrl(url + "?download=true", origin, id, { download: true }), url + "?download=true");
  assert.equal(wordPreviewEndpoint(url + "?preview=docx", origin).pathname, url);
  assert.equal(localPreviewEndpoint("/api/source-reference/content?target=a.pdf", origin).pathname, "/api/source-reference/content");
  for (const candidate of [undefined, "https://evil.test" + url, "//evil.test" + url, "file:///tmp/a", "data:text/html,x", "/api/settings", "/api/context/a/content", url + "#x", url + "\n", url + "?target=/etc/passwd", url + "?preview=html", url + "?download=true", "/api/source-reference/content"]) assert.equal(attachmentContentUrl(candidate, origin, id), null, String(candidate));
  assert.equal(attachmentContentUrl(url, origin, "66666666-2222-3333-4444-555555555555"), null);
  assert.equal(attachmentContentUrl(url, origin, id, { download: true }), null);
});

function mediaHarness() {
  const created = [], revoked = [], requests = [];
  const document = { location: { origin }, defaultView: { setTimeout, clearTimeout, URL: { createObjectURL: () => "blob:fixture", revokeObjectURL: value => revoked.push(value) } }, createElement(type) {
    const element = { type, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute() {}, removeAttribute() {}, remove() { this.removed = true; }, pause() { this.paused = true; }, load() {}, set src(value) { this.source = value; queueMicrotask(() => this.listeners[type === "img" ? "load" : "loadedmetadata"]?.()); } };
    created.push(element); return element;
  } };
  const container = { ownerDocument: document, append() {} };
  const fetchFile = async (...args) => { requests.push(args); return new Response(new Blob(["fixture"], { type: "image/png" }), { headers: { "content-type": "image/png" } }); };
  return { container, created, revoked, requests, fetchFile };
}

test("media preview uses bounded same-origin fetch without redirects and releases its blob on close", async () => {
  const h = mediaHarness(), controller = new AbortController();
  const cleanup = await renderAttachmentMedia(h.container, url, { type: "image", mimeType: "image/png", name: "Pasted image.png", signal: controller.signal, fetchFile: h.fetchFile });
  assert.equal(h.requests[0][0], origin + url);
  assert.equal(h.requests[0][1].redirect, "error"); assert.equal(h.requests[0][1].credentials, "same-origin");
  assert.equal(h.created[0].alt, "Pasted image.png"); assert.equal(h.created[0].source, "blob:fixture");
  controller.abort(); cleanup();
  assert.deepEqual(h.revoked, ["blob:fixture"]); assert.equal(h.created[0].removed, true);
});

test("HTML/SVG, off-origin, mismatched MIME and oversized media never become visible elements", async () => {
  const h = mediaHarness();
  for (const options of [{ type: "image", mimeType: "image/svg+xml" }, { type: "image", mimeType: "text/html" }]) await assert.rejects(renderAttachmentMedia(h.container, url, { ...options, fetchFile: h.fetchFile }));
  await assert.rejects(renderAttachmentMedia(h.container, "https://evil.test" + url, { type: "image", mimeType: "image/png", fetchFile: h.fetchFile }));
  await assert.rejects(renderAttachmentMedia(h.container, url, { type: "image", mimeType: "image/png", fetchFile: async () => new Response("<html>", { headers: { "content-type": "text/html" } }) }));
  await assert.rejects(renderAttachmentMedia(h.container, url, { type: "image", mimeType: "image/png", fetchFile: async () => new Response("image", { headers: { "content-type": "image/png", "content-length": "22000000" } }) }));
  assert.equal(h.created.length, 0); assert.equal(h.requests.length, 0);
});

test("cancelled media fetch never creates an object URL or inserts late bytes", async () => {
  const h = mediaHarness(), controller = new AbortController(); let resolve;
  const pending = renderAttachmentMedia(h.container, url, { type: "image", mimeType: "image/png", signal: controller.signal, fetchFile: () => new Promise(done => { resolve = done; }) });
  controller.abort(); resolve(new Response("image", { headers: { "content-type": "image/png" } }));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.created.length, 0); assert.equal(h.revoked.length, 0);
});
