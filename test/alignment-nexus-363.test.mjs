import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Nexus identity and theme control align across fonts, narrow windows and zoom", { timeout: 90_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-alignment-nexus-363-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/alignment-nexus-363.cjs", import.meta.url)), temporary], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-30_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 80_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/NEXUS_ALIGNMENT_363=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.scenarios, 96);
    assert.equal(result.networkRequests, 0);
  } finally {
    if (process.env.ARGUS_ALIGNMENT_CAPTURE === "1") console.log(`Nexus alignment captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
