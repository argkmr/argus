// A small declaration/literal reader, deliberately NOT a language interpreter.
// No eval, Function constructor, module loading, subprocess, or network access.
import { createStructureData, MAX_STRUCTURE_ENTRIES, MAX_STRUCTURE_DEPTH, countStructureEntries } from './diagram-structures.mjs';
import { parseStructureType, structureEntryTypes, createStructureForType, isKnownScalarType } from './diagram-structure-types.mjs';
import { tryParseCustomStructureCode } from './diagram-custom-structure-parser.mjs';

export const MAX_STRUCTURE_CODE_LENGTH = 20_000;
export const MAX_PARSED_STRUCTURES = 20;
const uid = () => globalThis.crypto.randomUUID();
const error = message => { throw new Error(message); };
const aliases = new Map([
  ['array', ['Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']],
  ['list', ['Collection', 'List', 'ArrayList', 'Vector', 'CopyOnWriteArrayList', 'AbstractList', 'ImmutableList', 'list', 'tuple', 'Sequence', 'MutableSequence', 'Tuple']],
  ['stack', ['Stack', 'stack', 'LifoQueue']],
  ['queue', ['Queue', 'AbstractQueue', 'ConcurrentLinkedQueue', 'BlockingQueue', 'LinkedBlockingQueue', 'ArrayBlockingQueue', 'SynchronousQueue', 'LinkedTransferQueue', 'TransferQueue', 'DelayQueue', 'SimpleQueue']],
  ['deque', ['Deque', 'ArrayDeque', 'ConcurrentLinkedDeque', 'LinkedBlockingDeque', 'BlockingDeque', 'deque']],
  ['map', ['Map', 'HashMap', 'LinkedHashMap', 'TreeMap', 'SortedMap', 'NavigableMap', 'WeakHashMap', 'IdentityHashMap', 'EnumMap', 'Hashtable', 'ConcurrentMap', 'ConcurrentHashMap', 'ConcurrentNavigableMap', 'ConcurrentSkipListMap', 'ImmutableMap', 'dict', 'Dict', 'Mapping', 'MutableMapping', 'OrderedDict', 'Counter']],
  ['set', ['Set', 'HashSet', 'LinkedHashSet', 'TreeSet', 'SortedSet', 'NavigableSet', 'EnumSet', 'CopyOnWriteArraySet', 'ConcurrentSkipListSet', 'ImmutableSet', 'set', 'frozenset', 'FrozenSet', 'MutableSet']],
  ['doubly-linked-list', ['LinkedList']],
  ['linked-list', ['SinglyLinkedList', 'LinkedNode', 'ListNode']],
  ['circular-list', ['CircularLinkedList', 'CircularList']],
  ['tree', ['Tree', 'TreeNode', 'BinaryTree']], ['bst', ['BinarySearchTree', 'BST']],
  ['heap', ['PriorityQueue', 'PriorityBlockingQueue', 'Heap', 'MinHeap', 'MaxHeap']],
  ['trie', ['Trie', 'TrieNode']], ['graph', ['Graph', 'DirectedGraph', 'UndirectedGraph']],
  ['union-find', ['UnionFind', 'DisjointSet', 'DSU']], ['bitset', ['BitSet', 'bitarray']],
  ['object', ['Object', 'object']],
].flatMap(([kind, names]) => names.map(name => [name, kind])));
const primitive = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'boolean', 'char']);
const bareType = type => type.replace(/<.*>|\[.*\]/g, '').split('.').at(-1);
const typeKind = type => type ? parseStructureType(type).structureKind : null;
const scalar = (value, type = 'string') => ({ kind: 'scalar', value, type });
const sequence = items => ({ kind: 'sequence', items });
const mapping = pairs => ({ kind: 'mapping', pairs });
const display = value => value.kind === 'scalar' ? value.value : value.kind === 'mapping'
  ? `{${value.pairs.map(([key, item]) => `${display(key)}: ${display(item)}`).join(', ')}}`
  : `[${value.items.map(display).join(', ')}]`;
