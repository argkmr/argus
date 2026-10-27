import test from "node:test";
import assert from "node:assert/strict";
import { initializeSourceReferences } from "../public/source-reference-viewer.js";

class Element {
  constructor(owner, kind = "div") {
    this.ownerDocument = owner;
    this.kind = kind;
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.hidden = false;
    this.isConnected = true;
    this.textContent = "";
    this.value = "";
    this.scrollTop = this.scrollLeft = 0;
    this.clientHeight = 220;
    this.classList = { contains: () => false };
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  focus() { this.ownerDocument.activeElement = this; }
  show() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    // The native HTMLDialogElement close event is queued, not synchronous.
    this.ownerDocument.nativeCloseEvents.push(() => this.dispatch("close"));
  }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  closest(selector) { return selector === "[data-source-reference]" && this.dataset.sourceReference ? this : null; }
  set innerHTML(markup) {
    this.assignedHtml = markup;
    if (this.kind !== "dialog") return;
    this.parts = new Map();
    for (const selector of ["h2", "[data-source-context]", "[data-source-notice]", "[data-source-body]", "textarea", "pre", "[data-source-close]", "[data-source-download]", "[data-document-preview]", "[data-source-toggle]", "[data-source-folder]", "[data-folder-name]", "[data-folder-path]", "[data-folder-reveal]", "[data-folder-copy]", "[data-folder-copy-status]"]) {
      this.parts.set(selector, new Element(this.ownerDocument, selector === "textarea" ? "textarea" : "div"));
    }
    this.parts.get("textarea").readOnly = /<textarea[^>]*\breadonly(?:\s|>)/.test(markup);
  }
  querySelector(selector) { return this.parts?.get(selector) || null; }
}

