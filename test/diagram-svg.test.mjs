import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { exportStructuredSvg } from '../frontend/features/diagrams/diagram-svg.mjs';
import { COMPONENT_BRAND_ICONS } from '../frontend/features/diagrams/diagram-catalog.mjs';
import { expandedNotesGraph, getExpandedNotesLayout } from '../frontend/features/diagrams/diagram-expanded-layout.mjs';
import { getExpandedRoutes } from '../frontend/features/diagrams/diagram-expanded-routing.mjs';

function parse(svg) {
  const errors = [];
  const document = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) }).parseFromString(svg, 'image/svg+xml');
  assert.deepEqual(errors, []);
  assert.equal(document.documentElement.localName, 'svg');
  return document;
}
const elements = (document, name) => Array.from(document.getElementsByTagName(name));
const node = (id, type, x, y, data, dimensions = {}) => ({ id, type, position: { x, y }, data, ...dimensions });

test('structured export is portable XML, escapes hostile labels, and preserves Unicode', () => {
  const hostile = '</text><script>alert("x")</script>& 名称';
  const graph = { nodes: [
    node('class" onload="alert(1)', 'umlClass', -40, -20, { name: hostile, stereotype: 'entity', fields: [{ id: 'a', text: '+ 名称: String & <Value>' }], methods: [{ id: 'b', text: '+ save(): Résultat' }] }),
    node('note', 'note', 400, 50, { name: 'Context', description: 'A → B\nNo &nbsp; entity is required.' }),
  ], edges: [] };
  const svg = exportStructuredSvg(graph), document = parse(svg);
  assert.equal(elements(document, 'script').length, 0);
  assert.equal(elements(document, 'foreignObject').length, 0);
  assert.equal(elements(document, 'image').length, 0);
  assert.equal(elements(document, 'input').length, 0);
  assert.equal(elements(document, 'g').some(element => element.hasAttribute('onload')), false);
  assert.ok(document.documentElement.textContent.includes(hostile));
  assert.ok(document.documentElement.textContent.includes('名称'));
  assert.ok(svg.includes('&amp;nbsp;'));
  assert.ok(!svg.includes('NaN'));
  assert.ok(document.documentElement.getAttribute('viewBox').startsWith('-88 -68 '));
});

test('HLD export makes the functional shape dominant, with a small product logo and unchanged notes', () => {
  const graph = { nodes: [
    node('redis', 'component', 10, 20, { name: 'Order cache', componentKey: 'redis', description: 'TTL 30 minutes' }, { measured: { width: 320, height: 180 }, style: { width: 600 } }),
    node('topic', 'component', 450, 20, { name: 'order.created', componentKey: 'kafka-topic', description: 'Partitioned event log' }),
  ], edges: [] };
  const document = parse(exportStructuredSvg(graph));
  const redis = elements(document, 'g').find(element => element.getAttribute('data-node-id') === 'redis');
  assert.equal(redis.getElementsByTagName('rect').length, 0, 'no enclosing card or badge rectangle');
  const role = elements(redis, 'g').find(element => element.getAttribute('data-role') === 'cache');
  assert.equal(role.getAttribute('transform'), 'translate(138 46) scale(2.67)', 'functional shape stays 64px');
  const mark = elements(redis, 'g').find(element => element.getAttribute('data-brand') === 'Redis');
  assert.equal(mark.getAttribute('transform'), 'translate(182 90)', 'product logo starts at the shape’s 44px inset');
  const logo = elements(mark, 'svg')[0];
  assert.equal(logo.getAttribute('width'), '24');
  assert.equal(logo.getAttribute('height'), '24');
  assert.equal(logo.getAttribute('viewBox'), COMPONENT_BRAND_ICONS.Redis.viewBox || '0 0 24 24');
  const badge = elements(redis, 'circle').find(element => element.hasAttribute('data-product-badge'));
  assert.deepEqual(['cx', 'cy', 'r'].map(attribute => badge.getAttribute(attribute)), ['194', '102', '15']);
  const label = elements(redis, 'text')[0];
  assert.equal(label.getAttribute('x'), '170');
  assert.equal(label.getAttribute('y'), '133');
  assert.equal(label.getAttribute('text-anchor'), 'middle');
  assert.ok(elements(redis, 'title').some(title => title.textContent === 'TTL 30 minutes'));
  const notes = elements(redis, 'g').find(element => element.hasAttribute('data-component-notes'));
  assert.equal(notes.getAttribute('transform'), 'translate(228 52)');
  assert.equal(elements(redis, 'text').some(text => text.textContent.includes('TTL 30 minutes')), false);
  const redisPaths = COMPONENT_BRAND_ICONS.Redis.paths || [{ d: COMPONENT_BRAND_ICONS.Redis.path }];
  for (const { d, fill } of redisPaths) assert.ok(elements(mark, 'path').some(path => path.getAttribute('d') === d && (!fill || path.getAttribute('fill') === fill)));
  assert.ok(elements(document, 'path').some(path => path.getAttribute('d') === COMPONENT_BRAND_ICONS['Apache Kafka'].path));
  assert.ok(elements(document, 'g').some(element => element.getAttribute('data-role') === 'cache'));
  assert.ok(elements(document, 'g').some(element => element.getAttribute('data-role') === 'topic'));
  assert.ok(!exportStructuredSvg(graph).includes('href='));
});