const keyIdentity = value => JSON.stringify(value);
const numericText = value => value.replace(/_/g, '').replace(/^([-+]?0[xX][\da-fA-F]+)[lLn]$/, '$1').replace(/^([-+]?0[bB][01]+)[lLn]$/, '$1').replace(/^([-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)[lLfFdDn]$/, '$1');

function tokenize(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (/\s/.test(char)) { if (char === '\n') tokens.push({ value: '\n', type: 'punct' }); index++; continue; }
    if (char === '#' || source.startsWith('//', index)) { while (index < source.length && source[index] !== '\n') index++; continue; }
    if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); if (end < 0) error('Unclosed code comment.'); index = end + 2; continue; }
    if (char === '"' || char === "'") {
      const quote = char; let value = ''; index++; let closed = false;
      while (index < source.length) {
        const next = source[index++];
        if (next === quote) { closed = true; break; }
        if (next === '\n' || next === '\r') error('Use single-line quoted string literals, not multiline or interpolated strings.');
        if (next !== '\\') { value += next; continue; }
        const escape = source[index++];
        const replacements = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'", '/': '/' };
        if (Object.hasOwn(replacements, escape)) value += replacements[escape];
        else if (escape === 'u' || escape === 'x') {
          const length = escape === 'u' ? 4 : 2, hex = source.slice(index, index + length);
          if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) error('Invalid string escape.');
          value += String.fromCharCode(parseInt(hex, 16)); index += length;
        } else error('Unsupported string escape. Use plain literal strings.');
      }
      if (!closed) error('Unclosed string literal.');
      tokens.push({ type: 'string', value, quote }); continue;
    }
    const number = source.slice(index).match(/^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]+)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[lLfFdDn]?/);
    if (number) { tokens.push({ type: 'number', value: number[0] }); index += number[0].length; continue; }
    const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/);
    if (identifier) { tokens.push({ type: 'id', value: identifier[0] }); index += identifier[0].length; continue; }
    if ('[]{}(),;:.=<>+-?*'.includes(char)) { tokens.push({ type: 'punct', value: char }); index++; continue; }
    error(`Unsupported code character ${JSON.stringify(char)}. Only declarations, literals and supported container operations are read.`);
  }
  return tokens;
}

function statements(tokens) {
  const result = []; let current = [], depth = 0, genericDepth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.type === 'punct') {
      if ('([{'.includes(token.value) && token.value.length === 1) depth++;
      if (')]}'.includes(token.value) && token.value.length === 1) depth--;
      if (token.value === '<') genericDepth++;
      if (token.value === '>') genericDepth--;
    }
    if (depth < 0 || genericDepth < 0) error('Unbalanced brackets.');
    const continues = token.value === '\n' && (['=', ',', '.', 'new'].includes(current.at(-1)?.value) || ['=', '.'].includes(tokens[index + 1]?.value));
    if (token.type === 'punct' && (token.value === ';' || token.value === '\n') && depth === 0 && genericDepth === 0 && !continues) { if (current.length) result.push(current); current = []; }
    else if (token.type !== 'punct' || token.value !== '\n') current.push(token);
  }
  if (depth || genericDepth) error('Unbalanced brackets.');
  if (current.length) result.push(current);
  return result;
}

