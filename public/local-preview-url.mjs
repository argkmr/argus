const CONTEXT_CONTENT = /^\/api\/context\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/content$/i;

// Both viewers use server-validated capabilities; never accept arbitrary file,
// data, blob, external URLs or unrelated authenticated application endpoints.
export function localPreviewEndpoint(value, origin) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid local document preview URL.");
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password || url.hash
    || (url.pathname !== "/api/source-reference/content" && !CONTEXT_CONTENT.test(url.pathname))) throw new Error("Invalid local document preview URL.");
  if (CONTEXT_CONTENT.test(url.pathname) && [...url.searchParams].some(([key, value]) => !(key === "download" && value === "true") && !(key === "preview" && value === "docx"))) throw new Error("Invalid local document preview URL.");
  return url;
}

export function attachmentContentUrl(value, origin, id, { download = false } = {}) {
  try {
    const url = localPreviewEndpoint(value, origin);
    if (!CONTEXT_CONTENT.test(url.pathname) || url.pathname !== `/api/context/${id}/content`
      || (url.searchParams.get("download") === "true") !== download) return null;
    return `${url.pathname}${url.search}`;
  } catch { return null; }
}
