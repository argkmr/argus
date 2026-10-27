import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real Monaco diff revert glyphs handle both Git targets and EOF gaps without editing snapshots", { timeout: 65_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-ide-diff-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/ide-diff-revert-electron.cjs", import.meta.url)), temporary], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-20_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 58_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/IDE_DIFF_RENDERER_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true); assert.equal(result.scenarios, 12); assert.equal(result.stateScenarios, 2);
    assert.equal(result.sandboxed, true); assert.equal(result.backendRequests, 0); assert.equal(result.disposed, true);
  } finally {
    if (process.env.ARGUS_IDE_DIFF_CAPTURE === "1") console.log(`IDE diff captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
