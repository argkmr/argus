import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real IDE shares Services logs, terminal and debugger in one dock with preserved sessions and buffers", { timeout: 75_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-ide-sync-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/ide-sync-electron.cjs", import.meta.url)), temporary], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-20_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 67_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/IDE_SYNC_RENDERER_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true); assert.equal(result.sandboxed, true); assert.equal(result.backendRequests, 0);
    assert.equal(result.configuredAndDetected, true); assert.equal(result.sharedState, true); assert.equal(result.unsavedProtected, true);
    assert.equal(result.sharedToolDock, true); assert.equal(result.liveProcessOutput, true); assert.equal(result.exactProcessSelection, true);
    assert.equal(result.retainedSessions, true); assert.equal(result.maximizeRestore, true); assert.equal(result.lazyLogPolling, true);
  } finally {
    if (process.env.ARGUS_IDE_SYNC_CAPTURE === "1") console.log(`IDE sync captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
