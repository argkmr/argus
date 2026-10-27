import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStructureType, createStructureEntry, createStructureForType, parseStructureType, structureEntryTypes } from '../frontend/features/diagrams/diagram-structure-types.mjs';
import { cleanStructureData, countStructureEntries, createStructureData, duplicateStructureData, structureHasNested } from '../frontend/features/diagrams/diagram-structures.mjs';
import { parseStructureCode } from '../frontend/features/diagrams/diagram-structure-parser.mjs';
import { createDiagramHistory, emptySnapshot, exportBoard, makeNode, parseBoardImport } from '../frontend/features/diagrams/diagram-model.mjs';

const parse = (source, language) => parseStructureCode(source, language).structures[0];
const values = data => data.entries.map(entry => entry.value);
const typed = text => createStructureForType(parseStructureType(text));
const add = data => { const entry = createStructureEntry(data); data.entries.push(entry); return entry; };
const plain = value => JSON.parse(JSON.stringify(value));

test('recursive type descriptions recognize container families, qualified generics and Python annotations', () => {
  const map = parseStructureType('java.util.Map<String, java.util.Map<String, java.util.ArrayList<String>>>');
  assert.equal(map.structureKind, 'map'); assert.equal(map.arguments[1].structureKind, 'map'); assert.equal(map.arguments[1].arguments[1].structureKind, 'list');
  const python = parseStructureType('typing.Dict[str, typing.List[collections.deque[int]]]');
  assert.equal(python.structureKind, 'map'); assert.equal(python.arguments[1].arguments[0].structureKind, 'deque');
  for (const [type, kind] of [['Set<List<String>>','set'], ['Queue<Map<String, int[]>>','queue'], ['Stack<Set<Integer>>','stack'], ['Tree<List<Integer>>','tree'], ['PriorityQueue<int[]>','heap'], ['Graph<Map<String, Integer>>','graph'], ['BitSet','bitset'], ['Record<string, Array<number>>','object']]) assert.equal(parseStructureType(type).structureKind, kind);
  assert.throws(() => parseStructureType('Map<String>'), /key type and a value type/);
  assert.throws(() => parseStructureType('tuple[str, int]'), /one element type/);
  assert.throws(() => parseStructureType('Mystery<Integer>'), /Unsupported generic container/);
  assert.throws(() => parseStructureType('Map<String,User>'), /Unknown type User/);
  assert.throws(() => parseStructureType('User[]'), /Unknown type User/);
  assert.throws(() => parseStructureType('Map<String, Integer>; run()'), /cannot include/);
});

test('Apply changes actual outer type and + grows typed nested containers instead of text cells', () => {
  const original = createStructureData('array');
  const root = applyStructureType(original, 'Map<String,Map<String,ArrayList<String>>>');
  assert.equal(root.structureKind, 'map'); assert.equal(original.structureKind, 'array');
  assert.equal(root.typeSignature, 'Map<String, Map<String, ArrayList<String>>>');
  const first = add(root); first.key = 'team';
  assert.equal(first.value, ''); assert.equal(first.valueContainer.structureKind, 'map');
  const second = add(first.valueContainer); second.key = 'workers';
  assert.equal(second.valueContainer.structureKind, 'list'); assert.deepEqual(second.valueContainer.entries, []);
  const third = add(second.valueContainer); third.value = 'alice';
  assert.equal(countStructureEntries(root), 3); assert.equal(structureHasNested(root), true);
  assert.deepEqual(cleanStructureData(root), root);
  assert.equal(structureEntryTypes(second.valueContainer).value.canonical, 'String');
});

test('nested keys are typed containers too, not flattened display strings', () => {
  const root = typed('Map<List<Integer>, Set<String>>'); const entry = add(root);
  assert.equal(entry.keyContainer.structureKind, 'list'); assert.equal(entry.valueContainer.structureKind, 'set');
  add(entry.keyContainer).value = '1'; add(entry.valueContainer).value = 'a';
  assert.equal(countStructureEntries(root), 3);
  const parsed = parse('Map<List<Integer>,List<String>> a=Map.of(List.of(1,2),List.of("x"));', 'java');
  assert.deepEqual(values(parsed.entries[0].keyContainer), ['1','2']); assert.deepEqual(values(parsed.entries[0].valueContainer), ['x']);
  const js = parse('const a = new Map([[[1,2], {items:[3]}]]);', 'javascript');
  assert.equal(js.entries[0].keyContainer.structureKind, 'array'); assert.equal(js.entries[0].valueContainer.structureKind, 'object');
  assert.throws(() => parse('a = {[1,2]: 3}', 'python'), /Nested Python map keys/);
});

