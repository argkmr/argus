import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function declaration(name) { const start = source.indexOf(`async function ${name}(`); return source.slice(start, source.indexOf('\n}', start) + 2); }
test('orchestration polls cannot replace a newly selected run or surface an unrelated error', async () => {
  for (const failed of [false, true]) {
    let resolve, reject, renders = 0, errors = 0;
    const state = { currentView: 'orchestration', activeOrchestrationRun: { id: 'old', status: 'running' } };
    const context = vm.createContext({ state, api: () => new Promise((yes, no) => { resolve = yes; reject = no; }), renderOrchestrationRun: () => renders++, $: () => { errors++; return { classList: { remove() {} } }; } });
    vm.runInContext(declaration('pollOrchestration'), context);
    const pending = context.pollOrchestration();
    state.activeOrchestrationRun = { id: 'new', status: 'running' };
    if (failed) reject(Error('Old run failed')); else resolve({ id: 'old', status: 'completed' });
    await pending; assert.equal(renders, 0); assert.equal(errors, 0); assert.equal(state.orchestrationPolling, false);
  }
});
test('slow background polling is coalesced and the guard clears on failure', async () => {
  let calls = 0, reject;
  const context = vm.createContext({ state: {}, ownerVisibleBackgroundJobs: value => value, api: () => { calls++; return new Promise((_resolve, no) => { reject = no; }); } });
  vm.runInContext(declaration('refreshBackgroundJobs'), context);
  const pending = context.refreshBackgroundJobs(); await context.refreshBackgroundJobs(); assert.equal(calls, 1);
  reject(Error('Offline')); await pending; assert.equal(context.state.backgroundJobsPolling, false);
});
