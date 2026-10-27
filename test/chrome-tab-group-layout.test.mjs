import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("tab group line has its own padded lane across fonts, themes, zoom and overflow", { timeout:65_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-tab-group-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/chrome-tab-group-layout-electron.cjs", import.meta.url)), temporary], { env:environment, detached:true, stdio:["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-20_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 55_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/TAB_GROUP_LAYOUT_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true); assert.equal(result.scenarios, 192);
    assert.ok(result.overflowScenarios > 0);
    assert.ok(result.minGap >= 3.95); assert.ok(result.maxGapDifference <= .05);
    assert.ok(result.minBottomClearance >= .5);
    assert.equal(result.unexpectedNetworkCount, 0);
  } finally {
    if (process.env.ARGUS_TAB_GROUP_CAPTURE === "1") console.log(`Tab group captures: ${temporary}`);
    else await rm(temporary, { recursive:true, force:true });
  }
});
