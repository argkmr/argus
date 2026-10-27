import test from 'node:test';
import assert from 'node:assert/strict';
import { expandedNotesGraph, getExpandedNotesLayout, wrapExpandedText } from '../frontend/features/diagrams/diagram-expanded-layout.mjs';

const component = (id, x, y, description = '') => ({ id, type: 'component', position: { x, y }, style: { width: 180, height: 160 }, data: { name: id, componentKey: 'redis', description } });
const group = (id, members) => ({ id, type: 'group', position: { x: -24, y: -60 }, style: { width: 400, height: 300 }, data: { name: id, color: '#74a7ff', memberIds: members } });
const overlaps = (a, b) => a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;
const contains = (outer, inner) => outer.position.x + 24 <= inner.position.x && outer.position.y + 60 <= inner.position.y && outer.position.x + outer.width - 24 >= inner.position.x + inner.width && outer.position.y + outer.height - 24 >= inner.position.y + inner.height;

test('expanded wrapping keeps every character, hard line break and blank line without ellipsizing', () => {
  const text = `First line\n\n${'W'.repeat(400)}  \t${'内容🙂'.repeat(300)} end`;
  const lines = wrapExpandedText(text);
  assert.equal(lines.join(''), text.replace(/\n/g, ''));
  assert.equal(lines[0], 'First line');
  assert.equal(lines[1], '');
  assert.ok(lines.length > 40);
  assert.ok(lines.every(line => Array.from(line).length <= 34));
  assert.deepEqual(wrapExpandedText('a\r\nb\rc'), ['a', 'b', 'c']);
  assert.deepEqual(wrapExpandedText(''), ['']);
});

test('full 4000-character notes and long names determine safe, unclipped expanded height', () => {
  const layout = getExpandedNotesLayout({ name: 'Very long service name '.repeat(12), description: 'W'.repeat(4000), replicas: 3 });
  assert.equal(layout.width, 460);
  assert.equal(layout.notesLines.join(''), 'W'.repeat(4000));
  assert.ok(layout.height >= layout.notesTop + layout.notesLines.length * layout.lineHeight + 24);
  assert.ok(layout.height >= layout.replicaTop + layout.lineHeight + 24);
  assert.equal(layout.glyphX, 28);
  assert.equal(layout.notesX, 156);
  assert.equal(layout.notesWidth, 280);
  assert.equal(layout.notesFontSize, 12.5);
});

