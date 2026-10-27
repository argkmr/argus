import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("repository search filters and navigates existing tabs in an aligned, bounded native popover", { timeout: 90_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-tab-search-renderer-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/repository-tab-search-electron.cjs", import.meta.url)), temporary], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-35_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 80_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/REPOSITORY_SEARCH_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.layoutScenarios, 64);
    assert.equal(result.filterScenarios, 5);
    assert.equal(result.selectionScenarios, 3);
    assert.equal(result.focusScenarios, 9);
    assert.equal(result.repositoryCount, 50);
    assert.equal(result.statePreserved, true);
    assert.equal(result.writeCount, 0);
    assert.equal(result.unexpectedNetworkCount, 0);
  } finally {
    if (process.env.ARGUS_TAB_SEARCH_CAPTURE === "1") console.log(`Repository search captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
