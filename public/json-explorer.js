import { indexJsonSource, jsonSourceMatchRanges } from "./json-source-ranges.mjs?v=20261027-404";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function childJsonPath(parent, key, arrayParent = false) {
  if (arrayParent || typeof key === "number") return `${parent}[${key}]`;
  return IDENTIFIER.test(String(key)) ? `${parent}.${key}` : `${parent}[${JSON.stringify(String(key))}]`;
}

export function jsonValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function jsonDocumentStats(value) {
  let nodes = 0, maxDepth = 0;
  for (const item of walkJsonDocument(value, false)) { nodes++; maxDepth = Math.max(maxDepth, item.depth); }
  return { nodes, maxDepth };
}

// Iterator frames visit one child at a time: neither nesting depth nor one huge
// array creates recursive calls or a stack containing every descendant.
function* walkJsonDocument(value, paths = true) {
  const stack = [{ entry: value, key: "$", path: "$", depth: 0, parent: null }];
  while (stack.length) {
    const item = stack.at(-1);
    if (!item.visited) {
      item.visited = true; yield item;
      item.keys = item.entry && typeof item.entry === "object" ? Object.keys(item.entry) : [];
      item.index = 0;
    }
    if (item.index >= item.keys.length) { stack.pop(); continue; }
    const key = item.keys[item.index++], array = Array.isArray(item.entry);
    stack.push({ entry: item.entry[key], key, depth: item.depth + 1, parent: paths ? item : null,
      path: paths ? childJsonPath(item.path, array ? Number(key) : key, array) : "" });
  }
}

const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));
const checkSignal = signal => { if (signal?.aborted) throw new DOMException("JSON operation cancelled", "AbortError"); };

export async function jsonDocumentStatsAsync(value, { signal, yieldWork = yieldToUi, batchSize = 1000 } = {}) {
  let nodes = 0, maxDepth = 0;
  checkSignal(signal);
  for (const item of walkJsonDocument(value, false)) {
    nodes++; maxDepth = Math.max(maxDepth, item.depth);
    if (nodes % batchSize === 0) { await yieldWork(); checkSignal(signal); }
  }
  return { nodes, maxDepth };
}

function searchableValue(value) {
  if (value === null) return "null";
  if (typeof value === "object") return Array.isArray(value) ? `array ${value.length}` : `object ${Object.keys(value).length}`;
  return String(value);
}

export function searchJsonDocument(value, query, scope = "all") {
  return [...jsonMatches(value, query, scope)];
}

function* jsonMatches(value, query, scope, withSegments = false) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return;
  for (const item of walkJsonDocument(value)) {
    const { entry, path, key } = item;
    const keyText = String(key);
    const valueText = searchableValue(entry);
    const keyMatch = keyText.toLocaleLowerCase().includes(needle);
    const valueMatch = valueText.toLocaleLowerCase().includes(needle);
    const pathMatch = path.toLocaleLowerCase().includes(needle);
    const matched = scope === "keys" ? keyMatch : scope === "values" ? valueMatch : scope === "paths" ? pathMatch : keyMatch || valueMatch;
    if (matched) {
      const match = { path, key: keyText, value: valueText, type: jsonValueType(entry) };
      if (withSegments) {
        const segments = []; for (let parent = item; parent.parent; parent = parent.parent) segments.push(parent.key);
        match.segments = segments.reverse();
      }
      yield match;
    } else if (withSegments) {
      // Async callers yield by visited nodes, not just matches; a query with zero
      // matches must also leave the input responsive.
      yield null;
    }
  }
}

export async function searchJsonDocumentAsync(value, query, scope = "all", { signal, yieldWork = yieldToUi, batchSize = 500 } = {}) {
  const matches = []; let visited = 0;
  checkSignal(signal);
  for (const match of jsonMatches(value, query, scope, true)) {
    if (match) matches.push(match);
    if (++visited % batchSize === 0) { await yieldWork(); checkSignal(signal); }
  }
  return matches;
}

export function jsonParseError(message, source) {
  const position = Number(String(message || "").match(/position\s+(\d+)/i)?.[1]);
  if (!Number.isFinite(position)) return { message: String(message || "Invalid JSON"), line: null, column: null };
  const before = String(source).slice(0, position);
  const lines = before.split("\n");
  return { message: String(message), line: lines.length, column: lines.at(-1).length + 1 };
}

function formattedBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function primitiveLabel(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function saveTextFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export class JsonExplorer {
  constructor(root, { notify = () => {} } = {}) {
    this.root = root;
    this.notify = notify;
    this.value = null;
    this.hasDocument = false;
    this.rows = new Map();
    this.matches = [];
    this.matchIndex = -1;
    this.parseTimer = null;
    this.searchTimer = null;
    this.workController = null;
    this.searchController = null;
    this.expandRevision = 0;
    this.documentRevision = 0;
    this.currentMatchRow = null;
    this.highlightedRows = new Set();
    this.matchPaths = new Set();
    this.view = "tree";
    this.codeHighlights = new Map();
    this.currentCodeMarks = [];
    this.codeRenderRevision = 0;
    this.sourceIndex = null;
    this.indexedSource = null;
    this.searchQuery = "";
    this.searchScope = "all";
    this.source = root.querySelector("#json-source-input");
    this.tree = root.querySelector("#json-tree-view");
    this.code = root.querySelector("#json-code-view");
    this.bind();
  }

  bind() {
    this.source.addEventListener("input", () => {
      this.cancelWork();
      this.clearMatches(false);
      clearTimeout(this.parseTimer);
      this.parseTimer = setTimeout(() => this.parse(), 160);
    });
    this.root.querySelector("#json-open-file").addEventListener("click", () => this.root.querySelector("#json-file-input").click());
    this.root.querySelector("#json-file-input").addEventListener("change", (event) => this.openFile(event.target.files?.[0]));
    this.root.querySelector("#json-paste").addEventListener("click", () => this.paste());
    this.root.querySelector("#json-clear").addEventListener("click", () => this.clear());
    this.root.querySelector("#json-format").addEventListener("click", () => this.rewrite(2));
    this.root.querySelector("#json-minify").addEventListener("click", () => this.rewrite(0));
    this.root.querySelector("#json-expand-all").addEventListener("click", () => this.setExpanded(true));
    this.root.querySelector("#json-collapse-all").addEventListener("click", () => this.setExpanded(false));
    this.root.querySelector("#json-copy").addEventListener("click", () => this.copyJson());
    this.root.querySelector("#json-download").addEventListener("click", () => this.download());
    this.root.querySelectorAll("[data-json-view]").forEach((button) => button.addEventListener("click", () => this.setView(button.dataset.jsonView)));
    this.root.querySelector("#json-open-search").addEventListener("click", () => this.openSearch());
    this.root.querySelector("#json-close-search").addEventListener("click", () => this.closeSearch());
    this.root.querySelector("#json-search-input").addEventListener("input", () => this.scheduleSearch());
    this.root.querySelector("#json-search-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); this.moveMatch(event.shiftKey ? -1 : 1); }
      if (event.key === "Escape") { event.preventDefault(); this.closeSearch(); }
    });
    this.root.querySelector("#json-search-scope").addEventListener("change", () => this.search());
    this.root.querySelector("#json-search-previous").addEventListener("click", () => this.moveMatch(-1));
    this.root.querySelector("#json-search-next").addEventListener("click", () => this.moveMatch(1));
    this.tree.addEventListener("click", (event) => {
      const copy = event.target.closest("[data-copy-json-path]");
      if (copy) { event.preventDefault(); event.stopPropagation(); this.copyPath(copy.dataset.copyJsonPath); return; }
      const row = event.target.closest("[data-json-path]");
      if (row) this.root.querySelector("#json-active-path").textContent = row.dataset.jsonPath;
    });
    document.addEventListener("keydown", (event) => {
      if (this.root.classList.contains("hidden")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") { event.preventDefault(); this.openSearch(); }
    });
  }

  show() {
    if (!this.source.value) this.source.focus();
  }

  parse() {
    this.cancelWork();
    clearTimeout(this.parseTimer);
    this.workController = new AbortController();
    const text = this.source.value.trim();
    this.root.querySelector("#json-document-size").textContent = formattedBytes(new TextEncoder().encode(this.source.value).length);
    if (!text) { this.resetDocument(); return; }
    try {
      this.value = JSON.parse(text);
      this.hasDocument = true;
      this.source.classList.remove("invalid");
      const validation = this.root.querySelector("#json-validation-state");
      validation.className = "valid";
      validation.textContent = "Valid JSON";
      this.root.querySelector("#json-error-location").textContent = "Parsed locally";
    } catch (error) {
      this.hasDocument = false;
      this.source.classList.add("invalid");
      const detail = jsonParseError(error.message, this.source.value);
      const validation = this.root.querySelector("#json-validation-state");
      validation.className = "invalid";
      validation.textContent = "Invalid JSON";
      this.root.querySelector("#json-error-location").textContent = detail.line ? `Line ${detail.line}, column ${detail.column} · ${detail.message}` : detail.message;
      this.root.querySelector("#json-document-stats").textContent = "Fix the syntax error to render the hierarchy";
      this.rows.clear();
      this.tree.replaceChildren(this.emptyState("!", "JSON could not be parsed", detail.message));
      this.code.textContent = this.source.value;
      this.clearMatches();
      return;
    }
    this.render();
  }

  render() {
    this.rows.clear();
    this.tree.replaceChildren();
    this.renderNode(this.tree, "$", this.value, "$", 0, false);
    // Preserve the original representation; pretty-print only on explicit Format.
    this.code.textContent = this.source.value;
    const signal = this.workController.signal;
    this.root.querySelector("#json-document-stats").textContent = "Counting nodes…";
    void jsonDocumentStatsAsync(this.value, { signal }).then(stats => {
      if (!signal.aborted) this.root.querySelector("#json-document-stats").textContent = `${stats.nodes.toLocaleString()} nodes · ${stats.maxDepth} levels · ${jsonValueType(this.value)}`;
    }).catch(error => { if (error.name !== "AbortError") this.notify(error.message, "error"); });
    this.root.querySelector("#json-active-path").textContent = "$";
    this.search();
  }

  renderNode(parent, key, value, path, depth, arrayParent) {
    const type = jsonValueType(value);
    const composite = type === "object" || type === "array";
    if (composite) {
      const details = document.createElement("details");
      details.className = `json-tree-node json-tree-branch type-${type}`;
      details.dataset.jsonPath = path;
      details.style.setProperty("--json-depth", depth);
      details.open = depth === 0;
      const summary = document.createElement("summary");
      summary.className = "json-tree-row";
      summary.append(this.keyElement(key, path, depth === 0));
      const count = type === "array" ? value.length : Object.keys(value).length;
      const badge = document.createElement("span");
      badge.className = "json-tree-count";
      badge.textContent = type === "array" ? `[ ${count} items ]` : `{ ${count} keys }`;
      summary.append(badge, this.pathButton(path));
      details.append(summary);
      const children = document.createElement("div");
      children.className = "json-tree-children";
      details.append(children);
      parent.append(details);
      const record = { row: summary, node: details, details, children, value, path, depth, keys: null, positions: null, rendered: new Map(), indices: [], nextIndex: 0, more: null };
      this.rows.set(path, record); this.highlight(record, path);
      details.addEventListener("toggle", () => { if (details.open && !record.rendered.size && this.rows.get(path) === record) this.loadChildren(record); });
      if (details.open) this.loadChildren(record);
      return record;
    }
    const row = document.createElement("div");
    row.className = `json-tree-row json-tree-leaf type-${type}`;
    row.dataset.jsonPath = path;
    row.style.setProperty("--json-depth", depth);
    row.append(this.keyElement(key, path, depth === 0));
    const separator = document.createElement("span");
    separator.className = "json-tree-separator";
    separator.textContent = ":";
    const output = document.createElement("span");
    output.className = "json-tree-value";
    output.textContent = primitiveLabel(value);
    output.title = primitiveLabel(value);
    row.append(separator, output, this.pathButton(path));
    parent.append(row);
    const record = { row, node: row, details: null };
    this.rows.set(path, record); this.highlight(record, path);
    return record;
  }

  highlight(record, path) {
    if (this.matchPaths.has(path)) { record.row.classList.add("search-match"); this.highlightedRows.add(record.row); }
  }

  ensureChild(record, key) {
    if (record.rendered.has(key)) return record.rendered.get(key);
    record.keys ||= Object.keys(record.value);
    record.positions ||= new Map(record.keys.map((key, index) => [key, index]));
    const index = record.positions.get(String(key));
    if (index === undefined) return null;
    const array = Array.isArray(record.value), numericKey = array ? Number(key) : key;
    const child = this.renderNode(record.children, numericKey, record.value[key], childJsonPath(record.path, numericKey, array), record.depth + 1, array);
    child.index = index; record.rendered.set(String(key), child);
    // Search can reveal a distant child without rendering every earlier sibling.
    let low = 0, high = record.indices.length;
    while (low < high) { const middle = (low + high) >>> 1; if (record.indices[middle] < index) low = middle + 1; else high = middle; }
    const next = record.rendered.get(record.keys[record.indices[low]])?.node || record.more;
    record.indices.splice(low, 0, index);
    if (next) record.children.insertBefore(child.node, next);
    return child;
  }

  loadChildren(record, batch = 100) {
    record.keys ||= Object.keys(record.value);
    const end = Math.min(record.keys.length, record.nextIndex + batch);
    while (record.nextIndex < end) this.ensureChild(record, record.keys[record.nextIndex++]);
    record.more?.remove(); record.more = null;
    if (record.nextIndex < record.keys.length) {
      const more = document.createElement("button"); more.type = "button"; more.className = "json-load-more";
      more.textContent = `Show next ${Math.min(100, record.keys.length - record.nextIndex)} of ${record.keys.length.toLocaleString()} items`;
      more.addEventListener("click", () => this.loadChildren(record)); record.children.append(more); record.more = more;
    }
  }

  cancelWork() {
    this.workController?.abort(); this.searchController?.abort();
    ++this.codeRenderRevision;
    this.sourceIndex = null; this.indexedSource = null;
    clearTimeout(this.searchTimer); ++this.expandRevision; ++this.documentRevision;
  }

  keyElement(key, path, root) {
    const element = document.createElement("span");
    element.className = "json-tree-key";
    element.textContent = root ? "$ root" : String(key);
    element.title = path;
    return element;
  }

  pathButton(path) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "json-path-copy";
    button.dataset.copyJsonPath = path;
    button.textContent = "Copy path";
    button.title = `Copy ${path}`;
    return button;
  }

  emptyState(icon, title, message) {
    const box = document.createElement("div");
    box.className = "json-empty-state";
    const symbol = document.createElement("span"); symbol.textContent = icon;
    const strong = document.createElement("strong"); strong.textContent = title;
    const copy = document.createElement("p"); copy.textContent = message;
    box.append(symbol, strong, copy);
    return box;
  }

  resetDocument() {
    this.cancelWork(); clearTimeout(this.parseTimer);
    this.value = null;
    this.hasDocument = false;
    this.rows.clear();
    this.source.classList.remove("invalid");
    const validation = this.root.querySelector("#json-validation-state");
    validation.className = "empty";
    validation.textContent = "Waiting for JSON";
    this.root.querySelector("#json-error-location").textContent = "";
    this.root.querySelector("#json-document-stats").textContent = "No document loaded";
    this.root.querySelector("#json-active-path").textContent = "$";
    this.tree.replaceChildren(this.emptyState("{ }", "Paste or open JSON to explore it", "Objects and arrays become collapsible branches. Values remain selectable and copyable."));
    this.code.textContent = "";
    this.clearMatches();
  }

  clear() {
    this.source.value = "";
    this.root.querySelector("#json-input-name").textContent = "Unsaved document";
    this.resetDocument();
    this.source.focus();
  }

  async paste() {
    this.cancelWork(); const revision = this.documentRevision;
    try {
      const text = await navigator.clipboard.readText();
      if (revision !== this.documentRevision) return;
      this.source.value = text;
      this.root.querySelector("#json-input-name").textContent = "Clipboard";
      this.parse();
    } catch { this.notify("Clipboard access was denied. Focus the editor and press Cmd+V.", "error"); }
  }

  async openFile(file) {
    if (!file) return;
    this.cancelWork(); const revision = this.documentRevision;
    try {
      const text = await file.text();
      if (revision !== this.documentRevision) return;
      this.source.value = text;
      this.root.querySelector("#json-input-name").textContent = file.name;
      this.parse();
    } catch { this.notify("Argus could not read that JSON file", "error"); }
    this.root.querySelector("#json-file-input").value = "";
  }

  rewrite(spaces) {
    if (!this.hasDocument) return this.notify("Paste valid JSON first", "error");
    try { this.source.value = JSON.stringify(this.value, null, spaces || undefined); this.parse(); }
    catch { this.notify("This document is too deeply nested to reformat. Its original text is unchanged.", "error"); }
  }

  async setExpanded(expanded) {
    const revision = ++this.expandRevision;
    for (const record of this.rows.values()) {
      if (revision !== this.expandRevision) return;
      if (!record.details) continue;
      record.details.open = expanded;
      if (expanded) do {
        this.loadChildren(record); await yieldToUi();
        if (revision !== this.expandRevision) return;
      } while (record.more);
    }
  }

  setView(view) {
    const code = view === "code";
    this.view = code ? "code" : "tree";
    this.tree.classList.toggle("hidden", code);
    this.code.classList.toggle("hidden", !code);
    this.root.querySelectorAll("[data-json-view]").forEach((button) => button.classList.toggle("active", button.dataset.jsonView === view));
    if (code) void this.renderCodeMatches();
    else { ++this.codeRenderRevision; this.updateMatch(); }
  }

  async renderCodeMatches() {
    const revision = ++this.codeRenderRevision;
    const source = this.source.value, matches = this.matches;
    const signal = this.searchController?.signal;
    const current = () => revision === this.codeRenderRevision && !signal?.aborted
      && this.source.value === source && this.matches === matches && this.view === "code";
    if (!this.hasDocument || !matches.length) return;
    try {
      if (!this.sourceIndex || this.indexedSource !== source) {
        const index = await indexJsonSource(source, { signal });
        if (!current()) return;
        this.sourceIndex = index; this.indexedSource = source;
      }
      const ranges = [];
      for (let index = 0; index < matches.length; index++) {
        const record = this.sourceIndex.get(matches[index].path);
        if (record) {
          let spans = jsonSourceMatchRanges(source, record, this.searchQuery, this.searchScope);
          // Array indices, the synthetic root, or a JSONPath may not be literal
          // source text. Identify that node by its key or first value character.
          if (!spans.length) spans = [record.key || { start: record.value.start, end: record.value.start + 1 }];
          for (const range of spans) ranges.push({ ...range, index });
        }
        if (index % 500 === 499) { await yieldToUi(); if (!current()) return; }
      }
      ranges.sort((a, b) => a.start - b.start || a.end - b.end);
      const fragment = document.createDocumentFragment(), marks = new Map();
      let cursor = 0, rendered = 0;
      for (const range of ranges) {
        const start = Math.max(cursor, range.start);
        if (range.end <= start) continue;
        if (start > cursor) fragment.append(document.createTextNode(source.slice(cursor, start)));
        const mark = document.createElement("mark");
        mark.className = "json-search-highlight";
        mark.dataset.jsonMatchIndex = String(range.index);
        mark.textContent = source.slice(start, range.end);
        fragment.append(mark);
        if (!marks.has(range.index)) marks.set(range.index, []);
        marks.get(range.index).push(mark);
        cursor = range.end;
        if (++rendered % 500 === 0) { await yieldToUi(); if (!current()) return; }
      }
      fragment.append(document.createTextNode(source.slice(cursor)));
      if (!current()) return;
      this.code.replaceChildren(fragment);
      this.codeHighlights = marks;
      this.currentCodeMarks = [];
      this.updateMatch();
    } catch (error) {
      if (current() && error.name !== "AbortError") {
        this.updateMatch();
        this.notify("Could not highlight this JSON search. Try the Tree view.", "error");
      }
    }
  }

  openSearch() {
    this.root.querySelector("#json-search-bar").classList.remove("hidden");
    const input = this.root.querySelector("#json-search-input");
    input.focus();
    input.select();
  }

  closeSearch() {
    this.root.querySelector("#json-search-bar").classList.add("hidden");
    this.clearMatches();
  }

  scheduleSearch() {
    this.searchController?.abort(); clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { void this.search(); }, 120);
  }

  async search() {
    this.searchController?.abort(); clearTimeout(this.searchTimer);
    const controller = new AbortController(); this.searchController = controller;
    this.clearMatches(false);
    const query = this.root.querySelector("#json-search-input").value;
    const scope = this.root.querySelector("#json-search-scope").value;
    this.searchQuery = query;
    this.searchScope = scope;
    if (!this.hasDocument || !query.trim()) return;
    this.root.querySelector("#json-search-count").textContent = "Searching…";
    let matches;
    try { matches = await searchJsonDocumentAsync(this.value, query, scope, { signal: controller.signal }); }
    catch (error) { if (error.name !== "AbortError") this.notify(error.message, "error"); return; }
    if (controller.signal.aborted) return;
    this.matches = matches;
    this.matchPaths = new Set(this.matches.map(match => match.path));
    this.rows.forEach((record, path) => this.highlight(record, path));
    this.matchIndex = this.matches.length ? 0 : -1;
    if (this.view === "code" && this.matches.length) await this.renderCodeMatches();
    else this.updateMatch();
  }

  clearMatches(reset = true) {
    if (reset) { this.searchController?.abort(); clearTimeout(this.searchTimer); }
    this.highlightedRows.forEach(row => row.classList.remove("search-match")); this.highlightedRows.clear(); this.matchPaths.clear();
    this.currentMatchRow?.classList.remove("current-match"); this.currentMatchRow = null;
    ++this.codeRenderRevision;
    if (this.codeHighlights.size) this.code.textContent = this.source.value;
    this.codeHighlights.clear(); this.currentCodeMarks = [];
    if (reset) this.root.querySelector("#json-search-input").value = "";
    this.matches = [];
    this.matchIndex = -1;
    this.root.querySelector("#json-search-count").textContent = "0 results";
    this.root.querySelector("#json-active-path").textContent = "$";
    this.root.querySelector("#json-search-previous").disabled = true;
    this.root.querySelector("#json-search-next").disabled = true;
  }

  moveMatch(offset) {
    if (!this.matches.length) return;
    this.matchIndex = (this.matchIndex + offset + this.matches.length) % this.matches.length;
    this.updateMatch();
  }

  updateMatch() {
    this.currentMatchRow?.classList.remove("current-match"); this.currentMatchRow = null;
    this.currentCodeMarks.forEach(mark => mark.classList.remove("current-match"));
    this.currentCodeMarks = [];
    const count = this.matches.length;
    this.root.querySelector("#json-search-count").textContent = count ? `${this.matchIndex + 1} of ${count}` : "0 results";
    this.root.querySelector("#json-search-previous").disabled = count < 2;
    this.root.querySelector("#json-search-next").disabled = count < 2;
    if (!count) return;
    const match = this.matches[this.matchIndex];
    this.root.querySelector("#json-active-path").textContent = match.path;
    if (this.view === "code") {
      this.currentCodeMarks = this.codeHighlights.get(this.matchIndex) || [];
      this.currentCodeMarks.forEach(mark => mark.classList.add("current-match"));
      const mark = this.currentCodeMarks[0];
      if (mark) {
        const bounds = mark.getBoundingClientRect(), pane = this.code.getBoundingClientRect();
        this.code.scrollTop += bounds.top - pane.top - (this.code.clientHeight - bounds.height) / 2;
        if (bounds.left < pane.left || bounds.right > pane.left + this.code.clientWidth) {
          this.code.scrollLeft += bounds.left - pane.left - 24;
        }
      }
      return;
    }
    let record = this.rows.get("$");
    for (const key of match.segments || []) {
      if (!record?.details) return;
      record.details.open = true; record = this.ensureChild(record, key);
    }
    record = this.rows.get(match.path);
    if (!record) return;
    let parent = record.row.parentElement;
    while (parent && parent !== this.tree) { if (parent.tagName === "DETAILS") parent.open = true; parent = parent.parentElement; }
    record.row.classList.add("current-match");
    this.currentMatchRow = record.row;
    record.row.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
  }

  async copyPath(path) {
    try { await navigator.clipboard.writeText(path); this.notify("JSONPath copied"); }
    catch { this.notify("Could not copy the JSONPath", "error"); }
  }

  async copyJson() {
    if (!this.hasDocument) return this.notify("Paste valid JSON first", "error");
    try { await navigator.clipboard.writeText(JSON.stringify(this.value, null, 2)); this.notify("Formatted JSON copied"); }
    catch { this.notify("Could not copy JSON", "error"); }
  }

  download() {
    if (!this.hasDocument) return this.notify("Paste valid JSON first", "error");
    const current = this.root.querySelector("#json-input-name").textContent;
    const name = current.endsWith(".json") ? current : "argus-export.json";
    try { saveTextFile(name, `${JSON.stringify(this.value, null, 2)}\n`); }
    catch { saveTextFile(name, this.source.value); this.notify("Saved the original valid JSON; it is too deeply nested to reformat."); }
  }
}

export function createJsonExplorer(root, options) {
  return new JsonExplorer(root, options);
}
