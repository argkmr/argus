import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeSequence, cleanSequenceData, getSequenceEndpointOffset, getSequenceGeometry, getSequenceLabelLayout } from '../frontend/features/diagrams/diagram-sequence.mjs';
import { cleanStructured, duplicateSelection, emptySnapshot, exportBoard, parseBoardImport, templateSnapshot } from '../frontend/features/diagrams/diagram-model.mjs';
import { getExpandedRoutes } from '../frontend/features/diagrams/diagram-expanded-routing.mjs';

const participant = (id, x = 0, y = 0, data = {}) => ({ id, type: 'participant', position: { x, y }, data: { name: id, role: 'Service', lifelineHeight: 560, ...data } });
const message = (id, source, target, row = 0, data = {}) => ({ id, source, target, sourceHandle: `r-${row}`, targetHandle: `l-${row}`, data: { label: id, relation: 'message', ...data } });
const graph = (nodes, edges = []) => ({ nodes, edges, viewport: { x: 10, y: 20, zoom: .8 } });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test('legacy participants retain row coordinates and have no fabricated activations', () => {
  assert.deepEqual(cleanSequenceData({ role: 'Actor' }), {});
  const geometry = getSequenceGeometry({ lifelineHeight: 560 });
  assert.equal(geometry.headerHeight, 74);
  assert.equal(geometry.rowGap, 28);
  assert.equal(geometry.rowCount, 16);
  assert.equal(geometry.height, 634);
  assert.equal(getSequenceGeometry({}, 550).height, 550);
  assert.deepEqual(geometry.activations, []);
  assert.deepEqual(geometry.rows[2], { index: 2, y: 156, leftHandle: 'l-2', rightHandle: 'r-2' });
  assert.deepEqual(getSequenceEndpointOffset({}, 'r-2'), { xOffset: 4, y: 156, direction: 'right' });
  assert.deepEqual(getSequenceEndpointOffset({}, 'l-15'), { xOffset: -4, y: 520, direction: 'left' });
  for (const handle of ['right', 'l--1', 'l-64', 'r-99999999', '', null]) assert.equal(getSequenceEndpointOffset({}, handle), null);
});

test('optional sequence fields are bounded and activation input is copied safely', () => {
  const data = freeze({ sequence: { rowGap: 500, rowCount: 1000, execute: '<script>' }, activations: [
    { id: 'same', startRow: 1, endRow: 3, depth: 100, execute: '<script>' },
    { id: 'same', startRow: 4, endRow: 4, depth: -1 },
    { id: 'backward', startRow: 5, endRow: 2 },
    { id: 'negative', startRow: -1, endRow: 4 },
    { id: 'oversized', startRow: 0, endRow: 64 },
    { id: 'fractional', startRow: .5, endRow: 2 },
    { id: 'nan', startRow: NaN, endRow: 2 },
  ] });
  const clean = cleanSequenceData(data);
  assert.deepEqual(clean.sequence, { rowGap: 120, rowCount: 64 });
  assert.equal(clean.activations.length, 2);
  assert.equal(new Set(clean.activations.map(item => item.id)).size, 2);
  assert.deepEqual(clean.activations.map(({ startRow, endRow, depth }) => ({ startRow, endRow, depth })), [
    { startRow: 1, endRow: 3, depth: 8 }, { startRow: 4, endRow: 4, depth: 0 },
  ]);
  assert.ok(clean.activations.every(item => !Object.hasOwn(item, 'execute')));
  assert.deepEqual(cleanSequenceData({ sequence: { rowGap: -1, rowCount: -1 } }), { sequence: { rowGap: 28, rowCount: 2 } });
  assert.deepEqual(cleanSequenceData(null), {});
  assert.deepEqual(cleanSequenceData({ sequence: [], activations: 'invalid' }), {});
  assert.equal(cleanSequenceData({ activations: Array.from({ length: 200 }, () => ({ startRow: 0, endRow: 1 })) }).activations.length, 128);
});

test('explicit activations and their ports share exact row and depth geometry', () => {
  const data = { sequence: { rowGap: 60, rowCount: 5 }, activations: [
    { id: 'outer', startRow: 0, endRow: 4, depth: 0 },
    { id: 'inner', startRow: 1, endRow: 3, depth: 1 },
    { id: 'instant', startRow: 6, endRow: 6, depth: 0 },
  ] };
  const geometry = getSequenceGeometry(data, 100);
  assert.equal(geometry.rowCount, 7, 'authored intervals are not clipped by a shorter row setting');
  assert.deepEqual(geometry.activations[0], { id: 'outer', startRow: 0, endRow: 4, depth: 0, xOffset: 0, y: 134, width: 12, height: 240 });
  assert.equal(geometry.activations[1].xOffset, 6);
  assert.equal(geometry.activations[2].height, 16);
  assert.equal(geometry.height, 534);
  assert.deepEqual(getSequenceEndpointOffset(data, 'l-0'), { xOffset: -6, y: 134, direction: 'left' });
  assert.deepEqual(getSequenceEndpointOffset(data, 'r-2'), { xOffset: 12, y: 254, direction: 'right' });
  assert.deepEqual(getSequenceEndpointOffset(data, 'l-2'), { xOffset: 0, y: 254, direction: 'left' });
  assert.deepEqual(getSequenceEndpointOffset(data, 'r-5'), { xOffset: 4, y: 434, direction: 'right' });
  const tall = getSequenceGeometry({ sequence: { rowGap: 120, rowCount: 64 } }, 550);
  assert.equal(tall.rows.at(-1).y, 7754);
  assert.equal(tall.height, 7794);
  assert.equal(getSequenceGeometry({ sequence: { rowGap: 56, rowCount: 2 } }).height, 226);
});

