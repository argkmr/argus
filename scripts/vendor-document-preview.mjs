import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const [pkg, files] of [
  ["docx-preview", [["dist/docx-preview.min.js", "docx-preview.min.js"], ["LICENSE", "LICENSE"]]],
  ["jszip", [["dist/jszip.min.js", "jszip.min.js"], ["LICENSE.markdown", "LICENSE.markdown"]]],
  ["markdown-it", [["dist/browser/markdown-it.esm.min.mjs", "markdown-it.mjs"], ["LICENSE", "LICENSE"]]],
]) {
  const destination = path.join(root, "public/vendor", pkg);
  await fs.mkdir(destination, { recursive: true });
  for (const [source, target] of files) await fs.copyFile(path.join(root, "node_modules", pkg, source), path.join(destination, target));
}
