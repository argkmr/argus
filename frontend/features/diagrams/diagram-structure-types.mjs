// Type descriptions are parsed as data. No reflection, evaluation, or imports.
import { cleanStructureData, createStructureData, MAX_STRUCTURE_DEPTH, countStructureEntries, structureHasNested } from './diagram-structures.mjs';
export { countStructureEntries, structureHasNested } from './diagram-structures.mjs';
const aliases = new Map([
  ['array', ['Array','Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array']],
  ['list', ['Collection','List','ArrayList','Vector','CopyOnWriteArrayList','AbstractList','ImmutableList','list','tuple','Sequence','MutableSequence','Tuple']],
  ['stack', ['Stack','stack','LifoQueue']],
  ['queue', ['Queue','AbstractQueue','ConcurrentLinkedQueue','BlockingQueue','LinkedBlockingQueue','ArrayBlockingQueue','SynchronousQueue','LinkedTransferQueue','TransferQueue','DelayQueue','SimpleQueue']],
  ['deque', ['Deque','ArrayDeque','ConcurrentLinkedDeque','LinkedBlockingDeque','BlockingDeque','deque']],
  ['map', ['Map','HashMap','LinkedHashMap','TreeMap','SortedMap','NavigableMap','WeakHashMap','IdentityHashMap','EnumMap','Hashtable','ConcurrentMap','ConcurrentHashMap','ConcurrentNavigableMap','ConcurrentSkipListMap','ImmutableMap','dict','Dict','Mapping','MutableMapping','OrderedDict','Counter']],
  ['set', ['Set','HashSet','LinkedHashSet','TreeSet','SortedSet','NavigableSet','EnumSet','CopyOnWriteArraySet','ConcurrentSkipListSet','ImmutableSet','set','frozenset','FrozenSet','MutableSet']],
  ['doubly-linked-list', ['LinkedList']], ['linked-list', ['SinglyLinkedList','LinkedNode','ListNode']], ['circular-list', ['CircularLinkedList','CircularList']],
  ['tree', ['Tree','TreeNode','BinaryTree']], ['bst', ['BinarySearchTree','BST']], ['heap', ['PriorityQueue','PriorityBlockingQueue','Heap','MinHeap','MaxHeap']],
  ['trie', ['Trie','TrieNode']], ['graph', ['Graph','DirectedGraph','UndirectedGraph']], ['union-find', ['UnionFind','DisjointSet','DSU']], ['bitset', ['BitSet','bitarray']],
  ['object', ['Object','object','Record']],
].flatMap(([kind, names]) => names.map(name => [name, kind])));
const fail = message => { throw new Error(message); };
const scalarAny = new Set(['Object', 'object', 'Any', 'any', 'unknown', '?']);
const scalarTypes = new Set(['byte','short','int','long','float','double','boolean','char','String','Integer','Long','Short','Byte','Double','Float','Boolean','Character','Number','number','string','bool','str','bytes','complex','BigInteger','BigDecimal','UUID','Date','Instant','LocalDate','LocalDateTime','bigint','symbol','None','NoneType','null','undefined']);
export const isKnownScalarType = schema => !schema?.structureKind && scalarTypes.has(schema?.name?.split('.').at(-1));

export function parseStructureType(text) {
  if (typeof text !== 'string' || !text.trim()) fail('Enter a container type, such as Map<String, ArrayList<Integer>>.');
  if (text.length > 2000) fail('Type descriptions are limited to 2,000 characters.');
  const tokens = text.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|[<>\[\],?]|\S/g) || [];
  let cursor = 0;
  function parse(level) {
    if (level > MAX_STRUCTURE_DEPTH + 1) fail('Nested container types support at most 8 levels.');
    const name = tokens[cursor++];
    if (!name || !/^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\?)$/.test(name)) fail('Use a Java generic or Python bracket type, not executable code.');
    const short = name.split('.').at(-1);
    let structureKind = aliases.get(short) || null;
    if (level > 1 && scalarAny.has(short)) structureKind = null;
    let args = [], open = '', close = '';
    if (tokens[cursor] === '<' || tokens[cursor] === '[' && tokens[cursor + 1] !== ']') {
      open = tokens[cursor++]; close = open === '<' ? '>' : ']';
      if (!structureKind) fail(`Unsupported generic container ${name}. Use a supported container around custom scalar types.`);
      if (tokens[cursor] === close) fail('Specify the nested type inside the brackets.');
      do { args.push(parse(level + 1)); if (tokens[cursor] !== ',') break; cursor++; } while (true);
      if (tokens[cursor++] !== close) fail('Type brackets are not balanced.');
      const arity = ['map', 'object'].includes(structureKind) ? 2 : 1;
      if (args.length !== arity) fail(`${name} needs ${arity === 2 ? 'a key type and a value type' : 'one element type'}.`);
    }
    if (structureKind && level > MAX_STRUCTURE_DEPTH) fail('Nested container types support at most 8 levels.');
    let result = { name, canonical: name + (open ? `${open}${args.map(arg => arg.canonical).join(', ')}${close}` : ''), structureKind, arguments: args };
    let dimensions = 0;
    while (tokens[cursor] === '[' && tokens[cursor + 1] === ']') { cursor += 2; dimensions++; }
    if (!structureKind && !scalarTypes.has(short) && !scalarAny.has(short) && (level > 1 || dimensions)) fail(`Unknown type ${name}; paste its custom class fields instead of guessing a flat value.`);
    if (dimensions > MAX_STRUCTURE_DEPTH) fail('Nested container types support at most 8 levels.');
    if (dimensions) {
      if (level + (result.structureKind ? 1 : 0) > MAX_STRUCTURE_DEPTH) fail('Nested container types support at most 8 levels.');
      const scalar = result;
      result = { name: dimensions >= 2 ? 'Matrix' : 'Array', canonical: scalar.canonical + '[]'.repeat(Math.min(2, dimensions)), structureKind: dimensions >= 2 ? 'matrix' : 'array', arguments: [scalar] };
      for (let index = 2; index < dimensions; index++) result = { name: 'Array', canonical: result.canonical + '[]', structureKind: 'array', arguments: [result] };
      if (level + Math.max(0, dimensions - 2) + (scalar.structureKind ? 1 : 0) > MAX_STRUCTURE_DEPTH) fail('Nested container types support at most 8 levels.');
    }
    return result;
  }
  const result = parse(1);
  if (cursor !== tokens.length) fail('Type descriptions cannot include a variable name, initializer, or executable expression.');
  return result;
}

