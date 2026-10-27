import { renderChatMessage } from "./message-renderer.js";
import { parseSourceReferenceTarget } from "./source-reference.js";

export function markdownLocalReference(href, filePath) {
  const target = parseSourceReferenceTarget(href);
  if (!target || !filePath?.startsWith("/")) return null;
  try {
    const path = target.path.split("/").map(encodeURIComponent).join("/");
    const suffix = target.column ? `:${target.line}:${target.column}` : target.line ? `#L${target.line}${target.endLine ? `-L${target.endLine}` : ""}` : "";
    // Home paths are expanded by the server, not relative to this document.
    if (target.path.startsWith("~/")) return `${path}${suffix}`;
    const base = `file://${filePath.split("/").map(encodeURIComponent).join("/")}`;
    const resolved = new URL(path, base);
    if (resolved.protocol !== "file:" || resolved.host) return null;
    return `${resolved.pathname}${suffix}`;
  } catch { return null; }
}

// Heading fragments are renderer navigation, not part of the server file path.
// File access is validated by the server after resolving the source reference.
export function markdownDocumentLink(href, filePath) {
  const reference = markdownLocalReference(href, filePath);
  if (reference) return { reference, anchor: null };
  if (typeof href !== "string" || href.length > 8192) return null;
  const fragment = href.indexOf("#");
  if (fragment <= 0) return null;
  const path = href.slice(0, fragment);
  const target = parseSourceReferenceTarget(path);
  if (!target || !/\.(?:md|markdown)$/i.test(target.path) || target.line) return null;
  const local = markdownLocalReference(path, filePath);
  const anchor = href.slice(fragment + 1);
  try {
    if (!local || anchor.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/.test(decodeURIComponent(anchor))) return null;
  } catch { return null; }
  return { reference: local, anchor };
}

export function scrollMarkdownAnchor(article, anchor) {
  if (typeof anchor !== "string" || !anchor || anchor.length > 2048) return;
  let requested;
  try { requested = decodeURIComponent(anchor); } catch { return; }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(requested)) return;
  [...article.querySelectorAll("[data-markdown-heading]")].find((node) => node.dataset.markdownHeading === requested)?.scrollIntoView({ block: "start" });
}

export function createMarkdownDocumentRenderer(MarkdownIt, { path: filePath = "" } = {}) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, maxNesting: 40 });
  const escape = md.utils.escapeHtml;
  const link = md.renderer.rules.link_open || ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const href = token.attrGet("href") || "";
    if (/^https?:\/\//i.test(href)) {
      token.attrSet("target", "_blank"); token.attrSet("rel", "noopener noreferrer");
    } else if (href.startsWith("#")) {
      token.attrSet("data-markdown-anchor", href.slice(1)); token.attrSet("href", "#");
    } else {
      const local = markdownDocumentLink(href, filePath);
      token.attrSet("href", "#");
      if (local) {
        token.attrSet("data-source-reference", local.reference);
        if (local.anchor !== null) token.attrSet("data-source-markdown-anchor", local.anchor);
      }
      else token.attrSet("aria-disabled", "true");
    }
    token.attrSet("class", "chat-link");
    return link(tokens, index, options, env, renderer);
  };
  // No implicit network access or filesystem image loads from document content.
  // Image labels remain available; diagrams use the isolated Mermaid renderer.
  md.renderer.rules.image = (tokens, index) => `<span class="source-markdown-image">[Image: ${escape(tokens[index].content || "embedded reference")}]</span>`;
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = token.info.trim().split(/\s/)[0];
    let markerLength = 3;
    for (const match of token.content.matchAll(/`+/g)) markerLength = Math.max(markerLength, match[0].length + 1);
    const marker = "`".repeat(markerLength);
    return renderChatMessage(`${marker}${language}\n${token.content.replace(/\n$/, "")}\n${marker}`);
  };
  const heading = md.renderer.rules.heading_open || ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));
  md.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
    const text = tokens[index + 1]?.content || "section";
    const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-") || "section";
    env.headings ||= new Map();
    const count = env.headings.get(slug) || 0;
    env.headings.set(slug, count + 1);
    tokens[index].attrSet("data-markdown-heading", `${slug}${count ? `-${count}` : ""}`);
    return heading(tokens, index, options, env, renderer);
  };
  return (value) => {
    if (String(value).length > 2 * 1024 * 1024) throw new Error("This Markdown document is too large to preview.");
    return md.render(String(value), {});
  };
}

export async function renderMarkdownDocument(container, file, { signal, anchor, loadLibrary = () => import("./vendor/markdown-it/markdown-it.mjs") } = {}) {
  const { default: MarkdownIt } = await loadLibrary();
  if (signal?.aborted) throw new DOMException("Document preview cancelled", "AbortError");
  const article = container.ownerDocument.createElement("article");
  article.className = "source-markdown-document chat-rich-text";
  // Only the parser's escaped output is trusted here. Raw HTML is disabled and
  // links/images are controlled above; documents cannot inject UI event hooks.
  article.innerHTML = createMarkdownDocumentRenderer(MarkdownIt, file)(file.content);
  article.addEventListener("click", (event) => {
    const anchor = event.target.closest?.("[data-markdown-anchor]");
    if (!anchor) return;
    event.preventDefault();
    scrollMarkdownAnchor(article, anchor.dataset.markdownAnchor);
  });
  container.append(article);
  scrollMarkdownAnchor(article, anchor);
  return () => article.remove();
}