class LiteralReader {
  constructor(tokens, language = 'auto') { this.tokens = tokens; this.language = language; this.index = 0; this.depth = 0; }
  peek(value) { return this.tokens[this.index]?.type === 'punct' && this.tokens[this.index]?.value === value; }
  take(value) { if (!this.peek(value)) error(`Expected ${value} in literal initializer.`); this.index++; }
  list(end) {
    const items = [];
    if (this.peek(end)) { this.index++; return items; }
    while (this.index < this.tokens.length) {
      items.push(this.read());
      if (items.length > MAX_STRUCTURE_ENTRIES * 2) error('A container supports at most 128 entries.');
      if (this.peek(end)) { this.index++; return items; }
      this.take(',');
      if (this.peek(end)) { this.index++; return items; }
    }
    error('Unclosed literal initializer.');
  }
  read() {
    if (++this.depth > 16) error('Literal nesting is limited to 16 levels.');
    try { return this.value(); } finally { this.depth--; }
  }
  value() {
    const token = this.tokens[this.index++];
    if (!token) error('Missing literal initializer.');
    if (token.type === 'string') {
      if (this.language === 'java' && token.quote === "'") { if (token.value.length !== 1) error('Java character literals must contain one character.'); return scalar(token.value, 'char'); }
      return scalar(token.value);
    }
    if (token.type === 'number') return scalar(numericText(token.value), 'number');
    if (token.value === '-' || token.value === '+') {
      const value = this.tokens[this.index++];
      if (value?.type !== 'number') error('Only numeric literals may have a sign.');
      return scalar(numericText(token.value + value.value), 'number');
    }
    if (['true', 'false', 'True', 'False', 'null', 'None', 'undefined'].includes(token.value)) return scalar(token.value, 'literal');
    if (token.value === '[' || token.value === '(') return sequence(this.list(token.value === '[' ? ']' : ')'));
    if (token.value === '{') {
      if (this.peek('}')) { this.index++; return mapping([]); }
      const first = this.readKey();
      if (this.peek(':')) {
        this.index++; const pairs = [[first, this.read()]];
        while (!this.peek('}')) { this.take(','); if (this.peek('}')) break; const key = this.readKey(); this.take(':'); pairs.push([key, this.read()]); if (pairs.length > MAX_STRUCTURE_ENTRIES) error('A container supports at most 128 entries.'); }
        this.take('}'); return mapping(pairs);
      }
      const items = [first];
      while (!this.peek('}')) { this.take(','); if (this.peek('}')) break; items.push(this.read()); if (items.length > MAX_STRUCTURE_ENTRIES) error('A container supports at most 128 entries.'); }
      this.take('}'); return { ...sequence(items), setLiteral: true };
    }
    if (token.type !== 'id') error('Expected a supported literal or container constructor.');
    const isNew = token.value === 'new';
    let name = isNew ? this.tokens[this.index++]?.value : token.value;
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) error('Expected a container type after new.');
    while (this.peek('.')) { this.index++; const part = this.tokens[this.index++]; if (part?.type !== 'id') error('Invalid container type.'); name += `.${part.value}`; }
    let constructorType = '';
    if (this.peek('<')) {
      const start = this.index;
      let depth = 0;
      do { const next = this.tokens[this.index++]; if (!next || !['id', 'punct'].includes(next.type)) error('Invalid generic type.'); if (next.value === '<') depth++; if (next.value === '>') depth--; } while (depth);
      if (this.index - start > 2) constructorType = name + this.tokens.slice(start, this.index).map(token => token.value).join('');
    }
    if (isNew && this.peek('[')) {
      const dimensions = [];
      while (this.peek('[')) { this.index++; let count = null; if (!this.peek(']')) { const size = this.read(); if (size.kind !== 'scalar' || size.type !== 'number' || !/^\d+$/.test(size.value)) error('Array sizes must be non-negative integer literals.'); count = Number(size.value); if (!Number.isSafeInteger(count) || count > MAX_STRUCTURE_ENTRIES) error('Each array dimension is limited to 128 units.'); } this.take(']'); dimensions.push(count); }
      if (dimensions.length > MAX_STRUCTURE_DEPTH) error('Nested containers support at most 8 levels.');
      if (this.peek('{')) { const init = this.read(); return { ...init, structureKind: dimensions.length === 2 ? 'matrix' : 'array', implementation: `${name}${'[]'.repeat(dimensions.length)}` }; }
      if (dimensions.some(size => size === null)) error('Unsized arrays require a literal initializer.');
      const count = dimensions.reduce((total, size) => total * size, 1);
      if (count > MAX_STRUCTURE_ENTRIES) error('A container supports at most 128 entries.');
      let prefix = 1, allocation = 0;
      for (const dimension of dimensions) { prefix *= dimension; allocation += prefix; if (allocation > MAX_STRUCTURE_ENTRIES * MAX_STRUCTURE_DEPTH) error('Nested arrays exceed the bounded preview allocation.'); }
      const initial = scalar(name === 'boolean' ? 'false' : name === 'char' ? '\\0' : primitive.has(name) ? '0' : 'null', 'literal');
      const build = index => Array.from({ length: dimensions[index] }, () => index === dimensions.length - 1 ? { ...initial } : sequence(build(index + 1)));
      const items = build(0);
      return { ...sequence(items), structureKind: dimensions.length === 2 ? 'matrix' : 'array', implementation: `${name}${'[]'.repeat(dimensions.length)}` };
    }
    if (!this.peek('(')) error(`Unsupported value ${name}. Variables, expressions and executable code are not evaluated.`);
    this.index++; const args = this.list(')');
    const result = construct(name, args, isNew);
    if (constructorType) result.typeSignature = parseStructureType(constructorType).canonical;
    return result;
  }
  readKey() { const token = this.tokens[this.index]; if (token?.type === 'id' && this.tokens[this.index + 1]?.value === ':') { this.index++; return scalar(token.value); } return this.read(); }
  all() { const value = this.read(); if (this.index !== this.tokens.length) error('Unsupported expression after literal. Arithmetic, function calls and runtime code are not executed.'); return value; }
}

