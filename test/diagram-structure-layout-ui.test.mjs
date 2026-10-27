import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('all structure nodes fit their shared bounds with real CSS, long text, units, and zoom', { timeout:60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'argus-structure-layout-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./fixtures/diagram-structure-layout-electron.cjs', import.meta.url)), temporary], { env, detached:true, stdio:['ignore', 'pipe', 'pipe'] });
      let output = ''; const capture = chunk => { output = (output + chunk).slice(-30_000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 55_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/STRUCTURE_LAYOUT_RESULT=(.+)/)?.[1] || '{}');
    assert.equal(result.ok, true); assert.equal(result.scenarios, 160); assert.equal(result.interactions, 10); assert.equal(result.networkRequests, 0);
  } finally { await rm(temporary, { recursive:true, force:true }); }
});
