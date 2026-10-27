import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDiagramElements, deleteDiagramSelection, isDiagramShortcutTarget } from '../frontend/features/diagrams/diagram-selection.mjs';
import { templateSnapshot, createDiagramHistory, cleanStructured } from '../frontend/features/diagrams/diagram-model.mjs';

const node = (id, type = 'component', selected = false, data = {}) => ({ id, type, selected, position: { x: 10, y: 20 }, data: { name: id, ...data } });
const edge = (id, source, target, selected = false) => ({ id, source, target, selected, data: { label: id, relation: 'association' } });
const graph = (nodes = [], edges = []) => ({ nodes, edges, viewport: { x: 23, y: 45, zoom: .75 } });
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

test('selection and clearing are immutable local state and repeated operations are no-ops', () => {
  const original = freeze(graph([node('a'), node('b')], [edge('ab', 'a', 'b')]));
  const selected = selectDiagramElements(original);
  assert.notEqual(selected, original);
  assert.equal(selected.viewport, original.viewport);
  assert.ok(selected.nodes.every(item => item.selected));
  assert.ok(selected.edges.every(item => item.selected));
  assert.equal(selected.nodes[0].data, original.nodes[0].data);
  assert.equal(selected.nodes[0].position, original.nodes[0].position);
  assert.equal(selectDiagramElements(selected), selected);
  assert.ok(original.nodes.every(item => !item.selected));
  const cleared = selectDiagramElements(freeze(selected), false);
  assert.ok([...cleared.nodes, ...cleared.edges].every(item => item.selected === false));
  assert.equal(selectDiagramElements(cleared, false), cleared);
  assert.equal(deleteDiagramSelection(original), original);
  const empty = freeze(graph());
  assert.equal(selectDiagramElements(empty), empty);
  assert.equal(selectDiagramElements(empty, false), empty);
  assert.equal(deleteDiagramSelection(empty), empty);
});

test('select all honors explicitly unselectable runtime objects while Escape clears everything', () => {
  const original = graph([
    node('a'),
    { ...node('locked', 'note'), selectable: false, selected: true },
  ], [{ ...edge('a-locked', 'a', 'locked'), selectable: false }]);
  const selected = selectDiagramElements(freeze(original));
  assert.deepEqual(selected.nodes.map(item => item.selected), [true, false]);
  assert.equal(selected.edges[0].selected, false);
  const cleared = selectDiagramElements(selected, false);
  assert.ok([...cleared.nodes, ...cleared.edges].every(item => !item.selected));
});

test('partial deletion removes selected nodes, selected edges, and incident edges exactly once', () => {
  const original = freeze(graph(
    [node('a', 'component', true), node('b', 'note'), node('c', 'umlClass')],
    [edge('ab', 'a', 'b'), edge('ca', 'c', 'a'), edge('aa', 'a', 'a', true), edge('bc', 'b', 'c', true), edge('cb', 'c', 'b')],
  ));
  const result = deleteDiagramSelection(original);
  assert.deepEqual(result.nodes.map(item => item.id), ['b', 'c']);
  assert.deepEqual(result.edges.map(item => item.id), ['cb']);
  assert.equal(result.viewport, original.viewport);
  assert.equal(result.nodes[0], original.nodes[1]);
  assert.equal(original.nodes.length, 3);
  assert.equal(original.edges.length, 5);
  assert.equal(deleteDiagramSelection(result), result);
});

test('edge-only selection deletes no objects and leaves other connections intact', () => {
  const original = freeze(graph([node('a'), node('b')], [edge('ab', 'a', 'b', true), edge('ba', 'b', 'a')]));
  const result = deleteDiagramSelection(original);
  assert.equal(result.nodes, original.nodes);
  assert.deepEqual(result.edges.map(item => item.id), ['ba']);
  assert.equal(result.edges[0], original.edges[1]);
});