test('branded replica ghosts repeat functional shapes without repeating product badges', () => {
  for (const theme of [{ background: '#111419', foreground: '#f2f4f7' }, { background: '#ffffff', foreground: '#15202b' }]) {
    const document = parse(exportStructuredSvg({ nodes: [node('redis', 'component', 0, 0, { name: 'Cache replicas', componentKey: 'redis', replicas: 5 })], edges: [] }, theme));
    const redis = elements(document, 'g').find(element => element.getAttribute('data-node-id') === 'redis');
    const ghosts = elements(redis, 'g').filter(element => element.hasAttribute('data-replica-layer'));
    assert.equal(ghosts.length, 3);
    assert.equal(elements(redis, 'g').filter(element => element.getAttribute('data-role') === 'cache').length, 4);
    assert.equal(elements(redis, 'g').filter(element => element.hasAttribute('data-brand')).length, 1);
    for (const ghost of ghosts) {
      assert.equal(elements(ghost, 'g').some(element => element.hasAttribute('data-brand')), false);
      assert.equal(elements(ghost, 'circle').some(element => element.hasAttribute('data-product-badge')), false);
    }
    const badge = elements(redis, 'circle').find(element => element.hasAttribute('data-product-badge'));
    assert.equal(badge.getAttribute('fill'), theme.background);
    assert.ok(elements(redis, 'g').some(element => element.getAttribute('data-replica-count') === '5'));
  }
});

test('both Redis catalog entries export the bundled classic multicolor product mark without network assets', () => {
  for (const componentKey of ['redis', 'eraser:redis']) {
    const document = parse(exportStructuredSvg({ nodes: [node('cache', 'component', 0, 0, { name: 'Cache', componentKey })], edges: [] }, { background: '#ffffff', foreground: '#15202b' }));
    const mark = elements(document, 'g').find(element => element.getAttribute('data-brand') === 'Redis');
    assert.ok(mark, componentKey);
    assert.equal(elements(mark, 'svg')[0].getAttribute('viewBox'), '0 0 128 128');
    assert.deepEqual(elements(mark, 'path').map(path => ({ d: path.getAttribute('d'), fill: path.getAttribute('fill') })), COMPONENT_BRAND_ICONS.Redis.paths);
    assert.ok(new Set(elements(mark, 'path').map(path => path.getAttribute('fill'))).size > 1);
    assert.equal(elements(document, 'image').length, 0, 'classic product mark works offline and in raster export');
    assert.equal(elements(document, 'g').filter(element => element.getAttribute('data-role') === 'cache').length, 1);
  }
});

