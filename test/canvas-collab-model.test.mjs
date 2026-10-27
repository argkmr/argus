import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createBoardDoc, readBoardDoc, applyBoardChange, createLocalUndoManager, validateBoardDoc, REMOTE_ORIGIN } from '../frontend/features/diagrams/collaboration/board-doc.mjs';
import { emptySnapshot, makeNode } from '../frontend/features/diagrams/diagram-model.mjs';
import { createGroup, ungroup } from '../frontend/features/diagrams/diagram-groups.mjs';

const clone = value => structuredClone(value);
const board = () => ({ id: 'board-a', name: 'Team board', snapshot: { ...emptySnapshot(), structured: { nodes: [{ ...makeNode('umlClass'), id: 'class-a', data: { name: 'Order', fields: [{ id: 'field-a', text: 'id: UUID' }, { id: 'field-b', text: 'total: Money' }], methods: [{ id: 'method-a', text: 'save()' }] } }, { ...makeNode('note'), id: 'note-a' }], edges: [], viewport: { x: 10, y: 20, zoom: 2 } } } });
function replica(source) { const doc = createBoardDoc(); Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), REMOTE_ORIGIN); return doc; }
function merge(left, right) { const a = Y.encodeStateAsUpdate(left), b = Y.encodeStateAsUpdate(right); Y.applyUpdate(left, b, REMOTE_ORIGIN); Y.applyUpdate(right, a, REMOTE_ORIGIN); assert.deepEqual(readBoardDoc(left), readBoardDoc(right)); }
function edit(doc, change, origin = {}) { const old = readBoardDoc(doc), next = clone(old); change(next); applyBoardChange(doc, old, next, origin); }

test('manual arrow bends and independently moved labels survive peer synchronization',()=>{
  const source=board();source.snapshot.structured.edges=[{id:'route',source:'class-a',target:'note-a',type:'relation',data:{relation:'association',routing:'elbow',curvature:.3,label:'Flow',waypoints:[{x:300,y:50}],labelOffset:{x:0,y:0}}}];
  const left=createBoardDoc(source),right=replica(left);
  edit(left,value=>{value.snapshot.structured.edges[0].data.waypoints[0].y=-90;});
  edit(right,value=>{value.snapshot.structured.edges[0].data.labelOffset.y=-32;});merge(left,right);
  const result=readBoardDoc(left).snapshot.structured.edges[0].data;
  assert.equal(result.routing,'elbow');assert.deepEqual(result.waypoints,[{x:300,y:-90}]);assert.deepEqual(result.labelOffset,{x:0,y:-32});
});

test('group colors and component notes converge independently, and ungroup preserves shared contents', () => {
  const source=board();
  source.snapshot.structured=createGroup(source.snapshot.structured,['class-a','note-a'],{id:'group-a',name:'Shared persistence',color:'#71d99c'});
  const left=createBoardDoc(source),right=replica(left);
  edit(left,value=>{value.snapshot.structured.nodes.find(node=>node.id==='group-a').data.color='#ae9cff';});
  edit(right,value=>{value.snapshot.structured.nodes.find(node=>node.id==='note-a').data.description='Collaborator notes are preserved.';});
  merge(left,right);
  const shared=readBoardDoc(left).snapshot.structured;
  assert.deepEqual(shared.nodes.find(node=>node.id==='group-a').data.memberIds,['class-a','note-a']);
  assert.equal(shared.nodes.find(node=>node.id==='group-a').data.color,'#ae9cff');
  assert.equal(shared.nodes.find(node=>node.id==='note-a').data.description,'Collaborator notes are preserved.');
  edit(left,value=>{value.snapshot.structured=ungroup(value.snapshot.structured,'group-a');});
  merge(left,right);
  assert.deepEqual(readBoardDoc(left).snapshot.structured.nodes.map(node=>node.id),['class-a','note-a']);
  assert.equal(readBoardDoc(left).snapshot.structured.nodes[1].data.description,'Collaborator notes are preserved.');
});

test('shared document excludes personal state and preserves all stable IDs', () => {
  const source = board(); source.snapshot.structured.nodes[0].selected = true;
  source.snapshot.sketch = { elements: [{ id: 'shape-a', type: 'rectangle', x: 0, y: 0 }], files: {}, appState: { scrollX: 44, selectedElementIds: { 'shape-a': true } }, libraryItems: [{ id: 'private-library', elements: [] }] };
  const doc = createBoardDoc(source), result = readBoardDoc(doc);
  assert.deepEqual(result.snapshot.structured.viewport, { x: 0, y: 0, zoom: 1 });
  assert.equal(result.snapshot.structured.nodes[0].selected, undefined);
  assert.equal(result.snapshot.structured.nodes[0].data.fields[0].id, 'field-a');
  assert.deepEqual(result.snapshot.sketch.appState, {}); assert.deepEqual(result.snapshot.sketch.libraryItems, []);
  assert.equal(validateBoardDoc(doc).snapshot.structured.viewport, undefined);
  assert.equal(applyBoardChange(doc, source, { ...source, snapshot: { ...source.snapshot, structured: { ...source.snapshot.structured, viewport: { x: 999, y: 9, zoom: .5 } } } }, {}), false);
});

