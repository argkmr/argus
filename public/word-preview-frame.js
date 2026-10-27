/* Opaque-origin frame. No document scripts, network, forms or popups. */
(() => {
  let received = false;
  let zoom = "fit";
  const pages = document.getElementById("pages");
  const fit = () => {
    const sections = [...pages.querySelectorAll("section.argus-docx")];
    for (const section of sections) section.style.zoom = "1";
    const naturalWidth = Math.max(1, ...sections.map((section) => section.offsetWidth));
    const scale = zoom === "fit" ? Math.min(1.5, Math.max(0.1, (innerWidth - 48) / naturalWidth)) : 1;
    for (const section of sections) section.style.zoom = String(scale);
  };
  window.addEventListener("resize", fit);
  document.addEventListener("click", (event) => {
    // A Word preview never navigates its frame to a document-supplied URL.
    const link = event.target.closest?.("a");
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) document.getElementById(href.slice(1))?.scrollIntoView();
  });
  window.addEventListener("message", async (event) => {
    if (event.source !== parent) return;
    if (event.data?.type === "argus-word-zoom") { zoom = event.data.zoom === "100" ? "100" : "fit"; fit(); return; }
    if (received || event.data?.type !== "argus-render-word") return;
    const { id, bytes } = event.data;
    if (typeof id !== "string" || !(bytes instanceof ArrayBuffer) || bytes.byteLength > 50 * 1024 * 1024) return;
    received = true;
    try {
      await docx.renderAsync(bytes, pages, document.getElementById("document-styles"), {
        className: "argus-docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false,
        ignoreFonts: false, breakPages: true, ignoreLastRenderedPageBreak: false,
        renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
        renderChanges: false, renderComments: false, renderAltChunks: false,
        useBase64URL: false, experimental: false, debug: false,
      });
      pages.querySelectorAll("script,iframe,object,embed,form,input,button,textarea").forEach((element) => element.remove());
      for (const element of pages.querySelectorAll("*")) {
        for (const attribute of [...element.attributes]) if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
      fit();
      const count = pages.querySelectorAll("section.argus-docx").length;
      if (!count) throw new Error("No document pages");
      parent.postMessage({ type: "argus-word-result", id, pages: count }, "*");
    } catch {
      pages.replaceChildren();
      parent.postMessage({ type: "argus-word-result", id, error: true }, "*");
    }
  });
  parent.postMessage({ type: "argus-word-ready" }, "*");
})();
