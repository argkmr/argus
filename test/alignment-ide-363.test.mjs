import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("IDE long labels preserve terminal, run-log, debugger, and footer alignment at every tested width", { timeout:75_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-alignment-ide-363-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/alignment-ide-363-electron.cjs", import.meta.url)), temporary], { env, detached:true, stdio:["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-18000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 68_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/ALIGNMENT_IDE_363=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true); assert.equal(result.scenarios, 120); assert.equal(result.unexpectedRequests, 0);
  } finally {
    if (process.env.ARGUS_ALIGNMENT_IDE_CAPTURE === "1") console.log(`IDE alignment captures: ${temporary}`);
    else await rm(temporary, { recursive:true, force:true });
  }
});
