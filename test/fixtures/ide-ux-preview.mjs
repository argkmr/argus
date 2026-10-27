// Isolated, read-only asset server. No Argus backend, profile, CLI or repository
// is opened; the page's API adapter is entirely synthetic and lives in memory.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(directory, "../../public");
const fixtures = new Map([
  ["/", "ide-ux-preview.html"],
  ["/ide-ux-preview.html", "ide-ux-preview.html"],
  ["/ide-ux-preview-browser.mjs", "ide-ux-preview-browser.mjs"],
  ["/ide-ux-services.mjs", "ide-ux-services.mjs"],
  ["/local-ai-preview.html", "local-ai-preview.html"],
  ["/local-ai-preview.mjs", "local-ai-preview.mjs"],
]);
const types = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".png": "image/png", ".wasm": "application/wasm" };

export function createPreviewServer() {
  return http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob:; frame-src 'self' about:; connect-src 'self'; object-src 'none'; base-uri 'none'");
    if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405); response.end("Read-only fixture"); return; }
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes("..")) throw new Error("Invalid path");
      let file, allowedRoot;
      if (fixtures.has(pathname)) { file = path.join(directory, fixtures.get(pathname)); allowedRoot = directory; }
      else if (pathname.startsWith("/legacy/")) { file = path.resolve(publicRoot, pathname.slice("/legacy/".length)); allowedRoot = publicRoot; }
      else { response.writeHead(404); response.end("No backend endpoints in this fixture"); return; }
      const realRoot = await fs.realpath(allowedRoot), realFile = await fs.realpath(file);
      if (!realFile.startsWith(realRoot + path.sep) || !(await fs.stat(realFile)).isFile()) throw new Error("Outside fixture roots");
      const content = await fs.readFile(realFile);
      response.writeHead(200, { "Content-Type": types[path.extname(realFile)] || "application/octet-stream", "Content-Length": content.length });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch { response.writeHead(404); response.end("Fixture asset not found"); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), port = args.length ? Number(args[1]) : 0;
  if (args.length && (args.length !== 2 || args[0] !== "--port") || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Usage: node test/fixtures/ide-ux-preview.mjs [--port 4199]");
  const server = createPreviewServer();
  server.listen(port, "127.0.0.1", () => console.log(`ISOLATED QA — synthetic debugger and source only: http://127.0.0.1:${server.address().port}/`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
