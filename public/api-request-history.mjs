export function apiSnapshotHasContent(snapshot) {
  const request = snapshot?.request || {}, editor = snapshot?.editor || {};
  const nonemptyJson = text => {
    if (!String(text || "").trim()) return false;
    try {
      const parsed = JSON.parse(text);
      return parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 0;
    }
    catch { return true; } // Partially written JSON is a draft too.
  };
  return Boolean(request.id || request.name || request.url || request.body || request.collectionId
    || (request.method && request.method !== "GET") || request.description || request.pathVariables?.length
    || Object.keys(request.variables || {}).length || snapshot?.response
    || [editor.queryRows, editor.headerRows].some(rows => rows?.some(row => row.key || row.value || row.description))
    || nonemptyJson(editor.queryText) || nonemptyJson(editor.headersText));
}

export function apiSnapshotKey(snapshot) {
  return JSON.stringify(snapshot);
}

export function apiSnapshotRequestKey(snapshot) {
  const editor = snapshot.editor || {};
  return JSON.stringify({ request: snapshot.request, environmentId: snapshot.environmentId,
    editor: { queryRows: editor.queryRows, headerRows: editor.headerRows,
      queryText: editor.queryText, headersText: editor.headersText,
      queryView: editor.queryView, headerView: editor.headerView } });
}

export function createApiRequestHistory({ api, onChange = () => {} }) {
  let entries = [], revision = 0, refreshSequence = 0;
  const publish = () => onChange(entries.slice());
  const sort = () => entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.id.localeCompare(a.id));
  return {
    get entries() { return entries.slice(); },
    async refresh() {
      const started = revision;
      const sequence = ++refreshSequence;
      const result = await api("/api/api-request-history", { dedupe: false });
      if (started === revision && sequence === refreshSequence) { entries = result; sort(); publish(); }
      return entries.slice();
    },
    async record(snapshot, id) {
      const entry = await api("/api/api-request-history", { method: "POST", body: { ...(id ? { id } : {}), snapshot } });
      revision++;
      entries = [entry, ...entries.filter(item => item.id !== entry.id)];
      sort(); publish();
      return entry;
    },
    load(id) { return api(`/api/api-request-history/${encodeURIComponent(id)}`, { dedupe: false }); },
    async remove(id) {
      await api(`/api/api-request-history/${encodeURIComponent(id)}`, { method: "DELETE" });
      revision++;
      entries = entries.filter(entry => entry.id !== id);
      publish();
    },
  };
}
