import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("project inspector stylesheet is used by both production shells", async () => {
  for (const file of ["../public/index.html", "../frontend/app/layout.jsx"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /project-structure-polish\.css/);
    assert.ok(source.indexOf("project-structure-polish.css") > source.indexOf("styles.css"));
  }
});

test("project inspector fits short content and scrolls every long project section across viewport, fonts, themes and zoom", { timeout: 90_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-project-inspector-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/project-structure-polish-electron.cjs", import.meta.url)), temporary], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let result = "";
      const capture = chunk => { result = (result + chunk.toString()).slice(-30_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 80_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(result) : reject(new Error(result)); });
    });
    const result = JSON.parse(output.match(/PROJECT_INSPECTOR_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.scenarios, 320);
    assert.equal(result.unexpectedNetworkCount, 0);
    assert.ok(result.scrollChecks > 40);
    assert.ok(result.maxOverviewHeight < 480);
  } finally {
    if (process.env.ARGUS_PROJECT_INSPECTOR_CAPTURE === "1") console.log(`Project inspector captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
