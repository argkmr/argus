import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { exportStructuredSvg } from '../frontend/features/diagrams/diagram-svg.mjs';
import { getStructureLayout } from '../frontend/features/diagrams/diagram-structure-layout.mjs';

const elements = (document, name) => Array.from(document.getElementsByTagName(name));
const node = (id, type, data, x = 0, y = 0) => ({ id, type, data, position: { x, y } });
const parse = graph => {
  const errors = [], svg = exportStructuredSvg(graph);
  const document = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) }).parseFromString(svg, 'image/svg+xml');
  assert.deepEqual(errors, []); assert.ok(!svg.includes('NaN')); return document;
};

test('HLD replica SVG matches exact count, bounded ghost glyphs and unchanged ports', () => {
  const graph = { nodes: [node('workers', 'component', { name: 'Workers', componentKey: 'worker', replicas: 1000 }), node('db', 'component', { name: 'DB', componentKey: 'mongodb' }, 450)], edges: [{ id: 'e', source: 'workers', target: 'db', sourceHandle: 'right', targetHandle: 'left' }] };
  const document = parse(graph), layers = elements(document, 'g').filter(element => element.hasAttribute('data-replica-layer'));
  assert.equal(layers.length, 3);
  assert.deepEqual(layers.map(element => element.getElementsByTagName('g')[0].getAttribute('transform')), ['translate(40 -2) scale(2.67)', 'translate(46 4) scale(2.67)', 'translate(52 10) scale(2.67)']);
  assert.ok(elements(document, 'g').some(element => element.getAttribute('data-replica-count') === '1000'));
  const edgePath = document => elements(document, 'g').find(element => element.getAttribute('data-edge-id') === 'e').getElementsByTagName('path')[0].getAttribute('d');
  graph.nodes[0].data.replicas = 1;
  const single = parse(graph);
  assert.equal(edgePath(single), edgePath(document));
  assert.equal(elements(single, 'g').filter(element => element.hasAttribute('data-replica-layer')).length, 0);
  assert.ok(document.documentElement.getAttribute('viewBox').startsWith('-48 -50 '));
});

test('HLD queue symbols have pipe-shaped end caps and export names and counts without a card', () => {
  const document = parse({ nodes: [node('queue', 'component', { name: 'Work queue', componentKey: 'queue', replicas: 2 })], edges: [] });
  const pipe = elements(document, 'g').find(element => element.getAttribute('data-role') === 'queue');
  assert.ok(pipe); assert.equal(pipe.getElementsByTagName('ellipse').length, 1);
  assert.equal(pipe.getElementsByTagName('rect').length, 0);
  assert.equal(pipe.getElementsByTagName('ellipse')[0].getAttribute('ry'), '8');
  assert.ok(document.documentElement.textContent.includes('Work queue'));
  assert.ok(elements(document, 'g').some(element => element.getAttribute('data-replica-count') === '2'));
});

test('all structured data containers survive SVG export empty and populated with internal links', () => {
  const kinds = ['array', 'list', 'matrix', 'stack', 'queue', 'deque', 'map', 'set', 'linked-list', 'doubly-linked-list', 'circular-list', 'tree', 'bst', 'heap', 'trie', 'graph', 'union-find', 'bitset', 'object'];
  for (const structureKind of kinds) for (const count of [0, 3]) {
    const entries = Array.from({ length: count }, (_, index) => ({ id: `e${index}`, key: `k${index}`, value: `v${index}`, annotation: index === 1 ? 'selected item' : '' }));
    const data = { name: `Test ${structureKind}`, structureKind, columns: 2, entries, activeEntryId: 'e1', links: [{ id: 'internal', source: 'e0', target: 'e1', label: 'next' }], pointers: [{ id: 'p', label: 'current', target: 'e1' }] };
    const document = parse({ nodes: [node('data', 'dataStructure', data, -100, 40)], edges: [] });
    const layout = getStructureLayout(data);
    assert.ok(elements(document, 'g').some(element => element.getAttribute('data-structure-kind') === structureKind));
    assert.equal(elements(document, 'g').filter(element => element.hasAttribute('data-entry-id')).length, count);
    assert.equal(elements(document, 'g').filter(element => element.hasAttribute('data-pointer-id')).length, count ? 1 : 0);
    assert.equal(elements(document, 'g').filter(element => element.getAttribute('data-active') === 'true').length, count ? 1 : 0);
    const [, , width, height] = document.documentElement.getAttribute('viewBox').split(' ').map(Number);
    assert.ok(width >= layout.width + 96 && height >= layout.height + 96, structureKind);
    if (count) assert.ok(document.documentElement.textContent.includes('selected item'));
  }
});

