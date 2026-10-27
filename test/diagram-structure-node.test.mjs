import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as structures from '../frontend/features/diagrams/diagram-structures.mjs';
import * as geometry from '../frontend/features/diagrams/diagram-structure-layout.mjs';
import * as types from '../frontend/features/diagrams/diagram-structure-types.mjs';
import { parseStructureCode } from '../frontend/features/diagrams/diagram-structure-parser.mjs';

const require = createRequire(import.meta.url), React = require('react'), ts = require('typescript');
const source = await readFile(new URL('../frontend/features/diagrams/DiagramStructureNode.jsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function node(data, { selected = true, open = false, typeDraft } = {}) {
  const changes = [], states = []; let stateIndex = 0;
  const context = vm.createContext({ exports: {}, crypto: globalThis.crypto, require(name) {
    if (name === 'react') return { ...React, useContext: () => ({ updateNode: (...args) => changes.push(args) }), useEffect() {}, useId: () => `test-${stateIndex}`, useRef: () => ({ current: null }), useState: initial => { const index = stateIndex++; return [index === 0 ? open : index === 7 && typeDraft !== undefined ? typeDraft : initial, value => states.push({ index, value })]; } };
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@xyflow/react') return { Handle: () => null, NodeResizer: () => null, Position: { Top:'top', Right:'right', Bottom:'bottom', Left:'left' }, useUpdateNodeInternals: () => () => {} };
    if (name === './DiagramNodes') return { DiagramNodeActionsContext: {} };
    if (name === './diagram-structures.mjs') return structures;
    if (name === './diagram-structure-types.mjs') return types;
    if (name === './diagram-structure-layout.mjs') return geometry;
    if (name === './useDiagramPopover') return { useDiagramPopover: () => () => {} };
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected import ${name}`);
  }});
  vm.runInContext(compiled, context);
  const tree = context.exports.DataStructureNode.type({ id:'node', data, selected, isConnectable:true });
  const elements = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!React.isValidElement(value)) return;
    if (typeof value.type === 'function') return walk(value.type(value.props));
    if (typeof value.type?.render === 'function') return walk(value.type.render(value.props, null));
    if (typeof value.type?.type === 'function') return walk(value.type.type(value.props));
    elements.push(value); walk(value.props.children);
  };
  walk(tree);
  return { changes, states, elements, find: label => elements.find(element => element.props['aria-label'] === label) };
}
const event = extra => ({ stopPropagation() {}, ...extra });
const entries = count => Array.from({ length: count }, (_, index) => ({ id:`e${index}`, key:String(index), value:String(index * 2), annotation:'' }));

test('every structure renders initially empty with its compact add action and no permanent tools', () => {
  for (const kind of structures.STRUCTURE_KINDS) {
    const ui = node(structures.createStructureData(kind.id), { selected:false });
    assert.ok(ui.find('Add first unit'), kind.id);
    assert.ok(!ui.find('Data structure tools'), kind.id);
    ui.find('Add first unit').props.onClick(event());
    const [id, patch, history] = ui.changes.at(-1);
    assert.equal(id, 'node'); assert.equal(patch.entries.length, 1); assert.equal(history, '');
    assert.equal(patch.entries[0].annotation, '');
  }
});

test('removing a unit removes only its links, pointers, and active reference', () => {
  const data = { ...structures.createStructureData('graph'), entries:entries(3), activeEntryId:'e1', links:[{ id:'l1', source:'e0', target:'e1' }, { id:'l2', source:'e0', target:'e2' }], pointers:[{ id:'p1', label:'i', target:'e1' }, { id:'p2', label:'j', target:'e2' }] };
  const ui = node(data); ui.find('Remove unit 2').props.onClick(event());
  const [, patch, group] = ui.changes[0];
  assert.deepEqual(Array.from(patch.entries, entry => entry.id), ['e0', 'e2']);
  assert.deepEqual(Array.from(patch.links, link => link.id), ['l2']);
  assert.deepEqual(Array.from(patch.pointers, pointer => pointer.id), ['p2']);
  assert.equal(patch.activeEntryId, ''); assert.equal(group, '');
});

test('manual stepping uses separate undo entries; inline edits keep their edit group', () => {
  const data = { ...structures.createStructureData('array'), entries:entries(3), activeEntryId:'e1' };
  const ui = node(data);
  ui.find('Next dry-run unit').props.onClick(event()); assert.equal(ui.changes.at(-1)[1].activeEntryId, 'e2'); assert.equal(ui.changes.at(-1)[2], '');
  ui.find('Previous dry-run unit').props.onClick(event()); assert.equal(ui.changes.at(-1)[1].activeEntryId, 'e0');
  ui.find('Unit 1 value').props.onChange({ target:{ value:'updated' } }); assert.equal(ui.changes.at(-1)[1].entries[0].value, 'updated'); assert.equal(ui.changes.at(-1)[2], 'node:node');
});

test('editable cells stop canvas delete and drag events but allow Escape dismissal', () => {
  const ui = node({ ...structures.createStructureData('map'), entries:entries(1) });
  for (const element of ui.elements.filter(element => element.type === 'input')) {
    let calls = 0;
    element.props.onKeyDown({ key:'Delete', stopPropagation() { calls++; } });
    element.props.onPointerDown({ stopPropagation() { calls++; } });
    element.props.onKeyDown({ key:'Escape', stopPropagation() { calls++; } });
    assert.equal(calls, 2); assert.match(element.props.className, /nodrag nopan/);
  }
});

test('tools add graph links and pointers without reserving a permanent inspector', () => {
  const ui = node({ ...structures.createStructureData('graph'), entries:entries(2) }, { open:true });
  assert.ok(ui.find('Data structure tools')); assert.ok(ui.find('New pointer target')); assert.ok(ui.find('Link source'));
  ui.find('Add pointer').props.onClick(event()); assert.equal(ui.changes.at(-1)[1].pointers[0].target, 'e0'); assert.equal(ui.changes.at(-1)[2], '');
  ui.find('Add link').props.onClick(event()); assert.equal(ui.changes.at(-1)[1].links[0].target, 'e1'); assert.equal(ui.changes.at(-1)[2], '');
});

test('all geometry is bounded, disjoint, and finite up to the unit cap', () => {
  for (const kind of structures.STRUCTURE_KINDS) for (const count of [0, 1, 3, 17, 128]) {
    const data = { ...structures.createStructureData(kind.id), entries:entries(count), columns:16 };
    data.links = data.entries.slice(1).map((entry,index) => ({ id:`l${index}`, source:data.entries[Math.floor(index / 2)].id, target:entry.id }));
    const layout = geometry.getStructureLayout(data);
    assert.equal(layout.cells.length, count, kind.id);
    assert.ok(layout.width <= 2200 && layout.height <= 2200, `${kind.id} ${count}: ${layout.width}x${layout.height}`);
    for (const cell of layout.cells) {
      assert.ok(cell.x >= 0 && cell.y >= layout.headerHeight && cell.x + cell.width <= layout.width && cell.y + cell.height <= layout.height, kind.id);
      for (const other of layout.cells) if (cell.id !== other.id) assert.ok(cell.x + cell.width <= other.x || other.x + other.width <= cell.x || cell.y + cell.height <= other.y || other.y + other.height <= cell.y, `${kind.id} overlaps`);
    }
    for (const edge of layout.edges) assert.doesNotMatch(edge.path, /NaN|Infinity|undefined/);
    assert.deepEqual(geometry.getStructureSize(data), { width:layout.width, height:layout.height });
  }
});

test('same-target pointers aggregate without overlapping each other or the header', () => {
  const data = { ...structures.createStructureData('queue'), entries:entries(2), pointers:Array.from({ length:16 }, (_, index) => ({ id:`p${index}`, label:`i${index}`, target:'e0' })) };
  const layout = geometry.getStructureLayout(data);
  assert.equal(layout.pointers.length, 1); assert.match(layout.pointers[0].label, /i0, i1/);
  assert.ok(layout.pointers[0].labelY > layout.headerHeight + 20);
});

test('matrix geometry and labels preserve all sixteen columns', () => {
  const data = { ...structures.createStructureData('matrix'), entries:entries(17), columns:16 };
  const layout = geometry.getStructureLayout(data);
  assert.equal(layout.cells[15].y, layout.cells[0].y); assert.ok(layout.cells[16].y > layout.cells[0].y);
  const ui = node(data); const labels = ui.elements.filter(element => element.props.className === 'diagram-structure-index').map(element => element.props.children);
  assert.equal(labels[15], '0,15'); assert.equal(labels[16], '1,0');
});

test('parsed 128 by 1 matrices retain their logical row labels across visual blocks', () => {
  const parsed = parseStructureCode('int[][] grid = new int[128][1];', 'java').structures[0];
  const data = structures.cleanStructureData(parsed), layout = geometry.getStructureLayout(data);
  assert.equal(data.entries.length, 128); assert.equal(data.columns, 1);
  assert.deepEqual(geometry.getStructureSize(data), { width:792, height:1534 });
  assert.equal(layout.cells[0].y, layout.cells[16].y); assert.ok(layout.cells[16].x > layout.cells[0].x);
  const ui = node(data), labels = ui.elements.filter(element => element.props.className === 'diagram-structure-index').map(element => element.props.children);
  for (const index of [0,15,16,127]) assert.equal(labels[index], `${index},0`);
});

test('typed nested maps render actual editable map and list containers and grow them separately', () => {
  let data = types.applyStructureType({ ...structures.createStructureData('map'), name:'lookup' }, 'Map<String, Map<String, ArrayList<String>>>');
  let ui = node(data); ui.find('Add unit to lookup').props.onClick(event()); data = { ...data, ...ui.changes.at(-1)[1] };
  assert.equal(data.entries[0].valueContainer.structureKind, 'map'); assert.equal(data.entries[0].valueContainer.entries.length, 0);
  ui = node(data); ui.find('Add unit to lookup · unit 1 value').props.onClick(event()); data = { ...data, ...ui.changes.at(-1)[1] };
  assert.equal(data.entries[0].valueContainer.entries[0].valueContainer.structureKind, 'list');
  ui = node(data); ui.find('Add unit to lookup · unit 1 value · unit 1 value').props.onClick(event()); data = { ...data, ...ui.changes.at(-1)[1] };
  ui = node(data); ui.find('Unit 1 value in lookup · unit 1 value · unit 1 value').props.onChange({ target:{value:'dry-run value'} });
  data = { ...data, ...ui.changes.at(-1)[1] };
  assert.equal(data.entries[0].valueContainer.entries[0].valueContainer.entries[0].value, 'dry-run value');
  assert.equal(types.countStructureEntries(data), 3);
  ui = node(data); assert.equal(ui.elements.filter(element => element.props['data-structure-kind']).length, 3);
  assert.ok(ui.elements.some(element => element.props.className === 'diagram-structure-type-signature' && element.props.children === data.typeSignature));
  ui.find('Remove unit 1 in lookup · unit 1 value · unit 1 value').props.onClick(event());
  assert.equal(ui.changes.at(-1)[1].entries[0].valueContainer.entries[0].valueContainer.entries.length, 0);
  assert.equal(ui.changes.at(-1)[2], '');
});

test('nested keys are editable and aggregate unit limit applies at every depth', () => {
  let data = types.applyStructureType({ ...structures.createStructureData('map'), name:'lookup' }, 'Map<List<String>, String>');
  data.entries = [types.createStructureEntry(data)];
  data.entries[0].keyContainer.entries = entries(127);
  const ui = node(data), addButtons = ui.elements.filter(element => element.type === 'button' && element.props.title === 'Limit of 128 total units');
  assert.equal(addButtons.length, 2); assert.ok(addButtons.every(button => button.props.disabled));
  ui.find('Unit 1 value in lookup · unit 1 key').props.onChange({ target:{value:'key item'} });
  assert.equal(ui.changes.at(-1)[1].entries[0].keyContainer.entries[0].value, 'key item');
});

test('container type applies atomically on Enter, not on typing', () => {
  const data = { ...structures.createStructureData('map'), name:'lookup' };
  const ui = node(data, { open:true, typeDraft:'Map<String, List<String>>' });
  const input = ui.find('Container type'); input.props.onChange({ target:{value:'Map<String, List<String>>'} });
  assert.equal(ui.changes.length, 0);
  input.props.onKeyDown(event({key:'Enter', preventDefault() {}}));
  assert.equal(ui.changes.length, 1); assert.equal(ui.changes[0][1].typeSignature, 'Map<String, List<String>>'); assert.equal(ui.changes[0][2], '');
});

test('incompatible type apply preserves populated scalar values and keeps actionable error state', () => {
  const data = { ...structures.createStructureData('map'), entries:[{id:'entry',key:'old',value:'xyz',annotation:''}] };
  const before = JSON.stringify(data);
  const ui = node(data, { open:true, typeDraft:'Map<String, Map<String, List<String>>>' });
  ui.find('Container type').props.onKeyDown(event({key:'Enter',preventDefault(){}}));
  assert.equal(ui.changes.length, 0); assert.equal(JSON.stringify(data), before);
  assert.ok(ui.states.some(state => typeof state.value === 'string' && state.value.includes('existing text cannot be converted')));
});

test('legacy implementation labels are visibly unapplied and malformed schemas cannot crash Add', () => {
  const data = { ...structures.createStructureData('object'), implementation:'Map<String, List<String>>', entries:[{id:'old',key:'key',value:'xyz',annotation:''}] };
  const ui = node(data), label = ui.elements.find(element => element.props.className === 'diagram-structure-type-signature is-unapplied');
  assert.match(label.props.children, /^Label only/); assert.match(label.props.title, /apply this container type/);
  for (const implementation of ['Work', 'Map.of']) assert.ok(!node({...data,implementation}).elements.some(element => element.props.className === 'diagram-structure-type-signature is-unapplied'));
  const invalid = node({ ...structures.createStructureData('array'), typeSignature:'List<<>' });
  assert.doesNotThrow(() => invalid.find('Add first unit').props.onClick(event()));
  assert.equal(invalid.changes.length, 0); assert.ok(invalid.states.some(state => typeof state.value === 'string' && state.value.length));
});

test('primitive scalar containers cannot grow duplicate value cells and recover after removing their value', () => {
  let data = types.applyStructureType(structures.createStructureData('object'), 'int');
  let ui = node(data); assert.ok(ui.find('Scalar values use one unit').props.disabled);
  ui.find('Remove unit 1').props.onClick(event()); data = { ...data, ...ui.changes.at(-1)[1] };
  ui = node(data); ui.find('Add first unit').props.onClick(event());
  assert.equal(ui.changes.at(-1)[1].entries.length, 1); assert.equal(ui.changes.at(-1)[1].entries[0].key, 'value'); assert.equal(ui.changes.at(-1)[1].entries[0].annotation, 'int');
});
