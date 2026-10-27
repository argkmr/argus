import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Netlify and static deployments use the same tested CSP and board-only publish directory', async () => {
  const config = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
  const headers = await readFile(new URL('../canvas-web/public/_headers', import.meta.url), 'utf8');
  const policy = config.match(/^Content-Security-Policy = "([^"]+)"$/m)?.[1];
  assert.equal(policy, headers.match(/^\s*Content-Security-Policy: (.+)$/m)?.[1]);
  assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(config, /publish\s*=\s*"canvas-web\/dist"/);
  assert.doesNotMatch(config, /force\s*=\s*true|\/api\/|localhost:4173/);
});

test('desktop packaging includes the board server, its shared model and production transports', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('canvas-server/**/*.mjs'));
  assert.ok(pkg.build.files.includes('frontend/features/diagrams/**/*.mjs'));
  for (const name of ['yjs', 'ws']) assert.ok(pkg.dependencies[name]);
  const sourceBundle = await readFile(new URL('../scripts/build-source-bundle.mjs', import.meta.url), 'utf8');
  for (const name of ['canvas-web', 'canvas-server', 'netlify.toml']) assert.ok(sourceBundle.includes(`"${name}"`));
});
