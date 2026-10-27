// Shared by the native editor and board JSON import, before persistence/rendering.
const SAVED_APP_STATE_KEYS = [
  'viewBackgroundColor', 'scrollX', 'scrollY', 'gridSize', 'gridStep',
  'gridModeEnabled', 'objectsSnapModeEnabled', 'zenModeEnabled', 'name',
  'currentItemStrokeColor', 'currentItemBackgroundColor', 'currentItemFillStyle',
  'currentItemStrokeWidth', 'currentItemStrokeStyle', 'currentItemRoughness',
  'currentItemOpacity', 'currentItemFontFamily', 'currentItemFontSize',
  'currentItemTextAlign', 'currentItemStartArrowhead', 'currentItemEndArrowhead',
  'currentItemRoundness', 'currentItemArrowType', 'currentChartType',
  'exportBackground', 'exportEmbedScene', 'exportWithDarkMode', 'exportScale',
  'defaultSidebarDockedPreference', 'penMode',
];
const RASTER_MIME = /^image\/(png|jpeg|jpg|gif|webp|bmp|avif|x-icon)$/i;
const RASTER_DATA = /^data:(image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|x-icon));base64,[A-Za-z0-9+/]+={0,2}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const IMAGE_ERROR = 'Drawing images must be embedded raster data (PNG, JPEG, GIF, WebP, BMP, AVIF or ICO). Remote URLs and SVG image payloads are not supported.';

function isRasterDataURL(dataURL, mimeType) {
  const match = typeof dataURL === 'string' && dataURL.match(RASTER_DATA);
  if (!match || (mimeType && (typeof mimeType !== 'string' || mimeType.toLowerCase() !== match[1].toLowerCase()))) return false;
  let bytes;
  try { bytes = globalThis.atob(dataURL.slice(dataURL.indexOf(',') + 1).slice(0, 64)); }
  catch { return false; }
  // A MIME label alone is not proof that a payload is raster image data.
  switch (match[1].toLowerCase()) {
    case 'image/png': return bytes.startsWith('\x89PNG\r\n\x1a\n');
    case 'image/jpeg': case 'image/jpg': return bytes.startsWith('\xff\xd8\xff');
    case 'image/gif': return bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a');
    case 'image/webp': return bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
    case 'image/bmp': return bytes.startsWith('BM');
    case 'image/avif': return bytes.slice(4, 8) === 'ftyp' && /avif|avis/.test(bytes.slice(8));
    case 'image/x-icon': return bytes.startsWith('\x00\x00\x01\x00');
    default: return false;
  }
}

export function assertLocalSketchData(value) {
  const pending = [[value, 0]];
  const seen = new Set();
  while (pending.length) {
    const [current, depth] = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    if (depth > 100) throw new Error('The drawing contains excessively nested data.');
    seen.add(current);
    if (Object.hasOwn(current, 'dataURL')) {
      if (!isRasterDataURL(current.dataURL, current.mimeType)) throw new Error(IMAGE_ERROR);
    }
    if (typeof current.mimeType === 'string' && current.mimeType.startsWith('image/') && !RASTER_MIME.test(current.mimeType)) throw new Error(IMAGE_ERROR);
    for (const child of Object.values(current)) pending.push([child, depth + 1]);
  }
}

export function sanitizeSketchLink(link) {
  if (typeof link !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(link)) return null;
  const trimmed = link.trim();
  return /^(https?:\/\/|mailto:|tel:|#)/i.test(trimmed) ? trimmed : null;
}

export function sanitizeSketchElements(elements = []) {
  if (!Array.isArray(elements) || elements.length > 10000) throw new Error('Invalid or oversized Excalidraw scene.');
  assertLocalSketchData(elements);
  return elements.filter(element => {
    if (!object(element) || typeof element.type !== 'string') throw new Error('Invalid Excalidraw drawing element.');
    return element.type !== 'iframe' && element.type !== 'magicframe';
  }).map(element => {
    if (element.link == null) return element;
    const link = sanitizeSketchLink(element.link);
    return link === element.link ? element : { ...element, link };
  });
}

export function sanitizeSketchFiles(files = {}) {
  if (!object(files)) throw new Error('Invalid drawing image data.');
  assertLocalSketchData(files);
  const entries = Object.entries(files);
  if (entries.length > 10000) throw new Error('Too many drawing images.');
  return Object.fromEntries(entries.map(([id, file]) => {
    if (!object(file) || file.id !== id || typeof file.mimeType !== 'string'
        || !RASTER_MIME.test(file.mimeType) || !RASTER_DATA.test(file.dataURL || '')) throw new Error(IMAGE_ERROR);
    return [id, { id, mimeType: file.mimeType, dataURL: file.dataURL,
      created: Number.isFinite(file.created) ? file.created : 0,
      ...(Number.isFinite(file.lastRetrieved) ? { lastRetrieved: file.lastRetrieved } : {}),
      ...(Number.isFinite(file.version) ? { version: file.version } : {}),
    }];
  }));
}

export function sanitizeSketchLibrary(items = []) {
  if (!Array.isArray(items) || items.length > 1000) throw new Error('Invalid or oversized drawing library.');
  assertLocalSketchData(items);
  return items.map(item => {
    if (!object(item)) throw new Error('Invalid drawing library item.');
    return { ...item, elements: sanitizeSketchElements(item.elements || []) };
  });
}

export function sanitizeSketchAppState(appState = {}) {
  const saved = {};
  for (const key of SAVED_APP_STATE_KEYS) {
    const value = appState?.[key];
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))) saved[key] = value;
  }
  if (Number.isFinite(appState?.zoom?.value) && appState.zoom.value > 0) saved.zoom = { value: appState.zoom.value };
  return saved;
}

export function sanitizeSketchSnapshot(snapshot = {}) {
  if (!object(snapshot)) throw new Error('Invalid sketch data.');
  return {
    elements: sanitizeSketchElements(snapshot.elements),
    appState: sanitizeSketchAppState(snapshot.appState),
    files: sanitizeSketchFiles(snapshot.files),
    libraryItems: sanitizeSketchLibrary(snapshot.libraryItems),
  };
}
