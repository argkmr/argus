import test from 'node:test';
import assert from 'node:assert/strict';
import { getStructureLayout, getStructureSize } from '../frontend/features/diagrams/diagram-structure-layout.mjs';

const row = (id, value = '', more = {}) => ({ id, key: id, value, ...more });
const container = (structureKind, entries = [], more = {}) => ({ name: structureKind, structureKind, entries, ...more });
const list = entries => container('list', entries, { typeSignature: 'ArrayList<String>' });
const nestedMap = () => container('map', [
  row('outer', '', { valueContainer: container('map', [row('inner', '', { valueContainer: list([row('a', 'one'), row('b', 'two')]) })], { typeSignature: 'Map<String, ArrayList<String>>' }) }),
  row('empty', '', { valueContainer: container('map', [], { typeSignature: 'Map<String, ArrayList<String>>' }) }),
], { typeSignature: 'Map<String, Map<String, ArrayList<String>>>' });

function assertBounds(layout) {
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
  for (const cell of layout.cells) {
    assert.ok(cell.x >= 0 && cell.y >= layout.headerHeight);
    assert.ok(cell.x + cell.width <= layout.width && cell.y + cell.height <= layout.height);
    for (const field of ['keyContainer', 'valueContainer']) if (cell[field]) {
      const child = cell[field];
      assert.ok(child.x >= cell.x && child.y >= cell.y, field);
      assert.ok(child.x + child.width <= cell.x + cell.width, field);
      assert.ok(child.y + child.height <= cell.y + cell.height, field);
      assert.equal(child.width, child.layout.width); assert.equal(child.height, child.layout.height);
      assert.equal(child.layout.headerHeight, 36);
      assertBounds(child.layout);
    }
  }
  for (let first = 0; first < layout.cells.length; first++) for (let second = first + 1; second < layout.cells.length; second++) {
    const a = layout.cells[first], b = layout.cells[second];
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'Sibling cells must not overlap');
  }
}

test('Map→Map→List geometry retains each actual nested container and type', () => {
  const data = nestedMap(), layout = getStructureLayout(data);
  assertBounds(layout);
  assert.equal(layout.shape, 'table'); assert.equal(layout.headerHeight, 48);
  const inner = layout.cells[0].valueContainer, leaf = inner.layout.cells[0].valueContainer;
  assert.equal(inner.layout.shape, 'table'); assert.equal(leaf.layout.shape, 'cells');
  assert.equal(leaf.layout.cells.length, 2);
  assert.equal(leaf.layout.typeLabel, 'ArrayList<String>');
  assert.equal(layout.cells[1].valueContainer.layout.cells.length, 0);
  assert.deepEqual(getStructureSize(data), { width: layout.width, height: layout.height });
  assert.ok(layout.width < 900, 'Three containers should remain a compact composition');
});

test('every family reflows nested values without flattening topology or overflowing', () => {
  const kinds = ['array', 'list', 'matrix', 'stack', 'queue', 'deque', 'map', 'set', 'linked-list', 'doubly-linked-list', 'circular-list', 'tree', 'bst', 'heap', 'trie', 'graph', 'union-find', 'bitset', 'object'];
  for (const kind of kinds) {
    const entries = Array.from({ length: 18 }, (_, index) => row(`e${index}`, '', { valueContainer: list(Array.from({ length: index % 3 }, (_, unit) => row(`v${index}-${unit}`, `${unit}`))) }));
    const data = container(kind, entries, { columns: 4, links: [{ source: 'e0', target: 'e1', label: 'next' }, { source: 'e1', target: 'e1', label: 'loop' }], pointers: [{ id: 'p', label: 'current', target: 'e1' }] });
    const layout = getStructureLayout(data); assertBounds(layout);
    assert.equal(layout.cells.length, 18, kind);
    assert.ok(layout.cells.every(cell => cell.valueContainer), kind);
    assert.ok(layout.edges.every(edge => !/NaN|undefined/.test(edge.path)), kind);
    assert.equal(layout.pointers[0].labelX, layout.cells.find(cell => cell.id === 'e1').x + layout.cells.find(cell => cell.id === 'e1').width / 2);
    for (const decoration of layout.decorations) assert.ok(decoration.x + decoration.width <= layout.width && decoration.y + decoration.height <= layout.height, kind);
  }
});

test('map keys and values can independently contain empty or populated containers', () => {
  const data = container('map', [row('both', '', { keyContainer: container('queue', []), valueContainer: nestedMap() }), row('scalar', 'kept')]);
  const layout = getStructureLayout(data); assertBounds(layout);
  const cell = layout.cells[0];
  assert.ok(cell.keyContainer.x + cell.keyContainer.width < cell.valueContainer.x);
  assert.equal(cell.keyWidth, layout.cells[1].keyWidth);
  assert.equal(cell.width, layout.cells[1].width);
});

test('direct layout handles cyclic and oversized input with finite bounded recursion', () => {
  const data = container('map', []); data.entries.push(row('cycle', '', { valueContainer: data }));
  const layout = getStructureLayout(data); assertBounds(layout);
  assert.equal(layout.cells[0].valueContainer.layout.truncated, true);
  const oversized = container('list', Array.from({ length: 500 }, (_, index) => row(`e${index}`, '', { valueContainer: list([row(`c${index}`, 'x')]) })));
  let count = 0;
  function visit(current) { count += current.cells.length; for (const cell of current.cells) for (const key of ['keyContainer', 'valueContainer']) if (cell[key]) visit(cell[key].layout); }
  visit(getStructureLayout(oversized)); assert.ok(count <= 128);
});
