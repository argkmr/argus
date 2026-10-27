// A native top-layer popover stays usable beside the editor, even when the
// conversation scrolls inside a clipped or very narrow dock. No data is fetched.
export function createAiContextHeader({ document, window = document.defaultView }) {
  const find = id => document.getElementById(id);
  const trigger = find("local-ai-info-toggle"), panel = find("local-ai-details");
  const closeButton = find("local-ai-details-close");
  if (!trigger || !panel) return { update() {}, close() {}, dispose() {} };
  let disposed = false;
  const open = () => panel.matches(":popover-open");
  const syncExpanded = () => trigger.setAttribute("aria-expanded", String(open()));
  const inside = target => target && (trigger.contains(target) || panel.contains(target));

  function close(restoreFocus = false) {
    if (open()) panel.hidePopover();
    syncExpanded();
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function position() {
    if (!open()) return;
    if (!trigger.checkVisibility()) { close(); return; }
    const viewport = document.documentElement;
    const scale = panel.getBoundingClientRect().width / panel.offsetWidth || 1;
    panel.style.maxWidth = `${Math.max(1, viewport.clientWidth - 24) / scale}px`;
    panel.style.maxHeight = `${Math.max(1, viewport.clientHeight - 24) / scale}px`;
    const anchor = trigger.getBoundingClientRect(), size = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(anchor.right - size.width, viewport.clientWidth - size.width - 12)) / scale}px`;
    panel.style.top = `${Math.max(12, Math.min(anchor.bottom + 6, viewport.clientHeight - size.height - 12)) / scale}px`;
  }

  const toggle = () => {
    if (open()) close();
    else { panel.showPopover(); syncExpanded(); position(); closeButton?.focus({ preventScroll: true }); }
  };
  const dismiss = () => close(true);
  const keydown = event => {
    if (event.key !== "Escape" || !open() || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation(); close(true);
  };
  const outsideFocus = event => { if (open() && !inside(event.target)) close(); };
  trigger.addEventListener("click", toggle);
  closeButton?.addEventListener("click", dismiss);
  panel.addEventListener("toggle", syncExpanded);
  document.addEventListener("keydown", keydown);
  document.addEventListener("focusin", outsideFocus);
  document.addEventListener("scroll", position, true);
  window?.addEventListener("resize", position);
  const observer = window?.ResizeObserver ? new window.ResizeObserver(position) : null;
  observer?.observe(trigger);

  return {
    update({ providerName = "No AI", status = "Checking connection", readiness = "checking", repositoryName = "Repository AI", mode = "edit" } = {}) {
      if (disposed) return;
      find("local-ai-summary-provider").textContent = providerName;
      find("local-ai-summary-repository").textContent = repositoryName;
      find("local-ai-summary-status").dataset.state = ["ready", "warning", "off"].includes(readiness) ? readiness : "checking";
      find("local-ai-summary-mode").textContent = mode === "plan" ? "Plan" : "Edit";
      const access = mode === "plan" ? "Read-only investigation" : "Can edit and use Git";
      trigger.title = `${providerName}: ${status}\n${repositoryName} · ${access}\nShow AI context details`;
      trigger.setAttribute("aria-label", `${providerName}: ${status}. ${repositoryName}. ${access}. Show AI context details`);
      position();
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true; close(); observer?.disconnect();
      trigger.removeEventListener("click", toggle);
      closeButton?.removeEventListener("click", dismiss);
      panel.removeEventListener("toggle", syncExpanded);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", outsideFocus);
      document.removeEventListener("scroll", position, true);
      window?.removeEventListener("resize", position);
    },
  };
}