function construct(name, args, isNew) {
  const short = name.split('.').at(-1), owner = name.split('.').at(-2);
  if (owner === 'Map' && short === 'entry' && args.length === 2) return { ...sequence(args), mapEntry: true };
  if (owner === 'Map' && short === 'ofEntries') {
    if (args.some(arg => !arg.mapEntry)) error('Map.ofEntries accepts only literal Map.entry(key, value) pairs.');
    return { ...mapping(args.map(arg => arg.items)), structureKind: 'map', implementation: name };
  }
  if (owner === 'Map' && short === 'of') {
    if (args.length % 2) error('Map.of requires key/value pairs.');
    return { ...mapping(Array.from({ length: args.length / 2 }, (_, index) => args.slice(index * 2, index * 2 + 2))), structureKind: 'map', implementation: name };
  }
  if ((['List', 'Set', 'ImmutableList', 'ImmutableSet'].includes(owner) && short === 'of') || (owner === 'Arrays' && short === 'asList')) return { ...sequence(args), structureKind: owner?.includes('Set') ? 'set' : 'list', implementation: name };
  if (owner === 'Collections' && ['emptyList', 'emptySet', 'emptyMap'].includes(short) && !args.length) return { ...(short === 'emptyMap' ? mapping([]) : sequence([])), structureKind: short.slice(5).toLowerCase(), implementation: name };
  if (owner === 'Collections' && ['singleton', 'singletonList', 'singletonMap'].includes(short)) {
    if (args.length !== (short === 'singletonMap' ? 2 : 1)) error('Invalid singleton literal.');
    return { ...(short === 'singletonMap' ? mapping([args]) : sequence(args)), structureKind: short === 'singletonMap' ? 'map' : short === 'singleton' ? 'set' : 'list', implementation: name };
  }
  if (owner === 'Collections' && /^(?:unmodifiable|synchronized)(?:List|Set|Map|Collection|SortedSet|SortedMap|NavigableSet|NavigableMap)$/.test(short)) {
    if (args.length !== 1 || !['sequence', 'mapping'].includes(args[0].kind)) error('Collection wrappers require a literal collection.');
    return { ...args[0], structureKind: /Map$/.test(short) ? 'map' : /Set$/.test(short) ? 'set' : 'list', implementation: name };
  }
  const kind = aliases.get(short);
  if (!kind) error(`Unsupported constructor or call ${name}. Only known container constructors and literal factories are supported.`);
  if (args.length > 1 && short !== 'Array') error(`${short} accepts a single literal collection in this visualizer. Comparators, defaults and runtime arguments are not executed.`);
  if (short === 'Array' && args.length > 1) return { ...sequence(args), structureKind: kind, implementation: short };
  let value = args[0] || (kind === 'map' || kind === 'object' ? mapping([]) : sequence([]));
  if (value.kind === 'scalar') {
    const capacityTypes = new Set(['ArrayList', 'Vector', 'HashMap', 'LinkedHashMap', 'HashSet', 'LinkedHashSet', 'Hashtable', 'ConcurrentHashMap', 'ArrayDeque', 'PriorityQueue', 'PriorityBlockingQueue', 'LinkedBlockingQueue', 'LinkedBlockingDeque', 'ArrayBlockingQueue', 'BitSet']);
    if ((isNew || short === 'Array') && value.type === 'number' && /^\d+$/.test(value.value) && (kind === 'array' || capacityTypes.has(short))) {
      if (kind === 'array') { if (+value.value > MAX_STRUCTURE_ENTRIES) error('A container supports at most 128 entries.'); value = sequence(Array.from({ length: +value.value }, () => scalar(short === 'Array' ? '' : '0', 'literal'))); }
      else value = kind === 'map' ? mapping([]) : sequence([]); // Java initial capacity is not a size.
    } else error(`${short} requires literal entries; runtime constructor arguments are not supported.`);
  }
  return { ...value, structureKind: kind, implementation: name };
}

