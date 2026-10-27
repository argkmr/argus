import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStructureCode } from '../frontend/features/diagrams/diagram-structure-parser.mjs';
import { countStructureEntries } from '../frontend/features/diagrams/diagram-structures.mjs';
import { cleanStructured, createDiagramHistory, duplicateSelection, emptySnapshot, exportBoard, parseBoardImport } from '../frontend/features/diagrams/diagram-model.mjs';
import { getStructureLayout } from '../frontend/features/diagrams/diagram-structure-layout.mjs';
import { exportStructuredSvg } from '../frontend/features/diagrams/diagram-svg.mjs';

const complex = 'Map<List<Integer>, Map<String, List<Deque<Set<int[]>>>>> topology = Map.of(List.of(1, 2), Map.of("shards", List.of(new ArrayDeque<>(List.of(Set.of(new int[]{7, 11}))))));';
const deepest = data => data.entries[0].valueContainer.entries[0].valueContainer.entries[0].valueContainer.entries[0].valueContainer.entries[0].valueContainer;
const ids = data => data.entries.flatMap(entry => [entry.id, ...(entry.keyContainer ? ids(entry.keyContainer) : []), ...(entry.valueContainer ? ids(entry.valueContainer) : [])]);

test('six nested collection levels plus a list-valued map key remain editable data through board workflows', () => {
  const data = parseStructureCode(complex, 'java').structures[0];
  assert.equal(countStructureEntries(data), 9);
  assert.deepEqual(data.entries[0].keyContainer.entries.map(row => row.value), ['1', '2']);
  assert.deepEqual(deepest(data).entries.map(row => row.value), ['7', '11']);
  const snapshot = emptySnapshot();
  snapshot.structured.nodes.push({ id: 'complex', type: 'dataStructure', position: { x: 0, y: 0 }, data });
  const loaded = parseBoardImport(exportBoard({ name: 'Nested regression', snapshot }));
  assert.deepEqual(loaded.snapshot.structured, snapshot.structured);
  const history = createDiagramHistory(snapshot.structured), changed = structuredClone(snapshot.structured);
  deepest(changed.nodes[0].data).entries[1].value = '13';
  history.push(cleanStructured(changed));
  assert.equal(deepest(history.undo().nodes[0].data).entries[1].value, '11');
  assert.equal(deepest(history.redo().nodes[0].data).entries[1].value, '13');
  const duplicate = duplicateSelection([{ ...changed.nodes[0], selected: true }], []).nodes[0];
  assert.equal(ids(duplicate.data).length, 9);
  assert.equal(ids(duplicate.data).filter(id => ids(data).includes(id)).length, 0);
  assert.equal(deepest(duplicate.data).entries[1].value, '13');
  const svg = exportStructuredSvg(changed);
  for (const kind of ['map', 'list', 'deque', 'set', 'array']) assert.ok(svg.includes(`data-structure-kind="${kind}"`));
  const layout = getStructureLayout(data);
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
  function check(parent) {
    for (const cell of parent.cells) {
      assert.ok(cell.x + cell.width <= parent.width && cell.y + cell.height <= parent.height);
      for (const child of [cell.keyContainer, cell.valueContainer].filter(Boolean)) {
        assert.ok(child.x >= cell.x && child.y >= cell.y);
        assert.ok(child.x + child.width <= cell.x + cell.width);
        assert.ok(child.y + child.height <= cell.y + cell.height);
        check(child.layout);
      }
    }
  }
  check(layout);
});
