import { renderPdfDocument } from "./pdf-preview.js";
import { renderWordDocument } from "./word-preview.js";
import { renderMarkdownDocument } from "./markdown-preview.js";

// Source links are read-only navigation, never filesystem URLs or shell commands.
export function sourceReferenceSelection(value, requestedLine = 1, column = null, endLine = null) {
  const content = String(value || "").replace(/\r\n?/g, "\n");
  const lines = content.split("\n");
  const line = Math.max(1, Math.min(lines.length, Number(requestedLine) || 1));
  const end = Math.max(line, Math.min(lines.length, Number(endLine) || line));
  let start = 0;
  for (let index = 0; index < line - 1; index++) start += lines[index].length + 1;
  const lineStart = start;
  if (column) start += Math.min(lines[line - 1].length, Math.max(0, Number(column) - 1));
  let finish = lineStart;
  for (let index = line - 1; index < end; index++) finish += lines[index].length + (index < end - 1 ? 1 : 0);
  return { content, line, lineCount: lines.length, start, end: finish };
}

export function sourceReferenceContentUrl(value, origin) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const base = new URL(origin);
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.pathname !== "/api/source-reference/content" || url.username || url.password || url.hash) return null;
    return `${url.pathname}${url.search}`;
  } catch { return null; }
}

