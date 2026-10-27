import { getDiagramComponent } from './diagram-catalog.mjs';
import { getVisualGeometry } from './diagram-visuals.mjs';
import { getGroupNodeBounds } from './diagram-groups.mjs';
import { getExpandedNotesLayout, wrapExpandedText } from './diagram-expanded-layout.mjs';
import { getSequenceEndpointOffset } from './diagram-sequence.mjs';

export const EXPANDED_ROUTE_LAYOUT = Object.freeze({ nodeGap: 8, stub: 16, labelPadding: 8, labelGap: 8, fontSize: 11, lineHeight: 15, maxLabelWidth: 260 });
const EPSILON = .01;
const DIRECTIONS = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const round = value => Math.round(value * 100) / 100;
const length = points => points.slice(1).reduce((total, point, index) => total + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y), 0);
const same = (a, b) => a.x === b.x && a.y === b.y;
const inflate = (rect, gap) => ({ ...rect, x: rect.x - gap, y: rect.y - gap, width: rect.width + gap * 2, height: rect.height + gap * 2 });
const overlap = (a, b) => a.x < b.x + b.width - EPSILON && a.x + a.width > b.x + EPSILON && a.y < b.y + b.height - EPSILON && a.y + a.height > b.y + EPSILON;

function simplify(points) {
  const result = [];
  for (const point of points) {
    if (result.length && same(result.at(-1), point)) continue;
    while (result.length > 1) {
      const a = result.at(-2), b = result.at(-1);
      if ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y)) result.pop();
      else break;
    }
    result.push({ x: round(point.x), y: round(point.y) });
  }
  return result;
}

function intersectsSegment(a, b, rect) {
  if (Math.abs(a.y - b.y) < EPSILON) return a.y > rect.y + EPSILON && a.y < rect.y + rect.height - EPSILON && Math.max(a.x, b.x) > rect.x + EPSILON && Math.min(a.x, b.x) < rect.x + rect.width - EPSILON;
  if (Math.abs(a.x - b.x) < EPSILON) return a.x > rect.x + EPSILON && a.x < rect.x + rect.width - EPSILON && Math.max(a.y, b.y) > rect.y + EPSILON && Math.min(a.y, b.y) < rect.y + rect.height - EPSILON;
  return true;
}

class RectIndex {
  constructor(rectangles = []) { this.cells = new Map(); this.large = []; this.rectangles = []; rectangles.forEach(rect => this.add(rect)); }
  add(rect) {
    this.rectangles.push(rect);
    const bounds = this.cellBounds(rect);
    if ((bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1) > 256) { this.large.push(rect); return; }
    for (let x = bounds.x0; x <= bounds.x1; x++) for (let y = bounds.y0; y <= bounds.y1; y++) {
      const key = `${x}:${y}`, bucket = this.cells.get(key) || [];
      bucket.push(rect); this.cells.set(key, bucket);
    }
  }
  cellBounds(rect) { return { x0: Math.floor(rect.x / 256), y0: Math.floor(rect.y / 256), x1: Math.floor((rect.x + rect.width) / 256), y1: Math.floor((rect.y + rect.height) / 256) }; }
  query(rect) {
    const bounds = this.cellBounds(rect);
    if ((bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1) > 2048) return this.rectangles;
    const found = new Set(this.large);
    for (let x = bounds.x0; x <= bounds.x1; x++) for (let y = bounds.y0; y <= bounds.y1; y++) for (const item of this.cells.get(`${x}:${y}`) || []) found.add(item);
    return found;
  }
  blockers(a, b) {
    const bounds = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
    return [...this.query(bounds)].filter(rect => intersectsSegment(a, b, rect));
  }
  freeRect(rect) { for (const item of this.query(rect)) if (overlap(rect, item)) return false; return true; }
  freePath(points, blocked) {
    for (let index = 1; index < points.length; index++) {
      const blockers = this.blockers(points[index - 1], points[index]);
      if (blockers.length) { blockers.forEach(rect => blocked?.add(rect)); return false; }
    }
    return true;
  }
}

