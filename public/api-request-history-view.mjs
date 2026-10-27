const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

// The history index contains request metadata only. Never put credentials or
// query values into the list, tooltips, or search text.
export function historyRequestAddress(value) {
  const input = String(value ?? "").trim();
  if (!input) return "No URL yet";
  if (/^curl(?:\s|$)/i.test(input)) return "Unparsed cURL draft";
  const withoutParameters = input.split(/[?#]/, 1)[0];
  try {
    const url = new URL(withoutParameters);
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.host}${url.pathname}`;
  } catch { /* Environment placeholders and relative URLs are valid drafts. */ }
  return withoutParameters.replace(/^((?:[^/]*:)?\/\/)?[^/]*@/, "$1") || "No URL yet";
}

export function historyEntryLabel(entry) {
  return String(entry?.name ?? "").trim() || historyRequestAddress(entry?.url);
}

function entryMethod(entry) {
  const method = String(entry?.method ?? "GET").toUpperCase();
  return /^[A-Z]{1,12}$/.test(method) ? method : "HTTP";
}

function entryStatus(entry) {
  if (entry.kind === "failed") return { kind: "failed", label: "Failed" };
  if (entry.kind === "sent") {
    const code = Number(entry.status);
    return { kind: code >= 400 ? "failed" : "sent", label: Number.isInteger(code) && code >= 100 && code <= 599 ? `Sent · ${code}` : "Sent" };
  }
  return { kind: "draft", label: "Draft" };
}

function entryTime(entry) {
  const date = new Date(entry.updatedAt || entry.createdAt || "");
  if (!Number.isFinite(date.getTime())) return "";
  const readable = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  return `<time datetime="${date.toISOString()}">${escapeHtml(readable)}</time>`;
}

export function historyRowsMarkup(entries, query = "") {
  const rows = (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry.id === "string" && entry.id);
  const search = String(query ?? "").trim().toLocaleLowerCase();
  const matches = rows.filter(entry => !search || [historyEntryLabel(entry), historyRequestAddress(entry.url), entryMethod(entry), entryStatus(entry).label].join(" ").toLocaleLowerCase().includes(search));
  if (!matches.length) return `<p class="api-history-empty">${rows.length ? "No matching requests." : "Previous requests will appear here automatically. Opening one never sends it."}</p>`;
  return matches.map(entry => {
    const name = historyEntryLabel(entry), address = historyRequestAddress(entry.url), method = entryMethod(entry), status = entryStatus(entry);
    return `<div class="api-history-row"><button type="button" class="api-history-item-open" data-api-history-id="${escapeHtml(entry.id)}" aria-label="Open ${escapeHtml(method)} request: ${escapeHtml(name)}" title="${escapeHtml(name)}"><span class="api-method ${escapeHtml(method)}">${escapeHtml(method)}</span><span class="api-history-details"><strong>${escapeHtml(name)}</strong>${name !== address ? `<small>${escapeHtml(address)}</small>` : ""}<span class="api-history-meta"><span class="api-history-kind ${status.kind}">${escapeHtml(status.label)}</span>${entryTime(entry)}</span></span></button><button type="button" class="api-history-delete" data-delete-api-history="${escapeHtml(entry.id)}" aria-label="Remove ${escapeHtml(name)} from history" title="Remove from history"><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M6 6l8 8M14 6l-8 8"/></svg></button></div>`;
  }).join("");
}
