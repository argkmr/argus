import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { buildServiceCards } from '../public/service-card-order.mjs';
const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderServices('), render = source.slice(start, source.indexOf('\n}', start) + 2);
test('actual Services renderer follows arranged descriptors and does not replace DOM mid-drag', () => {
  const nodes = new Map(), orderCalls = []; let dragging = false, writes = 0;
  const list = { value: '', get innerHTML() { return this.value; }, set innerHTML(value) { this.value = value; writes++; } };
  nodes.set('#service-list', list);
  const state = { workspace: { repositories: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }], runConfigurations: [{ id: 'ca', repositoryId: 'a', name: 'Run Alpha', executable: 'echo', args: [] }], preferences: { serviceCardOrder: ['saved-marker'] } }, processes: [], detectedRuntimes: [], currentView: 'services' };
  const context = vm.createContext({ state, buildServiceCards, serviceCardOrder: { isDragging: () => dragging, restore: value => orderCalls.push(value), arrange: cards => [...cards].reverse() }, $: selector => { if (!nodes.has(selector)) nodes.set(selector, { scrollTop: 20, textContent: '' }); return nodes.get(selector); }, syncIdeRunControls() {}, syncServicePendingControls() {}, syncStopAllServicesControl() {}, requestAnimationFrame: fn => fn(), escapeHtml: value => String(value || '') });
  vm.runInContext(render, context); context.renderServices();
  assert.ok(list.innerHTML.indexOf('data-service-card="repository:b"') < list.innerHTML.indexOf('data-service-card="configuration:ca"'));
  assert.match(list.innerHTML, /data-service-card-drag/); assert.deepEqual(orderCalls[0], ['saved-marker']);
  context.renderServices(); assert.equal(writes, 1, 'unchanged poll preserves DOM');
  dragging = true; state.workspace.repositories.push({ id: 'c', name: 'New repo' }); context.renderServices(); assert.equal(writes, 1);
  dragging = false; context.renderServices(); assert.equal(writes, 2);
  state.workspace = null; context.renderServices(); assert.equal(writes, 2, 'provisional workspace must not initialize saved order');
});
test('Local AI stylesheet is shipped in both the legacy shell and production Next shell', async () => {
  const [html, layout] = await Promise.all(['../public/index.html', '../frontend/app/layout.jsx'].map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
  assert.match(html, /local-ai-panel\.css/); assert.match(layout, /local-ai-panel\.css/);
  assert.match(html, /role="tab"[^>]*aria-controls="local-ai-panel"/);
  assert.match(html, /id="local-storage-panel"[^>]*hidden/);
});