test('data SVG keeps arbitrary labels as bounded escaped text, including maps and pointers', () => {
  const hostile = '</text><script>alert("x")</script>& 配列', long = 'W'.repeat(500);
  const data = { name: hostile, structureKind: 'map', implementation: 'HashMap<String, String>', entries: [{ id: 'e" onclick="x', key: hostile, value: long, annotation: hostile }], pointers: [{ id: 'p"', label: hostile, target: 'e" onclick="x' }] };
  const document = parse({ nodes: [node('d"', 'dataStructure', data)], edges: [] });
  assert.equal(elements(document, 'script').length, 0);
  assert.equal(elements(document, 'foreignObject').length, 0);
  assert.ok(elements(document, 'g').every(element => !element.hasAttribute('onclick')));
  assert.ok(document.documentElement.textContent.includes(hostile));
  assert.ok(document.documentElement.textContent.includes(long));
  assert.ok(document.documentElement.textContent.includes('HashMap<String, String>'));
  assert.ok(elements(document, 'tspan').some(element => element.textContent.endsWith('…')));
  assert.ok(elements(document, 'tspan').every(element => element.textContent.length < 100));
});

test('nested map keys and Map→Map→List values export as real containers with safe type labels', () => {
  const hostile = '</text><script>alert("nested")</script>&';
  const leaf = { name: 'Values', structureKind: 'list', typeSignature: 'ArrayList<String>', entries: [{ id: 'leaf', key: '', value: hostile, annotation: 'leaf annotation' }], activeEntryId: 'leaf', pointers: [{ id: 'p', label: hostile, target: 'leaf' }] };
  const inner = { name: 'Inner', structureKind: 'map', typeSignature: 'Map<String, ArrayList<String>>', entries: [{ id: 'inner', key: 'inner key', value: '', valueContainer: leaf }] };
  const data = { name: 'Nested', structureKind: 'map', typeSignature: 'Map<String, Map<String, ArrayList<String>>>', entries: [{ id: 'outer', key: 'outer key', valueContainer: inner }, { id: 'empty', keyContainer: { name: 'key collection', structureKind: 'set', typeSignature: `Set<${hostile}>`, entries: [] }, valueContainer: { name: 'empty value', structureKind: 'queue', typeSignature: 'Queue<String>', entries: [] } }] };
  const document = parse({ nodes: [{ ...node('nested', 'dataStructure', data, -75, -40), width: 80, height: 80 }], edges: [] });
  const containers = elements(document, 'g').filter(element => element.hasAttribute('data-structure-kind'));
  assert.deepEqual(containers.map(element => element.getAttribute('data-structure-kind')), ['map', 'map', 'list', 'set', 'queue']);
  assert.equal(elements(document, 'g').filter(element => element.hasAttribute('data-entry-id')).length, 4);
  assert.equal(elements(document, 'g').filter(element => element.hasAttribute('data-embedded-container')).length, 4);
  assert.ok(elements(document, 'g').some(element => element.getAttribute('data-structure-type') === data.typeSignature));
  assert.ok(document.documentElement.textContent.includes(hostile));
  assert.ok(document.documentElement.textContent.includes('leaf annotation'));
  assert.equal(elements(document, 'script').length, 0);
  assert.equal(elements(document, 'foreignObject').length, 0);
  assert.ok(elements(document, 'g').every(element => !element.hasAttribute('onclick')));
  const layout = getStructureLayout(data), [, , width, height] = document.documentElement.getAttribute('viewBox').split(' ').map(Number);
  assert.ok(width >= layout.width + 96 && height >= layout.height + 96);
});

test('nested container SVG remains bounded for an unsanitized reference cycle', () => {
  const data = { name: 'cycle', structureKind: 'map', entries: [] };
  data.entries.push({ id: 'e', key: '', value: '', valueContainer: data });
  const document = parse({ nodes: [node('cycle', 'dataStructure', data)], edges: [] });
  assert.equal(elements(document, 'g').filter(element => element.hasAttribute('data-structure-kind')).length, 2);
  assert.ok(document.documentElement.textContent.includes('Container limit reached'));
});
