import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "build/ide-tools");
export const JDTLS = Object.freeze({
  archive: "jdt-language-server-1.62.0-202609111927.tar.gz",
  sha256: "0ee4099ed8f07ab43cda42835bb843c2427cac06f36322d79b07ddf78defeb80",
  origin: "https://download.eclipse.org/jdtls/snapshots/",
});
export const JS_DEBUG = Object.freeze({
  archive: "js-debug-dap-v1.117.0.tar.gz",
  sha256: "ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772",
  origin: "https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/",
});

export function validateArchiveEntries(text) {
  const entries = text.trim().split("\n");
  if (!entries.length || entries.length > 10000 || entries.some(entry => entry.startsWith("/") || entry.split("/").includes("..") || /[\u0000\r]/.test(entry))) throw new Error("Invalid IDE tool archive paths");
}

async function stageArchive(spec, name, child = "") {
  const cache = path.join(root, "build", spec.archive);
  let archive;
  try { archive = await fs.readFile(cache); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!archive) {
    const response = await fetch(spec.origin + spec.archive, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`${name} download failed (${response.status})`);
    const parts = []; let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 150 * 1024 * 1024) throw new Error("JDT language-server archive exceeds download limit");
      parts.push(part);
    }
    archive = Buffer.concat(parts);
  }
  if (crypto.createHash("sha256").update(archive).digest("hex") !== spec.sha256) throw new Error(`${name} checksum mismatch; nothing extracted`);
  await fs.writeFile(cache, archive);
  validateArchiveEntries(execFileSync("tar", ["-tzf", cache], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
  const staging = await fs.mkdtemp(path.join(root, `build/.${name}-`));
  const fresh = path.join(staging, "fresh");
  await fs.mkdir(fresh);
  execFileSync("tar", ["-xzf", cache, "-C", fresh], { timeout: 60000 });
  // Do not overwrite a previously staged tool in place. Preserve it during promotion.
  const target = path.join(destination, name), previous = path.join(staging, "previous");
  let retainedPrevious = false;
  try { await fs.rename(target, previous); retainedPrevious = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  try {
    await fs.rename(child ? path.join(fresh, child) : fresh, target);
  } catch (error) {
    if (retainedPrevious) try { await fs.rename(previous, target); } catch { /* Retain recovery on external filesystem failure. */ }
    throw new Error(`IDE tool staging did not complete; recovery retained at ${staging}`, { cause: error });
  }
  // Only this invocation's generated staging tree is removed after promotion.
  await fs.rm(staging, { recursive: true, force: true });
}

export async function buildIdeTools() {
  await fs.mkdir(destination, { recursive: true });
  for (const name of ["typescript-language-server", "typescript"]) {
    await fs.cp(path.join(root, "node_modules", name), path.join(destination, name), { recursive: true });
  }
  await stageArchive(JDTLS, "jdtls");
  await stageArchive(JS_DEBUG, "js-debug", "js-debug");
  // Upstream's standalone archive omits package.json. Isolate its CommonJS bundle
  // from Argus's parent type:module without altering upstream JavaScript bytes.
  await fs.writeFile(path.join(destination, "js-debug/package.json"), JSON.stringify({ private: true, type: "commonjs" }) + "\n");
  await fs.writeFile(path.join(destination, "versions.json"), JSON.stringify({ jdtls: JDTLS, jsDebug: JS_DEBUG, typescript: "6.0.3", typescriptLanguageServer: "6.0.0" }, null, 2) + "\n");
  console.log("IDE tools prepared with verified archive checksums. No tool was started.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildIdeTools();
