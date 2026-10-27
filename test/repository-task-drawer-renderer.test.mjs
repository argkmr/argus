import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("task history fits narrow and wide IDE windows and dismisses without disrupting chat or editor focus", { timeout: 55_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-task-drawer-"));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [
        fileURLToPath(new URL("./fixtures/repository-task-drawer-electron.cjs", import.meta.url)), temporary,
      ], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-16_000); };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, 45_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error(`Task drawer renderer exited with code ${code}:\n${output}`));
      });
    });
    const match = output.match(/TASK_DRAWER_RENDERER_RESULT=(.+)/);
    assert.ok(match, `Task drawer renderer did not report its result:\n${output}`);
    const result = JSON.parse(match[1]);
    assert.equal(result.ok, true);
    assert.equal(result.sandboxed, true);
    assert.equal(result.networkRequests, 0);
    assert.deepEqual(result.widths, [420, 1440]);
    assert.equal(result.iframeDismissed, true);
  } finally {
    if (process.env.ARGUS_TASK_DRAWER_CAPTURE === "1") console.log(`Task drawer captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
