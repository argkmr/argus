import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STRUCTURE_KINDS, createStructureData, cleanStructureData, duplicateStructureData, getStructureSize, MAX_STRUCTURE_ENTRIES, MAX_STRUCTURE_LINKS, MAX_STRUCTURE_POINTERS } from '../frontend/features/diagrams/diagram-structures.mjs';
import { parseStructureCode } from '../frontend/features/diagrams/diagram-structure-parser.mjs';
import { cleanStructured, duplicateSelection, emptySnapshot, exportBoard, makeNode, parseBoardImport, templateSnapshot } from '../frontend/features/diagrams/diagram-model.mjs';
const parse = (source, language) => parseStructureCode(source, language).structures;
const values = data => data.entries.map(entry => entry.value);
const row = (id, value = id) => ({ id, key: '', value, annotation: '' });

test('every structure starts empty, has bounded geometry, and offers a custom object fallback', () => {
  assert.equal(STRUCTURE_KINDS.length, 19);
  assert.equal(new Set(STRUCTURE_KINDS.map(item => item.id)).size, 19);
  for (const kind of STRUCTURE_KINDS) {
    const data = createStructureData(kind.id);
    assert.deepEqual(data.entries, []); assert.deepEqual(data.links, []); assert.deepEqual(data.pointers, []);
    assert.equal(data.activeEntryId, ''); assert.equal(data.structureKind, kind.id);
    assert.deepEqual(cleanStructureData(data), data);
    const size = getStructureSize(data); assert.ok(size.width >= 320); assert.ok(size.height >= 100);
    data.entries = Array.from({ length: 128 }, (_, index) => row(`e${index}`));
    const full = getStructureSize(data); assert.ok(Number.isFinite(full.width) && full.width <= 2400); assert.ok(Number.isFinite(full.height) && full.height <= 6400);
  }
  assert.throws(() => createStructureData('exec'), /supported/);
  assert.equal(cleanStructureData({ structureKind: 'custom unsafe' }).structureKind, 'object');
});

test('structure sanitizer bounds all arrays and strings, deduplicates IDs and drops invalid references', () => {
  const data = cleanStructureData({ ...createStructureData('graph'), name: 'x'.repeat(1000), description: 'x'.repeat(5000), implementation: 'x'.repeat(500), columns: 99,
    entries: Array.from({ length: 140 }, (_, index) => ({ ...row(index < 2 ? 'same' : `e${index}`), value: 'v'.repeat(2200), key: 'k'.repeat(600), annotation: 'n'.repeat(600), execute: 'no' })),
    links: Array.from({ length: 280 }, () => ({ id: 'same', source: 'same', target: 'e2', label: 'l'.repeat(500) })),
    pointers: Array.from({ length: 30 }, () => ({ id: 'same', target: 'e2', label: 'p'.repeat(500) })), activeEntryId: 'missing', onChange: () => {},
  });
  assert.equal(data.entries.length, MAX_STRUCTURE_ENTRIES); assert.equal(data.links.length, MAX_STRUCTURE_LINKS); assert.equal(data.pointers.length, MAX_STRUCTURE_POINTERS);
  const ids = [...data.entries, ...data.links, ...data.pointers].map(item => item.id); assert.equal(new Set(ids).size, ids.length);
  assert.equal(data.name.length, 240); assert.equal(data.description.length, 4000); assert.equal(data.implementation.length, 120); assert.equal(data.columns, 16);
  assert.equal(data.entries[0].value.length, 2000); assert.equal(data.entries[0].key.length, 500); assert.equal(data.entries[0].annotation.length, 500);
  assert.equal(data.links[0].label.length, 240); assert.equal(data.pointers[0].label.length, 120); assert.equal(data.activeEntryId, '');
  assert.equal(Object.hasOwn(data, 'onChange'), false); assert.equal(Object.hasOwn(data.entries[0], 'execute'), false);
  const invalid = cleanStructureData({ ...createStructureData('graph'), entries: [row('a')], links: [{ id: 'l', source: 'a', target: 'missing' }], pointers: [{ id: 'p', target: 'missing' }] });
  assert.deepEqual(invalid.links, []); assert.deepEqual(invalid.pointers, []);
});

test('duplicate structures remap entries, internal connections, pointers, highlights, and board connections', () => {
  const node = makeNode('dataStructure', { x: 10, y: 20 }, 'graph'); node.selected = true;
  Object.assign(node.data, { entries: [row('a'), row('b')], links: [{ id: 'l', source: 'a', target: 'b', label: 'edge' }], pointers: [{ id: 'p', label: 'current', target: 'b' }], activeEntryId: 'a' });
  const data = duplicateStructureData(node.data);
  assert.notEqual(data.entries[0].id, 'a'); assert.equal(data.links[0].source, data.entries[0].id); assert.equal(data.links[0].target, data.entries[1].id);
  assert.equal(data.pointers[0].target, data.entries[1].id); assert.equal(data.activeEntryId, data.entries[0].id);
  const copied = duplicateSelection([node], [{ id: 'outer', source: node.id, target: node.id }]);
  assert.equal(copied.edges[0].source, copied.nodes[0].id); assert.notEqual(copied.nodes[0].data.entries[0].id, 'a');
  copied.nodes[0].data.entries[0].value = 'new'; assert.equal(node.data.entries[0].value, 'a');
});

