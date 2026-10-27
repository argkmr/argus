import { COMPONENT_BRAND_ICONS, getDiagramComponent } from './diagram-catalog.mjs';
import { getSelfLoopGeometry } from './diagram-edge-geometry.mjs';
import { connectionGeometry } from './diagram-connection-routing.mjs';
import { getReplicaLayout } from './diagram-replicas.mjs';
import { getStructureLayout } from './diagram-structure-layout.mjs';
import { getVisualGeometry } from './diagram-visuals.mjs';
import { getArchitectureSymbol } from './diagram-architecture-symbols.mjs';
import { getCachedEraserIcon } from './eraser-icon-assets.mjs';
import { getExpandedNotesLayout } from './diagram-expanded-layout.mjs';
import { getExpandedRoutes } from './diagram-expanded-routing.mjs';
import { getSequenceGeometry, getSequenceEndpointOffset, getSequenceLabelLayout } from './diagram-sequence.mjs';

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif';
const MONO = 'SFMono-Regular, Consolas, Liberation Mono, monospace';
const SEQUENCE_RELATIONS = new Set(['message', 'return', 'async']);
const RELATIONS = new Set(['association', 'dependency', 'inheritance', 'implementation', 'aggregation', 'composition', ...SEQUENCE_RELATIONS]);
const DIRECTIONS = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const ROLE_PATHS = {
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  cache: '<path d="m3 6 9-4 9 4-9 4-9-4Zm0 6 9 4 9-4M3 18l9 4 9-4m-8-10-3 5h4l-3 5"/>',
  topic: '<rect x="2" y="3" width="20" height="5" rx="1"/><rect x="2" y="10" width="20" height="5" rx="1"/><rect x="2" y="17" width="20" height="5" rx="1"/><path d="M7 3v5m6-5v5m5-5v5M7 10v5m6-5v5m5-5v5M7 17v5m6-5v5m5-5v5"/>',
  queue: '<path d="M4 4h16M4 20h16m0-16a3 8 0 0 1 0 16"/><ellipse cx="4" cy="12" rx="3" ry="8"/><path d="M9 9v6m4-6v6m4-6v6"/>',
  'load-balancer': '<path d="M12 2v5M4 14v-4h16v4M12 7v7"/><rect x="1" y="15" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><rect x="17" y="15" width="6" height="6" rx="1"/>',
  gateway: '<rect x="8" y="3" width="8" height="18" rx="2"/><path d="M1 8h7M1 16h7m8-8h7m-7 8h7m-12-9v10m3-10v10"/>',
  browser: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 8h20m-16-3h.01M9 5h.01M7 12l-3 3 3 3m10-6 3 3-3 3"/>',
  mobile: '<rect x="6" y="1" width="12" height="22" rx="2"/><path d="M10 4h4m-3 16h2"/>',
  user: '<circle cx="12" cy="6" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3M4 22h16"/>',
  cloud: '<path d="M6 19a5 5 0 1 1 .6-10A6 6 0 0 1 18 8a5.5 5.5 0 0 1 0 11H6Z"/>',
  external: '<path d="M6 19a5 5 0 1 1 .6-10A6 6 0 0 1 18 8a5.5 5.5 0 0 1 0 11H6Zm4-4h5m-2-2 2 2-2 2"/>',
  'object-store': '<path d="M4 6h16l-2 15H6L4 6Zm0 0 3-4h10l3 4M9 11h6v5H9z"/>',
  container: '<path d="m12 2 10 5v10l-10 5-10-5V7l10-5Zm0 10 10-5M12 12 2 7m10 5v10M7 4l10 5"/>',
  cluster: '<rect x="8" y="1" width="8" height="7" rx="1"/><rect x="1" y="16" width="8" height="7" rx="1"/><rect x="15" y="16" width="8" height="7" rx="1"/><path d="M12 8v5H5v3m7-3h7v3"/>',
  monitor: '<rect x="2" y="3" width="20" height="16" rx="2"/><path d="M8 23h8m-4-4v4M5 11h3l2-5 4 10 2-5h3"/>',
  chart: '<rect x="2" y="3" width="20" height="16" rx="2"/><path d="M8 23h8m-4-4v4M6 15v-3m4 3V9m4 6V6m4 9v-5"/>',
  worker: '<path d="m12 2 3 2 4 1 1 4 2 3-2 3-1 4-4 1-3 2-3-2-4-1-1-4-2-3 2-3 1-4 4-1 3-2Zm-2 6 6 4-6 4V8Z"/>',
  service: '<rect x="3" y="2" width="18" height="8" rx="2"/><rect x="3" y="14" width="18" height="8" rx="2"/><path d="M7 6h.01M7 18h.01M11 6h6m-6 12h6M12 10v4"/>',
};

