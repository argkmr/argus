import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { composerPopoverPosition } from "../public/compact-composer.mjs";

test("composer menu prefers space above the input and clamps to the viewport at font zoom", () => {
  assert.deepEqual(composerPopoverPosition({ left: 50, top: 650, bottom: 680 }, { width: 360, height: 300 }, { width: 1000, height: 800 }), { left: 50, top: 342 });
  assert.deepEqual(composerPopoverPosition({ left: 270, top: 100, bottom: 130 }, { width: 300, height: 320 }, { width: 340, height: 500 }), { left: 30, top: 138 });
  assert.deepEqual(composerPopoverPosition({ left: 270, top: 100, bottom: 130 }, { width: 320, height: 480 }, { width: 340, height: 500 }, 1.25), { left: 8, top: 8 });
});

test("both composers retain one of every original control inside native context/model menus", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const [scope, prefix] of [["repository", "agent"], ["global", "global-agent"]]) {
    const context = html.slice(html.indexOf(`id="${scope}-composer-context"`), html.indexOf(`id="${scope}-composer-model"`));
    const model = html.slice(html.indexOf(`id="${scope}-composer-model"`), html.indexOf(`id="${scope === "global" ? "queue-global-agent-prompt" : "queue-agent-prompt"}"`));
    for (const suffix of ["prompt", "provider", "model", "speed", "effort", "mode", "context-mode", "config-summary"]) assert.equal([...html.matchAll(new RegExp(`id="${prefix}-${suffix}"`, "g"))].length, 1, `${prefix}-${suffix}`);
    for (const suffix of ["provider", "model", "speed", "effort", "mode"]) assert.ok(model.includes(`id="${prefix}-${suffix}"`));
    assert.ok(context.includes(`id="${prefix}-context-mode"`));
    assert.ok(context.includes(`data-attach-file="${scope}"`));
    assert.ok(context.includes(`data-attach-browser="${scope}"`));
    assert.ok(context.includes(`id="${scope}-task-notes"`));
    assert.match(context, /popover="auto"/); assert.match(model, /popover="auto"/);
  }
  assert.equal([...html.matchAll(/id="nexus-repository-picker-root"/g)].length, 1);
});

test("compact styling preserves native hiding, single-row controls and bounded input", async () => {
  const css = await readFile(new URL("../public/compact-composer.css", import.meta.url), "utf8");
  assert.match(css, /\[popover\]:not\(:popover-open\)\s*\{ display: none/);
  assert.match(css, /flex-wrap: nowrap/);
  assert.match(css, /min-height: 42px/);
  assert.match(css, /max-height: 112px/);
  assert.match(css, /@container chat-layout \(max-height: 420px\)/);
  assert.match(css, /max-height: 76px/);
  assert.doesNotMatch(css, /\.composer-action-button\s*\{[^}]*display:\s*none/);
});

test("Context and request settings use decorative, font-independent icons in both composers", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal([...html.matchAll(/<svg class="composer-context-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"/g)].length, 2);
  for (const scope of ["repository", "global"]) {
    const summary = html.match(new RegExp(`<summary[^>]*aria-controls="${scope}-composer-model"[^>]*>(.*?)</summary>`))?.[1];
    assert.match(summary, /<svg class="disclosure-chevron"/);
    assert.doesNotMatch(summary, /⌄|▾|▼/);
  }
});