test('label layout preserves all text, Unicode and explicit line breaks without ellipsis', () => {
  for (const label of ['A '.repeat(250), '界'.repeat(500), 'verylongtoken'.repeat(30), 'line one\n\nline three', '<script> & "quoted"']) {
    const layout = getSequenceLabelLayout(label, 220);
    assert.equal(layout.fontSize, 13);
    assert.equal(layout.lineHeight, 18);
    assert.equal(layout.height, layout.lines.length * 18 + 8);
    assert.equal(layout.lines.join(''), label.replace(/\n/g, ''));
    assert.ok(!layout.lines.join('').includes('…'));
    assert.ok(layout.width <= 188);
  }
  assert.deepEqual(getSequenceLabelLayout('', 300).lines, []);
  assert.equal(getSequenceLabelLayout('', 300).height, 0);
  assert.deepEqual(getSequenceLabelLayout('first\n\nlast', 300).lines, ['first', '', 'last']);
  assert.equal(getSequenceLabelLayout('x'.repeat(600), 300).lines.join('').length, 500);
  assert.equal(getSequenceLabelLayout('Self call', 0, { self: true }).width, 140);
});

test('arrange preserves content and row identity, aligns tops and makes room for wrapped labels', () => {
  const original = freeze(graph([
    participant('b', 90, 80), participant('a', 0, 40), participant('c', 180, 120),
  ], [message('query', 'a', 'b', 0, { label: '界'.repeat(130) }), message('reply', 'b', 'a', 3, { relation: 'return' }),
    { ...message('work', 'b', 'c', 4), targetHandle: 'l-5' }]));
  const arranged = arrangeSequence(original), byId = new Map(arranged.nodes.map(node => [node.id, node]));
  assert.notEqual(arranged, original);
  assert.equal(arranged.edges, original.edges);
  assert.equal(arranged.viewport, original.viewport);
  assert.deepEqual(arranged.nodes.map(node => node.id), ['b', 'a', 'c']);
  assert.ok(arranged.nodes.every(node => node.position.y === 40 && node.data.sequence.rowCount === 7));
  assert.ok(byId.get('a').position.x < byId.get('b').position.x && byId.get('b').position.x < byId.get('c').position.x);
  assert.ok(arranged.nodes.every(node => !Object.hasOwn(node.data, 'activations')));
  const span = byId.get('b').position.x - byId.get('a').position.x;
  assert.ok(span <= 560, 'long labels do not force an excessively wide adjacent timeline');
  assert.ok(arranged.nodes[0].data.sequence.rowGap >= getSequenceLabelLayout(original.edges[0].data.label, span).height + 18);
  assert.deepEqual(arrangeSequence(arranged), arranged, 'arrangement is deterministic and idempotent');
});

test('arrange includes authored activation extents but never adds activation semantics', () => {
  const original = graph([participant('a', 0, 0), participant('b', 300, 0, { activations: [{ id: 'long', startRow: 0, endRow: 12, depth: 0 }] })], [message('request', 'a', 'b', 1)]);
  const arranged = arrangeSequence(original);
  assert.equal(arranged.nodes[0].data.sequence.rowCount, 14);
  assert.deepEqual(arranged.nodes[1].data.activations, original.nodes[1].data.activations);
  assert.equal(arranged.nodes[0].data.activations, undefined);
  const last = arrangeSequence(graph([participant('a'), participant('b', 300)], [message('last', 'a', 'b', 63)]));
  assert.equal(last.nodes[0].data.sequence.rowCount, 64);
  assert.ok(getSequenceGeometry(last.nodes[0].data, last.nodes[0].height).height > getSequenceEndpointOffset(last.nodes[0].data, 'r-63').y);
});

