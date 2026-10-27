import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOARD_FORMAT, MAX_IMPORT_BYTES, cleanStructured, createDiagramHistory,
  duplicateSelection, emptySnapshot, exportBoard, makeNode, parseBoardImport, templateSnapshot,
} from '../frontend/features/diagrams/diagram-model.mjs';
import { getSelfLoopGeometry } from '../frontend/features/diagrams/diagram-edge-geometry.mjs';

const graphOf = (...nodes) => ({ nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } });

test('all templates provide valid, independent structured graphs and fresh member identities', () => {
  const expected = { blank: [0, 0], class: [2, 1], sequence: [3, 4], hld: [5, 4] };
  const seen = new Set();
  for (const [kind, [nodeCount, edgeCount]] of Object.entries(expected)) {
    for (let iteration = 0; iteration < 2; iteration++) {
      const snapshot = templateSnapshot(kind);
      const graph = cleanStructured(snapshot.structured);
      assert.equal(graph.nodes.length, nodeCount);
      assert.equal(graph.edges.length, edgeCount);
      assert.deepEqual(snapshot.sketch.elements, []);
      for (const node of graph.nodes) {
        assert.ok(!seen.has(node.id)); seen.add(node.id);
        for (const member of [...node.data.fields || [], ...node.data.methods || []]) {
          assert.ok(!seen.has(member.id)); seen.add(member.id);
        }
      }
      for (const edge of graph.edges) {
        assert.ok(graph.nodes.some(node => node.id === edge.source));
        assert.ok(graph.nodes.some(node => node.id === edge.target));
        if (kind === 'sequence') assert.equal(edge.sourceHandle.slice(2), edge.targetHandle.slice(2));
      }
    }
  }
  const first = emptySnapshot(), second = emptySnapshot();
  first.sketch.elements.push({ id: 'one' });
  assert.equal(second.sketch.elements.length, 0);
});

