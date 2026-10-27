// Logs are untrusted terminal output. Keep plain text, never terminal commands,
// escape payloads, or HTML rendering, in either the display or clipboard export.
export function plainProcessLogText(value) {
  return String(value ?? "")
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function formatProcessLogEntry(value) {
  const timestamp = plainProcessLogText(value?.timestamp);
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(timestamp)?.[1] || "";
  const prefix = value?.stream === "stderr" ? "ERR " : value?.stream === "stdout" ? "" : "SYS ";
  return `${time ? `${time} ` : ""}${prefix}${plainProcessLogText(value?.line)}`;
}

// Export a fresh after=0 snapshot, not a viewer's potentially truncated buffer.
export function formatProcessLogSnapshot(result) {
  if (!Array.isArray(result?.logs) || !Number.isSafeInteger(result.cursor) || result.cursor < 0
      || (result.dropped != null && (!Number.isSafeInteger(result.dropped) || result.dropped < 0))) throw new Error("Invalid log response");
  const count = result.logs.length, missing = result.dropped || 0;
  const warning = missing ? `[Argus: ${missing} earlier log ${missing === 1 ? "entry is" : "entries are"} no longer available. This is all retained output.]\n` : "";
  return {
    count,
    text: count ? warning + result.logs.map(formatProcessLogEntry).join("\n") : "",
    message: count
      ? `Copied ${count} log ${count === 1 ? "entry" : "entries"}.${missing ? ` ${missing} earlier ${missing === 1 ? "entry was" : "entries were"} no longer available.` : ""}`
      : "No logs available to copy.",
  };
}
