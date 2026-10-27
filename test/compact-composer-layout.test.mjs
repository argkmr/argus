import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("compact composers and native menus fit Nexus, repository chat and short IDE chat in Chromium", { timeout:60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-compact-composer-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/compact-composer-electron.cjs", import.meta.url)), temporary], { env:environment, detached:true, stdio:["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-30_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 55_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/COMPACT_COMPOSER_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.scenarios, 18);
    assert.equal(result.zoomScenarios, 2);
    assert.equal(result.alignmentScenarios, 48);
    assert.equal(result.recoveryScenarios, 2);
  } finally {
    if (process.env.ARGUS_COMPOSER_CAPTURE === "1") console.log(`Compact composer captures: ${temporary}`);
    else await rm(temporary, { recursive:true, force:true });
  }
});
