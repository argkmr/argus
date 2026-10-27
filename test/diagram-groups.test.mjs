import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNodeChanges } from '@xyflow/react';
import { createGroup, fitGroup, ungroup, moveGroupMembers, applyGroupMoves, getGroupMemberIds, getGroupNodeBounds, getGroupFitBounds, getCompactComponentNameWidth, cleanGroupData, sanitizeGroupMembership, GROUP_COLORS } from '../frontend/features/diagrams/diagram-groups.mjs';
import { cleanStructured, makeNode, duplicateSelection, exportBoard, parseBoardImport, emptySnapshot } from '../frontend/features/diagrams/diagram-model.mjs';
import { sanitizeSharedBoard } from '../frontend/features/diagrams/collaboration/board-doc.mjs';

const node = (id, x = 100, y = 100, width = 180, height = 160) => ({ id, type: 'component', position: { x, y }, style: { width, height }, data: { name: id, description: '', componentKey: 'redis', replicas: 1 } });
const graph = (...nodes) => ({ nodes, edges: [], viewport: { x: 5, y: 10, zoom: 1 } });
const group = (id, memberIds) => ({ ...makeNode('group'), id, data: { name: id, description: '', color: '#71d99c', memberIds } });

test('group creation tightly wraps full-size visual objects without changing geometry or edges', () => {
  const initial = graph(node('a', 100, 200, 240, 160), node('b', 320, 150, 200, 180));
  initial.nodes = initial.nodes.map(item => ({ ...item, data: { ...item.data, componentKey: 'shape:rectangle' } }));
  initial.edges = [{ id: 'ab', source: 'a', target: 'b' }];
  const before = structuredClone(initial);
  const result = createGroup(initial, ['a', 'b', 'missing', 'a'], { id: 'group', name: 'Storage', color: '#71d99c' });
  const frame = result.nodes[0];
  assert.equal(frame.id, 'group');
  assert.deepEqual(frame.position, { x: 76, y: 90 });
  assert.deepEqual(frame.style, { width: 468, height: 294 });
  assert.deepEqual(frame.data.memberIds, ['a', 'b']);
  assert.equal(frame.data.name, 'Storage');
  assert.equal(frame.data.color, '#71d99c');
  assert.equal(frame.parentId, undefined);
  assert.equal(frame.zIndex, undefined, 'Stacking is display state, not persisted geometry');
  assert.equal(frame.selected, true);
  assert.deepEqual(result.nodes.slice(1).map(({ position }) => position), initial.nodes.map(({ position }) => position));
  assert.equal(result.edges, initial.edges);
  assert.deepEqual(initial, before);
});

test('one selected node is enough, empty selection is a no-op, group IDs stay unique', () => {
  const initial = graph(node('a'));
  assert.equal(createGroup(initial, []), initial);
  assert.equal(createGroup(initial, ['missing']), initial);
  const result = createGroup(initial, ['a'], { id: 'a' });
  assert.notEqual(result.nodes[0].id, 'a');
  assert.deepEqual(result.nodes[0].style, { width: 180, height: 224 });
  assert.equal(createGroup({ ...initial, nodes: Array.from({ length: 2000 }, (_, i) => node(String(i))) }, ['0']).nodes.length, 2000);
});

test('fit uses measured sizes and makes no change to member positions or notes', () => {
  const a = { ...node('a'), measured: { width: 250, height: 210 } };
  const initial = createGroup(graph(a), ['a'], { id: 'g' });
  const moved = { ...initial, nodes: initial.nodes.map(item => item.id === 'a' ? { ...item, position: { x: 400, y: 300 } } : item) };
  const fitted = fitGroup(moved, 'g');
  assert.deepEqual(fitted.nodes[0].position, { x: 469, y: 281 });
  assert.deepEqual(fitted.nodes[0].style, { width: 180, height: 224 });
  assert.deepEqual(fitted.nodes[1], moved.nodes[1]);
  assert.equal(fitGroup(moved, 'missing'), moved);
  assert.equal(fitGroup(graph(group('empty', [])), 'absent').nodes.length, 1);
});

