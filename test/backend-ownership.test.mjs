import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("Argus ships one Java backend and keeps JavaScript only for UI, desktop and tooling", async () => {
  const package_ = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(package_.dependencies, undefined);
  assert.equal(package_.build.files.some(value => value.startsWith("server/")), false);
  assert.ok(package_.scripts["build:backend"].endsWith("clean verify"));
  await assert.rejects(fs.access(new URL("../server", import.meta.url)), {code:"ENOENT"});
  await assert.rejects(fs.access(new URL("../backend/src/main/java/com/argus/platform/LegacyApiBridgeController.java", import.meta.url)), {code:"ENOENT"});
  const main = await fs.readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.equal(main.includes("server/index.mjs"), false);
  assert.equal(main.includes("legacy-origin"), false);
  assert.match(main,/health\.pid/);
  assert.match(main,/drainJavaBackend/);
});
