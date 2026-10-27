import * as Y from 'yjs';
import { cleanStructured, emptySnapshot, MAX_IMPORT_BYTES } from '../diagram-model.mjs';
import { sanitizeSketchSnapshot } from '../diagram-sketch-model.mjs';

export const BOARD_DOC_ORIGIN = Symbol('board-initialization');
export const REMOTE_ORIGIN = Symbol('canvas-remote');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left, right) => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]));
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
};
const own = (value, key) => Object.hasOwn(value || {}, key);
const uniqueKey = () => `item:${globalThis.crypto.randomUUID()}`;
const itemKey = value => object(value) && typeof value.id === 'string' ? `id:${value.id}` : null;

function portableJson(value, visiting = new Set(), depth = 0) {
  if (depth > 100) throw new Error('Shared board data is too deeply nested.');
  if (Array.isArray(value) || object(value)) {
    if (visiting.has(value)) throw new Error('Shared board data cannot contain cycles.');
    visiting.add(value);
    const normalized = Array.isArray(value)
      ? Array.from(value, item => item === undefined ? null : portableJson(item, visiting, depth + 1))
      : Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, portableJson(item, visiting, depth + 1)]));
    visiting.delete(value); return normalized;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error('Shared boards must contain only finite JSON data.');
}

function assertIds(items, label, seen = new Set()) {
  if (!Array.isArray(items)) throw new Error(`Invalid ${label}.`);
  for (const item of items) {
    if (!object(item) || typeof item.id !== 'string' || !item.id || item.id.length > 160 || seen.has(item.id)) {
      throw new Error(`${label} must have unique, stable IDs.`);
    }
    seen.add(item.id);
  }
  return seen;
}

function assertStructureIds(data, seen = new Set(), depth = 0) {
  if (depth > 8) throw new Error('Nested containers support at most 8 levels.');
  for (const key of ['entries', 'links', 'pointers']) assertIds(data[key] || [], 'Structure items', seen);
  for (const entry of data.entries || []) {
    if (entry.keyContainer) assertStructureIds(entry.keyContainer, seen, depth + 1);
    if (entry.valueContainer) assertStructureIds(entry.valueContainer, seen, depth + 1);
  }
}

/** The shared payload intentionally omits viewport, selections, tool state and libraries. */
export function sanitizeSharedBoard(board = {}) {
  const snapshot = board.snapshot || emptySnapshot();
  const structured = snapshot.structured || { nodes: [], edges: [] };
  assertIds(structured.nodes, 'Diagram objects');
  assertIds(structured.edges, 'Connections');
  for (const node of structured.nodes) {
    if (node.type === 'umlClass') {
      const seen = assertIds(node.data?.fields || [], 'Class members');
      assertIds(node.data?.methods || [], 'Class members', seen);
    }
    if (node.type === 'dataStructure') assertStructureIds(node.data || {});
  }
  const ids = new Set(structured.nodes.map(node => node.id));
  // Concurrent deletion of a node and insertion of an edge is valid CRDT state.
  // Every replica derives the same visible graph without inventing IDs or edits.
  const cleaned = cleanStructured({ ...structured, edges: structured.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) });
  const sketch = sanitizeSketchSnapshot({ elements: snapshot.sketch?.elements || [], files: snapshot.sketch?.files || {} });
  assertIds(sketch.elements, 'Drawing elements');
  const result = portableJson({
    id: typeof board.id === 'string' ? board.id.slice(0, 160) : '',
    name: typeof board.name === 'string' && board.name.trim() ? board.name.slice(0, 160) : 'Untitled board',
    snapshot: { structured: { nodes: cleaned.nodes, edges: cleaned.edges }, sketch: { elements: sketch.elements, files: sketch.files } },
  });
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_IMPORT_BYTES) throw new Error('The shared board exceeds the 10 MB limit.');
  return result;
}