function nodeBounds(node) {
  const bounds = getGroupNodeBounds(node);
  const position = node.positionAbsolute || node.position;
  return { ...bounds, x: Number.isFinite(position?.x) ? position.x : bounds.x, y: Number.isFinite(position?.y) ? position.y : bounds.y, id: node.id };
}

function endpoint(node, handle, fallback) {
  const rect = nodeBounds(node), side = Object.hasOwn(DIRECTIONS, handle) ? handle : fallback;
  let x, y, direction = side;
  const sequence = getSequenceEndpointOffset(node.type === 'participant' ? node.data : {}, handle);
  if (sequence) {
    direction = sequence.direction;
    x = rect.x + rect.width / 2 + sequence.xOffset; y = rect.y + sequence.y;
  } else if (node.type === 'component') {
    const component = getDiagramComponent(node.data?.componentKey);
    if (component.visualKind) {
      const port = getVisualGeometry(component, rect.width, rect.height).ports[side]; x = rect.x + port[0]; y = rect.y + port[1];
    } else if (node.data?.expandedNotes) {
      const layout = getExpandedNotesLayout(node.data);
      x = rect.x + (side === 'left' ? 0 : side === 'right' ? rect.width : layout.nameCenterX);
      y = rect.y + (side === 'top' ? 0 : side === 'bottom' ? rect.height : layout.glyphY + 32);
    } else {
      x = rect.x + rect.width / 2 + (side === 'left' ? -50 : side === 'right' ? 50 : 0);
      y = rect.y + rect.height / 2 + (side === 'top' ? -76 : side === 'bottom' ? 76 : -32);
    }
  } else {
    x = rect.x + (side === 'left' ? 0 : side === 'right' ? rect.width : rect.width / 2);
    y = rect.y + (side === 'top' ? 0 : side === 'bottom' ? rect.height : rect.height / 2);
  }
  const vector = DIRECTIONS[direction], stub = EXPANDED_ROUTE_LAYOUT.stub;
  // Some legacy shape/sequence handles sit inside their own outline; the
  // first/last segment may cross that outline, but never another object.
  const exit = { x: x + vector[0] * stub, y: y + vector[1] * stub };
  if (direction === 'left') exit.x = Math.min(exit.x, rect.x - stub);
  if (direction === 'right') exit.x = Math.max(exit.x, rect.x + rect.width + stub);
  if (direction === 'top') exit.y = Math.min(exit.y, rect.y - stub);
  if (direction === 'bottom') exit.y = Math.max(exit.y, rect.y + rect.height + stub);
  return { x: round(x), y: round(y), direction, exit, rect };
}

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    const items = this.items; let index = items.length; items.push(item);
    while (index) { const parent = (index - 1) >> 1; if (items[parent].score <= item.score) break; items[index] = items[parent]; index = parent; }
    items[index] = item;
  }
  pop() {
    const items = this.items, result = items[0], last = items.pop();
    if (items.length) {
      let index = 0;
      while (index * 2 + 1 < items.length) {
        let child = index * 2 + 1; if (child + 1 < items.length && items[child + 1].score < items[child].score) child++;
        if (last.score <= items[child].score) break; items[index] = items[child]; index = child;
      }
      items[index] = last;
    }
    return result;
  }
}