function xml(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[\ud800-\udfff]/gu, '\ufffd')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const rounded = value => Math.round(number(value) * 100) / 100;
const coordinate = value => rounded(value).toString();
const point = value => `${coordinate(value.x)} ${coordinate(value.y)}`;
const list = value => Array.isArray(value) ? value : [];
const safeColor = (value, fallback) => typeof value === 'string' && /^(#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d.,%\s+/-]+\))$/i.test(value.trim()) ? value.trim() : fallback;

function colorRgb(value) {
  const color = String(value).trim().toLowerCase();
  if (/^#[\da-f]{3,4}$/i.test(color)) return color.slice(1, 4).split('').map(channel => Number.parseInt(channel + channel, 16));
  if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)) return [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16));
  if (color === 'white') return [255, 255, 255];
  if (color === 'black') return [0, 0, 0];
  if (/^rgba?\(/.test(color)) {
    const channels = color.slice(color.indexOf('(') + 1, -1).split(/[,\s/]+/).filter(Boolean).slice(0, 3);
    if (channels.length === 3) return channels.map(channel => Math.max(0, Math.min(255, Number.parseFloat(channel) * (channel.endsWith('%') ? 2.55 : 1))));
  }
  if (/^hsla?\(/.test(color)) {
    const [h, s, l] = color.slice(color.indexOf('(') + 1, -1).split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number.parseFloat);
    if ([h, s, l].every(Number.isFinite)) {
      const hue = ((h % 360) + 360) % 360 / 30, lightness = Math.max(0, Math.min(1, l / 100));
      const amplitude = Math.max(0, Math.min(1, s / 100)) * Math.min(lightness, 1 - lightness);
      return [0, 8, 4].map(offset => { const k = (offset + hue) % 12; return 255 * (lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1))); });
    }
  }
  return null;
}

// Mirrors the canvas light theme's color-mix(in srgb, brand 60%, text).
// Emit ordinary RGB rather than CSS color-mix so standalone SVG consumers
// retain the contrast adjustment even without modern CSS color support.
function componentGlyphColor(color, theme) {
  const background = colorRgb(theme.background), foreground = colorRgb(theme.foreground), brand = colorRgb(color);
  if (!background || !foreground || !brand || background.some(channel => !Number.isFinite(channel)) || foreground.some(channel => !Number.isFinite(channel))) return color;
  const luminance = background.reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  if (luminance < 150) return color;
  return `#${brand.map((channel, index) => Math.round(channel * .6 + foreground[index] * .4).toString(16).padStart(2, '0')).join('')}`;
}