test('projection is pure, stable, deterministic and eliminates intersections across mixed node sizes', () => {
  const nodes = Array.from({ length: 18 }, (_, index) => component(`service-${index}`, (index % 6) * 210, Math.floor(index / 6) * 200, index % 3 ? 'Short notes.' : 'A paragraph with many words. '.repeat(140)));
  nodes.push({ id: 'annotation', type: 'note', position: { x: -80, y: 20 }, style: { width: 640, height: 300 }, data: { description: 'Keep this note.' } });
  nodes.push({ id: 'shape', type: 'component', position: { x: 50, y: 300 }, style: { width: 300, height: 200 }, data: { componentKey: 'shape:rectangle', name: 'Boundary' } });
  nodes.push({ id: 'ds', type: 'dataStructure', position: { x: 30, y: 50 }, data: { structureKind: 'array', entries: [{ id: 'a', value: '1' }] } });
  const graph = { nodes, edges: [{ id: 'edge', source: 'service-1', target: 'service-2' }] };
  const before = structuredClone(graph);
  const result = expandedNotesGraph(graph);
  assert.deepEqual(graph, before, 'stored compact graph is untouched');
  assert.deepEqual(expandedNotesGraph(graph), result, 'repeated projection is stable');
  assert.deepEqual(result.edges, graph.edges);
  const geometry = value => value.nodes.map(({ id, position, width, height }) => ({ id, position, width, height })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(geometry(expandedNotesGraph({ ...graph, nodes: [...nodes].reverse() })), geometry(result), 'input array order does not change layout');
  assert.equal(result.nodes.find(node => node.id === 'shape').data.expandedNotes, undefined);
  assert.equal(result.nodes.find(node => node.id === 'annotation').width, 640);
  for (const node of result.nodes) for (const other of result.nodes) if (node.id !== other.id) assert.equal(overlaps(node, other), false, `${node.id} does not overlap ${other.id}`);
});

test('nested groups stay together, fit descendants and remain disjoint from unrelated blocks', () => {
  const graph = { nodes: [component('a', 0, 0, 'long '.repeat(800)), component('b', 250, 0), component('c', 500, 0), component('outside', 750, 0), group('inner', ['a', 'b']), group('outer', ['inner', 'c'])], edges: [] };
  const result = expandedNotesGraph(graph), byId = new Map(result.nodes.map(node => [node.id, node]));
  assert.ok(contains(byId.get('inner'), byId.get('a')));
  assert.ok(contains(byId.get('inner'), byId.get('b')));
  assert.ok(contains(byId.get('outer'), byId.get('inner')));
  assert.ok(contains(byId.get('outer'), byId.get('c')));
  assert.equal(overlaps(byId.get('inner'), byId.get('c')), false);
  assert.equal(overlaps(byId.get('outer'), byId.get('outside')), false);
  assert.equal(overlaps(byId.get('a'), byId.get('b')), false);
});

test('nearby source y positions form left-to-right ranks, independent of note lengths or input order', () => {
  const graph = { nodes: [component('database', 790, 80), component('client', 80, 100), component('api', 400, 100, 'Long notes '.repeat(350)), component('cache', 790, 350), component('topic', 400, 410), component('worker', 1080, 350)], edges: [] };
  for (const current of [graph, { ...graph, nodes: [...graph.nodes].reverse() }, { ...graph, nodes: graph.nodes.map(node => ({ ...node, data: { ...node.data, description: '' } })) }]) {
    const result = expandedNotesGraph(current), byId = new Map(result.nodes.map(node => [node.id, node]));
    const firstRow = ['client', 'api', 'database'].map(id => byId.get(id));
    const secondRow = ['topic', 'cache', 'worker'].map(id => byId.get(id));
    assert.equal(new Set(firstRow.map(node => node.position.y)).size, 1);
    assert.equal(new Set(secondRow.map(node => node.position.y)).size, 1);
    for (const row of [firstRow, secondRow]) assert.ok(row[0].position.x < row[1].position.x && row[1].position.x < row[2].position.x);
    assert.ok(secondRow[0].position.y >= Math.max(...firstRow.map(node => node.position.y + node.height)) + 48);
  }
});

test('a padded group remains beside its source-rank peers instead of wrapping at an assumed card width', () => {
  const graph = { nodes: [component('ui', 80, 100), component('api', 400, 100), component('database', 790, 80), component('cache', 790, 350), { ...group('data-layer', ['database', 'cache']), position: { x: 766, y: 20 } }], edges: [] };
  const original = structuredClone(graph);
  const result = expandedNotesGraph(graph), byId = new Map(result.nodes.map(node => [node.id, node]));
  const row = ['ui', 'api', 'data-layer'].map(id => byId.get(id));
  assert.equal(new Set(row.map(node => node.position.y)).size, 1, 'all three source-rank peers stay on one row');
  assert.equal(row[2].width, 508, 'the group includes its genuine 24px left/right padding');
  assert.ok(row[0].position.x + row[0].width + 144 <= row[1].position.x);
  assert.ok(row[1].position.x + row[1].width + 144 <= row[2].position.x);
  assert.ok(contains(row[2], byId.get('database')));
  assert.ok(contains(row[2], byId.get('cache')));
  assert.ok(byId.get('database').position.y + byId.get('database').height < byId.get('cache').position.y, 'vertical group members retain their ranks');
  assert.deepEqual(graph, original);
});

test('invalid dimensions, membership cycles, shared children and dangling ids do not produce NaN or duplicate placement', () => {
  const graph = { nodes: [component('a', Infinity, NaN), { ...component('b', -40, 0), measured: { width: Infinity, height: NaN } }, group('g1', ['g2', 'a', 'missing']), group('g2', ['g1', 'a', 'b'])] };
  const result = expandedNotesGraph(graph);
  const membership = result.nodes.filter(node => node.type === 'group').flatMap(node => node.data.memberIds);
  assert.equal(new Set(membership).size, membership.length);
  for (const node of result.nodes) for (const value of [node.position.x, node.position.y, node.width, node.height]) assert.ok(Number.isFinite(value));
  assert.deepEqual(expandedNotesGraph({ nodes: [] }), { nodes: [], edges: [] });
});
