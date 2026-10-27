// Portable, bounded, non-executable data. Renderers and imports share this contract.
export { getStructureSize } from './diagram-structure-layout.mjs';
export const MAX_STRUCTURE_ENTRIES = 128;
export const MAX_STRUCTURE_LINKS = 256;
export const MAX_STRUCTURE_POINTERS = 16;
export const MAX_STRUCTURE_DEPTH = 8;
export const STRUCTURE_KINDS = Object.freeze([
  ['array', 'Array', 'Indexed cells', 'cells'],
  ['list', 'List / vector', 'A growable indexed sequence', 'cells'],
  ['matrix', 'Matrix', 'Rows and columns', 'matrix'],
  ['stack', 'Stack', 'Last in, first out', 'stack'],
  ['queue', 'Queue', 'First in, first out', 'queue'],
  ['deque', 'Deque', 'Add or remove at either end', 'queue'],
  ['map', 'Map / dictionary', 'Key and value columns', 'map'],
  ['set', 'Set', 'Unique members', 'cells'],
  ['linked-list', 'Linked list', 'Nodes with next links', 'linked'],
  ['doubly-linked-list', 'Doubly linked list', 'Next and previous links', 'linked'],
  ['circular-list', 'Circular list', 'Last node links back to the first', 'linked'],
  ['tree', 'Tree', 'Editable nodes and connections', 'tree'],
  ['bst', 'Binary search tree', 'Editable tree; ordering is manual', 'tree'],
  ['heap', 'Heap / priority queue', 'Editable tree; heap ordering is manual', 'tree'],
  ['trie', 'Trie', 'Prefix nodes and labeled connections', 'tree'],
  ['graph', 'Graph', 'Editable vertices and edges', 'graph'],
  ['union-find', 'Union find', 'Parent relationships', 'tree'],
  ['bitset', 'Bit set', 'Indexed bits', 'cells'],
  ['object', 'Object / custom container', 'Named members; adaptable to custom structures', 'map'],
].map(([id, label, description, shape]) => Object.freeze({ id, label, description, shape })));
const kinds = new Set(STRUCTURE_KINDS.map(item => item.id));
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const uid = () => globalThis.crypto.randomUUID();

export function createStructureData(kind = 'array') {
  const definition = STRUCTURE_KINDS.find(item => item.id === kind);
  if (!definition) throw new Error('Choose a supported data structure.');
  return { name: definition.label, description: '', structureKind: kind, implementation: '', entries: [], columns: 4, links: [], pointers: [], activeEntryId: '' };
}

export function structureHasNested(data) {
  return Array.isArray(data?.entries) && data.entries.some(entry => entry?.keyContainer || entry?.valueContainer);
}

export function countStructureEntries(data) {
  let count = 0;
  const visiting = new Set();
  const visit = (container, depth) => {
    if (!object(container) || depth > MAX_STRUCTURE_DEPTH || visiting.has(container)) throw new Error('Nested containers support at most 8 levels and cannot contain cycles.');
    visiting.add(container);
    for (const entry of Array.isArray(container.entries) ? container.entries : []) {
      if (!object(entry)) continue;
      if (++count > MAX_STRUCTURE_ENTRIES) throw new Error('A container and all of its nested containers support at most 128 units in total.');
      if (entry.keyContainer) visit(entry.keyContainer, depth + 1);
      if (entry.valueContainer) visit(entry.valueContainer, depth + 1);
    }
    visiting.delete(container);
  };
  visit(data, 1); return count;
}

export function cleanStructureData(input, state = null, depth = 1) {
  input = object(input) ? input : {};
  state ||= { count: 0, seen: new Set(), visiting: new Set() };
  if (depth > MAX_STRUCTURE_DEPTH || state.visiting.has(input)) throw new Error('Nested containers support at most 8 levels and cannot contain cycles.');
  state.visiting.add(input);
  const kind = kinds.has(input.structureKind) ? input.structureKind : 'object';
  const data = createStructureData(kind);
  data.name = text(input.name, 240) || data.name;
  data.description = text(input.description, 4000);
  data.implementation = text(input.implementation, 120);
  if (typeof input.typeSignature === 'string' && input.typeSignature.trim()) data.typeSignature = text(input.typeSignature, 2000);
  data.columns = Number.isFinite(input.columns) ? Math.max(1, Math.min(16, Math.floor(input.columns))) : 4;
  const seen = state.seen, localIds = new Map();
  const freshId = value => {
    let id = text(value, 160);
    if (!id || seen.has(id)) id = uid();
    seen.add(id); return id;
  };
  const entries = Array.isArray(input.entries) ? input.entries : [];
  if ((depth > 1 || structureHasNested(input)) && entries.length > MAX_STRUCTURE_ENTRIES) throw new Error('A container and all of its nested containers support at most 128 units in total.');
  data.entries = entries.slice(0, MAX_STRUCTURE_ENTRIES).filter(object).map(entry => {
    if (++state.count > MAX_STRUCTURE_ENTRIES) throw new Error('A container and all of its nested containers support at most 128 units in total.');
    const id = freshId(entry.id);
    if (typeof entry.id === 'string' && !localIds.has(entry.id)) localIds.set(entry.id, id);
    const row = { id, key: text(entry.key, 500), value: text(entry.value, 2000), annotation: text(entry.annotation, 500) };
    for (const side of ['key', 'value']) if (row[side] && object(entry[`${side}Container`])) throw new Error(`A ${side} cannot contain both scalar text and a nested container. Clear one explicitly so no saved data is hidden.`);
    if (object(entry.keyContainer)) row.keyContainer = cleanStructureData(entry.keyContainer, state, depth + 1);
    if (object(entry.valueContainer)) row.valueContainer = cleanStructureData(entry.valueContainer, state, depth + 1);
    return row;
  });
  const entryIds = new Set(data.entries.map(entry => entry.id));
  data.links = (Array.isArray(input.links) ? input.links : []).slice(0, MAX_STRUCTURE_LINKS).filter(link => object(link) && entryIds.has(localIds.get(link.source)) && entryIds.has(localIds.get(link.target))).map(link => ({
    id: freshId(link.id), source: localIds.get(link.source), target: localIds.get(link.target), label: text(link.label, 240),
  }));
  data.pointers = (Array.isArray(input.pointers) ? input.pointers : []).slice(0, MAX_STRUCTURE_POINTERS).filter(pointer => object(pointer) && entryIds.has(localIds.get(pointer.target))).map(pointer => ({
    id: freshId(pointer.id), label: text(pointer.label, 120), target: localIds.get(pointer.target),
  }));
  data.activeEntryId = localIds.get(input.activeEntryId) || '';
  state.visiting.delete(input);
  return data;
}

export function duplicateStructureData(input) {
  const data = cleanStructureData(input);
  return duplicateCleanStructure(data);
}

function duplicateCleanStructure(data) {
  const ids = new Map(data.entries.map(entry => [entry.id, uid()]));
  return { ...data,
    entries: data.entries.map(entry => ({ ...entry, id: ids.get(entry.id), ...(entry.keyContainer ? { keyContainer: duplicateCleanStructure(entry.keyContainer) } : {}), ...(entry.valueContainer ? { valueContainer: duplicateCleanStructure(entry.valueContainer) } : {}) })),
    links: data.links.map(link => ({ ...link, id: uid(), source: ids.get(link.source), target: ids.get(link.target) })),
    pointers: data.pointers.map(pointer => ({ ...pointer, id: uid(), target: ids.get(pointer.target) })),
    activeEntryId: ids.get(data.activeEntryId) || '',
  };
}
