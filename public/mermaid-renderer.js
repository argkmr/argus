const MAX_SOURCE_LENGTH = 24_000;
const blockSelector = ".chat-mermaid-block[data-mermaid-complete=\"true\"]";

export function createDiagramRenderCache(render, limit = 32) {
  const cache = new Map();
  return (source, theme) => {
    const key = `${theme}\n${source}`;
    if (cache.has(key)) return cache.get(key);
    const result = Promise.resolve().then(() => {
      if (!source.trim() || source.length > MAX_SOURCE_LENGTH) throw new Error("Diagram is empty or too large");
      return render(source, theme);
    });
    cache.set(key, result);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
    return result;
  };
}

function isolatedRenderer(document) {
  const pending = new Map();
  let frame;
  let ready;
  let serial = 0;
  const view = document.defaultView;
  const ensureFrame = () => {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      frame = document.createElement("iframe");
      frame.className = "chat-diagram-renderer";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.src = new URL("./mermaid-frame.html", import.meta.url).href;
      const timeout = view.setTimeout(() => reject(new Error("Local diagram renderer is unavailable")), 15_000);
      const receive = (event) => {
        if (event.source !== frame.contentWindow) return;
        if (event.data?.type === "argus-mermaid-ready") { view.clearTimeout(timeout); resolve(); }
        if (event.data?.type === "argus-mermaid-result") {
          const request = pending.get(event.data.id);
          if (!request) return;
          pending.delete(event.data.id);
          view.clearTimeout(request.timeout);
          if (event.data.error || typeof event.data.svg !== "string") request.reject(new Error("Diagram could not be rendered"));
          else request.resolve(event.data.svg);
        }
      };
      view.addEventListener("message", receive);
      document.body.append(frame);
    });
    return ready;
  };
  return async (source, theme) => {
    await ensureFrame();
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}_${++serial}`;
      const timeout = view.setTimeout(() => { pending.delete(id); reject(new Error("Diagram rendering timed out")); }, 15_000);
      pending.set(id, { resolve, reject, timeout });
      frame.contentWindow.postMessage({ type: "argus-render-mermaid", id, source, theme }, "*");
    });
  };
}

function withStableScroll(block, change) {
  const view = block.ownerDocument.defaultView;
  const snapshots = [];
  for (let parent = block.parentElement; parent; parent = parent.parentElement) {
    if (!/(auto|scroll)/.test(view.getComputedStyle(parent).overflowY)) continue;
    snapshots.push({ element: parent, top: parent.scrollTop, left: parent.scrollLeft,
      atBottom: parent.scrollHeight - parent.clientHeight - parent.scrollTop <= 64 });
  }
  change();
  for (const { element, top, left, atBottom } of snapshots) {
    element.scrollTop = atBottom ? element.scrollHeight : top;
    element.scrollLeft = left;
  }
}

function diagramFrame(document, svg, theme) {
  if (svg.length > 2_000_000) throw new Error("Diagram output is too large");
  const parsed = new document.defaultView.DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) throw new Error("Invalid diagram output");
  root.querySelectorAll("script,foreignObject,iframe,object,embed,image,animate,animateMotion,animateTransform,set").forEach((node) => node.remove());
  root.querySelectorAll("a").forEach((node) => node.replaceWith(...node.childNodes));
  for (const node of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || /^(?:tabindex|autofocus)$/i.test(attribute.name)
        || /(?:^|:)href$/i.test(attribute.name) && !attribute.value.startsWith("#")) node.removeAttribute(attribute.name);
    }
  }
  const safeSvg = new document.defaultView.XMLSerializer().serializeToString(root);
  const viewBox = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const width = viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : 800;
  const height = viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : 500;
  // Display in a second, script-free opaque-origin frame. Even a future Mermaid
  // sanitization regression cannot access Argus, run handlers or load resources.
  const frame = document.createElement("iframe");
  frame.className = "chat-diagram-image";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("title", "Mermaid diagram");
  frame.setAttribute("loading", "lazy");
  frame.style.width = "100%";
  frame.style.maxWidth = `${Math.max(280, Math.min(width, 2400))}px`;
  frame.style.minWidth = `${Math.min(width, 640)}px`;
  frame.style.aspectRatio = `${width} / ${height}`;
  frame.style.height = "auto";
  frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;padding:0;background:${theme === "light" ? "#f6f7f4" : "#080c10"};overflow:hidden}svg{display:block;width:100%;height:auto;max-width:none!important}a{pointer-events:none}</style></head><body>${safeSvg}</body></html>`;
  return frame;
}

