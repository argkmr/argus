import { getDiagramComponent } from './diagram-catalog.mjs';
import { getStructureLayout } from './diagram-structure-layout.mjs';
import { GROUP_PADDING, GROUP_HEADER_HEIGHT } from './diagram-groups.mjs';

/** Shared by the read-only expanded canvas and SVG/PNG export. Never persisted. */
export const EXPANDED_NOTES_LAYOUT = Object.freeze({
  width: 460, minHeight: 160, glyphX: 28, glyphY: 24, glyphSize: 64,
  nameCenterX: 60, nameTop: 104, nameWidth: 112, nameFontSize: 13,
  notesX: 156, notesTop: 24, notesWidth: 280, notesFontSize: 12.5,
  lineHeight: 18, notesColumns: 34, nameColumns: 14, bottomPadding: 24,
  nodeGap: 144, rankTolerance: 160, maxColumns: 3, groupPadding: GROUP_PADDING, groupHeader: GROUP_HEADER_HEIGHT,
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const point = value => ({ x: Math.max(-1e7, Math.min(1e7, finite(value?.x))), y: Math.max(-1e7, Math.min(1e7, finite(value?.y))) });
const columnWidth = character => /\p{Mark}|\u200d|\ufe0f/u.test(character) ? 0 : character === '\t' ? 4 : /[MWwm@%]/.test(character) ? 1.6 : /[A-Z]/.test(character) ? 1.15 : character.codePointAt(0) > 0x2ff ? 2 : 1;

/** Preserve whitespace and explicit blank lines; never ellipsize long notes. */
export function wrapExpandedText(value, { columns = EXPANDED_NOTES_LAYOUT.notesColumns } = {}) {
  const limit = Math.max(2, Math.min(1000, finite(columns, EXPANDED_NOTES_LAYOUT.notesColumns)));
  const lines = [];
  for (const paragraph of String(value ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let current = [], width = 0;
    for (const character of paragraph) {
      const advance = columnWidth(character);
      while (current.length && width + advance > limit) {
        let split = current.length;
        for (let index = current.length - 1; index > 0; index--) {
          if (/\s/u.test(current[index])) { split = index + 1; break; }
        }
        lines.push(current.slice(0, split).join(''));
        current = current.slice(split);
        width = current.reduce((sum, item) => sum + columnWidth(item), 0);
      }
      current.push(character); width += advance;
    }
    lines.push(current.join(''));
  }
  return lines;
}

export function getExpandedNotesLayout(data = {}) {
  const layout = EXPANDED_NOTES_LAYOUT;
  const nameLines = wrapExpandedText(data.name || getDiagramComponent(data.componentKey).label, { columns: layout.nameColumns });
  const notesLines = wrapExpandedText(data.description || '');
  const replicaTop = layout.nameTop + nameLines.length * layout.lineHeight + 8;
  const identityBottom = replicaTop + (finite(data.replicas, 1) > 1 ? layout.lineHeight : 0);
  return {
    ...layout, nameLines, notesLines, replicaTop,
    height: Math.max(layout.minHeight, layout.notesTop + notesLines.length * layout.lineHeight + layout.bottomPadding, identityBottom + layout.bottomPadding),
  };
}

function dimension(node, key, fallback) {
  for (const value of [node.measured?.[key], node[key], node.style?.[key]]) {
    const parsed = typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number.parseFloat(value) : value;
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(1e7, parsed);
  }
  return fallback;
}

function displayNode(node) {
  const data = { ...node.data };
  let width = 180, height = 160;
  if (node.type === 'component' && !getDiagramComponent(data.componentKey).visualKind) {
    const layout = getExpandedNotesLayout(data);
    width = layout.width; height = layout.height; data.expandedNotes = true;
  } else {
    if (node.type === 'dataStructure') {
      const layout = getStructureLayout(data); width = layout.width; height = layout.height;
    } else if (node.type === 'umlClass') {
      width = 260; height = 146 + Math.max(1, data.fields?.length || 0) * 28 + Math.max(1, data.methods?.length || 0) * 28;
    } else if (node.type === 'participant') {
      width = 160; height = Math.max(550, finite(data.lifelineHeight, 500) + 74);
    } else if (node.type === 'note') height = 114;
    width = Math.max(width, dimension(node, 'width', width));
    height = Math.max(height, dimension(node, 'height', height));
  }
  const position = point(node.positionAbsolute || node.position);
  return { ...node, data, position, ...(node.positionAbsolute ? { positionAbsolute: position } : {}), width, height, measured: { ...node.measured, width, height }, style: { ...node.style, width, height } };
}

const compare = (left, right) => left.anchor.y - right.anchor.y || left.anchor.x - right.anchor.x || String(left.id).localeCompare(String(right.id));

function sourceRanks(blocks) {
  const ranks = [];
  for (const block of [...blocks].sort(compare)) {
    let rank = ranks.at(-1);
    if (!rank || block.anchor.y - rank.top > EXPANDED_NOTES_LAYOUT.rankTolerance) {
      rank = { top: block.anchor.y, blocks: [] }; ranks.push(rank);
    }
    rank.blocks.push(block);
  }
  return ranks.map(rank => rank.blocks.sort((a, b) => a.anchor.x - b.anchor.x || compare(a, b)));
}

// Small vertical placement differences should not reverse a left-to-right
// architecture rank. Keep source bands intact, with at most three columns;
// description length only changes row height, never the semantic ordering.
function pack(blocks, maxWidth) {
  let x = 0, y = 0, rowHeight = 0, width = 0, columns = 0;
  const placed = [];
  const nextRow = () => { x = 0; y += rowHeight + EXPANDED_NOTES_LAYOUT.nodeGap; rowHeight = 0; columns = 0; };
  for (const rank of sourceRanks(blocks)) {
    if (columns) nextRow();
    for (const block of rank) {
      if (columns && (columns >= EXPANDED_NOTES_LAYOUT.maxColumns || x + block.width > maxWidth)) nextRow();
      placed.push({ ...block, x, y });
      width = Math.max(width, x + block.width);
      rowHeight = Math.max(rowHeight, block.height);
      x += block.width + EXPANDED_NOTES_LAYOUT.nodeGap; columns++;
    }
  }
  return { blocks: placed, width, height: blocks.length ? y + rowHeight : 0 };
}

/**
 * Pure display projection. Saved positions, sizes, membership and notes remain
 * untouched; switching back to compact view can reuse the original graph.
 * Groups are atomic blocks with absolute-positioned (possibly nested) children.
 */
export function expandedNotesGraph(graph = {}) {
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter(node => node && typeof node.id === 'string').map(displayNode);
  const visible = nodes.filter(node => !node.hidden), byId = new Map(visible.map(node => [node.id, node]));
  const owners = new Map(), members = new Map();
  const groups = visible.filter(node => node.type === 'group').sort((a, b) => compare({ id: a.id, anchor: a.position }, { id: b.id, anchor: b.position }));
  for (const group of groups) {
    const ids = [];
    for (const id of Array.isArray(group.data.memberIds) ? group.data.memberIds : []) {
      let ancestor = group.id, cyclic = false;
      while (ancestor !== undefined) {
        if (ancestor === id) { cyclic = true; break; }
        ancestor = owners.get(ancestor);
      }
      // First owner wins, and an ancestor can never become its descendant.
      if (!cyclic && byId.has(id) && !owners.has(id)) {
        owners.set(id, group.id); ids.push(id);
      }
    }
    members.set(group.id, ids);
  }
  const blockFor = node => {
    const block = { id: node.id, anchor: node.position, width: node.width, height: node.height, children: [] };
    if (node.type !== 'group') return block;
    const packed = pack(members.get(node.id).map(id => blockFor(byId.get(id))), 2 * EXPANDED_NOTES_LAYOUT.width + EXPANDED_NOTES_LAYOUT.nodeGap);
    const padding = EXPANDED_NOTES_LAYOUT.groupPadding, header = EXPANDED_NOTES_LAYOUT.groupHeader;
    block.width = Math.max(320, packed.width + 2 * padding);
    block.height = Math.max(160, packed.height + 2 * padding + header);
    block.children = packed.blocks.map(child => ({ ...child, x: child.x + padding, y: child.y + padding + header }));
    return block;
  };
  const blocks = visible.filter(node => !owners.has(node.id)).map(blockFor);
  // Top-level source ranks are bounded by column count, not an assumed 460px
  // card width. A group's real padding (or a wider visual/DSA node) must not
  // unexpectedly push the final peer into another architectural rank.
  const packed = pack(blocks, Infinity);
  const anchor = visible.length ? { x: Math.min(...visible.map(node => node.position.x)), y: Math.min(...visible.map(node => node.position.y)) } : { x: 0, y: 0 };
  const placements = new Map();
  function place(block, origin) {
    const position = { x: origin.x + block.x, y: origin.y + block.y };
    placements.set(block.id, { position, width: block.width, height: block.height });
    for (const child of block.children) place(child, position);
  }
  for (const block of packed.blocks) place(block, anchor);
  return { ...graph, nodes: nodes.map(node => {
    const placement = placements.get(node.id);
    if (!placement) return node;
    const { position, width, height } = placement;
    return { ...node, ...placement, ...(node.positionAbsolute ? { positionAbsolute: position } : {}), measured: { ...node.measured, width, height }, style: { ...node.style, width, height }, data: node.type === 'group' ? { ...node.data, memberIds: members.get(node.id) } : node.data };
  }), edges: Array.isArray(graph.edges) ? [...graph.edges] : [] };
}
