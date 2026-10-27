import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "pdfjs-dist");
const destination = path.join(root, "public", "vendor", "pdfjs");
await fs.mkdir(destination, { recursive: true });
// Electron's Chromium may lag the JS features expected by PDF.js's modern build.
// Use the upstream legacy API AND worker from the same pinned version: each realm
// needs its own supported polyfills (including Uint8Array.prototype.toHex).
for (const name of ["pdf.mjs", "pdf.worker.mjs"]) await fs.copyFile(path.join(source, "legacy", "build", name), path.join(destination, name));
for (const name of ["cmaps", "standard_fonts", "wasm"]) await fs.cp(path.join(source, name), path.join(destination, name), { recursive: true });
await fs.copyFile(path.join(source, "LICENSE"), path.join(destination, "LICENSE"));
