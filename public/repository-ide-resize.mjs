import { createIdeSplitter } from "./ide-splitter.mjs";

export function createRepositoryWorkbenchResize({ document, storage }) {
  const container = document.querySelector("#repository-workbench"), host = document.querySelector("#repository-ide-host");
  if (!container || !host) return null;
  const handle = document.createElement("div");
  handle.id = "repository-workbench-resizer";
  handle.className = "ide-splitter repository-workbench-resizer";
  handle.setAttribute("aria-label", "Resize editor and AI chat");
  handle.setAttribute("aria-controls", "repository-ide-host");
  host.after(handle);
  const controller = createIdeSplitter({ document, container, handle, storage,
    // A new width preference must not reinterpret an older editor-height value.
    property: "--ide-chat-width", storageKey: "argus.repositoryIde.chatWidth.v1",
    getLayout() {
      const style = document.defaultView.getComputedStyle?.(container);
      const padding = (Number.parseFloat(style?.paddingLeft) || 0) + (Number.parseFloat(style?.paddingRight) || 0);
      const available = container.clientWidth - padding;
      const compact = available < 720;
      container.dataset.chatLayout = compact ? "overlay" : "split";
      if (compact) return null;
      if (document.body.classList.contains("repository-ide-chat-hidden")) return null;
      const total = available - 6;
      if (!(total > 0)) return null;
      return { axis: "x", reverse: true, minimum: 280, maximum: Math.min(640, total - 360), initial: Math.min(480, Math.max(320, total * .36)) };
    },
  });
  return { setContext: controller.setContext, refresh: controller.refresh, dispose() { controller.dispose(); delete container.dataset.chatLayout; handle.remove(); } };
}
