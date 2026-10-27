function dotenvValue(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_./:@%+,-]*$/.test(text) ? text : JSON.stringify(text);
}

export function parseEnvironmentText(text) {
  const source = String(text || "");
  const entries = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const character of source) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote) { current += character; escaped = true; continue; }
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote === character ? null : character;
      current += character;
      continue;
    }
    if (!quote && (character === "\n" || character === ";")) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  entries.push(current);

  const environment = {};
  for (let rawEntry of entries) {
    rawEntry = rawEntry.trim();
    if (!rawEntry || rawEntry.startsWith("#")) continue;
    rawEntry = rawEntry.replace(/^export\s+/, "");
    const separator = rawEntry.indexOf("=");
    if (separator < 1) throw new Error(`Invalid environment entry: ${rawEntry.slice(0, 60)}`);
    const key = rawEntry.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable: ${key}`);
    let value = rawEntry.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); }
      catch { value = value.slice(1, -1); }
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    environment[key] = value;
  }
  return environment;
}

export function parseVaultValues(text) {
  const source = String(text || "").trim();
  if (!source) return {};
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error("Vault values must be pasted as one valid JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Vault values must be a JSON object");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const environmentValue = item !== null && typeof item === "object" ? JSON.stringify(item) : String(item ?? "");
    return [key, environmentValue];
  }));
}

export function serializeDotenv(environment) {
  return Object.entries(environment).map(([key, value]) => `${key}=${dotenvValue(value)}`).join("\n");
}

function restoreStructuredValue(value) {
  const trimmed = String(value).trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

export function serializeVault(environment) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, restoreStructuredValue(value)])),
    null,
    2,
  );
}

export function convertEnvironmentFormat(text, fromFormat, toFormat) {
  const source = String(text || "");
  if (!source.trim() || fromFormat === toFormat) return source;
  const environment = fromFormat === "vault" ? parseVaultValues(source) : parseEnvironmentText(source);
  return toFormat === "vault" ? serializeVault(environment) : serializeDotenv(environment);
}
