import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules/monaco-editor");
const destination = path.join(root, "public/vendor/monaco");
await fs.mkdir(destination, { recursive: true });
// Keep the pinned distribution's worker/module paths intact; never use a CDN.
await fs.cp(path.join(source, "min/vs"), path.join(destination, "vs"), { recursive: true });
await fs.copyFile(path.join(source, "LICENSE"), path.join(destination, "LICENSE"));
await fs.copyFile(path.join(source, "ThirdPartyNotices.txt"), path.join(destination, "ThirdPartyNotices.txt"));