function gridRoute(start, end, rectangles, index, bounds, maxVisits = 24000) {
  const xs = [...new Set([start.x, end.x, bounds.left, bounds.right, ...rectangles.flatMap(rect => [rect.x - 1, rect.x + rect.width + 1])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, bounds.top, bounds.bottom, ...rectangles.flatMap(rect => [rect.y - 1, rect.y + rect.height + 1])])].sort((a, b) => a - b);
  const startX = xs.indexOf(start.x), startY = ys.indexOf(start.y), endX = xs.indexOf(end.x), endY = ys.indexOf(end.y);
  const heap = new MinHeap(), visited = new Map(), blocked = new Set(), segmentCache = new Map();
  const key = (x, y, direction) => `${x}:${y}:${direction}`;
  const origin = { x: startX, y: startY, direction: 0, cost: 0, parent: null };
  origin.score = Math.abs(start.x - end.x) + Math.abs(start.y - end.y); heap.push(origin); visited.set(key(startX, startY, 0), 0);
  let attempts = 0;
  while (heap.items.length && attempts++ < maxVisits) {
    const current = heap.pop();
    if (current.cost !== visited.get(key(current.x, current.y, current.direction))) continue;
    if (current.x === endX && current.y === endY) {
      const points = []; let step = current;
      while (step) { points.push({ x: xs[step.x], y: ys[step.y] }); step = step.parent; }
      return { points: simplify(points.reverse()), blocked };
    }
    const a = { x: xs[current.x], y: ys[current.y] };
    for (const [dx, dy, direction] of [[-1, 0, 1], [1, 0, 1], [0, -1, 2], [0, 1, 2]]) {
      const x = current.x + dx, y = current.y + dy;
      if (x < 0 || x >= xs.length || y < 0 || y >= ys.length) continue;
      const b = { x: xs[x], y: ys[y] }, cacheKey = [Math.min(x, current.x), Math.min(y, current.y), direction].join(':');
      let free = segmentCache.get(cacheKey);
      if (free === undefined) { const blockers = index.blockers(a, b); free = !blockers.length; blockers.forEach(rect => blocked.add(rect)); segmentCache.set(cacheKey, free); }
      if (!free) continue;
      const cost = current.cost + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + (current.direction && current.direction !== direction ? 18 : 0), id = key(x, y, direction);
      if (visited.has(id) && visited.get(id) <= cost) continue;
      visited.set(id, cost); heap.push({ x, y, direction, cost, score: cost + Math.abs(b.x - end.x) + Math.abs(b.y - end.y), parent: current });
    }
  }
  return { points: null, blocked };
}

function candidateRoutes(start, end, bounds, fromRect, toRect) {
  const routes = [[start, { x: end.x, y: start.y }, end], [start, { x: start.x, y: end.y }, end]];
  const xs = [(start.x + end.x) / 2, bounds.left, bounds.right], ys = [(start.y + end.y) / 2, bounds.top, bounds.bottom];
  for (const x of xs) routes.push([start, { x, y: start.y }, { x, y: end.y }, end]);
  for (const y of ys) routes.push([start, { x: start.x, y }, { x: end.x, y }, end]);
  if (fromRect && toRect) {
    const fromYs = [fromRect.y - 24, fromRect.y + fromRect.height + 24], toYs = [toRect.y - 24, toRect.y + toRect.height + 24];
    const fromXs = [fromRect.x - 16, fromRect.x + fromRect.width + 16], toXs = [toRect.x - 16, toRect.x + toRect.width + 16];
    for (const x of [bounds.left, bounds.right]) for (const a of fromYs) for (const b of toYs) routes.push([start, { x: start.x, y: a }, { x, y: a }, { x, y: b }, { x: end.x, y: b }, end]);
    for (const y of [bounds.top, bounds.bottom]) for (const a of fromXs) for (const b of toXs) routes.push([start, { x: a, y: start.y }, { x: a, y }, { x: b, y }, { x: b, y: end.y }, end]);
  }
  return routes.map(simplify).sort((a, b) => (length(a) + a.length * 18) - (length(b) + b.length * 18));
}