export function initializeSourceReferences({ document = globalThis.document, loadReference, revealReference, copyText = value => document.defaultView.navigator.clipboard.writeText(value), preferredRepositoryId = () => null, getEditorTarget = () => null, showDialog, onClose = () => {}, renderPdf = renderPdfDocument, renderWord = renderWordDocument, renderMarkdown = renderMarkdownDocument } = {}) {
  if (!document || typeof loadReference !== "function") return;
  let dialog, title, context, notice, editor, gutter, body, selection, download, documentPreview;
  let epoch = 0;
  let opener = null;
  let disposePreview = null;
  let previewController = null;
  let sourceToggle;
  let sourceNotice = "";
  let formattedNotice = "";
  let folder, folderName, folderPath, revealButton, copyButton, copyStatus;
  let activeReference = null;
  let currentFolder = null;
  const pendingReveals = new Map();

  function clearPreview() {
    previewController?.abort();
    previewController = null;
    disposePreview?.();
    disposePreview = null;
    documentPreview?.replaceChildren();
    if (sourceToggle) sourceToggle.hidden = true;
    if (documentPreview) documentPreview.hidden = true;
    currentFolder = null;
    if (folder) {
      folder.hidden = true;
      folderName.textContent = "";
      folderPath.textContent = "";
      copyStatus.textContent = "";
      copyStatus.hidden = true;
    }
    if (dialog) delete dialog.dataset.sourceKind;
    if (download) {
      download.hidden = true;
      download.removeAttribute("href");
      download.removeAttribute("download");
    }
  }

  function syncGutter() {
    if (!selection || !editor || body.hidden) return;
    const height = Number.parseFloat(document.defaultView.getComputedStyle(editor).lineHeight) || 22;
    const first = Math.floor(editor.scrollTop / height);
    const count = Math.ceil(editor.clientHeight / height) + 2;
    const last = Math.min(selection.lineCount, first + count);
    const numbers = [];
    for (let index = first; index < last; index++) numbers.push(String(index + 1));
    gutter.textContent = numbers.join("\n");
    gutter.style.transform = `translateY(${12 - (editor.scrollTop % height)}px)`;
  }

  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "source-reference-dialog";
    dialog.setAttribute("aria-labelledby", "source-reference-title");
    // Only fixed UI markup is assigned as HTML. File names and contents use text/value.
    dialog.innerHTML = `<section class="dialog-card source-reference-card">
      <header class="source-reference-header"><div><h2 id="source-reference-title">Source reference</h2><p data-source-context></p></div><div class="source-reference-actions"><button type="button" class="source-reference-download" data-source-toggle hidden aria-pressed="false">Source</button><a class="source-reference-download" data-source-download hidden download>Download original</a><button type="button" class="icon-button" data-source-close aria-label="Close source file">×</button></div></header>
      <p class="source-reference-notice" data-source-notice role="status" aria-live="polite"></p>
      <div class="source-reference-content"><div class="source-reference-body" data-source-body hidden><div class="source-reference-gutter" aria-hidden="true"><pre></pre></div><textarea class="source-reference-editor" aria-label="Source file contents (read-only)" readonly spellcheck="false" wrap="off"></textarea></div><div class="source-document-preview" data-document-preview hidden></div>
        <section class="source-folder-reference" data-source-folder hidden aria-label="Referenced folder">
          <div class="source-folder-heading"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 9h18"/></svg><strong data-folder-name></strong></div>
          <code class="source-folder-path" data-folder-path></code>
          <div class="source-folder-actions"><button type="button" class="source-reference-download" data-folder-reveal>Show in Finder</button><button type="button" class="source-reference-download" data-folder-copy>Copy path</button></div>
          <p class="source-folder-feedback" data-folder-copy-status role="status" aria-live="polite" hidden></p>
        </section>
      </div>
    </section>`;
    document.body.append(dialog);
    title = dialog.querySelector("h2");
    context = dialog.querySelector("[data-source-context]");
    notice = dialog.querySelector("[data-source-notice]");
    body = dialog.querySelector("[data-source-body]");
    download = dialog.querySelector("[data-source-download]");
    documentPreview = dialog.querySelector("[data-document-preview]");
    sourceToggle = dialog.querySelector("[data-source-toggle]");
    folder = dialog.querySelector("[data-source-folder]");
    folderName = dialog.querySelector("[data-folder-name]");
    folderPath = dialog.querySelector("[data-folder-path]");
    revealButton = dialog.querySelector("[data-folder-reveal]");
    copyButton = dialog.querySelector("[data-folder-copy]");
    copyStatus = dialog.querySelector("[data-folder-copy-status]");
    editor = dialog.querySelector("textarea");
    gutter = dialog.querySelector("pre");
    revealButton.addEventListener("click", () => { void revealFolder(currentFolder); });
    copyButton.addEventListener("click", () => { void copyFolderPath(currentFolder); });
    sourceToggle?.addEventListener("click", () => {
      const showSource = body.hidden;
      body.hidden = !showSource;
      documentPreview.hidden = showSource;
      sourceToggle.textContent = showSource ? "Preview" : "Source";
      sourceToggle.setAttribute("aria-pressed", String(showSource));
      notice.textContent = showSource ? sourceNotice : formattedNotice;
      if (showSource) { editor.focus({ preventScroll: true }); syncGutter(); }
    });
    dialog.querySelector("[data-source-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const findBar = document.querySelector("#find-bar");
      if (findBar && !findBar.classList.contains("hidden")) return;
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
    });
    dialog.addEventListener("close", () => {
      // Native close events are queued; a new citation may already have reopened it.
      if (dialog.open) return;
      epoch++;
      activeReference = null;
      clearPreview();
      onClose();
      selection = null;
      editor.value = "";
      if (opener?.isConnected && !document.querySelector("dialog[open]")) opener.focus({ preventScroll: true });
    });
    editor.addEventListener("scroll", syncGutter);
    if (document.defaultView.ResizeObserver) new document.defaultView.ResizeObserver(syncGutter).observe(editor);
  }

  function isCurrentFolder(reference) {
    return reference && reference === currentFolder && reference.epoch === epoch && dialog.open;
  }

  async function revealFolder(reference) {
    if (!isCurrentFolder(reference) || reference.revealing) return;
    reference.revealing = true;
    revealButton.disabled = true;
    revealButton.textContent = "Showing…";
    notice.dataset.error = "false";
    notice.textContent = "Showing folder in Finder…";
    try {
      if (typeof revealReference !== "function") throw new Error("Finder is not available here. You can copy the folder path instead.");
      // Share an in-flight reveal when the same folder is clicked again, including
      // closing/reopening the card. Only this current user-selected reference may launch it.
      let pending = pendingReveals.get(reference.path);
      if (!pending) {
        // Reuse the exact citation that metadata resolution accepted. A canonical
        // filesystem path may contain literal '#', '?', ':42', or trailing spaces
        // that would change meaning if reparsed as a newly constructed citation.
        pending = Promise.resolve(revealReference(reference.target, reference.repositoryId));
        pendingReveals.set(reference.path, pending);
        const forget = () => { if (pendingReveals.get(reference.path) === pending) pendingReveals.delete(reference.path); };
        pending.then(forget, forget);
      }
      const result = await pending;
      if (!isCurrentFolder(reference)) return;
      if (result?.opened !== true) throw new Error("Finder could not be confirmed. Try again or copy the folder path.");
      notice.textContent = "Shown in Finder · Your chat and repository remain unchanged.";
    } catch (error) {
      if (!isCurrentFolder(reference)) return;
      notice.dataset.error = "true";
      notice.textContent = error.message || "This folder could not be shown in Finder. Try again or copy its path.";
    } finally {
      reference.revealing = false;
      if (isCurrentFolder(reference)) {
        revealButton.disabled = false;
        revealButton.textContent = "Show in Finder";
      }
    }
  }

  async function copyFolderPath(reference) {
    if (!isCurrentFolder(reference) || reference.copying) return;
    reference.copying = true;
    copyButton.disabled = true;
    copyButton.textContent = "Copying…";
    copyStatus.hidden = true;
    try {
      await copyText(reference.path);
      if (!isCurrentFolder(reference)) return;
      copyButton.textContent = "Copied";
      copyStatus.dataset.error = "false";
      copyStatus.textContent = "Folder path copied.";
      copyStatus.hidden = false;
    } catch (error) {
      if (!isCurrentFolder(reference)) return;
      copyButton.textContent = "Copy path";
      copyStatus.dataset.error = "true";
      copyStatus.textContent = error.message || "The path could not be copied. Select the path above to copy it manually.";
      copyStatus.hidden = false;
    } finally {
      reference.copying = false;
      if (isCurrentFolder(reference)) copyButton.disabled = false;
    }
  }

  async function openReference(button) {
    const target = button.dataset.sourceReference;
    const repositoryId = preferredRepositoryId(button);
    const editorTarget = getEditorTarget(button);
    let loaded, loadError;
    if (editorTarget) {
      const navigationEpoch = ++epoch;
      const current = () => navigationEpoch === epoch && editorTarget.isCurrent();
      try {
        loaded = await loadReference(target, repositoryId);
        if (!current()) return;
        if (loaded.kind === "text" && loaded.repositoryId === editorTarget.repositoryId) {
          const opened = await editorTarget.open(loaded, current);
          if (opened !== false) {
            if (dialog?.open) dialog.close();
            return;
          }
          if (!current()) return;
        }
      } catch (error) {
        if (!current()) return;
        loadError = error;
      }
    }
    ensureDialog();
    if (dialog.open && activeReference?.target === target && activeReference.repositoryId === repositoryId
      && (activeReference.loading || currentFolder?.revealing)) return;
    if (showDialog) {
      if (showDialog(dialog.id) === false) return;
    } else if (!dialog.open) dialog.show();
    const requestEpoch = ++epoch;
    opener = button;
    clearPreview();
    const reference = { target, repositoryId, epoch: requestEpoch, loading: true };
    activeReference = reference;
    selection = null;
    body.hidden = true;
    editor.value = "";
    notice.dataset.error = "false";
    title.textContent = "Source reference";
    context.textContent = "Read-only · Local files and folders";
    context.removeAttribute("title");
    notice.textContent = "Opening local reference…";
    const close = dialog.querySelector("[data-source-close]");
    close.setAttribute("aria-label", "Close source file");
    close.focus({ preventScroll: true });
    try {
      if (loadError) throw loadError;
      const file = loaded || await loadReference(target, repositoryId);
      if (requestEpoch !== epoch || !dialog.open) return;
      reference.loading = false;
      if (file.kind === "directory") {
        currentFolder = { ...reference, path: file.path || file.file };
        dialog.dataset.sourceKind = "directory";
        title.textContent = "Folder reference";
        context.textContent = file.scope === "local" || !file.repositoryName ? "Local folder · Read-only" : `${file.repositoryName} · Folder`;
        context.title = currentFolder.path;
        folderName.textContent = file.name || file.file.split("/").filter(Boolean).at(-1) || file.path;
        folderPath.textContent = currentFolder.path;
        folder.hidden = false;
        revealButton.disabled = false;
        revealButton.textContent = "Show in Finder";
        copyButton.disabled = false;
        copyButton.textContent = "Copy path";
        close.setAttribute("aria-label", "Close folder reference");
        await revealFolder(currentFolder);
        return;
      }
      title.textContent = file.name || file.file.split("/").at(-1);
      context.textContent = file.scope === "local" || !file.repositoryName
        ? `Local file · ${file.path || file.file}`
        : `${file.repositoryName} · ${file.file}`;
      context.title = file.path;
      const downloadUrl = sourceReferenceContentUrl(file.downloadUrl, document.location?.origin);
      if (downloadUrl) {
        download.href = downloadUrl;
        download.download = file.name || file.file.split("/").at(-1);
        download.hidden = false;
      }
      if (file.kind === "document") {
        documentPreview.hidden = false;
        const contentUrl = sourceReferenceContentUrl(file.contentUrl, document.location?.origin);
        if (file.previewType === "pdf" && file.mimeType === "application/pdf" && contentUrl && renderPdf) {
          notice.textContent = "Preparing PDF preview… · Download original keeps the exact file format.";
          previewController = new AbortController();
          const dispose = await renderPdf(documentPreview, contentUrl, { signal: previewController.signal });
          if (requestEpoch !== epoch || !dialog.open) { dispose?.(); return; }
          disposePreview = dispose;
          notice.textContent = "PDF preview · Read-only · Download original saves the unchanged PDF.";
        } else if (file.previewType === "docx" && contentUrl && renderWord) {
          notice.textContent = "Preparing formatted Word preview…";
          previewController = new AbortController();
          const dispose = await renderWord(documentPreview, contentUrl, { signal: previewController.signal });
          if (requestEpoch !== epoch || !dialog.open) { dispose?.(); return; }
          disposePreview = dispose;
          notice.textContent = file.previewNotice
            ? `Formatted Word preview · Read-only · ${file.previewNotice}`
            : "Formatted Word preview · Read-only · Download original preserves the full document.";
        } else if (file.previewType === "text" && typeof file.content === "string") {
          const text = document.createElement("pre");
          text.className = "source-document-text";
          text.textContent = file.content;
          documentPreview.append(text);
          notice.textContent = file.previewNotice || "Plain-text document preview · Formatting is not preserved. Download original keeps the full document.";
        } else {
          const message = document.createElement("p");
          message.className = "source-document-unavailable";
          message.textContent = file.previewNotice || "This document format does not have an in-app preview. Download the original file to open it in its own application.";
          documentPreview.append(message);
          notice.textContent = "Original document available · Download keeps the exact format and contents.";
        }
        return;
      }
      selection = sourceReferenceSelection(file.content, file.line, file.column, file.endLine);
      const location = file.column ? `Line ${selection.line}, column ${file.column}` : `Line ${selection.line}`;
      const moved = file.requestedLine && file.requestedLine !== selection.line ? ` · Requested line ${file.requestedLine} is beyond this file` : "";
      sourceNotice = `${location} of ${selection.lineCount} · Read-only · Current local file${moved}`;
      notice.textContent = sourceNotice;
      editor.value = selection.content;
      body.hidden = false;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(selection.start, selection.end);
      const height = Number.parseFloat(document.defaultView.getComputedStyle(editor).lineHeight) || 22;
      editor.scrollTop = Math.max(0, (selection.line - 1) * height - editor.clientHeight / 3);
      editor.scrollLeft = 0;
      syncGutter();
      if (/\.(?:md|markdown)$/i.test(file.name || file.file)) {
        body.hidden = true;
        documentPreview.hidden = false;
        formattedNotice = "Formatted Markdown · Read-only · Source and original download remain available.";
        notice.textContent = "Preparing formatted Markdown…";
        previewController = new AbortController();
        try {
          const dispose = await renderMarkdown(documentPreview, file, { signal: previewController.signal, anchor: button.dataset.sourceMarkdownAnchor });
          if (requestEpoch !== epoch || !dialog.open) { dispose?.(); return; }
          disposePreview = dispose;
          notice.textContent = formattedNotice;
          if (sourceToggle) { sourceToggle.hidden = false; sourceToggle.textContent = "Source"; sourceToggle.setAttribute("aria-pressed", "false"); }
          dialog.querySelector("[data-source-close]").focus({ preventScroll: true });
        } catch (error) {
          if (requestEpoch !== epoch || !dialog.open) return;
          documentPreview.hidden = true;
          body.hidden = false;
          syncGutter();
          throw error;
        }
      }
    } catch (error) {
      if (requestEpoch !== epoch || !dialog.open) return;
      reference.loading = false;
      disposePreview?.();
      disposePreview = null;
      notice.dataset.error = "true";
      notice.textContent = `${error.message || "This source file could not be opened."}${download.hidden ? "" : " You can still download the original file."}`;
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-source-reference]");
    if (!button) return;
    event.preventDefault();
    void openReference(button);
  });
}
