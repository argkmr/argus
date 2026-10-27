import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("IDE split chat uses compact column-relative empty-state typography and scroll clearance", async () => {
  const css = await readFile(new URL("../public/repository-ide-shell.css", import.meta.url), "utf8");
  assert.match(css, /body\.repository-ide-enabled \.ai-canvas \.chat-empty-state h1\s*\{[^}]*font-size:\s*clamp\(22px, 6cqi, 28px\)/);
  assert.match(css, /body\.repository-ide-enabled \.ai-canvas \.chat-empty-state\s*\{[^}]*flex:\s*0 0 auto;[^}]*justify-content:\s*flex-start/);
  assert.match(css, /body\.repository-ide-enabled \.ai-canvas \.chat-thread\.is-empty\s*\{[^}]*min-height:\s*0;[^}]*padding:\s*10px 6px 60px/);
  assert.match(css, /body\.repository-ide-enabled \.ai-canvas \.chat-empty-state > p:last-child\s*\{[^}]*font-size:\s*12px/);
});

test("checkpoint overlay is hidden only for an entirely empty repository chat in IDE mode", async () => {
  const css = await readFile(new URL("../public/repository-ide-shell.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1].includes(".chat-navigation-slot"));
  assert.equal(rules.length, 1);
  assert.equal(rules[0][1].trim(), "body.repository-ide-enabled .ai-main-content:has(#agent-conversation.is-empty):has(#agent-output-card.hidden):has(#agent-question-card-host:empty) > .chat-navigation-slot");
  assert.match(rules[0][2], /display:\s*none/);
});

test("IDE shell docks chat on the right, overlays it on narrow windows and collapses only chat content", async () => {
  const css = await readFile(new URL("../public/repository-ide-shell.css", import.meta.url), "utf8");
  assert.match(css, /body\.repository-ide-enabled #repository-workbench\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 6px minmax\(0, var\(--ide-chat-width, 36%\)\);[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(css, /repository-ide-chat-hidden #repository-workbench\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 0 0/);
  assert.match(css, /data-chat-layout="overlay"[^{}]*\.ai-main-content\s*\{[^}]*position:\s*absolute;[^}]*grid-area:\s*auto;[^}]*inset:\s*42px 0 0 auto/);
  assert.match(css, /repository-ide-chat-hidden #repository-workbench > \.ai-canvas > \.ai-main-content\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /repository-ide-chat-hidden[^{}]*> \.ai-canvas\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(css, /--ide-editor-size/);
});

test("IDE Git, shared tool dock and right-docked chat fit short windows, context headers and zoom", { timeout: 55_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-ide-layout-"));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/repository-ide-layout-electron.cjs", import.meta.url)), temporary], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-16_000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 48_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/IDE_LAYOUT_RESULT=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true);
    assert.equal(result.scenarios, 128);
    assert.equal(result.scrollScenarios, 8);
    assert.equal(result.toolScenarios, 192);
    assert.equal(result.sharedToolDock, true);
    assert.equal(result.normalLayoutRestored, true);
    assert.equal(result.gitIdeOnly, true);
    assert.equal(result.treePreferencePreserved, true);
  } finally {
    if (process.env.ARGUS_IDE_LAYOUT_CAPTURE === "1") console.log(`IDE layout captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
