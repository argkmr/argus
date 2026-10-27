import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  ".gitignore", "README.md", "package.json", "package-lock.json", "backend", "chrome-extension",
  "desktop", "docs", "frontend", "public", "scripts", "test", "postman", "canvas-server", "canvas-web", "netlify.toml",
];
const ignored = new Set([".ds_store", ".git", ".gradle", ".next", ".argus-data", "build", "dist", "node_modules", "out", "target", "__pycache__", ".aws", ".ssh", ".gnupg", ".codex", ".claude", ".config", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "git-recovery", "kubeconfig", "id_rsa", "id_ed25519", "argus owner", "argus owner signing", "backup-owner.json"]);
const sensitiveName = /secret|credential|private[-_.]?key/i;
const implementation = /\.(?:java|js|mjs|cjs|ts|tsx|jsx|css|html|vue|svelte|c|h)$/i;
const keyMaterial = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;

export async function buildSourceBundle(root = projectRoot) {
  root = path.resolve(root);
  const destination = path.join(root, "build", "source");
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const source = path.join(root, entry);
    try { await fs.access(source); } catch { continue; }
    await fs.cp(source, path.join(destination, entry), {
      recursive: true,
      force: true,
      filter: async (candidate) => {
        const relative = path.relative(root, candidate);
        const parts = relative.split(path.sep), name = parts.at(-1);
        if (parts.some(part => ignored.has(part.toLowerCase())) || parts.slice(0,-1).some(part => sensitiveName.test(part))) return false;
        if (/^\.env(?:\.|$)/i.test(name) || /\.py[co]$/i.test(name) || keyMaterial.test(name)) return false;
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink()) return false;
        if (stat.isFile() && /\.(?:log(?:\.\d+)?|hprof|jfr|heapdump)$/i.test(name)) return false;
        return !sensitiveName.test(name) || (stat.isFile() && implementation.test(name));
      },
    });
  }
  console.log(`Created distributable Argus source bundle at ${destination}`);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSourceBundle();
