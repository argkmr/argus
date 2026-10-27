import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("folder references stay compact, aligned and keyboard-accessible at narrow widths and zoom", { timeout: 65_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-source-folder-layout-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/source-folder-layout-electron.cjs", import.meta.url)), temporary], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = chunk => { output = (output + chunk).slice(-30_000); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 60_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
    });
    const result = JSON.parse(await readFile(join(temporary, "result.json"), "utf8"));
    assert.equal(result.scenarios, 24);
    assert.ok(result.interactionChecks >= 5);
    assert.equal(result.networkRequests, 0);
  } finally {
    if (process.env.ARGUS_FOLDER_CAPTURE === "1") console.log(`Folder reference captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