// Arrays retain a map entry per item, including scalar items. Editing one cell,
// field, or nested property never replaces its siblings' CRDT values.
function encode(value) {
  if (Array.isArray(value)) {
    const result = new Y.Map(), items = new Y.Map(), order = new Y.Array();
    const keys = value.map(item => itemKey(item) || uniqueKey());
    result.set('$items', items); result.set('$order', order);
    value.forEach((item, index) => items.set(keys[index], encode(item)));
    order.insert(0, keys);
    return result;
  }
  if (object(value)) {
    const result = new Y.Map(), fields = new Y.Map();
    result.set('$object', fields);
    for (const [key, child] of Object.entries(value)) fields.set(key, encode(child));
    return result;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error('Shared boards must contain only finite JSON data.');
}

function decode(value, budget = { count: 0 }, depth = 0) {
  if (++budget.count > 250_000 || depth > 100) throw new Error('Shared board data is too deeply nested or too large.');
  if (!(value instanceof Y.Map)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    throw new Error('Invalid shared document value.');
  }
  const fields = value.get('$object');
  if (fields instanceof Y.Map && value.size === 1) {
    return Object.fromEntries([...fields.entries()].map(([key, child]) => [key, decode(child, budget, depth + 1)]));
  }
  const items = value.get('$items'), order = value.get('$order');
  if (!(items instanceof Y.Map) || !(order instanceof Y.Array) || value.size !== 2) throw new Error('Invalid shared document collection.');
  const seen = new Set(), result = [];
  for (const key of order.toArray()) {
    if (typeof key !== 'string') throw new Error('Invalid shared document item key.');
    if (!seen.has(key) && items.has(key)) {
      seen.add(key); result.push(decode(items.get(key), budget, depth + 1));
    }
  }
  return result;
}

function patchValue(parent, key, previous, next) {
  if (equal(previous, next)) return;
  const current = parent.get(key);
  if (Array.isArray(previous) && Array.isArray(next) && current instanceof Y.Map && current.get('$items') instanceof Y.Map) {
    patchArray(current, previous, next);
  } else if (object(previous) && object(next) && current instanceof Y.Map && current.get('$object') instanceof Y.Map) {
    patchObject(current.get('$object'), previous, next);
  } else parent.set(key, encode(next));
}

function patchObject(fields, previous, next) {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (!own(next, key)) { if (own(previous, key)) fields.delete(key); }
    else patchValue(fields, key, previous[key], next[key]);
  }
}

function patchArray(array, previous, next) {
  const items = array.get('$items'), order = array.get('$order');
  const currentKeys = [...new Set(order.toArray())].filter(key => items.has(key));
  const previousKeys = previous.map((value, index) => itemKey(value) || currentKeys[index]);
  let nextKeys;
  if (previous.every(itemKey) && next.every(itemKey)) nextKeys = next.map(itemKey);
  else if (previous.length === next.length) nextKeys = next.map((value, index) => itemKey(value) || previousKeys[index] || uniqueKey());
  else {
    let prefix = 0, suffix = 0;
    while (prefix < previous.length && prefix < next.length && equal(previous[prefix], next[prefix])) prefix++;
    while (suffix < previous.length - prefix && suffix < next.length - prefix && equal(previous[previous.length - suffix - 1], next[next.length - suffix - 1])) suffix++;
    nextKeys = next.map((value, index) => itemKey(value) || (index < prefix ? previousKeys[index] : index >= next.length - suffix ? previousKeys[previous.length - next.length + index] : uniqueKey()));
  }
  const nextSet = new Set(nextKeys), previousSet = new Set(previousKeys);
  const previousByKey = new Map(previousKeys.map((key, index) => [key, previous[index]]));
  for (const key of previousKeys) if (!nextSet.has(key)) items.delete(key);
  next.forEach((value, index) => {
    const key = nextKeys[index];
    if (!items.has(key) && previousSet.has(key)) return; // A remote deletion must not be resurrected by a stale local property edit.
    if (!items.has(key)) items.set(key, encode(value));
    else patchValue(items, key, previousByKey.get(key), value);
  });
  // Remove only locally deleted/reordered entries. Concurrent additions stay in
  // their Y.Array positions and duplicate order references are read once.
  for (let index = order.length - 1; index >= 0; index--) {
    const key = order.get(index);
    if (previousSet.has(key) && !nextSet.has(key)) order.delete(index, 1);
  }
  const oldCommon = previousKeys.filter(key => nextSet.has(key));
  const newCommon = nextKeys.filter(key => previousSet.has(key));
  if (!equal(oldCommon, newCommon)) {
    for (let index = order.length - 1; index >= 0; index--) if (previousSet.has(order.get(index))) order.delete(index, 1);
  }
  let after = 0;
  for (const key of nextKeys) {
    if (!items.has(key)) continue;
    const index = order.toArray().indexOf(key);
    if (index >= 0) after = index + 1;
    else { order.insert(Math.min(after, order.length), [key]); after++; }
  }
}