test('board export/import preserves separate structured and sketch content', () => {
  const snapshot = templateSnapshot('hld');
  snapshot.sketch = { elements: [{ id: 'rectangle', type: 'rectangle', x: 4, y: 7 }], appState: { viewBackgroundColor: '#ffffff' }, files: { asset: { id: 'asset', mimeType: 'image/png', created: 0, dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V0kAAAAASUVORK5CYII=' } }, libraryItems: [{ id: 'library', elements: [] }] };
  const exported = exportBoard({ name: '订单 & architecture', snapshot });
  const raw = JSON.parse(exported);
  assert.equal(raw.format, BOARD_FORMAT);
  assert.equal(raw.schemaVersion, 1);
  const imported = parseBoardImport(exported);
  assert.equal(imported.name, '订单 & architecture');
  assert.equal(imported.mode, 'structured');
  assert.deepEqual(imported.snapshot.structured, cleanStructured(snapshot.structured));
  assert.deepEqual(imported.snapshot.sketch, snapshot.sketch);
  imported.snapshot.sketch.elements[0].x = 99;
  assert.equal(snapshot.sketch.elements[0].x, 4);
});

test('native Excalidraw import creates an independent sketch canvas', () => {
  const source = { type: 'excalidraw', elements: [{ id: 'shape', type: 'rectangle' }], appState: { gridSize: 16 }, files: {} };
  const imported = parseBoardImport(JSON.stringify(source));
  assert.equal(imported.mode, 'sketch');
  assert.deepEqual(imported.snapshot.structured.nodes, []);
  assert.deepEqual(imported.snapshot.sketch.elements, source.elements);
  assert.deepEqual(imported.snapshot.sketch.appState, source.appState);
  assert.deepEqual(imported.snapshot.sketch.libraryItems, []);
});

test('untrusted imports reject invalid formats, endpoints, IDs, and oversized scenes', () => {
  assert.throws(() => parseBoardImport('{'), /valid.*JSON/i);
  assert.throws(() => parseBoardImport('null'), /Unsupported/);
  assert.throws(() => parseBoardImport(JSON.stringify({ format: BOARD_FORMAT, schemaVersion: 99, snapshot: emptySnapshot() })), /format or version/);
  const malformed = { format: BOARD_FORMAT, schemaVersion: 1, snapshot: emptySnapshot() };
  malformed.snapshot.sketch.files = [];
  assert.throws(() => parseBoardImport(JSON.stringify(malformed)), /sketch data/);
  assert.throws(() => cleanStructured({ nodes: Array(2001).fill({}), edges: [] }), /2,000/);
  assert.throws(() => cleanStructured({ nodes: [], edges: Array(5001).fill({}) }), /5,000/);
  assert.throws(() => parseBoardImport(JSON.stringify({ type: 'excalidraw', elements: Array(10001).fill({}) })), /oversized/);
  assert.throws(() => parseBoardImport('"' + '😀'.repeat(Math.ceil(MAX_IMPORT_BYTES / 4)) + '"'), /10 MB/);
  const node = makeNode('component');
  assert.throws(() => cleanStructured(graphOf(node, node)), /unique/);
  assert.throws(() => cleanStructured(graphOf({ ...node, type: 'executable' })), /unsupported/);
  assert.throws(() => cleanStructured({ ...graphOf(node), edges: [{ id: 'edge', source: node.id, target: 'missing' }] }), /valid endpoints/);
  const edge = { id: 'edge', source: node.id, target: node.id };
  assert.throws(() => cleanStructured({ ...graphOf(node), edges: [edge, edge] }), /unique/);
});

test('board import accepts exactly 10 MB of UTF-8 and rejects the next byte', () => {
  assert.equal(MAX_IMPORT_BYTES, 10_000_000);
  const json = exportBoard({ name: 'Diagram 漢😀', snapshot: emptySnapshot() });
  const exact = json + ' '.repeat(MAX_IMPORT_BYTES - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(exact), MAX_IMPORT_BYTES);
  assert.equal(parseBoardImport(exact).name, 'Diagram 漢😀');
  assert.throws(() => parseBoardImport(exact + ' '), /10 MB/);
});

test('near-limit saved-board envelopes round-trip beyond the former 9.5 MB import cap', () => {
  const snapshot = templateSnapshot('class');
  snapshot.sketch.elements = [{ id: 'large-text', type: 'text', text: '漢😀'.repeat(1_420_000) }];
  const document = { id: 'd9113698-fd93-4b9f-9216-5bd9e7d21ed0', name: 'Near-limit saved board', revision: 99, schemaVersion: 1,
    createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', archived: false, snapshot };
  // This conservative, fully indented stored envelope includes all metadata.
  const storedBytes = Buffer.byteLength(JSON.stringify(document, null, 2));
  assert.ok(storedBytes > 9_500_000 && storedBytes <= MAX_IMPORT_BYTES);
  const exported = exportBoard(document);
  assert.ok(Buffer.byteLength(exported) <= MAX_IMPORT_BYTES);
  const imported = parseBoardImport(exported);
  assert.deepEqual(imported.snapshot.structured, cleanStructured(snapshot.structured));
  assert.equal(imported.snapshot.sketch.elements[0].text, snapshot.sketch.elements[0].text);
});

test('near-limit exports compact excessive indentation without losing either canvas', () => {
  const snapshot = templateSnapshot('sequence');
  snapshot.sketch.elements = Array.from({ length: 1000 }, (_, index) => ({ id: `shape-${index}`, type: 'rectangle', customData: { payload: '' } }));
  const document = { name: 'Dense metadata', snapshot };
  const value = { format: BOARD_FORMAT, schemaVersion: 1, name: document.name, snapshot: { ...snapshot, structured: cleanStructured(snapshot.structured) } };
  const remaining = MAX_IMPORT_BYTES - 20_000 - Buffer.byteLength(JSON.stringify(value));
  const repeated = Math.floor(remaining / snapshot.sketch.elements.length);
  snapshot.sketch.elements.forEach((element, index) => { element.customData.payload = 'x'.repeat(repeated + (index < remaining % snapshot.sketch.elements.length ? 1 : 0)); });
  assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2)) > MAX_IMPORT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < MAX_IMPORT_BYTES);
  const exported = exportBoard(document);
  assert.equal(exported, JSON.stringify(value));
  assert.deepEqual(parseBoardImport(exported).snapshot, value.snapshot);
});

test('duplicate and clipboard paste refuse the edge budget before mutating the graph', () => {
  const source = readFileSync(new URL('../frontend/features/diagrams/DiagramStudio.jsx', import.meta.url), 'utf8');
  const duplicateBody = source.match(/  function duplicate\(fromClipboard=false\) \{([\s\S]*?)\n  \}\n  function add/)[1];
  const invoke = new Function('duplicateSelection', 'graphRef', 'clipboard', 'onError', 'publish', 'fromClipboard', duplicateBody);
  const graph = edgeCount => {
    const nodes = [makeNode('component'), makeNode('component')].map(node => ({ ...node, selected: true }));
    return { nodes, edges: Array.from({ length: edgeCount }, (_, index) => ({ id: `edge-${index}`, source: nodes[0].id, target: nodes[1].id, data: { label: '' } })) };
  };
  for (const [existing, copied, fromClipboard] of [[2501, 2501, false], [4999, 2, true]]) {
    const current = graph(existing), before = structuredClone(current), errors = [], published = [];
    invoke(duplicateSelection, { current }, { current: graph(copied) }, message => errors.push(message), next => published.push(next), fromClipboard);
    assert.deepEqual(errors, ['The board connection limit is 5,000.']);
    assert.deepEqual(published, []);
    assert.deepEqual(current, before);
  }
  const current = graph(2500), errors = [], published = [];
  invoke(duplicateSelection, { current }, { current: null }, message => errors.push(message), next => published.push(next), false);
  assert.deepEqual(errors, []);
  assert.equal(published[0].edges.length, 5000);
  assert.equal(published[0].nodes.length, 4);
  assert.doesNotThrow(() => cleanStructured(published[0]));
});

test('sanitization bounds graph data, removes executable fields, and repairs duplicate class member IDs', () => {
  const node = makeNode('umlClass', { x: Infinity, y: 2_000_000 });
  node.data.fields = [{ id: 'same', text: 'field one' }, { id: 'same', text: 'field two' }, { text: 'field three' }];
  node.data.methods = [{ id: 'same', text: 'method one' }, { id: '', text: 'method two' }];
  node.data.extra = { execute: 'alert(1)' };
  node.data.name = 'x'.repeat(1000);
  node.onClick = 'alert(1)';
  const clean = cleanStructured({ ...graphOf(node), viewport: { x: Infinity, y: 20, zoom: 999 }, edges: [{ id: 'edge', source: node.id, target: node.id, data: { relation: 'execute', curvature: 999, label: 'z'.repeat(1000) } }] });
  const result = clean.nodes[0];
  const members = [...result.data.fields, ...result.data.methods];
  assert.equal(new Set(members.map(member => member.id)).size, members.length);
  assert.deepEqual(members.map(member => member.text), ['field one', 'field two', 'field three', 'method one', 'method two']);
  assert.equal(result.data.name.length, 240);
  assert.equal(Object.hasOwn(result, 'onClick'), false);
  assert.equal(Object.hasOwn(result.data, 'extra'), false);
  assert.deepEqual(result.position, { x: 0, y: 0 });
  assert.equal(clean.viewport.zoom, 3);
  assert.equal(clean.edges[0].data.relation, 'association');
  assert.equal(clean.edges[0].data.curvature, 1.2);
  assert.equal(clean.edges[0].data.label.length, 500);
  node.data.fields = Array.from({ length: 110 }, (_, index) => ({ id: `f${index}`, text: 'x'.repeat(2100) }));
  const limited = cleanStructured(graphOf(node)).nodes[0];
  assert.equal(limited.data.fields.length, 100);
  assert.equal(limited.data.fields[0].text.length, 2000);
});

test('React Flow resized dimensions survive sanitizing and board round-trips', () => {
  const node = { ...makeNode('component'), width: 420, height: 260, measured: { width: 420, height: 260 }, selected: true, dragging: true };
  const clean = cleanStructured(graphOf(node));
  assert.equal(clean.nodes[0].style.width, 420);
  assert.equal(clean.nodes[0].style.height, 260);
  assert.equal(Object.hasOwn(clean.nodes[0], 'selected'), false);
  assert.equal(Object.hasOwn(clean.nodes[0], 'dragging'), false);
  const snapshot = emptySnapshot(); snapshot.structured = clean;
  const imported = parseBoardImport(exportBoard({ name: 'Resized', snapshot }));
  assert.equal(imported.snapshot.structured.nodes[0].style.width, 420);
  assert.equal(imported.snapshot.structured.nodes[0].style.height, 260);
  const explicit = cleanStructured(graphOf({ ...makeNode('component'), style: { width: 350, height: 180 } })).nodes[0];
  assert.equal(explicit.style.width, 350);
  assert.equal(explicit.style.height, 180);
});

test('node dimensions cannot undersize member compartments or sequence message handles', () => {
  const classNode = makeNode('umlClass');
  classNode.data.fields = Array.from({ length: 15 }, (_, index) => ({ id: `f-${index}`, text: `field${index}` }));
  classNode.style = { width: 10, height: 10 };
  const participant = { ...makeNode('participant'), style: { width: 10, height: 10 }, data: { name: 'Actor', role: '', lifelineHeight: 1 } };
  const [cleanClass, cleanParticipant] = cleanStructured(graphOf(classNode, participant)).nodes;
  assert.ok(cleanClass.style.width >= 260);
  assert.ok(cleanClass.style.height >= 146 + 15 * 28 + 28);
  assert.ok(cleanParticipant.style.height >= 550);
  assert.ok(cleanParticipant.data.lifelineHeight >= 476);
});

test('duplicate selection remaps only internal edges, all member IDs, positions and mutable content', () => {
  const source = templateSnapshot('class').structured;
  source.nodes.forEach(node => { node.selected = true; node.style = { width: 360, height: 320 }; });
  const outside = makeNode('component');
  source.nodes.push(outside);
  source.edges.push({ id: 'outside', source: source.nodes[0].id, target: outside.id, data: { label: 'external' } });
  const duplicate = duplicateSelection(source.nodes, source.edges, 48);
  assert.equal(duplicate.nodes.length, 2);
  assert.equal(duplicate.edges.length, 1);
  assert.equal(duplicate.edges[0].source, duplicate.nodes[0].id);
  assert.equal(duplicate.edges[0].target, duplicate.nodes[1].id);
  assert.notEqual(duplicate.edges[0].id, source.edges[0].id);
  assert.equal(duplicate.edges[0].selected, false);
  const originalIds = new Set(source.nodes.flatMap(node => [node.id, ...node.data.fields?.map(member => member.id) || [], ...node.data.methods?.map(member => member.id) || []]));
  for (const [index, copied] of duplicate.nodes.entries()) {
    assert.ok(copied.selected);
    assert.ok(!originalIds.has(copied.id));
    assert.equal(copied.position.x, source.nodes[index].position.x + 48);
    assert.equal(copied.position.y, source.nodes[index].position.y + 48);
    assert.deepEqual(copied.style, source.nodes[index].style);
    for (const member of [...copied.data.fields, ...copied.data.methods]) assert.ok(!originalIds.has(member.id));
  }
  duplicate.nodes[0].data.fields[0].text = 'edited copy';
  duplicate.nodes[0].style.width = 800;
  assert.notEqual(source.nodes[0].data.fields[0].text, 'edited copy');
  assert.equal(source.nodes[0].style.width, 360);
  assert.deepEqual(duplicateSelection([outside], []), { nodes: [], edges: [] });
});

test('history groups continuous edits, expires groups, and clears redo on divergent work', context => {
  let now = 1000;
  context.mock.method(Date, 'now', () => now);
  const initial = { value: 0 }, history = createDiagramHistory(initial);
  initial.value = 99;
  assert.equal(history.canUndo, false);
  assert.equal(history.push({ value: 1 }, 'name'), true);
  now += 400;
  history.push({ value: 2 }, 'name');
  assert.deepEqual(history.undo(), { value: 0 });
  assert.deepEqual(history.redo(), { value: 2 });
  now += 800;
  history.push({ value: 3 }, 'name');
  assert.deepEqual(history.undo(), { value: 2 });
  assert.equal(history.canRedo, true);
  assert.equal(history.push({ value: 2 }), false);
  assert.equal(history.canRedo, true);
  history.push({ value: 4 });
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(), null);
  const prior = history.undo(); prior.value = -1;
  assert.deepEqual(history.redo(), { value: 4 });
});

