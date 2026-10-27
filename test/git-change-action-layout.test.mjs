import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Git Stage/Unstage and Revert/Delete labels retain padding and reachable bounds across panel widths, fonts and zoom", { timeout: 50_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-git-action-layout-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/git-change-action-layout-electron.cjs", import.meta.url)), temporary], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = chunk => { output = (output + chunk).slice(-24_000); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 45_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
    });
    const result = JSON.parse(await readFile(join(temporary, "results.json"), "utf8"));
    assert.equal(result.layouts.length, 144);
    assert.equal(result.unexpectedNetwork, 0);
    assert.equal(result.oldCssReproducesOverflow, true, "The fixture must catch the original fixed-width Unstage regression");
    assert.deepEqual(result.labels, ["Delete", "Revert", "Stage", "Unstage"]);
  } finally {
    if (process.env.ARGUS_GIT_ACTION_LAYOUT_CAPTURE === "1") console.log(`Git action layout captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
