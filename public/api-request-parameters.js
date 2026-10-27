function decodePart(value = "") {
  try { return decodeURIComponent(String(value).replace(/\+/g, " ")); }
  catch { return String(value); }
}

function encodePart(value = "") {
  return encodeURIComponent(String(value))
    .replace(/%7B%7B/gi, "{{")
    .replace(/%7D%7D/gi, "}}");
}

export function normalizeRequestParameters(value = []) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object").map((item) => ({
    key: String(item.key || ""),
    value: String(item.value ?? ""),
    description: typeof item.description === "string" ? item.description : item.description?.content || "",
    enabled: item.enabled !== false && item.disabled !== true,
  }));
}

export function requestParametersFromObject(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parameters must be a JSON object");
  return Object.entries(value).map(([key, item]) => ({
    key,
    value: item == null ? "" : String(item),
    description: "",
    enabled: true,
  }));
}

export function requestParametersToObject(value = []) {
  return Object.fromEntries(normalizeRequestParameters(value)
    .filter((item) => item.enabled && item.key)
    .map((item) => [item.key, item.value]));
}

export function queryParametersFromUrl(value = "") {
  const source = String(value);
  const hashIndex = source.indexOf("#");
  const withoutHash = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return [];
  return withoutHash.slice(queryIndex + 1).split("&").filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return {
      key: decodePart(separator >= 0 ? part.slice(0, separator) : part),
      value: decodePart(separator >= 0 ? part.slice(separator + 1) : ""),
      description: "",
      enabled: true,
    };
  });
}

export function composeUrlWithQuery(value = "", parameters = []) {
  const source = String(value);
  const hashIndex = source.indexOf("#");
  const fragment = hashIndex >= 0 ? source.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const queryIndex = withoutHash.indexOf("?");
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = normalizeRequestParameters(parameters)
    .filter((item) => item.enabled && item.key)
    .map((item) => `${encodePart(item.key)}=${encodePart(item.value)}`)
    .join("&");
  return `${base}${query ? `?${query}` : ""}${fragment}`;
}

export function pathVariableNames(value = "") {
  const path = String(value).split(/[?#]/, 1)[0];
  const names = [];
  const seen = new Set();
  for (const match of path.matchAll(/:([A-Za-z_][\w.-]*)|(?<!\{)\{([A-Za-z_][\w.-]*)\}(?!\})/g)) {
    const name = match[1] || match[2];
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }
  return names;
}

export function pathVariablesFromUrl(value = "", existing = []) {
  const previous = new Map(normalizeRequestParameters(existing).map((item) => [item.key, item]));
  return pathVariableNames(value).map((key) => previous.get(key) || { key, value: "", description: "", enabled: true });
}

export function applyPathVariables(value = "", parameters = [], transform = (item) => item) {
  const variables = new Map(normalizeRequestParameters(parameters).filter((item) => item.enabled && item.key).map((item) => [item.key, item.value]));
  return String(value).replace(/:([A-Za-z_][\w.-]*)|(?<!\{)\{([A-Za-z_][\w.-]*)\}(?!\})/g, (match, colonName, braceName) => {
    const name = colonName || braceName;
    if (!variables.has(name) || variables.get(name) === "") return match;
    return encodeURIComponent(String(transform(variables.get(name), name)));
  });
}
