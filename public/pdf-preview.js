import { localPreviewEndpoint } from "./local-preview-url.mjs";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 8_000_000;

async function loadPdfLibrary() {
  const library = await import("./vendor/pdfjs/pdf.mjs");
  library.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;
  return library;
}

export function pdfPageViewport(page, availableWidth, pixelRatio = 1) {
  const natural = page.getViewport({ scale: 1 });
  if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width <= 0 || natural.height <= 0) throw new Error("This PDF has invalid page dimensions.");
  if (natural.width / natural.height < 0.02 || natural.width / natural.height > 50) throw new Error("This PDF page has unsupported proportions. Download the original to view it.");
  const width = Math.min(1600, Math.max(240, Number(availableWidth) || 800));
  const scale = Math.min(width / natural.width, 2);
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(Math.max(1, Number(pixelRatio) || 1), 2, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
  return { viewport, ratio };
}

// Canvas-only PDF.js rendering: no PDF JavaScript, forms, HTML annotation layer,
// document links, or remote document services are enabled. PDF parsing uses a worker.
export async function renderPdfDocument(container, contentUrl, { signal, loadLibrary = loadPdfLibrary, fetchFile = globalThis.fetch } = {}) {
  const document = container.ownerDocument;
  const view = document.defaultView;
  const endpoint = localPreviewEndpoint(contentUrl, document.location.origin);
  let disposed = false;
  let destroyed = false;
  let loadingTask, pdf, renderTask, observer, resizeTimer;
  let pageNumber = 1;
  let rendering = Promise.resolve();
  const controller = new AbortController();
  const toolbar = document.createElement("div");
  toolbar.className = "source-pdf-toolbar";
  const previous = document.createElement("button");
  previous.type = "button";
  previous.textContent = "Previous page";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Next page";
  previous.disabled = next.disabled = true;
  toolbar.append(previous, status, next);
  const pageArea = document.createElement("div");
  pageArea.className = "source-pdf-page";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  pageArea.append(canvas);
  container.append(toolbar, pageArea);
  const destroyLoading = () => {
    if (!loadingTask || destroyed) return;
    destroyed = true;
    loadingTask.destroy()?.catch?.(() => {});
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    signal?.removeEventListener("abort", cleanup);
    observer?.disconnect();
    if (resizeTimer) view.clearTimeout(resizeTimer);
    renderTask?.cancel();
    destroyLoading();
    canvas.width = canvas.height = 0;
    toolbar.remove();
    pageArea.remove();
  };
  signal?.addEventListener("abort", cleanup, { once: true });
  if (signal?.aborted) { cleanup(); throw new DOMException("Document preview cancelled", "AbortError"); }
  const timeout = view.setTimeout(() => controller.abort(), 45_000);
  try {
    const [library, response] = await Promise.all([loadLibrary(), fetchFile(endpoint.href, { signal: controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error" })]);
    if (!response.ok) throw new Error("Could not load this PDF. The original file may have changed or become unavailable.");
    if (!/^application\/pdf(?:;|$)/i.test(response.headers.get("content-type") || "")) throw new Error("The selected file is not a PDF preview.");
    if (Number(response.headers.get("content-length")) > MAX_PDF_BYTES) throw new Error("This PDF is too large to preview.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (disposed || controller.signal.aborted) throw new DOMException("Document preview cancelled", "AbortError");
    if (bytes.length > MAX_PDF_BYTES || !new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) throw new Error("The selected file is not a supported PDF.");
    loadingTask = library.getDocument({
      data: bytes, isEvalSupported: false, enableXfa: false, useSystemFonts: false,
      cMapUrl: new URL("./vendor/pdfjs/cmaps/", import.meta.url).href, cMapPacked: true,
      standardFontDataUrl: new URL("./vendor/pdfjs/standard_fonts/", import.meta.url).href,
      wasmUrl: new URL("./vendor/pdfjs/wasm/", import.meta.url).href,
      disableAutoFetch: true, disableStream: true, maxImageSize: 16_000_000,
      canvasMaxAreaInBytes: 64_000_000, verbosity: 0,
    });
    const onTimeout = destroyLoading;
    controller.signal.addEventListener("abort", onTimeout, { once: true });
    pdf = await loadingTask.promise;
    if (disposed) throw new DOMException("Document preview cancelled", "AbortError");
    const renderPage = async () => {
      if (disposed) return;
      previous.disabled = next.disabled = true;
      status.textContent = `Page ${pageNumber} of ${pdf.numPages} · Rendering…`;
      const page = await pdf.getPage(pageNumber);
      if (disposed) { page.cleanup?.(); return; }
      const { viewport, ratio } = pdfPageViewport(page, container.clientWidth - 40, view.devicePixelRatio);
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute("aria-label", `PDF page ${pageNumber} of ${pdf.numPages}`);
      renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0], annotationMode: library.AnnotationMode.DISABLE });
      try { await renderTask.promise; }
      finally { page.cleanup?.(); renderTask = null; }
      if (disposed) return;
      status.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
      previous.disabled = pageNumber <= 1;
      next.disabled = pageNumber >= pdf.numPages;
    };
    const enqueue = () => {
      rendering = rendering.catch(() => {}).then(renderPage).catch((error) => {
        if (disposed) return;
        status.textContent = "Could not render this page. Download the original to view it.";
        previous.disabled = pageNumber <= 1;
        next.disabled = pageNumber >= pdf.numPages;
        throw error;
      });
      return rendering;
    };
    const changePage = (difference) => {
      pageNumber += difference;
      previous.disabled = next.disabled = true;
      container.scrollTop = 0;
      void enqueue().catch(() => {});
    };
    previous.addEventListener("click", () => { if (!previous.disabled) changePage(-1); });
    next.addEventListener("click", () => { if (!next.disabled) changePage(1); });
    await enqueue();
    if (view.ResizeObserver) {
      let width = container.clientWidth;
      observer = new view.ResizeObserver(() => {
        if (disposed || width === container.clientWidth) return;
        width = container.clientWidth;
        view.clearTimeout(resizeTimer);
        resizeTimer = view.setTimeout(() => { void enqueue().catch(() => {}); }, 150);
      });
      observer.observe(container);
    }
    return cleanup;
  } catch (error) {
    cleanup();
    if (error?.name === "PasswordException") throw new Error("This PDF is password-protected. Download the original to open it securely.");
    throw error;
  } finally { view.clearTimeout(timeout); }
}
