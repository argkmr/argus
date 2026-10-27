function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

export function formatJson(value) {
  return JSON.stringify(JSON.parse(value), null, 2);
}

export function highlightedJson(value) {
  const formatted = formatJson(value);
  // Tokenize JSON, not escaped HTML: otherwise the digits in &#39; become a
  // number span, breaking the entity and the string's syntax highlighting.
  const tokens = /"(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let html = "", offset = 0;
  for (const match of formatted.matchAll(tokens)) {
    html += escapeHtml(formatted.slice(offset, match.index));
    const token = match[0], suffix = match[1] || "";
    const kind = token.startsWith('"') ? (suffix ? "key" : "string")
      : token === "null" ? "null" : /^(true|false)$/.test(token) ? "boolean" : "number";
    const content = suffix ? token.slice(0, -suffix.length) : token;
    html += `<span class="json-${kind}">${escapeHtml(content)}</span>${escapeHtml(suffix)}`;
    offset = match.index + token.length;
  }
  html += escapeHtml(formatted.slice(offset));
  return { formatted, html: html.split("\n").map(line => `<span class="json-line">${line || " "}</span>`).join("") };
}

export function renderResponseContent(element, value, preferJson = true) {
  const raw = String(value ?? "");
  element.dataset.raw = raw;
  element.classList.remove("json-view");
  if (preferJson) {
    try {
      const rendered = highlightedJson(raw);
      element.dataset.raw = rendered.formatted;
      element.classList.add("json-view");
      element.innerHTML = rendered.html;
      return true;
    } catch { /* Display non-JSON responses as plain text. */ }
  }
  element.textContent = raw;
  return false;
}