function dimension(node, key, fallback) {
  for (const value of [node.measured?.[key], node[key], node.style?.[key]]) {
    const parsed = typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number.parseFloat(value) : value;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function normalizeNode(node) {
  const data = node.data || {};
  const fields = list(data.fields), methods = list(data.methods);
  const structureLayout = node.type === 'dataStructure' ? getStructureLayout(data) : null;
  const expandedLayout = node.type === 'component' && data.expandedNotes && !getDiagramComponent(data.componentKey).visualKind ? getExpandedNotesLayout(data) : null;
  const sequenceLayout = node.type === 'participant' ? getSequenceGeometry(data, dimension(node, 'height', undefined)) : null;
  const minimumHeight = expandedLayout?.height || structureLayout?.height || sequenceLayout?.height || (node.type === 'umlClass' ? 146 + Math.max(1, fields.length) * 28 + Math.max(1, methods.length) * 28 : ['note', 'group'].includes(node.type) ? 114 : 160);
  const fallbackHeight = sequenceLayout?.height || minimumHeight;
  const minimumWidth = expandedLayout?.width || structureLayout?.width || (node.type === 'umlClass' ? 260 : node.type === 'participant' ? 160 : 180);
  const width = Math.max(minimumWidth, dimension(node, 'width', minimumWidth));
  const height = Math.max(minimumHeight, dimension(node, 'height', fallbackHeight));
  const position = node.positionAbsolute || node.position || {};
  return { ...node, data, fields, methods, structureLayout, sequenceLayout, x: number(position.x), y: number(position.y), width, height };
}

function mixColor(first, second, ratio) {
  const a = colorRgb(first), b = colorRgb(second);
  return a && b ? `#${a.map((channel, index) => Math.round(channel * ratio + b[index] * (1 - ratio)).toString(16).padStart(2, '0')).join('')}` : first;
}

function sequenceColors(theme) {
  return {
    header: mixColor('#55b9d8', theme.background, .12),
    border: mixColor('#55b9d8', theme.foreground, .45),
    activation: mixColor('#55b9d8', theme.background, .55),
    activationBorder: mixColor('#55b9d8', theme.foreground, .65),
    line: mixColor(theme.foreground, theme.background, .8),
    lifeline: mixColor(theme.foreground, theme.background, .58),
  };
}

// Approximate glyph advances keep this exporter independent of DOM/canvas/font
// loading. Text remains real, selectable Unicode text in the SVG.
function textWidth(value, fontSize, monospace = false) {
  let advance = 0;
  for (const character of String(value)) {
    if (/\p{Mark}/u.test(character) || character === '\u200d' || character === '\ufe0f') continue;
    advance += character.codePointAt(0) > 0x2ff ? 1 : monospace ? .61 : /[MW@#%]/.test(character) ? .88 : /[ilI.,' :;!|]/.test(character) ? .3 : .56;
  }
  return advance * fontSize;
}

function wrapText(value, width, fontSize, maxLines = Infinity, monospace = false) {
  const lines = [];
  for (const paragraph of String(value ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let current = '';
    for (const token of paragraph.split(/(\s+)/).filter(Boolean)) {
      if (textWidth(current + token, fontSize, monospace) <= width) { current += token; continue; }
      if (current.trim()) lines.push(current.trimEnd());
      current = '';
      if (!token.trim()) continue;
      for (const character of token) {
        if (current && textWidth(current + character, fontSize, monospace) > width) { lines.push(current); current = ''; }
        current += character;
      }
    }
    lines.push(current.trimEnd());
  }
  const limited = lines.slice(0, Math.max(1, maxLines));
  if (lines.length > limited.length) {
    const last = Array.from(limited.at(-1));
    while (last.length && textWidth(last.join('') + '…', fontSize, monospace) > width) last.pop();
    limited[limited.length - 1] = last.join('') + '…';
  }
  return limited;
}

function textBlock(value, x, y, width, { fontSize = 12, lineHeight = fontSize * 1.35, maxLines = 1, fill, weight = 400, anchor = 'start', monospace = false, title = true } = {}) {
  const lines = wrapText(value, Math.max(12, width), fontSize, maxLines, monospace);
  return `<text x="${coordinate(x)}" y="${coordinate(y)}" font-family="${monospace ? MONO : FONT}" font-size="${fontSize}" font-weight="${weight}" text-anchor="${anchor}"${fill ? ` fill="${xml(fill)}"` : ''}>${title ? `<title>${xml(value)}</title>` : ''}${lines.map((line, index) => `<tspan x="${coordinate(x)}" dy="${index ? coordinate(lineHeight) : '0'}">${xml(line)}</tspan>`).join('')}</text>`;
}

function expandedText(lines, x, top, { fontSize, lineHeight, anchor = 'start', weight = 400, attribute }) {
  return `<text ${attribute}="true" x="${coordinate(x)}" y="${coordinate(top + fontSize)}" font-size="${fontSize}" font-weight="${weight}" text-anchor="${anchor}" xml:space="preserve">${lines.map((line, index) => `<tspan x="${coordinate(x)}" y="${coordinate(top + fontSize + index * lineHeight)}">${xml(line)}</tspan>`).join('')}</text>`;
}

function roleGlyph(role, x, y, size, color) {
  const architectureSymbol = getArchitectureSymbol(role);
  if (architectureSymbol) {
    const drawing = architectureSymbol.primitives.map(({ tag, attrs, text }) => `<${tag} ${Object.entries(attrs).map(([name, value]) => `${name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}="${xml(value)}"`).join(' ')}>${text ? xml(text) : ''}</${tag}>`).join('');
    return `<g data-role="${xml(role)}" data-architecture-symbol="${xml(role)}" transform="translate(${coordinate(x)} ${coordinate(y)}) scale(${coordinate(size / architectureSymbol.size)})" fill="none" stroke="${xml(color)}" color="${xml(color)}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${drawing}</g>`;
  }
  return `<g data-role="${xml(role)}" transform="translate(${coordinate(x)} ${coordinate(y)}) scale(${coordinate(size / 24)})" fill="none" stroke="${xml(color)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ROLE_PATHS[role] || ROLE_PATHS.service}</g>`;
}

function productGlyph(icon, x, y, size, color) {
  const paths = icon.paths?.length ? icon.paths : [{ d: icon.path }];
  // A nested SVG preserves each product mark's intrinsic aspect ratio and
  // multi-colour layers, while keeping the badge at the same size as canvas.
  return `<g data-brand="${xml(icon.title)}" transform="translate(${coordinate(x)} ${coordinate(y)})" fill="${xml(color)}"><title>${xml(icon.title)} product logo</title><svg width="${coordinate(size)}" height="${coordinate(size)}" viewBox="${xml(icon.viewBox || '0 0 24 24')}" preserveAspectRatio="xMidYMid meet">${paths.map(path => `<path d="${xml(path.d)}"${path.fill ? ` fill="${xml(path.fill)}"` : ''}/>`).join('')}</svg></g>`;
}

function visualNode(node, component, theme) {
  const geometry = getVisualGeometry(component, node.width, node.height);
  const outline = geometry.primitives.map(({ tag, attrs }) => `<${tag} ${Object.entries(attrs).map(([name, value]) => `${name}="${xml(value)}"`).join(' ')} vector-effect="non-scaling-stroke"/>`).join('');
  let body = `<g data-visual-kind="${component.visualKind}" data-visual-form="${component.shape || component.frame}" transform="translate(${coordinate(node.x)} ${coordinate(node.y)})" fill="none" stroke="${xml(theme.foreground)}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${outline}</g>`;
  const label = geometry.label;
  body += textBlock(node.data.name || component.label, node.x + label.x + label.width / 2, node.y + label.y + 17, label.width - 8, { fontSize: 14, lineHeight: 18, maxLines: 2, weight: 650, anchor: 'middle' });
  if (String(node.data.description || '').trim()) body += `<g data-component-notes="true" transform="translate(${coordinate(node.x + node.width - 29)} ${coordinate(node.y + 13)})" fill="none" stroke="${xml(theme.foreground)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><title>${xml(node.data.description)}</title><path d="M3 2h9l4 4v13H3zM12 2v5h4M6 10h7M6 14h5"/><circle cx="16" cy="2" r="2" fill="${xml(theme.line)}" stroke="none"/></g>`;
  return body;
}

function eraserImage(component, left, top, theme) {
  const asset = theme.iconAssets?.[component.iconName] || getCachedEraserIcon(component.iconName, { color: theme.foreground });
  // The download path preloads sanitized image-context SVGs. Never introduce
  // a network reference or an unrelated placeholder into a portable export.
  if (typeof asset !== 'string' || !/^data:image\/svg\+xml;(?:charset=utf-8;)?base64,[A-Za-z0-9+/=]+$/.test(asset)) throw new Error(`Load the ${component.label} icon before exporting. Reconnect and try again.`);
  return `<image data-eraser-icon="${xml(component.iconName)}" href="${xml(asset)}" x="${coordinate(left)}" y="${coordinate(top)}" width="64" height="64" preserveAspectRatio="xMidYMid meet"><title>${xml(component.label)}</title></image>`;
}

function renderStructure(node, theme) {
  const { data, structureLayout: layout, width, height } = node;
  const ink = xml(theme.foreground), accent = xml(theme.line), background = xml(theme.background);
  const kind = data.structureKind || 'array', entries = list(data.entries);
  const entryMap = new Map(entries.filter(Boolean).map(entry => [entry.id, entry]));
  let body = `<rect width="${coordinate(width)}" height="${coordinate(height)}" rx="8" fill="${background}" stroke="${ink}" stroke-opacity=".34"/>`;
  const titleY = layout.typeLabel ? layout.nested ? 15 : 20 : layout.nested ? 23 : 28;
  body += textBlock(data.name || kind, 12, titleY, width - 118, { fontSize: layout.nested ? 11 : 13, weight: 650 });
  body += textBlock(`${kind} · ${layout.cells.length}`, width - 12, layout.nested ? 21 : 28, 100, { fontSize: 10, fill: theme.foreground, anchor: 'end' });
  if (layout.typeLabel) body += `<g data-structure-type="${xml(layout.typeLabel)}">${textBlock(layout.typeLabel, 12, layout.headerHeight - 6, width - 24, { fontSize: 9, monospace: true })}</g>`;
  body += `<path d="M0 ${layout.headerHeight}H${coordinate(width)}" fill="none" stroke="${ink}" stroke-opacity=".2"/>`;
  for (const decoration of layout.decorations) {
    const { x, y, width: w, height: h } = decoration;
    if (decoration.type === 'pipe') {
      body += `<g data-container="queue"><path d="M${x + 6} ${y}H${x + w - 6}M${x + 6} ${y + h}H${x + w - 6}" fill="none" stroke="${accent}" stroke-opacity=".65"/><ellipse cx="${x + 6}" cy="${y + h / 2}" rx="6" ry="${h / 2}" fill="none" stroke="${accent}" stroke-opacity=".65"/><path d="M${x + w - 6} ${y}a6 ${h / 2} 0 0 1 0 ${h}" fill="none" stroke="${accent}" stroke-opacity=".65"/></g>`;
    } else {
      body += `<path data-container="stack" d="M${x} ${y}V${y + h}H${x + w}V${y}" fill="none" stroke="${accent}" stroke-width="2"/>`;
    }
  }
  for (const edge of layout.edges) {
    body += `<g data-structure-link="${xml(edge.id || `${edge.source}:${edge.target}`)}"><title>${xml(edge.label || '')}</title><path d="${xml(edge.path)}" fill="none" stroke="${accent}" stroke-width="1.3" marker-end="url(#argus-open-arrow)"${edge.double ? ' marker-start="url(#argus-open-arrow)"' : ''}/>`;
    if (edge.label) body += textBlock(edge.label, edge.labelX, edge.labelY, 76, { fontSize: 9, maxLines: 1, anchor: 'middle', fill: theme.foreground });
    body += '</g>';
  }
  for (const cell of layout.cells) {
    const entry = entryMap.get(cell.id) || {}, active = cell.id === data.activeEntryId;
    const { x, y, width: w, height: h } = cell;
    body += `<g data-entry-id="${xml(cell.id)}"${active ? ' data-active="true"' : ''}><title>${xml([entry.key, entry.value, entry.annotation].filter(value => value !== undefined && value !== '').join(' · '))}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${layout.shape === 'graph' ? 14 : layout.shape === 'set' ? 20 : 4}" fill="${background}" stroke="${active ? accent : ink}" stroke-opacity="${active ? 1 : .4}" stroke-width="${active ? 2 : 1}"/>`;
    if (layout.shape === 'table') {
      const keyWidth = cell.keyWidth || w / 2;
      body += `<path d="M${x + keyWidth} ${y}V${y + h}" fill="none" stroke="${ink}" stroke-opacity=".3"/>`;
      if (!cell.keyContainer) body += textBlock(entry.key || '', x + 7, y + 22, keyWidth - 14, { fontSize: 11, monospace: true });
      if (!cell.valueContainer) body += textBlock(entry.value || '', x + keyWidth + 7, y + 22, w - keyWidth - 14, { fontSize: 11, monospace: true });
    } else {
      if (layout.shape === 'graph' && entry.key && !cell.keyContainer) body += textBlock(entry.key, x + w / 2, y + 13, w - 10, { fontSize: 8, anchor: 'middle' });
      if (!cell.valueContainer) {
        const valueX = x + (cell.keyContainer ? cell.keyWidth : 0), valueWidth = w - (cell.keyContainer ? cell.keyWidth : 0);
        body += textBlock(entry.value || '', valueX + valueWidth / 2, y + (layout.shape === 'graph' && entry.key ? 30 : 26), valueWidth - 12, { fontSize: 11, monospace: true, anchor: 'middle' });
      }
    }
    for (const field of ['keyContainer', 'valueContainer']) {
      const child = cell[field]; if (!child) continue;
      body += `<g data-embedded-container="${field === 'keyContainer' ? 'key' : 'value'}">${renderStructure({ data: child.data, structureLayout: child.layout, x: child.x, y: child.y, width: child.width, height: child.height }, theme)}</g>`;
    }
    if (['array', 'list', 'matrix', 'bitset'].includes(kind)) body += textBlock(kind === 'matrix' ? `${Math.floor(cell.index / Math.max(1, Number(data.columns) || 4))},${cell.index % Math.max(1, Number(data.columns) || 4)}` : String(cell.index), x + w / 2, y + h + 12, w, { fontSize: 9, anchor: 'middle' });
    if (entry.annotation) body += textBlock(entry.annotation, x + w / 2, y + h + (['array', 'list', 'matrix', 'bitset'].includes(kind) ? 25 : 13), w - 4, { fontSize: 8, anchor: 'middle' });
    body += '</g>';
  }
  for (const label of layout.labels) body += textBlock(label.text, label.x, label.y, 130, { fontSize: 9, anchor: label.align || 'start' });
  for (const pointer of layout.pointers) body += `<g data-pointer-id="${xml(pointer.id)}"><title>${xml(pointer.label || '')}</title><path d="${xml(pointer.path)}" fill="none" stroke="${accent}" stroke-width="1.3" marker-end="url(#argus-open-arrow)"/>${textBlock(pointer.label || '', pointer.labelX, pointer.labelY, 70, { fontSize: 9, anchor: 'middle' })}</g>`;
  if (!layout.cells.length) body += textBlock(layout.truncated ? 'Container limit reached' : 'Empty', width / 2, layout.headerHeight + 55, width - 40, { fontSize: 11, anchor: 'middle' });
  return `<g data-structure-kind="${xml(kind)}" transform="translate(${coordinate(node.x)} ${coordinate(node.y)})">${body}</g>`;
}

function renderNode(node, theme) {
  const { x, y, width, height, data, type, fields, methods } = node;
  const right = x + width, bottom = y + height;
  const muted = theme.foreground;
  const rectangle = (rectHeight = height, fill = theme.background) => `<rect x="${coordinate(x)}" y="${coordinate(y)}" width="${coordinate(width)}" height="${coordinate(rectHeight)}" rx="7" fill="${xml(fill)}" stroke="${xml(theme.foreground)}" stroke-opacity=".34"/>`;
  const title = [data.name, data.stereotype, data.role, data.description, data.implementation, ...fields.map(row => row.text), ...methods.map(row => row.text), ...list(data.entries).filter(Boolean).map(row => [row.key, row.value, row.annotation].filter(value => value !== undefined && value !== '').join(' · '))].filter(Boolean).join('\n');
  let body = '';
  if (type === 'group') {
    const color = /^#[a-f\d]{6}$/i.test(data.color || '') ? data.color : '#74a7ff';
    body = `<rect data-group-frame="true" x="${coordinate(x)}" y="${coordinate(y)}" width="${coordinate(width)}" height="${coordinate(height)}" rx="12" fill="${color}" fill-opacity=".08" stroke="${color}" stroke-opacity=".6" stroke-width="1.5"/>`;
    body += textBlock(data.name || 'Group', x + 16, y + 24, width - 32, { fontSize: 12.5, weight: 650, fill: componentGlyphColor(color, theme) });
  } else if (type === 'umlClass') {
    const extra = Math.max(0, height - (146 + Math.max(1, fields.length) * 28 + Math.max(1, methods.length) * 28));
    const fieldsHeight = 37 + Math.max(1, fields.length) * 28 + extra / 2;
    const headerBottom = y + 71, fieldsBottom = headerBottom + fieldsHeight;
    body = rectangle() + `<path d="M${coordinate(x)} ${coordinate(headerBottom)}H${coordinate(right)}M${coordinate(x)} ${coordinate(fieldsBottom)}H${coordinate(right)}" fill="none" stroke="${xml(theme.foreground)}" stroke-opacity=".34"/>`;
    body += textBlock(`«${data.stereotype || 'class'}»`, x + width / 2, y + 23, width - 24, { fontSize: 10, fill: muted, anchor: 'middle' });
    body += textBlock(data.name || 'ClassName', x + width / 2, y + 44, width - 24, { fontSize: 13, lineHeight: 15, maxLines: 2, weight: 650, anchor: 'middle' });
    for (const [label, members, top, end] of [['Fields', fields, headerBottom, fieldsBottom], ['Methods', methods, fieldsBottom, bottom - 1]]) {
      body += textBlock(label, x + 13, top + 19, width - 26, { fontSize: 9, fill: muted, weight: 600 });
      const rowHeight = (end - top - 31) / Math.max(1, members.length);
      if (!members.length) body += textBlock(`No ${label.toLowerCase()}`, x + 13, top + 44, width - 26, { fontSize: 10, fill: muted });
      members.forEach((member, index) => {
        body += textBlock(member.text || '', x + 13, top + 41 + index * rowHeight, width - 26, { fontSize: 10.5, lineHeight: 12, maxLines: Math.max(1, Math.floor((rowHeight - 2) / 12)), monospace: true });
      });
    }
  } else if (type === 'participant') {
    const colors = sequenceColors(theme), geometry = node.sequenceLayout;
    body = `<path data-sequence-lifeline="true" d="M${coordinate(x + width / 2)} ${coordinate(y + geometry.headerHeight)}V${coordinate(bottom - 12)}" fill="none" stroke="${xml(colors.lifeline)}" stroke-width="1.5" stroke-dasharray="6 5"/>`;
    body += `<rect data-sequence-header="true" x="${coordinate(x)}" y="${coordinate(y)}" width="${coordinate(width)}" height="${geometry.headerHeight}" rx="3" fill="${colors.header}" stroke="${colors.border}" stroke-width="1.2"/>`;
    body += textBlock(data.name || 'Participant', x + width / 2, y + 30, width - 20, { fontSize: 14, maxLines: 1, weight: 650, anchor: 'middle' });
    body += textBlock(data.role || '', x + width / 2, y + 53, width - 20, { fontSize: 12, maxLines: 1, fill: muted, anchor: 'middle' });
    body += geometry.activations.map(activation => `<rect data-sequence-activation="${xml(activation.id)}" x="${coordinate(x + width / 2 + activation.xOffset - activation.width / 2)}" y="${coordinate(y + activation.y)}" width="${activation.width}" height="${coordinate(activation.height)}" fill="${colors.activation}" stroke="${colors.activationBorder}" stroke-width="1.2"/>`).join('');
    body += `<path d="M${coordinate(x + width / 2 - 5)} ${coordinate(bottom - 8)}h11" stroke="${xml(colors.lifeline)}"/>`;
  } else if (type === 'note') {
    body = `<path d="M${coordinate(x)} ${coordinate(y)}H${coordinate(right - 13)}L${coordinate(right)} ${coordinate(y + 13)}V${coordinate(bottom)}H${coordinate(x)}Z" fill="${xml(theme.background)}" stroke="#b78b4d"/><path d="M${coordinate(right - 13)} ${coordinate(y)}v13h13" fill="none" stroke="#b78b4d"/>`;
    body += textBlock(data.name || 'Note', x + 14, y + 28, width - 28, { fontSize: 13, weight: 650 });
    body += textBlock(data.description || '', x + 14, y + 51, width - 28, { fontSize: 11, lineHeight: 15, maxLines: Math.max(1, Math.floor((height - 59) / 15) + 1), fill: muted });
  } else if (type === 'dataStructure') {
    body = renderStructure(node, theme);
  } else {
    const component = getDiagramComponent(data.componentKey), brand = COMPONENT_BRAND_ICONS[component.brand];
    if (component.visualKind) body = visualNode(node, component, theme);
    else {
    const replicas = getReplicaLayout(data.replicas);
    const glyphColor = componentGlyphColor(component.color, theme);
    const expanded = data.expandedNotes ? getExpandedNotesLayout(data) : null;
    // Match the role-first canvas without changing saved node bounds or ports.
    // Notes remain selectable metadata rather than turning the component into
    // a paragraph card. Replica ghosts repeat the symbol, never a card shell.
    const centerX = expanded ? x + expanded.nameCenterX : x + width / 2, glyphX = expanded ? x + expanded.glyphX : centerX - 32;
    const glyphY = expanded ? y + expanded.glyphY : y + Math.max(16, (height - 160) / 2 + 16);
    const mainGlyph = (left, top) => component.iconName ? eraserImage(component, left, top, theme)
      : roleGlyph(component.role, left, top, 64, glyphColor);
    body = replicas.offsets.map(offset => `<g data-replica-layer="${offset / 6}" opacity=".18">${mainGlyph(glyphX - offset, glyphY - offset)}</g>`).join('');
    body += `<g data-component-symbol="${xml(component.id)}">${mainGlyph(glyphX, glyphY)}`;
    if (brand && !component.iconName) {
      body += `<circle data-product-badge="true" cx="${coordinate(glyphX + 56)}" cy="${coordinate(glyphY + 56)}" r="15" fill="${xml(theme.background)}"/>`;
      body += productGlyph(brand, glyphX + 44, glyphY + 44, 24, component.color);
    }
    body += '</g>';
    if (String(data.description || '').trim() && !expanded) {
      body += `<g data-component-notes="true" transform="translate(${coordinate(centerX + 58)} ${coordinate(glyphY + 6)})" fill="none" stroke="${xml(muted)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><title>${xml(data.description)}</title><path d="M3 2h9l4 4v13H3zM12 2v5h4M6 10h7M6 14h5"/><circle cx="16" cy="2" r="2" fill="${component.color}" stroke="none"/></g>`;
    }
    if (expanded) {
      body += expandedText(expanded.nameLines, centerX, y + expanded.nameTop, { fontSize: expanded.nameFontSize, lineHeight: expanded.lineHeight, anchor: 'middle', weight: 650, attribute: 'data-expanded-name' });
      body += expandedText(expanded.notesLines, x + expanded.notesX, y + expanded.notesTop, { fontSize: expanded.notesFontSize, lineHeight: expanded.lineHeight, attribute: 'data-expanded-notes' });
    } else body += textBlock(data.name || component.label, centerX, glyphY + 87, width - 24, { fontSize: 13, lineHeight: 18, maxLines: 2, weight: 650, anchor: 'middle' });
    if (replicas.count > 1) body += `<g data-replica-count="${replicas.count}"><title>${replicas.count} instances</title>${textBlock(`×${replicas.count}`, centerX, expanded ? y + expanded.replicaTop + 10 : glyphY + 129, 72, { fontSize: 10, fill: muted, anchor: 'middle', monospace: true })}</g>`;
    }
  }
  return `<g data-node-id="${xml(node.id)}" data-node-type="${xml(type)}"><title>${xml(title)}</title>${body}</g>`;
}

function endpoint(node, handle, fallback) {
  const sequence = getSequenceEndpointOffset(node.type === 'participant' ? node.data : {}, handle);
  if (sequence) return { x: node.x + node.width / 2 + sequence.xOffset, y: node.y + sequence.y, direction: sequence.direction };
  const side = Object.hasOwn(DIRECTIONS, handle) ? handle : fallback;
  if (node.type === 'component') {
    const component = getDiagramComponent(node.data?.componentKey);
    if (component.visualKind) {
      const port = getVisualGeometry(component, node.width, node.height).ports[side];
      return { x: node.x + port[0], y: node.y + port[1], direction: side };
    }
    if (node.data?.expandedNotes) {
      const layout = getExpandedNotesLayout(node.data);
      return { x: node.x + (side === 'left' ? 0 : side === 'right' ? node.width : layout.nameCenterX), y: node.y + (side === 'top' ? 0 : side === 'bottom' ? node.height : layout.glyphY + 32), direction: side };
    }
    const centerX = node.x + node.width / 2, centerY = node.y + node.height / 2;
    return { x: centerX + (side === 'left' ? -50 : side === 'right' ? 50 : 0), y: centerY + (side === 'top' ? -76 : side === 'bottom' ? 76 : -32), direction: side };
  }
  return { x: node.x + (side === 'left' ? 0 : side === 'right' ? node.width : node.width / 2), y: node.y + (side === 'top' ? 0 : side === 'bottom' ? node.height : node.height / 2), direction: side };
}

function routeEdge(edge, nodes, expandedRoute) {
  const source = nodes.get(edge.source), target = nodes.get(edge.target);
  if (!source || !target) return null;
  const start = endpoint(source, edge.sourceHandle, 'right'), end = endpoint(target, edge.targetHandle, 'left');
  const relation = RELATIONS.has(edge.data?.relation) ? edge.data.relation : 'association';
  if (expandedRoute?.unroutable) throw new Error(`Cannot export the expanded diagram: connection ${edge.id} has no safe route. Move overlapping objects or return to compact view.`);
  if (expandedRoute) return { ...edge, ...expandedRoute, relation, label: { x: expandedRoute.labelX, y: expandedRoute.labelY }, controls: expandedRoute.points, expandedRoute: true };
  const sequence = SEQUENCE_RELATIONS.has(relation);
  const umlSequence = sequence && source.type === 'participant' && target.type === 'participant';
  const curve = Math.max(.05, Math.min(1.2, number(edge.data?.curvature, .3)));
  let path, label, controls = [start, end];
  if (source.id === target.id) {
    const loop = getSelfLoopGeometry({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y, sourcePosition: start.direction, sequence, curvature: curve });
    path = loop.path;
    label = { x: loop.labelX, y: loop.labelY - (sequence ? 13 : 0) };
    controls = loop.controls;
  } else if (sequence) {
    path = `M${point(start)} L${point(end)}`;
    label = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 13 };
  } else {
    const distance = Math.max(45, Math.hypot(end.x - start.x, end.y - start.y) * curve);
    const fromDirection = DIRECTIONS[start.direction], toDirection = DIRECTIONS[end.direction];
    const control1 = { x: start.x + fromDirection[0] * distance, y: start.y + fromDirection[1] * distance };
    const control2 = { x: end.x + toDirection[0] * distance, y: end.y + toDirection[1] * distance };
    path = `M${point(start)} C${point(control1)} ${point(control2)} ${point(end)}`;
    label = { x: (start.x + 3 * control1.x + 3 * control2.x + end.x) / 8, y: (start.y + 3 * control1.y + 3 * control2.y + end.y) / 8 };
    controls = [start, control1, control2, end];
  }
  const authored = !umlSequence && connectionGeometry(edge.data, start, end);
  if (authored) { path = authored.path; label = { x: authored.labelX, y: authored.labelY }; controls = authored.controls; }
  const labelText = String(edge.data?.label || '');
  if (umlSequence) {
    const layout = getSequenceLabelLayout(labelText, source.id === target.id ? Math.abs(controls[1].x - start.x) : Math.abs(end.x - start.x), { self: source.id === target.id });
    if (source.id === target.id) label.x=start.x+(start.direction==='left'?-1:1)*Math.max(Math.abs(label.x-start.x),layout.width/2+10);
    // The entire caption sits above the arrow; it never cuts the message line.
    label.y = (source.id === target.id ? start.y : (start.y + end.y) / 2) - layout.height / 2 - 8;
    return { ...edge, relation, path, label, labelText, labelWidth: layout.width, labelHeight: layout.height, labelLines: layout.lines, umlSequence: true, controls };
  }
  const labelWidth = Math.min(340, Math.max(30, textWidth(labelText, 11) + 16));
  const labelLines = wrapText(labelText, labelWidth - 16, 11, 6);
  const labelHeight = labelText ? labelLines.length * 15 + 8 : 0;
  return { ...edge, relation, path, label, labelText, labelWidth, labelHeight, controls };
}

function markerDefinitions(theme) {
  const color = xml(theme.line), background = xml(theme.background);
  const arrow = (id, drawing) => `<marker id="${id}" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse" markerUnits="userSpaceOnUse">${drawing}</marker>`;
  const diamond = (id, fill) => `<marker id="${id}" viewBox="-1 -1 18 14" refX="0" refY="6" markerWidth="18" markerHeight="14" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 6 8 1 16 6 8 11Z" fill="${fill}" stroke="${color}" stroke-width="1.4"/></marker>`;
  return '<defs>' + arrow('argus-arrow', `<path d="M1 1 11 6 1 11Z" fill="${color}" stroke="${color}" stroke-width="1.4"/>`)
    + arrow('argus-open-arrow', `<path d="M1 1 11 6 1 11" fill="none" stroke="${color}" stroke-width="1.5"/>`)
    + arrow('argus-triangle', `<path d="M1 1 11 6 1 11Z" fill="${background}" stroke="${color}" stroke-width="1.4"/>`)
    + diamond('argus-aggregation', background) + diamond('argus-composition', color)
    + arrow('argus-sequence-arrow', `<path d="M1 1 11 6 1 11Z" fill="${sequenceColors(theme).line}"/>`)
    + arrow('argus-sequence-open-arrow', `<path d="M1 1 11 6 1 11" fill="none" stroke="${sequenceColors(theme).line}" stroke-width="1.5"/>`) + '</defs>';
}

function renderEdge(edge, theme) {
  const diamond = edge.relation === 'aggregation' || edge.relation === 'composition';
  const hollow = edge.relation === 'inheritance' || edge.relation === 'implementation';
  const open = edge.relation === 'return' || edge.relation === 'async';
  const marker = diamond ? `marker-start="url(#argus-${edge.relation})"` : `marker-end="url(#argus-${edge.umlSequence ? 'sequence-' : ''}${hollow ? 'triangle' : open ? 'open-arrow' : 'arrow'})"`;
  const dashed = ['dependency', 'implementation', 'return'].includes(edge.relation) ? ' stroke-dasharray="7 5"' : '';
  return `<g data-edge-id="${xml(edge.id)}" data-relation="${edge.relation}"><title>${xml(edge.labelText || edge.relation)}</title><path d="${edge.path}" fill="none" stroke="${xml(edge.umlSequence ? sequenceColors(theme).line : theme.line)}" stroke-width="1.7" stroke-linejoin="round"${dashed} ${marker}/></g>`;
}

function renderEdgeLabel(edge, theme) {
  if (!edge.labelText) return '';
  const x = edge.label.x - edge.labelWidth / 2, y = edge.label.y - edge.labelHeight / 2;
  if (edge.umlSequence) return `<g data-edge-label="${xml(edge.id)}" data-sequence-label="true"><rect x="${coordinate(x)}" y="${coordinate(y)}" width="${coordinate(edge.labelWidth)}" height="${coordinate(edge.labelHeight)}" rx="2" fill="${xml(theme.background)}"/>${expandedText(edge.labelLines, edge.label.x, y + 4, { fontSize: 13, lineHeight: 18, anchor: 'middle', attribute: 'data-sequence-caption' })}</g>`;
  const text = edge.expandedRoute ? expandedText(edge.labelLines, edge.label.x, y + 6, { fontSize: 11, lineHeight: 15, anchor: 'middle', attribute: 'data-expanded-edge-label' }) : textBlock(edge.labelText, edge.label.x, y + 15, edge.labelWidth - 16, { fontSize: 11, lineHeight: 15, maxLines: 6, fill: theme.foreground, anchor: 'middle' });
  return `<g data-edge-label="${xml(edge.id)}"><rect x="${coordinate(x)}" y="${coordinate(y)}" width="${coordinate(edge.labelWidth)}" height="${coordinate(edge.labelHeight)}" rx="4" fill="${xml(theme.background)}"/>${text}</g>`;
}

/** Export a structured graph as self-contained, selectable, ordinary SVG. */
function structuredScene(graph) {
  const nodes = list(graph?.nodes).filter(node => node && ['umlClass', 'component', 'participant', 'note', 'dataStructure', 'group'].includes(node.type) && !node.hidden).map(normalizeNode);
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const expandedRoutes = nodes.some(node => node.data?.expandedNotes) ? getExpandedRoutes({ nodes, edges: graph?.edges }) : Object.create(null);
  const edges = list(graph?.edges).filter(edge => edge && !edge.hidden).map(edge => routeEdge(edge, nodeMap, expandedRoutes[edge.id])).filter(Boolean);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function include(x, y) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  nodes.forEach(node => {
    include(node.x, node.y); include(node.x + node.width, node.y + node.height);
    if (node.type === 'component' && !getDiagramComponent(node.data?.componentKey).visualKind) {
      const extent = getReplicaLayout(node.data.replicas).extent;
      const expanded = node.data.expandedNotes ? getExpandedNotesLayout(node.data) : null;
      include(node.x + (expanded ? expanded.glyphX : node.width / 2 - 32) - extent, node.y + (expanded ? expanded.glyphY : Math.max(16, (node.height - 160) / 2 + 16)) - extent);
    }
  });
  edges.forEach(edge => {
    edge.controls.forEach(control => include(control.x, control.y));
    if (edge.labelText) { include(edge.label.x - edge.labelWidth / 2, edge.label.y - edge.labelHeight / 2); include(edge.label.x + edge.labelWidth / 2, edge.label.y + edge.labelHeight / 2); }
  });
  const bounds = nodes.length ? { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) } : { x: 0, y: 0, width: 640, height: 360 };
  return { nodes, edges, bounds };
}

// Include captions and self calls in raster framing, not only node rectangles.
export function getStructuredBounds(graph) { return structuredScene(graph).bounds; }

export function exportStructuredSvg(graph, { background = '#151515', foreground = '#e7e7e7', line = '#b0b0b0', iconAssets = {} } = {}) {
  const theme = { background: safeColor(background, '#151515'), foreground: safeColor(foreground, '#e7e7e7'), line: safeColor(line, '#b0b0b0'), iconAssets };
  const { nodes, edges, bounds: contentBounds } = structuredScene(graph);
  const padding = nodes.length ? 48 : 0;
  const bounds = { x: contentBounds.x - padding, y: contentBounds.y - padding, width: contentBounds.width + padding * 2, height: contentBounds.height + padding * 2 };
  const groupNodes = nodes.filter(node => node.type === 'group').sort((a, b) => b.width * b.height - a.width * a.height);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(bounds.width)}" height="${Math.ceil(bounds.height)}" viewBox="${coordinate(bounds.x)} ${coordinate(bounds.y)} ${coordinate(bounds.width)} ${coordinate(bounds.height)}" fill="${xml(theme.foreground)}" font-family="${FONT}" role="img"><title>Argus diagram</title><desc>Structured diagram with ${nodes.length} objects and ${edges.length} relationships. Full labels are included in each object title.</desc>${markerDefinitions(theme)}<rect x="${coordinate(bounds.x)}" y="${coordinate(bounds.y)}" width="${coordinate(bounds.width)}" height="${coordinate(bounds.height)}" fill="${xml(theme.background)}"/>${groupNodes.map(node => renderNode(node, theme)).join('')}${edges.map(edge => renderEdge(edge, theme)).join('')}${nodes.filter(node => node.type !== 'group').map(node => renderNode(node, theme)).join('')}${edges.map(edge => renderEdgeLabel(edge, theme)).join('')}</svg>`;
}
