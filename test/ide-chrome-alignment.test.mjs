import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("tool splitter bounds match the rendered minimum and code-space reserve",async()=>{
  const [css,source]=await Promise.all(["../public/repository-ide.css","../public/repository-ide.mjs"].map(file=>readFile(new URL(file,import.meta.url),"utf8")));
  const rendered=css.match(/\.repository-ide-tool-dock \{[^}]*min-height:\s*(\d+)px;[^}]*max-height:\s*max\((\d+)px, calc\(100% - (\d+)px\)\)/);
  const splitter=source.match(/const maximum = Math\.max\((\d+), height - (\d+)\), minimum = Math\.min\(160, maximum\)/);
  assert.ok(rendered);assert.ok(splitter);assert.equal(rendered[1],rendered[2]);assert.equal(splitter[1],rendered[1]);assert.equal(splitter[2],rendered[3]);
});

test("IDE Git/footer and Files/editor headers align across window sizes, fonts, themes, and zoom", {timeout:50_000}, async()=>{
  const temporary=await mkdtemp(join(tmpdir(),"argus-ide-chrome-"));
  const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
  try{
    const output=await new Promise((resolve,reject)=>{
      const child=spawn(createRequire(import.meta.url)("electron"),[fileURLToPath(new URL("./fixtures/ide-chrome-alignment-electron.cjs",import.meta.url)),temporary],{env:environment,detached:true,stdio:["ignore","pipe","pipe"]});
      let output="";const capture=chunk=>{output=(output+chunk.toString()).slice(-18000);};child.stdout.on("data",capture);child.stderr.on("data",capture);
      const timer=setTimeout(()=>{try{process.kill(-child.pid,"SIGKILL");}catch{child.kill("SIGKILL");}},45_000);
      child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("close",code=>{clearTimeout(timer);code===0?resolve(output):reject(new Error(output));});
    });
    const result=JSON.parse(output.match(/IDE_CHROME_RESULT=(.+)/)?.[1]||"{}");
    assert.equal(result.ok,true);assert.equal(result.scenarios,256);assert.equal(result.networkRequests,0);
    if(process.env.ARGUS_IDE_CHROME_BASELINE==='1')console.log(output);
  }finally{
    if(process.env.ARGUS_IDE_CHROME_CAPTURE==='1'||process.env.ARGUS_IDE_CHROME_BASELINE==='1')console.log(`IDE chrome captures: ${temporary}`);
    else await rm(temporary,{recursive:true,force:true});
  }
});
