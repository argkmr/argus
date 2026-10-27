import { getStructureSize } from './diagram-structures.mjs';
import { getDiagramComponent } from './diagram-catalog.mjs';
import { getReplicaLayout } from './diagram-replicas.mjs';

export const GROUP_COLORS = Object.freeze(['#74a7ff', '#71d99c', '#ae9cff', '#f5aa5c', '#ef8fa7', '#58c5d9']);
export const GROUP_PADDING = 24;
export const GROUP_HEADER_HEIGHT = 36;
export const GROUP_Z_INDEX = -1;
const validColor = value => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value);
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export function cleanGroupData(data = {}) {
  return {
    color: validColor(data.color) ? data.color : GROUP_COLORS[0],
    memberIds: [...new Set((Array.isArray(data.memberIds) ? data.memberIds : [])
      .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 160))].slice(0, 2000),
  };
}

/** Drop dangling/self/cyclic memberships without moving or deleting any object. */
export function sanitizeGroupMembership(nodes) {
  const ids = new Set(nodes.map(node => node.id));
  const groups = new Map(nodes.filter(node => node.type === 'group').map(node => [node.id, []]));
  const reaches = (start, target) => {
    const seen = new Set(), pending = [start];
    while (pending.length) {
      const id = pending.pop();
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id); pending.push(...groups.get(id) || []);
    }
    return false;
  };
  return nodes.map(node => {
    if (node.type !== 'group') return node;
    const data = cleanGroupData(node.data);
    data.memberIds = data.memberIds.filter(id => ids.has(id) && id !== node.id && !reaches(id, node.id));
    groups.set(node.id, data.memberIds);
    return { ...node, data: { ...node.data, ...data } };
  });
}

/** All direct and nested members, visited once even in malformed legacy data. */
export function getGroupMemberIds(nodes, groupId) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const group = byId.get(groupId);
  if (group?.type !== 'group') return [];
  const seen = new Set([groupId]), result = [], pending = [];
  const enqueue = ids => { for (const id of ids) if (byId.has(id) && !seen.has(id)) { seen.add(id); pending.push(id); } };
  enqueue(cleanGroupData(group.data).memberIds);
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index], node = byId.get(id);
    result.push(id);
    if (node.type === 'group') enqueue(cleanGroupData(node.data).memberIds);
  }
  return result;
}