test('generic HLD symbols, replica ghosts and notes are portable without card shells', () => {
  for (const theme of [{ background: '#111419', foreground: '#f2f4f7' }, { background: '#ffffff', foreground: '#15202b' }]) {
    const description = '</title><script>attack()</script> & private design notes';
    const graph = { nodes: [node('workers', 'component', 0, 0, { name: 'Background workers processing order events', componentKey: 'worker', description, replicas: 1000 })], edges: [] };
    const document = parse(exportStructuredSvg(graph, theme));
    const worker = elements(document, 'g').find(element => element.getAttribute('data-node-id') === 'workers');
    assert.equal(elements(worker, 'rect').length, 0);
    assert.equal(elements(worker, 'g').filter(element => element.hasAttribute('data-replica-layer')).length, 3);
    assert.equal(elements(worker, 'g').filter(element => element.getAttribute('data-role') === 'worker').length, 4);
    assert.ok(elements(worker, 'g').some(element => element.getAttribute('data-replica-count') === '1000'));
    assert.ok(elements(worker, 'title').some(title => title.textContent === description));
    assert.equal(elements(worker, 'text').some(text => text.textContent.includes('private design notes')), false);
    assert.equal(elements(document, 'script').length, 0);
    const [left, top, width, height] = document.documentElement.getAttribute('viewBox').split(' ').map(Number);
    assert.ok(left <= 40 && top <= -2 && left + width >= 180 && top + height >= 160, 'including all ghost layers');
    assert.equal(elements(worker, 'text')[0].getElementsByTagName('tspan').length, 2);
  }
});

test('components without notes or replicas show only their symbol and label', () => {
  const document = parse(exportStructuredSvg({ nodes: [node('service', 'component', 0, 0, { name: 'API', componentKey: 'service', replicas: 1 })], edges: [] }));
  const service = elements(document, 'g').find(element => element.getAttribute('data-node-id') === 'service');
  assert.equal(elements(service, 'g').filter(element => element.hasAttribute('data-component-notes') || element.hasAttribute('data-replica-count') || element.hasAttribute('data-replica-layer')).length, 0);
  assert.equal(elements(service, 'text').length, 1);
});

test('HLD edge ports follow symbols and labels instead of the former card boundaries', () => {
  const graph = { nodes: [node('a', 'component', 10, 20, { name: 'API', componentKey: 'service' }, { measured: { width: 320, height: 200 } }), node('b', 'component', 500, 40, { name: 'Cache', componentKey: 'redis' })], edges: ['top', 'right', 'bottom', 'left'].map(side => ({ id: side, source: 'a', target: 'b', sourceHandle: side, targetHandle: side, data: { relation: 'message' } })) };
  const document = parse(exportStructuredSvg(graph));
  const expected = { top: 'M170 44 L590 44', right: 'M220 88 L640 88', bottom: 'M170 196 L590 196', left: 'M120 88 L540 88' };
  for (const [side, path] of Object.entries(expected)) {
    const edge = elements(document, 'g').find(element => element.getAttribute('data-edge-id') === side);
    assert.equal(edge.getElementsByTagName('path')[0].getAttribute('d'), path);
  }
});