test('compact architecture frames ignore large invisible wrappers but contain visible controls', () => {
  const redis = { ...node('redis', 100, 200, 500, 400), data: { name: 'Redis', componentKey: 'redis', description: 'Cache notes', replicas: 1 } };
  const before = structuredClone(redis);
  const full = getGroupNodeBounds(redis), painted = getGroupFitBounds(redis);
  assert.deepEqual(full, { x: 100, y: 200, width: 500, height: 400 }, 'Router bounds remain unchanged');
  assert.deepEqual(painted, { x: 318, y: 336, width: 117, height: 140 });
  const frame = createGroup(graph(redis), ['redis'], { id: 'frame' }).nodes[0];
  assert.deepEqual(frame.position, { x: 294, y: 276 });
  assert.deepEqual(frame.style, { width: 180, height: 224 });
  assert.ok(frame.style.width < full.width / 2, 'Short labels no longer reserve a500px transparent input wrapper');
  for (const point of [[318, 336], [382, 400], [389, 407], [434, 368], [321, 472], [435, 476]]) {
    assert.ok(point[0] >= painted.x && point[0] <= painted.x + painted.width);
    assert.ok(point[1] >= painted.y && point[1] <= painted.y + painted.height);
  }
  assert.deepEqual(redis, before, 'Fitting cannot shrink, move or rewrite the component');
});