test('structures survive canvas serialization, export/import, independent templates and content growth', () => {
  const node = makeNode('dataStructure', { x: 10, y: 20 }, 'map'); node.data.entries = [row('a')];
  const snapshot = emptySnapshot(); snapshot.structured.nodes = [node];
  const document = parseBoardImport(exportBoard({ name: 'Dry run', snapshot }));
  assert.deepEqual(document.snapshot.structured.nodes[0].data, node.data);
  node.data.entries = Array.from({ length: 128 }, (_, index) => row(`e${index}`)); node.style = { width: 1, height: 1 };
  const saved = cleanStructured({ ...snapshot.structured, nodes: [node] }).nodes[0];
  const size = getStructureSize(node.data); assert.ok(saved.style.width >= size.width); assert.ok(saved.style.height >= size.height);
  const a = templateSnapshot('dsa'), b = templateSnapshot('dsa'); assert.equal(a.structured.nodes[0].type, 'dataStructure'); assert.equal(a.structured.nodes[0].data.entries.length, 0); assert.notEqual(a.structured.nodes[0].id, b.structured.nodes[0].id);
});

test('HLD replica counts survive model roundtrip and stay within safe bounds', () => {
  for (const [input, expected] of [[undefined, 1], [0, 1], [3.9, 3], [1e8, 1000], [NaN, 1]]) {
    const node = makeNode('component'); node.data.replicas = input;
    assert.equal(cleanStructured({ nodes: [node], edges: [] }).nodes[0].data.replicas, expected);
  }
});

test('Java collection interfaces, concurrent and immutable aliases resolve into empty editable containers', () => {
  const samples = { ArrayList: 'list', LinkedList: 'doubly-linked-list', ArrayDeque: 'deque', PriorityQueue: 'heap', HashMap: 'map', TreeMap: 'map', HashSet: 'set', TreeSet: 'set', ConcurrentHashMap: 'map', ConcurrentLinkedQueue: 'queue', LinkedBlockingDeque: 'deque', CopyOnWriteArrayList: 'list', ImmutableList: 'list', BitSet: 'bitset' };
  for (const [type, kind] of Object.entries(samples)) {
    const generic = kind === 'map' ? '<String,Integer>' : kind === 'bitset' ? '' : '<String>';
    const [data] = parse(`${type}${generic} items;`, 'java'); assert.equal(data.structureKind, kind, type); assert.equal(data.entries.length, 0);
  }
  const [queue] = parse('Queue<String> jobs = new LinkedList<>();', 'java'); assert.equal(queue.structureKind, 'queue');
  const [capacity] = parse('ArrayList<Integer> a = new ArrayList<>(32);', 'java'); assert.equal(capacity.entries.length, 0);
  assert.throws(() => parse('TreeNode root = new TreeNode(1);', 'java'), /runtime constructor arguments/);
});

test('Java literals, factories, wrappers, multiline generics and comments are read without running code', () => {
  const result = parseStructureCode(`import java.util.*;
    // This is an ordinary declaration, not a program.
    final Map<
      String, List<Integer>
    > lookup = new HashMap<>(Map.of("a", List.of(1, 2), "b", List.of(3)));
    List<String> names =
      new ArrayList<>(Arrays.asList("left ] right", "comma, value", "/* text */", "semi;colon"));
    Set<Integer> unique = Collections.unmodifiableSet(Set.of(1, 2, 1));
    Map<String, Integer> entries = Map.ofEntries(Map.entry("x", 1), Map.entry("y", 2));`, 'java');
  assert.deepEqual(result.structures[0].entries.map(item => [item.key, item.value, values(item.valueContainer)]), [['a', '', ['1', '2']], ['b', '', ['3']]]);
  assert.deepEqual(values(result.structures[1]), ['left ] right', 'comma, value', '/* text */', 'semi;colon']);
  assert.deepEqual(values(result.structures[2]), ['1', '2']); assert.deepEqual(values(result.structures[3]), ['1', '2']);
  assert.ok(result.warnings.some(item => item.includes('immutability'))); assert.ok(result.warnings.some(item => item.includes('no modules')));
});

