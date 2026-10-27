import { createStableHtmlRenderer } from "./stable-html-renderer.mjs";

/**
 * Preserve a formatted response while polling changes only its job metadata.
 * Nested content may legitimately change after rendering (diagrams, code toggles
 * and selections); only replacing the root's children invalidates this snapshot.
 */
export function createChatContentRenderer(renderMessage) {
  if (typeof renderMessage !== "function") throw new TypeError("A safe chat message renderer is required");
  const rendered = new WeakMap();
  const renderHtml = createStableHtmlRenderer({
    // Changed diagram source must be enhanced again; an unchanged diagram must
    // keep its existing iframe and its user's Code/Diagram toggle state.
    replaceChanged: node => node.classList?.contains("chat-mermaid-block"),
  });

  return function renderChatContent(target, value = "") {
    if (!target || typeof target !== "object") throw new TypeError("A chat content element is required");
    const source = String(value ?? "");
    const previous = rendered.get(target);
    const children = target.childNodes;
    if (previous?.source === source && children && previous.children
      && children.length === previous.children.length
      && previous.children.every((child, index) => children[index] === child)) return false;

    // Keep escaping, link safety and streaming fence handling in the existing
    // renderer. A failed render must never mark an unwritten response as cached.
    renderHtml(target, renderMessage(source));
    rendered.set(target, { source, children: target.childNodes ? Array.from(target.childNodes) : null });
    return true;
  };
}
