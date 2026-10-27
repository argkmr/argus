import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { checkPdfPreviewElectron } from "../scripts/check-pdf-preview-electron.mjs";

test("PDF API and worker are the matching upstream legacy bundle, not modern-only JS", async () => {
  for (const file of ["pdf.mjs", "pdf.worker.mjs"]) {
    const [vendored, supported] = await Promise.all([
      fs.readFile(new URL(`../public/vendor/pdfjs/${file}`, import.meta.url)),
      fs.readFile(new URL(`../node_modules/pdfjs-dist/legacy/build/${file}`, import.meta.url)),
    ]);
    assert.deepEqual(vendored, supported, `${file} must use the pinned upstream legacy build`);
    assert.match(supported.toString(), /Uint8Array\.prototype\.toHex/);
  }
});

test("sandboxed packaged Electron parses and renders PDF pages using the real worker", { timeout: 60_000 }, async () => {
  const result = await checkPdfPreviewElectron();
  assert.equal(result.electron, createRequire(import.meta.url)("electron/package.json").version);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sandboxed, true);
  assert.equal(result.firstPage, "Page 1 of 2");
  assert.equal(result.secondPage, "Page 2 of 2");
  assert(result.canvas.darkPixels > 20);
  assert.equal(result.cleanedUp, true);
});