test('incompatible Apply is atomic and never erases old scalar values or map keys', () => {
  const root = createStructureData('map'); root.entries.push({ id:'one',key:'abc',value:'xyz',annotation:'keep' });
  const before = plain(root);
  assert.throws(() => applyStructureType(root, 'Map<String,Map<String,List<String>>>'), /existing text.*without losing/);
  assert.deepEqual(root, before);
  assert.throws(() => applyStructureType(root, 'List<String>'), /remove existing keys/);
  const nested = parse('const a = {items:[1,2]};', 'javascript'); const copy = plain(nested);
  assert.throws(() => applyStructureType(nested, 'Map<String,String>'), /populated container/);
  assert.deepEqual(nested, copy);
  const preserved = applyStructureType(nested, 'Map<String,Object>');
  assert.deepEqual(values(preserved.entries[0].valueContainer), ['1','2']);
  root.entries[0].value = ''; const changed = applyStructureType(root, 'Map<String,List<String>>');
  assert.equal(changed.entries[0].key, 'abc'); assert.equal(changed.entries[0].annotation, 'keep');
  assert.deepEqual(changed.entries[0].valueContainer.entries, []);
});

test('Java, Python and JS literals retain nested maps, lists, sets and objects', () => {
  for (const [code, language] of [
    ['Map<String,Map<String,List<String>>> a=Map.of("team",Map.of("names",List.of("A","B")));','java'],
    ['a: dict[str,dict[str,list[str]]] = {"team":{"names":["A","B"]}}','python'],
    ['const a = new Map([["team",new Map([["names",["A","B"]]])]]);','javascript'],
  ]) {
    const root = parse(code, language), child = root.entries[0].valueContainer.entries[0].valueContainer;
    assert.deepEqual(values(child), ['A','B']); assert.equal(root.entries[0].value, ''); assert.equal(countStructureEntries(root), 4);
  }
  const root = parse('const a = {users:[{name:"A",roles:new Set(["reader"])}]};', 'javascript');
  const user = root.entries[0].valueContainer.entries[0].valueContainer;
  assert.equal(user.structureKind, 'object'); assert.deepEqual(values(user.entries[1].valueContainer), ['reader']);
  assert.equal(parse('Map<String, Map<String, ArrayList<String>>>').entries.length, 0);
});

test('typed nested initializer mismatches fail instead of producing a misleading type label', () => {
  for (const code of [
    'Map<String,List<Integer>> a=Map.of("x",Map.of("bad",1));',
    'Map<String,Map<String,Integer>> a=Map.of("x",List.of(1));',
    'List<Map<String,Integer>> a=List.of(List.of(1));',
    'List<Integer> a=new HashMap<>();',
    'Map<String,Integer> a=List.of(List.of("a",1));',
    'List<String> a=List.of(List.of("a"));',
  ]) assert.throws(() => parse(code, 'java'), /Expected|incompatible/);
  assert.throws(() => parse('a: dict[str,int] = [("x",1)]', 'python'), /sequence literal/);
  assert.throws(() => parse('a: list[int] = {}', 'python'), /map\/object literal/);
  assert.equal(parse('Queue<Integer> a = new PriorityQueue<>();', 'java').structureKind, 'heap');
  assert.equal(parse('Queue<Integer> a = new LinkedList<>();', 'java').structureKind, 'queue');
  assert.equal(parse('Collection<Integer> a = new HashSet<>(List.of(1,1));', 'java').entries.length, 1);
});

test('known primitives have one typed value slot while unknown custom types are explicit errors', () => {
  const empty = parse('int'); assert.equal(empty.structureKind,'object'); assert.equal(empty.entries[0].key,'value'); assert.equal(empty.entries[0].value,'');
  const initialized = parse('String message="hello";', 'java'); assert.equal(initialized.typeSignature,'String'); assert.deepEqual(values(initialized),['hello']);
  assert.deepEqual(values(parse('n: int = 12', 'python')), ['12']);
  assert.throws(() => parse('Mystery'), /Unsupported/); assert.throws(() => parse('Mystery a;', 'java'), /Unsupported data type/);
  assert.throws(() => parse(`String huge="${'x'.repeat(2001)}";`, 'java'), /too long/);
  const multi = createStructureData('list'); multi.entries=[{id:'a',key:'',value:'1',annotation:''},{id:'b',key:'',value:'2',annotation:''}];
  assert.throws(() => applyStructureType(multi, 'int'), /remove existing data/);
});

test('higher-dimensional arrays preserve recursive dimensions and correctly initialized cells', () => {
  const empty = typed('int[][][]'); assert.equal(empty.structureKind, 'array');
  const entry = add(empty); assert.equal(entry.valueContainer.structureKind, 'matrix'); assert.equal(entry.valueContainer.typeSignature, 'int[][]');
  const array = parse('int[][][] cube = new int[2][2][2];', 'java');
  assert.equal(array.entries.length, 2); assert.equal(array.entries[0].valueContainer.columns, 2);
  assert.deepEqual(values(array.entries[0].valueContainer), ['0','0','0','0']); assert.equal(countStructureEntries(array), 10);
  const literal = parse('int[][][] cube = {{{1,2},{3,4}}};', 'java');
  assert.deepEqual(values(literal.entries[0].valueContainer), ['1','2','3','4']);
});

