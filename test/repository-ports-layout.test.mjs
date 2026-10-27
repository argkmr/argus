import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Argus service ports stay compact with inline editing and configured-port fallback in desktop/narrow windows", { timeout:40_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-ports-layout-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/repository-ports-electron.cjs", import.meta.url)), temporary], { env:environment, detached:true, stdio:["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-16_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 35_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/PORTS_LAYOUT_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true); assert.equal(result.scenarios, 12);
    assert.equal(result.fallbackScenarios, 4);
    assert.equal(result.writeCount, 0);
  } finally {
    if (process.env.ARGUS_PORTS_CAPTURE === "1") console.log(`Port captures: ${temporary}`);
    else await rm(temporary, { recursive:true, force:true });
  }
});