function harness({ useShowDialog = true, renderPdf, renderWord, renderMarkdown, revealReference, copyText, getEditorTarget, preferredRepositoryId = () => "repo-a" } = {}) {
  const document = {
    location: { origin: "http://127.0.0.1:4173" },
    nativeCloseEvents: [],
    defaultView: { getComputedStyle: () => ({ lineHeight: "22px" }) },
    listeners: new Map(),
    createElement(kind) { return new Element(this, kind); },
    addEventListener(type, callback) { this.listeners.set(type, callback); },
    querySelector(selector) {
      if (selector === "#find-bar") return null;
      if (selector === "dialog[open]") return this.body.children.find((element) => element.kind === "dialog" && element.open) || null;
      if (selector.startsWith("#")) return this.body.children.find((element) => element.id === selector.slice(1)) || null;
      return null;
    },
    click(element) { this.listeners.get("click")({ target: element, preventDefault() {} }); },
    flushCloseEvents() { for (const callback of this.nativeCloseEvents.splice(0)) callback(); },
  };
  document.body = new Element(document, "body");
  const calls = [];
  const pending = [];
  let closeCount = 0;
  initializeSourceReferences({
    document,
    loadReference: (target, repositoryId) => {
      calls.push({ target, repositoryId });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    preferredRepositoryId,
    getEditorTarget,
    revealReference,
    copyText,
    ...(useShowDialog ? { showDialog: (id) => { document.querySelector(`#${id}`).show(); return true; } } : {}),
    onClose: () => closeCount++,
    renderPdf,
    renderWord,
    renderMarkdown,
  });
  const button = (target) => { const element = new Element(document, "button"); element.dataset.sourceReference = target; return element; };
  const dialog = () => document.querySelector("#source-reference-dialog");
  const part = (selector) => dialog().querySelector(selector);
  return { document, button, dialog, part, calls, pending, closeCount: () => closeCount };
}

function file(overrides = {}) {
  return { content: "one\ntwo\nthree", file: "src/Flow.java", path: "/repo/src/Flow.java", repositoryName: "Repository", line: 2, column: null, lineCount: 3, requestedLine: 2, endLine: null, ...overrides };
}
async function settle() { await new Promise((resolve) => setImmediate(resolve)); }

test("repository chat citations open the editor without creating a preview dialog", async () => {
  const opened = [];
  const h = harness({ getEditorTarget: () => ({
    repositoryId: "repo-a", isCurrent: () => true,
    open: async (file, current) => { assert.equal(current(), true); opened.push(file); return true; },
  }) });
  h.document.click(h.button("package.json:11"));
  const resolved = file({ kind: "text", repositoryId: "repo-a", file: "package.json", line: 11 });
  h.pending[0].resolve(resolved); await settle();
  assert.deepEqual(opened, [resolved]);
  assert.equal(h.dialog(), null);
});

test("Nexus citations retain the read-only source preview", async () => {
  const h = harness({ getEditorTarget: () => null });
  h.document.click(h.button("package.json:2"));
  h.pending[0].resolve(file({ kind: "text", repositoryId: "repo-a" })); await settle();
  assert.equal(h.dialog().open, true);
  assert.equal(h.part("textarea").readOnly, true);
});

test("late repository citations cannot open a file after changing repository or view", async () => {
  let current = true, opened = false;
  const h = harness({ getEditorTarget: () => ({
    repositoryId: "repo-a", isCurrent: () => current,
    open: async () => { opened = true; return true; },
  }) });
  h.document.click(h.button("package.json"));
  current = false;
  h.pending[0].resolve(file({ kind: "text", repositoryId: "repo-a" })); await settle();
  assert.equal(opened, false); assert.equal(h.dialog(), null);
});

test("repository documents and references belonging to other repositories stay safe previews", async () => {
  let opened = false;
  const h = harness({ getEditorTarget: () => ({
    repositoryId: "repo-a", isCurrent: () => true,
    open: async () => { opened = true; return true; },
  }) });
  h.document.click(h.button("other/src/file.js"));
  h.pending[0].resolve(file({ kind: "text", repositoryId: "repo-b" })); await settle();
  assert.equal(opened, false); assert.equal(h.dialog().open, true);
  assert.equal(h.calls.length, 1);
});

test("clicking a source citation opens a read-only preview at its cited line", async () => {
  const h = harness();
  const opener = h.button("/repo/src/Flow.java:2");
  h.document.click(opener);
  assert.equal(h.dialog().open, true);
  assert.equal(h.part("[data-source-body]").hidden, true);
  assert.equal(h.part("[data-source-notice]").textContent, "Opening local reference…");
  assert.equal(h.part("[data-source-context]").textContent, "Read-only · Local files and folders");
  assert.deepEqual(h.calls, [{ target: "/repo/src/Flow.java:2", repositoryId: "repo-a" }]);
  h.pending[0].resolve(file());
  await settle();
  const editor = h.part("textarea");
  assert.equal(editor.readOnly, true);
  assert.equal(editor.value, "one\ntwo\nthree");
  assert.equal(editor.selectionStart, 4);
  assert.equal(editor.selectionEnd, 7);
  assert.equal(h.part("[data-source-body]").hidden, false);
  assert.equal(h.part("h2").textContent, "Flow.java");
  assert.equal(h.part("[data-source-context]").textContent, "Repository · src/Flow.java");
  assert.equal(h.part("[data-source-context]").title, "/repo/src/Flow.java");
  assert.match(h.part("[data-source-notice]").textContent, /Line 2 of 3 · Read-only/);
});

test("opening another citation clears the previous file context and tooltip, including on failure", async () => {
  const h = harness();
  h.document.click(h.button("/repo/src/Flow.java"));
  h.pending[0].resolve(file());
  await settle();
  assert.equal(h.part("[data-source-context]").title, "/repo/src/Flow.java");
  h.document.click(h.button("/outside/notes.txt"));
  assert.equal(h.part("[data-source-context]").textContent, "Read-only · Local files and folders");
  assert.equal(h.part("[data-source-context]").title, undefined);
  h.pending[1].reject(new Error("File no longer exists"));
  await settle();
  assert.equal(h.part("[data-source-context]").title, undefined);
  assert.equal(h.part("[data-source-context]").textContent, "Read-only · Local files and folders");
});

test("a newer source citation wins over an older in-flight response", async () => {
  const h = harness();
  h.document.click(h.button("/repo/old.java"));
  h.document.click(h.button("/repo/new.java"));
  h.pending[1].resolve(file({ file: "new.java", content: "new" }));
  await settle();
  h.pending[0].resolve(file({ file: "old.java", content: "old" }));
  await settle();
  assert.equal(h.part("h2").textContent, "new.java");
  assert.equal(h.part("textarea").value, "new");
});

test("closing a pending preview discards its response without reopening it", async () => {
  const h = harness();
  const opener = h.button("/repo/Flow.java");
  h.document.click(opener);
  h.dialog().close();
  h.document.flushCloseEvents();
  h.pending[0].resolve(file());
  await settle();
  assert.equal(h.dialog().open, false);
  assert.equal(h.part("textarea").value, "");
  assert.equal(h.document.activeElement, opener);
  assert.equal(h.closeCount(), 1);
});

test("closing a loaded preview clears its file buffer", async () => {
  const h = harness();
  h.document.click(h.button("/repo/Flow.java"));
  h.pending[0].resolve(file());
  await settle();
  h.part("[data-source-close]").dispatch("click");
  h.document.flushCloseEvents();
  assert.equal(h.dialog().open, false);
  assert.equal(h.part("textarea").value, "");
});

test("a delayed native close event cannot clear or cancel a reopened preview", async () => {
  const h = harness();
  h.document.click(h.button("/repo/old.java"));
  h.dialog().close();
  h.document.click(h.button("/repo/new.java"));
  h.document.flushCloseEvents();
  h.pending[1].resolve(file({ file: "new.java", content: "new file" }));
  await settle();
  h.pending[0].resolve(file({ file: "old.java", content: "old file" }));
  await settle();
  assert.equal(h.dialog().open, true);
  assert.equal(h.part("h2").textContent, "new.java");
  assert.equal(h.part("textarea").value, "new file");
});

test("standalone initialization can replace an already open source preview", async () => {
  const h = harness({ useShowDialog: false });
  h.document.click(h.button("/repo/first.java"));
  h.document.click(h.button("/repo/second.java"));
  assert.equal(h.calls.length, 2);
  h.pending[1].resolve(file({ content: "second" }));
  await settle();
  assert.equal(h.part("textarea").value, "second");
});

test("preview failure messages are safe text, not rendered HTML", async () => {
  const h = harness();
  h.document.click(h.button("/repo/Flow.java"));
  const message = '<img src=x onerror="alert(1)"> cannot be opened';
  h.pending[0].reject(new Error(message));
  await settle();
  assert.equal(h.part("[data-source-notice]").textContent, message);
  assert.equal(h.part("[data-source-notice]").assignedHtml, undefined);
  assert.equal(h.part("[data-source-notice]").dataset.error, "true");
  assert.equal(h.part("[data-source-body]").hidden, true);
});

const downloadUrl = "/api/source-reference/content?target=docs%2Fplan.pdf&download=true";
function pdfFile() { return file({ kind: "document", previewType: "pdf", mimeType: "application/pdf", name: "plan.pdf", file: "docs/plan.pdf", contentUrl: "/api/source-reference/content?target=docs%2Fplan.pdf", downloadUrl }); }

test("PDF preview and Download original use separate local capabilities", async () => {
  const calls = [];
  let cleanups = 0;
  const h = harness({ renderPdf: async (container, url, options) => { calls.push({ container, url, options }); return () => cleanups++; } });
  h.document.click(h.button("docs/plan.pdf"));
  h.pending[0].resolve(pdfFile());
  await settle();
  assert.equal(calls[0].url, "/api/source-reference/content?target=docs%2Fplan.pdf");
  assert.equal(h.part("[data-source-body]").hidden, true);
  assert.equal(h.part("[data-document-preview]").hidden, false);
  assert.match(h.part("[data-source-notice]").textContent, /PDF preview · Read-only/);
  assert.equal(h.part("[data-source-download]").href, downloadUrl);
  assert.equal(h.part("[data-source-download]").download, "plan.pdf");
  assert.equal(h.part("[data-source-download]").hidden, false);
  h.dialog().close(); h.document.flushCloseEvents();
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(cleanups, 1);
  assert.equal(h.part("[data-source-download]").hidden, true);
  assert.equal(h.part("[data-source-download]").href, undefined);
});

test("a late PDF render cannot replace a newer text citation or retain resources", async () => {
  let finish; let cleanups = 0; let signal;
  const h = harness({ renderPdf: (_container, _url, options) => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); } });
  h.document.click(h.button("docs/plan.pdf")); h.pending[0].resolve(pdfFile());
  await settle();
  h.document.click(h.button("src/new.java")); h.pending[1].resolve(file({ content: "latest" }));
  await settle();
  assert.equal(signal.aborted, true);
  finish(() => cleanups++);
  await settle();
  assert.equal(cleanups, 1);
  assert.equal(h.part("textarea").value, "latest");
  assert.equal(h.part("[data-document-preview]").hidden, true);
  assert.match(h.part("[data-source-notice]").textContent, /Line/);
});

