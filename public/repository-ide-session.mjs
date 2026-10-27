// Navigation metadata only. Source text and unsaved drafts never enter storage.
export const IDE_SESSION_KEY = "argus-ide-last-file:v1";
const MAX_REPOSITORIES = 100;
const MAX_STORAGE_CHARS = 1024 * 1024;
const boundedNumber = (value, fallback, minimum = 0) => Number.isFinite(value)
  ? Math.min(10_000_000, Math.max(minimum, Math.floor(value))) : fallback;
const safeText = value => typeof value === "string" && value.length <= 4096 && !/[\0\r\n]/.test(value);

function identity(repository) {
  const id = typeof repository === "string" ? repository : repository?.id;
  const root = typeof repository === "object" ? repository?.path ?? "" : "";
  return safeText(id) && id && safeText(root) ? { id, root } : null;
}

export function sanitizeIdeSessionView(value) {
  if (!value || !safeText(value.path) || !value.path || value.path.startsWith("/")
    || /[\\]|^[a-z]+:/i.test(value.path) || value.path.split("/").some(part => !part || part === "." || part === "..")) return null;
  return { path: value.path, line: boundedNumber(value.line, 1, 1), column: boundedNumber(value.column, 1, 1),
    scrollTop: boundedNumber(value.scrollTop, 0), scrollLeft: boundedNumber(value.scrollLeft, 0) };
}

export function createIdeSessionStorage(getStorage) {
  function read(storage) {
    const raw = storage?.getItem(IDE_SESSION_KEY);
    if (!raw || raw.length > MAX_STORAGE_CHARS) return [];
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.repositories)) return [];
    return value.repositories.slice(-MAX_REPOSITORIES).flatMap(entry => {
      const owner = identity({ id: entry?.id, path: entry?.root }), view = sanitizeIdeSessionView(entry?.view);
      return owner && view ? [{ ...owner, view }] : [];
    });
  }
  return {
    load(repository) {
      try {
        const owner = identity(repository);
        if (!owner) return null;
        return read(getStorage()).findLast(entry => entry.id === owner.id && entry.root === owner.root)?.view || null;
      } catch { return null; }
    },
    save(repository, value) {
      try {
        const owner = identity(repository), view = value === null ? null : sanitizeIdeSessionView(value), storage = getStorage();
        if (!owner || !storage || value !== null && !view) return false;
        let previous;
        try { previous = read(storage); } catch { previous = []; }
        const entries = previous.filter(entry => entry.id !== owner.id);
        if (view) entries.push({ ...owner, view });
        const serialized = JSON.stringify({ version: 1, repositories: entries.slice(-MAX_REPOSITORIES) });
        if (serialized.length > MAX_STORAGE_CHARS) return false;
        if (storage.getItem(IDE_SESSION_KEY) !== serialized) storage.setItem(IDE_SESSION_KEY, serialized);
        return true;
      } catch { return false; } // Restricted/quota-full storage never blocks editing or Quit.
    },
  };
}
