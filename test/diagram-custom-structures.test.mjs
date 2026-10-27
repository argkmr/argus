import test from 'node:test';
import assert from 'node:assert/strict';
import { tryParseCustomStructureCode as parse } from '../frontend/features/diagrams/diagram-custom-structure-parser.mjs';
import { createStructureEntry } from '../frontend/features/diagrams/diagram-structure-types.mjs';

test('custom Java class and record fields retain nested container schemas without inventing values', () => {
  for (const source of [
    'class Work { private String name; Map<String, Map<String, ArrayList<String>>> groups; int counts[]; }',
    'public record Work(String name, Map<String, Map<String, ArrayList<String>>> groups, int[] counts) {}',
  ]) {
    const result = parse(source, 'java'), data = result.structures[0];
    assert.equal(data.name, 'Work'); assert.deepEqual(data.entries.map(row => row.key), ['name', 'groups', 'counts']);
    assert.equal(data.entries[0].value, ''); assert.equal(data.entries[0].annotation, 'String');
    const groups = data.entries[1].valueContainer;
    assert.equal(groups.structureKind, 'map'); assert.deepEqual(groups.entries, []);
    const map = createStructureEntry(groups).valueContainer;
    assert.equal(map.structureKind, 'map'); assert.equal(createStructureEntry(map).valueContainer.structureKind, 'list');
    assert.equal(data.entries[2].valueContainer.structureKind, 'array');
    assert.ok(result.warnings[0].includes('not executed'));
  }
});

test('Python annotated classes and TypeScript interfaces preserve known field shapes', () => {
  const python = parse('@dataclass\nclass Work:\n    name: str\n    groups: dict[str, list[int]]', 'python').structures[0];
  assert.deepEqual(python.entries.map(row => row.key), ['name', 'groups']);
  assert.equal(python.entries[1].valueContainer.typeSignature, 'dict[str, list[int]]');
  const ts = parse('export interface Work { name: string; groups: Map<string, Array<number>>; }', 'javascript').structures[0];
  assert.equal(ts.entries[1].valueContainer.typeSignature, 'Map<string, Array<number>>');
  assert.equal(parse('const x = new Map();'), null);
});

test('custom fields fail visibly rather than skipping methods, runtime initialization or unknown shapes', () => {
  for (const source of [
    'class Work { String name = load(); }',
    'class Work { String getName() { return secret(); } }',
    'class Work { User owner; }',
    'class Work { List<User> owners; }',
    'class Work { String name; String name; }',
    'class Work extends Base { String name; }',
    'class Work { unknown; }',
    'class Work:\n    name: str\noutside: int',
    'class Work:\n    pass\noutside: int',
    'class Work:\n    name: str\n        nested: int',
    `class ${'W'.repeat(241)} { String name; }`,
    `class Work { String ${'f'.repeat(501)}; }`,
  ]) assert.throws(() => parse(source));
});