test('literal-only append and map replacement keep nested values and enforce type compatibility', () => {
  const list = parse('List<List<Integer>> a=new ArrayList<>(); a.add(List.of(1,2)); a.set(0,List.of(3));', 'java');
  assert.deepEqual(values(list.entries[0].valueContainer), ['3']);
  const map = parse('Map<String,List<Integer>> a=new HashMap<>(); a.put("x",List.of(1,2)); a.put("x",List.of(3));', 'java');
  assert.equal(map.entries.length, 1); assert.equal(countStructureEntries(map), 2); assert.deepEqual(values(map.entries[0].valueContainer), ['3']);
  assert.throws(() => parse('List<List<Integer>> a=new ArrayList<>(); a.add(1);', 'java'), /scalar literal/);
  assert.throws(() => parse('Map<String,List<Integer>> a=new HashMap<>(); a.put("x",Map.of("bad",1));', 'java'), /Expected/);
});

test('nested clean, duplicate, board export/import and history preserve contents and independent identities', () => {
  const data = parse('const a={list:[{id:1},{id:2}]};','javascript');
  const child = data.entries[0].valueContainer;
  child.links=[{id:'edge',source:child.entries[0].id,target:child.entries[1].id,label:'next'}];
  child.pointers=[{id:'pointer',target:child.entries[1].id,label:'at'}]; child.activeEntryId=child.entries[0].id;
  assert.deepEqual(cleanStructureData(data),data);
  const duplicate = duplicateStructureData(data), copied = duplicate.entries[0].valueContainer;
  assert.notEqual(copied.entries[0].id,child.entries[0].id); assert.equal(copied.links[0].source,copied.entries[0].id);
  assert.equal(copied.pointers[0].target,copied.entries[1].id); assert.equal(copied.activeEntryId,copied.entries[0].id);
  copied.entries[0].valueContainer.entries[0].value='updated'; assert.equal(child.entries[0].valueContainer.entries[0].value,'1');
  const snapshot=emptySnapshot(); const node=makeNode('dataStructure'); node.data=data; snapshot.structured.nodes=[node];
  const roundtrip=parseBoardImport(exportBoard({name:'Nested',snapshot})); assert.deepEqual(roundtrip.snapshot.structured.nodes[0].data,data);
  const history=createDiagramHistory(data); history.push(duplicate);
  assert.deepEqual(history.undo(),data); assert.deepEqual(history.redo(),duplicate);
});

test('duplicate IDs in different nested levels are repaired with their local links retained', () => {
  const root = createStructureData('list'), child=createStructureData('list');
  root.entries=[{id:'same',key:'',value:'',annotation:'',valueContainer:child}];
  child.entries=[{id:'same',key:'',value:'child',annotation:''}]; child.pointers=[{id:'p',label:'here',target:'same'}]; child.activeEntryId='same';
  const safe=cleanStructureData(root), saved=safe.entries[0].valueContainer;
  assert.notEqual(safe.entries[0].id,saved.entries[0].id); assert.equal(saved.pointers[0].target,saved.entries[0].id); assert.equal(saved.activeEntryId,saved.entries[0].id);
});

test('aggregate units, nesting and cycles stay bounded before persistence or preview', () => {
  const root=createStructureData('list'), child=createStructureData('array');
  root.entries=[{id:'r',key:'',value:'',annotation:'',valueContainer:child}];
  child.entries=Array.from({length:127},(_,index)=>({id:`e${index}`,key:'',value:'',annotation:''}));
  assert.equal(countStructureEntries(cleanStructureData(root)),128);
  child.entries.push({id:'extra',key:'',value:'',annotation:''});
  assert.throws(()=>cleanStructureData(root),/128 units/); assert.throws(()=>countStructureEntries(root),/128 units/);
  assert.throws(()=>parse(`const a=[{values:[${Array(127).fill('1').join(',')}]}];`,'javascript'),/128 units/);
  assert.throws(()=>parseStructureType(`${'List<'.repeat(9)}String${'>'.repeat(9)}`),/8 levels/);
  let nested=createStructureData('list');
  for(let i=0;i<8;i++) { const outer=createStructureData('list'); outer.entries=[{id:`e${i}`,key:'',value:'',annotation:'',valueContainer:nested}]; nested=outer; }
  assert.throws(()=>cleanStructureData(nested),/8 levels/);
  const cyclic=createStructureData('list'); cyclic.entries=[{id:'cycle',key:'',value:'',annotation:'',valueContainer:cyclic}];
  assert.throws(()=>cleanStructureData(cyclic),/cycles/); assert.throws(()=>countStructureEntries(cyclic),/cycles/);
  const ambiguous=createStructureData('map'); ambiguous.entries=[{id:'bad',key:'x',value:'saved text',annotation:'',valueContainer:createStructureData('list')}];
  assert.throws(()=>cleanStructureData(ambiguous),/both scalar text and a nested container/);
});