function rejectDroppedFields(raw, sanitized, path = '') {
  if (Array.isArray(raw) && Array.isArray(sanitized)) {
    const byId = new Map(sanitized.filter(object).map(item => [item.id, item]));
    raw.forEach((item, index) => {
      const cleaned = itemKey(item) ? byId.get(item.id) : sanitized[index];
      // A peer may delete an endpoint while another adds a relationship. The
      // same deterministic rule applies inside recursive DSA containers.
      if (cleaned === undefined && /\.(edges|links|pointers)$/.test(path)) return;
      if (cleaned === undefined) throw new Error('Shared board data exceeds a supported collection limit.');
      rejectDroppedFields(item, cleaned, `${path}[]`);
    });
  } else if (object(raw) && object(sanitized)) {
    for (const [key, value] of Object.entries(raw)) {
      if (!own(sanitized, key)) throw new Error('Shared board data contains unsupported, unsafe, or personal fields.');
      if (key === 'link' && path.startsWith('.snapshot.sketch.elements') && value !== sanitized[key]) throw new Error('Shared drawing contains an unsafe link.');
      rejectDroppedFields(value, sanitized[key], `${path}.${key}`);
    }
  }
}

export function createBoardDoc(board) {
  const doc = new Y.Doc();
  if (board) {
    const shared = sanitizeSharedBoard(board);
    doc.transact(() => patchObject(doc.getMap('board'), {}, shared), BOARD_DOC_ORIGIN);
  } else doc.getMap('board');
  return doc;
}

export function validateBoardDoc(doc) {
  if (!(doc instanceof Y.Doc)) throw new Error('A Yjs board document is required.');
  const root = doc.getMap('board');
  if (root.size !== 3 || !root.has('id') || !root.has('name') || !root.has('snapshot')) throw new Error('Invalid shared board document.');
  const budget = { count: 0 };
  const raw = Object.fromEntries([...root.entries()].map(([key, value]) => [key, decode(value, budget)]));
  if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_IMPORT_BYTES) throw new Error('The shared board exceeds the 10 MB limit.');
  const sanitized = sanitizeSharedBoard(raw);
  rejectDroppedFields(raw, sanitized);
  return sanitized;
}

export function readBoardDoc(doc) {
  const shared = validateBoardDoc(doc);
  return { ...shared, snapshot: {
    structured: { ...shared.snapshot.structured, viewport: { x: 0, y: 0, zoom: 1 } },
    sketch: { ...shared.snapshot.sketch, appState: {}, libraryItems: [] },
  } };
}

export function applyBoardChange(doc, previousBoard, nextBoard, origin) {
  const previous = sanitizeSharedBoard(previousBoard), next = sanitizeSharedBoard(nextBoard);
  if (previous.id !== next.id) throw new Error('A shared board ID cannot change.');
  if (equal(previous, next)) return false;
  doc.transact(() => patchObject(doc.getMap('board'), previous, next), origin);
  return true;
}

export function createLocalUndoManager(doc, origin) {
  if (origin === undefined || origin === null) throw new Error('A distinct local undo origin is required.');
  return new Y.UndoManager(doc.getMap('board'), { trackedOrigins: new Set([origin]), captureTimeout: 500 });
}
