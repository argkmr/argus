// Field-only custom shapes. This reads declarations, never executes class bodies.
import { createStructureData, cleanStructureData, MAX_STRUCTURE_ENTRIES } from './diagram-structures.mjs';
import { parseStructureType, createStructureForType } from './diagram-structure-types.mjs';

const fail = message => { throw new Error(message); };
const scalarNames = new Set(['byte','short','int','long','float','double','boolean','char','String','Integer','Long','Short','Byte','Float','Double','Boolean','Character','Number','BigInteger','BigDecimal','UUID','Date','Instant','LocalDate','LocalDateTime','Object','object','str','bool','bytes','complex','Any','any','unknown','string','number','bigint','symbol','None']);
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|#).*$/gm, '');
function splitFields(text, separator) {
  const parts = []; let start = 0, depth = 0;
  for (let index = 0; index < text.length; index++) {
    if ('<[{('.includes(text[index])) depth++;
    if ('>]})'.includes(text[index])) depth--;
    if (depth < 0) fail('Custom field brackets are not balanced.');
    if (text[index] === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  if (depth) fail('Custom field brackets are not balanced.');
  parts.push(text.slice(start)); return parts.map(part => part.trim()).filter(Boolean);
}
function fieldType(text, field) {
  const schema = parseStructureType(text);
  const check = type => {
    if (!type.structureKind && !scalarNames.has(type.name.split('.').at(-1))) fail(`Field ${field}: ${type.name} has no field definition here. Use a supported value type or visualize that custom class separately; its shape will not be guessed.`);
    type.arguments.forEach(check);
  };
  check(schema); return schema;
}

/** Returns null for ordinary container declarations so the literal reader handles them. */
export function tryParseCustomStructureCode(raw, language = 'auto') {
  if (typeof raw !== 'string' || !/^\s*(?:(?:public|final|export|abstract)\s+|@dataclass\s*)*(?:class|record|interface|type)\s+\w/.test(raw)) return null;
  if (raw.length > 20_000) fail('Custom type declarations are limited to 20,000 characters.');
  const source = stripComments(raw).trim();
  let name, fields, style;
  const record = source.match(/^(?:(?:public|final)\s+)*record\s+(\w+)\s*\(([\s\S]*)\)\s*(?:\{\s*\}|;)?$/);
  const python = source.match(/^(?:@dataclass\s*)?class\s+(\w+)[ \t]*:[ \t]*\r?\n([\s\S]*)$/);
  const brace = source.match(/^(?:(?:public|final|export|abstract)\s+)*(class|interface|type)\s+(\w+)\s*(?:=\s*)?\{([\s\S]*)\}\s*;?$/);
  if (record) { name = record[1]; fields = splitFields(record[2], ','); style = 'java'; }
  else if (python) {
    name = python[1];
    const lines = python[2].split('\n').filter(line => line.trim());
    const indent = lines[0]?.match(/^[ \t]+/)?.[0];
    if (!indent || lines.some(line => line.match(/^[ \t]*/)?.[0] !== indent)) fail('Paste one Python class with consistently indented fields. Dedented statements and nested blocks are not class fields.');
    fields = lines.map(line => line.trim()).filter(line => line !== 'pass'); style = 'annotated';
  }
  else if (brace) { name = brace[2]; fields = splitFields(brace[3], ';'); style = brace[1] === 'class' && language !== 'javascript' ? 'java' : 'annotated'; }
  else fail('Use one field-only class, record, or interface declaration. Methods, inheritance, decorators, and executable initializers are not interpreted.');
  if (name.length > 240) fail('Custom type names are limited to 240 characters.');
  if (fields.length > MAX_STRUCTURE_ENTRIES) fail('A custom shape supports at most 128 fields.');
  const data = createStructureData('object'); data.name = name; data.implementation = name;
  const names = new Set();
  for (const declaration of fields) {
    const text = declaration.replace(/^(?:(?:public|private|protected|final|readonly)\s+)*/, '').trim();
    if (/[={}()]/.test(text)) fail('Use field declarations without initializers or methods. Values can be entered in the canvas after creating the shape.');
    const match = style === 'java' ? text.match(/^(.+?)\s+([A-Za-z_$][\w$]*)((?:\[\])*)$/) : text.match(/^([A-Za-z_$][\w$]*)\s*:\s*(.+)$/);
    if (!match) fail(`Cannot determine the type of field ${JSON.stringify(text)}. Add an explicit field type; no fields have been skipped.`);
    const key = style === 'java' ? match[2] : match[1], type = style === 'java' ? match[1] + (match[3] || '') : match[2];
    if (key.length > 500) fail('Custom field names are limited to 500 characters.');
    if (names.has(key)) fail(`Field ${key} is declared more than once.`);
    names.add(key);
    const schema = fieldType(type, key);
    const entry = { id: globalThis.crypto.randomUUID(), key, value: '', annotation: schema.canonical };
    if (schema.structureKind) entry.valueContainer = createStructureForType(schema, key);
    data.entries.push(entry);
  }
  return { structures: [cleanStructureData(data)], warnings: ['Field shape only. Constructors, methods, runtime instances, and recursive object references are not executed.'] };
}
