import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("recent branches retain a bounded, reachable picker across narrow layouts, fonts, themes and zoom", { timeout: 45_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-recent-branches-layout-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/recent-branches-layout-electron.cjs", import.meta.url)), temporary], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = chunk => { output = (output + chunk).slice(-30_000); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 40_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
    });
    const result = JSON.parse(await readFile(join(temporary, "results.json"), "utf8"));
    assert.equal(result.unexpectedNetwork, 0);
    assert.equal(result.backendCalls, 0);
    assert.equal(result.layouts.length, 24);
    assert.ok(result.layouts.every(layout => layout.recentCount === 4 && layout.duplicateCount === 0 && layout.clickSubmissions === 0));
  } finally {
    if (process.env.ARGUS_RECENT_BRANCHES_CAPTURE === "1") console.log(`Recent branches layout captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
