import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [legacy, layout, metadata] = await Promise.all([
  fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../frontend/app/layout.jsx", import.meta.url), "utf8"),
  fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
]);
const build = JSON.parse(metadata).argusBuild;
const legacyStyles = [...legacy.matchAll(/<link\s+rel="stylesheet"\s+href="([^\"]+)"/g)].map(([, href]) => href);
const nextStyles = [...layout.matchAll(/<link\s+rel="stylesheet"\s+href=\{`([^`]+)`\}/g)].map(([, href]) => href);

test("production Next shell delivers every legacy stylesheet in the same cascade order", () => {
  assert.ok(legacyStyles.length > 0, "the shell must include stylesheets");
  assert.equal(new Set(legacyStyles).size, legacyStyles.length, "legacy stylesheets must not be duplicated");
  assert.deepEqual(
    nextStyles,
    legacyStyles.map(href => `/legacy${href.replace(`?v=${build}`, "?v=${argusBuild}")}`),
    "A stylesheet present only in the legacy shell leaves its UI unstyled in the installed Next.js app",
  );
  assert.ok(nextStyles.includes("/legacy/repository-ports.css?v=${argusBuild}"));
});

test("every shell stylesheet has a shipped public asset and a build-versioned URL", async () => {
  await Promise.all(legacyStyles.map(async href => {
    assert.ok(href.endsWith(`?v=${build}`), `${href} must use the current build cache key`);
    const file = new URL(`../public${href.split("?")[0]}`, import.meta.url);
    assert.equal((await fs.stat(file)).isFile(), true, `${href} must resolve to a stylesheet copied by sync-next-assets`);
  }));
});
