import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { renderChatMessage } from "../public/message-renderer.js";
import { createDiagramRenderCache, initializeMermaidRendering } from "../public/mermaid-renderer.js";

test("complete Mermaid fences produce diagram hooks with safe original source and copy", () => {
  const html = renderChatMessage('```Mermaid\nflowchart LR\n A["<img src=x onerror=alert(1)>"] --> B\n```');
  assert.match(html, /chat-mermaid-block/);
  assert.match(html, /data-mermaid-complete="true"/);
  assert.match(html, /data-toggle-mermaid-source/);
  assert.match(html, /data-copy-chat-code/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
});

test("streaming fences remain code until the matching complete fence arrives", () => {
  for (const content of ['```mermaid\nflowchart LR\n A -->', '````mermaid\nflowchart LR\n A-->B\n```']) {
    const html = renderChatMessage(content);
    assert.match(html, /data-mermaid-complete="false"/);
    assert.doesNotMatch(html, /data-toggle-mermaid-source/);
  }
  assert.match(renderChatMessage('~~~mermaid\nflowchart LR\n A-->B\n~~~'), /data-mermaid-complete="true"/);
  assert.doesNotMatch(renderChatMessage('```javascript\nconst mermaid = true;\n```'), /chat-mermaid-block/);
});

test("diagram renders are deduplicated across rerenders and keyed by theme", async () => {
  const calls = [];
  const render = createDiagramRenderCache(async (source, theme) => { calls.push([source, theme]); return "svg"; });
  const first = render("flowchart LR\nA-->B", "dark");
  assert.equal(first, render("flowchart LR\nA-->B", "dark"));
  await first;
  await render("flowchart LR\nA-->B", "light");
  assert.equal(calls.length, 2);
});

test("diagram cache is bounded and rejects oversized input before renderer invocation", async () => {
  let calls = 0;
  const render = createDiagramRenderCache(async () => ++calls, 2);
  await render("A", "dark"); await render("B", "dark"); await render("C", "dark"); await render("A", "dark");
  assert.equal(calls, 4);
  await assert.rejects(render("a".repeat(24_001), "dark"), /too large/);
  await assert.rejects(render(" ", "dark"), /empty/);
  assert.equal(calls, 4);
});

test("bad Mermaid definitions do not repeatedly parse on every streaming update", async () => {
  let calls = 0;
  const render = createDiagramRenderCache(async () => { calls++; throw new Error("invalid"); });
  await assert.rejects(render("invalid", "dark"));
  await assert.rejects(render("invalid", "dark"));
  assert.equal(calls, 1);
});

async function frameHarness(render = async () => ({ svg: "<svg></svg>" })) {
  const script = await fs.readFile(new URL("../public/mermaid-frame.js", import.meta.url), "utf8");
  let listener;
  const messages = [], configurations = [], definitions = [];
  const parent = { postMessage: (message) => messages.push(message) };
  const context = { parent, window: { addEventListener: (_name, fn) => { listener = fn; } }, document: { body: { replaceChildren() {} } },
    mermaid: { initialize: (config) => configurations.push(config), parse: async () => false, render: async (id, source) => { definitions.push(source); return render(id, source); } } };
  vm.runInNewContext(script, context);
  return { messages, configurations, definitions, async send(data, source = parent) { listener({source, data}); await new Promise((resolve) => setImmediate(resolve)); } };
}

test("isolated renderer locks strict safety and strips source-supplied configuration", async () => {
  const frame = await frameHarness();
  await frame.send({ type: "argus-render-mermaid", id: "1", source: '---\nconfig:\n  securityLevel: loose\n---\n%%{init: {"themeCSS":"@import url(https://evil.invalid)"}}%%\nflowchart LR\n A-->B', theme: "light" });
  assert.equal(frame.configurations[0].securityLevel, "strict");
  assert.equal(frame.configurations[0].htmlLabels, false);
  assert.equal(frame.configurations[0].theme, "default");
  assert.equal(frame.configurations[0].maxEdges, 250);
  assert.doesNotMatch(frame.definitions[0], /securityLevel|themeCSS|evil\.invalid/);
  assert.equal(frame.messages.at(-1).svg, "<svg></svg>");
});

test("renderer ignores other windows and returns generic errors, never raw source errors", async () => {
  const frame = await frameHarness(async () => { throw new Error("<img onerror=evil>"); });
  await frame.send({ type: "argus-render-mermaid", id: "1", source: "flowchart LR\nA-->B" }, {});
  assert.equal(frame.configurations.length, 0);
  await frame.send({ type: "argus-render-mermaid", id: "2", source: "invalid" });
  assert.equal(frame.messages.at(-1).error, true);
  assert.doesNotMatch(JSON.stringify(frame.messages), /onerror/);
});

test("invalid sequence notes get a narrow punctuation retry without changing entities or statements", async () => {
  const frame = await frameHarness();
  await frame.send({ type: "argus-render-mermaid", id: "3", source: "sequenceDiagram\nNote over C: Start action A; owner = CRM #59;\nNote over P: Merge context; C->>D: Next statement" });
  assert.match(frame.definitions[0], /Start action A#59; owner = CRM #59;/);
  assert.match(frame.definitions[0], /Merge context; C->>D: Next statement/);
});

test("rendering frame is local and network-blocked; initialization is safe without a DOM", async () => {
  const html = await fs.readFile(new URL("../public/mermaid-frame.html", import.meta.url), "utf8");
  assert.match(html, /script-src 'self'/);
  assert.match(html, /img-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /\.\/vendor\/mermaid\/mermaid.min.js/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.equal(typeof initializeMermaidRendering(null), "function");
});