test('replica ghosts extend painted bounds and long editable names retain available width', () => {
  const worker = { ...node('worker', 100, 200, 500, 400), data: { name: 'Workers', componentKey: 'worker', replicas: 100 } };
  const painted = getGroupFitBounds(worker);
  assert.equal(painted.x, 300, 'Three ghost layers extend18px left of the role');
  assert.equal(painted.y, 318, 'Three ghost layers extend18px above the role');
  assert.equal(painted.height, 158);
  const longName = { ...worker, data: { ...worker.data, name: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW' } };
  const longBounds = getGroupFitBounds(longName);
  assert.equal(getCompactComponentNameWidth(longName.data, 500), 484);
  assert.equal(longBounds.x, 108);
  assert.equal(longBounds.width, 484);
  assert.ok(getCompactComponentNameWidth({ name: '订单处理服务集群', componentKey: 'worker' }, 500) >= 8 * 14, 'Wide-script labels are not estimated as narrow Latin text');
  assert.equal(getCompactComponentNameWidth({ name: 'Short\nMuch longer label', componentKey: 'worker' }, 500), getCompactComponentNameWidth({ name: 'Much longer label', componentKey: 'worker' }, 500));
});

test('expanded components, visual devices and non-component objects keep complete bounds', () => {
  const variants = [
    { ...node('expanded', 10, 20, 460, 750), data: { name: 'Expanded', componentKey: 'redis', expandedNotes: true } },
    { ...node('device', 10, 20, 600, 400), data: { name: 'Browser', componentKey: 'frame:browser' } },
    { ...node('visual', 10, 20, 380, 360), data: { name: 'Cylinder', componentKey: 'shape:cylinder' } },
    { ...makeNode('dataStructure'), style: { width: 800, height: 600 } },
    { ...makeNode('umlClass'), style: { width: 500, height: 400 } },
    { ...makeNode('note'), style: { width: 500, height: 400 } },
  ];
  for (const item of variants) assert.deepEqual(getGroupFitBounds(item), getGroupNodeBounds(item), item.id);
});

test('group dragging moves descendants once and skips members already moved by React Flow', () => {
  const initial = graph(group('outer', ['inner', 'b']), group('inner', ['a']), node('a'), node('b'), node('outside'));
  const result = moveGroupMembers(initial, 'outer', { x: 40, y: -20 }, ['b']);
  assert.deepEqual(result.nodes.find(item => item.id === 'a').position, { x: 140, y: 80 });
  assert.deepEqual(result.nodes.find(item => item.id === 'inner').position, { x: 140, y: 80 });
  assert.deepEqual(result.nodes.find(item => item.id === 'b').position, { x: 100, y: 100 });
  assert.deepEqual(result.nodes.find(item => item.id === 'outer').position, initial.nodes[0].position);
  assert.deepEqual(result.nodes.find(item => item.id === 'outside').position, { x: 100, y: 100 });
  assert.equal(moveGroupMembers(initial, 'outer', { x: NaN, y: Infinity }), initial);
});

test('regrouping reparents members, while a selected nested group keeps its children', () => {
  const initial = graph(group('old', ['a', 'b']), node('a'), node('b'));
  const regrouped = createGroup(initial, ['a'], { id: 'new' });
  assert.deepEqual(regrouped.nodes.find(item => item.id === 'old').data.memberIds, ['b']);
  assert.deepEqual(regrouped.nodes.find(item => item.id === 'new').data.memberIds, ['a']);
  const outer = createGroup(initial, ['old', 'a'], { id: 'outer' });
  assert.deepEqual(outer.nodes[0].data.memberIds, ['old']);
  assert.deepEqual(outer.nodes.find(item => item.id === 'old').data.memberIds, ['a', 'b']);
});

test('ungroup retains children, child edges, absolute geometry and nested ownership', () => {
  const initial = graph(group('outer', ['inner']), group('inner', ['a', 'b']), node('a'), node('b'));
  initial.edges = [{ id: 'ab', source: 'a', target: 'b' }, { id: 'invalid-group-edge', source: 'inner', target: 'b' }];
  const result = ungroup(initial, 'inner');
  assert.deepEqual(result.nodes.map(item => item.id), ['outer', 'a', 'b']);
  assert.deepEqual(result.nodes[0].data.memberIds, ['a', 'b']);
  assert.deepEqual(result.nodes.slice(1), initial.nodes.slice(2));
  assert.deepEqual(result.edges, [initial.edges[0]]);
  assert.equal(ungroup(initial, 'missing'), initial);
});

test('group sanitization rejects unsafe color, invalid IDs and cycles without deleting content', () => {
  const data = cleanGroupData({ color: 'url(javascript:bad)', memberIds: ['a', 'a', null, 12, '', 'z'.repeat(161)] });
  assert.equal(data.color, GROUP_COLORS[0]);
  assert.deepEqual(data.memberIds, ['a']);
  const nodes = [group('one', ['one', 'two', 'a', 'missing']), group('two', ['one', 'a']), node('a')];
  const clean = sanitizeGroupMembership(nodes);
  assert.deepEqual(clean[0].data.memberIds, ['two', 'a']);
  assert.deepEqual(clean[1].data.memberIds, ['a']);
  assert.deepEqual(getGroupMemberIds(clean, 'one').sort(), ['a', 'two']);
  assert.deepEqual(getGroupMemberIds(nodes, 'one').sort(), ['a', 'two'], 'Traversal terminates even before sanitization');
  assert.equal(clean[2], nodes[2]);
});

test('group clone includes descendants and internal edges with remapped independent IDs', () => {
  const nodes = [group('outer', ['inner', 'b']), group('inner', ['a']), node('a'), node('b'), node('outside')];
  nodes[0].selected = true;
  nodes[2].selected = true;
  const edges = [{ id: 'inside', source: 'a', target: 'b' }, { id: 'outside-edge', source: 'b', target: 'outside' }];
  const result = duplicateSelection(nodes, edges, 32);
  assert.equal(result.nodes.length, 4);
  assert.ok(result.nodes.every(item => !nodes.some(original => original.id === item.id)));
  const [outer, inner, a, b] = result.nodes;
  assert.deepEqual(outer.data.memberIds, [inner.id, b.id]);
  assert.deepEqual(inner.data.memberIds, [a.id]);
  assert.deepEqual(a.position, { x: 132, y: 132 });
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].source, a.id);
  assert.equal(result.edges[0].target, b.id);
  outer.data.memberIds.pop();
  assert.deepEqual(nodes[0].data.memberIds, ['inner', 'b']);
});

test('local export and shared sanitization preserve group membership, color and large bounds', () => {
  const source = createGroup(graph(node('a'), node('b', 5000, 2000)), ['a', 'b'], { id: 'g', name: 'Workers', color: '#ae9cff' });
  const snapshot = { ...emptySnapshot(), structured: source };
  const board = { id: 'synthetic-groups', name: 'Grouped architecture', snapshot };
  const clean = cleanStructured(source);
  assert.ok(clean.nodes[0].style.width > 1600);
  assert.equal(clean.nodes[0].zIndex, undefined);
  const imported = parseBoardImport(exportBoard(board));
  assert.deepEqual(imported.snapshot.structured, clean);
  const shared = sanitizeSharedBoard(board);
  assert.deepEqual(shared.snapshot.structured.nodes, clean.nodes);
  assert.deepEqual(shared.snapshot.structured.edges, clean.edges);
});

