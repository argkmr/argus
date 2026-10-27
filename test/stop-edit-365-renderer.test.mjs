import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

test("Stop restores the original request in the production editor without overwriting another draft", {timeout:100_000}, async () => {
  const temporary=await mkdtemp(join(tmpdir(),"argus-stop-edit-365-"));
  const environment={...process.env}; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const output=await new Promise((resolve,reject)=>{
      const child=spawn(createRequire(import.meta.url)("electron"),[fileURLToPath(new URL("./fixtures/stop-edit-365-electron.cjs",import.meta.url)),temporary],{env:environment,detached:true,stdio:["ignore","pipe","pipe"]});
      let stdout="",stderr="";
      child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
      child.on("error",reject);child.on("exit",code=>code===0?resolve(stdout):reject(new Error(`Renderer exited ${code}\n${stdout}\n${stderr}`)));
    });
    const match=output.match(/STOP_EDIT_365_RESULT=(.+)/); assert.ok(match,output);
    const result=JSON.parse(match[1]);assert.equal(result.ok,true);assert.equal(result.scenarios,24);assert.equal(result.networkRequests,0);assert.equal(result.sandboxed,true);
  } finally {
    if(process.env.ARGUS_STOP_EDIT_CAPTURE==="1") console.log(`Stop/edit screenshots: ${temporary}`);
    else await rm(temporary,{recursive:true,force:true});
  }
});
