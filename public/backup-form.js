export function normalizeBackupRepositoryUrl(input = "") {
  let value = String(input).trim();
  const fail = () => { throw new Error("Enter a valid HTTPS or SSH clone URL without credentials, commands, or extra arguments."); };
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return fail();
  if (/^git +clone +/.test(value)) {
    value = value.replace(/^git +clone +/, "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  }
  if (/[^\x21-\x7e]|[;&|`$<>\\"']/.test(value)) return fail();
  const hostPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
  const validPath = path => path.length > 0 && path.split("/").every(part => part && part !== "." && part !== ".." && /^(?:[A-Za-z0-9._~-]|%20)+$/.test(part));
  const scp = value.match(/^([A-Za-z0-9._-]+)@([^/:]+):(.+)$/);
  if (scp) {
    if (!hostPattern.test(scp[2]) || !validPath(scp[3])) return fail();
    if (scp[2].toLowerCase() === "bitbucket.org" && scp[3].split("/").length !== 2) return fail();
    return value;
  }
  let parsed;
  try { parsed = new URL(value); } catch { return fail(); }
  const authority = value.match(/^[a-z]+:\/\/([^/]+)/)?.[1] || "";
  if (!["https:", "ssh:"].includes(parsed.protocol) || !hostPattern.test(parsed.hostname) || parsed.port === "0"
      || parsed.search || parsed.hash || parsed.password
      || (authority.includes("@") && !parsed.username)
      || (parsed.username && !/^[A-Za-z0-9._-]+$/.test(parsed.username))) return fail();
  // Inspect the raw path as well: URL() otherwise resolves hostile dot segments.
  const rawPath = value.match(/^[a-z]+:\/\/[^/]+\/(.*)$/)?.[1];
  if (!rawPath || !validPath(rawPath.replace(/\/$/, ""))) return fail();
  const parts = rawPath.replace(/\/$/, "").split("/");
  if (parsed.hostname.toLowerCase() === "bitbucket.org") {
    if (parsed.protocol === "https:" && !parsed.port && parts.length === 4 && parts[2] === "src") {
      return `https://bitbucket.org/${parts[0]}/${parts[1].replace(/\.git$/, "")}.git`;
    }
    if (parts.length !== 2) return fail();
  }
  return value;
}

export function backupFieldsValid({ repositoryUrl = "", driveDirectory = "", passphrase = "", hasRecoveryPassphrase = false } = {}) {
  const destinationReady = Boolean(String(repositoryUrl).trim() || String(driveDirectory).trim());
  if (String(repositoryUrl).trim()) {
    try { normalizeBackupRepositoryUrl(repositoryUrl); } catch { return false; }
  }
  const enteredPassphrase = String(passphrase);
  const passphraseReady = enteredPassphrase
    ? enteredPassphrase.length >= 12
    : Boolean(hasRecoveryPassphrase);
  return destinationReady && passphraseReady;
}
