import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanStructureData, createStructureData, getStructureSize } from '../frontend/features/diagrams/diagram-structures.mjs';
import { cleanStructured, createDiagramHistory, emptySnapshot, uid } from '../frontend/features/diagrams/diagram-model.mjs';

test('real React code picker cancels stale previews, adds current data and emits local drag payloads', { timeout: 40_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'argus-structure-picker-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./fixtures/diagram-structure-picker-electron.cjs', import.meta.url)), temporary], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const capture = chunk => { output = (output + chunk).slice(-20_000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 35_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/DIAGRAM_PICKER_RESULT=(.+)/)?.[1] || '{}');
    assert.equal(result.ok, true); assert.equal(result.networkRequests, 0); assert.equal(result.assertions, 14);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

function studioAddHarness({ readOnly = false, expandedNotes = false } = {}) {
  const source = readFileSync(new URL('../frontend/features/diagrams/DiagramStudio.jsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  function addStructures('), source.indexOf('  function align('));
  const graphRef = { current: emptySnapshot().structured }, history = createDiagramHistory(graphRef.current), errors = [], closes = [], centers = [];
  let focus = 0;
  const flow = { screenToFlowPosition: point => point, getNodes: () => graphRef.current.nodes, getZoom: () => 1.2, setCenter: (...args) => centers.push(args) };
  const root = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }), closest: () => ({ focus: () => focus++ }) };
  const getNodesBounds = () => ({ x: 100, y: 120, width: 400, height: 300 });
  const publish = value => { history.push(cleanStructured(value)); graphRef.current = value; };
  const make = new Function('graphRef', 'flowRoot', 'flow', 'getNodesBounds', 'cleanStructureData', 'getStructureSize', 'uid', 'publish', 'closePalette', 'onError', 'STRUCTURE_DRAG_TYPE', 'readOnly', 'expandedNotes', `const DIAGRAM_ITEM_DRAG_TYPE='application/x-argus-diagram-item'; ${body}; return {addStructures,dropStructure};`);
  const handlers = make(graphRef, { current: root }, flow, getNodesBounds, cleanStructureData, getStructureSize, uid, publish, value => closes.push(value), error => errors.push(error), 'application/x-argus-data-structure', readOnly, expandedNotes);
  return { ...handlers, graphRef, history, errors, closes, centers, focused: () => focus };
}

test('Studio insertion closes the palette, avoids overlap, keeps explicit drops and makes separate undo entries', () => {
  const h = studioAddHarness();
  h.addStructures([createStructureData('array')]);
  assert.equal(h.graphRef.current.nodes.length, 1); assert.equal(h.focused(), 1); assert.deepEqual(h.closes, [false]);
  h.addStructures([createStructureData('map')]);
  assert.equal(h.graphRef.current.nodes.length, 2); assert.equal(h.graphRef.current.nodes[1].position.x, 548);
  assert.equal(h.graphRef.current.nodes[0].selected, false); assert.equal(h.centers.length, 2);
  const payload = JSON.stringify(createStructureData('queue'));
  let prevented = false;
  h.dropStructure({ dataTransfer: { types: ['application/x-argus-data-structure'], getData: () => payload }, clientX: 900, clientY: 700, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.deepEqual(h.graphRef.current.nodes[2].position, { x: 780, y: 630 }); assert.equal(h.centers.length, 2);
  assert.equal(h.history.undo().nodes.length, 2); assert.equal(h.history.undo().nodes.length, 1); assert.equal(h.history.undo().nodes.length, 0);
  assert.deepEqual(h.errors, []);
});

test('Studio rejects invalid drag JSON and board budgets without modifying the canvas', () => {
  const h = studioAddHarness();
  for (const raw of ['{', 'x'.repeat(200001)]) h.dropStructure({ dataTransfer: { types: ['application/x-argus-data-structure'], getData: () => raw }, clientX: 10, clientY: 10, preventDefault() {} });
  assert.equal(h.graphRef.current.nodes.length, 0); assert.equal(h.errors.length, 2); assert.equal(h.closes.length, 0);
  h.addStructures(Array.from({ length: 21 }, () => createStructureData('array'))); assert.match(h.errors.at(-1), /20 containers/);
  h.graphRef.current.nodes = Array.from({ length: 2000 }, () => ({})); h.addStructures([createStructureData('array')]); assert.match(h.errors.at(-1), /2,000/);
});

test('read-only and expanded reading views block structure insertion and drops', () => {
  for (const options of [{ readOnly: true }, { expandedNotes: true }]) {
    const h = studioAddHarness(options);
    let prevented = false;
    h.addStructures([createStructureData('array')]);
    h.dropStructure({ dataTransfer: { types: ['application/x-argus-data-structure'], getData: () => JSON.stringify(createStructureData('array')) }, clientX: 10, clientY: 20, preventDefault: () => { prevented = true; } });
    assert.equal(h.graphRef.current.nodes.length, 0);
    assert.equal(prevented, false);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.closes, []);
  }
});

test('resized data-structure nodes grow with edited content and preserve separately undoable actions', () => {
  const source = readFileSync(new URL('../frontend/features/diagrams/DiagramStudio.jsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  const updateNode='), source.indexOf('  const updateEdge='));
  const graphRef = { current: { ...emptySnapshot().structured, nodes: [{ id: 'a', type: 'dataStructure', position: { x: 0, y: 0 }, data: createStructureData('map'), width: 320, height: 144, style: { width: 320, height: 144 } }] } };
  const history = createDiagramHistory(graphRef.current), groups = [];
  const publish = (next, group) => { history.push(cleanStructured(next), group); groups.push(group); graphRef.current = next; };
  const update = new Function('publish', 'graphRef', 'getStructureSize', `${body};return updateNode;`)(publish, graphRef, getStructureSize);
  const entries = Array.from({ length: 128 }, (_, index) => ({ id: `e${index}`, key: String(index), value: 'value', annotation: '' }));
  update('a', { entries }, '');
  const node = graphRef.current.nodes[0], size = getStructureSize(node.data);
  assert.ok(node.width >= size.width); assert.ok(node.height >= size.height); assert.equal(node.width, node.style.width); assert.equal(node.height, node.style.height);
  update('a', { activeEntryId: 'e0' }, ''); update('a', { activeEntryId: 'e1' }, '');
  assert.deepEqual(groups, ['', '', '']);
  assert.equal(history.undo().nodes[0].data.activeEntryId, 'e0'); assert.equal(history.undo().nodes[0].data.activeEntryId, ''); assert.equal(history.undo().nodes[0].data.entries.length, 0);
});

test('PNG exports omit transient data-structure tools and steppers but retain cells', () => {
  const source = readFileSync(new URL('../frontend/features/diagrams/DiagramStudio.jsx', import.meta.url), 'utf8');
  const expression = source.match(/filter:(node=>[^\n]+?)\}\);/)[1];
  const filter = new Function(`return (${expression});`)();
  const matches = selector => ({ classList: { contains: () => false }, matches: candidate => candidate.split(',').includes(selector) });
  assert.equal(filter(matches('.diagram-structure-tools')), false); assert.equal(filter(matches('.diagram-structure-stepper')), false); assert.equal(filter(matches('.diagram-structure-inline-error')), false); assert.equal(filter(matches('button')), false); assert.equal(filter(matches('.diagram-structure-cell')), true);
});
