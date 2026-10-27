const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

export function attachmentSize(value) {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1000) return `${size} B`;
  if (size < 1_000_000) return `${Math.round(size / 1000)} KB`;
  return `${(size / 1_000_000).toFixed(1)} MB`;
}

export function attachmentPresentation(item = {}) {
  const title = String(item.title || item.fileName || "").trim();
  const mime = String(item.mimeType || "").toLowerCase();
  const kind = item.kind === "browser" ? "browser" : item.kind === "paste" ? "paste"
    : item.kind === "image" || mime.startsWith("image/") ? "image"
    : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "file";
  const name = title || ({ browser: "Chrome tab", paste: "Pasted text", image: "Pasted image", file: "Attached file", audio: "Audio attachment", video: "Video attachment" }[kind]);
  const extension = /\.([a-z0-9]{1,12})$/i.exec(name)?.[1]?.toUpperCase();
  const label = { browser: "Chrome tab", paste: "Pasted text", image: "Image", audio: "Audio", video: "Video", file: extension || "File" }[kind];
  return { name, kind, description: `${label} · ${attachmentSize(item.size)}` };
}

const paths = {
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 4 4 3-3 6 6"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
  paste: '<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 11h6M9 15h6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  audio: '<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>',
  video: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/>',
};
const icon = kind => `<svg class="attachment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;

// Names are labels, never HTML or URLs. Preview and remove are sibling controls,
// so a mouse/keyboard removal cannot accidentally open the attachment viewer.
export function attachmentCardMarkup(item = {}, { scope = "repository", removable = false } = {}) {
  const { name, kind, description } = attachmentPresentation(item);
  const preview = `<button type="button" class="attachment-preview-button" data-preview-context="${escape(item.id)}" data-attachment-name="${escape(name)}" aria-label="Preview ${escape(name)}" title="Preview ${escape(name)}">${icon(kind)}<span class="attachment-copy"><strong>${escape(name)}</strong><small>${escape(description)}</small></span></button>`;
  const remove = removable ? `<button type="button" class="attachment-remove" data-remove-context="${escape(item.id)}" data-context-scope="${escape(scope)}" aria-label="Remove ${escape(name)}" title="Remove attachment"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>` : "";
  return `<span class="attachment-card ${removable ? "context-chip" : "chat-message-attachment"}">${preview}${remove}</span>`;
}
