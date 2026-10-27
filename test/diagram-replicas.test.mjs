import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { getReplicaLayout } from '../frontend/features/diagrams/diagram-replicas.mjs';
import * as visuals from '../frontend/features/diagrams/diagram-visuals.mjs';
import * as assets from '../frontend/features/diagrams/eraser-icon-assets.mjs';
import * as architectureSymbols from '../frontend/features/diagrams/diagram-architecture-symbols.mjs';
import * as expandedLayout from '../frontend/features/diagrams/diagram-expanded-layout.mjs';
import * as sequence from '../frontend/features/diagrams/diagram-sequence.mjs';
import * as expandedRouting from '../frontend/features/diagrams/diagram-expanded-routing.mjs';

test('replica stacks retain exact bounded counts with at most three ghost symbols', () => {
  for (const [input, count, layers] of [[undefined, 1, 0], [0, 1, 0], [-3, 1, 0], [2, 2, 1], [3, 3, 2], [4, 4, 3], [1000, 1000, 3], [1001, 1000, 3], [3.7, 3, 2], ['abc', 1, 0]]) {
    const layout = getReplicaLayout(input);
    assert.equal(layout.count, count);
    assert.equal(layout.offsets.length, layers);
    assert.equal(layout.extent, layers * 6);
    assert.ok(layout.offsets.every(offset => offset > 0 && offset <= 18));
  }
});

test('replica controls update only instance count, bound +/- and leave node geometry unchanged', async () => {
  const source = await readFile(new URL('../frontend/features/diagrams/DiagramNodes.jsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const changes = [];
  const actions = { updateNode: (...args) => changes.push(args) };
  const context = vm.createContext({ exports: {}, require(name) {
    if (name === 'react') return { ...React, useContext: () => actions, useState: value => [value, () => {}], useRef: value => ({ current: value }), useEffect: () => {} };
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react-dom') return { createPortal: () => { throw new Error('Closed notes must not mount a portal'); } };
    if (name === '@xyflow/react') return { Handle: 'port', NodeResizer: 'resize-frame', Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' }, useUpdateNodeInternals: () => () => {} };
    if (name === './diagram-catalog.mjs') return { getDiagramComponent: () => ({ label: 'Worker', role: 'worker', color: '#aabbcc' }), COMPONENT_BRAND_ICONS: {} };
    if (name === './diagram-replicas.mjs') return { getReplicaLayout };
    if (name === './diagram-visuals.mjs') return visuals;
    if (name === './eraser-icon-assets.mjs') return assets;
    if (name === './diagram-architecture-symbols.mjs') return architectureSymbols;
    if (name === './diagram-expanded-layout.mjs') return expandedLayout;
    if (name === './diagram-sequence.mjs') return sequence;
    if (name === './diagram-expanded-routing.mjs') return expandedRouting;
    if (name === './useDiagramPopover') return { useDiagramPopover: () => () => {} };
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected import ${name}`);
  } });
  vm.runInContext(compiled, context);
  const render = count => context.exports.ComponentNode.type({ id: 'workers', data: { name: 'Order workers', componentKey: 'worker', replicas: count }, selected: true, isConnectable: true });
  const flatten = element => [element, ...React.Children.toArray(element?.props?.children).flatMap(child => typeof child === 'object' ? flatten(child) : [])];
  const event = { stopPropagation() {} };
  const tree = flatten(render(3));
  tree.find(element => element.props?.['aria-label'] === 'Add replica to Order workers').props.onClick(event);
  tree.find(element => element.props?.['aria-label'] === 'Remove replica from Order workers').props.onClick(event);
  assert.deepEqual(changes.map(change => JSON.parse(JSON.stringify(change))), [['workers', { replicas: 4 }], ['workers', { replicas: 2 }]]);
  assert.equal(flatten(render(1)).find(element => element.props?.['aria-label'] === 'Remove replica from Order workers').props.disabled, true);
  assert.equal(flatten(render(1000)).find(element => element.props?.['aria-label'] === 'Add replica to Order workers').props.disabled, true);
  const count = tree.find(element => element.props?.['aria-label'] === 'Replica count for Order workers');
  assert.equal(count.props.type, 'number'); assert.equal(count.props.min, '1'); assert.equal(count.props.max, '1000');
  count.props.onChange({ target: { value: '250' } });
  assert.deepEqual(JSON.parse(JSON.stringify(changes.at(-1))), ['workers', { replicas: 250 }]);
  assert.ok(changes.every(([, patch]) => Object.keys(patch).join(',') === 'replicas'));
  const beforeInvalid = changes.length;
  for (const value of ['', '-1', '0', '1001', '3.7', 'abc']) count.props.onChange({ target: { value } });
  assert.equal(changes.length, beforeInvalid, 'Partially typed or invalid counts must not be published');

  actions.readOnly = true;
  const readOnlyTree = flatten(render(3));
  for (const label of ['Add replica to Order workers', 'Remove replica from Order workers']) {
    const control = readOnlyTree.find(element => element.props?.['aria-label'] === label);
    assert.equal(control.props.disabled, true);
    control.props.onClick(event);
  }
  const readOnlyCount = readOnlyTree.find(element => element.props?.['aria-label'] === 'Replica count for Order workers');
  assert.equal(readOnlyCount.props.readOnly, true);
  readOnlyCount.props.onChange({ target: { value: '7' } });
  readOnlyCount.props.onBlur();
  const readOnlyName = readOnlyTree.find(element => element.props?.['aria-label'] === 'Component name');
  assert.equal(readOnlyName.props.readOnly, true);
  readOnlyName.props.onChange({ target: { value: 'Changed' } });
  assert.equal(changes.length, beforeInvalid, 'Read-only viewers must never publish node edits');
});

test('shape-first replica and queue symbols stay aligned at minimum widths with large counts', { timeout: 50_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'argus-diagram-replicas-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./fixtures/diagram-replicas-electron.cjs', import.meta.url)), temporary], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const capture = chunk => { output = (output + chunk).slice(-40_000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 45_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/DIAGRAM_REPLICAS_RESULT=(.+)/)?.[1] || '{}');
    assert.equal(result.ok, true); assert.equal(result.scenarios, 144); assert.equal(result.networkRequests, 0);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
