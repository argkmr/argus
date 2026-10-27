// Shared sequence geometry for the interactive canvas and portable exporters.
// Row identities are document data: presentation never infers execution spans.
const HEADER_HEIGHT = 74, FIRST_ROW = 100, LEGACY_GAP = 28, LEGACY_ROWS = 16;
const MAX_ROWS = 64, MAX_GAP = 120, MAX_DEPTH = 8, MAX_ACTIVATIONS = 128;
const SEQUENCE_RELATIONS = new Set(['message', 'return', 'async']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const bounded = (value, minimum, maximum, fallback) => Math.max(minimum, Math.min(maximum, Math.floor(finite(value, fallback))));
const handleRow = handle => {
  const match = /^([lr])-(\d{1,2})$/.exec(typeof handle === 'string' ? handle : '');
  if (!match || Number(match[2]) >= MAX_ROWS) return null;
  return { index: Number(match[2]), direction: match[1] === 'l' ? 'left' : 'right' };
};

/** Keep optional fields optional so legacy documents need no migration. */
export function cleanSequenceData(data = {}) {
  const input = object(data) ? data : {}, result = {};
  if (object(input.sequence)) result.sequence = {
    rowGap: bounded(input.sequence.rowGap, LEGACY_GAP, MAX_GAP, LEGACY_GAP),
    rowCount: bounded(input.sequence.rowCount, 2, MAX_ROWS, LEGACY_ROWS),
  };
  if (Array.isArray(input.activations)) {
    const ids = new Set();
    result.activations = input.activations.slice(0, MAX_ACTIVATIONS).flatMap((activation, index) => {
      // Invalid/reversed ranges are not converted into a different execution.
      if (!object(activation) || !Number.isInteger(activation.startRow) || !Number.isInteger(activation.endRow)
        || activation.startRow < 0 || activation.endRow < activation.startRow || activation.endRow >= MAX_ROWS) return [];
      const originalId = typeof activation.id === 'string' ? activation.id.slice(0, 160) : '';
      let id = originalId || `activation-${index + 1}`;
      let suffix = 0;
      while (ids.has(id)) id = `activation-${index + 1}-${++suffix}`;
      ids.add(id);
      return [{ id, startRow: activation.startRow, endRow: activation.endRow, depth: bounded(activation.depth, 0, MAX_DEPTH, 0) }];
    });
  }
  return result;
}

export function getSequenceGeometry(data = {}, height) {
  const clean = cleanSequenceData(data), rowGap = clean.sequence?.rowGap ?? LEGACY_GAP;
  const authored = clean.activations || [];
  const firstRow = clean.sequence ? HEADER_HEIGHT + rowGap : FIRST_ROW;
  const rowCount = Math.max(clean.sequence?.rowCount ?? LEGACY_ROWS, ...authored.map(item => item.endRow + 1));
  const rows = Array.from({ length: rowCount }, (_, index) => ({ index, y: firstRow + index * rowGap, leftHandle: `l-${index}`, rightHandle: `r-${index}` }));
  const activations = authored.map(item => ({ ...item, xOffset: item.depth * 6, y: firstRow + item.startRow * rowGap, width: 12, height: Math.max(16, (item.endRow - item.startRow) * rowGap) }));
  const minimumHeight = clean.sequence ? rows.at(-1).y + 40 : 550;
  const requestedHeight = Number.isFinite(height) && height > 0 ? height : clean.sequence ? minimumHeight : finite(data?.lifelineHeight, 500) + HEADER_HEIGHT;
  return {
    headerHeight: HEADER_HEIGHT, firstRow, rowGap, rowCount, rows,
    height: Math.max(minimumHeight, Math.min(10000, requestedHeight), rows.at(-1).y + 30, ...activations.map(item => item.y + item.height + 20)),
    activations,
  };
}

export function getSequenceEndpointOffset(data, handle) {
  const parsed = handleRow(handle);
  if (!parsed) return null;
  const geometry = getSequenceGeometry(data), y = geometry.firstRow + parsed.index * geometry.rowGap;
  const active = geometry.activations.filter(item => parsed.index >= item.startRow && parsed.index <= item.endRow)
    .sort((left, right) => right.depth - left.depth)[0];
  return { xOffset: active ? active.xOffset + (parsed.direction === 'left' ? -6 : 6) : parsed.direction === 'left' ? -4 : 4, y, direction: parsed.direction };
}

const characterWidth = character => /\p{Mark}|\u200d|\ufe0f/u.test(character) ? 0
  : character === '\t' ? 26 : character.codePointAt(0) > 0x2ff ? 13
    : /[MW@#%]/.test(character) ? 11.5 : /[ilI.,' :;!|]/.test(character) ? 4 : 7.3;
const textWidth = text => Array.from(text).reduce((width, character) => width + characterWidth(character), 0);
const labelText = label => typeof label === 'string' ? label.slice(0, 500).replace(/\r\n?/g, '\n') : '';

/** Return real text, preserving explicit line breaks and never ellipsizing. */
export function getSequenceLabelLayout(label, span, { self = false } = {}) {
  const text = labelText(label), available = Math.max(self ? 140 : 80, Math.abs(finite(span, self ? 180 : 320)) - 32);
  const width = Math.ceil(Math.min(available, Math.max(self ? 140 : 80, ...text.split('\n').map(line => textWidth(line) + 16))));
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let current = [], currentWidth = 0;
    for (const character of paragraph) {
      const advance = characterWidth(character);
      while (current.length && currentWidth + advance > width - 16) {
        let split = current.length;
        for (let index = current.length - 1; index > 0; index--) if (/\s/u.test(current[index])) { split = index + 1; break; }
        lines.push(current.slice(0, split).join(''));
        current = current.slice(split); currentWidth = textWidth(current.join(''));
      }
      current.push(character); currentWidth += advance;
    }
    lines.push(current.join(''));
  }
  return { lines: text ? lines : [], width, height: text ? lines.length * 18 + 8 : 0, fontSize: 13, lineHeight: 18 };
}

function nodeWidth(node) {
  for (const width of [node.measured?.width, node.width, node.style?.width]) if (Number.isFinite(width) && width >= 160 && width <= 1600) return width;
  return 180;
}

/** An explicit layout action. Mixed/invalid diagrams remain exactly untouched. */
export function arrangeSequence(graph) {
  if (!object(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || !graph.nodes.length || graph.nodes.length > 2000 || graph.edges.length > 5000) return graph;
  if (graph.nodes.some(node => !object(node) || node.type !== 'participant' || !node.id || node.parentId || node.hidden
    || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)
    || Math.abs(node.position.x) > 1000000 || Math.abs(node.position.y) > 1000000)) return graph;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length) return graph;
  const messages = [];
  let highestRow = 0;
  for (const edge of graph.edges) {
    const source = nodes.get(edge?.source), target = nodes.get(edge?.target);
    const from = handleRow(edge?.sourceHandle), to = handleRow(edge?.targetHandle);
    if (!source || !target || !from || !to || edge.hidden || !SEQUENCE_RELATIONS.has(edge.data?.relation)) return graph;
    highestRow = Math.max(highestRow, from.index, to.index);
    messages.push({ edge, source, target });
  }
  for (const node of graph.nodes) {
    if (node.data?.activations !== undefined && (!Array.isArray(node.data.activations)
      || cleanSequenceData(node.data).activations.length !== node.data.activations.length)) return graph;
    for (const activation of cleanSequenceData(node.data).activations || []) highestRow = Math.max(highestRow, activation.endRow);
  }
  const ordered = [...graph.nodes].sort((left, right) => left.position.x - right.position.x || String(left.id).localeCompare(String(right.id)));
  const indices = new Map(ordered.map((node, index) => [node.id, index]));
  const widths = ordered.map(nodeWidth);
  const gaps = ordered.slice(1).map((_, index) => Math.max(280, (widths[index] + widths[index + 1]) / 2 + 80));
  // Wide labels get room between lifelines before vertical rows are enlarged.
  for (const { edge, source, target } of messages) {
    const left = Math.min(indices.get(source.id), indices.get(target.id)), right = Math.max(indices.get(source.id), indices.get(target.id));
    if (left === right) continue;
    const preferredSpan = Math.min(560, Math.max(280, ...labelText(edge.data?.label).split('\n').map(line => textWidth(line) + 64)));
    const available = gaps.slice(left, right).reduce((sum, gap) => sum + gap, 0), extra = Math.max(0, preferredSpan - available) / (right - left);
    for (let index = left; index < right; index++) gaps[index] += extra;
  }
  const centers = [ordered[0].position.x + widths[0] / 2];
  for (const gap of gaps) centers.push(centers.at(-1) + gap);
  let rowGap = 56;
  for (const { edge, source, target } of messages) {
    const self = source.id === target.id;
    const fromOffset=getSequenceEndpointOffset(source.data,edge.sourceHandle).xOffset;
    const toOffset=getSequenceEndpointOffset(target.data,edge.targetHandle).xOffset;
    const span = self ? 80 * (1 + Math.max(.05, Math.min(1.2, finite(edge.data?.curvature, .3))))
      : Math.abs(centers[indices.get(source.id)] + fromOffset - centers[indices.get(target.id)] - toOffset);
    rowGap = Math.max(rowGap, getSequenceLabelLayout(edge.data?.label, span, { self }).height + 18);
  }
  // Explicitly tall text cannot be made safe within this model's row-gap bound.
  if (rowGap > MAX_GAP) return graph;
  const rowCount = Math.min(MAX_ROWS, highestRow + 2), top = Math.min(...ordered.map(node => node.position.y));
  const arranged = new Map(ordered.map((node, index) => {
    const data = { ...node.data, sequence: { rowGap: Math.ceil(rowGap), rowCount } };
    const height = getSequenceGeometry(data, 1).height;
    data.lifelineHeight = height - HEADER_HEIGHT;
    const position = { x: Math.round((centers[index] - widths[index] / 2) * 100) / 100, y: top };
    return [node.id, { ...node, data, position, width: widths[index], height,
      ...(node.positionAbsolute ? { positionAbsolute: { ...position } } : {}),
      ...(node.measured ? { measured: { ...node.measured, width: widths[index], height } } : {}),
      style: { ...node.style, width: widths[index], height } }];
  }));
  if ([...arranged.values()].some(node => Math.abs(node.position.x) > 1000000)) return graph;
  return { ...graph, nodes: graph.nodes.map(node => arranged.get(node.id)) };
}