test('arrange reserves caption clearance using activation boundaries, not lifeline centers', () => {
  const original=graph([
    participant('a',0,0,{activations:[{id:'deep',startRow:0,endRow:3,depth:8}]}),
    participant('b',300,0,{activations:[{id:'outer',startRow:0,endRow:3,depth:0}]}),
  ],[message('call','a','b',1,{label:'W'.repeat(79)})]);
  const arranged=arrangeSequence(original);
  assert.notEqual(arranged,original);
  const [a,b]=arranged.nodes;
  const start=a.position.x+a.style.width/2+getSequenceEndpointOffset(a.data,'r-1').xOffset;
  const end=b.position.x+b.style.width/2+getSequenceEndpointOffset(b.data,'l-1').xOffset;
  assert.ok(a.data.sequence.rowGap>=getSequenceLabelLayout('W'.repeat(79),end-start).height+18);
  const first=getSequenceGeometry(a.data).firstRow;
  assert.ok(first-getSequenceLabelLayout('W'.repeat(79),end-start).height-8>74,'caption clears header too');
});

test('unsafe or mixed diagrams are returned unchanged instead of partially rearranged', () => {
  const original = graph([participant('a'), participant('b', 300)], [message('message', 'a', 'b')]);
  const examples = [
    { ...original, nodes: [...original.nodes, { ...participant('note'), type: 'note' }] },
    { ...original, nodes: [original.nodes[0], { ...original.nodes[1], parentId: 'group' }] },
    { ...original, nodes: [original.nodes[0], { ...original.nodes[1], position: { x: Infinity, y: 0 } }] },
    { ...original, edges: [{ ...original.edges[0], target: 'missing' }] },
    { ...original, edges: [{ ...original.edges[0], targetHandle: 'left' }] },
    { ...original, edges: [{ ...original.edges[0], sourceHandle: 'r-64' }] },
    { ...original, edges: [message('class relation', 'a', 'b', 0, { relation: 'association' })] },
    { ...original, edges: [message('tall', 'a', 'b', 0, { label: 'line\n'.repeat(30) })] },
    { ...original, edges: [message('long', 'a', 'b', 0, { label: '界'.repeat(500) })] },
    { ...original, edges: [message('self', 'a', 'a', 0, { label: 'long self-call '.repeat(20), curvature: .3 })] },
    graph([participant('invalid', 0, 0, { activations: [{ startRow: 4, endRow: 2 }] })]),
    null,
  ];
  for (const input of examples) assert.equal(arrangeSequence(freeze(input)), input);
});

test('sequence metadata survives board round trips and duplication remains independent', () => {
  const source = participant('a', 0, 0, { sequence: { rowGap: 120, rowCount: 64 }, activations: [{ id: 'execution', startRow: 0, endRow: 63, depth: 0 }] });
  source.style = { width: 200, height: 550 };
  const cleaned = cleanStructured(graph([source]));
  assert.equal(cleaned.nodes[0].style.height, 7794);
  const snapshot = emptySnapshot(); snapshot.structured = cleaned;
  assert.deepEqual(parseBoardImport(exportBoard({ name: 'Sequence', snapshot })).snapshot.structured, cleaned);
  const copied = duplicateSelection([{ ...cleaned.nodes[0], selected: true }], []).nodes[0];
  assert.notEqual(copied.data.activations[0].id, cleaned.nodes[0].data.activations[0].id);
  assert.equal(copied.data.activations[0].endRow, 63);
  copied.data.activations[0].endRow = 2;
  assert.equal(cleaned.nodes[0].data.activations[0].endRow, 63);
  const legacy = cleanStructured(graph([participant('legacy')]));
  assert.ok(!Object.hasOwn(legacy.nodes[0].data, 'sequence'));
  assert.ok(!Object.hasOwn(legacy.nodes[0].data, 'activations'));
});

test('new sequence templates contain deliberate example executions and spaced rows', () => {
  const first = templateSnapshot('sequence').structured, second = templateSnapshot('sequence').structured;
  assert.ok(first.nodes.every(node => node.data.sequence.rowGap >= 56 && node.data.sequence.rowCount === 8));
  assert.equal(first.nodes[0].data.activations, undefined);
  assert.deepEqual(first.nodes[1].data.activations.map(({ startRow, endRow }) => [startRow, endRow]), [[0, 6]]);
  assert.deepEqual(first.nodes[2].data.activations.map(({ startRow, endRow }) => [startRow, endRow]), [[2, 4]]);
  assert.notEqual(first.nodes[1].data.activations[0].id, second.nodes[1].data.activations[0].id);
  assert.equal(cleanStructured(first).edges.length, 4);
});

test('expanded routes use shared configured rows and explicit activation port boundaries', () => {
  const data = { sequence: { rowGap: 60, rowCount: 8 }, activations: [{ id: 'active', startRow: 1, endRow: 4, depth: 0 }] };
  const nodes = [participant('a', 0, 0, data), participant('b', 500, 0, data)];
  nodes.forEach(node => { node.style = { width: 200, height: 700 }; });
  const routes = getExpandedRoutes(graph(nodes, [message('call', 'a', 'b', 2)]));
  assert.deepEqual(routes.call.points[0], { x: 106, y: 254 });
  assert.deepEqual(routes.call.points.at(-1), { x: 594, y: 254 });
});