test('Java arrays support empty declarations, initializer syntax, primitive defaults, and rectangular matrices', () => {
  assert.deepEqual(values(parse('int[] nums;', 'java')[0]), []);
  assert.deepEqual(values(parse('int nums[] = {};', 'java')[0]), []);
  assert.deepEqual(values(parse('int[] nums = new int[]{1, -2, 0xff, 10L};', 'java')[0]), ['1', '-2', '0xff', '10']);
  assert.deepEqual(values(parse('boolean[] flags = new boolean[3];', 'java')[0]), ['false', 'false', 'false']);
  assert.deepEqual(values(parse('Integer[] flags = new Integer[2];', 'java')[0]), ['null', 'null']);
  const [matrix] = parse('int[][] grid = new int[][]{{1,2},{3,4}};', 'java'); assert.equal(matrix.structureKind, 'matrix'); assert.equal(matrix.columns, 2); assert.deepEqual(values(matrix), ['1', '2', '3', '4']);
  assert.equal(parse('int[][] grid = new int[2][3];', 'java')[0].entries.length, 6);
  assert.equal(parse('int[][] grid = {};', 'java')[0].entries.length, 0);
  assert.throws(() => parse('int[][] grid = {{1},{2,3}};', 'java'), /same length/);
  assert.throws(() => parse('int[] nums = new int[size];', 'java'), /not evaluated/);
});

test('JavaScript / Node handles Array, Map, Set, object, typed arrays and nested matrices', () => {
  const [array, map, set, object, typed, matrix] = parse(`const arr = [1, "two", null]; const cache = new Map([["x", 1], ["y", 2]]);
    let seen = new Set([1, 2, 2]); let user = {name: "A", active: true}; const bytes = new Uint8Array(3); const grid = [[1,2],[3,4]];`, 'node');
  assert.equal(array.structureKind, 'array'); assert.deepEqual(values(array), ['1', 'two', 'null']);
  assert.equal(map.structureKind, 'map'); assert.deepEqual(map.entries.map(item => item.key), ['x', 'y']);
  assert.equal(set.structureKind, 'set'); assert.equal(set.entries.length, 2);
  assert.equal(object.structureKind, 'object'); assert.deepEqual(object.entries.map(item => item.key), ['name', 'active']);
  assert.deepEqual(values(typed), ['0', '0', '0']); assert.equal(matrix.structureKind, 'matrix');
  assert.deepEqual(values(parse('const sparse = Array(2);', 'javascript')[0]), ['', '']);
});

test('Python literal lists, dictionaries, sets, tuples, typed declarations and deque are supported', () => {
  const result = parseStructureCode(`from collections import deque
    nums: list[int] = [1, -2, 3]
    cache = {"a": 1, "b": 2}
    seen = {1, 2, 2}
    pair = (1, 2)
    pending = deque([])
    empty: dict[str, int]
    truth = [True, False, None]`, 'python');
  assert.deepEqual(result.structures.map(item => item.structureKind), ['list', 'map', 'set', 'list', 'deque', 'map', 'list']);
  assert.deepEqual(values(result.structures[2]), ['1', '2']); assert.deepEqual(values(result.structures[6]), ['True', 'False', 'None']);
});

test('recognized mutations build an import snapshot in declaration order with correct queue/stack ends', () => {
  const [queue, stack, deque, map, list] = parse(`Queue<Integer> q = new ArrayDeque<>(); q.offer(1); q.add(2); q.poll();
    Stack<Integer> s = new Stack<>(); s.push(1); s.push(2); s.pop();
    Deque<Integer> d = new ArrayDeque<>(); d.addLast(1); d.push(2); d.addFirst(3); d.pop();
    Map<String,Integer> m = new HashMap<>(); m.put("one", 1); m.put("one", 2);
    List<String> list = new ArrayList<>(); list.addAll(List.of("a", "b")); list.set(0, "x");`, 'java');
  assert.deepEqual(values(queue), ['2']); assert.deepEqual(values(stack), ['1']); assert.deepEqual(values(deque), ['2', '1']); assert.deepEqual(values(map), ['2']); assert.deepEqual(values(list), ['x', 'b']);
  const [py] = parse('d = deque([1,2])\nd.appendleft(0)\nd.popleft()\nd.append(3)', 'python'); assert.deepEqual(values(py), ['1', '2', '3']);
  const [js] = parse('const a = []; a.push(1); a.push(2); a.shift();', 'javascript'); assert.deepEqual(values(js), ['2']);
});

test('quoted punctuation, comments and escapes remain literal data, including prototype-like keys', () => {
  const [data] = parse('const safe = {"__proto__": "value", "constructor": "text", "close": "]", "open": "(", "url": "https://example.test/#a", "escape": "A\\nB\\u263a"};', 'javascript');
  assert.deepEqual(values(data), ['value', 'text', ']', '(', 'https://example.test/#a', 'A\nB☺']);
  assert.equal({}.polluted, undefined);
});

