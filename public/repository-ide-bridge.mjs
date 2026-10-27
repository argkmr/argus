import { createRepositoryWorkbenchResize } from "./repository-ide-resize.mjs";
// Tiny shell integration: importing this file does not load Monaco or start a language server.
export function createRepositoryIdeBridge({ document, storage, api, getRepository, onError, onFileSaved, onVisibilityChange = () => {}, onChatVisibilityChange = () => {}, onNavigationChange = () => {}, getVersionControlOpen, onVersionControlToggle, onVersionControlMount, getRunState, onRunAction, onRunSelect, onRunConfigure, onTerminalToggle, onTerminalHide, onTerminalMount, getCodeChatSettings, onCodeChatOpenTask, onCodeDiscussionChanged, load = () => import("./repository-ide.mjs") }) {
  let instance, loaded, desired = null, epoch = 0;
  let visible = false, resize, chatPresentation = "";
  let queue = Promise.resolve();
  const host = document.querySelector("#repository-ide-host");
  const button = document.querySelector("#repository-chat-toggle");
  const chatVisible = () => { try { return storage.getItem(`argus-ide-chat:${getRepository()?.id}`) !== "hidden"; } catch { return true; } };
  function setChatVisible(show) {
    const repository = getRepository();
    if (!repository) return;
    try { storage.setItem(`argus-ide-chat:${repository.id}`, show ? "visible" : "hidden"); }
    catch { onError(new Error("Chat visibility preference could not be saved")); return; }
    presentation(repository, visible);
    onChatVisibilityChange(Boolean(show));
    onNavigationChange();
  }
  function presentation(repository, on) {
    host.hidden = !on;
    document.body.classList.toggle("repository-ide-enabled", on);
    document.body.classList.toggle("repository-ide-chat-hidden", on && !chatVisible());
    if (on) resize ||= createRepositoryWorkbenchResize({ document, storage });
    resize?.setContext(repository?.id, on && chatVisible());
    const showChat = on && chatVisible();
    button.disabled = !repository || !on;
    button.setAttribute("aria-pressed", String(showChat));
    button.setAttribute("aria-expanded", String(showChat));
    button.setAttribute("aria-label", showChat ? "Hide AI chat" : "Show AI chat");
    button.title = showChat ? "Hide AI chat · keep working in code" : "Show AI chat beside code";
    if (visible !== on) { visible = on; onVisibilityChange(on); }
    const nextChatPresentation = JSON.stringify([repository?.id, on, showChat]);
    if (chatPresentation !== nextChatPresentation) {
      chatPresentation = nextChatPresentation;
      instance?.syncChatVisibility?.();
    }
    instance?.syncVersionControlState?.();
  }
  function sync(visible = true, { focus = true } = {}) {
    const repository = getRepository();
    // Code is the repository's default surface. Legacy disabled preferences
    // must not turn a repository or a restored navigation entry back into chat-only mode.
    const on = Boolean(visible && repository);
    const id = on ? repository.id : null;
    presentation(repository, on);
    if (desired === id) return queue;
    desired = id;
    const revision = ++epoch;
    // Cancel a currently loading editor immediately, not after its loading promise.
    const stopped = instance ? Promise.resolve(instance.deactivate()) : Promise.resolve();
    queue = queue.catch(() => {}).then(async () => {
      await stopped;
      if (revision !== epoch) return;
      if (!on) return;
      if (!loaded) loaded = load().catch(error => { loaded = null; throw error; });
      const module = await loaded;
      if (revision !== epoch) return;
      instance ||= module.createRepositoryIde({ host, document, api, onError, onFileSaved,
        getVersionControlOpen: id => visible && desired === id && getRepository()?.id === id && Boolean(getVersionControlOpen?.(id)),
        onVersionControlToggle: typeof onVersionControlToggle === "function" ? id => visible && desired === id && getRepository()?.id === id ? onVersionControlToggle(id) : false : undefined,
        onVersionControlMount,
        getRunState, onRunAction, onRunSelect, onRunConfigure, onTerminalToggle, onTerminalHide, onTerminalMount,
        getCodeChatSettings, onCodeChatOpenTask, onCodeDiscussionChanged,
        onNavigationChange: (location, options) => { if (visible && desired === getRepository()?.id) onNavigationChange(location, options); },
      });
      await instance.activate(repository, { focus });
    }).catch(error => { if (revision === epoch) { desired = null; onError(error); } });
    return queue;
  }
  async function enable(repositoryId, { focus = true } = {}) {
    if (getRepository()?.id !== repositoryId) return false;
    await sync(true, { focus });
    return desired === repositoryId && getRepository()?.id === repositoryId && Boolean(instance);
  }
  async function setEnabled(repositoryId, on, { focus = false } = {}) {
    // Compatibility for older history snapshots: false no longer disables code.
    // Leaving the repository still uses sync(false), without discarding its buffers.
    return enable(repositoryId, { focus });
  }
  async function openDiff(repositoryId, payload, isCurrent = () => true) {
    if (!visible || desired !== repositoryId || getRepository()?.id !== repositoryId || !isCurrent()) return false;
    const revision = epoch;
    await queue;
    if (revision !== epoch || !visible || desired !== repositoryId || !instance || getRepository()?.id !== repositoryId || !isCurrent()) return false;
    return instance.openDiff(payload);
  }
  async function restoreLocation(repositoryId, location, isCurrent = () => true) {
    if (!isCurrent() || !await enable(repositoryId, { focus: false }) || desired !== repositoryId || !isCurrent()) return false;
    const revision = epoch;
    return instance.restoreLocation?.(location, () => isCurrent() && epoch === revision && desired === repositoryId && getRepository()?.id === repositoryId);
  }
  async function revealNavigation(repositoryId, source, result, isCurrent = () => true) {
    if (!isCurrent() || getRepository()?.id !== repositoryId) return false;
    if (!await enable(repositoryId, { focus: false })) return false;
    if (!isCurrent() || getRepository()?.id !== repositoryId || desired !== repositoryId) return false;
    const revision = epoch;
    return instance.revealNavigation(source, result, () => isCurrent() && epoch === revision && desired === repositoryId && getRepository()?.id === repositoryId);
  }
  button.addEventListener("click", () => {
    const repository = getRepository();
    if (!repository || !visible || desired !== repository.id) return;
    setChatVisible(!chatVisible());
  });
  document.defaultView?.addEventListener("beforeunload", event => {
    if (!instance?.isDirty()) return;
    event.preventDefault(); event.returnValue = "";
  });
  presentation(getRepository(), false);
  return { sync, enable, setEnabled, openDiff, restoreLocation, revealNavigation, setChatVisible,
    openSourceReference: async (repositoryId, file, isCurrent = () => true) => {
      if (!isCurrent() || getRepository()?.id !== repositoryId || file?.repositoryId !== repositoryId || file.kind !== "text") return false;
      if (!await enable(repositoryId, { focus: false }) || !isCurrent()) return false;
      const revision = epoch;
      return instance.openFile(file.file, file.line, file.column, {
        isValid: () => isCurrent() && revision === epoch && desired === repositoryId && getRepository()?.id === repositoryId,
      });
    },
    openCodeDiscussions: async repositoryId => {
      if (getRepository()?.id !== repositoryId || !await enable(repositoryId, { focus: false }) || getRepository()?.id !== repositoryId) return false;
      return instance?.openCodeDiscussions?.();
    },
    isFileDirty: (repositoryId, path) => Boolean(instance?.isFileDirty?.(repositoryId, path)),
    invalidateSavedFile: (repositoryId, path) => instance?.invalidateSavedFile?.(repositoryId, path),
    refreshAfterExternalChange: (repositoryId, options) => instance?.refreshAfterExternalChange?.(repositoryId, options),
    isVisible: id => visible && desired === id && getRepository()?.id === id,
    getNavigationState: () => ({ enabled: visible && desired === getRepository()?.id, chatVisible: chatVisible(),
      ...(visible && desired === getRepository()?.id ? instance?.getNavigationState?.() : null) }),
    syncRunState: () => instance?.syncRunState?.(),
    syncVersionControlState: () => instance?.syncVersionControlState?.(),
    syncTerminalState: state => instance?.syncTerminalState?.(state),
    showRunLogs: repositoryId => visible && desired === repositoryId && getRepository()?.id === repositoryId ? instance?.showRunLogs?.() : false,
    attachLaunchedDebug: (repositoryId, process) => visible && desired === repositoryId && getRepository()?.id === repositoryId ? instance?.attachLaunchedDebug?.(process) : false,
    focus: () => instance?.focus(), isDirty: id => Boolean(instance?.isDirty(id)), refreshDebug: () => instance?.refreshDebug(), dispose: () => { epoch++; resize?.dispose(); instance?.dispose(); } };
}
