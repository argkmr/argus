import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import config from '../canvas-web/vite.config.mjs';

test('standalone canvas shares structured and sketch edits, protects viewers, and renders both themes',{timeout:110000},async()=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'argus-canvas-ui-'));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  try {
    await build({...config,configFile:false,logLevel:'error',build:{...config.build,outDir:path.join(temporary,'site')}});
    const output=await new Promise((resolve,reject)=>{
      const child=spawn(createRequire(import.meta.url)('electron'),[fileURLToPath(new URL('./fixtures/canvas-sharing-electron.cjs',import.meta.url)),temporary],{env,detached:true,stdio:['ignore','pipe','pipe']});
      let output='';const capture=chunk=>{output=(output+chunk).slice(-30000);};child.stdout.on('data',capture);child.stderr.on('data',capture);
      const timeout=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}},100000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('close',code=>{clearTimeout(timeout);code===0?resolve(output):reject(new Error(output));});
    });
    const result=JSON.parse(output.match(/CANVAS_UI_RESULT=(.+)/)?.[1]||'{}');
    assert.equal(result.ok,true);assert.equal(result.participants,3);assert.equal(result.externalRequests,0);
    if(process.env.ARGUS_CANVAS_UI_CAPTURE==='1')console.log('Canvas screenshots: '+temporary);
  } finally {if(process.env.ARGUS_CANVAS_UI_CAPTURE!=='1')await rm(temporary,{recursive:true,force:true});}
});