test("DOCX preview displays safe extracted text and keeps the original DOCX download", async () => {
  const h = harness();
  h.document.click(h.button("docs/plan.docx"));
  h.pending[0].resolve(file({ kind: "document", previewType: "text", name: "plan.docx", file: "docs/plan.docx", content: "<script>alert('bad')</script>\nBusiness requirements", previewNotice: "Plain-text preview; formatting is not preserved.", downloadUrl: "/api/source-reference/content?target=docs%2Fplan.docx&download=true" }));
  await settle();
  const preview = h.part("[data-document-preview]").children[0];
  assert.equal(preview.textContent, "<script>alert('bad')</script>\nBusiness requirements");
  assert.equal(preview.assignedHtml, undefined);
  assert.equal(h.part("[data-source-download]").download, "plan.docx");
  assert.match(h.part("[data-source-notice]").textContent, /formatting is not preserved/);
});

test("PDF errors retain the original download and do not affect text source downloads", async () => {
  const h = harness({ renderPdf: async () => { throw new Error("Password required"); } });
  h.document.click(h.button("docs/plan.pdf")); h.pending[0].resolve(pdfFile());
  await settle();
  assert.equal(h.part("[data-source-download]").hidden, false);
  assert.match(h.part("[data-source-notice]").textContent, /Password required.*download the original/);
  h.document.click(h.button("src/Flow.java"));
  h.pending[1].resolve(file({ name: "Flow.java", downloadUrl: "/api/source-reference/content?target=src%2FFlow.java&download=true" }));
  await settle();
  assert.equal(h.part("[data-source-download]").download, "Flow.java");
  assert.equal(h.part("textarea").value, "one\ntwo\nthree");
});

test("external preview/download URLs cannot become navigable document actions", async () => {
  let renders = 0;
  const h = harness({ renderPdf: async () => { renders++; } });
  h.document.click(h.button("docs/plan.pdf"));
  h.pending[0].resolve({ ...pdfFile(), contentUrl: "https://evil.test/api/source-reference/content", downloadUrl: "https://evil.test/api/source-reference/content?download=true" });
  await settle();
  assert.equal(renders, 0);
  assert.equal(h.part("[data-source-download]").hidden, true);
  assert.equal(h.part("[data-source-download]").href, undefined);
});