function assertInitializerCompatible(schema, value, language) {
  if (!schema?.structureKind || !value || value.kind === 'scalar') return;
  const expected = schema.structureKind, actual = value.structureKind, short = schema.name.split('.').at(-1);
  if (actual && actual !== expected) {
    const roleCompatible = short === 'Collection' && !['map', 'object', 'matrix'].includes(actual)
      || expected === 'queue' && ['deque', 'doubly-linked-list', 'heap'].includes(actual)
      || expected === 'deque' && actual === 'doubly-linked-list'
      || expected === 'list' && actual === 'doubly-linked-list'
      || expected === 'tree' && ['bst', 'heap'].includes(actual);
    if (!roleCompatible) error(`Expected ${schema.canonical}, but the initializer is a ${actual} container. Use a matching container type.`);
  }
  if (['map', 'object'].includes(expected)) {
    if (value.kind !== 'mapping' && !['map', 'object'].includes(actual)) error(`Expected ${schema.canonical}; a sequence literal cannot replace a key/value container. Use a map/object initializer.`);
  } else if (value.kind === 'mapping' && !(language === 'java' && !value.pairs.length && ['array', 'matrix'].includes(expected))) {
    error(`Expected ${schema.canonical}; a map/object literal cannot replace a sequence container.`);
  } else if (value.setLiteral && expected !== 'set' && language === 'python') {
    error(`Expected ${schema.canonical}; a set literal cannot replace this container.`);
  }
}

function structureFrom(value, name, declaredType, language, warnings, identities, budget = { count: 0 }, depth = 1) {
  if (depth > MAX_STRUCTURE_DEPTH) error('Nested containers support at most 8 levels.');
  const signature = declaredType || value?.typeSignature || (/\[\]$/.test(value?.implementation || '') ? value.implementation : '');
  const schema = signature ? parseStructureType(signature) : null;
  const declaredKind = schema?.structureKind;
  if (value?.kind === 'scalar' || isKnownScalarType(schema)) {
    const scalarType = schema || parseStructureType(value.type === 'number' ? language === 'python' ? 'int' : 'number' : value.type === 'char' ? 'char' : value.type === 'string' ? language === 'python' ? 'str' : 'String' : /^(?:true|false|True|False)$/.test(value.value) ? 'boolean' : value.value === 'None' ? 'NoneType' : value.value);
    if (!isKnownScalarType(scalarType)) error('This scalar type is not supported without a custom type declaration.');
    const data = createStructureForType(scalarType, name);
    if (++budget.count > MAX_STRUCTURE_ENTRIES) error('A container and all of its nested containers support at most 128 units in total.');
    if (value) { if (value.kind !== 'scalar') error('A scalar type cannot contain a collection literal.'); if (value.value.length > 2000) error('A literal cell is too long (2,000 characters for values).'); data.entries[0].value = value.value; }
    return data;
  }
  assertInitializerCompatible(schema, value, language);
  const nestedRows = value?.kind === 'sequence' && value.items.length > 0 && value.items.every(item => item.kind === 'sequence' && item.items.length === value.items[0].items.length && item.items.every(cell => cell.kind === 'scalar')) && !value.structureKind && !declaredKind;
  // Concrete constructors matter: Queue backed by PriorityQueue is a heap,
  // Collection backed by HashSet is a set. LinkedList/Deque retain the declared
  // queue/list role, since these implementations support several interfaces.
  const declaredRole = ['deque', 'doubly-linked-list'].includes(value?.structureKind) && ['queue', 'deque', 'list'].includes(declaredKind) ? declaredKind : null;
  const kind = declaredRole || value?.structureKind || declaredKind || (nestedRows ? 'matrix' : value?.kind === 'mapping' ? language === 'javascript' ? 'object' : 'map' : value?.kind === 'sequence' ? value.setLiteral ? 'set' : language === 'javascript' ? 'array' : 'list' : null);
  if (!kind) error(`Cannot infer a container for ${name}. Use a supported typed declaration or literal collection.`);
  const data = createStructureData(kind); data.name = name; data.implementation = (value?.implementation || declaredType || (language === 'python' ? kind === 'map' ? 'dict' : kind === 'set' ? 'set' : 'list' : kind === 'object' ? 'Object' : 'Array')).slice(0, 120);
  if (schema?.structureKind) data.typeSignature = schema.canonical;
  const types = structureEntryTypes(data);
  const add = (item, key = null) => { const row = literalEntry(item, key, types, language, warnings, budget, depth); data.entries.push(row); return row; };
  if (value && kind === 'matrix') {
    if (value.kind === 'mapping' && !value.pairs.length) value = sequence([]);
    if (value.kind !== 'sequence' || value.items.some(row => row.kind !== 'sequence')) error('A matrix initializer must contain literal rows.');
    data.columns = value.items[0]?.items.length || 4;
    if (data.columns > 16 || value.items.some(row => row.items.length !== data.columns)) error('Matrix rows must have the same length, with at most 16 columns.');
    value.items.forEach(row => row.items.forEach(item => add(item)));
  } else if (value && ['map', 'object'].includes(kind)) {
    const pairs = value.kind === 'mapping' ? value.pairs : value.kind === 'sequence' && value.items.every(item => item.kind === 'sequence' && item.items.length === 2) ? value.items.map(item => item.items) : null;
    if (!pairs) error('Maps require literal key/value pairs.');
    const keys = new Map();
    pairs.forEach(([key, item]) => {
      if (key.kind !== 'scalar' && language === 'python') error('Nested Python map keys are not supported; use scalar keys or edit a key container manually.');
      const identity = key.kind !== 'scalar' && language === 'javascript' ? uid() : keyIdentity(key);
      if (key.kind === 'scalar') rememberIdentity(identities, key);
      if (keys.has(identity)) {
        const index = keys.get(identity), previous = data.entries[index];
        budget.count -= entryUnits(previous);
        data.entries[index] = { ...literalEntry(item, key, types, language, warnings, budget, depth), id: previous.id };
      } else { keys.set(identity, data.entries.length); add(item, key); }
    });
  } else if (value) {
    if (value.kind === 'mapping' && !value.pairs.length) value = sequence([]); // Java's empty {} array literal.
    if (value.kind !== 'sequence') error('This container requires a literal sequence.');
    const unique = new Set();
    value.items.forEach(item => { const identity = keyIdentity(item); if (kind === 'set') { if (item.kind === 'scalar') rememberIdentity(identities, item); if (unique.has(identity) && !(item.kind !== 'scalar' && language === 'javascript')) return; } unique.add(identity); add(item); });
  }
  if (['heap', 'tree', 'bst', 'trie', 'graph', 'union-find'].includes(kind)) warnings.add('Tree/heap/graph relationships and ordering are edited manually; constructors do not run algorithms.');
  if (/Concurrent|Synchronized|synchronized|Blocking|Immutable|unmodifiable|TreeMap|TreeSet|Sorted|Navigable/.test(data.implementation)) warnings.add('Ordering, concurrency and immutability semantics are not executed; the diagram remains manually editable.');
  return data;
}

