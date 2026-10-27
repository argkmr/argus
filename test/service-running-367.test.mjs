import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("only live running Services cards have a stable, accessible theme-aware highlight", { timeout:45_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-service-running-367-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve,reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/service-running-367-electron.cjs",import.meta.url)),temporary], { env, detached:true, stdio:["ignore","pipe","pipe"] });
      let output=""; const capture = chunk => { output=(output+chunk.toString()).slice(-30000); };
      child.stdout.on("data",capture); child.stderr.on("data",capture);
      const timer=setTimeout(()=>{ try { process.kill(-child.pid,"SIGKILL"); } catch { child.kill("SIGKILL"); } },40000);
      child.once("error",error=>{ clearTimeout(timer); reject(error); });
      child.once("close",code=>{ clearTimeout(timer); code===0 ? resolve(output) : reject(new Error(output)); });
    });
    const result=JSON.parse(output.match(/SERVICE_RUNNING_367=(.+)/)?.[1] || "{}");
    assert.equal(result.ok,true); assert.equal(result.scenarios,16); assert.equal(result.networkRequests,0);
  } finally {
    if (process.env.ARGUS_SERVICE_RUNNING_CAPTURE === "1") console.log(`Running service captures: ${temporary}`);
    else await rm(temporary,{ recursive:true, force:true });
  }
});
