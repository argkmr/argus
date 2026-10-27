// Dismiss the IDE's task-history overlay without touching chat/navigation state.
export function createRepositoryTaskDrawer({ document, getEnabled, onClose }) {
  const panel = document.querySelector("#repository-task-sidebar");
  const toggle = document.querySelector("#repository-chat-history-toggle") || document.querySelector("#workspace-task-rail-toggle");
  const close = document.querySelector("#repository-task-history-close");
  const window = document.defaultView;
  let disposed = false, frameFocusTimer = null;

  const enabled = () => !disposed && Boolean(panel && getEnabled());
  const topLayerOpen = () => Boolean(document.querySelector("dialog:modal, [popover]:popover-open"));
  const inside = target => Boolean(target && (panel?.contains(target) || toggle?.contains(target)));

  function dismiss({ restoreFocus = false } = {}) {
    if (!enabled()) return false;
    onClose();
    if (restoreFocus) toggle?.focus({ preventScroll: true });
    return true;
  }

  const closeClick = () => dismiss({ restoreFocus: true });
  const outside = event => {
    if (!enabled() || !event.target || inside(event.target) || topLayerOpen()) return;
    // Let the original click/focus reach its target; dismissing must not steal it.
    dismiss();
  };
  const keydown = event => {
    if (event.key !== "Escape" || event.defaultPrevented || !enabled() || topLayerOpen()
      || event.target?.closest?.(".task-title-input")) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss({ restoreFocus: true });
  };
  const windowBlur = () => {
    if (!enabled() || !window) return;
    if (frameFocusTimer !== null) window.clearTimeout(frameFocusTimer);
    // Pointer/focus events inside the editor iframe do not reach this document.
    // Wait one turn for activeElement to settle, without treating app blur as a click.
    frameFocusTimer = window.setTimeout(() => {
      frameFocusTimer = null;
      const target = document.activeElement;
      if (target?.tagName === "IFRAME") outside({ target });
    }, 0);
  };

  close?.addEventListener("click", closeClick);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("focusin", outside, true);
  // Bubble after editor/rename controls have had an opportunity to handle Escape.
  document.addEventListener("keydown", keydown);
  window?.addEventListener("blur", windowBlur);

  return {
    dismiss,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frameFocusTimer !== null) window.clearTimeout(frameFocusTimer);
      frameFocusTimer = null;
      close?.removeEventListener("click", closeClick);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", keydown);
      window?.removeEventListener("blur", windowBlur);
    },
  };
}