const wordContentUrl = "/api/source-reference/content?target=docs%2Fplan.docx&preview=docx";
const wordDownloadUrl = "/api/source-reference/content?target=docs%2Fplan.docx&download=true";
function wordFile(overrides = {}) {
  return file({ kind: "document", previewType: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "plan.docx", file: "docs/plan.docx", path: "/repo/docs/plan.docx", contentUrl: wordContentUrl, downloadUrl: wordDownloadUrl, ...overrides });
}
function markdownFile(overrides = {}) {
  return file({ name: "plan.md", file: "docs/plan.md", path: "/repo/docs/plan.md", content: "# Plan\n\nKeep the original.", line: 1, requestedLine: 1, downloadUrl: "/api/source-reference/content?target=docs%2Fplan.md&download=true", ...overrides });
}

function localFile(original = file(), overrides = {}) {
  const name = original.name || original.file.split("/").at(-1);
  const path = `/outside/My "files" & plans/${name}`;
  const contentUrl = `/api/source-reference/content?target=${encodeURIComponent(path)}`;
  return { ...original, name, path, file: path, scope: "local", repositoryId: null, repositoryName: null, contentUrl, downloadUrl: `${contentUrl}&download=true`, ...overrides };
}

for (const [kind, original] of [["source", file()], ["PDF", pdfFile()], ["Markdown", markdownFile()]]) {
  test(`external ${kind} files display literal local paths without repository metadata`, async () => {
    const renders = [];
    const local = localFile(original);
    // Missing repository fields are also supported, as well as explicit nulls.
    if (kind === "Markdown") { delete local.repositoryId; delete local.repositoryName; }
    const h = harness({
      renderPdf: async (_container, url) => { renders.push(url); return () => {}; },
      renderMarkdown: async (_container, input) => { renders.push(input); return () => {}; },
    });
    h.document.click(h.button(local.path));
    h.pending[0].resolve(local);
    await settle();
    assert.equal(h.part("h2").textContent, local.name);
    assert.equal(h.part("[data-source-context]").textContent, `Local file · ${local.path}`);
    assert.equal(h.part("[data-source-context]").title, local.path);
    assert.equal(h.part("[data-source-context]").assignedHtml, undefined);
    assert.equal(h.part("[data-source-download]").href, local.downloadUrl);
    assert.equal(h.part("[data-source-download]").download, local.name);
    assert.equal(h.part("[data-source-notice]").dataset.error, "false");
    if (kind === "source") {
      assert.equal(h.part("textarea").value, local.content);
      assert.equal(h.part("textarea").readOnly, true);
      assert.equal(h.part("[data-source-body]").hidden, false);
      assert.equal(h.part("textarea").selectionStart, 4);
    } else {
      assert.deepEqual(renders, [kind === "PDF" ? local.contentUrl : local]);
      assert.equal(h.part("[data-document-preview]").hidden, false);
      assert.equal(h.part("[data-source-body]").hidden, true);
      if (kind === "Markdown") {
        h.part("[data-source-toggle]").dispatch("click");
        assert.equal(h.part("textarea").value, local.content);
        assert.equal(h.part("[data-source-body]").hidden, false);
      }
    }
  });
}

test("external file names and paths cannot inject HTML into the viewer header", async () => {
  const h = harness();
  const name = '<img src=x onerror="bad()">.txt';
  const path = `/outside/${name}`;
  h.document.click(h.button("/outside/file.txt"));
  h.pending[0].resolve(localFile(file(), { name, path, file: path }));
  await settle();
  assert.equal(h.part("h2").textContent, name);
  assert.equal(h.part("h2").assignedHtml, undefined);
  assert.equal(h.part("[data-source-context]").textContent, `Local file · ${path}`);
  assert.equal(h.part("[data-source-context]").title, path);
  assert.equal(h.part("[data-source-context]").assignedHtml, undefined);
});

test("external files still reject off-origin preview and download URLs", async () => {
  let renders = 0;
  const h = harness({ renderPdf: async () => { renders++; } });
  const local = localFile(pdfFile());
  h.document.click(h.button(local.path));
  h.pending[0].resolve({ ...local, contentUrl: `https://evil.test${local.contentUrl}`, downloadUrl: `https://evil.test${local.downloadUrl}` });
  await settle();
  assert.equal(renders, 0);
  assert.equal(h.part("[data-source-download]").hidden, true);
  assert.equal(h.part("[data-source-download]").href, undefined);
  assert.equal(h.part("[data-source-context]").textContent, `Local file · ${local.path}`);
});

test("queued close and stale local-file responses preserve a newer repository citation", async () => {
  const h = harness();
  const local = localFile(file());
  h.document.click(h.button(local.path));
  h.dialog().close();
  h.document.click(h.button("/repo/src/Flow.java"));
  h.document.flushCloseEvents();
  h.pending[1].resolve(file());
  await settle();
  h.pending[0].resolve(local);
  await settle();
  assert.equal(h.dialog().open, true);
  assert.equal(h.closeCount(), 0);
  assert.equal(h.part("[data-source-context]").textContent, "Repository · src/Flow.java");
  assert.equal(h.part("[data-source-context]").title, "/repo/src/Flow.java");
  assert.equal(h.part("textarea").value, "one\ntwo\nthree");
});

