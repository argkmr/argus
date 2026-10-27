import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERASER_ICONS, ERASER_ICON_CATEGORIES, ERASER_ICON_CATALOG_METADATA } from '../frontend/features/diagrams/diagram-eraser-icons.mjs';
import { DIAGRAM_VISUALS } from '../frontend/features/diagrams/diagram-visuals.mjs';
import { getDiagramComponent, searchDiagramComponents } from '../frontend/features/diagrams/diagram-catalog.mjs';
import { emptySnapshot, exportBoard, makeNode, parseBoardImport, duplicateSelection } from '../frontend/features/diagrams/diagram-model.mjs';
import { sanitizeSharedBoard } from '../frontend/features/diagrams/collaboration/board-doc.mjs';

test('every published Eraser icon resolves to its own catalog identity and category', () => {
  assert.equal(ERASER_ICONS.length, ERASER_ICON_CATALOG_METADATA.count);
  assert.equal(ERASER_ICONS.length, 3951);
  assert.equal(new Set(ERASER_ICONS.map(icon => icon.id)).size, ERASER_ICONS.length);
  assert.equal(ERASER_ICON_CATEGORIES.reduce((total, category) => total + category.count, 0), ERASER_ICONS.length);
  assert.equal(ERASER_ICON_CATEGORIES.length, 8);
  for (const icon of ERASER_ICONS) {
    const component = getDiagramComponent(icon.id);
    assert.equal(component.id, icon.id);
    assert.equal(component.category, icon.category);
    if (icon.id === 'eraser:redis') {
      assert.equal(component.brand, 'Redis');
      assert.equal(component.iconName, undefined, 'Redis uses the bundled classic stacked product mark');
    } else assert.equal(component.iconName, icon.iconName, `Catalog fallback for ${icon.id}`);
    assert.equal(icon.id, `eraser:${icon.iconName}`);
    assert.ok(icon.id.length <= 80, `Icon ID exceeds the persisted componentKey limit: ${icon.id}`);
    assert.ok(ERASER_ICON_CATEGORIES.some(category => category.name === icon.category));
  }
  for (const query of ['aws ec2', 'azure web app', 'kubernetes', 'postgres', 'redis']) {
    assert.ok(searchDiagramComponents(query).some(component => component.iconName), `No Eraser result for ${query}`);
  }
});

test('the desktop allowlist exactly matches frontend icon names including punctuation and case', async () => {
  const text = await readFile(new URL('../backend/src/main/resources/diagrams/eraser-icon-names.txt', import.meta.url), 'utf8');
  const backendNames = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.deepEqual([...backendNames].sort(), ERASER_ICONS.map(icon => icon.iconName).sort());
  assert.ok(backendNames.includes('azure-web-app-+-database'));
  assert.ok(backendNames.includes('aws-elemental-appliances-&-software'));
  assert.ok(backendNames.includes('aws-cloudfront-functions_48_Light'));
});

test('all icons, shapes and device frames preserve identity and notes through local and shared board saves', () => {
  const entries = [...ERASER_ICONS, ...DIAGRAM_VISUALS];
  // Real boards cap at2,000 objects. Exercise the entire library in independently valid batches.
  for (let offset = 0; offset < entries.length; offset += 1000) {
    const selected = entries.slice(offset, offset + 1000);
    const snapshot = emptySnapshot();
    snapshot.structured.nodes = selected.map((component, index) => ({
      ...makeNode('component', { x: index * 7, y: index * 11 }, component.id),
      style: { width: component.width || 180, height: component.height || 160 },
      data: { componentKey: component.id, name: `${component.label} · α`, description: `Notes for ${component.id}\n<script>inert text</script>`, replicas: 1 },
    }));
    const board = { id: `synthetic-catalog-${offset}`, name: 'Synthetic catalog round trip', snapshot };
    const imported = parseBoardImport(exportBoard(board));
    assert.deepEqual(imported.snapshot.structured.nodes.map(node => node.data), snapshot.structured.nodes.map(node => node.data));
    assert.deepEqual(imported.snapshot.structured.nodes.map(node => node.style), snapshot.structured.nodes.map(node => node.style));
    const shared = sanitizeSharedBoard(board);
    assert.deepEqual(shared.snapshot.structured.nodes.map(node => node.data), snapshot.structured.nodes.map(node => node.data));
    assert.deepEqual(shared.snapshot.structured.nodes.map(node => node.position), snapshot.structured.nodes.map(node => node.position));
  }
});

test('duplicating connected library objects preserves notes without sharing node identities', () => {
  const nodes = ['eraser:aws-ec2', 'shape:cylinder', 'frame:browser'].map((key, index) => ({
    ...makeNode('component', { x: index * 300, y: 80 }, key), selected: true,
    data: { name: key, componentKey: key, description: `Private draft notes ${index}`, replicas: 1 },
  }));
  const edges = [{ id: 'edge', source: nodes[0].id, target: nodes[1].id, data: { label: 'persist' } }];
  const duplicated = duplicateSelection(nodes, edges);
  assert.deepEqual(duplicated.nodes.map(node => node.data), nodes.map(node => node.data));
  assert.ok(duplicated.nodes.every(node => !nodes.some(original => original.id === node.id)));
  assert.equal(duplicated.edges[0].source, duplicated.nodes[0].id);
  assert.equal(duplicated.edges[0].target, duplicated.nodes[1].id);
  duplicated.nodes[0].data.description = 'Changed only the copy';
  assert.equal(nodes[0].data.description, 'Private draft notes 0');
});

test('production insert picker supports bounded pages, provider search, keyboard, drag and compact themes', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'argus-insert-library-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./fixtures/diagram-insert-library-electron.cjs', import.meta.url)), temporary], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const capture = chunk => { output = (output + chunk).slice(-30_000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 55_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
    });
    const result = JSON.parse(output.match(/DIAGRAM_INSERT_LIBRARY_RESULT=(.+)/)?.[1] || '{}');
    assert.equal(result.ok, true);
    assert.ok(result.scenarios >= 109);
    assert.equal(result.networkRequests, 0);
  } finally {
    if (process.env.ARGUS_DIAGRAM_INSERT_CAPTURE === '1') console.log('Insert library screenshots: ' + temporary);
    else await rm(temporary, { recursive: true, force: true });
  }
});
