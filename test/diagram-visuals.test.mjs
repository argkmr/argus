import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { DIAGRAM_VISUALS, getVisualGeometry } from '../frontend/features/diagrams/diagram-visuals.mjs';
import { getDiagramComponent } from '../frontend/features/diagrams/diagram-catalog.mjs';
import { exportStructuredSvg } from '../frontend/features/diagrams/diagram-svg.mjs';

const parse = value => new DOMParser().parseFromString(value, 'image/svg+xml');
const all = (node, tag) => Array.from(node.getElementsByTagName(tag));
const asNode = (item, overrides = {}) => ({ id: item.id, type: 'component', position: { x: 10, y: 20 }, style: { width: item.width, height: item.height }, data: { componentKey: item.id, name: item.label, description: 'Design notes <safe> & preserved.', replicas: 1 }, ...overrides });

test('visual catalog includes all twelve documented Eraser shape forms and four wireframe devices', () => {
  assert.equal(DIAGRAM_VISUALS.filter(item => item.visualKind === 'shape').length, 12);
  assert.equal(DIAGRAM_VISUALS.filter(item => item.visualKind === 'frame').length, 4);
  assert.equal(new Set(DIAGRAM_VISUALS.map(item => item.id)).size, 16);
  for (const item of DIAGRAM_VISUALS) assert.equal(getDiagramComponent(item.id).id, item.id, `${item.id} participates in shared catalog lookup`);
});

test('shape/frame geometry remains bounded at initial, minimum and expanded sizes', () => {
  for (const item of DIAGRAM_VISUALS) for (const [width, height] of [[item.width, item.height], [180, 160], [600, 480]]) {
    const geometry = getVisualGeometry(item, width, height);
    assert.ok(geometry.primitives.length);
    for (const [side, [x, y]] of Object.entries(geometry.ports)) {
      assert.ok(Number.isFinite(x) && x >= 0 && x <= width, `${item.id} ${side} x`);
      assert.ok(Number.isFinite(y) && y >= 0 && y <= height, `${item.id} ${side} y`);
    }
    assert.ok(geometry.label.x >= 0 && geometry.label.y >= 0);
    assert.ok(geometry.label.x + geometry.label.width <= width);
    assert.ok(geometry.label.y + geometry.label.height <= height);
    for (const { tag, attrs } of geometry.primitives) {
      assert.ok(['path', 'circle', 'ellipse', 'rect'].includes(tag));
      for (const [key, value] of Object.entries(attrs)) {
        if (typeof value === 'number') assert.ok(Number.isFinite(value));
        if (['width', 'height', 'r', 'rx', 'ry'].includes(key)) assert.ok(value > 0, `${item.id} ${key}`);
      }
    }
  }
});

test('portable SVG uses the same shape/frame forms and ports, keeping notes in tooltips', () => {
  for (const item of DIAGRAM_VISUALS) {
    const source = asNode(item), target = asNode(item, { id: 'other', position: { x: 600, y: 400 } });
    const graph = { nodes: [source, target], edges: ['top', 'right', 'bottom', 'left'].map(side => ({ id: side, source: source.id, target: target.id, sourceHandle: side, targetHandle: side, data: { relation: 'message' } })) };
    const document = parse(exportStructuredSvg(graph));
    const visual = all(document, 'g').find(node => node.getAttribute('data-visual-form') === (item.shape || item.frame));
    assert.ok(visual, item.id);
    assert.equal(visual.getAttribute('data-visual-kind'), item.visualKind);
    assert.equal(visual.getAttribute('transform'), 'translate(10 20)');
    assert.equal(all(visual, '*').length, getVisualGeometry(item, item.width, item.height).primitives.length);
    assert.ok(all(document, 'g').some(node => node.getAttribute('data-component-notes') === 'true'));
    assert.ok(all(document, 'title').some(node => node.textContent.includes(source.data.description)));
    assert.ok(!all(document, 'text').some(node => node.textContent.includes(source.data.description)));
    assert.equal(all(document, 'script').length, 0);
    for (const [side, [x, y]] of Object.entries(getVisualGeometry(item, item.width, item.height).ports)) {
      const rounded = value => Math.round(value * 100) / 100;
      const edge = all(document, 'g').find(node => node.getAttribute('data-edge-id') === side);
      assert.equal(all(edge, 'path')[0].getAttribute('d'), `M${rounded(10 + x)} ${rounded(20 + y)} L${rounded(600 + x)} ${rounded(400 + y)}`);
    }
  }
});

test('Eraser icons export as embedded image assets, without card shells or a second glyph', () => {
  const item = getDiagramComponent('eraser:aws-lambda');
  assert.equal(item.iconName, 'aws-lambda');
  const asset = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 1h8v8H1z" fill="#f90"/></svg>').toString('base64')}`;
  const graph = { nodes: [asNode({ ...item, width: 240, height: 180 })], edges: [] };
  const document = parse(exportStructuredSvg(graph, { iconAssets: { 'aws-lambda': asset } }));
  const image = all(document, 'image')[0];
  assert.equal(image.getAttribute('data-eraser-icon'), 'aws-lambda');
  assert.equal(image.getAttribute('href'), asset);
  assert.equal(image.getAttribute('width'), '64');
  const component = all(document, 'g').find(node => node.getAttribute('data-node-id') === item.id);
  assert.equal(all(component, 'rect').length, 0);
  assert.ok(!all(component, 'g').some(node => node.hasAttribute('data-role')));
  assert.throws(() => exportStructuredSvg(graph, { iconAssets: { 'aws-lambda': 'https://example.com/icon.svg' } }), /before exporting/);
});
