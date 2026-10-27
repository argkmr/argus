const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const NON_FILE_SCHEME = /^(?:https?|javascript|data|vbscript|mailto|ftp|sftp|blob|about|chrome|chrome-extension|codex|vscode|wss?):/i;

function positivePosition(value) {
  if (value == null) return null;
  const position = Number(value);
  return Number.isSafeInteger(position) && position > 0 ? position : undefined;
}

/** Parse a source citation, without resolving it or granting filesystem access.
 * The server must still resolve symlinks and validate local-file access or
 * connected-repository lookup for relative paths.
 */
export function parseSourceReferenceTarget(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 8192) return null;
  let target = value.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  target = target.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
  try { target = decodeURIComponent(target); } catch { return null; }
  if (!target || CONTROL_CHARACTERS.test(target) || target.includes("\\")) return null;
  if (NON_FILE_SCHEME.test(target)) return null;
  if (/^file:/i.test(target)) {
    // Do not use URL.pathname: URL normalization would erase traversal segments
    // before the server has a chance to reject them.
    const localFile = target.match(/^file:\/\/(?:localhost)?(\/.*)$/i);
    if (!localFile) return null;
    target = localFile[1];
  }
  if (target.startsWith("//") || target.startsWith("#") || target.startsWith("?")) return null;

  let path = target;
  let line = null;
  let column = null;
  let endLine = null;
  const fragment = target.match(/^(.*?)#L(\d+)(?:-L?(\d+))?$/i);
  const colon = target.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (fragment) {
    path = fragment[1];
    line = positivePosition(fragment[2]);
    endLine = positivePosition(fragment[3]);
  } else if (colon) {
    path = colon[1];
    line = positivePosition(colon[2]);
    column = positivePosition(colon[3]);
  }
  if ([line, column, endLine].includes(undefined) || (endLine != null && endLine < line)) return null;
  // Remaining URI schemes/fragments are not source citations. Colon suffixes
  // accepted above are line/column positions, never an executable URL.
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") || /[?#<>]/.test(path)) return null;
  return { path, line, column, endLine };
}
