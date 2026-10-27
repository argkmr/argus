const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const temporary = option("--fixture-root");
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-pdf-electron-")) throw new Error("An isolated test directory is required.");
const root = path.resolve(__dirname, "../..");
const pdfPath = option("--fixture-pdf");
const screenshotPath = option("--fixture-screenshot");
if (screenshotPath && (!path.isAbsolute(screenshotPath) || !screenshotPath.endsWith(".png"))) throw new Error("An explicit PNG output path is required.");
const modernBaseline = args.includes("--modern-baseline");
app.setPath("userData", path.join(temporary, "profile"));
app.setPath("sessionData", path.join(temporary, "session"));
app.setPath("logs", path.join(temporary, "logs"));
app.commandLine.appendSwitch("disable-background-networking");
let server, window, completed = false;
const timer = setTimeout(() => finish({ ok: false, error: "PDF renderer test timed out." }, 1), 45_000);

async function finish(result, code = 0) {
  if (completed) return;
  completed = true;
  clearTimeout(timer);
  try { await fs.writeFile(path.join(temporary, "result.json"), JSON.stringify({ ...result, electron: process.versions.electron, chromium: process.versions.chrome, bundle: modernBaseline ? "modern-baseline" : "vendored-legacy" })); }
  catch (error) { console.error(error.message); code = 1; }
  if (window && !window.isDestroyed()) window.destroy();
  server?.closeAllConnections();
  server?.close();
  app.exit(code);
}

// Two pages with actual text, valid xref offsets and no external resources.
function syntheticPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...["First PDF preview page", "Second PDF preview page"].map((text) => { const stream = `BT /F1 16 Tf 25 350 Td (${text}) Tj ET`; return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`; }),
  ];
  let pdf = "%PDF-1.4\n", offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const page = `<!doctype html><meta charset="utf-8"><title>Isolated PDF regression test</title><div id="pdf" style="width:900px"></div><script type="module" src="/fixture.js"></script>`;
const renderer = `
import { renderPdfDocument } from "/pdf-preview.js";
const nativeHex = typeof Uint8Array.prototype.toHex;
const result = { nativeHex, sandboxed: typeof process === "undefined" && typeof require === "undefined" };
try {
  const container = document.querySelector("#pdf");
  const cleanup = await renderPdfDocument(container, "/api/source-reference/content?target=fixture.pdf");
  result.firstPage = container.querySelector('[role="status"]').textContent;
  const canvas = container.querySelector("canvas"), pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  result.canvas = { width: canvas.width, height: canvas.height, darkPixels: 0 };
  for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] > 0 && pixels[index] + pixels[index + 1] + pixels[index + 2] < 600) result.canvas.darkPixels++;
  if (${Boolean(screenshotPath)}) {
    const screenshot = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const saved = await fetch("/snapshot", { method: "POST", body: screenshot });
    if (!saved.ok) throw new Error("Could not save the explicit QA screenshot.");
    result.screenshotSaved = true;
  }
  const next = [...container.querySelectorAll("button")].find((button) => button.textContent === "Next page");
  if (!next.disabled) {
    next.click();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Second page did not finish rendering.")); }, 15000);
      const observer = new MutationObserver(() => { if (/^Page 2 of [0-9]+$/.test(container.querySelector('[role="status"]').textContent)) { observer.disconnect(); clearTimeout(timeout); resolve(); } });
      observer.observe(container, { subtree: true, childList: true, characterData: true });
    });
    result.secondPage = container.querySelector('[role="status"]').textContent;
  }
  cleanup();
  result.cleanedUp = container.children.length === 0 && canvas.width === 0 && canvas.height === 0;
  result.ok = result.sandboxed && result.cleanedUp && result.canvas.darkPixels > 20;
} catch (error) { result.ok = false; result.error = error.message; }
await fetch("/result", { method: "POST", body: JSON.stringify(result), headers: { "Content-Type": "application/json" } });
`;

app.whenReady().then(async () => {
  const pdf = pdfPath ? await fs.readFile(pdfPath) : syntheticPdf();
  if (pdf.length > 50 * 1024 * 1024 || !pdf.subarray(0, 1024).includes("%PDF-")) throw new Error("Invalid or oversized explicit PDF fixture.");
  server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname === "/snapshot" && request.method === "POST" && screenshotPath) {
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; if (length > 32 * 1024 * 1024) throw new Error("Oversized renderer screenshot."); chunks.push(chunk); }
        const screenshot = Buffer.concat(chunks);
        if (!screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Invalid screenshot format.");
        await fs.writeFile(screenshotPath, screenshot, { flag: "wx", mode: 0o600 });
        response.writeHead(200).end("ok");
        return;
      }
      if (pathname === "/result" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 8192) throw new Error("Oversized renderer result."); }
        response.writeHead(200).end("ok");
        await finish(JSON.parse(body));
        return;
      }
      if (request.method !== "GET") { response.writeHead(405).end(); return; }
      if (pathname === "/") { response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'" }).end(page); return; }
      if (pathname === "/fixture.js") { response.writeHead(200, { "Content-Type": "text/javascript" }).end(renderer); return; }
      if (pathname === "/api/source-reference/content") { response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length }).end(pdf); return; }
      let asset;
      if (pathname === "/pdf-preview.js") asset = path.join(root, "public", "pdf-preview.js");
      else if (pathname === "/local-preview-url.mjs") asset = path.join(root, "public", "local-preview-url.mjs");
      else if (/^\/vendor\/pdfjs\/[a-zA-Z0-9_./-]+$/.test(pathname) && !pathname.split("/").includes("..")) {
        const relative = pathname.slice("/vendor/pdfjs/".length);
        asset = modernBaseline && ["pdf.mjs", "pdf.worker.mjs"].includes(relative)
          ? path.join(root, "node_modules", "pdfjs-dist", "build", relative)
          : path.join(root, "public", "vendor", "pdfjs", relative);
      }
      if (!asset) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": /\.m?js$/.test(asset) ? "text/javascript" : /\.wasm$/.test(asset) ? "application/wasm" : "application/octet-stream" }).end(await fs.readFile(asset));
    } catch (error) { response.writeHead(500).end("Fixture failed."); await finish({ ok: false, error: error.message }, 1); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isolated = session.fromPartition("pdf-regression", { cache: false });
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + "/") }));
  isolated.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(origin + "/")) event.preventDefault(); });
  window.webContents.on("render-process-gone", (_event, details) => finish({ ok: false, error: `Renderer exited: ${details.reason}` }, 1));
  await window.loadURL(origin + "/");
}).catch((error) => { console.error(error.message); finish({ ok: false, error: error.message }, 1); });