function entryUnits(entry) { return 1 + (entry.keyContainer ? countStructureEntries(entry.keyContainer) : 0) + (entry.valueContainer ? countStructureEntries(entry.valueContainer) : 0); }

function literalEntry(item, key, types, language, warnings, budget, depth = 1) {
  if (++budget.count > MAX_STRUCTURE_ENTRIES) error('A container and all of its nested containers support at most 128 units in total.');
  const row = { id: uid(), key: '', value: '', annotation: '' };
  for (const [side, literal] of [['key', key], ['value', item]]) {
    if (!literal) continue;
    const expected = types[side];
    if (literal.kind === 'scalar') {
      if (expected?.structureKind && !['null', 'None', 'undefined'].includes(literal.value)) error(`Expected ${expected.canonical} for this ${side}; a scalar literal cannot replace a nested container.`);
      if (literal.value.length > (side === 'key' ? 500 : 2000)) error('A literal cell is too long (2,000 characters for values, 500 for keys).');
      row[side] = literal.value;
    } else {
      if (expected && !expected.structureKind && !['Object','object','Any','any','unknown','?'].includes(expected.name.split('.').at(-1))) error(`Expected scalar ${expected.canonical} for this ${side}; a nested collection would be incompatible.`);
      row[`${side}Container`] = structureFrom(literal, side === 'key' ? 'Key' : 'Value', expected?.structureKind ? expected.canonical : '', language, warnings, new Map(), budget, depth + 1);
    }
  }
  return row;
}