test("formatted Word uses its preview capability and close aborts and releases resources", async () => {
  const calls = [];
  let cleanups = 0;
  const h = harness({ renderWord: async (container, url, options) => {
    calls.push({ container, url, options });
    container.append(new Element(container.ownerDocument, "iframe"));
    return () => cleanups++;
  } });
  const opener = h.button("docs/plan.docx");
  h.document.click(opener); h.pending[0].resolve(wordFile());
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, wordContentUrl);
  assert.equal(calls[0].container, h.part("[data-document-preview]"));
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(h.part("[data-source-body]").hidden, true);
  assert.equal(h.part("[data-document-preview]").hidden, false);
  assert.equal(h.part("[data-source-toggle]").hidden, true);
  assert.match(h.part("[data-source-notice]").textContent, /Formatted Word preview · Read-only/);
  assert.equal(h.part("[data-source-download]").href, wordDownloadUrl);
  assert.equal(h.part("[data-source-download]").download, "plan.docx");
  h.dialog().close(); h.document.flushCloseEvents();
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(cleanups, 1);
  assert.deepEqual(h.part("[data-document-preview]").children, []);
  assert.equal(h.part("[data-source-download]").hidden, true);
  assert.equal(h.part("[data-source-download]").href, undefined);
  assert.equal(h.document.activeElement, opener);
});

test("late Word completion is disposed without replacing a newer source or download", async () => {
  let finish, signal; let cleanups = 0;
  const h = harness({ renderWord: (_container, _url, options) => {
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  } });
  h.document.click(h.button("docs/plan.docx")); h.pending[0].resolve(wordFile());
  await settle();
  h.document.click(h.button("src/New.java:2"));
  const nextDownload = "/api/source-reference/content?target=src%2FNew.java&download=true";
  h.pending[1].resolve(file({ name: "New.java", file: "src/New.java", content: "new\nsource", downloadUrl: nextDownload }));
  await settle();
  assert.equal(signal.aborted, true);
  finish(() => cleanups++); await settle();
  assert.equal(cleanups, 1);
  assert.equal(h.part("h2").textContent, "New.java");
  assert.equal(h.part("textarea").value, "new\nsource");
  assert.equal(h.part("[data-document-preview]").hidden, true);
  assert.equal(h.part("[data-source-download]").href, nextDownload);
  assert.match(h.part("[data-source-notice]").textContent, /Line 2 of 2/);
  assert.equal(h.part("[data-source-notice]").dataset.error, "false");
});

test("Word rendering failure retains the unchanged original download and safe error text", async () => {
  const failure = '<img src=x onerror="bad()"> Word rendering failed';
  const h = harness({ renderWord: async () => { throw new Error(failure); } });
  h.document.click(h.button("docs/plan.docx")); h.pending[0].resolve(wordFile());
  await settle();
  assert.equal(h.part("[data-source-download]").hidden, false);
  assert.equal(h.part("[data-source-download]").href, wordDownloadUrl);
  assert.equal(h.part("[data-source-download]").download, "plan.docx");
  assert.equal(h.part("[data-source-notice]").dataset.error, "true");
  assert.equal(h.part("[data-source-notice]").textContent, `${failure} You can still download the original file.`);
  assert.equal(h.part("[data-source-notice]").assignedHtml, undefined);
  assert.equal(h.part("[data-source-body]").hidden, true);
});

test("late Word rejection cannot mark a newer preview as failed", async () => {
  let reject;
  const h = harness({ renderWord: () => new Promise((_resolve, fail) => { reject = fail; }) });
  h.document.click(h.button("docs/plan.docx")); h.pending[0].resolve(wordFile());
  await settle();
  h.document.click(h.button("src/Current.java")); h.pending[1].resolve(file({ name: "Current.java", content: "current" }));
  await settle();
  reject(new Error("Old Word timeout")); await settle();
  assert.equal(h.part("h2").textContent, "Current.java");
  assert.equal(h.part("textarea").value, "current");
  assert.equal(h.part("[data-source-notice]").dataset.error, "false");
  assert.doesNotMatch(h.part("[data-source-notice]").textContent, /Word timeout/);
});

test("Markdown opens formatted by default and toggles the unchanged read-only source", async () => {
  let renders = 0, cleanups = 0, signal;
  const original = markdownFile();
  const h = harness({ renderMarkdown: async (container, input, options) => {
    renders++; signal = options.signal;
    assert.equal(input, original);
    container.append(new Element(container.ownerDocument, "article"));
    return () => cleanups++;
  } });
  h.document.click(h.button("docs/plan.md")); h.pending[0].resolve(original);
  await settle();
  const toggle = h.part("[data-source-toggle]");
  assert.equal(renders, 1);
  assert.equal(h.part("[data-document-preview]").hidden, false);
  assert.equal(h.part("[data-source-body]").hidden, true);
  assert.equal(h.part("textarea").value, original.content);
  assert.equal(h.part("textarea").readOnly, true);
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.textContent, "Source");
  assert.equal(toggle["aria-pressed"], "false");
  assert.match(h.part("[data-source-notice]").textContent, /Formatted Markdown · Read-only/);
  assert.equal(h.part("[data-source-download]").href, original.downloadUrl);
  toggle.dispatch("click");
  assert.equal(h.part("[data-document-preview]").hidden, true);
  assert.equal(h.part("[data-source-body]").hidden, false);
  assert.equal(toggle.textContent, "Preview");
  assert.equal(toggle["aria-pressed"], "true");
  assert.equal(h.document.activeElement, h.part("textarea"));
  assert.match(h.part("[data-source-notice]").textContent, /Line 1 of 3 · Read-only/);
  toggle.dispatch("click");
  assert.equal(h.part("[data-document-preview]").hidden, false);
  assert.equal(h.part("[data-source-body]").hidden, true);
  assert.equal(toggle.textContent, "Source");
  assert.equal(toggle["aria-pressed"], "false");
  assert.equal(renders, 1);
  assert.equal(cleanups, 0);
  h.dialog().close(); h.document.flushCloseEvents();
  assert.equal(signal.aborted, true);
  assert.equal(cleanups, 1);
  assert.equal(toggle.hidden, true);
  assert.equal(h.part("textarea").value, "");
  assert.deepEqual(h.part("[data-document-preview]").children, []);
  assert.equal(h.part("[data-source-download]").href, undefined);
});