test('language-specific deque ends, priority removal and mixed-type identities never silently corrupt data', () => {
  assert.deepEqual(values(parse('from collections import deque\nq=deque([1,2,3])\nq.pop()', 'python')[0]), ['1', '2']);
  assert.deepEqual(values(parse('Deque<Integer> q=new ArrayDeque<>(List.of(1,2,3));q.pop();', 'java')[0]), ['2', '3']);
  assert.deepEqual(values(parse('var q=new ArrayDeque<>(List.of(1,2,3));q.pop();')[0]), ['2', '3']);
  assert.deepEqual(values(parse('LinkedList<Integer> q=new LinkedList<>();q.push(1);q.push(2);q.pop();', 'java')[0]), ['1']);
  assert.throws(() => parse('PriorityQueue<Integer> q=new PriorityQueue<>(List.of(3,1,2));q.poll();', 'java'), /Priority ordering/);
  assert.throws(() => parse('Queue<Integer> q=new PriorityQueue<>();q.offer(3);q.offer(1);q.poll();', 'java'), /Priority ordering/);
  assert.equal(parse('Queue<Integer> q=new PriorityQueue<>();', 'java')[0].structureKind, 'heap');
  assert.deepEqual(values(parse('Collection<Integer> c=new HashSet<>(List.of(1,1));', 'java')[0]), ['1']);
  assert.throws(() => parse('Set<Object> s = Set.of(\'a\', "a");', 'java'), /Mixed-type/);
  for (const code of ['const m = new Map(); m.set(1,"a"); m.set("1","b");', 'const s = new Set(); s.add(1); s.add("1");', 'const m = new Map([[1,"a"],["1","b"]]);', 'const s = new Set([1,"1"]);']) assert.throws(() => parse(code, 'javascript'), /Mixed-type/);
  assert.deepEqual(values(parse('const m = new Map(); m.set(1,"a"); m.clear(); m.set("1","b");', 'javascript')[0]), ['b']);
});

test('unsafe calls and unsupported language constructs fail atomically without side effects', () => {
  const malicious = [
    'const a = [fetch("https://bad.test")];', 'const a = eval("globalThis.polluted=true");', 'const a = new Function("return 1")();',
    'a = __import__("os").system("open /tmp")', 'Runtime r = Runtime.getRuntime();', 'System.exit(0);',
    'const a = []; while(true) { a.push(1); }', 'a = [x for x in range(10)]', 'const a = [`${fetch("x")}`];',
    'List<Integer> a = new ArrayList<>() {{ add(1); }};', 'const a = [1 + 2];', 'const a = unknown;',
    'const a = []; a.forEach(alert);', 'import java.util.List dangerous()', 'const a = []; a.map(x => x);',
  ];
  for (const code of malicious) assert.throws(() => parse(code), undefined, code);
  assert.equal(globalThis.polluted, undefined);
  const source = readFileSync(new URL('../frontend/features/diagrams/diagram-structure-parser.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:eval|fetch)\s*\(|new\s+Function\s*\(|\b(?:await|return)\s+import\s*\(/);
});

test('parser budgets bound input, container count, element count, nesting, cell size and dimensions', () => {
  assert.throws(() => parse(' '.repeat(20_001) + 'a=[]'), /20,000/);
  assert.throws(() => parse(Array.from({ length: 21 }, (_, index) => `a${index}=[]`).join('\n')), /20 containers/);
  assert.throws(() => parse(`a=[${Array(129).fill('1').join(',')}]`), /128 (?:entries|units)/);
  assert.throws(() => parse('int[] a = new int[999999];', 'java'), /128/);
  for (const size of ['1000000000', '9'.repeat(1000)]) assert.throws(() => parse(`int[][] nums = new int[${size}][0];`, 'java'), /dimension.*128/);
  assert.throws(() => parse(`a=${'['.repeat(17)}0${']'.repeat(17)}`), /16 levels/);
  assert.throws(() => parse(`a=["${'x'.repeat(2001)}"]`), /too long/);
  assert.throws(() => parse(`a={"${'x'.repeat(501)}":1}`), /too long/);
  assert.throws(() => parse('a=[]\na=[]'), /Duplicate/);
  assert.throws(() => parse(`${'a'.repeat(241)}=[]`), /240 characters/);
  assert.equal(parse(`${'java.util.'.repeat(15)}List<String> items;`, 'java')[0].implementation.length, 120);
  assert.equal(parse('int[][][] a;', 'java')[0].structureKind, 'array'); // Additional dimensions remain nested, not silently flattened.
  assert.throws(() => parse('const a = []', 'ruby'), /Choose Java/);
  assert.equal(parse('int[] a = new int[128];', 'java')[0].entries.length, 128);
});
