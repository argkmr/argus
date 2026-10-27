import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "public/vendor/xterm");
await fs.mkdir(destination, { recursive: true });
// Pin, bundle and license the official distributions; terminal code never uses a CDN.
for (const [pkg, files] of [
  ["xterm", [["lib/xterm.mjs", "xterm.mjs"], ["css/xterm.css", "xterm.css"], ["LICENSE", "LICENSE-xterm"]]],
  ["addon-fit", [["lib/addon-fit.mjs", "addon-fit.mjs"], ["LICENSE", "LICENSE-addon-fit"]]],
]) {
  for (const [source, target] of files) {
    await fs.copyFile(path.join(root, "node_modules/@xterm", pkg, source), path.join(destination, target));
  }
}