function declaration(tokens, language) {
  const equal = tokens.findIndex(token => token.value === '=');
  const left = (equal < 0 ? tokens : tokens.slice(0, equal)).map(token => token.value);
  const right = equal < 0 ? null : tokens.slice(equal + 1);
  if (['const', 'let', 'var'].includes(left[0]) && (language === 'javascript' || language === 'auto')) {
    if (left.length !== 2 || !/^[A-Za-z_$][\w$]*$/.test(left[1])) error('Use one simple variable declaration at a time.');
    return { name: left[1], type: '', right, language: 'javascript' };
  }
  if (left.length === 1 && /^[A-Za-z_$][\w$]*$/.test(left[0]) && right) return { name: left[0], type: '', right, language: language === 'javascript' ? language : 'python' };
  if (left[1] === ':') {
    if (language === 'java' || language === 'javascript') error('Python type annotations require Python mode.');
    const type = left.slice(2).join('');
    return { name: left[0], type, right, language: 'python' };
  }
  if (language === 'python' || language === 'javascript') error('Unsupported declaration. Paste simple container declarations, not a complete program.');
  while (['final', 'static', 'public', 'private', 'protected'].includes(left[0])) left.shift();
  const suffix = [];
  while (left.at(-1) === ']' && left.at(-2) === '[') { suffix.unshift('[]'); left.splice(-2); }
  const name = left.pop(), type = left.join('') + suffix.join('');
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name) || !type || !/^[\w.$<>?,\[\]]+$/.test(type)) error('Unsupported declaration. Use a known container type and a variable name.');
  if (type !== 'var') { const schema = parseStructureType(type); if (!schema.structureKind && !isKnownScalarType(schema)) error(`Unsupported data type ${type}. Paste its custom class declaration or use a known container.`); }
  return { name, type: type === 'var' ? '' : type, right, language: 'java' };
}

function rememberIdentity(identities, literal) {
  const visible = display(literal), identity = keyIdentity(literal);
  if (identities.has(visible) && identities.get(visible) !== identity) error('Mixed-type keys or set members with the same displayed text are ambiguous. Use distinct text or edit them manually on the canvas.');
  identities.set(visible, identity);
}

function mutate(tokens, structures, semantics) {
  const [variable, dot, method, open] = tokens;
  if (variable?.type !== 'id' || dot?.value !== '.' || method?.type !== 'id' || open?.value !== '(' || tokens.at(-1)?.value !== ')') return false;
  const data = structures.get(variable.value);
  if (!data) error(`Declare ${variable.value} before changing it.`);
  const { language, identities, warnings } = semantics.get(variable.value);
  const reader = new LiteralReader(tokens.slice(3), language); reader.take('('); const args = reader.list(')');
  if (reader.index !== reader.tokens.length) error('Unsupported code after container operation.');
  const kind = data.structureKind, entries = data.entries, op = method.value;
  const count = expected => { if (args.length !== expected) error(`${op} requires ${expected} literal argument${expected === 1 ? '' : 's'}.`); };
  const types = structureEntryTypes(data), budget = { count: countStructureEntries(data) };
  const entry = (item, key = null) => literalEntry(item, key, types, language, warnings, budget);
  const append = (item, front = false) => {
    if (kind === 'set') {
      if (item.kind !== 'scalar') error('Nested set mutation identity is not evaluated. Use a literal initializer or edit the nested container manually.');
      rememberIdentity(identities, item); if (entries.some(entry => !entry.valueContainer && entry.value === item.value)) return;
    }
    const row = entry(item); front ? entries.unshift(row) : entries.push(row);
  };
  if (op === 'clear') { count(0); data.entries = []; data.links = []; data.pointers = []; data.activeEntryId = ''; identities.clear(); return true; }
  if (['put', 'set'].includes(op) && ['map', 'object'].includes(kind)) {
    count(2); if (args[0].kind !== 'scalar') error('Nested map key mutation identity is not evaluated. Use a literal initializer or edit the nested key container manually.');
    const key = display(args[0]); if (key.length > 500) error('A literal key is too long.'); rememberIdentity(identities, args[0]);
    const index = entries.findIndex(item => !item.keyContainer && item.key === key);
    if (index >= 0) { const prior = entries[index]; budget.count -= entryUnits(prior); entries[index] = { ...entry(args[1], args[0]), id: prior.id }; }
    else entries.push(entry(args[1], args[0]));
    return true;
  }
  if (['add', 'append', 'offer', 'enqueue', 'push', 'addLast', 'offerLast', 'appendleft', 'addFirst', 'offerFirst'].includes(op) && !['map', 'object', 'matrix', 'bitset'].includes(kind)) {
    count(1); append(args[0], ['appendleft', 'addFirst', 'offerFirst'].includes(op) || op === 'push' && language === 'java' && ['deque', 'doubly-linked-list'].includes(kind)); return true;
  }
  if (['addAll', 'extend'].includes(op) && !['map', 'object', 'matrix', 'bitset'].includes(kind)) { count(1); if (args[0].kind !== 'sequence') error(`${op} needs a literal sequence.`); args[0].items.forEach(item => append(item)); return true; }
  if (['set', 'insert'].includes(op) && ['array', 'list', 'linked-list', 'doubly-linked-list'].includes(kind)) {
    count(2); const index = args[0]; if (index.kind !== 'scalar' || !/^\d+$/.test(index.value)) error('Use a non-negative literal index.'); const at = +index.value;
    if (at >= entries.length + (op === 'insert' ? 1 : 0)) error('Container index is out of bounds.');
    if (op === 'insert') entries.splice(at, 0, entry(args[1])); else { const prior = entries[at]; budget.count -= entryUnits(prior); entries[at] = { ...entry(args[1]), id: prior.id }; } return true;
  }
  if (['pop', 'poll', 'dequeue', 'popleft', 'removeFirst', 'pollFirst', 'removeLast', 'pollLast', 'shift'].includes(op) && !['map', 'object', 'set', 'matrix', 'bitset'].includes(kind)) {
    if (['heap', 'tree', 'bst', 'trie', 'graph', 'union-find'].includes(kind)) error('Priority ordering and graph algorithms are not executed. Remove units manually on the canvas.');
    count(0); if (!entries.length) error(`Cannot ${op} from an empty container.`);
    const front = ['poll', 'dequeue', 'popleft', 'removeFirst', 'pollFirst', 'shift'].includes(op) || op === 'pop' && ['deque', 'doubly-linked-list'].includes(kind) && language === 'java'; front ? entries.shift() : entries.pop(); return true;
  }
  error(`Unsupported ${op} operation for ${kind}. Use the canvas controls for a manual dry run; runtime algorithms are not executed.`);
}

