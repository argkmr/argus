// Shared local-space geometry for the editable node and portable SVG export.
// No React/model imports: persistence can use these same minimum dimensions.
const HEADER = 48;
const PAD = 16;
const GRAPH_KINDS = new Set(['tree', 'bst', 'heap', 'trie', 'graph']);
const CHAIN_KINDS = new Set(['linked-list', 'doubly-linked-list', 'circular-list']);
const TABLE_KINDS = new Set(['map', 'object', 'union-find']);

function curve(source, target, self = false) {
  if (self) {
    const x = source.x + source.width, y = source.y + source.height / 2;
    return { path: `M${x - 10},${y - 12} C${x + 24},${y - 32} ${x + 24},${y + 32} ${x - 10},${y + 12}`, labelX: x + 14, labelY: y - 27 };
  }
  const downward = Math.abs(target.y - source.y) > 10;
  const sx = source.x + (downward ? source.width / 2 : source.width);
  const sy = source.y + (downward ? source.height : source.height / 2);
  const tx = target.x + (downward ? target.width / 2 : 0);
  const ty = target.y + (downward ? 0 : target.height / 2);
  const middle = downward ? (sy + ty) / 2 : (sx + tx) / 2;
  return {
    path: downward ? `M${sx},${sy} C${sx},${middle} ${tx},${middle} ${tx},${ty}` : `M${sx},${sy} C${middle},${sy} ${middle},${ty} ${tx},${ty}`,
    labelX: (sx + tx) / 2, labelY: (sy + ty) / 2 - 6,
  };
}

function graphCells(entries, links, kind, header = HEADER) {
  const cells = [];
  if (kind === 'graph') {
    const columns = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(entries.length))));
    entries.forEach((entry, index) => cells.push({ id: entry.id, index, x: PAD + (index % columns) * 108, y: header + 28 + Math.floor(index / columns) * 90, width: 72, height: 44 }));
    return cells;
  }
  const ids = new Set(entries.map(entry => entry.id));
  const incoming = new Set(links.filter(link => link.source !== link.target && ids.has(link.source) && ids.has(link.target)).map(link => link.target));
  const children = new Map();
  for (const link of links) if (ids.has(link.source) && ids.has(link.target) && link.source !== link.target) {
    if (!children.has(link.source)) children.set(link.source, []);
    children.get(link.source).push(link.target);
  }
  const depths = new Map(), queue = entries.filter(entry => !incoming.has(entry.id)).map(entry => [entry.id, 0]);
  if (!queue.length && entries.length) queue.push([entries[0].id, 0]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [id, depth] = queue[cursor];
    if (depths.has(id)) continue;
    depths.set(id, Math.min(10, depth));
    for (const child of children.get(id) || []) if (!depths.has(child)) queue.push([child, depth + 1]);
  }
  const groups = new Map();
  for (const entry of entries) {
    const depth = depths.has(entry.id) ? depths.get(entry.id) : 0;
    if (!groups.has(depth)) groups.set(depth, []);
    groups.get(depth).push(entry);
  }
  let row = 0;
  const maxColumns = Math.max(3, Math.min(8, Math.max(0, ...Array.from(groups.values(), group => group.length))));
  for (const [, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    group.forEach((entry, index) => {
      const onRow = Math.min(8, group.length - Math.floor(index / 8) * 8);
      cells.push({ id: entry.id, index: entries.findIndex(current => current.id === entry.id), x: PAD + (maxColumns - onRow) * 54 + (index % 8) * 108, y: header + 28 + (row + Math.floor(index / 8)) * 80, width: 72, height: 44 });
    });
    row += Math.ceil(group.length / 8);
  }
  return cells;
}

