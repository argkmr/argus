import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("both send actions use the same decorative SVG without changing their control contracts", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const icons = [];
  for (const id of ["run-agent", "run-global-agent"]) {
    const button = html.match(new RegExp(`<button id="${id}"[^>]*>(.*?)</button>`))?.[0];
    assert.ok(button);
    assert.match(button, /type="button"/);
    assert.match(button, /aria-label="Send message" title="Send message"/);
    assert.match(button, /<svg class="composer-send-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">/);
    assert.match(button, /<span class="composer-stop-icon" aria-hidden="true"><\/span>/);
    assert.doesNotMatch(button, /↑|onclick=/);
    icons.push(button.match(/<svg.*?<\/svg>/)[0]);
  }
  assert.equal(icons[0], icons[1]);
});

test("send and stop actions stay aligned, themed and accessible across chat surfaces", { timeout:80_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-composer-action-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/composer-action-electron.cjs", import.meta.url)), temporary], { env:environment, detached:true, stdio:["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-30_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 70_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/COMPOSER_ACTION_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.layouts, 96);
    assert.equal(result.states, 480);
    assert.equal(result.paletteStates, 60);
    assert.equal(result.interactionPalettes, 14);
    assert.ok(result.minIconContrast >= 3);
    assert.equal(result.reducedMotion, true);
    assert.equal(result.networkRequests, 0);
  } finally {
    if (process.env.ARGUS_COMPOSER_ACTION_CAPTURE === "1") console.log(`Composer action captures: ${temporary}`);
    else await rm(temporary, { recursive:true, force:true });
  }
});