test('concurrent UML fields, node position and sibling edits converge without replacement', () => {
  const left = createBoardDoc(board()), right = replica(left);
  edit(left, value => { value.snapshot.structured.nodes[0].data.fields[0].text = 'id: Long'; value.snapshot.structured.nodes[0].position.x = 300; });
  edit(right, value => { value.snapshot.structured.nodes[0].data.fields[1].text = 'total: Decimal'; value.snapshot.structured.nodes[0].position.y = 400; value.snapshot.structured.nodes[1].data.name = 'Collaborator note'; });
  merge(left, right);
  const nodes = readBoardDoc(left).snapshot.structured.nodes;
  assert.deepEqual(nodes[0].data.fields.map(field => field.text), ['id: Long', 'total: Decimal']);
  assert.deepEqual(nodes[0].position, { x: 300, y: 400 }); assert.equal(nodes[1].data.name, 'Collaborator note');
});

test('recursive DSA rows and independently nested containers merge', () => {
  const source = board(), structure = makeNode('dataStructure'); structure.id = 'dsa';
  structure.data.entries = [{ id: 'outer', key: '', value: '', annotation: '', valueContainer: { ...makeNode('dataStructure').data, entries: [{ id: 'cell-a', key: '', value: '1', annotation: '' }, { id: 'cell-b', key: '', value: '2', annotation: '' }] } }];
  source.snapshot.structured.nodes.push(structure);
  const left = createBoardDoc(source), right = replica(left);
  edit(left, value => { value.snapshot.structured.nodes[2].data.entries[0].valueContainer.entries[0].value = '10'; });
  edit(right, value => { value.snapshot.structured.nodes[2].data.entries[0].valueContainer.entries[1].annotation = 'peer'; value.snapshot.structured.nodes[2].data.entries[0].annotation = 'outer peer'; });
  merge(left, right);
  const entry = readBoardDoc(left).snapshot.structured.nodes[2].data.entries[0];
  assert.equal(entry.valueContainer.entries[0].value, '10'); assert.equal(entry.valueContainer.entries[1].annotation, 'peer'); assert.equal(entry.annotation, 'outer peer');
});

test('concurrent insertion and reorder preserve IDs and converge', () => {
  const left = createBoardDoc(board()), right = replica(left);
  edit(left, value => { value.snapshot.structured.nodes[0].data.fields.unshift({ id: 'field-c', text: 'new field' }); });
  edit(right, value => { value.snapshot.structured.nodes[0].data.fields.push({ id: 'field-d', text: 'another field' }); value.snapshot.structured.nodes.reverse(); });
  merge(left, right);
  const nodes = readBoardDoc(left).snapshot.structured.nodes;
  assert.deepEqual(nodes.map(node => node.id), ['note-a', 'class-a']);
  assert.deepEqual(new Set(nodes[1].data.fields.map(field => field.id)), new Set(['field-a', 'field-b', 'field-c', 'field-d']));
});

test('concurrent delete and connection creation derives a graph with no dangling edges', () => {
  const left = createBoardDoc(board()), right = replica(left);
  edit(left, value => value.snapshot.structured.nodes.pop());
  edit(right, value => value.snapshot.structured.edges.push({ id: 'connection-a', source: 'class-a', target: 'note-a', data: { label: 'new' } }));
  merge(left, right);
  assert.equal(readBoardDoc(left).snapshot.structured.edges.length, 0);
});

