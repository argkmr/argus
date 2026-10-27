import { ERASER_ICONS, eraserIconAssetName, eraserIconUrl, isEraserIconName } from '../frontend/features/diagrams/diagram-eraser-icons.mjs';
import { MAX_ERASER_SVG_BYTES, readBoundedIconResponse, sanitizeEraserIconSvg } from '../frontend/features/diagrams/eraser-icon-safety.mjs';

// Matches the public on-demand loader documented by Eraser. This is not a
// general URL proxy and never forwards canvas/session credentials upstream.
export function createEraserIconFetcher({ fetcher = (...args) => fetch(...args), concurrency = 4, maxEntries = 256, maxBytes = 8 * 1024 * 1024, timeoutMs = 8000, retryDelayMs = 5000, now = Date.now } = {}) {
  const cache = new Map();
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
  const release = () => {
    const next = queue.shift();
    if (next) next(); else active--;
  };
  return async function fetchEraserIcon(name) {
    if (!isEraserIconName(name)) throw new TypeError('Unknown Eraser icon');
    const key = eraserIconAssetName(name);
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached.svg; }
    const failure = failures.get(key);
    if (failure && failure.until > now()) throw failure.error;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      await slot();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(eraserIconUrl(name), { signal: controller.signal, redirect: 'error', headers: { Accept: 'image/svg+xml' } });
        if (!response.ok) throw new Error(`Eraser icon returned HTTP ${response.status}`);
        const svg = await sanitizeEraserIconSvg(await readBoundedIconResponse(response, MAX_ERASER_SVG_BYTES), name);
        const bytes = new TextEncoder().encode(svg).length;
        cache.set(key, { svg, bytes });
        totalBytes += bytes;
        while (cache.size > maxEntries || totalBytes > maxBytes) {
          const oldest = cache.keys().next().value;
          totalBytes -= cache.get(oldest).bytes;
          cache.delete(oldest);
        }
        failures.delete(key);
        return svg;
      } finally { clearTimeout(timer); release(); }
    })().catch(error => {
      failures.set(key, { error, until: now() + retryDelayMs });
      while (failures.size > maxEntries) failures.delete(failures.keys().next().value);
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}

export const fetchEraserIcon = createEraserIconFetcher();
