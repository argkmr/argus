import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

test("professional explorer, compact tabs and Tab tools fit dark/light, narrow windows and zoom", { timeout: 75_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-workspace-polish-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/workspace-polish-electron.cjs", import.meta.url)), temporary], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; const collect = chunk => { output = (output + chunk).slice(-20_000); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 65_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/WORKSPACE_POLISH_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true); assert.equal(result.scenarios, 8); assert.equal(result.externalRequests, 0); assert.ok(result.icons >= 6);
    assert.ok(result.minTextContrast >= 4.5); assert.ok(result.minIconContrast >= 3);
    assert.equal(result.usageScenarios, 4);
    assert.equal(result.sharedThemeScenarios, 2);
  } finally {
    if (process.env.ARGUS_WORKSPACE_POLISH_CAPTURE === "1") console.log(`Workspace polish captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