test("closing a pending Markdown render aborts it and disposes any late result", async () => {
  let finish, signal; let cleanups = 0;
  const h = harness({ renderMarkdown: (_container, _file, options) => {
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  } });
  h.document.click(h.button("docs/plan.md")); h.pending[0].resolve(markdownFile());
  await settle();
  h.dialog().close(); h.document.flushCloseEvents();
  assert.equal(signal.aborted, true);
  finish(() => cleanups++); await settle();
  assert.equal(cleanups, 1);
  assert.equal(h.dialog().open, false);
  assert.equal(h.part("[data-source-toggle]").hidden, true);
  assert.equal(h.part("textarea").value, "");
  assert.equal(h.part("[data-source-download]").hidden, true);
});

test("Markdown rendering failure falls back to read-only source and retains original download", async () => {
  const h = harness({ renderMarkdown: async () => { throw new Error("Markdown parser unavailable"); } });
  const original = markdownFile();
  h.document.click(h.button("docs/plan.md")); h.pending[0].resolve(original);
  await settle();
  assert.equal(h.part("[data-source-body]").hidden, false);
  assert.equal(h.part("[data-document-preview]").hidden, true);
  assert.equal(h.part("textarea").value, original.content);
  assert.equal(h.part("textarea").readOnly, true);
  assert.equal(h.part("[data-source-toggle]").hidden, true);
  assert.equal(h.part("[data-source-download]").href, original.downloadUrl);
  assert.equal(h.part("[data-source-download]").hidden, false);
  assert.match(h.part("[data-source-notice]").textContent, /Markdown parser unavailable.*download the original/);
});

test("cross-document Markdown anchors stay out of the source API and are passed to the renderer", async () => {
  let options;
  const h = harness({ renderMarkdown: async (_container, _file, value) => { options = value; return () => {}; } });
  const link = h.button("/repo/docs/guide.md");
  link.dataset.sourceMarkdownAnchor = "setup";
  h.document.click(link);
  assert.deepEqual(h.calls, [{ target: "/repo/docs/guide.md", repositoryId: "repo-a" }]);
  h.pending[0].resolve(markdownFile({ file: "docs/guide.md", name: "guide.md" }));
  await settle();
  assert.equal(options.anchor, "setup");
  assert.equal(h.part("[data-source-notice]").dataset.error, "false");
});

test("oversized Markdown metadata keeps its original download without invoking any renderer", async () => {
  let renders = 0;
  const h = harness({ renderMarkdown: async () => { renders++; } });
  h.document.click(h.button("docs/large.md"));
  h.pending[0].resolve(file({ kind: "document", previewType: "download", name: "large.md", file: "docs/large.md", mimeType: "text/markdown", contentUrl: null, downloadUrl: "/api/source-reference/content?target=docs%2Flarge.md&download=true", previewNotice: "This Markdown document exceeds the 2 MB preview limit. Download the unchanged original." }));
  await settle();
  assert.equal(renders, 0);
  assert.equal(h.part("[data-source-download]").hidden, false);
  assert.equal(h.part("[data-source-download]").download, "large.md");
  assert.equal(h.part("[data-source-body]").hidden, true);
  assert.equal(h.part("[data-source-notice]").dataset.error, "false");
  assert.match(h.part("[data-document-preview]").children[0].textContent, /2 MB preview limit/);
});

function directory(overrides = {}) {
  return { kind: "directory", previewType: "directory", scope: "local", repositoryId: null, repositoryName: null, file: "/outside/guided-help-studio", name: "guided-help-studio", path: "/outside/guided-help-studio", size: null, contentUrl: null, downloadUrl: null, ...overrides };
}

