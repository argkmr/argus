import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Services paint saved and fresh cards before stalled discovery, retain order/status, and fit desktop/narrow windows", { timeout: 45_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-services-loading-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/services-loading-electron.cjs", import.meta.url)), temporary], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-20_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 40_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/SERVICES_LOADING_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.configuredScenarios, 8);
    assert.equal(result.boundaryScenarios, 12);
    assert.equal(result.writeCount, 0);
    assert.equal(result.unexpectedNetworkCount, 0);
    assert.equal(result.timings.samples, 8);
    assert.ok(Number.isFinite(result.timings.synchronousCardsMaxMs));
    assert.ok(Number.isFinite(result.timings.twoFrameReadyMaxMs));
    assert.ok(Number.isFinite(result.timings.liveProcessAppliedMaxMs));
    console.log(`Isolated Services renderer timings: ${JSON.stringify(result.timings)}`);
  } finally {
    if (process.env.ARGUS_SERVICES_CAPTURE === "1") console.log(`Services captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
