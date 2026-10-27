import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('bulk board controls are usable and safe in the real Studio UI; Draw offers only a blank drawing', { timeout: 65_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'argus-diagram-board-bulk-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./fixtures/diagram-board-bulk-electron.cjs', import.meta.url)), temporary], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const capture = chunk => { output = (output + chunk).slice(-30_000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 60_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/DIAGRAM_BOARD_BULK_RESULT=(.+)/)?.[1] || '{}');
    assert.equal(result.ok, true);
    assert.equal(result.scenarios, 9);
    assert.equal(result.screenshots, 4);
    assert.equal(result.networkRequests, 0);
    assert.equal(result.sandboxed, true);
  } finally {
    if (process.env.ARGUS_DIAGRAM_BOARD_BULK_CAPTURE === '1') console.log('Bulk board screenshots: ' + temporary);
    else await rm(temporary, { recursive: true, force: true });
  }
});
