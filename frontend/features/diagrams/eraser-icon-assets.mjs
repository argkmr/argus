import { ERASER_ICONS, isEraserIconName } from './diagram-eraser-icons.mjs';
import { eraserSvgDataUri, isMonochromeEraserSvg, readBoundedIconResponse, sanitizeEraserIconSvg } from './eraser-icon-safety.mjs';

export { eraserSvgDataUri, isMonochromeEraserSvg, sanitizeEraserIconSvg } from './eraser-icon-safety.mjs';
const MAX_ENTRIES = 256;
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_DATABASE = 'argus-eraser-icons-v1';

function createPersistentIconCache() {
  let opening;
  const open = () => {
    if (!globalThis.indexedDB) return Promise.resolve(null);
    if (opening) return opening;
    opening = new Promise(resolve => {
      const request = indexedDB.open(CACHE_DATABASE, 1);
      const timer = setTimeout(() => resolve(null), 1500);
      request.onupgradeneeded = () => { request.result.createObjectStore('icons', { keyPath: 'name' }); };
      request.onsuccess = () => { clearTimeout(timer); request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = request.onblocked = () => { clearTimeout(timer); resolve(null); };
    });
    return opening;
  };
  return {
    async get(name) {
      const db = await open();
      if (!db) return null;
      return new Promise(resolve => {
        const request = db.transaction('icons', 'readonly').objectStore('icons').get(name);
        request.onsuccess = () => resolve(request.result?.svg || null);
        request.onerror = () => resolve(null);
      });
    },
    async set(name, svg) {
      const db = await open();
      if (!db) return;
      await new Promise(resolve => {
        const tx = db.transaction('icons', 'readwrite');
        const store = tx.objectStore('icons');
        store.put({ name, svg, bytes: new TextEncoder().encode(svg).length, at: Date.now() });
        const request = store.getAll();
        request.onsuccess = () => {
          const rows = request.result.sort((a, b) => b.at - a.at);
          let bytes = 0;
          rows.forEach((row, index) => {
            bytes += row.bytes || 0;
            if (index >= MAX_ENTRIES || bytes > MAX_BYTES) store.delete(row.name);
          });
        };
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      });
    },
  };
}

function validateProxyBaseUrl(value) {
  if (typeof value !== 'string' || !value || /[?#]/.test(value)) throw new TypeError('Invalid icon proxy URL');
  if (value.startsWith('/') && !value.startsWith('//')) return value.replace(/\/+$/, '');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Invalid icon proxy URL');
  return url.href.replace(/\/+$/, '');
}

// Dependency injection keeps cache, offline, security, and retry tests network-free.
export function createEraserIconAssetStore({ fetcher = (...args) => fetch(...args), persistentCache = createPersistentIconCache(), proxyBaseUrl = '/api/diagram-icons', headers = {}, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES, concurrency = 4, timeoutMs = 8000, retryDelayMs = 5000, now = Date.now } = {}) {
  let config = { proxyBaseUrl: validateProxyBaseUrl(proxyBaseUrl), headers };
  const memory = new Map();
  const pending = new Map();
  const failures = new Map();
  const queue = [];
  let active = 0;
  let totalBytes = 0;
  const slot = async () => {
    if (active >= concurrency) {
      if (queue.length >= ERASER_ICONS.length) throw new Error('Icon loader is busy');
      await new Promise(resolve => queue.push(resolve));
    } else active++;
  };
  const release = () => { const next = queue.shift(); if (next) next(); else active--; };
  const remember = (name, svg) => {
    totalBytes -= memory.get(name)?.bytes || 0;
    memory.delete(name);
    const bytes = new TextEncoder().encode(svg).length;
    memory.set(name, { svg, bytes });
    totalBytes += bytes;
    while (memory.size > maxEntries || totalBytes > maxBytes) {
      const key = memory.keys().next().value;
      totalBytes -= memory.get(key).bytes;
      memory.delete(key);
    }
    failures.delete(name);
    return svg;
  };
  function getCached(name, options = {}) {
    if (!isEraserIconName(name)) return null;
    const entry = memory.get(name);
    if (!entry) return null;
    memory.delete(name); memory.set(name, entry);
    return eraserSvgDataUri(entry.svg, name, options);
  }
  async function load(name, options = {}) {
    if (!isEraserIconName(name)) throw new TypeError('Unknown Eraser icon');
    const cached = getCached(name, options);
    if (cached) return cached;
    if (options.retry) failures.delete(name);
    const failed = failures.get(name);
    if (failed && failed.until > now()) throw failed.error;
    if (!pending.has(name)) {
      const promise = (async () => {
        // IndexedDB is an opportunistic cache: blocked/quota-disabled storage must
        // never prevent a successful network load. Validate even cached markup.
        try {
          const persisted = await persistentCache?.get(name);
          if (persisted) return remember(name, await sanitizeEraserIconSvg(persisted, name));
        } catch { /* Cache unavailable or invalid: refetch the original. */ }
        await slot();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const requestHeaders = typeof config.headers === 'function' ? config.headers() : config.headers;
          const response = await fetcher(`${config.proxyBaseUrl}/${encodeURIComponent(name)}`, { headers: { ...requestHeaders, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
          if (!response.ok) throw new Error(`Icon could not be loaded (HTTP ${response.status})`);
          const payload = JSON.parse(await readBoundedIconResponse(response));
          const svg = remember(name, await sanitizeEraserIconSvg(payload.svg, name));
          try { await persistentCache?.set(name, svg); } catch { /* Storage quota/private mode. */ }
          return svg;
        } finally { clearTimeout(timer); release(); }
      })().catch(error => {
        failures.set(name, { error, until: now() + retryDelayMs });
        while (failures.size > MAX_ENTRIES) failures.delete(failures.keys().next().value);
        throw error;
      }).finally(() => pending.delete(name));
      pending.set(name, promise);
    }
    return eraserSvgDataUri(await pending.get(name), name, options);
  }
  return {
    load, getCached,
    isMonochrome(name) { const entry = memory.get(name); return entry ? isMonochromeEraserSvg(entry.svg) : null; },
    configure(options = {}) {
      config = { proxyBaseUrl: validateProxyBaseUrl(options.proxyBaseUrl ?? config.proxyBaseUrl), headers: options.headers ?? config.headers };
      failures.clear();
    },
    async prefetch(names, options = {}) {
      const result = new Map();
      const queue = [...new Set(names)].filter(isEraserIconName);
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const name = queue.shift();
          try { result.set(name, await load(name, options)); } catch { result.set(name, null); }
        }
      }));
      return result;
    },
  };
}

const defaultStore = createEraserIconAssetStore();
export const loadEraserIcon = (name, options) => defaultStore.load(name, options);
export const getCachedEraserIcon = (name, options) => defaultStore.getCached(name, options);
export const isCachedEraserIconMonochrome = name => defaultStore.isMonochrome(name);
export const prefetchEraserIcons = (names, options) => defaultStore.prefetch(names, options);
export const configureEraserIconAssets = options => defaultStore.configure(options);
