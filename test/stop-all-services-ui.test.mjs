import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Stop all uses compact accessible header controls and safely reconciles synthetic service stops", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-stop-services-ui-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/stop-all-services-electron.cjs", import.meta.url)), temporary], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-30_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 50_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/STOP_SERVICES_UI_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.layoutScenarios, 48);
    assert.equal(result.behaviorScenarios, 10);
    assert.equal(result.unexpectedNetworkCount, 0);
  } finally {
    if (process.env.ARGUS_STOP_SERVICES_CAPTURE === "1") console.log(`Stop all Services captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