test('deleting a group preserves its children and deletes only dangling memberships', () => {
  const source = graph(group('outer', ['inner']), group('inner', ['a']), node('a'));
  const deleted = cleanStructured({ ...source, nodes: source.nodes.filter(item => item.id !== 'inner') });
  assert.deepEqual(deleted.nodes.map(item => item.id), ['outer', 'a']);
  assert.deepEqual(deleted.nodes[0].data.memberIds, []);
  assert.deepEqual(deleted.nodes[1].position, source.nodes[2].position);
});

test('imported group frames always have explicit dimensions instead of React Flow defaults', () => {
  const bare = { id: 'frame', type: 'group', position: { x: 0, y: 0 }, data: { name: 'Frame', memberIds: [] } };
  const cleaned = cleanStructured(graph(bare));
  assert.deepEqual(cleaned.nodes[0].style, { width: 320, height: 240 });
});

function canvasChanges(initial, changes) {
  return applyGroupMoves(initial, { ...initial, nodes: applyNodeChanges(changes, initial.nodes) }, changes);
}

test('canvas group dragging still moves members alongside unrelated dimension measurements', () => {
  const initial = graph({ ...group('g', ['a']), position: { x: 0, y: 0 } }, node('a', 24, 60), node('outside', 400));
  const result = canvasChanges(initial, [{ type: 'position', id: 'g', position: { x: 50, y: 0 }, dragging: true }, { type: 'dimensions', id: 'outside', dimensions: { width: 180, height: 160 } }]);
  assert.equal(result.nodes.find(item => item.id === 'a').position.x, 74);
});

test('aligning selected ancestor and child groups preserves the child content offsets', () => {
  const initial = graph({ ...group('outer', ['inner']), position: { x: 0, y: 0 }, selected: true }, { ...group('inner', ['a']), position: { x: 100, y: 60 }, selected: true }, node('a', 124, 120));
  const result = canvasChanges(initial, [{ type: 'position', id: 'outer', position: { x: 0, y: 0 } }, { type: 'position', id: 'inner', position: { x: 0, y: 60 } }]);
  const inner = result.nodes.find(item => item.id === 'inner'), member = result.nodes.find(item => item.id === 'a');
  assert.equal(member.position.x - inner.position.x, 24);
});

test('mixed resizing and dragging only suppresses member movement for the resized group', () => {
  const initial = graph({ ...group('sized', ['a']), position: { x: 0, y: 0 } }, { ...group('moved', ['b']), position: { x: 400, y: 0 } }, node('a', 24, 60), node('b', 424, 60));
  const changes = [
    { type: 'position', id: 'sized', position: { x: -50, y: 0 } },
    { type: 'dimensions', id: 'sized', dimensions: { width: 400, height: 200 }, resizing: true },
    { type: 'position', id: 'moved', position: { x: 500, y: 0 }, dragging: true },
  ];
  const result = canvasChanges(initial, changes);
  assert.equal(result.nodes.find(item => item.id === 'a').position.x, 24, 'Resizing changes only the frame');
  assert.equal(result.nodes.find(item => item.id === 'b').position.x, 524, 'Other groups still move');
});

test('nested simultaneous drags and explicit child moves are never applied twice', () => {
  const initial = graph({ ...group('outer', ['inner']), position: { x: 0, y: 0 } }, { ...group('inner', ['a', 'b']), position: { x: 24, y: 60 } }, node('a', 48, 120), node('b', 250, 120));
  const changes = [
    { type: 'position', id: 'outer', position: { x: 50, y: 0 }, dragging: true },
    { type: 'position', id: 'inner', position: { x: 74, y: 60 }, dragging: true },
    { type: 'position', id: 'a', position: { x: 98, y: 120 }, dragging: true },
  ];
  const result = canvasChanges(initial, changes);
  assert.equal(result.nodes.find(item => item.id === 'a').position.x, 98);
  assert.equal(result.nodes.find(item => item.id === 'b').position.x, 300);
});