export function structureEntryTypes(data) {
  let schema = null;
  if (data?.typeSignature) schema = parseStructureType(data.typeSignature);
  else if (data?.implementation) { try { schema = parseStructureType(data.implementation); } catch {} }
  if (!schema?.structureKind) return { key: null, value: null };
  return ['map','object'].includes(schema.structureKind) ? { key: schema.arguments[0] || null, value: schema.arguments[1] || null } : { key: null, value: schema.arguments[0] || null };
}

export function createStructureForType(schema, name = '') {
  if (isKnownScalarType(schema)) {
    const data = createStructureData('object');
    data.name = (name || schema.name).slice(0, 240); data.typeSignature = schema.canonical; data.implementation = schema.canonical.slice(0, 120);
    data.entries = [{ id: globalThis.crypto.randomUUID(), key: 'value', value: '', annotation: schema.canonical }];
    return data;
  }
  if (!schema?.structureKind) fail('Unsupported type. Choose a known data type or paste its custom class/record declaration.');
  const data = createStructureData(schema.structureKind);
  data.typeSignature = schema.canonical;
  data.implementation = schema.canonical.slice(0, 120);
  if (name) data.name = name.slice(0, 240);
  return data;
}

export function createStructureEntry(data) {
  const types = structureEntryTypes(data);
  const entry = { id: globalThis.crypto.randomUUID(), key: '', value: data.structureKind === 'bitset' ? '0' : '', annotation: '' };
  for (const side of ['key','value']) if (types[side]?.structureKind) entry[`${side}Container`] = createStructureForType(types[side], side === 'key' ? 'Key' : 'Value');
  return entry;
}

export function applyStructureType(input, text) {
  const schema = parseStructureType(text);
  const data = cleanStructureData(input);
  if (isKnownScalarType(schema)) {
    if (data.entries.length > 1 || data.entries.some(entry => entry.keyContainer || entry.valueContainer || entry.key && entry.key !== 'value')) fail('Converting this structure to a scalar would remove existing data. Use an empty structure or a single value cell.');
    const result = createStructureForType(schema, data.name);
    return { ...data, structureKind: 'object', implementation: result.implementation, typeSignature: result.typeSignature, entries: data.entries.length ? data.entries.map(entry => ({ ...entry, key: 'value', annotation: entry.annotation || schema.canonical })) : result.entries };
  }
  if (!schema.structureKind) fail('Unsupported type. Choose a known data type or paste its custom class/record declaration.');
  function apply(container, type, path) {
    const wasMap = ['map','object'].includes(container.structureKind), isMap = ['map','object'].includes(type.structureKind);
    if (wasMap && !isMap && container.entries.some(entry => entry.key || entry.keyContainer)) fail(`${path}: this conversion would remove existing keys. Keep the current type or clear those keys first.`);
    const next = { ...container, structureKind: type.structureKind, implementation: type.canonical.slice(0, 120), typeSignature: type.canonical };
    const types = isMap ? { key: type.arguments[0], value: type.arguments[1] } : { key: null, value: type.arguments[0] };
    next.entries = container.entries.map((entry, index) => {
      const row = { ...entry };
      for (const side of ['key','value']) {
        const expected = types[side], child = entry[`${side}Container`], location = `${path}, unit ${index + 1} ${side}`;
        if (expected?.structureKind) {
          if (child && entry[side]) fail(`${location}: both text and a nested container are present. Clear the text explicitly before changing its type.`);
          if (child) row[`${side}Container`] = apply(child, expected, location);
          else if (entry[side]) fail(`${location}: existing text cannot be converted into ${expected.canonical} without losing it. Keep the value or clear this cell first.`);
          else row[`${side}Container`] = createStructureForType(expected, side === 'key' ? 'Key' : 'Value');
          row[side] = '';
        } else if (child && expected && !scalarAny.has(expected.name.split('.').at(-1))) {
          if (child.entries.length || child.description || child.links.length || child.pointers.length) fail(`${location}: converting a populated container to ${expected.canonical} would remove its contents.`);
          delete row[`${side}Container`]; row[side] = '';
        }
      }
      return row;
    });
    return next;
  }
  const result = apply(data, schema, 'Container');
  countStructureEntries(result);
  return cleanStructureData(result);
}