test('deleting a frame preserves unselected nested contents and cleans dangling memberships', () => {
  const original = freeze(graph([
    node('outer', 'group', false, { color: '#74a7ff', memberIds: ['frame', 'keep'] }),
    node('frame', 'group', true, { color: '#71d99c', memberIds: ['nested', 'child'] }),
    node('nested', 'group', false, { color: '#ae9cff', memberIds: ['grandchild'] }),
    node('child'), node('grandchild', 'dataStructure'), node('keep', 'participant'),
  ], [edge('child-grandchild', 'child', 'grandchild'), edge('frame-keep', 'frame', 'keep')]));
  const result = deleteDiagramSelection(original);
  assert.deepEqual(result.nodes.map(item => item.id), ['outer', 'nested', 'child', 'grandchild', 'keep']);
  assert.deepEqual(result.nodes.find(item => item.id === 'outer').data.memberIds, ['keep']);
  assert.deepEqual(result.nodes.find(item => item.id === 'nested').data.memberIds, ['grandchild']);
  assert.deepEqual(result.edges.map(item => item.id), ['child-grandchild']);
  assert.deepEqual(original.nodes[0].data.memberIds, ['frame', 'keep']);
});

test('deleting a selected frame member does not delete the frame or its unselected siblings', () => {
  const original = freeze(graph([
    node('frame', 'group', false, { color: '#74a7ff', memberIds: ['a', 'b'] }),
    node('a', 'note', true), node('b'),
  ]));
  const result = deleteDiagramSelection(original);
  assert.deepEqual(result.nodes.map(item => item.id), ['frame', 'b']);
  assert.deepEqual(result.nodes[0].data.memberIds, ['b']);
});

test('whole selection supports every diagram template and one undo restores the complete graph', () => {
  for (const kind of ['class', 'sequence', 'hld', 'dsa']) {
    const original = cleanStructured(templateSnapshot(kind).structured);
    const history = createDiagramHistory(original);
    const selected = selectDiagramElements(freeze(original));
    assert.ok(selected.nodes.every(item => item.selected), kind);
    assert.ok(selected.edges.every(item => item.selected), kind);
    assert.equal(history.canUndo, false, 'selection creates no history entry');
    const deleted = cleanStructured(deleteDiagramSelection(selected));
    assert.equal(deleted.nodes.length, 0, kind);
    assert.equal(deleted.edges.length, 0, kind);
    assert.equal(history.push(deleted), true);
    assert.deepEqual(history.undo(), original, kind);
    assert.equal(history.canUndo, false, 'one undo restores the entire deletion');
    assert.deepEqual(history.redo(), deleted, kind);
  }
});

function shortcutFixture({ outside = false, blocked = false, hidden = false, editable = false } = {}) {
  const target = { isContentEditable: editable, closest: selector => blocked && selector.includes('[role="dialog"]') ? {} : null };
  const root = { contains: item => item === target && !outside, closest: () => hidden ? {} : null };
  return { event: { target, defaultPrevented: false, isComposing: false, nativeEvent: {} }, root };
}

test('canvas shortcuts accept contained plain targets but never portal or outside targets', () => {
  const inside = shortcutFixture();
  assert.equal(isDiagramShortcutTarget(inside.event, inside.root), true);
  const portal = shortcutFixture({ outside: true });
  assert.equal(isDiagramShortcutTarget(portal.event, portal.root), false);
  assert.equal(isDiagramShortcutTarget(inside.event, null), false);
  assert.equal(isDiagramShortcutTarget({ target: null }, inside.root), false);
  assert.equal(isDiagramShortcutTarget({}, {}), false);
});

test('canvas shortcuts defer to editing controls, dialogs, inert surfaces, and IME composition', () => {
  for (const options of [{ blocked: true }, { hidden: true }, { editable: true }]) {
    const fixture = shortcutFixture(options);
    assert.equal(isDiagramShortcutTarget(fixture.event, fixture.root), false);
  }
  for (const patch of [{ defaultPrevented: true }, { isComposing: true }, { nativeEvent: { isComposing: true } }]) {
    const fixture = shortcutFixture();
    assert.equal(isDiagramShortcutTarget({ ...fixture.event, ...patch }, fixture.root), false);
  }
  const fixture = shortcutFixture();
  for (const selector of ['input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]', '[role="dialog"]', '[role="alertdialog"]', '.nokey', '.diagram-edge-inspector', '[data-diagram-shortcuts-ignore]']) {
    fixture.event.target.closest = actual => actual.includes(selector) ? {} : null;
    assert.equal(isDiagramShortcutTarget(fixture.event, fixture.root), false, selector);
  }
});
