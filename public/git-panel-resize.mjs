export const GIT_DOCK_WIDTH_KEY = "argus-git-dock-width";
const WIDTH_PROPERTY = "--git-dock-width";
const instances = new WeakMap();

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// Keep the existing dock minimum, reserving a usable editor where the viewport permits.
export function gitPanelResizeBounds({ viewportWidth, scale = 1, minimum = 260, rail = 30, editorWidth }) {
  const zoom = positive(scale, 1);
  const embedded = positive(editorWidth, 0);
  const available = embedded || positive(viewportWidth, minimum + rail + 480) / zoom - Math.max(0, rail);
  // Compact IDEs use a drawer with a visible edge of code; wide IDEs reserve code space.
  const reserve = embedded ? (available <= 620 ? 48 : 320) : 480;
  const min = Math.min(positive(minimum, 260), embedded ? Math.max(120, Math.floor(available - reserve)) : Infinity);
  return { minimum: min, maximum: Math.max(min, Math.min(720, Math.floor(available - reserve))), scale: zoom };
}

function clamp(width, bounds) {
  return Math.max(bounds.minimum, Math.min(bounds.maximum, Math.round(width)));
}

/** Local-only layout controller; it never reads or mutates repository/chat state. */
export function setupGitPanelResize({ document, window = document.defaultView, storage } = {}) {
  if (instances.has(document)) return instances.get(document);
  const panel = document.querySelector(".git-panel");
  const body = document.body;
  if (!panel || !body) return null;
  if (storage === undefined) {
    try { storage = window.localStorage; } catch { /* Resizing still works without storage. */ }
  }
  let preferred = null;
  try { preferred = positive(storage?.getItem(GIT_DOCK_WIDTH_KEY), null); } catch { /* Optional cache. */ }
  let width = 0, drag = null, disposed = false;
  const originalWidth = body.style.getPropertyValue(WIDTH_PROPERTY);
  const handle = document.createElement("div");
  handle.className = "git-panel-resize-handle";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize Version Control");
  handle.title = "Drag to widen Version Control. Arrow keys resize; Home restores the default width.";
  if (!panel.id) panel.id = "git-panel";
  handle.setAttribute("aria-controls", panel.id);
  panel.append(handle);

  const open = () => body.classList.contains("version-control-dock-open") && body.dataset.view === "repository"
    && body.classList.contains("repository-ide-enabled")
    && !body.classList.contains("workspace-tool-active");
  const bounds = () => {
    const style = window.getComputedStyle(body);
    const rootStyle = window.getComputedStyle(document.documentElement);
    const zoomValue = (value) => String(value).endsWith("%") ? parseFloat(value) / 100 : positive(value, 1);
    const scale = zoomValue(style.zoom) * zoomValue(rootStyle.zoom);
    return gitPanelResizeBounds({
      viewportWidth: window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth,
      scale,
      minimum: parseFloat(style.getPropertyValue("--side-panel-width")) || 260,
      rail: parseFloat(style.getPropertyValue("--tools-rail-width")) || 30,
      editorWidth: panel.closest?.(".repository-ide-body")?.clientWidth,
    });
  };
  const paint = (value, limits) => {
    width = clamp(value, limits);
    const pixels = `${width}px`;
    if (body.style.getPropertyValue(WIDTH_PROPERTY) !== pixels) body.style.setProperty(WIDTH_PROPERTY, pixels);
    handle.setAttribute("aria-valuemin", String(limits.minimum));
    handle.setAttribute("aria-valuemax", String(limits.maximum));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", `${width} pixels wide`);
  };
  const persist = () => {
    try {
      if (preferred === null) storage?.removeItem(GIT_DOCK_WIDTH_KEY);
      else storage?.setItem(GIT_DOCK_WIDTH_KEY, String(preferred));
    } catch { /* The current session remains resized when the cache is unavailable. */ }
  };
  function finish(commit) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (!commit) preferred = previous.preferred;
    handle.classList.remove("dragging");
    body.classList.remove("git-panel-resizing");
    try { handle.releasePointerCapture(previous.id); } catch { /* Capture may already be lost. */ }
    if (commit) persist();
    refresh();
  }
  function refresh() {
    if (disposed) return;
    if (drag && !open()) { finish(false); return; }
    const limits = bounds();
    paint(preferred ?? limits.minimum, limits);
    if (drag && drag.scale !== limits.scale) {
      // Re-anchor rather than jumping if appearance zoom changes during a gesture.
      drag.startWidth = width;
      drag.startX = drag.lastX;
      drag.scale = limits.scale;
    }
  }
  const down = (event) => {
    if (!open() || drag || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    refresh();
    const limits = bounds();
    drag = { id: event.pointerId, startX: event.clientX, lastX: event.clientX, startWidth: width, preferred, scale: limits.scale };
    handle.focus({ preventScroll: true });
    handle.classList.add("dragging");
    body.classList.add("git-panel-resizing");
    try { handle.setPointerCapture(event.pointerId); } catch { /* Window listeners cover unsupported capture. */ }
  };
  const move = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!open()) { finish(false); return; }
    event.preventDefault();
    const limits = bounds();
    preferred = clamp(drag.startWidth + (event.clientX - drag.startX) / drag.scale, limits);
    drag.lastX = event.clientX;
    paint(preferred, limits);
  };
  const up = (event) => { if (drag?.id === event.pointerId) finish(true); };
  const cancel = (event) => { if (drag?.id === event.pointerId) finish(false); };
  const blur = () => finish(false);
  const keydown = (event) => {
    if (event.key === "Escape" && drag) { event.preventDefault(); finish(false); return; }
    if (!open() || event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    finish(false);
    refresh();
    const limits = bounds();
    preferred = event.key === "Home" ? null : clamp(width + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 10), limits);
    paint(preferred ?? limits.minimum, limits);
    persist();
  };
  handle.addEventListener("pointerdown", down);
  handle.addEventListener("keydown", keydown);
  handle.addEventListener("lostpointercapture", cancel);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", blur);
  window.addEventListener("resize", refresh);
  window.visualViewport?.addEventListener("resize", refresh);
  const observer = window.MutationObserver ? new window.MutationObserver(refresh) : null;
  observer?.observe(body, { attributes: true, attributeFilter: ["style", "class", "data-view"] });
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-font-size"] });
  const resizeObserver = window.ResizeObserver ? new window.ResizeObserver(refresh) : null;
  resizeObserver?.observe(panel);
  refresh();
  const controller = {
    handle,
    refresh,
    destroy() {
      if (disposed) return;
      finish(false);
      disposed = true;
      observer?.disconnect();
      resizeObserver?.disconnect();
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("keydown", keydown);
      handle.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("resize", refresh);
      handle.remove();
      if (originalWidth) body.style.setProperty(WIDTH_PROPERTY, originalWidth);
      else body.style.removeProperty(WIDTH_PROPERTY);
      instances.delete(document);
    },
  };
  instances.set(document, controller);
  return controller;
}
