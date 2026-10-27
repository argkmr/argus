import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("production chats retain content, diagrams, selection, focus and scroll during streaming", { timeout:65_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-chat-stability-366-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/chat-stability-366-electron.cjs", import.meta.url)), temporary], { env, detached:true, stdio:["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = chunk => { output = (output + chunk.toString()).slice(-24000); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 58_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/CHAT_STABILITY_366=(.+)/)?.[1] || "{}");
    assert.equal(result.ok, true); assert.equal(result.scenarios.length, 12); assert.equal(result.blockedRequests, 0);
    for (const scenario of result.scenarios) {
      assert.equal(scenario.metadataMutations, 0); assert.equal(scenario.appendUpdates, 12);
      for (const key of ["preservedDiagram", "selectionRetained", "focusRetained", "readingScrollRetained", "liveEdgeRetained"]) assert.equal(scenario[key], true);
    }
    for (const key of ["safeStructureChanges", "growingCodeRetained", "growingTableRetained", "changedDiagramReplaced", "externalReplacementRecovered", "keyedTranscriptRetained", "precedingRemovalRetained", "savedDiagramRetained"]) assert.equal(result.structure[key], true);
  } finally {
    if (process.env.ARGUS_CHAT_STABILITY_CAPTURE === "1") console.log(`Chat stability captures: ${temporary}`);
    else await rm(temporary, { recursive:true, force:true });
  }
});
