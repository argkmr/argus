const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const metadata = new WeakMap();
const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));
const checkSignal = signal => { if (signal?.aborted) throw new DOMException("JSON operation cancelled", "AbortError"); };
const childPath = (parent, key, array) => array ? `${parent}[${key}]` : IDENTIFIER.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
const syntaxError = position => new SyntaxError(`Invalid JSON at position ${position}`);

// Checkpoints count source characters, not matching nodes: even a large string
// or a document without search matches must let the UI process cancellation.
function* sourceTokens(source, batchSize, startOffset, endOffset) {
  let position = startOffset, checkpoint = startOffset + batchSize;
  while (position < endOffset) {
    if (position >= checkpoint) { yield null; checkpoint = position + batchSize; }
    const start = position, character = source[position];
    if (character === " " || character === "\t" || character === "\r" || character === "\n") { position++; continue; }
    if ("{}[],:".includes(character)) { position++; yield { type: character, start, end: position }; continue; }
    if (character === '"') {
      position++;
      let closed = false;
      while (position < endOffset) {
        if (position >= checkpoint) { yield null; checkpoint = position + batchSize; }
        const next = source[position++];
        if (next === '"') { closed = true; break; }
        if (next.charCodeAt(0) < 32) throw syntaxError(position - 1);
        if (next === "\\") {
          const escape = source[position++];
          if (escape === "u") {
            if (!/^[\da-fA-F]{4}$/.test(source.slice(position, position + 4))) throw syntaxError(position);
            position += 4;
          } else if (!escape || !'"\\/bfnrt'.includes(escape)) throw syntaxError(position - 1);
        }
      }
      if (!closed) throw syntaxError(start);
      yield { type: "string", start, end: position }; continue;
    }
    while (position < endOffset && !/[\s{}\[\],:"]/.test(source[position])) {
      position++;
      if (position >= checkpoint) { yield null; checkpoint = position + batchSize; }
    }
    const token = source.slice(start, position);
    const type = token === "null" ? "null" : token === "true" || token === "false" ? "boolean"
      : /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token) ? "number" : null;
    if (!type) throw syntaxError(start);
    yield { type, start, end: position };
  }
}

/**
 * Index an unmodified JSON source. Ranges are half-open UTF-16 offsets; key and
 * string value ranges include their quotes, and composite values include the
 * complete object/array. Only the last occurrence of a duplicate object key and
 * its descendants survive, matching JSON.parse. No recursive calls are used.
 * Outer whitespace follows the explorer's JSON.parse(source.trim()) behavior,
 * including BOM-prefixed files, without shifting the original source offsets.
 */
export async function indexJsonSource(source, { signal, yieldWork = yieldToUi, batchSize = 1000 } = {}) {
  source = String(source);
  batchSize = Number.isFinite(batchSize) && batchSize > 0 ? Math.max(1, Math.floor(batchSize)) : 1000;
  checkSignal(signal);
  const stack = [];
  let root = null;
  // Lexing is cheaper than constructing a node/path. Chunk it by characters
  // without scheduling thousands of tiny timers for a moderately sized JSON.
  const characterBatch = Math.min(65536, batchSize * 32);
  const startOffset = source.length - source.trimStart().length;
  const endOffset = source.trimEnd().length;
  for (const token of sourceTokens(source, characterBatch, startOffset, endOffset)) {
    if (!token) { await yieldWork(); checkSignal(signal); continue; }
    const frame = stack.at(-1);
    if (frame?.state === "key" || frame?.state === "keyOrEnd") {
      if (token.type === "}" && frame.state === "keyOrEnd") {
        frame.node.value.end = token.end; stack.pop(); continue;
      }
      if (token.type !== "string") throw syntaxError(token.start);
      frame.key = JSON.parse(source.slice(token.start, token.end));
      frame.keyRange = { start: token.start, end: token.end }; frame.state = "colon"; continue;
    }
    if (frame?.state === "colon") {
      if (token.type !== ":") throw syntaxError(token.start);
      frame.state = "value"; continue;
    }
    if (frame?.state === "commaOrEnd") {
      if (token.type === (frame.array ? "]" : "}")) {
        frame.node.value.end = token.end; stack.pop(); continue;
      }
      if (token.type !== ",") throw syntaxError(token.start);
      frame.state = frame.array ? "value" : "key"; continue;
    }
    if (frame?.state === "valueOrEnd" && token.type === "]") {
      frame.node.value.end = token.end; stack.pop(); continue;
    }
    if (!frame && root) throw syntaxError(token.start);
    const array = token.type === "[", composite = array || token.type === "{";
    if (!composite && !["string", "number", "boolean", "null"].includes(token.type)) throw syntaxError(token.start);
    const node = { key: frame && !frame.array ? frame.keyRange : null,
      value: { start: token.start, end: token.end }, type: composite ? array ? "array" : "object" : token.type,
      children: composite ? new Map() : null };
    if (frame) {
      frame.node.children.set(frame.array ? frame.index++ : frame.key, node);
      frame.state = "commaOrEnd";
    } else root = node;
    if (composite) stack.push({ node, array, index: 0, state: array ? "valueOrEnd" : "keyOrEnd" });
  }
  if (!root || stack.length) throw syntaxError(source.length);
  checkSignal(signal);
  const ranges = new Map();
  const visit = [{ node: root, path: "$", key: "$", iterator: null }];
  let visited = 0;
  while (visit.length) {
    const frame = visit.at(-1);
    if (!frame.iterator) {
      const record = { path: frame.path, key: frame.node.key, value: frame.node.value };
      ranges.set(frame.path, record);
      metadata.set(record, { type: frame.node.type, size: frame.node.children?.size, key: String(frame.key) });
      frame.iterator = frame.node.children?.entries() || [][Symbol.iterator]();
      if (++visited % batchSize === 0) { await yieldWork(); checkSignal(signal); }
    }
    const next = frame.iterator.next();
    if (next.done) { visit.pop(); continue; }
    const [key, node] = next.value;
    visit.push({ node, key, path: childPath(frame.path, key, frame.node.type === "array"), iterator: null });
  }
  return ranges;
}

