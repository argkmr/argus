import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser } from '@xmldom/xmldom';
import * as catalog from '../frontend/features/diagrams/diagram-catalog.mjs';
import * as symbols from '../frontend/features/diagrams/diagram-architecture-symbols.mjs';
import * as replicas from '../frontend/features/diagrams/diagram-replicas.mjs';
import * as visuals from '../frontend/features/diagrams/diagram-visuals.mjs';
import * as expandedLayout from '../frontend/features/diagrams/diagram-expanded-layout.mjs';
import * as sequence from '../frontend/features/diagrams/diagram-sequence.mjs';
import * as expandedRouting from '../frontend/features/diagrams/diagram-expanded-routing.mjs';
import { emptySnapshot, exportBoard, makeNode, parseBoardImport } from '../frontend/features/diagrams/diagram-model.mjs';
import { exportStructuredSvg } from '../frontend/features/diagrams/diagram-svg.mjs';

const keys = ['sharding', 'consistent-hashing', 'load-balancer-l4', 'load-balancer-l7'];
const parse = value => new DOMParser().parseFromString(value, 'image/svg+xml');
const all = (node, tag) => Array.from(node.getElementsByTagName(tag));

test('architecture concepts have distinct offline symbols and searchable protocol/partition semantics', () => {
  const semantics = { sharding: ['shard key', 'database partition', 'hash range'], 'consistent-hashing': ['hash ring', 'consistent hashing', 'virtual nodes'], 'load-balancer-l4': ['L4', 'TCP UDP', 'transport IP ports'], 'load-balancer-l7': ['L7', 'HTTP HTTPS', 'request path headers'] };
  const drawings = new Set();
  for (const key of keys) {
    const item = catalog.getDiagramComponent(key), symbol = symbols.getArchitectureSymbol(key);
    assert.equal(item.id, key); assert.equal(item.role, key);
    assert.equal(item.iconName, undefined, 'Concept symbols must work without fetching Eraser artwork');
    assert.equal(item.brand, undefined, 'Concepts are not presented as vendor marks');
    assert.match(item.description, /Vendor-neutral/);
    assert.ok(symbol.primitives.length >= 5);
    drawings.add(JSON.stringify(symbol.primitives));
    for (const query of semantics[key]) assert.ok(catalog.searchDiagramComponents(query).some(item => item.id === key), `${query} finds ${key}`);
    for (const primitive of symbol.primitives) {
      assert.ok(['circle', 'ellipse', 'rect', 'path', 'text'].includes(primitive.tag));
      assert.ok(!Object.keys(primitive.attrs).some(key => /^on/i.test(key) || /href/i.test(key)));
    }
  }
  assert.equal(drawings.size, 4);
  assert.ok(symbols.getArchitectureSymbol('load-balancer-l4').primitives.some(p => p.text === 'L4'));
  assert.ok(symbols.getArchitectureSymbol('load-balancer-l7').primitives.some(p => p.text === 'L7'));
});

test('all four concepts, notes and connector identities survive board export/import', () => {
  const snapshot = emptySnapshot();
  snapshot.structured.nodes = keys.map((key, index) => {
    const node = makeNode('component', { x: index * 300, y: 100 }, key);
    return { ...node, id: key, style: { width: 240, height: 180 }, data: { ...node.data, name: catalog.getDiagramComponent(key).label, description: `Notes for ${key}: custom config <retained> & safe.`, replicas: 2 } };
  });
  snapshot.structured.edges = keys.slice(1).map((key, index) => ({ id: 'edge-' + key, source: keys[index], target: key, sourceHandle: 'right', targetHandle: 'left', type: 'relation', data: { relation: 'association', label: 'route', curvature: .3 } }));
  const board = { name: 'Architecture concepts', snapshot };
  const restored = parseBoardImport(exportBoard(board));
  assert.deepEqual(restored.snapshot.structured, snapshot.structured);
  for (const node of restored.snapshot.structured.nodes) assert.equal(catalog.getDiagramComponent(node.data.componentKey).id, node.data.componentKey);
});

