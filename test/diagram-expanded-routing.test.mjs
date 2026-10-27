import test from 'node:test';
import assert from 'node:assert/strict';
import { expandedNotesGraph } from '../frontend/features/diagrams/diagram-expanded-layout.mjs';
import { getExpandedRoutes, getExpandedRouteBounds } from '../frontend/features/diagrams/diagram-expanded-routing.mjs';

const component = (id, x, y, description = 'Readable notes.') => ({ id, type: 'component', position: { x, y }, data: { name: id, componentKey: 'redis', description } });
const edge = (id, source, target, sourceHandle = 'right', targetHandle = 'left', label = id) => ({ id, source, target, sourceHandle, targetHandle, data: { label, relation: 'association' } });
const rectFor = node => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height });
const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const crosses = (a, b, rect) => a.y === b.y
  ? a.y > rect.y + .01 && a.y < rect.y + rect.height - .01 && Math.max(a.x, b.x) > rect.x + .01 && Math.min(a.x, b.x) < rect.x + rect.width - .01
  : a.x > rect.x + .01 && a.x < rect.x + rect.width - .01 && Math.max(a.y, b.y) > rect.y + .01 && Math.min(a.y, b.y) < rect.y + rect.height - .01;

function verify(graph, routes) {
  const rectangles = graph.nodes.filter(node => node.type !== 'group').map(rectFor), labels = [];
  for (const [id, route] of Object.entries(routes)) {
    assert.equal(route.unroutable, undefined, `${id} has a safe route`);
    assert.ok(route.path.startsWith('M'));
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1], b = route.points[index];
      assert.ok(a.x === b.x || a.y === b.y, `${id} is orthogonal`);
      for (const rect of rectangles) assert.equal(crosses(a, b, rect), false, `${id} segment ${JSON.stringify([a, b])} avoids ${JSON.stringify(rect)}`);
    }
    if (route.labelText) {
      const rect = { x: route.labelX - route.labelWidth / 2, y: route.labelY - route.labelHeight / 2, width: route.labelWidth, height: route.labelHeight };
      for (const obstacle of [...rectangles, ...labels]) assert.equal(overlap(rect, obstacle), false, `${id} label avoids nodes and previous labels`);
      labels.push(rect);
    }
  }
  const bounds = getExpandedRouteBounds(graph, routes);
  for (const route of Object.values(routes)) for (const point of route.points) assert.ok(point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height);
  for (const rect of labels) assert.ok(rect.x >= bounds.x && rect.x + rect.width <= bounds.x + bounds.width && rect.y >= bounds.y && rect.y + rect.height <= bounds.y + bounds.height);
}

test('common expanded architecture keeps every connector and label outside notes and node outlines', () => {
  const graph = expandedNotesGraph({ nodes: [component('client', 80, 100), component('api', 400, 100, 'Validate, persist and publish once. '.repeat(35)), component('mongo', 790, 80), component('redis', 790, 350), component('topic', 400, 410), component('worker', 1080, 350)], edges: [edge('a', 'client', 'api', 'right', 'left', 'HTTPS'), edge('b', 'api', 'mongo', 'right', 'left', 'Persist'), edge('c', 'api', 'redis', 'right', 'left', 'Read-through'), edge('d', 'api', 'topic', 'bottom', 'top', 'Publish'), edge('e', 'topic', 'worker', 'right', 'left', 'Consume')] });
  const routes = getExpandedRoutes(graph);
  assert.equal(Object.keys(routes).length, 5);
  verify(graph, routes);
  assert.deepEqual(getExpandedRoutes(graph), routes);
});

test('all sixteen handle pairs and labeled/unlabeled self-loops use safe orthogonal geometry', () => {
  const nodes = [component('a', 0, 0), component('b', 500, 0), component('c', 0, 240), component('d', 500, 240)], edges = [];
  for (const sourceHandle of ['top', 'right', 'bottom', 'left']) for (const targetHandle of ['top', 'right', 'bottom', 'left']) edges.push(edge(`${sourceHandle}-${targetHandle}`, 'a', 'd', sourceHandle, targetHandle));
  for (const side of ['top', 'right', 'bottom', 'left']) {
    edges.push(edge(`loop-${side}`, 'a', 'a', side, side, `Retry on ${side}`));
    edges.push(edge(`empty-loop-${side}`, 'b', 'b', side, side, ''));
  }
  const graph = expandedNotesGraph({ nodes, edges }), routes = getExpandedRoutes(graph);
  verify(graph, routes);
  for (const [id, route] of Object.entries(routes)) if (id.includes('loop')) {
    const area = Math.abs(route.points.slice(1).reduce((sum, p, index) => sum + route.points[index].x * p.y - p.x * route.points[index].y, 0));
    assert.ok(area > 0, `${id} forms a visible loop, not a doubled-back straight line`);
  }
});