function flatLayout(input = {}, { nested = false } = {}) {
  const HEADER = nested ? 36 : 48;
  const kind = input.structureKind || 'array';
  const entries = Array.isArray(input.entries) ? input.entries.filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string').slice(0, 128) : [];
  const links = Array.isArray(input.links) ? input.links.filter(link => link && typeof link === 'object').slice(0, 256) : [];
  const shape = GRAPH_KINDS.has(kind) ? 'graph' : CHAIN_KINDS.has(kind) ? 'chain' : TABLE_KINDS.has(kind) ? 'table' : kind === 'stack' ? 'stack' : kind === 'queue' || kind === 'deque' ? 'pipe' : kind === 'matrix' ? 'matrix' : kind === 'set' ? 'set' : 'cells';
  const cells = [], edges = [], labels = [], decorations = [];
  if (shape === 'graph') cells.push(...graphCells(entries, links, kind, HEADER));
  else if (shape === 'table') {
    const count = Math.max(1, Math.ceil(entries.length / 24));
    for (let column = 0; column < count; column++) {
      const x = PAD + column * 316;
      labels.push({ text: kind === 'union-find' ? 'Element' : 'Key', x: x + 8, y: HEADER + 17, align: 'start' }, { text: kind === 'union-find' ? 'Parent' : 'Value', x: x + 154, y: HEADER + 17, align: 'start' });
    }
    entries.forEach((entry, index) => cells.push({ id: entry.id, index, x: PAD + Math.floor(index / 24) * 316, y: HEADER + 48 + (index % 24) * 70, width: 300, height: 36 }));
  } else if (shape === 'stack') {
    const perColumn = Math.min(16, Math.max(1, entries.length));
    for (let column = 0; column < Math.max(1, Math.ceil(entries.length / 16)); column++) {
      const count = Math.min(perColumn, entries.length - column * 16);
      const x = PAD + column * 196;
      decorations.push({ type: 'stack', x, y: HEADER + 18, width: 180, height: Math.max(68, count * 76 + 22) });
      labels.push({ text: column === 0 ? 'top' : 'continued', x: x + 5, y: HEADER + 11, align: 'start' });
    }
    entries.forEach((entry, index) => {
      const reverse = entries.length - 1 - index;
      cells.push({ id: entry.id, index, x: PAD + 6 + Math.floor(reverse / 16) * 196, y: HEADER + 39 + (reverse % 16) * 76, width: 168, height: 38 });
    });
  } else {
    const columns = shape === 'matrix' ? Math.max(1, Math.min(16, Math.round(Number(input.columns) || 4))) : shape === 'chain' ? 6 : 8;
    const width = shape === 'chain' ? 86 : 68, strideX = shape === 'chain' ? 118 : 74;
    const strideY = shape === 'chain' ? 88 : 92;
    const startY = HEADER + (shape === 'pipe' ? 48 : 30);
    entries.forEach((entry, index) => {
      const row = Math.floor(index / columns), block = shape === 'matrix' ? Math.floor(row / 16) : 0;
      cells.push({ id: entry.id, index, x: PAD + 6 + index % columns * strideX + block * (columns * strideX + 24), y: startY + (shape === 'matrix' ? row % 16 : row) * strideY, width, height: 42 });
    });
    if (shape === 'pipe') {
      for (let row = 0; row < Math.max(1, Math.ceil(entries.length / columns)); row++) {
        const count = Math.min(columns, Math.max(1, entries.length - row * columns));
        decorations.push({ type: 'pipe', x: PAD - 2, y: startY - 8 + row * strideY, width: Math.max(280, count * strideX + 10), height: 58 });
      }
      labels.push({ text: 'front', x: PAD + 7, y: HEADER + 15, align: 'start' });
      const last = cells.at(-1);
      labels.push({ text: 'rear', x: last ? last.x + last.width : PAD + 263, y: last ? last.y + last.height + 26 : HEADER + 15, align: 'end' });
    }
    if (shape === 'chain') {
      for (let index = 1; index < cells.length; index++) edges.push({ source: cells[index - 1].id, target: cells[index].id, label: '', ...curve(cells[index - 1], cells[index]), double: kind === 'doubly-linked-list' });
      if (kind === 'circular-list' && cells.length) {
        const first = cells[0], last = cells.at(-1), bottom = Math.max(...cells.map(cell => cell.y + cell.height)) + 22;
        edges.push({ source: last.id, target: first.id, label: 'head', path: `M${last.x + last.width / 2},${last.y + last.height} V${bottom} H${PAD - 7} V${first.y + 21} H${first.x}`, labelX: PAD + 18, labelY: bottom - 5 });
      }
    }
  }
  const cellMap = new Map(cells.map(cell => [cell.id, cell]));
  if (shape === 'graph') for (const link of links) {
    const source = cellMap.get(link.source), target = cellMap.get(link.target);
    if (source && target) edges.push({ ...link, ...curve(source, target, source === target) });
  }
  // One label per target keeps coincident pointers legible and inside the node.
  const pointerGroups = new Map();
  for (const pointer of (Array.isArray(input.pointers) ? input.pointers : []).slice(0, 16)) {
    if (!pointer || !cellMap.has(pointer.target)) continue;
    if (!pointerGroups.has(pointer.target)) pointerGroups.set(pointer.target, []);
    pointerGroups.get(pointer.target).push(pointer);
  }
  const pointers = [...pointerGroups].map(([target, group]) => {
    const cell = cellMap.get(target);
    return { id: group.map(pointer => pointer.id).join('-'), target, label: group.map(pointer => String(pointer.label || '')).join(', '), path: `M${cell.x + cell.width / 2},${cell.y - 7} V${cell.y - 1}`, labelX: cell.x + cell.width / 2, labelY: cell.y - 10 };
  });
  let width = Math.max(nested ? 220 : 320, ...cells.map(cell => cell.x + cell.width + PAD + (shape === 'graph' ? 30 : 0)), ...decorations.map(item => item.x + item.width + PAD));
  let height = Math.max(nested ? 116 : 144, ...cells.map(cell => cell.y + cell.height + 34), ...decorations.map(item => item.y + item.height + PAD));
  if (shape === 'table' && (!nested || entries.length)) width = Math.max(width, 332);
  if (shape === 'chain' && kind === 'circular-list') height += 12;
  return { width, height, shape, cells, edges, pointers, labels, decorations, headerHeight: HEADER };
}

