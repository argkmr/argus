/* Runs only inside the opaque-origin, network-blocked rendering frame. */
(() => {
  let queue = Promise.resolve();
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.type !== "argus-render-mermaid") return;
    const { id, source, theme } = event.data;
    if (typeof id !== "string" || typeof source !== "string") return;
    queue = queue.then(async () => {
      try {
        if (!source.trim() || source.length > 24_000) throw new Error("Diagram size is unsupported");
        // Source-level configuration is never authoritative over the renderer's
        // safety limits, theme, HTML policy, or CSS. Keep the original for Copy.
        let definition = source.replace(/^\s*---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "").replace(/%%\{[\s\S]*?\}%%/g, "");
        mermaid.initialize({
          startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
          theme: theme === "light" ? "default" : "dark", htmlLabels: false,
          fontFamily: "Arial, sans-serif", maxTextSize: 24_000, maxEdges: 250,
          flowchart: { htmlLabels: false },
          secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "htmlLabels", "theme", "themeCSS", "fontFamily", "dompurifyConfig"],
        });
        // Mermaid treats bare semicolons as statement delimiters. AI-generated
        // sequence notes often use them as punctuation. Only retry invalid
        // sequences, and never alter a note containing another arrow statement.
        if (/^\s*sequenceDiagram\b/m.test(definition) && !await mermaid.parse(definition, { suppressErrors: true })) {
          definition = definition.replace(/^(\s*Note\s+(?:over|right of|left of)\s+[^:\n]+:)(.*)$/gim, (line, prefix, text) =>
            /;[^\n]*(?:->|-->)/.test(text) ? line : prefix + text.replace(/(#[a-zA-Z0-9]+;)|;/g, (_match, entity) => entity || "#59;"));
        }
        const { svg } = await mermaid.render(`argusDiagram${id.replace(/[^a-zA-Z0-9]/g, "")}`, definition);
        if (svg.length > 2_000_000) throw new Error("Diagram output is too large");
        parent.postMessage({ type: "argus-mermaid-result", id, svg }, "*");
      } catch {
        // Never return raw parser errors; they can contain arbitrary source HTML.
        parent.postMessage({ type: "argus-mermaid-result", id, error: true }, "*");
      } finally {
        document.body.replaceChildren();
      }
    });
  });
  parent.postMessage({ type: "argus-mermaid-ready" }, "*");
})();