test("folder citation shows the canonical path and reveals the original reference without rendering files", async () => {
  const reveals = [], copies = [];
  let renders = 0;
  const h = harness({
    revealReference: async (target, repositoryId) => { reveals.push({ target, repositoryId }); return { opened: true }; },
    copyText: async value => { copies.push(value); },
    renderPdf: async () => { renders++; }, renderWord: async () => { renders++; }, renderMarkdown: async () => { renders++; },
  });
  h.document.click(h.button("/outside/studio-link"));
  h.pending[0].resolve(directory());
  await settle();
  assert.deepEqual(reveals, [{ target: "/outside/studio-link", repositoryId: "repo-a" }]);
  assert.equal(h.dialog().dataset.sourceKind, "directory");
  assert.equal(h.part("h2").textContent, "Folder reference");
  assert.equal(h.part("[data-source-context]").textContent, "Local folder · Read-only");
  assert.equal(h.part("[data-folder-name]").textContent, "guided-help-studio");
  assert.equal(h.part("[data-folder-path]").textContent, "/outside/guided-help-studio");
  assert.match(h.part("[data-source-notice]").textContent, /Shown in Finder/);
  assert.equal(h.part("[data-source-folder]").hidden, false);
  for (const selector of ["[data-source-body]", "[data-document-preview]", "[data-source-download]", "[data-source-toggle]"]) assert.equal(h.part(selector).hidden, true);
  assert.equal(h.part("textarea").value, "");
  assert.equal(renders, 0);
  assert.equal(h.part("[data-source-close]")["aria-label"], "Close folder reference");
  h.part("[data-folder-copy]").dispatch("click");
  await settle();
  assert.deepEqual(copies, ["/outside/guided-help-studio"]);
  assert.equal(h.part("[data-folder-copy]").textContent, "Copied");
  assert.equal(h.part("[data-folder-copy-status]").textContent, "Folder path copied.");
});

test("folder reveal preserves the original target and captured repository while copying the raw canonical path", async () => {
  const reveals = [], copies = [];
  let repositoryId = "repo-a";
  const h = harness({ preferredRepositoryId: () => repositoryId,
    revealReference: async (target, id) => { reveals.push({ target, id }); return { opened: true }; },
    copyText: async value => { copies.push(value); },
  });
  const path = '/outside/Résumé 100%25 + plan/<img src=x onerror="bad()">';
  h.document.click(h.button("/outside/alias"));
  repositoryId = "repo-b";
  h.pending[0].resolve(directory({ path, name: '<img src=x onerror="bad()">' }));
  await settle();
  assert.deepEqual(reveals, [{ target: "/outside/alias", id: "repo-a" }]);
  assert.equal(h.part("[data-folder-path]").textContent, path);
  assert.equal(h.part("[data-folder-path]").assignedHtml, undefined);
  assert.equal(h.part("[data-folder-name]").assignedHtml, undefined);
  h.part("[data-folder-copy]").dispatch("click"); await settle();
  assert.deepEqual(copies, [path]);
});

test("folder reveal round-trips punctuation, encoded aliases and trailing-slash citations unchanged", async () => {
  const cases = [
    { target: "/outside/project:42/", path: "/outside/project:42" },
    { target: "/outside/alias-to-punctuation/", path: "/outside/plan#notes?draft " },
    { target: "/outside/R%C3%A9sum%C3%A9%20100%2525%20%2B%20plan/", path: "/outside/Résumé 100%25 + plan" },
    { target: "/outside/alias-to-space/", path: "/outside/directory with trailing space " },
  ];
  for (const { target, path } of cases) {
    const reveals = [], copies = [];
    const h = harness({
      revealReference: async (value, repositoryId) => { reveals.push({ value, repositoryId }); return { opened: true }; },
      copyText: async value => { copies.push(value); },
    });
    h.document.click(h.button(target));
    h.pending[0].resolve(directory({ path })); await settle();
    assert.deepEqual(h.calls, [{ target, repositoryId: "repo-a" }]);
    assert.deepEqual(reveals, [{ value: target, repositoryId: "repo-a" }]);
    assert.equal(h.part("[data-folder-path]").textContent, path);
    h.part("[data-folder-copy]").dispatch("click"); await settle();
    assert.deepEqual(copies, [path]);
  }
});

for (const action of ["close", "replace", "close-and-reopen"]) {
  test(`folder metadata arriving after ${action} cannot open Finder or overwrite the current view`, async () => {
    const reveals = [];
    const h = harness({ revealReference: async target => { reveals.push(target); return { opened: true }; } });
    const opener = h.button("/outside/old-folder");
    h.document.click(opener);
    if (action !== "replace") h.dialog().close();
    if (action !== "close") {
      h.document.click(h.button("src/Current.java"));
      h.pending[1].resolve(file()); await settle();
    }
    // Exercise the native close-event delay too: open=false must be enough.
    h.pending[0].resolve(directory()); await settle();
    assert.deepEqual(reveals, []);
    if (action === "close") assert.equal(h.dialog().open, false);
    else assert.equal(h.part("textarea").value, "one\ntwo\nthree");
    h.document.flushCloseEvents();
    if (action === "close") assert.equal(h.document.activeElement, opener);
  });
}

test("repeated folder citations and retry clicks share pending metadata and Finder work", async () => {
  let finish;
  const reveals = [];
  const h = harness({ revealReference: (target, repositoryId) => { reveals.push({ target, repositoryId }); return new Promise(resolve => { finish = resolve; }); } });
  const opener = h.button("/outside/studio-link");
  h.document.click(opener); h.document.click(opener);
  assert.equal(h.calls.length, 1);
  h.pending[0].resolve(directory()); await settle();
  h.document.click(opener);
  h.part("[data-folder-reveal]").dispatch("click");
  assert.equal(h.calls.length, 1);
  assert.equal(reveals.length, 1);
  assert.equal(h.part("[data-folder-reveal]").disabled, true);
  h.dialog().close();
  h.document.click(opener);
  h.document.flushCloseEvents();
  h.pending[1].resolve(directory()); await settle();
  assert.equal(reveals.length, 1);
  finish({ opened: true }); await settle();
  assert.match(h.part("[data-source-notice]").textContent, /Shown in Finder/);
  assert.equal(h.part("[data-folder-reveal]").disabled, false);
});

