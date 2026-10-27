import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
test('AI Connections opens over the current workspace without changing the selected repository or editor',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const binding=source.split('\n').find(line=>line.includes('$("#ai-status-pill").addEventListener'));
 assert.ok(binding); assert.doesNotMatch(binding,/switchPrimaryView/);
 assert.match(binding,/showAppDialog\("ai-connections-dialog"\)/);
 let click; const calls=[];
 const underlying={view:'repository',repositoryId:'repo-one',editorTab:'package.json',draft:'Unsent draft'};
 const before=JSON.stringify(underlying);
 vm.runInNewContext(binding,{
   $:()=>({addEventListener:(_event,handler)=>{click=handler;}}),
   launchWorkspaceTool:action=>action(),
   refreshBrowserPairingStatus:()=>calls.push('refresh'),
   showAppDialog:id=>calls.push(id),renderAIConnections:()=>calls.push('render'),
   switchPrimaryView:()=>{underlying.view='ai';underlying.editorTab=null;}
 });
 click(); assert.equal(JSON.stringify(underlying),before);assert.deepEqual(calls,['refresh','ai-connections-dialog','render']);
});
test('repository history content/header alignment and local data scrolling in Chromium', {timeout:45000},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'argus-workspace-404-'));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 try{await new Promise((resolve,reject)=>{
 const child=spawn(createRequire(import.meta.url)('electron'),[fileURLToPath(new URL('./fixtures/workspace-regressions-404.cjs',import.meta.url)),temp],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const timeout=setTimeout(()=>child.kill('SIGKILL'),40000);
 child.once('error',reject);child.once('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error(output));});
 });}finally{if(process.env.ARGUS_LAYOUT_404_CAPTURE==='1')console.log(temp);else await rm(temp,{recursive:true,force:true});}
});
