import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function runAudit(extraEnvironment, scenarios) {
  const temporary=await mkdtemp(join(tmpdir(),'argus-alignment-audit-363-'));
  const env={...process.env,AUDIT_WIDTHS:'1440,820,500,380',AUDIT_HEIGHTS:'900,557',AUDIT_ZOOMS:'1,1.22,2',...extraEnvironment};
  delete env.ELECTRON_RUN_AS_NODE;
  try{
    const output=await new Promise((resolve,reject)=>{
      const child=spawn(createRequire(import.meta.url)('electron'),[fileURLToPath(new URL('./fixtures/alignment-audit-363-electron.cjs',import.meta.url)),temporary],{env,detached:true,stdio:['ignore','pipe','pipe']});
      let output='';const collect=chunk=>{output=(output+chunk).slice(-50000)};child.stdout.on('data',collect);child.stderr.on('data',collect);
      const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{child.kill('SIGKILL')}},55000);
      child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(new Error(output))});
    });
    const result=JSON.parse(output.match(/ALIGNMENT_AUDIT_363_RESULT=(.+)/)?.[1] || '{}');
    assert.equal(result.network,0);assert.equal(result.scenarios,scenarios);
  }finally{if(process.env.ARGUS_ALIGNMENT_CAPTURE==='1')console.log('Alignment captures: '+temporary);else await rm(temporary,{recursive:true,force:true})}
}

test('service configuration heading and path remain aligned across widths, zoom, fonts and themes', {timeout:60000}, () => runAudit({AUDIT_KINDS:'service-dialog',AUDIT_ASSERT_YAML:'1'},96));
test('tab group actions align and remain reachable for Create/Edit and long repository lists', {timeout:60000}, () => runAudit({AUDIT_KINDS:'repo-group-dialog,repo-group-dialog-edit',AUDIT_ASSERT_GROUP:'1',AUDIT_WIDTHS:'1440,820,500,380',AUDIT_ZOOMS:'1,1.22'},128));
test('dialog action buttons share aligned heights and centerlines across fonts, zoom and narrow layouts', {timeout:60000}, () => runAudit({AUDIT_KINDS:'repo-dialog,branch-dialog,curl-dialog,api-collection-dialog,project-structure-dialog,backup-dialog,api-environment-dialog,agent-profile-dialog',AUDIT_ASSERT_ACTIONS:'1',AUDIT_WIDTHS:'1440,380',AUDIT_ZOOMS:'1,1.22'},256));
