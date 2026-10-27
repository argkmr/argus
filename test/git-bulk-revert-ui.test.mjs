import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("bulk revert confirmation and selection toolbar fit narrow/wide windows in dark/light themes", { timeout: 50_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-git-bulk-ui-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/git-bulk-revert-electron.cjs", import.meta.url)), temporary], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", data => { output = (output + data).slice(-20000); }); child.stderr.on("data", data => { output = (output + data).slice(-20000); });
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 45_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
    });
    const report = JSON.parse(await readFile(join(temporary, "results.json"), "utf8"));
    assert.equal(report.scenarios, 24); assert.equal(report.unexpectedNetwork, 0);
    assert.equal(report.escapedPaths, true); assert.equal(report.cancelDefault, true);
  } finally {
    if (process.env.ARGUS_GIT_BULK_CAPTURE === "1") console.log(`Bulk Git captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