test("failed folder reveal retains path and allows an explicit retry without a file error screen", async () => {
  let attempts = 0;
  const h = harness({ revealReference: async () => {
    if (++attempts === 1) throw new Error("Finder is available only on macOS.");
    return { opened: true };
  } });
  h.document.click(h.button("/outside/studio")); h.pending[0].resolve(directory()); await settle();
  assert.equal(h.dialog().dataset.sourceKind, "directory");
  assert.equal(h.part("[data-source-folder]").hidden, false);
  assert.match(h.part("[data-source-notice]").textContent, /only on macOS/);
  assert.equal(h.part("[data-source-notice]").dataset.error, "true");
  assert.equal(h.part("[data-folder-reveal]").disabled, false);
  h.part("[data-folder-reveal]").dispatch("click"); await settle();
  assert.equal(attempts, 2);
  assert.equal(h.part("[data-source-notice]").dataset.error, "false");
  assert.match(h.part("[data-source-notice]").textContent, /Shown in Finder/);
});

test("missing or unconfirmed folder reveal capability never claims Finder opened", async () => {
  for (const revealReference of [undefined, async () => ({ opened: false })]) {
    const h = harness({ revealReference });
    h.document.click(h.button("/outside/studio")); h.pending[0].resolve(directory()); await settle();
    assert.equal(h.part("[data-source-notice]").dataset.error, "true");
    assert.doesNotMatch(h.part("[data-source-notice]").textContent, /Shown in Finder/);
    assert.equal(h.part("[data-source-folder]").hidden, false);
    assert.equal(h.part("[data-folder-copy]").disabled, false);
  }
});

for (const next of [file(), pdfFile(), wordFile(), markdownFile()]) {
  test(`folder-to-${next.name || "source"} transition resets folder controls and ignores late Finder/clipboard results`, async () => {
    let rejectReveal, finishCopy;
    const h = harness({
      revealReference: () => new Promise((_resolve, reject) => { rejectReveal = reject; }),
      copyText: () => new Promise(resolve => { finishCopy = resolve; }),
      renderPdf: async () => () => {}, renderWord: async () => () => {}, renderMarkdown: async () => () => {},
    });
    h.document.click(h.button("/outside/studio")); h.pending[0].resolve(directory()); await settle();
    h.part("[data-folder-copy]").dispatch("click");
    h.document.click(h.button(next.file)); h.pending[1].resolve(next); await settle();
    const notice = h.part("[data-source-notice]").textContent;
    rejectReveal(new Error("old Finder failed")); finishCopy(); await settle();
    assert.equal(h.dialog().dataset.sourceKind, undefined);
    assert.equal(h.part("[data-source-folder]").hidden, true);
    assert.equal(h.part("[data-folder-path]").textContent, "");
    assert.equal(h.part("[data-folder-copy-status]").hidden, true);
    assert.equal(h.part("[data-source-notice]").textContent, notice);
    assert.equal(h.part("[data-source-notice]").dataset.error, "false");
    assert.equal(h.part("[data-source-close]")["aria-label"], "Close source file");
  });
}

test("copy failure is safe visible feedback, can retry, and does not overwrite Finder status", async () => {
  let attempts = 0;
  const h = harness({ revealReference: async () => ({ opened: true }), copyText: async () => {
    if (++attempts === 1) throw new Error('<img src=x onerror="bad()"> Clipboard permission denied');
  } });
  h.document.click(h.button("/outside/studio")); h.pending[0].resolve(directory()); await settle();
  h.part("[data-folder-copy]").dispatch("click"); h.part("[data-folder-copy]").dispatch("click"); await settle();
  assert.equal(attempts, 1);
  assert.equal(h.part("[data-folder-copy]").disabled, false);
  assert.equal(h.part("[data-folder-copy-status]").dataset.error, "true");
  assert.equal(h.part("[data-folder-copy-status]").assignedHtml, undefined);
  assert.match(h.part("[data-source-notice]").textContent, /Shown in Finder/);
  h.part("[data-folder-copy]").dispatch("click"); await settle();
  assert.equal(attempts, 2);
  assert.equal(h.part("[data-folder-copy-status]").dataset.error, "false");
  assert.equal(h.part("[data-folder-copy]").textContent, "Copied");
});

test("closing a folder card clears its path, ignores pending actions, and restores citation focus", async () => {
  let finish;
  const h = harness({ revealReference: () => new Promise(resolve => { finish = resolve; }) });
  const opener = h.button("/outside/studio");
  h.document.click(opener); h.pending[0].resolve(directory()); await settle();
  h.part("[data-source-close]").dispatch("click"); h.document.flushCloseEvents();
  finish({ opened: true }); await settle();
  assert.equal(h.dialog().open, false);
  assert.equal(h.part("[data-source-folder]").hidden, true);
  assert.equal(h.part("[data-folder-path]").textContent, "");
  assert.equal(h.document.activeElement, opener);
  assert.equal(h.closeCount(), 1);
});