export function parseStructureCode(source, language = 'auto') {
  if (typeof source !== 'string' || !source.trim()) error('Paste a container declaration or literal initializer.');
  if (source.length > MAX_STRUCTURE_CODE_LENGTH) error('Code input is limited to 20,000 characters.');
  const languages = { auto: 'auto', java: 'java', javascript: 'javascript', js: 'javascript', node: 'javascript', python: 'python', py: 'python' };
  language = languages[language]; if (!language) error('Choose Java, JavaScript / Node, Python, or automatic detection.');
  const custom = tryParseCustomStructureCode(source, language);
  if (custom) return custom;
  // A type by itself is useful when preparing a dry run before values exist.
  if (!/[;={}]/.test(source) && !/\b(?:const|let|var)\b/.test(source)) {
    let schema;
    try { schema = parseStructureType(source); } catch {}
    if (schema?.structureKind || isKnownScalarType(schema)) return { structures: [createStructureForType(schema, schema.name.split('.').at(-1))], warnings: [] };
  }
  const result = new Map(), warnings = new Set(), semantics = new Map();
  for (const tokens of statements(tokenize(source))) {
    const words = tokens.map(token => token.value).join(' ');
    if (/^import java \. util(?: \. concurrent)? \. (?:[A-Za-z]+|\*)$/.test(words) || /^(?:from collections import (?:deque|Counter|OrderedDict)(?: , (?:deque|Counter|OrderedDict))*|import collections)$/.test(words)) {
      warnings.add('Import statements are recognized as text only; no modules are loaded.'); continue;
    }
    if (mutate(tokens, result, semantics)) continue;
    const declarationInfo = declaration(tokens, language);
    if (declarationInfo.name.length > 240) error('Container names are limited to 240 characters.');
    if (result.has(declarationInfo.name)) error(`Duplicate declaration ${declarationInfo.name}. Use supported mutations instead.`);
    if (result.size >= MAX_PARSED_STRUCTURES) error('Import at most 20 containers at a time.');
    const value = declarationInfo.right ? new LiteralReader(declarationInfo.right, declarationInfo.language).all() : null;
    if (language === 'auto' && tokens[0]?.value === 'var' && value?.implementation && !['Array', 'Map', 'Set', 'Object'].includes(value.implementation) && aliases.has(value.implementation) && /^[A-Z]/.test(value.implementation) && !/Array$/.test(value.implementation)) declarationInfo.language = 'java';
    const identities = new Map();
    const data = structureFrom(value, declarationInfo.name, declarationInfo.type, declarationInfo.language, warnings, identities);
    result.set(data.name, data);
    semantics.set(data.name, { language: declarationInfo.language, identities, warnings });
  }
  if (!result.size) error('No supported container declarations were found.');
  return { structures: [...result.values()], warnings: [...warnings] };
}