test('React glyphs and dark/light SVG export use identical drawing primitives without network or card shells', async () => {
  const source = await readFile(new URL('../frontend/features/diagrams/DiagramNodes.jsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ exports: {}, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react-dom') return { createPortal: () => { throw new Error('Notes start closed'); } };
    if (name === '@xyflow/react') return { Handle: () => null, NodeResizer: () => null, Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' }, useUpdateNodeInternals: () => () => {} };
    if (name === './diagram-catalog.mjs') return catalog;
    if (name === './diagram-architecture-symbols.mjs') return symbols;
    if (name === './diagram-replicas.mjs') return replicas;
    if (name === './diagram-visuals.mjs') return visuals;
    if (name === './diagram-expanded-layout.mjs') return expandedLayout;
    if (name === './diagram-sequence.mjs') return sequence;
    if (name === './diagram-expanded-routing.mjs') return expandedRouting;
    if (name === './eraser-icon-assets.mjs') return { getCachedEraserIcon: () => { throw new Error('Offline concepts must not load icons'); }, isCachedEraserIconMonochrome: () => null, loadEraserIcon: () => { throw new Error('Network must not be used'); } };
    if (name === './useDiagramPopover') return { useDiagramPopover: () => () => {} };
    if (name.endsWith('.css')) return {};
    throw new Error('Unexpected import ' + name);
  } });
  vm.runInContext(compiled, context);
  for (const key of keys) {
    const component = catalog.getDiagramComponent(key);
    const data = { componentKey: key, name: component.label, description: 'On-demand design notes', replicas: 1 };
    const canvas = parse(renderToStaticMarkup(React.createElement(context.exports.ComponentNode, { id: key, data, width: 240, height: 180 })));
    const canvasSymbol = all(canvas, 'svg').find(node => node.getAttribute('data-architecture-symbol') === key);
    assert.ok(canvasSymbol);
    assert.equal(canvasSymbol.getAttribute('viewBox'), '0 0 48 48');
    assert.equal(canvasSymbol.getAttribute('width'), '64');
    assert.equal(all(canvas, 'img').length, 0);
    assert.equal(all(canvas, 'button').filter(node => node.getAttribute('aria-label') === 'Notes for ' + component.label).length, 1);
    assert.equal(all(canvas, 'textarea').filter(node => node.getAttribute('aria-label') === 'Component notes').length, 0, 'Notes do not inflate the node');
    const canvasPaths = all(canvasSymbol, 'path').map(node => node.getAttribute('d'));
    const inks = [];
    for (const theme of [{ background: '#111419', foreground: '#f2f4f7' }, { background: '#ffffff', foreground: '#15202b' }]) {
      const exported = parse(exportStructuredSvg({ nodes: [{ id: key, type: 'component', position: { x: 0, y: 0 }, style: { width: 240, height: 180 }, data }], edges: [] }, theme));
      const exportedSymbol = all(exported, 'g').find(node => node.getAttribute('data-architecture-symbol') === key);
      assert.ok(exportedSymbol);
      assert.deepEqual(all(exportedSymbol, 'path').map(node => node.getAttribute('d')), canvasPaths);
      assert.equal(all(exportedSymbol, 'rect').length, all(canvasSymbol, 'rect').length);
      assert.deepEqual(all(exportedSymbol, 'text').map(node => node.textContent), all(canvasSymbol, 'text').map(node => node.textContent));
      assert.equal(all(exported, 'image').length, 0);
      assert.equal(all(exported, 'foreignObject').length, 0);
      assert.ok(all(exported, 'g').some(node => node.getAttribute('data-component-notes') === 'true'));
      const ink = exportedSymbol.getAttribute('stroke');
      assert.notEqual(ink, theme.background); inks.push(ink);
    }
    assert.notEqual(inks[0], inks[1], `${key} receives the existing light-theme contrast adjustment`);
  }
});
