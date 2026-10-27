import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./vendor-mermaid.mjs";
import "./vendor-pdfjs.mjs";
import "./vendor-document-preview.mjs";
import "./vendor-ide.mjs";
import "./vendor-terminal.mjs";
import "./vendor-diagrams.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public");
const target = path.join(root, "frontend", "public");
const legacy = path.join(target, "legacy");

await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(legacy, { recursive: true });
for (const entry of await fs.readdir(source, { withFileTypes: true })) {
  if (entry.name === "index.html" || entry.name === "assets") continue;
  await fs.cp(path.join(source, entry.name), path.join(legacy, entry.name), { recursive: true });
}
await fs.cp(path.join(source, "assets"), path.join(target, "assets"), { recursive: true });