test('HLD roles adapt to light-theme contrast while small product logos retain their colors', () => {
  const graph = { nodes: [node('react', 'component', 0, 0, { name: 'Web client', componentKey: 'react' }), node('worker', 'component', 200, 0, { name: 'Worker', componentKey: 'worker' })], edges: [] };
  const mixedReact = '#4390a8', mixedWorker = '#4c8f6f';
  for (const [background, foreground] of [['#ffffff', '#15202b'], ['rgb(255, 255, 255)', 'rgb(21 32 43)'], ['hsl(0 0% 100%)', '#15202b']]) {
    const document = parse(exportStructuredSvg(graph, { background, foreground }));
    const react = elements(document, 'g').find(element => element.getAttribute('data-brand') === 'React');
    const worker = elements(document, 'g').find(element => element.getAttribute('data-role') === 'worker');
    assert.equal(react.getAttribute('fill'), '#61dafb', 'brand color is not replaced with the role contrast mix');
    assert.equal(worker.getAttribute('stroke'), mixedWorker);
    const role = elements(document, 'g').find(element => element.getAttribute('data-role') === 'browser');
    assert.equal(role.getAttribute('stroke'), mixedReact, 'the dominant functional shape receives the contrast mix');
    assert.equal(role.getAttribute('transform'), 'translate(58 16) scale(2.67)');
  }
  const dark = parse(exportStructuredSvg(graph, { background: '#111419', foreground: '#f2f4f7' }));
  assert.equal(elements(dark, 'g').find(element => element.getAttribute('data-brand') === 'React').getAttribute('fill'), '#61dafb');
  assert.equal(elements(dark, 'g').find(element => element.getAttribute('data-role') === 'browser').getAttribute('stroke'), '#61dafb');
});

test('expanded notes export every line using shared geometry without clipping or ellipses', () => {
  const description = ('Line with <safe> & exact whitespace.\n\n' + 'W'.repeat(150) + '\n').repeat(24).slice(0, 4000);
  const graph = expandedNotesGraph({ nodes: [node('redis', 'component', 10, 20, { name: 'An intentionally long name for our Redis replicas', componentKey: 'redis', description, replicas: 5 })], edges: [] });
  const source = graph.nodes[0], layout = getExpandedNotesLayout(source.data);
  for (const background of ['#151515', '#f6f7f9']) {
    const document = parse(exportStructuredSvg(graph, { background }));
    const notes = elements(document, 'text').find(text => text.hasAttribute('data-expanded-notes'));
    const lines = elements(notes, 'tspan');
    assert.deepEqual(lines.map(line => line.textContent), layout.notesLines);
    assert.equal(notes.textContent, description.replace(/\n/g, ''));
    assert.equal(notes.getAttribute('font-size'), '12.5');
    assert.equal(notes.getAttribute('x'), String(source.position.x + 156));
    assert.equal(notes.getAttribute('y'), String(source.position.y + 36.5));
    assert.ok(Number(lines.at(-1).getAttribute('y')) < source.position.y + source.height - 24);
    const symbol = elements(document, 'g').find(element => element.getAttribute('data-component-symbol') === 'redis');
    assert.equal(elements(symbol, 'g').find(element => element.getAttribute('data-role') === 'cache').getAttribute('transform'), 'translate(38 44) scale(2.67)');
    assert.equal(elements(document, 'rect').some(element => element.hasAttribute('data-expanded-notes-background')), false, 'expanded notes stay transparent inside colored groups');
    assert.equal(elements(document, 'g').some(element => element.hasAttribute('data-component-notes')), false);
    assert.equal(elements(document, 'script').length, 0);
  }
});

