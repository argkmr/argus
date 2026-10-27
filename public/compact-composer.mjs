// Presentation only: the existing controls remain the source of request state.
export function composerPopoverPosition(anchor, size, viewport, scale = 1) {
  const gap = 8, inset = 10;
  const top = anchor.top - size.height - gap >= inset
    ? anchor.top - size.height - gap
    : Math.min(anchor.bottom + gap, viewport.height - size.height - inset);
  return {
    left: Math.max(inset, Math.min(anchor.left, viewport.width - size.width - inset)) / scale,
    top: Math.max(inset, top) / scale,
  };
}

export function initializeCompactComposers({ document }) {
  const view = document.defaultView, entries = [], observers = [], cleanups = [];
  const listen = (node, event, callback, options) => {
    node.addEventListener(event, callback, options);
    cleanups.push(() => node.removeEventListener(event, callback, options));
  };
  const isOpen = entry => entry.panel.matches(":popover-open");
  const close = (entry, focus = false) => {
    if (isOpen(entry)) entry.panel.hidePopover();
    entry.menu.open = false;
    entry.summary.setAttribute("aria-expanded", "false");
    if (focus && entry.summary.checkVisibility()) entry.summary.focus({ preventScroll: true });
  };
  const position = entry => {
    if (!isOpen(entry)) return;
    if (!entry.summary.checkVisibility({ visibilityProperty: true })) return close(entry);
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const scale = entry.panel.getBoundingClientRect().width / entry.panel.offsetWidth || 1;
    entry.panel.style.maxWidth = `${Math.max(1, viewport.width - 20) / scale}px`;
    entry.panel.style.maxHeight = `${Math.max(1, viewport.height - 20) / scale}px`;
    const offsets = composerPopoverPosition(entry.summary.getBoundingClientRect(), entry.panel.getBoundingClientRect(), viewport, scale);
    entry.panel.style.left = `${offsets.left}px`;
    entry.panel.style.top = `${offsets.top}px`;
  };
  for (const composer of document.querySelectorAll(".compact-composer")) {
    const prefix = composer.dataset.composerScope === "global" ? "global-agent" : "agent";
    const model = composer.querySelector(`#${prefix}-model`);
    const modelLabel = composer.querySelector("[data-composer-model-label]");
    const contextSummary = composer.querySelector(".composer-context-toggle");
    const badge = contextSummary.querySelector("[data-composer-context-count]");
    const notes = composer.querySelector(".task-notes-bar");
    const repositories = composer.querySelector("#nexus-repository-picker-root");
    const history = composer.querySelector(`#${prefix}-context-mode`);
    const syncLabels = () => {
      const label = model?.selectedOptions?.[0]?.textContent || model?.value || "Choose model";
      if (modelLabel.textContent !== label) modelLabel.textContent = label;
      const enabled = Number(notes?.dataset.enabledNoteCount) || 0;
      const selected = Number(repositories?.dataset.selectedRepositoryCount) || 0;
      const parts = [enabled ? `${enabled} enabled note${enabled === 1 ? "" : "s"}` : "", history?.value === "history" ? "Previous chat context" : "", selected ? `${selected} selected repositor${selected === 1 ? "y" : "ies"}` : ""].filter(Boolean);
      badge.hidden = !parts.length;
      badge.textContent = parts.length ? String(parts.length) : "";
      contextSummary.title = parts.length ? `Attachments & context: ${parts.join(" · ")}` : "Add files, Chrome tabs, notes, or previous chat context";
      contextSummary.setAttribute("aria-label", contextSummary.title);
      const settings = composer.querySelector(".composer-model-menu > summary");
      settings.setAttribute("aria-label", `${label}. ${composer.querySelector(`#${prefix}-config-summary`)?.textContent || ""}. Model and request settings`);
    };
    listen(composer, "change", syncLabels);
    const labels = new view.MutationObserver(syncLabels);
    for (const node of [model, notes, repositories, composer.querySelector(`#${prefix}-config-summary`)]) {
      if (node) labels.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-enabled-note-count", "data-selected-repository-count"] });
    }
    observers.push(labels); syncLabels();
    for (const menu of composer.querySelectorAll(".composer-menu")) {
      const summary = menu.querySelector(":scope > summary"), panel = menu.querySelector(":scope > .composer-popover");
      const entry = { menu, summary, panel }; entries.push(entry);
      listen(summary, "click", event => {
        event.preventDefault();
        if (isOpen(entry)) return close(entry, true);
        for (const other of entries) if (other !== entry) close(other);
        menu.open = true;
        panel.showPopover({ source: summary });
        summary.setAttribute("aria-expanded", "true");
        position(entry);
      });
      listen(panel, "toggle", () => {
        summary.setAttribute("aria-expanded", String(isOpen(entry)));
        if (!isOpen(entry)) menu.open = false;
        else position(entry);
      });
      // Existing outside-click handling can close model <details> directly.
      listen(menu, "toggle", () => { if (!menu.open) close(entry); });
      listen(panel.querySelector("[data-composer-menu-close]"), "click", () => close(entry, true));
      listen(panel, "keydown", event => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault(); event.stopPropagation(); close(entry, true);
        }
      });
      const resize = new view.ResizeObserver(() => position(entry));
      resize.observe(panel); resize.observe(composer); observers.push(resize);
    }
  }
  const reposition = () => entries.forEach(position);
  listen(view, "resize", reposition);
  listen(document, "scroll", reposition, true);
  const visibility = new view.MutationObserver(reposition);
  visibility.observe(document.body, { attributes: true, attributeFilter: ["class", "data-view"] });
  visibility.observe(document.documentElement, { attributes: true, attributeFilter: ["data-font-size"] });
  observers.push(visibility);
  return { destroy() { entries.forEach(entry => close(entry)); observers.forEach(observer => observer.disconnect()); cleanups.forEach(cleanup => cleanup()); } };
}
