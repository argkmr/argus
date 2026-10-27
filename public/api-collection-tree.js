function collectionSegments(name) {
  return String(name || "Collection").split(/\s*\/\s*/).map((part) => part.trim()).filter(Boolean);
}

export function buildApiCollectionTree(collections = [], requests = []) {
  const root = { children: [], childMap: new Map() };
  const collectionNodes = new Map();

  for (const collection of collections) {
    let parent = root;
    const path = [];
    for (const segment of collectionSegments(collection.name)) {
      path.push(segment);
      let node = parent.childMap.get(segment);
      if (!node) {
        node = { name: segment, path: [...path], collection: null, requests: [], children: [], childMap: new Map(), requestCount: 0 };
        parent.childMap.set(segment, node);
        parent.children.push(node);
      }
      parent = node;
    }
    parent.collection = collection;
    collectionNodes.set(collection.id, parent);
  }

  for (const request of requests) {
    const node = collectionNodes.get(request.collectionId);
    if (node) node.requests.push(request);
  }

  const finalize = (node) => {
    node.children.forEach(finalize);
    node.requestCount = node.requests.length + node.children.reduce((total, child) => total + child.requestCount, 0);
    node.key = node.collection?.id || `path:${node.path.join(" / ")}`;
    delete node.childMap;
    return node;
  };
  return root.children.map(finalize);
}
