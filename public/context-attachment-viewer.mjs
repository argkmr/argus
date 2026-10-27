import { attachmentPresentation } from "./context-attachment-view.mjs";
import { attachmentContentUrl, localPreviewEndpoint } from "./local-preview-url.mjs";
import { renderPdfDocument } from "./pdf-preview.js";
import { renderWordDocument } from "./word-preview.js";
import { renderMarkdownDocument } from "./markdown-preview.js";

const THEME_PROPERTIES = ["--bg", "--surface", "--surface-2", "--surface-3", "--line", "--line-soft", "--text", "--muted", "--muted-2", "--accent", "--accent-ink", "--blue", "--red"];
const MEDIA_TYPES = {
  image: new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]),
  audio: new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/flac"]),
  video: new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]),
};

export async function renderAttachmentMedia(container, url, { type, mimeType, name, signal, fetchFile = globalThis.fetch } = {}) {
  if (!MEDIA_TYPES[type]?.has(mimeType)) throw new Error("This media format needs its original application.");
  const document = container.ownerDocument, view = document.defaultView;
  const endpoint = localPreviewEndpoint(url, document.location.origin);
  const controller = new AbortController();
  let element, blobUrl, disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    signal?.removeEventListener("abort", cleanup);
    if (element) {
      element.pause?.(); element.removeAttribute("src"); element.load?.(); element.remove();
    }
    if (blobUrl) view.URL.revokeObjectURL(blobUrl);
  };
  signal?.addEventListener("abort", cleanup, { once: true });
  const timeout = view.setTimeout(() => controller.abort(), 30_000);
  try {
    if (signal?.aborted) throw new DOMException("Preview cancelled", "AbortError");
    const response = await fetchFile(endpoint.href, { signal: controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error" });
    if (!response.ok || (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== mimeType) throw new Error("This attachment could not be loaded safely.");
    if (Number(response.headers.get("content-length")) > 21_000_000) throw new Error("This attachment is too large to preview.");
    const blob = await response.blob();
    if (disposed || controller.signal.aborted) throw new DOMException("Preview cancelled", "AbortError");
    if (blob.size > 21_000_000) throw new Error("This attachment is too large to preview.");
    blobUrl = view.URL.createObjectURL(blob);
    element = document.createElement(type === "image" ? "img" : type);
    element.className = `attachment-media attachment-media-${type}`;
    if (type === "image") element.alt = name;
    else { element.controls = true; element.preload = "metadata"; element.setAttribute("aria-label", name); }
    const ready = new Promise((resolve, reject) => {
      element.addEventListener(type === "image" ? "load" : "loadedmetadata", resolve, { once: true });
      element.addEventListener("error", () => reject(new Error("This media cannot be displayed here. Download the original to open it.")), { once: true });
      controller.signal.addEventListener("abort", () => reject(new DOMException("Preview cancelled", "AbortError")), { once: true });
    });
    element.src = blobUrl;
    container.append(element);
    await ready;
    return cleanup;
  } catch (error) { cleanup(); throw error; }
  finally { view.clearTimeout(timeout); }
}

export function initializeAttachmentViewer({ document = globalThis.document, loadPreview, showDialog, onClose = () => {}, renderPdf = renderPdfDocument, renderWord = renderWordDocument, renderMarkdown = renderMarkdownDocument, renderMedia = renderAttachmentMedia } = {}) {
  if (!document || typeof loadPreview !== "function") return;
  let dialog, title, detail, notice, download, content, toggle, closeButton;
  let epoch = 0, opener, controller, dispose;

  function clear() {
    controller?.abort(); controller = null;
    dispose?.(); dispose = null;
    content?.replaceChildren();
    if (download) { download.hidden = true; download.removeAttribute("href"); download.removeAttribute("download"); }
    if (toggle) { toggle.hidden = true; toggle.onclick = null; }
  }

  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "context-attachment-dialog";
    dialog.setAttribute("aria-labelledby", "context-attachment-title");
    dialog.innerHTML = `<section class="dialog-card source-reference-card attachment-viewer-card">
      <header class="source-reference-header"><div><h2 id="context-attachment-title">Attachment</h2><p data-attachment-detail></p></div><div class="source-reference-actions"><button type="button" class="source-reference-download" data-attachment-source hidden aria-pressed="false">Source</button><a class="source-reference-download" data-attachment-download hidden download>Download original</a><button type="button" class="icon-button" data-attachment-close aria-label="Close attachment preview">×</button></div></header>
      <p class="source-reference-notice" data-attachment-notice role="status" aria-live="polite"></p>
      <div class="attachment-viewer-content" data-attachment-content></div>
    </section>`;
    document.body.append(dialog);
    title = dialog.querySelector("h2"); detail = dialog.querySelector("[data-attachment-detail]");
    notice = dialog.querySelector("[data-attachment-notice]"); download = dialog.querySelector("[data-attachment-download]");
    content = dialog.querySelector("[data-attachment-content]"); toggle = dialog.querySelector("[data-attachment-source]");
    closeButton = dialog.querySelector("[data-attachment-close]");
    closeButton.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      const findBar = document.querySelector("#find-bar");
      if (findBar && !findBar.classList.contains("hidden")) return;
      event.preventDefault(); event.stopPropagation(); dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (dialog.open) return; // A queued native close must not clear a newer preview.
      epoch++; clear(); onClose();
      if (opener?.isConnected && !document.querySelector("dialog[open]")) opener.focus({ preventScroll: true });
    });
  }

  async function open(button) {
    ensureDialog();
    if (showDialog) { if (showDialog(dialog.id) === false) return; }
    else if (!dialog.open) dialog.show();
    const current = ++epoch;
    opener = button; clear();
    // Nexus palettes are scoped to its panel; a body-level viewer must carry
    // those tokens with it, then reset them when opened from a repository chat.
    const palette = document.defaultView.getComputedStyle(button);
    for (const property of THEME_PROPERTIES) dialog.style.setProperty(property, palette.getPropertyValue(property));
    controller = new AbortController();
    const signal = controller.signal;
    const isCurrent = () => current === epoch && dialog.open && !signal.aborted;
    title.textContent = button.dataset.attachmentName || "Attachment";
    detail.textContent = "Read-only · Saved attachment";
    notice.dataset.error = "false"; notice.textContent = "Opening attachment…";
    closeButton.focus({ preventScroll: true });
    // Every open owns a different mount, so even a renderer resolving after
    // cancellation cannot append to the next attachment's visible contents.
    const mount = document.createElement("div"); mount.className = "attachment-preview-mount source-document-preview";
    content.append(mount);
    try {
      const id = button.dataset.previewContext;
      const file = await loadPreview(id, { signal });
      if (!isCurrent()) return;
      const presentation = attachmentPresentation(file);
      title.textContent = file.title || file.fileName || presentation.name;
      detail.textContent = `${presentation.description} · Read-only`;
      const original = attachmentContentUrl(file.downloadUrl, document.location.origin, id, { download: true });
      if (original) { download.href = original; download.download = file.fileName || title.textContent; download.hidden = false; }
      const url = attachmentContentUrl(file.contentUrl, document.location.origin, id);
      let cleanup;
      if (file.previewType === "text" && typeof file.content === "string") {
        const text = document.createElement("textarea");
        text.className = "attachment-text-preview"; text.readOnly = true; text.spellcheck = false;
        text.setAttribute("aria-label", "Attachment contents (read-only)"); text.wrap = "off"; text.value = file.content;
        mount.append(text);
        if (!["paste", "browser"].includes(file.kind) && /\.(?:md|markdown)$/i.test(file.fileName || file.title || "") && file.content.length <= 2 * 1024 * 1024) {
          const formatted = document.createElement("div"); formatted.className = "attachment-markdown-preview"; mount.append(formatted);
          try {
            // No stored filesystem path is provided to untrusted document links.
            cleanup = await renderMarkdown(formatted, { content: file.content, path: "" }, { signal });
            if (!isCurrent()) { cleanup?.(); return; }
            text.hidden = true; toggle.hidden = false; toggle.textContent = "Source"; toggle.setAttribute("aria-pressed", "false");
            toggle.onclick = () => { text.hidden = !text.hidden; formatted.hidden = !text.hidden; toggle.textContent = text.hidden ? "Source" : "Preview"; toggle.setAttribute("aria-pressed", String(!text.hidden)); };
          } catch (error) { if (!isCurrent()) return; formatted.remove(); }
        }
      } else if (url && file.previewType === "pdf" && file.mimeType === "application/pdf") {
        cleanup = await renderPdf(mount, url, { signal });
      } else if (url && file.previewType === "docx") {
        cleanup = await renderWord(mount, url, { signal });
      } else if (url && MEDIA_TYPES[file.previewType]?.has(file.mimeType)) {
        mount.classList.add("attachment-media-mount");
        cleanup = await renderMedia(mount, url, { type: file.previewType, mimeType: file.mimeType, name: title.textContent, signal });
      } else {
        const message = document.createElement("p"); message.className = "source-document-unavailable";
        message.textContent = file.previewNotice || "This format does not have an in-app preview. Download the original to open it in its own application.";
        mount.append(message);
      }
      if (!isCurrent()) { cleanup?.(); return; }
      dispose = cleanup;
      notice.textContent = file.previewNotice || "Saved attachment · Original contents are unchanged.";
    } catch (error) {
      if (!isCurrent()) return;
      notice.dataset.error = "true";
      notice.textContent = `${error.message || "This attachment could not be opened."}${download.hidden ? "" : " You can still download the original."}`;
    }
  }

  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-preview-context]");
    if (!button) return;
    event.preventDefault(); void open(button);
  });
  return { open, close: () => dialog?.close() };
}
