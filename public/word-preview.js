import { localPreviewEndpoint } from "./local-preview-url.mjs";

const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_BYTES = 50 * 1024 * 1024;

export function wordPreviewEndpoint(value, origin) {
  const url = localPreviewEndpoint(value, origin);
  if (url.searchParams.get("preview") !== "docx" || url.searchParams.get("download") === "true") throw new Error("Invalid local Word preview URL.");
  return url;
}

export async function renderWordDocument(container, contentUrl, { signal, fetchFile = globalThis.fetch } = {}) {
  const document = container.ownerDocument;
  const view = document.defaultView;
  const endpoint = wordPreviewEndpoint(contentUrl, document.location.origin);
  const controller = new AbortController();
  const id = globalThis.crypto.randomUUID();
  let disposed = false;
  let rejectPending;
  let timer;
  const toolbar = document.createElement("div");
  toolbar.className = "source-word-toolbar";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.textContent = "Loading Word document…";
  const zoom = document.createElement("select");
  zoom.setAttribute("aria-label", "Word document zoom");
  for (const [value, label] of [["fit", "Fit width"], ["100", "100%"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; zoom.append(option);
  }
  toolbar.append(status, zoom);
  const frame = document.createElement("iframe");
  frame.className = "source-word-frame";
  frame.title = "Formatted Word document (read-only)";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.src = new URL("./word-preview-frame.html", import.meta.url).href;
  const receive = (event) => {
    if (disposed || event.source !== frame.contentWindow) return;
    if (event.data?.type === "argus-word-ready") readyResolve();
    if (event.data?.type === "argus-word-result" && event.data.id === id) {
      if (event.data.error || !Number.isSafeInteger(event.data.pages) || event.data.pages < 1) renderReject(new Error("This Word document could not be rendered. Download the original to open it in Word."));
      else { status.textContent = `${event.data.pages} ${event.data.pages === 1 ? "page" : "pages"} · Read-only`; renderResolve(); }
    }
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    view.clearTimeout(timer);
    signal?.removeEventListener("abort", cleanup);
    view.removeEventListener("message", receive);
    rejectPending?.(new DOMException("Document preview cancelled", "AbortError"));
    readyResolve?.();
    renderReject?.(new DOMException("Document preview cancelled", "AbortError"));
    frame.remove(); toolbar.remove();
    container.classList.remove("source-word-preview");
  };
  let readyResolve, renderResolve, renderReject;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const rendered = new Promise((resolve, reject) => { renderResolve = resolve; renderReject = reject; });
  // Attach rejection handling immediately, including while the bytes are loading.
  rendered.catch(() => {});
  view.addEventListener("message", receive);
  signal?.addEventListener("abort", cleanup, { once: true });
  if (signal?.aborted) { cleanup(); throw new DOMException("Document preview cancelled", "AbortError"); }
  container.classList.add("source-word-preview");
  container.append(toolbar, frame);
  zoom.addEventListener("change", () => frame.contentWindow?.postMessage({ type: "argus-word-zoom", zoom: zoom.value }, "*"));
  try {
    await Promise.race([
      new Promise((_resolve, reject) => {
        rejectPending = reject;
        timer = view.setTimeout(() => reject(new Error("Word preview timed out. Download the original to open it in Word.")), 45_000);
      }),
      (async () => {
        const response = await fetchFile(endpoint.href, { signal: controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error" });
        if (!response.ok) throw new Error("The Word document is unavailable or cannot be safely previewed.");
        if ((response.headers.get("content-type") || "").split(";")[0].toLowerCase() !== WORD_MIME || Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("This file is not a supported Word preview.");
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_BYTES || new Uint8Array(bytes)[0] !== 80 || new Uint8Array(bytes)[1] !== 75) throw new Error("This file is not a supported Word preview.");
        await ready;
        if (disposed) throw new DOMException("Document preview cancelled", "AbortError");
        frame.contentWindow.postMessage({ type: "argus-render-word", id, bytes }, "*", [bytes]);
        await rendered;
      })(),
    ]);
    view.clearTimeout(timer);
    rejectPending = null;
    return cleanup;
  } catch (error) { cleanup(); throw error; }
}
