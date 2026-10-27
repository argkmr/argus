// Local layout only: no repository reads, network calls, or chat state changes.
export function createIdeSplitter({ document, container, handle, property, storage, storageKey, getLayout, onResize = () => {} }) {
  const window = document.defaultView;
  if (storage === undefined) { try { storage = window.localStorage; } catch { /* Optional preference store. */ } }
  let context = null, enabled = false, preferred = null, preferenceKey = null, width = 0, drag = null, disposed = false;
  const memory = new Map(), original = container.style.getPropertyValue(property);
  const clamp = (value, layout) => Math.round(Math.max(layout.minimum, Math.min(layout.maximum, value)));
  const readLayout = () => {
    if (!enabled || disposed) return null;
    const value = getLayout();
    if (!value || !["x", "y"].includes(value.axis) || ![value.minimum, value.maximum, value.initial].every(Number.isFinite)) return null;
    return { ...value, maximum: Math.max(value.minimum, value.maximum) };
  };
  const scale = axis => {
    const rect = container.getBoundingClientRect();
    const measured = axis === "x" ? rect.width / container.offsetWidth : rect.height / container.offsetHeight;
    return Number.isFinite(measured) && measured > 0 ? measured : 1;
  };
  function loadPreference(layout) {
    const key = `${storageKey}:${context}:${layout.axis}`;
    if (key === preferenceKey) return;
    preferenceKey = key;
    preferred = memory.get(key) ?? null;
    if (!memory.has(key)) {
      try { const value = Number(storage?.getItem(key)); if (Number.isFinite(value) && value > 0) preferred = value; } catch { /* Keep usable without storage. */ }
    }
  }
  function persist() {
    if (!preferenceKey) return;
    memory.set(preferenceKey, preferred);
    try { if (preferred === null) storage?.removeItem(preferenceKey); else storage?.setItem(preferenceKey, String(preferred)); } catch { /* Keep the session layout. */ }
  }
  function paint(value, layout) {
    width = clamp(value, layout);
    container.style.setProperty(property, `${width}px`);
    handle.dataset.axis = layout.axis;
    handle.setAttribute("aria-orientation", layout.axis === "x" ? "vertical" : "horizontal");
    handle.setAttribute("aria-valuemin", String(Math.round(layout.minimum)));
    handle.setAttribute("aria-valuemax", String(Math.round(layout.maximum)));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", `${width} pixels ${layout.axis === "x" ? "wide" : "high"}`);
    onResize(width, layout.axis);
  }
  function finish(commit) {
    if (!drag) return;
    const previous = drag; drag = null;
    if (!commit) preferred = previous.preferred;
    previous.shield.remove();
    handle.classList.remove("dragging");
    try { handle.releasePointerCapture(previous.id); } catch { /* Already released. */ }
    if (commit) persist();
    refresh();
  }
  function refresh() {
    if (disposed) return;
    const layout = readLayout();
    if (drag && (!layout || layout.axis !== drag.axis)) finish(false);
    handle.hidden = !layout;
    if (!layout) return;
    loadPreference(layout);
    paint(preferred ?? layout.initial, layout);
    if (drag) {
      // Re-anchor after viewport/zoom changes instead of jumping on the next move.
      drag.start = drag.last;
      drag.width = width;
      drag.scale = scale(layout.axis);
    }
  }
  const down = event => {
    const layout = readLayout();
    if (!layout || drag || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault(); event.stopPropagation(); refresh();
    const shield = document.createElement("div");
    shield.className = "ide-splitter-drag-shield";
    shield.setAttribute("aria-hidden", "true");
    Object.assign(shield.style, { position: "fixed", inset: "0", zIndex: "2147483647", cursor: layout.axis === "x" ? "col-resize" : "row-resize", touchAction: "none", userSelect: "none" });
    document.body.append(shield);
    const coordinate = layout.axis === "x" ? event.clientX : event.clientY;
    drag = { id: event.pointerId, axis: layout.axis, start: coordinate, last: coordinate, width, preferred, scale: scale(layout.axis), shield };
    handle.focus({ preventScroll: true });
    handle.classList.add("dragging");
    try { handle.setPointerCapture(event.pointerId); } catch { /* Shield/window listeners cover the iframe boundary. */ }
  };
  const move = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const layout = readLayout();
    if (!layout || layout.axis !== drag.axis) { finish(false); return; }
    event.preventDefault();
    drag.last = layout.axis === "x" ? event.clientX : event.clientY;
    preferred = clamp(drag.width + (drag.last - drag.start) / drag.scale * (layout.reverse ? -1 : 1), layout);
    paint(preferred, layout);
  };
  const up = event => { if (drag?.id === event.pointerId) finish(true); };
  const cancel = event => { if (drag?.id === event.pointerId) finish(false); };
  const blur = () => finish(false);
  const escape = event => { if (drag && event.key === "Escape") { event.preventDefault(); finish(false); } };
  const reset = event => {
    const layout = readLayout(); if (!layout) return;
    event.preventDefault(); finish(false); preferred = null; persist(); paint(layout.initial, layout);
  };
  const key = event => {
    escape(event);
    const layout = readLayout();
    if (!layout || event.altKey || event.metaKey || event.ctrlKey) return;
    const previous = layout.axis === "x" ? "ArrowLeft" : "ArrowUp", next = layout.axis === "x" ? "ArrowRight" : "ArrowDown";
    if (![previous, next, "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); finish(false); refresh();
    preferred = event.key === "Home" ? null : event.key === "End" ? layout.maximum : clamp(width + (event.key === next ? 1 : -1) * (layout.reverse ? -1 : 1) * (event.shiftKey ? 40 : 10), layout);
    persist(); paint(preferred ?? layout.initial, layout);
  };
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.title = "Drag to resize. Arrow keys adjust; Home or double-click resets; Escape cancels a drag.";
  const listeners = [
    [handle, "pointerdown", down], [handle, "lostpointercapture", cancel], [handle, "keydown", key], [handle, "dblclick", reset],
    [window, "pointermove", move], [window, "pointerup", up], [window, "pointercancel", cancel], [window, "blur", blur],
    [window, "keydown", escape], [window, "resize", refresh], [window.visualViewport, "resize", refresh],
  ];
  for (const [target, type, fn] of listeners) target?.addEventListener(type, fn);
  const observer = window.ResizeObserver ? new window.ResizeObserver(refresh) : null;
  observer?.observe(container);
  handle.hidden = true;
  return {
    handle, refresh,
    setContext(id, on = true) {
      const next = id == null ? null : String(id), active = Boolean(on && next);
      if (context !== next || enabled !== active) { finish(false); context = next; enabled = active; preferenceKey = null; }
      refresh();
    },
    dispose() {
      if (disposed) return;
      finish(false); disposed = true; observer?.disconnect();
      for (const [target, type, fn] of listeners) target?.removeEventListener(type, fn);
      if (original) container.style.setProperty(property, original); else container.style.removeProperty(property);
      handle.hidden = true;
    },
  };
}
