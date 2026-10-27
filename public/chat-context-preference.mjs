// Next-prompt preferences are distinct from the historical mode on a sent task.
// Older releases wrote "fresh" even when the user had made no explicit choice.
export function createChatContextPreference(storage) {
  const storageKey = "argus-chat-context-preferences-v1";
  const choices = new Map();
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [key, mode] of Object.entries(saved)) {
        if (mode === "fresh" || mode === "history") choices.set(key, mode);
      }
    }
  } catch { /* A corrupt or unavailable cache must not prevent composing. */ }
  const flush = () => {
    try { storage?.setItem(storageKey, JSON.stringify(Object.fromEntries(choices))); }
    catch { /* Keep the explicit choice for this session if storage is full. */ }
  };
  return {
    get(key, task) {
      // Revisions intentionally exclude later history. Do not turn that safety
      // exception into the default for subsequent ordinary follow-ups.
      if (task?.revisionDraft || task?.revisionOf?.pending === true) return "fresh";
      return choices.get(key) || "history";
    },
    has: key => choices.has(key),
    set(key, mode) {
      if (!["history", "fresh"].includes(mode)) throw new TypeError("Invalid chat context mode");
      choices.set(key, mode); flush();
    },
    reset(key) { choices.delete(key); flush(); },
  };
}