test('recursive DSA deletion deterministically removes concurrently added links and pointers', () => {
  const source = board(), structure = makeNode('dataStructure', undefined, 'linked-list'); structure.id = 'dsa';
  structure.data.entries = [{ id: 'cell-a', key: '', value: '1', annotation: '' }, { id: 'cell-b', key: '', value: '2', annotation: '' }];
  source.snapshot.structured.nodes.push(structure);
  const left = createBoardDoc(source), right = replica(left);
  edit(left, value => value.snapshot.structured.nodes[2].data.entries.pop());
  edit(right, value => {
    value.snapshot.structured.nodes[2].data.links.push({ id: 'link', source: 'cell-a', target: 'cell-b', label: 'next' });
    value.snapshot.structured.nodes[2].data.pointers.push({ id: 'pointer', target: 'cell-b', label: 'tail' });
    value.snapshot.structured.nodes[2].data.activeEntryId = 'cell-b';
  });
  merge(left, right);
  const data = readBoardDoc(left).snapshot.structured.nodes[2].data;
  assert.deepEqual(data.links, []); assert.deepEqual(data.pointers, []); assert.equal(data.activeEntryId, '');
});

test('own-origin undo preserves collaborator changes', () => {
  const left = createBoardDoc(board()), right = replica(left), origin = {}, undo = createLocalUndoManager(left, origin);
  edit(left, value => { value.snapshot.structured.nodes[0].data.fields[0].text = 'local'; }, origin);
  edit(right, value => { value.snapshot.structured.nodes[0].data.fields[1].text = 'remote'; });
  merge(left, right); undo.undo();
  assert.deepEqual(readBoardDoc(left).snapshot.structured.nodes[0].data.fields.map(field => field.text), ['id: UUID', 'remote']);
  undo.redo(); assert.equal(readBoardDoc(left).snapshot.structured.nodes[0].data.fields[0].text, 'local');
});

test('Excalidraw elements and recursive point arrays merge granular edits', () => {
  const source = board(); source.snapshot.sketch.elements = [{ id: 'shape-a', type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] }, { id: 'shape-b', type: 'rectangle', x: 0, y: 0 }];
  const left = createBoardDoc(source), right = replica(left);
  edit(left, value => { value.snapshot.sketch.elements[0].points[0][0] = 5; });
  edit(right, value => { value.snapshot.sketch.elements[0].points[1][1] = 20; value.snapshot.sketch.elements[1].x = 200; });
  merge(left, right);
  const shapes = readBoardDoc(left).snapshot.sketch.elements;
  assert.deepEqual(shapes[0].points, [[5, 0], [10, 20]]); assert.equal(shapes[1].x, 200);
});

test('native Excalidraw optional undefined fields follow JSON persistence semantics', () => {
  const source = board();
  const nativeElement = {
    id: 'native-rectangle', type: 'rectangle', x: 148, y: 124, width: 180, height: 90, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
    index: undefined, roundness: { type: 3, value: undefined }, seed: 12345, version: 1,
    versionNonce: 1234, isDeleted: false, boundElements: null, updated: 1, link: null,
    locked: false, customData: undefined,
  };
  source.snapshot.sketch.elements = [nativeElement];
  const doc = createBoardDoc(source);
  assert.deepEqual(readBoardDoc(doc).snapshot.sketch.elements[0], JSON.parse(JSON.stringify(nativeElement)));
  const previous = readBoardDoc(doc), next = structuredClone(previous);
  next.snapshot.sketch.elements[0].customData = { optional: undefined, slots: [undefined, , 'value'] };
  applyBoardChange(doc, previous, next, {});
  assert.deepEqual(readBoardDoc(doc).snapshot.sketch.elements[0].customData, { slots: [null, null, 'value'] });
  for (const invalid of [NaN, Infinity, () => 'execute', Symbol('invalid'), 1n]) {
    const unsafe = board(); unsafe.snapshot.sketch.elements = [{ ...nativeElement, customData: { value: invalid } }];
    assert.throws(() => createBoardDoc(unsafe), /finite JSON data/);
  }
  const before = Y.encodeStateAsUpdate(doc), invalidEdit = structuredClone(readBoardDoc(doc));
  invalidEdit.name = 'Must not partially apply'; invalidEdit.snapshot.sketch.elements[0].customData = { callback() {} };
  assert.throws(() => applyBoardChange(doc, readBoardDoc(doc), invalidEdit, {}), /finite JSON data/);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
});

test('malformed IDs, remote images and unsupported shared fields are rejected', () => {
  const invalid = board(); delete invalid.snapshot.structured.nodes[0].data.fields[0].id;
  assert.throws(() => createBoardDoc(invalid), /stable IDs/);
  const image = board(); image.snapshot.sketch.files = { bad: { id: 'bad', mimeType: 'image/png', dataURL: 'https://example.com/image.png' } };
  assert.throws(() => createBoardDoc(image), /raster/);
  const doc = createBoardDoc(board());
  const snapshot = doc.getMap('board').get('snapshot').get('$object'); snapshot.set('appState', 'private');
  assert.throws(() => validateBoardDoc(doc), /unsupported, unsafe, or personal/);
});