// Nested containers retain their own shape, header, units and local coordinate
// system. Only placements are parent-relative: consumers can recursively draw
// the same layout in the editor and SVG without flattening a collection to text.
// These defensive limits also make direct export of unsanitized input bounded.
export function getStructureLayout(input = {}, options = {}) {
  const context = { remaining: 128, ancestors: new Set() };
  return nestedLayout(input, options, context, 0);
}

function nestedLayout(raw, options, context, depth) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const cyclic = context.ancestors.has(input);
  const entries = cyclic || depth >= 8 ? [] : (Array.isArray(input.entries) ? input.entries : []).filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string').slice(0, context.remaining);
  context.remaining -= entries.length;
  const data = { ...input, entries };
  const layout = flatLayout(data, options);
  layout.nested = Boolean(options.nested);
  layout.typeLabel = String(input.typeSignature || input.implementation || '').slice(0, 2000);
  if (cyclic || depth >= 8) { layout.truncated = true; return layout; }
  context.ancestors.add(input);
  const children = new Map();
  for (const entry of entries) {
    const nested = {};
    for (const field of ['keyContainer', 'valueContainer']) if (entry[field] && typeof entry[field] === 'object' && !Array.isArray(entry[field])) {
      const childData = entry[field], childLayout = nestedLayout(childData, { nested: true }, context, depth + 1);
      nested[field] = { data: childData, layout: childLayout, width: childLayout.width, height: childLayout.height };
    }
    if (nested.keyContainer || nested.valueContainer) children.set(entry.id, nested);
  }
  context.ancestors.delete(input);
  if (!children.size) return layout;

  const originalCells = layout.cells;
  const cells = originalCells.map(cell => {
    const child = children.get(cell.id) || {}, entry = entries[cell.index];
    const key = child.keyContainer, value = child.valueContainer;
    const keyWidth = key ? key.width + 16 : 120;
    const valueWidth = value ? value.width + 16 : 150;
    const contentTop = layout.shape === 'graph' && entry.key && !key && value ? 18 : 0;
    return { ...cell, ...child, keyWidth: layout.shape === 'table' ? keyWidth : key ? keyWidth : undefined, contentTop,
      width: layout.shape === 'table' ? keyWidth + valueWidth : key || value ? (key ? key.width + 16 : 0) + (value ? value.width + 16 : key ? 100 : 0) : cell.width,
      height: Math.max(cell.height, Math.max(key?.height || 0, value?.height || 0) + (key || value ? 16 + contentTop : 0)) };
  });
  if (layout.shape === 'table') {
    layout.labels = [];
    let x = PAD;
    for (let column = 0; column < Math.ceil(cells.length / 24); column++) {
      const group = cells.filter(cell => Math.floor(cell.index / 24) === column);
      const keyWidth = Math.max(120, ...group.map(cell => cell.keyWidth));
      const valueWidth = Math.max(150, ...group.map(cell => cell.width - cell.keyWidth));
      layout.labels.push({ text: input.structureKind === 'union-find' ? 'Element' : 'Key', x: x + 8, y: layout.headerHeight + 17, align: 'start' }, { text: input.structureKind === 'union-find' ? 'Parent' : 'Value', x: x + keyWidth + 8, y: layout.headerHeight + 17, align: 'start' });
      let y = layout.headerHeight + 48;
      for (const cell of group) { Object.assign(cell, { x, y, width: keyWidth + valueWidth, keyWidth }); y += cell.height + 34; }
      x += keyWidth + valueWidth + 16;
    }
  } else {
    // Preserve the original topology while enlarging row/column tracks to fit
    // arbitrary child containers, including graph, stack and chain units.
    for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
      const positions = [...new Set(originalCells.map(cell => cell[axis]))].sort((a, b) => a - b);
      let at = positions[0] || PAD;
      for (let index = 0; index < positions.length; index++) {
        const position = positions[index], original = originalCells.filter(cell => cell[axis] === position), group = cells.filter(cell => original.some(prior => prior.id === cell.id));
        for (const cell of group) cell[axis] = at;
        const priorSize = Math.max(...original.map(cell => cell[size]));
        const gap = index + 1 < positions.length ? positions[index + 1] - position - priorSize : 0;
        at += Math.max(...group.map(cell => cell[size])) + Math.max(axis === 'x' ? 16 : 34, gap);
      }
    }
  }
  for (const cell of cells) for (const field of ['keyContainer', 'valueContainer']) {
    const child = cell[field]; if (!child) continue;
    child.x = cell.x + 8 + (field === 'valueContainer' && (layout.shape === 'table' || cell.keyContainer) ? cell.keyWidth : 0);
    child.y = cell.y + 8 + cell.contentTop;
  }
  layout.cells = cells;
  const cellMap = new Map(cells.map(cell => [cell.id, cell]));
  layout.edges = layout.edges.map(edge => {
    const source = cellMap.get(edge.source), target = cellMap.get(edge.target);
    if (input.structureKind === 'circular-list' && edge.label === 'head') {
      const bottom = Math.max(...cells.map(cell => cell.y + cell.height)) + 22;
      return { ...edge, path: `M${source.x + source.width / 2},${source.y + source.height} V${bottom} H${PAD - 7} V${target.y + target.height / 2} H${target.x}`, labelX: PAD + 18, labelY: bottom - 5 };
    }
    return { ...edge, ...curve(source, target, source === target) };
  });
  layout.pointers = layout.pointers.map(pointer => {
    const cell = cellMap.get(pointer.target);
    return { ...pointer, path: `M${cell.x + cell.width / 2},${cell.y - 7} V${cell.y - 1}`, labelX: cell.x + cell.width / 2, labelY: cell.y - 10 };
  });
  layout.decorations = layout.decorations.map(decoration => {
    const members = originalCells.filter(cell => cell.x >= decoration.x && cell.x + cell.width <= decoration.x + decoration.width && cell.y >= decoration.y && cell.y + cell.height <= decoration.y + decoration.height).map(cell => cellMap.get(cell.id));
    if (!members.length) return decoration;
    const left = Math.min(...members.map(cell => cell.x)), top = Math.min(...members.map(cell => cell.y));
    return { ...decoration, x: left - (decoration.type === 'pipe' ? 8 : 6), y: top - (decoration.type === 'pipe' ? 8 : 21), width: Math.max(...members.map(cell => cell.x + cell.width)) - left + (decoration.type === 'pipe' ? 16 : 12), height: Math.max(...members.map(cell => cell.y + cell.height)) - top + (decoration.type === 'pipe' ? 16 : 30) };
  });
  if (layout.shape === 'pipe') {
    const first = cells[0], last = cells.at(-1);
    layout.labels = [{ text: 'front', x: first.x, y: layout.headerHeight + 15, align: 'start' }, { text: 'rear', x: last.x + last.width, y: last.y + last.height + 26, align: 'end' }];
  } else if (layout.shape === 'stack') layout.labels = layout.decorations.map((item, index) => ({ text: index ? 'continued' : 'top', x: item.x + 5, y: item.y - 7, align: 'start' }));
  layout.width = Math.max(options.nested ? 220 : 320, ...cells.map(cell => cell.x + cell.width + PAD + (layout.shape === 'graph' ? 30 : 0)), ...layout.decorations.map(item => item.x + item.width + PAD));
  layout.height = Math.max(options.nested ? 116 : 144, ...cells.map(cell => cell.y + cell.height + 34), ...layout.decorations.map(item => item.y + item.height + PAD)) + (input.structureKind === 'circular-list' ? 12 : 0);
  return layout;
}

export function getStructureSize(data) {
  const { width, height } = getStructureLayout(data);
  return { width, height };
}
