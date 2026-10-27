import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { emptySnapshot, templateSnapshot } from '../frontend/features/diagrams/diagram-model.mjs';

const require = createRequire(import.meta.url), ts = require('typescript');
const source = await readFile(new URL('../frontend/features/diagrams/DiagramStudio.jsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('export function DiagramStudioView('), source.indexOf('\nexport function StructuredCanvas('));
const compiled = ts.transpileModule(component, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const board = (id, name = id, archived = false) => ({ id, name, archived, revision: 7, updatedAt: '2026-10-23T00:00:00Z', snapshot: emptySnapshot() });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

// Run only the real top-level view with inert React element/hook adapters.
// Store operations are synthetic: no browser, network, or saved board is touched.
function harness({ documents = [board('a', 'Alpha'), board('b', 'Beta'), board('c', 'Archived', true)], document = documents[0], remove, accepted = true } = {}) {
  const states = [], refs = [], reducers = [], calls = [], prompts = [], creations = [], errors = [];
  let stateIndex = 0, refIndex = 0, reducerIndex = 0, initialized = false;
  const store = {
    documents, document, busy: false, dirty: false, status: 'Saved locally', error: '',
    setError: message => errors.push(message),
    async remove(item) {
      calls.push(item);
      const result = remove ? await remove(item) : true;
      if (result) { store.documents = store.documents.filter(board => board.id !== item.id); if (store.document?.id === item.id) store.document = null; }
      return result;
    },
    async create(name, snapshot) { creations.push({ name, snapshot }); const created = board('new', name); created.snapshot = snapshot; store.document = created; store.documents = [...store.documents, created]; return created; },
    open() { assert.fail('selection must not open a board'); }, restore() { assert.fail('selection must not restore a board'); },
    change() { assert.fail('deletion must not edit a canvas'); }, flush: async () => {}, loadList: async () => {},
  };
  const context = vm.createContext({
    exports: {}, require: name => { assert.equal(name, 'react/jsx-runtime'); return require(name); },
    useState(initial) { const index = stateIndex++; if (!initialized) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef(initial) { const index = refIndex++; if (!initialized) refs[index] = { current: initial }; return refs[index]; },
    useReducer(reducer, initial) { const index = reducerIndex++; if (!initialized) reducers[index] = initial; return [reducers[index], action => { reducers[index] = reducer(reducers[index], action); }]; },
    useEffect() {},
    useDiagramCanvasScale: () => ({}),
    useDiagramPopover: (_open, setOpen) => () => setOpen(false),
    window: { confirm: prompt => { prompts.push(prompt); return accepted; } },
    emptySnapshot, templateSnapshot, StudioIcon: 'studio-icon', StructureGlyph: 'structure-glyph',
    StructuredCanvas: 'structured-canvas', Sketch: 'sketch-canvas', Suspense: 'suspense', ReactFlowProvider: 'flow-provider',
  });
  vm.runInContext(compiled, context);
  let tree;
  const render = () => { stateIndex = 0; refIndex = 0; reducerIndex = 0; tree = context.exports.DiagramStudioView({ store, headerActions: 'Sharing actions' }); initialized = true; return tree; };
  const find = predicate => nodes(tree).find(predicate);
  const button = name => find(node => node.type === 'button' && (node.props['aria-label'] === name || text(node) === name));
  const input = label => find(node => node.type === 'input' && node.props['aria-label'] === label);
  const click = name => { const node = button(name); assert.ok(node, `Missing button: ${name}`); assert.ok(!node.props.disabled, `Disabled button: ${name}`); const result = node.props.onClick(); render(); return result; };
  const check = (label, checked = true) => { const node = input(label); assert.ok(node, `Missing input: ${label}`); assert.ok(!node.props.disabled); node.props.onChange({ target: { checked } }); render(); };
  render();
  return { store, calls, prompts, creations, errors, render, find, button, input, click, check, text: () => text(tree),
    selectAll() { click('Boards'); click('Select boards'); check('Select all visible boards'); },
  };
}

test('bulk selection targets only visible filtered boards and asks once for both canvases', async () => {
  const h = harness({ documents: [board('a', 'Alpha'), board('b', 'Alpine'), board('c', 'Beta'), board('d', 'Alpha archive', true)] });
  h.click('Boards');
  h.input('Search saved boards').props.onChange({ target: { value: 'Al' } }); h.render();
  h.click('Select boards'); h.check('Select all visible boards');
  assert.match(h.text(), /2 selected/);
  h.click('Delete selected'); await settle(); h.render();
  assert.deepEqual(h.calls.map(item => item.id), ['a', 'b']);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /Permanently delete 2 selected boards/);
  assert.match(h.prompts[0], /Alpha\n• Alpine/);
  assert.match(h.prompts[0], /structured canvas and drawing/);
  assert.match(h.prompts[0], /cannot be undone/);
  assert.doesNotMatch(h.prompts[0], /Beta|Alpha archive/);
  assert.match(h.text(), /Deleted 2 boards permanently/);
  assert.deepEqual(h.store.documents.map(item => item.id), ['c', 'd']);
});

test('changing search or archive filter clears selection and never selects hidden boards', () => {
  const h = harness(); h.selectAll();
  h.input('Search saved boards').props.onChange({ target: { value: 'Alpha' } }); h.render();
  assert.match(h.text(), /0 selected/);
  assert.ok(h.button('Delete selected').props.disabled);
  h.check('Select all visible boards');
  assert.match(h.text(), /1 selected/);
  h.click('Archived');
  assert.match(h.text(), /0 selected/);
  assert.ok(h.button('Delete selected').props.disabled);
  h.input('Search saved boards').props.onChange({ target: { value: '' } }); h.render();
  h.check('Select all visible boards');
  assert.equal(h.input('Select board Archived').props.checked, true);
  assert.equal(h.input('Select board Alpha'), undefined);
});

test('canceling bulk confirmation makes no store call and keeps selection for review', async () => {
  const h = harness({ accepted: false }); h.selectAll(); h.click('Delete selected'); await settle(); h.render();
  assert.equal(h.calls.length, 0);
  assert.equal(h.prompts.length, 1);
  assert.match(h.text(), /2 selected/);
  assert.equal(h.button('Delete selected').props.disabled, false);
  h.click('Cancel');
  assert.ok(h.button('Select boards'));
  assert.equal(h.input('Select board Alpha'), undefined);
});

test('archived bulk deletion keeps active boards and passes the original revision to the store', async () => {
  const h = harness(); h.click('Boards'); h.click('Archived'); h.click('Select boards'); h.check('Select all visible boards');
  h.click('Delete selected'); await settle(); h.render();
  assert.deepEqual(h.calls.map(({ id, archived, revision }) => ({ id, archived, revision })), [{ id: 'c', archived: true, revision: 7 }]);
  assert.equal(h.store.document.id, 'a');
  assert.deepEqual(h.store.documents.map(item => item.id), ['a', 'b']);
  assert.match(h.prompts[0], /Permanently delete 1 selected board/);
});

test('bulk confirmation uses the latest unsaved name for the current board', async () => {
  const current = board('a', 'Latest edited name');
  const h = harness({ document: current, accepted: false }); h.selectAll(); h.click('Delete selected'); await settle();
  assert.match(h.prompts[0], /Latest edited name/);
  assert.doesNotMatch(h.prompts[0], /Alpha/);
  assert.equal(h.calls.length, 0);
});

test('bulk deletion is sequential, reentry-proof and freezes navigation and editing', async () => {
  const pending = [];
  const h = harness({ remove: () => new Promise(resolve => pending.push(resolve)) }); h.selectAll();
  const handler = h.button('Delete selected').props.onClick;
  handler(); handler(); h.render();
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.calls.map(item => item.id), ['a']);
  for (const name of ['Delete selected', 'Cancel', 'New', 'Close boards', 'Import board', 'Export board', 'Archive board', 'Structured', 'Draw · Excalidraw']) assert.ok(h.button(name).props.disabled, name);
  assert.ok(h.input('Search saved boards').props.disabled);
  assert.ok(h.input('Select all visible boards').props.disabled);
  assert.ok(h.input('Board name').props.disabled);
  assert.equal(h.find(node => node.props?.className === 'diagram-header-actions-lock').props.inert, true);
  assert.equal(h.find(node => node.props?.className === 'diagram-mode-surface').props.inert, true);
  pending[0](true); await settle(); h.render();
  assert.deepEqual(h.calls.map(item => item.id), ['a', 'b']);
  assert.equal(h.button('Delete selected').props.disabled, true, 'entire batch remains frozen between store calls');
  pending[1](true); await settle(); h.render();
  assert.match(h.text(), /Deleted 2 boards permanently/);
  assert.equal(h.button('Draw · Excalidraw').props.disabled, false);
});

test('first failure stops the batch and retains failed and unattempted selections', async () => {
  const h = harness({ documents: [board('a', 'Alpha'), board('b', 'Beta'), board('c', 'Gamma')], remove: item => item.id !== 'b' });
  h.selectAll(); h.click('Delete selected'); await settle(); h.render();
  assert.deepEqual(h.calls.map(item => item.id), ['a', 'b']);
  assert.equal(h.input('Select board Alpha'), undefined);
  assert.equal(h.input('Select board Beta').props.checked, true);
  assert.equal(h.input('Select board Gamma').props.checked, true);
  assert.match(h.text(), /1 of 3 deleted\. Stopped at “Beta”\. 2 still selected/);
  assert.doesNotMatch(h.text(), /Deleted 3 boards/);
});

test('a throwing store operation stops safely and reports no unconfirmed deletion', async () => {
  const h = harness({ remove: () => { throw new Error('Revision conflict'); } }); h.selectAll(); h.click('Delete selected'); await settle(); h.render();
  assert.deepEqual(h.calls.map(item => item.id), ['a']);
  assert.deepEqual(h.errors, ['Revision conflict']);
  assert.match(h.text(), /0 of 2 deleted/);
  assert.equal(h.input('Select board Alpha').props.checked, true);
  assert.equal(h.input('Select board Beta').props.checked, true);
});

test('Draw mode hides structured templates and creates an empty drawing without switching mode', async () => {
  const h = harness({ documents: [], document: null });
  h.click('Draw · Excalidraw');
  assert.match(h.text(), /New drawing/);
  assert.doesNotMatch(h.text(), /Class diagrams|Sequence diagrams|System architecture/);
  h.click('Boards');
  assert.equal(h.find(node => node.props?.className === 'diagram-template-actions'), undefined);
  const create = h.find(node => node.type === 'button' && node.props.className === 'diagram-new');
  await create.props.onClick(); h.render();
  assert.equal(h.creations.length, 1);
  assert.equal(h.creations[0].name, 'Untitled drawing');
  assert.deepEqual(h.creations[0].snapshot, emptySnapshot());
  assert.equal(h.button('Draw · Excalidraw').props['aria-pressed'], true);
  assert.ok(h.find(node => node.type === 'sketch-canvas'));
  h.click('Structured');
  assert.equal(h.button('Structured').props['aria-pressed'], true);
  h.click('Boards');
  assert.ok(h.find(node => node.props?.className === 'diagram-template-actions'));
});

test('switching canvas mode keeps both existing snapshots and preserves useState order', () => {
  const current = board('both'); current.snapshot.structured = templateSnapshot('class').structured;
  current.snapshot.sketch.elements = [{ id: 'drawing-shape', type: 'rectangle' }];
  const before = structuredClone(current);
  const h = harness({ documents: [current], document: current });
  h.click('Draw · Excalidraw'); h.click('Structured');
  assert.deepEqual(h.store.document, before);
  assert.equal((component.match(/useState\(/g) || []).length, 6, 'existing layout fixtures use the established state positions');
});
