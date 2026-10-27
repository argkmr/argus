import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const build = String(metadata.argusBuild || "").trim();

if (!/^\d{8}-\d+$/.test(build)) {
  throw new Error(`Invalid argusBuild in package.json: ${build || "missing"}`);
}

const indexPath = path.join(root, "public", "index.html");
const source = await fs.readFile(indexPath, "utf8");
const updated = source.replace(/([?&]v=)\d{8}-\d+/g, `$1${build}`);

if (updated === source && !source.includes(`v=${build}`)) {
  throw new Error("No renderer build identifiers were found in public/index.html");
}

await fs.writeFile(indexPath, updated);
// Imported modules have their own cache keys too; keep them in lockstep with the shell.
for (const name of ["app.js", "nexus-theme-picker.mjs", "daily-planner.mjs", "json-explorer.js", "ide-process-logs.mjs"]) {
  const file = path.join(root, "public", name);
  const content = await fs.readFile(file, "utf8");
  await fs.writeFile(file, content.replace(/([?&]v=)\d{8}-\d+/g, `$1${build}`));
}
console.log(`Synchronized Argus renderer build ${build}`);