function findRoute(start, end, index, bounds, fromRect, toRect, { alternatives = false } = {}) {
  const blocked = new Set(), candidates = [];
  for (const route of candidateRoutes(start, end, bounds, fromRect, toRect)) {
    if (index.freePath(route, blocked)) { if (!alternatives) return [route]; candidates.push(route); }
  }
  if (candidates.length) return candidates;
  let selected = [...blocked].slice(0, 96);
  for (let attempt = 0; attempt < 3; attempt++) {
    const search = gridRoute(start, end, selected, index, bounds);
    if (search.points) return [search.points];
    selected = [...new Set([...selected, ...search.blocked])].slice(0, 192);
  }
  // Lazy A* only materialises visited grid cells, never the full Cartesian
  // product. This last pass handles irregular legacy layouts and cycles.
  const search = gridRoute(start, end, index.rectangles, index, bounds, 80000);
  return search.points ? [search.points] : [];
}

function labelLayout(value) {
  const labelText = String(value || '');
  const labelLines = labelText ? wrapExpandedText(labelText, { columns: 28 }) : [];
  // Conservative 11px system-font advances leave room for the editable label's
  // border/padding too. Capital-only protocols (HTTPS/TCP) must not wrap to an
  // unbudgeted extra row in the real textarea.
  const widthOf = text => Array.from(text).reduce((sum, char) => sum + (/\p{Mark}/u.test(char) ? 0 : char.codePointAt(0) > 0x2ff ? 11 : /[MWwm@%]/.test(char) ? 10.5 : /[A-Z]/.test(char) ? 8.5 : /[ijlI.,:;' ]/.test(char) ? 5 : char === '\t' ? 30 : 7.5), 0);
  return { labelText, labelLines, labelWidth: labelText ? Math.min(EXPANDED_ROUTE_LAYOUT.maxLabelWidth, Math.max(84, Math.ceil(Math.max(...labelLines.map(widthOf))) + 20)) : 0, labelHeight: labelLines.length ? labelLines.length * 15 + 12 : 0 };
}

function placeLabel(points, label, obstacles, labels) {
  if (!label.labelText) return { labelX: points[0]?.x || 0, labelY: points[0]?.y || 0 };
  const candidates = [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], horizontal = a.y === b.y;
    const segmentLength = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (segmentLength < (horizontal ? label.labelWidth : label.labelHeight) + 16) continue;
    for (const fraction of [.5, .25, .75]) {
      const labelX = a.x + (b.x - a.x) * fraction, labelY = a.y + (b.y - a.y) * fraction;
      const rect = { x: labelX - label.labelWidth / 2, y: labelY - label.labelHeight / 2, width: label.labelWidth, height: label.labelHeight };
      if (obstacles.freeRect(inflate(rect, 4)) && labels.freeRect(inflate(rect, EXPANDED_ROUTE_LAYOUT.labelGap))) candidates.push({ labelX, labelY, score: segmentLength + (horizontal ? 100 : 0) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

/** Shared deterministic orthogonal geometry for the expanded canvas and SVG. */
export function getExpandedRoutes(graph = {}) {
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter(node => node && !node.hidden).slice(0, 2000);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const rectangles = nodes.filter(node => node.type !== 'group').map(nodeBounds);
  const obstacles = new RectIndex(rectangles.map(rect => inflate(rect, EXPANDED_ROUTE_LAYOUT.nodeGap)));
  const labels = new RectIndex();
  const bounds = rectangles.length ? {
    left: Math.min(...rectangles.map(rect => rect.x)) - 40, right: Math.max(...rectangles.map(rect => rect.x + rect.width)) + 40,
    top: Math.min(...rectangles.map(rect => rect.y)) - 40, bottom: Math.max(...rectangles.map(rect => rect.y + rect.height)) + 40,
  } : { left: -40, right: 40, top: -40, bottom: 40 };
  const result = Object.create(null); let outerLane = bounds.top;
  const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter(edge => edge && !edge.hidden && byId.has(edge.source) && byId.has(edge.target)).slice(0, 5000).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const edge of edges) {
    const from = endpoint(byId.get(edge.source), edge.sourceHandle, 'right'), to = endpoint(byId.get(edge.target), edge.targetHandle, 'left');
    const label = labelLayout(edge.data?.label), candidates = findRoute(from.exit, to.exit, obstacles, bounds, from.rect, to.rect, { alternatives: Boolean(label.labelText) });
    if (edge.source === edge.target && same(from.exit, to.exit)) {
      const [dx, dy] = DIRECTIONS[from.direction];
      for (const distance of [64, -64]) {
        const p = from.exit;
        const loop = [p, { x: p.x + dx * 12, y: p.y + dy * 12 }, { x: p.x + dx * 12 - dy * distance, y: p.y + dy * 12 + dx * distance }, { x: p.x - dy * distance, y: p.y + dx * distance }, p];
        if (obstacles.freePath(loop)) candidates.unshift(loop);
      }
    }
    let points = null, placement = null;
    for (const middle of candidates) {
      const candidate = simplify([from, ...middle, to]);
      // A self-loop must leave the node even when both handles coincide.
      if (edge.source === edge.target && (length(candidate) < 64 || (same(from, to) && Math.abs(candidate.slice(1).reduce((area, point, index) => area + candidate[index].x * point.y - point.x * candidate[index].y, 0)) < 1))) continue;
      const proposed = placeLabel(candidate, label, obstacles, labels);
      if (proposed) { points = candidate; placement = proposed; break; }
    }
    if (!points || !placement) {
      // No safe in-corridor label (or a coincident self-loop): reserve a fresh
      // horizontal outer lane and route through it, rather than hiding text
      // behind a node or drawing an unconnected floating annotation.
      outerLane -= label.labelHeight + 32;
      const centerX = (from.exit.x + to.exit.x) / 2, half = Math.max(48, label.labelWidth / 2 + 16);
      const a = { x: centerX - half, y: outerLane }, b = { x: centerX + half, y: outerLane };
      const approach = { x: a.x, y: outerLane + label.labelHeight / 2 + 24 }, departure = { x: b.x, y: outerLane + label.labelHeight / 2 + 24 };
      const outside = { ...bounds, top: outerLane - 32 };
      const left = findRoute(from.exit, approach, obstacles, outside, from.rect, null)[0];
      const right = findRoute(departure, to.exit, obstacles, outside, null, to.rect)[0];
      if (left && right) {
        points = simplify([from, ...left, a, b, ...right, to]); placement = { labelX: centerX, labelY: outerLane };
      }
    }
    if (!points) {
      // Never draw a known-invalid segment through a node after the bounded
      // search is exhausted. The caller can surface this exceptional state.
      result[edge.id] = { ...label, path: '', points: [], labelX: from.x, labelY: from.y, unroutable: true };
      continue;
    }
    if (label.labelText) labels.add({ x: placement.labelX - label.labelWidth / 2, y: placement.labelY - label.labelHeight / 2, width: label.labelWidth, height: label.labelHeight, id: edge.id });
    result[edge.id] = { ...label, ...placement, points, path: points.map((point, index) => `${index ? 'L' : 'M'}${round(point.x)} ${round(point.y)}`).join(' '), sourcePoint: { x: from.x, y: from.y }, targetPoint: { x: to.x, y: to.y } };
  }
  return result;
}

/** Unpadded world bounds including every readable label and outer corridor. */
export function getExpandedRouteBounds(graph = {}, routes = {}) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const include = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); } };
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) if (node && !node.hidden) {
    const rect = nodeBounds(node); include(rect.x, rect.y); include(rect.x + rect.width, rect.y + rect.height);
  }
  for (const route of routes instanceof Map ? routes.values() : Object.values(routes)) {
    for (const point of route.points || []) include(point.x, point.y);
    if (route.labelText) { include(route.labelX - route.labelWidth / 2, route.labelY - route.labelHeight / 2); include(route.labelX + route.labelWidth / 2, route.labelY + route.labelHeight / 2); }
  }
  return Number.isFinite(left) ? { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) } : { x: 0, y: 0, width: 1, height: 1 };
}
