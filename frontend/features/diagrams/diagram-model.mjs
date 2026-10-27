// Plain-data board model. No React state, network, or executable imported content.
import { sanitizeSketchSnapshot } from './diagram-sketch-model.mjs';
import { cleanStructureData, createStructureData, duplicateStructureData, getStructureSize } from './diagram-structures.mjs';
import { DIAGRAM_VISUALS } from './diagram-visuals.mjs';
import { cleanGroupData, getGroupMemberIds, sanitizeGroupMembership } from './diagram-groups.mjs';
import { arrangeSequence, cleanSequenceData, getSequenceGeometry } from './diagram-sequence.mjs';
import { cleanConnectionRouting, translateConnectionData } from './diagram-connection-routing.mjs';
export const BOARD_FORMAT = 'argus-diagram';
export const MAX_IMPORT_BYTES = 10_000_000;
export const NODE_TYPES = new Set(['umlClass', 'component', 'participant', 'note', 'dataStructure', 'group']);
export const RELATIONS = [
  ['association', 'Association'], ['dependency', 'Dependency'],
  ['inheritance', 'Inheritance'], ['implementation', 'Implementation'],
  ['aggregation', 'Aggregation'], ['composition', 'Composition'],
  ['message', 'Message'], ['return', 'Return'], ['async', 'Async message'],
];
export const uid = () => globalThis.crypto.randomUUID();
const copy = value => JSON.parse(JSON.stringify(value));
export const emptySnapshot = () => ({
  structured: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  sketch: { elements: [], appState: {}, files: {}, libraryItems: [] },
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, fallback) => Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : fallback;
const txt = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
const members = (rows, seen = new Set()) => {
  return (Array.isArray(rows) ? rows : []).slice(0, 100).map(row => {
    let id = txt(row?.id, 160) || uid();
    if (seen.has(id)) id = uid();
    seen.add(id); return { id, text: txt(row?.text) };
  });
};

export function cleanStructured(value) {
  if (!object(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error('This file has no valid structured canvas.');
  if (value.nodes.length > 2000 || value.edges.length > 5000) throw new Error('A board supports up to 2,000 objects and 5,000 connections.');
  const ids = new Set();
  const nodes = value.nodes.map(node => {
    if (!object(node) || !NODE_TYPES.has(node.type) || !object(node.position)) throw new Error('This file contains an unsupported diagram object.');
    const id = txt(node.id, 160);
    if (!id || ids.has(id)) throw new Error('Diagram object IDs must be unique.');
    ids.add(id);
    const input = object(node.data) ? node.data : {};
    const data = { name: txt(input.name, 240) || 'Untitled', description: txt(input.description, 4000) };
    if (node.type === 'umlClass') { const memberIds = new Set(); Object.assign(data, { stereotype: txt(input.stereotype, 120), fields: members(input.fields, memberIds), methods: members(input.methods, memberIds) }); }
    if (node.type === 'component') { data.componentKey = txt(input.componentKey, 160) || 'service'; data.replicas = Number.isFinite(input.replicas) ? Math.max(1, Math.min(1000, Math.floor(input.replicas))) : 1; }
    if (node.type === 'dataStructure') Object.assign(data, cleanStructureData(input));
    if (node.type === 'group') Object.assign(data, cleanGroupData(input));
    if (node.type === 'participant') Object.assign(data, { role: txt(input.role, 120), lifelineHeight: Math.max(560, Math.min(1800, finite(input.lifelineHeight, 560))) }, cleanSequenceData(input));
    const style = {};
    const width = node.width ?? node.style?.width, height = node.height ?? node.style?.height;
    const structureSize = node.type === 'dataStructure' ? getStructureSize(data) : null;
    if (Number.isFinite(width)) style.width = Math.max(structureSize?.width || (node.type === 'umlClass' ? 260 : 180), Math.min(node.type === 'group' ? 1_000_000 : structureSize ? 2400 : 1600, width));
    const minimumHeight = structureSize?.height || (node.type === 'umlClass' ? 146 + 28 * Math.max(1, data.fields.length) + 28 * Math.max(1, data.methods.length) : node.type === 'participant' ? getSequenceGeometry(data, 1).height : node.type === 'component' ? 160 : 114);
    if (Number.isFinite(height)) style.height = Math.max(minimumHeight, Math.min(node.type === 'group' ? 1_000_000 : 6400, height));
    if (node.type === 'group') { style.width ??= 320; style.height ??= 240; }
    return { id, type: node.type, position: { x: finite(node.position.x, 0), y: finite(node.position.y, 0) }, data, ...(Object.keys(style).length ? { style } : {}) };
  });
  const edgeIds = new Set();
  const edges = value.edges.map(edge => {
    const id = txt(edge?.id, 160);
    if (!id || edgeIds.has(id) || !ids.has(edge.source) || !ids.has(edge.target)) throw new Error('Connections must have unique IDs and valid endpoints.');
    edgeIds.add(id);
    const relation = RELATIONS.some(([key]) => key === edge.data?.relation) ? edge.data.relation : 'association';
    return { id, source: edge.source, target: edge.target, sourceHandle: txt(edge.sourceHandle, 80) || 'right', targetHandle: txt(edge.targetHandle, 80) || 'left', type: 'relation', data: { label: txt(edge.data?.label, 500), relation, curvature: Math.max(.05, Math.min(1.2, finite(edge.data?.curvature, .3))), ...cleanConnectionRouting(edge.data) } };
  });
  return { nodes: sanitizeGroupMembership(nodes), edges, viewport: { x: finite(value.viewport?.x, 0), y: finite(value.viewport?.y, 0), zoom: Math.max(.1, Math.min(3, finite(value.viewport?.zoom, 1))) } };
}

export function parseBoardImport(text) {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('This file is too large. The board import limit is 10 MB.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Choose a valid Argus board or .excalidraw JSON file.'); }
  if (!object(value)) throw new Error('Unsupported board file.');
  if (value.type === 'excalidraw') {
    if (!Array.isArray(value.elements) || value.elements.length > 10000) throw new Error('Invalid or oversized Excalidraw scene.');
    const snapshot = emptySnapshot();
    snapshot.sketch = sanitizeSketchSnapshot({ elements: value.elements, appState: object(value.appState) ? value.appState : {}, files: object(value.files) ? value.files : {}, libraryItems: [] });
    return { name: 'Imported sketch', snapshot, mode: 'sketch' };
  }
  if (value.format !== BOARD_FORMAT || value.schemaVersion !== 1 || !object(value.snapshot)) throw new Error('Unsupported Argus board format or version.');
  const sketch = value.snapshot.sketch;
  if (!object(sketch) || !Array.isArray(sketch.elements) || sketch.elements.length > 10000 || !object(sketch.files) || !object(sketch.appState) || !Array.isArray(sketch.libraryItems)) throw new Error('Invalid sketch data.');
  return { name: txt(value.name, 160) || 'Imported board', snapshot: { structured: cleanStructured(value.snapshot.structured), sketch: sanitizeSketchSnapshot(sketch) }, mode: 'structured' };
}

export function exportBoard(document) {
  const value = { format: BOARD_FORMAT, schemaVersion: 1, name: document.name, snapshot: { structured: cleanStructured(document.snapshot.structured), sketch: document.snapshot.sketch } };
  const formatted = JSON.stringify(value, null, 2);
  // JavaScript array indentation can exceed the backend's pretty-printed size.
  // Keep near-limit saved boards importable without dropping either canvas.
  return new TextEncoder().encode(formatted).length <= MAX_IMPORT_BYTES ? formatted : JSON.stringify(value);
}

export function makeNode(type, position = { x: 100, y: 100 }, componentKey = 'service') {
  const node = { id: uid(), type, position, data: { name: 'Note', description: '' } };
  if (type === 'umlClass') node.data = { name: 'ClassName', stereotype: '', fields: [{ id: uid(), text: '- field: Type' }], methods: [{ id: uid(), text: '+ method(): Result' }] };
  if (type === 'component') {
    const visual = DIAGRAM_VISUALS.find(item => item.id === componentKey);
    node.data = { name: visual?.label || componentKey, description: '', componentKey, replicas: 1 };
    if (visual) node.style = { width: visual.width, height: visual.height };
  }
  if (type === 'dataStructure') node.data = createStructureData(componentKey === 'service' ? 'array' : componentKey);
  if (type === 'participant') node.data = { name: 'Participant', role: 'Service', lifelineHeight: 560 };
  if (type === 'group') { node.data = { name: 'Group', description: '', ...cleanGroupData() }; node.style = { width: 320, height: 240 }; }
  return node;
}

export function duplicateSelection(nodes, edges, offset = 32) {
  const selectedIds = new Set(nodes.filter(node => node.selected).flatMap(node => [node.id, ...getGroupMemberIds(nodes, node.id)]));
  const selected = nodes.filter(node => selectedIds.has(node.id));
  const idMap = new Map(selected.map(node => [node.id, uid()]));
  const copiedNodes = selected.map(node => ({ ...copy(node), id: idMap.get(node.id), selected: true, position: { x: node.position.x + offset, y: node.position.y + offset }, data: node.type === 'dataStructure' ? duplicateStructureData(node.data) : { ...copy(node.data), ...(node.data.fields ? { fields: node.data.fields.map(row => ({ ...row, id: uid() })), methods: node.data.methods.map(row => ({ ...row, id: uid() })) } : {}) } }));
  for (const node of copiedNodes) if (node.type === 'participant' && Array.isArray(node.data.activations)) node.data.activations = node.data.activations.map(activation => ({ ...activation, id: uid() }));
  for (const node of copiedNodes) if (node.type === 'group') node.data.memberIds = cleanGroupData(node.data).memberIds.map(id => idMap.get(id)).filter(Boolean);
  const copiedEdges = edges.filter(edge => idMap.has(edge.source) && idMap.has(edge.target)).map(edge => ({ ...copy(edge), id: uid(), selected: false, source: idMap.get(edge.source), target: idMap.get(edge.target), ...(edge.data?{data:translateConnectionData(copy(edge.data),offset,offset)}:{}) }));
  return { nodes: copiedNodes, edges: copiedEdges };
}

export function createDiagramHistory(initial, { maxEntries = 50, maxCharacters = 12_000_000 } = {}) {
  let past = [], future = [], current = copy(initial), group = '', groupAt = 0;
  const trim = () => {
    let total = 0;
    past = past.slice(-maxEntries).reverse().filter(item => (total += JSON.stringify(item).length) <= maxCharacters).reverse();
  };
  return {
    push(next, key = '') {
      if (JSON.stringify(next) === JSON.stringify(current)) return false;
      const now = Date.now();
      if (!key || key !== group || now - groupAt > 750) past.push(copy(current));
      group = key; groupAt = now; current = copy(next); future = []; trim(); return true;
    },
    undo() { if (!past.length) return null; future.push(current); current = past.pop(); group = ''; return copy(current); },
    redo() { if (!future.length) return null; past.push(current); current = future.pop(); group = ''; trim(); return copy(current); },
    get canUndo() { return past.length > 0; }, get canRedo() { return future.length > 0; },
  };
}

export function templateSnapshot(kind) {
  const snapshot = emptySnapshot();
  const edge = (source, target, label, relation = 'association', row = null) => ({ id: uid(), source: source.id, target: target.id, sourceHandle: row === null ? 'right' : `r-${row}`, targetHandle: row === null ? 'left' : `l-${row}`, type: 'relation', data: { label, relation, curvature: .3 } });
  if (kind === 'sequence') {
    const nodes = ['Client', 'API service', 'Database'].map((name, i) => ({ ...makeNode('participant', { x: 100 + i * 320, y: 60 }), data: { name, role: i === 0 ? 'Actor' : 'Service', lifelineHeight: 560 } }));
    snapshot.structured.nodes = nodes;
    snapshot.structured.edges = [edge(nodes[0], nodes[1], '1. GET /orders', 'message', 0), edge(nodes[1], nodes[2], '2. Find orders', 'message', 2), { ...edge(nodes[2], nodes[1], '3. Order rows', 'return', 4), sourceHandle: 'l-4', targetHandle: 'r-4' }, { ...edge(nodes[1], nodes[0], '4. 200 OK', 'return', 6), sourceHandle: 'l-6', targetHandle: 'r-6' }];
    // These example executions are authored with the template, never inferred
    // from arbitrary saved messages or retroactively added to existing boards.
    nodes[1].data.activations = [{ id: uid(), startRow: 0, endRow: 6, depth: 0 }];
    nodes[2].data.activations = [{ id: uid(), startRow: 2, endRow: 4, depth: 0 }];
    snapshot.structured = arrangeSequence(snapshot.structured);
  } else if (kind === 'hld') {
    const nodes = [['browser','Web client',80,100], ['service','API service',400,100], ['redis','Cache',760,40], ['mongodb','Document store',760,270], ['kafka-topic','Order events',400,380]].map(([key,name,x,y]) => ({ ...makeNode('component',{x,y},key),data:{name,componentKey:key,description:''} }));
    snapshot.structured.nodes = nodes; snapshot.structured.edges = [edge(nodes[0],nodes[1],'HTTPS'),edge(nodes[1],nodes[2],'Read-through'),edge(nodes[1],nodes[3],'Read / write'),{...edge(nodes[1],nodes[4],'Publish','async'),sourceHandle:'bottom',targetHandle:'top'}];
  } else if (kind === 'dsa') {
    const node = makeNode('dataStructure', { x: 100, y: 100 }, 'array'); node.data.name = 'nums';
    snapshot.structured.nodes = [node];
  } else if (kind === 'class') {
    const order = makeNode('umlClass',{x:100,y:120}); order.data={name:'Order',stereotype:'entity',fields:[{id:uid(),text:'- id: UUID'},{id:uid(),text:'- status: OrderStatus'}],methods:[{id:uid(),text:'+ confirm(): void'},{id:uid(),text:'+ total(): Money'}]};
    const item = makeNode('umlClass',{x:550,y:120}); item.data={name:'OrderItem',stereotype:'value object',fields:[{id:uid(),text:'- quantity: int'},{id:uid(),text:'- unitPrice: Money'}],methods:[{id:uid(),text:'+ subtotal(): Money'}]};
    snapshot.structured.nodes=[order,item];snapshot.structured.edges=[edge(order,item,'1 owns 1..*','composition')];
  }
  return snapshot;
}
