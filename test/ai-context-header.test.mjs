import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("repository AI context keeps metadata in an accessible on-demand popover in both frontends", async () => {
  const [html, layout, application, styles] = await Promise.all(["../public/index.html", "../frontend/app/layout.jsx", "../public/app.js", "../public/repository-ide-shell.css"].map(path => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of [html, layout]) assert.match(source, /ai-context-header\.css/);
  assert.match(html, /id="local-ai-info-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="local-ai-details"/);
  assert.match(html, /id="local-ai-details"[^>]*popover="auto"[^>]*role="dialog"/);
  for (const id of ["local-ai-provider", "local-ai-version", "local-ai-repository", "local-ai-access", "local-codex-title"]) assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
  assert.match(application, /aiContextHeader\?\.update\([\s\S]*?providerConnectionStatus\(selected\)[\s\S]*?providerIsVerifiedReady\(selected\)/);
  assert.doesNotMatch(styles, /\.ai-sticky-header\s*\{\s*display:\s*none/);
});

test("AI context is a compact single row with reachable details across dock sizes, fonts, themes and zoom", { timeout: 90_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-ai-context-"));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/ai-context-header-electron.cjs", import.meta.url)), temporary], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-30_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 80_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/AI_CONTEXT_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.layoutScenarios, 64);
    assert.equal(result.behaviorChecks, 9);
    assert.equal(result.unexpectedNetworkCount, 0);
  } finally {
    if (process.env.ARGUS_AI_CONTEXT_CAPTURE === "1") console.log(`AI context captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