test('history limits retained entries and memory without changing the current state', () => {
  const history = createDiagramHistory({ value: 0 }, { maxEntries: 2 });
  history.push({ value: 1 }); history.push({ value: 2 }); history.push({ value: 3 });
  assert.deepEqual(history.undo(), { value: 2 });
  assert.deepEqual(history.undo(), { value: 1 });
  assert.equal(history.undo(), null);
  assert.deepEqual(history.redo(), { value: 2 });
  const small = createDiagramHistory({ value: 'x'.repeat(100) }, { maxCharacters: 30 });
  small.push({ value: 1 });
  assert.equal(small.canUndo, false);
  small.push({ value: 2 });
  assert.deepEqual(small.undo(), { value: 1 });
});

test('self-loop geometry terminates at exact handles on either side and same-row loops remain visible', () => {
  const right = getSelfLoopGeometry({ sourceX: 204, sourceY: 128, targetX: 204, targetY: 212, sequence: true });
  assert.match(right.path, /V 212 H 204$/);
  assert.deepEqual(right.controls.at(-1), { x: 204, y: 212 });
  const left = getSelfLoopGeometry({ sourceX: 196, sourceY: 128, targetX: 196, targetY: 212, sourcePosition: 'left', sequence: true });
  assert.ok(left.controls[1].x < 196);
  assert.match(left.path, /V 212 H 196$/);
  const same = getSelfLoopGeometry({ sourceX: 204, sourceY: 128, targetX: 204, targetY: 128, sequence: true });
  assert.match(same.path, /C .*204 128$/);
  assert.deepEqual(same.controls.at(-1), { x: 204, y: 128 });
  const top = getSelfLoopGeometry({ sourceX: 100, sourceY: 0, targetX: 120, targetY: 0, sourcePosition: 'top' });
  assert.ok(top.controls[1].y < 0);
  assert.deepEqual(top.controls.at(-1), { x: 120, y: 0 });
});
