import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

test("background and agent activity retain DOM, focus, selected target and logs during updates", { timeout: 50_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-activity-stability-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/activity-update-stability-electron.cjs", import.meta.url)), temporary], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-16000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 45_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/ACTIVITY_STABILITY=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.networkRequests, 0);
    assert.equal(result.unchangedMutations, 0);
    assert.equal(result.unchangedMarkupBuilds, 0);
    assert.equal(result.targetPreserved, true);
    assert.equal(result.focusPreserved, true);
    assert.equal(result.emptyStateSafe, true);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