export function initializeMermaidRendering(document = globalThis.document, { render } = {}) {
  if (!document?.body || !document.defaultView?.MutationObserver) return () => {};
  const states = new WeakMap();
  const cachedRender = createDiagramRenderCache(render || isolatedRenderer(document));
  const theme = () => document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const renderBlock = async (block) => {
    const code = block.querySelector("pre > code");
    if (!code || !block.isConnected) return;
    const source = code.textContent;
    const selectedTheme = theme();
    const key = `${selectedTheme}\n${source}`;
    if (states.get(block) === key) return;
    states.set(block, key);
    try {
      const svg = await cachedRender(source, selectedTheme);
      if (!block.isConnected || states.get(block) !== key || code.textContent !== source || theme() !== selectedTheme) return;
      const viewport = document.createElement("div");
      viewport.className = "chat-diagram-viewport";
      viewport.setAttribute("role", "region");
      viewport.setAttribute("aria-label", "Scrollable Mermaid diagram");
      viewport.tabIndex = 0;
      viewport.append(diagramFrame(document, svg, selectedTheme));
      withStableScroll(block, () => {
        block.querySelector(".chat-diagram-viewport")?.remove();
        block.insertBefore(viewport, code.parentElement);
        code.parentElement.hidden = true;
        const toggle = block.querySelector("[data-toggle-mermaid-source]");
        toggle.hidden = false;
        toggle.textContent = "Code";
        toggle.setAttribute("aria-pressed", "false");
        block.querySelector(".chat-diagram-status").hidden = true;
      });
    } catch {
      if (!block.isConnected || states.get(block) !== key) return;
      withStableScroll(block, () => {
        block.querySelector(".chat-diagram-viewport")?.remove();
        code.parentElement.hidden = false;
        const status = block.querySelector(".chat-diagram-status");
        status.hidden = false;
        status.textContent = source.length > MAX_SOURCE_LENGTH
          ? "Diagram is too large to display. The original code is available below."
          : "Could not display this diagram. The original code is available below.";
        block.querySelector("[data-toggle-mermaid-source]").hidden = true;
      });
    }
  };
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches(blockSelector)) void renderBlock(node);
    node.querySelectorAll(blockSelector).forEach((block) => void renderBlock(block));
  };
  const observer = new document.defaultView.MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === "attributes" && change.attributeName === "data-theme") scan(document.body);
      else if (change.type === "attributes") scan(change.target);
      else if (change.type === "characterData") {
        const block = change.target.parentElement?.closest(blockSelector);
        if (block) void renderBlock(block);
      } else change.addedNodes.forEach(scan);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-theme", "data-mermaid-complete"] });
  const toggleSource = (event) => {
    const button = event.target.closest?.("[data-toggle-mermaid-source]");
    if (!button) return;
    const block = button.closest(blockSelector);
    const source = block?.querySelector("pre");
    const viewport = block?.querySelector(".chat-diagram-viewport");
    if (!source || !viewport) return;
    withStableScroll(block, () => {
      source.hidden = !source.hidden;
      viewport.hidden = !source.hidden;
      button.textContent = source.hidden ? "Code" : "Diagram";
      button.setAttribute("aria-pressed", String(!source.hidden));
    });
  };
  document.addEventListener("click", toggleSource);
  scan(document.body);
  return () => { observer.disconnect(); document.removeEventListener("click", toggleSource); };
}