test('colored group frames render behind all connectors and components in compact and expanded export', () => {
  const original = { nodes: [
    node('a', 'component', 20, 80, { name: 'Service', componentKey: 'service', description: 'A complete service note.' }),
    node('b', 'component', 260, 80, { name: 'Cache', componentKey: 'redis' }),
    node('group', 'group', -4, 20, { name: 'Backend <boundary>', color: '#71d99c', memberIds: ['a', 'b'] }, { style: { width: 500, height: 250 } }),
  ], edges: [{ id: 'edge', source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left' }] };
  for (const graph of [original, expandedNotesGraph(original)]) {
    const svg = exportStructuredSvg(graph), document = parse(svg);
    const frame = elements(document, 'rect').find(element => element.hasAttribute('data-group-frame'));
    assert.equal(frame.getAttribute('fill'), '#71d99c');
    assert.equal(frame.getAttribute('fill-opacity'), '.08');
    assert.ok(svg.indexOf('data-node-id="group"') < svg.indexOf('data-edge-id="edge"'));
    assert.ok(svg.indexOf('data-edge-id="edge"') < svg.indexOf('data-node-id="a"'));
    assert.ok(elements(document, 'text').some(text => text.textContent.includes('Backend <boundary>')));
    assert.equal(elements(document, 'g').filter(element => element.getAttribute('data-node-type') === 'group').length, 1);
  }
});

test('expanded connector ports stay outside the readable notes instead of crossing into their text', () => {
  const graph = expandedNotesGraph({ nodes: [node('a', 'component', 0, 0, { name: 'A', componentKey: 'service' }), node('b', 'component', 500, 0, { name: 'B', componentKey: 'redis' })], edges: ['top', 'right', 'bottom', 'left'].map(side => ({ id: side, source: 'a', target: 'b', sourceHandle: side, targetHandle: side, data: { relation: 'message' } })) });
  const document = parse(exportStructuredSvg(graph));
  const routes = getExpandedRoutes(graph);
  const point = (node, side) => `${node.position.x + (side === 'left' ? 0 : side === 'right' ? node.width : 60)} ${node.position.y + (side === 'top' ? 0 : side === 'bottom' ? node.height : 56)}`;
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const edge = elements(document, 'g').find(element => element.getAttribute('data-edge-id') === side);
    assert.equal(elements(edge, 'path')[0].getAttribute('d'), routes[side].path);
    assert.ok(routes[side].path.startsWith(`M${point(graph.nodes[0], side)} `));
    assert.ok(routes[side].path.endsWith(`L${point(graph.nodes[1], side)}`));
  }
});

test('expanded SVG uses the exact shared safe paths, full label lines and outer-lane bounds', () => {
  const graph = expandedNotesGraph({ nodes: [node('a', 'component', 0, 0, { name: 'A', componentKey: 'spring' }), node('b', 'component', 500, 0, { name: 'B', componentKey: 'redis' })], edges: Array.from({ length: 8 }, (_, index) => ({ id: `edge-${index}`, source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left', data: { relation: 'association', label: `HTTPS ${index}: preserve the complete operation identifier across retries and reconciliation` } })) });
  const routes = getExpandedRoutes(graph), document = parse(exportStructuredSvg(graph));
  const [left, top, width, height] = document.documentElement.getAttribute('viewBox').split(' ').map(Number);
  for (const [id, route] of Object.entries(routes)) {
    const edge = elements(document, 'g').find(element => element.getAttribute('data-edge-id') === id);
    const label = elements(document, 'g').find(element => element.getAttribute('data-edge-label') === id);
    assert.equal(elements(edge, 'path')[0].getAttribute('d'), route.path);
    assert.deepEqual(elements(label, 'tspan').map(element => element.textContent), route.labelLines);
    const rectangle = elements(label, 'rect')[0];
    assert.equal(Number(rectangle.getAttribute('width')), route.labelWidth);
    assert.equal(Number(rectangle.getAttribute('height')), route.labelHeight);
    assert.ok(route.labelX - route.labelWidth / 2 > left && route.labelX + route.labelWidth / 2 < left + width);
    assert.ok(route.labelY - route.labelHeight / 2 > top && route.labelY + route.labelHeight / 2 < top + height);
  }
});

test('every UML relation receives the correct source or target marker and dash treatment', () => {
  const relations = ['association', 'dependency', 'inheritance', 'implementation', 'aggregation', 'composition', 'message', 'return', 'async'];
  const graph = { nodes: [node('a', 'component', 0, 0, { name: 'A' }), node('b', 'component', 400, 0, { name: 'B' })], edges: relations.map((relation, index) => ({ id: relation, source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left', data: { relation, label: relation, curvature: (index + 1) / 10 } })) };
  const document = parse(exportStructuredSvg(graph));
  for (const relation of relations) {
    const edge = elements(document, 'g').find(element => element.getAttribute('data-edge-id') === relation);
    const path = edge.getElementsByTagName('path')[0];
    assert.equal(path.hasAttribute('stroke-dasharray'), ['dependency', 'implementation', 'return'].includes(relation));
    if (['aggregation', 'composition'].includes(relation)) {
      assert.equal(path.getAttribute('marker-start'), `url(#argus-${relation})`);
      assert.equal(path.hasAttribute('marker-end'), false);
    } else {
      const marker = ['inheritance', 'implementation'].includes(relation) ? 'triangle' : ['return', 'async'].includes(relation) ? 'open-arrow' : 'arrow';
      assert.equal(path.getAttribute('marker-end'), `url(#argus-${marker})`);
    }
    assert.equal(path.getAttribute('d').includes(' C'), !['message', 'return', 'async'].includes(relation));
  }
  const triangle = elements(document, 'marker').find(marker => marker.getAttribute('id') === 'argus-triangle').getElementsByTagName('path')[0];
  assert.equal(triangle.getAttribute('fill'), '#151515');
  const aggregation = elements(document, 'marker').find(marker => marker.getAttribute('id') === 'argus-aggregation').getElementsByTagName('path')[0];
  const composition = elements(document, 'marker').find(marker => marker.getAttribute('id') === 'argus-composition').getElementsByTagName('path')[0];
  assert.notEqual(aggregation.getAttribute('fill'), composition.getAttribute('fill'));
});

test('sequence row coordinates, self-loop endpoints, and world bounds are retained', () => {
  const graph = { nodes: [
    node('a', 'participant', 0, 0, { name: 'Client', role: 'Actor', lifelineHeight: 700 }, { measured: { width: 200, height: 774 } }),
    node('b', 'participant', 400, 0, { name: 'API', role: 'Service', lifelineHeight: 500 }, { style: { width: '200px' } }),
  ], edges: [
    { id: 'request', source: 'a', target: 'b', sourceHandle: 'r-2', targetHandle: 'l-2', data: { relation: 'message', label: 'GET /orders' } },
    { id: 'self', source: 'b', target: 'b', sourceHandle: 'r-3', targetHandle: 'r-5', data: { relation: 'message', label: 'Validate' } },
  ] };
  const document = parse(exportStructuredSvg(graph));
  const edge = id => elements(document, 'g').find(element => element.getAttribute('data-edge-id') === id).getElementsByTagName('path')[0];
  assert.equal(edge('request').getAttribute('d'), 'M104 156 L496 156');
  assert.match(edge('self').getAttribute('d'), /^M 504 184 H [\d.]+ V 240 H 504$/);
  const [, , , height] = document.documentElement.getAttribute('viewBox').split(' ').map(Number);
  assert.ok(height >= 870);
});

test('long text wraps, missing endpoints are skipped, and empty exports remain valid', () => {
  const long = 'This description contains many words that should wrap into several selectable lines without introducing embedded HTML.';
  const graph = { nodes: [node('n', 'note', 0, 0, { name: 'Design note', description: long }, { style: { width: 220, height: 220 } })], edges: [{ id: 'dangling', source: 'n', target: 'missing' }] };
  const document = parse(exportStructuredSvg(graph, { background: '"/><script/>', foreground: '#222222', line: '#335577' }));
  assert.ok(elements(document, 'tspan').length > 3);
  assert.ok(document.documentElement.textContent.includes(long));
  assert.equal(elements(document, 'g').filter(element => element.hasAttribute('data-edge-id')).length, 0);
  assert.equal(elements(document, 'script').length, 0);
  assert.ok(parse(exportStructuredSvg({ nodes: [], edges: [] })).documentElement.getAttribute('viewBox') === '0 0 640 360');
});
