import { isEraserIconName } from './diagram-eraser-icons.mjs';

// The Eraser parser permits static SVG drawing primitives only. Its current MIT
// source is vendored with attribution; artwork retains its owners' rights.
export const MAX_ERASER_SVG_BYTES = 64 * 1024;
const SAFE_COLOR = /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|rgba?\([\d\s.,%/+\-]+\))$/i;
let transforms;
let transformsLoading;
let validateStaticSvg;
const loadTransforms = () => transforms ? Promise.resolve(transforms) : (transformsLoading ||= Promise.all([import('./eraser-svg-transforms.mjs'), import('./eraser-static-svg.mjs')]).then(([module, validator]) => { validateStaticSvg = validator.sanitizeSvg; transforms = module; return module; }));

function sanitizeReadyEraserIconSvg(raw, name) {
  if (!isEraserIconName(name)) throw new TypeError('Unknown Eraser icon');
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_ERASER_SVG_BYTES) throw new Error('Icon SVG exceeds the safe size limit');
  if (!transforms) throw new Error('Load and validate the Eraser icon before creating an image');
  // Cisco's exported artwork repeats the standard SVG namespace under the
  // unused svg prefix. Remove only that exact redundant declaration; never
  // relax the parser's rejection of arbitrary namespace-qualified content.
  const source = raw.replace(/\sxmlns:svg\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/gi, '');
  const normalized = transforms.normalizeFetchedIcon(source, name.replace(/[^a-z0-9-]/gi, '-'));
  const result = validateStaticSvg(normalized);
  if (!result.ok) throw new Error('Icon does not contain safe static SVG: ' + result.reason);
  return result.svg;
}

export async function sanitizeEraserIconSvg(raw, name) {
  await loadTransforms();
  return sanitizeReadyEraserIconSvg(raw, name);
}

// Some vendor marks, like Redis, deliberately have no paint attributes. They
// need theme ink too; do not infer monochrome solely from the catalog category.
export function isMonochromeEraserSvg(svg) {
  if (/<(?:linearGradient|radialGradient|pattern)\b/i.test(svg)) return false;
  const paints = [...svg.matchAll(/\b(?:fill|stroke|color|stop-color)\s*(?:=\s*["']|:\s*)([^;"'>]+)/gi)].map(match => match[1].trim().toLowerCase());
  if (!paints.every(paint => ['none', 'currentcolor', 'inherit', 'transparent', 'black', '#000', '#000000', 'white', '#fff', '#ffffff'].includes(paint))) return false;
  const white = paints.some(paint => ['white', '#fff', '#ffffff'].includes(paint));
  const black = paints.some(paint => ['black', '#000', '#000000'].includes(paint));
  // Contrasting black/white artwork can encode cutouts. Flattening both paints
  // into one mask erases that detail, so preserve the original two-tone mark.
  if (white && black) return false;
  if (white) {
    const root = svg.match(/<svg\b([^>]*)>/i)?.[1] || '';
    const rootHasFill = /\bfill\s*(?:=|:)/i.test(root);
    const hasUnpaintedShape = [...svg.matchAll(/<(?:path|rect|circle|ellipse|polygon|polyline|text)\b([^>]*)>/gi)].some(([, attributes]) => !/\bfill\s*(?:=|:)/i.test(attributes));
    if (!rootHasFill && hasUnpaintedShape) return false;
  }
  return true;
}

export function eraserSvgDataUri(raw, name, { color = '#a9b4c2' } = {}) {
  let svg = sanitizeReadyEraserIconSvg(raw, name);
  if (typeof color !== 'string' || !SAFE_COLOR.test(color)) throw new TypeError('Icon color must be a hex or RGB color');
  if (isMonochromeEraserSvg(svg)) {
    svg = transforms.normalizeToCurrentColor(svg).replace(/currentColor/gi, color);
    svg = svg.replace(/<svg\b([^>]*)>/i, (_, attributes) => {
      const fill = /(?:^|\s)fill\s*=/.test(attributes) ? '' : ` fill="${color}"`;
      const withoutColor = attributes.replace(/\scolor\s*=\s*(["']).*?\1/gi, '');
      return `<svg${withoutColor}${fill} color="${color}">`;
    });
  }
  // Image context only: consumers must not insert this SVG as innerHTML.
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return 'data:image/svg+xml;base64,' + btoa(binary);
}

export async function readBoundedIconResponse(response, maxBytes = MAX_ERASER_SVG_BYTES + 16 * 1024) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('Icon response exceeds the safe size limit');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw new Error('Icon response exceeds the safe size limit');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('Icon response exceeds the safe size limit'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