function dimension(node, axis, fallback) {
  for (const value of [node.measured?.[axis], node[axis], node.style?.[axis]]) {
    const parsed = typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number.parseFloat(value) : value;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export function getGroupNodeBounds(node) {
  const structure = node.type === 'dataStructure' ? getStructureSize(node.data) : null;
  const fallbackWidth = structure?.width || (node.type === 'umlClass' ? 260 : node.type === 'group' ? 320 : node.type === 'participant' ? 160 : 180);
  const fallbackHeight = structure?.height || (node.type === 'umlClass' ? 146 + 28 * Math.max(1, node.data?.fields?.length || 0) + 28 * Math.max(1, node.data?.methods?.length || 0) : node.type === 'participant' ? Math.max(560, finite(node.data?.lifelineHeight, 560)) + 74 : node.type === 'group' ? 240 : node.type === 'note' ? 114 : 160);
  return { x: finite(node.position?.x), y: finite(node.position?.y), width: dimension(node, 'width', fallbackWidth), height: dimension(node, 'height', fallbackHeight) };
}

/** Conservative 14px/600 system-font advances; long/wrapped labels retain all available width. */
export function getCompactComponentNameWidth(data = {}, nodeWidth = 180) {
  const available = Math.max(1, nodeWidth - 16);
  const name = String(data.name || getDiagramComponent(data.componentKey).label);
  const advance = character => {
    if (/\p{Mark}|\u200d|\ufe0f/u.test(character)) return 0;
    if (character === '\t') return 20;
    if (/\s/u.test(character)) return 5;
    if (/[MW@%&#]/.test(character)) return 14;
    if (/[ilIjtfr.,:;!'`|]/.test(character)) return 5;
    if (/[A-Z0-9]/.test(character)) return 10;
    if (character.codePointAt(0) > 0x2ff) return 18;
    return 9;
  };
  const longest = Math.max(0, ...name.split(/\r\n?|\n/).map(line => [...line].reduce((sum, character) => sum + advance(character), 0)));
  // The buffer includes textarea padding and allows for platform font variance.
  return Math.min(available, Math.max(24, longest + 12));
}

/**
 * Fit the content a person sees, not the transparent architecture hit rectangle.
 * Keep getGroupNodeBounds unchanged for routing/selection geometry. Coordinates
 * mirror compact DiagramNodes/CSS: 64px role, badge ring, ghosts, centered name,
 * notes button and count/hover controls. Popover notes are intentionally excluded.
 */
export function getGroupFitBounds(node) {
  const full = getGroupNodeBounds(node);
  if (node.type !== 'component' || node.data?.expandedNotes || getDiagramComponent(node.data?.componentKey).visualKind) return full;
  const width = Math.max(180, full.width), height = Math.max(160, full.height);
  const cx = full.x + width / 2, cy = full.y + height / 2;
  const extent = getReplicaLayout(node.data?.replicas).extent;
  const nameWidth = getCompactComponentNameWidth(node.data, width);
  const shapes = [
    { x: cx - 32 - extent, y: cy - 64 - extent, width: 64 + extent, height: 64 + extent },
    { x: cx - nameWidth / 2, y: cy + 8, width: nameWidth, height: 40 },
    { x: cx + 58, y: cy - 58, width: 26, height: 26 },
    { x: cx - 29, y: cy + 50, width: 58, height: 22 },
    // These controls appear on hover/focus; keep them inside without refitting.
    { x: cx + 33, y: cy + 48, width: 52, height: 28 },
  ];
  if (getDiagramComponent(node.data?.componentKey).brand) shapes.push({ x: cx + 9, y: cy - 23, width: 30, height: 30 });
  const x = Math.min(...shapes.map(shape => shape.x)), y = Math.min(...shapes.map(shape => shape.y));
  return { x, y, width: Math.max(...shapes.map(shape => shape.x + shape.width)) - x, height: Math.max(...shapes.map(shape => shape.y + shape.height)) - y };
}

function boundsAround(nodes) {
  const bounds = nodes.map(getGroupFitBounds);
  const x = Math.min(...bounds.map(node => node.x)) - GROUP_PADDING;
  const y = Math.min(...bounds.map(node => node.y)) - GROUP_PADDING - GROUP_HEADER_HEIGHT;
  return { x, y, width: Math.max(180, Math.max(...bounds.map(node => node.x + node.width)) + GROUP_PADDING - x), height: Math.max(114, Math.max(...bounds.map(node => node.y + node.height)) + GROUP_PADDING - y) };
}

/** Absolute-position members keep their existing geometry and edges unchanged. */
export function createGroup(graph, selectedIds, options = {}) {
  const selected = new Set(selectedIds || []);
  // Selecting both a group and one of its children keeps that child's owner.
  const descendants = new Set(graph.nodes.filter(node => selected.has(node.id) && node.type === 'group').flatMap(node => getGroupMemberIds(graph.nodes, node.id)));
  const members = graph.nodes.filter(node => selected.has(node.id) && !descendants.has(node.id));
  if (!members.length || graph.nodes.length >= 2000) return graph;
  const memberIds = new Set(members.map(node => node.id));
  const bounds = boundsAround(members);
  const id = typeof options.id === 'string' && options.id && options.id.length <= 160 && !graph.nodes.some(node => node.id === options.id) ? options.id : globalThis.crypto.randomUUID();
  const group = {
    id, type: 'group', selected: true,
    position: { x: bounds.x, y: bounds.y }, style: { width: bounds.width, height: bounds.height },
    data: { name: typeof options.name === 'string' && options.name.trim() ? options.name.slice(0, 240) : 'Group', description: '', ...cleanGroupData({ color: options.color, memberIds: members.map(node => node.id) }) },
  };
  return { ...graph, nodes: [group, ...graph.nodes.map(node => ({ ...node, selected: false,
    ...(node.type === 'group' ? { data: { ...node.data, memberIds: cleanGroupData(node.data).memberIds.filter(id => !memberIds.has(id)) } } : {}),
  }))] };
}

export function fitGroup(graph, id) {
  const group = graph.nodes.find(node => node.id === id && node.type === 'group');
  if (!group) return graph;
  const memberIds = new Set(getGroupMemberIds(graph.nodes, id));
  const members = graph.nodes.filter(node => memberIds.has(node.id));
  if (!members.length) return graph;
  const bounds = boundsAround(members);
  return { ...graph, nodes: graph.nodes.map(node => node.id !== id ? node : {
    ...node, position: { x: bounds.x, y: bounds.y }, width: bounds.width, height: bounds.height,
    measured: { ...node.measured, width: bounds.width, height: bounds.height },
    style: { ...node.style, width: bounds.width, height: bounds.height },
  }) };
}

/** Only removes the background. Nested parents inherit its direct members. */
export function ungroup(graph, id) {
  const group = graph.nodes.find(node => node.id === id && node.type === 'group');
  if (!group) return graph;
  const nodes = graph.nodes.filter(node => node.id !== id).map(node => node.type !== 'group' ? node : {
    ...node, data: { ...node.data, memberIds: cleanGroupData(node.data).memberIds.flatMap(member => member === id ? cleanGroupData(group.data).memberIds : [member]) },
  });
  return { ...graph, nodes: sanitizeGroupMembership(nodes), edges: graph.edges.filter(edge => edge.source !== id && edge.target !== id) };
}

/** Group itself is moved by React Flow; skip members already in that change batch. */
export function moveGroupMembers(graph, id, delta, alreadyMovedIds = []) {
  const dx = finite(delta?.x), dy = finite(delta?.y);
  if (!dx && !dy) return graph;
  const skipped = new Set(alreadyMovedIds), ids = new Set(getGroupMemberIds(graph.nodes, id));
  return { ...graph, nodes: graph.nodes.map(node => !ids.has(node.id) || skipped.has(node.id) ? node : {
    ...node, position: { x: finite(node.position?.x) + dx, y: finite(node.position?.y) + dy },
  }) };
}

/** Apply member translations after React Flow has already applied this batch. */
export function applyGroupMoves(beforeGraph, afterGraph, changes = []) {
  const before = new Map(beforeGraph.nodes.map(node => [node.id, node]));
  const moved = changes.filter(change => change.type === 'position' && change.position);
  const shifted = new Set(moved.map(change => change.id));
  const resizing = new Set(changes.filter(change => change.type === 'dimensions' && change.resizing).map(change => change.id));
  const groups = moved.filter(change => before.get(change.id)?.type === 'group' && !resizing.has(change.id));
  const members = new Map(groups.map(change => [change.id, getGroupMemberIds(beforeGraph.nodes, change.id)]));
  // Nearest explicitly moved ancestor owns a descendant's delta, including
  // zero. This handles alignment (different deltas) and multi-drag (same delta).
  groups.sort((left, right) => members.get(left.id).length - members.get(right.id).length);
  let next = afterGraph;
  for (const change of groups) {
    const original = before.get(change.id);
    next = moveGroupMembers(next, change.id, { x: change.position.x - original.position.x, y: change.position.y - original.position.y }, shifted);
    for (const id of members.get(change.id)) shifted.add(id);
  }
  return next;
}
