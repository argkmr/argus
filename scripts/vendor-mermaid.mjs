import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "public", "vendor", "mermaid");
await fs.mkdir(destination, { recursive: true });
// Ship the complete classic bundle: the isolated renderer needs no remote CDN,
// dynamic module imports, dependency server, or network access.
for (const [source, target] of [["dist/mermaid.min.js", "mermaid.min.js"], ["LICENSE", "LICENSE"]]) {
  await fs.copyFile(path.join(root, "node_modules", "mermaid", source), path.join(destination, target));
}
