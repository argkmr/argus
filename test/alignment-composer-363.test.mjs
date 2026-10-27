import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("composer alignment survives narrow docks, long model names, attachment metadata and empty states", { timeout:55_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-alignment-composer-363-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/alignment-composer-363-electron.cjs", import.meta.url)), temporary], { env:environment, detached:true, stdio:["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-30_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 50_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/ALIGNMENT_COMPOSER_363_RESULT=(.+)/)?.[1] || "{}");
    assert.deepEqual(result, { ok:true, scenarios:64 });
  } finally {
    if (process.env.ARGUS_ALIGNMENT_COMPOSER_CAPTURE === "1") console.log(`Composer alignment captures: ${temporary}`);
    else await rm(temporary, { recursive:true, force:true });
  }
});
