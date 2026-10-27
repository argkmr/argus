const childSnapshotMatches = (target, children) => children.length === target.childNodes.length
  && children.every((child, index) => target.childNodes[index] === child);

const signature = node => node.nodeType === 1 ? node.outerHTML : `${node.nodeType}:${node.nodeValue}`;
const attributes = node => new Map(Array.from(node.attributes || [], attribute => [attribute.name, attribute.value]));
const compatible = (record, source) => record.node.nodeType === source.nodeType
  && record.node.nodeName === source.nodeName && record.node.namespaceURI === source.namespaceURI;

function snapshot(node, source = node) {
  return {
    node, signature: signature(source), attributes: attributes(source),
    children: Array.from(source.childNodes || [], (child, index) => snapshot(node.childNodes[index], child)),
  };
}

// CharacterData edits retain selections in an unchanged prefix/suffix. Setting
// textContent or nodeValue would reset offsets even when a stream only appends.
function updateText(node, value) {
  const current = node.data;
  if (current === value) return;
  let prefix = 0, suffix = 0;
  while (prefix < current.length && prefix < value.length && current[prefix] === value[prefix]) prefix++;
  while (suffix < current.length - prefix && suffix < value.length - prefix
    && current[current.length - suffix - 1] === value[value.length - suffix - 1]) suffix++;
  node.replaceData(prefix, current.length - prefix - suffix, value.slice(prefix, value.length - suffix));
}

/**
 * Reconcile already-safe HTML, never raw user input. Compare authored markup,
 * not the enhanced live DOM: unchanged diagrams, open details, focus and text
 * selections belong to the user and must survive a streaming/polling update.
 */
export function createStableHtmlRenderer({ getKey = () => null, replaceChanged = () => false } = {}) {
  const rendered = new WeakMap();

  function patchNode(record, source, nextSignature) {
    if (record.signature === nextSignature) return record;
    const node = record.node;
    if (replaceChanged(node, source)) return snapshot(source.cloneNode(true), source);
    if (node.nodeType === 3 || node.nodeType === 8) {
      updateText(node, source.data);
    } else {
      const nextAttributes = attributes(source);
      for (const name of record.attributes.keys()) {
        if (!nextAttributes.has(name)) node.removeAttribute(name);
      }
      for (const [name, value] of nextAttributes) {
        if (record.attributes.get(name) !== value) node.setAttribute(name, value);
      }
      record.attributes = nextAttributes;
      record.children = patchChildren(node, record.children, Array.from(source.childNodes));
    }
    record.signature = nextSignature;
    return record;
  }

  function patchChildren(parent, previous, sources) {
    const available = previous.filter(record => record.node.parentNode === parent);
    const keyed = new Map(available.map(record => [getKey(record.node), record]).filter(([key]) => key != null));
    const exact = new Map();
    for (const record of available) {
      if (getKey(record.node) != null) continue;
      if (!exact.has(record.signature)) exact.set(record.signature, []);
      exact.get(record.signature).push(record);
    }
    const entries = sources.map(source => ({ source, key: getKey(source), signature: signature(source) }));
    const remaining = new Map();
    for (const entry of entries) {
      if (entry.key == null) remaining.set(entry.signature, (remaining.get(entry.signature) || 0) + 1);
    }
    const used = new Set();
    const records = entries.map(({ source, key, signature: nextSignature }, index) => {
      if (key == null) remaining.set(nextSignature, remaining.get(nextSignature) - 1);
      // Keys win over structural similarity: two identical replies still own
      // different user state. Unkeyed completed blocks can also survive inserts.
      const matches = key == null ? exact.get(nextSignature) : null;
      while (matches?.length && used.has(matches[0])) matches.shift();
      let record = key != null ? keyed.get(key) : matches?.shift();
      if (!record && key == null) {
        const candidate = previous[index];
        if (candidate?.node.parentNode === parent && !used.has(candidate) && getKey(candidate.node) == null
          && !remaining.get(candidate.signature)) record = candidate;
      }
      if (!record || used.has(record) || !compatible(record, source)) return snapshot(source.cloneNode(true), source);
      used.add(record);
      return patchNode(record, source, nextSignature);
    });
    // Only a changed authored subtree reaches here. Unchanged enhanced blocks
    // are skipped whole, so their extra iframe/status nodes remain untouched.
    const retained = new Set(records.map(record => record.node));
    for (const node of Array.from(parent.childNodes)) if (!retained.has(node)) parent.removeChild(node);
    // Remove obsolete siblings first: retaining B after deleting A must not move
    // B before A and reload a nested iframe or disrupt its focused control.
    let cursor = parent.firstChild;
    for (const record of records) {
      if (record.node !== cursor) parent.insertBefore(record.node, cursor);
      cursor = record.node.nextSibling;
    }
    return records;
  }

  return function renderStableHtml(target, safeHtml = "") {
    const html = String(safeHtml ?? "");
    const previous = rendered.get(target);
    const intact = previous && target.childNodes && childSnapshotMatches(target, previous.children);
    if (intact && previous.html === html) return false;

    const template = target.ownerDocument?.createElement?.("template");
    if (!template?.content || typeof target.insertBefore !== "function") {
      // Small non-browser adapters retain the original replacement semantics.
      target.innerHTML = html;
      rendered.set(target, { html, children: Array.from(target.childNodes || []) });
      return true;
    }
    template.innerHTML = html;
    const sources = Array.from(template.content.childNodes);
    let records;
    if (intact) records = patchChildren(target, previous.records, sources);
    else {
      target.replaceChildren(template.content.cloneNode(true));
      records = sources.map((source, index) => snapshot(target.childNodes[index], source));
    }
    rendered.set(target, { html, records, children: Array.from(target.childNodes) });
    return true;
  };
}
