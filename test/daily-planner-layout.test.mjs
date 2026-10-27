import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("daily planner fixed-date timing, dense backlogs, controls, links, archive restoration and drafts remain safe in isolated Electron", { timeout: 65_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-daily-planner-layout-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/daily-planner-layout-electron.cjs", import.meta.url)), temporary], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; const collect = chunk => { output = (output + chunk).slice(-30_000); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 60_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
    });
    const result = JSON.parse(await readFile(join(temporary, "results.json"), "utf8"));
    assert.equal(result.unexpectedNetwork, 0); assert.equal(result.backendCalls, 0);
    assert.equal(result.layouts.length, 24); assert.ok(result.interactionsPassed);
    assert.ok(result.layouts.every(layout => layout.timePickerFits));
    assert.equal(result.linkLayouts.length, 3); assert.ok(result.linkLayouts.every(layout => layout.linksFit));
    assert.ok(result.timeInteractionsPassed); assert.ok(result.linkInteractionsPassed);
    assert.equal(result.stressLayouts.length, 24);
    assert.ok(result.stressLayouts.every(layout => layout.headersFixed && layout.cardsFit && layout.initialCardsPerDay === 40));
    assert.ok(result.stressInteractionsPassed);
    assert.equal(result.timingLayouts.length,24);
    assert.ok(result.timingLayouts.every(layout=>layout.fixedDates&&layout.missedCountsVisible));
    assert.ok(result.fixedDateInteractionsPassed);
    assert.deepEqual(result.rolloverResults.boardDates,['2026-09-26','2026-09-27','2026-09-28']);
    assert.deepEqual(result.rolloverResults.reportDates,result.rolloverResults.boardDates);
    assert.ok(result.rolloverResults.stalePreviousDayIgnored);
  } finally {
    if (process.env.ARGUS_DAILY_PLANNER_CAPTURE === "1") console.log(`Daily planner captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