function tokenMatchRanges(source, range, needle, stringToken) {
  const raw = source.slice(range.start, range.end);
  const text = stringToken ? JSON.parse(raw) : String(JSON.parse(raw));
  const folded = text.toLocaleLowerCase();
  if (!folded.includes(needle)) return [];
  // Ordinary JSON strings need only a constant offset. Avoid allocating two
  // per-character span arrays (and lowercasing every character separately) for
  // large ASCII response bodies; escapes and Unicode retain the mapped path.
  if (stringToken && !raw.includes("\\") && /^[\x20-\x7e]*$/.test(text)) {
    const ranges = [];
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
      ranges.push({ start: range.start + 1 + at, end: range.start + 1 + at + needle.length });
    }
    return ranges;
  }
  if (!stringToken) {
    const literal = raw.toLocaleLowerCase(), ranges = [];
    for (let at = literal.indexOf(needle); at >= 0; at = literal.indexOf(needle, at + needle.length)) {
      ranges.push({ start: range.start + at, end: range.start + at + needle.length });
    }
    return ranges.length ? ranges : [range];
  }
  const original = [];
  for (let position = range.start + 1; position < range.end - 1;) {
    const start = position;
    if (source[position++] === "\\") position += source[position] === "u" ? 5 : 1;
    original.push({ start, end: position });
  }
  const foldedPositions = [];
  let offset = 0;
  for (const point of text) {
    const span = { start: original[offset].start, end: original[offset + point.length - 1].end };
    for (let unit = 0; unit < point.toLocaleLowerCase().length; unit++) foldedPositions.push(span);
    offset += point.length;
  }
  // Some locales have contextual case mappings. If folding changes its length
  // differently in context, keep the whole token highlighted rather than mark
  // unrelated characters with inaccurate offsets.
  if (foldedPositions.length !== folded.length) return [range];
  const ranges = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    ranges.push({ start: foldedPositions[at].start, end: foldedPositions[at + needle.length - 1].end });
  }
  return ranges;
}

/** Return safe source offsets, never HTML, for one structural search result. */
export function jsonSourceMatchRanges(source, record, query, scope = "all") {
  source = String(source);
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!record || !needle) return [];
  const meta = metadata.get(record);
  const first = source[record.value.start], composite = first === "{" || first === "[";
  const valueAnchor = composite ? { start: record.value.start, end: record.value.start + 1 } : record.value;
  if (scope === "paths") return record.path.toLocaleLowerCase().includes(needle) ? [record.key || valueAnchor] : [];
  const ranges = [];
  if (scope === "all" || scope === "keys") {
    if (record.key) ranges.push(...tokenMatchRanges(source, record.key, needle, true));
    else {
      const key = meta?.key || (record.path === "$" ? "$" : record.path.match(/\[(\d+)\]$/)?.[1] || "");
      if (key.toLocaleLowerCase().includes(needle)) ranges.push(valueAnchor);
    }
  }
  if (scope === "all" || scope === "values") {
    if (!composite) ranges.push(...tokenMatchRanges(source, record.value, needle, first === '"'));
    else if (meta && `${meta.type} ${meta.size}`.toLocaleLowerCase().includes(needle)) ranges.push(valueAnchor);
  }
  return ranges.sort((left, right) => left.start - right.start).filter((range, index, all) => !index || range.start !== all[index - 1].start || range.end !== all[index - 1].end);
}