test('short same-rank labels fit directly between nodes without detouring to outer lanes', () => {
  const graph = expandedNotesGraph({ nodes: [component('client', 80, 100), component('api', 400, 100), component('mongo', 790, 80)], edges: [edge('https', 'client', 'api', 'right', 'left', 'HTTPS'), edge('persist', 'api', 'mongo', 'right', 'left', 'Persist')] });
  const routes = getExpandedRoutes(graph), byId = new Map(graph.nodes.map(node => [node.id, node]));
  verify(graph, routes);
  for (const edge of graph.edges) {
    const source = byId.get(edge.source), target = byId.get(edge.target), route = routes[edge.id];
    assert.ok(route.points.every(point => point.y === source.position.y + 56), `${edge.id} stays in its horizontal corridor`);
    assert.ok(route.labelX - route.labelWidth / 2 > source.position.x + source.width);
    assert.ok(route.labelX + route.labelWidth / 2 < target.position.x);
  }
});

test('irregular obstacle mazes and graph cycles route without clipping annotations', () => {
  const nodes = [component('a', 0, 0), component('b', 1400, 700), ...Array.from({ length: 12 }, (_, index) => ({ ...component(`wall-${index}`, 540 + index % 3 * 250, Math.floor(index / 3) * 260), type: 'note', style: { width: 180, height: 180 }, width: 180, height: 180 }))];
  for (const node of nodes.slice(0, 2)) { node.data.expandedNotes = true; node.width = 460; node.height = 160; }
  const graph = { nodes, edges: [edge('cycle-a', 'a', 'b'), edge('cycle-b', 'b', 'a', 'top', 'bottom', 'Retry after acknowledgement'), edge('loop', 'a', 'a', 'right', 'top', 'Reconcile')] };
  verify(graph, getExpandedRoutes(graph));
});

test('crowded labels reserve connected outer lanes instead of overlapping one another', () => {
  const graph = expandedNotesGraph({ nodes: [component('a', 0, 0), component('b', 500, 0)], edges: Array.from({ length: 40 }, (_, index) => edge(`parallel-${String(index).padStart(2, '0')}`, 'a', 'b', 'right', 'left', `Request ${index}: preserve transaction ids and retry with a stable idempotency key`)) });
  const routes = getExpandedRoutes(graph);
  verify(graph, routes);
  for (const route of Object.values(routes)) assert.equal(route.labelLines.join(''), route.labelText);
  assert.ok(Object.values(routes).some(route => route.labelY < 0));
});

test('group frames are not obstacles, and missing/hidden endpoints do not create spurious routes', () => {
  const graph = expandedNotesGraph({ nodes: [component('a', 0, 0), component('b', 500, 0), { id: 'group', type: 'group', position: { x: -24, y: -60 }, data: { memberIds: ['a', 'b'] } }], edges: [edge('__proto__', 'a', 'b'), edge('missing', 'a', 'unknown'), { ...edge('hidden', 'a', 'b'), hidden: true }] });
  const routes = getExpandedRoutes(graph);
  assert.equal(Object.getPrototypeOf(routes), null);
  assert.deepEqual(Object.keys(routes), ['__proto__']);
  verify(graph, routes);
  assert.deepEqual(getExpandedRouteBounds({ nodes: [] }, {}), { x: 0, y: 0, width: 1, height: 1 });
});

test('large projected boards remain bounded and do not materialize a full Cartesian visibility grid', () => {
  const nodes = Array.from({ length: 2000 }, (_, index) => component(`node-${index}`, index % 40 * 200, Math.floor(index / 40) * 200));
  const edges = Array.from({ length: 5000 }, (_, index) => edge(`edge-${String(index).padStart(4, '0')}`, `node-${index % 1999}`, `node-${index % 1999 + 1}`, 'right', 'left', ''));
  const graph = expandedNotesGraph({ nodes, edges }), routes = getExpandedRoutes(graph);
  assert.equal(Object.keys(routes).length, 5000);
  assert.equal(Object.values(routes).filter(route => route.unroutable).length, 0);
  assert.ok(Object.values(routes).every(route => route.points.length <= 20));
});
