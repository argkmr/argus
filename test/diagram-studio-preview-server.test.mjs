import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDiagramStudioPreviewServer } from './fixtures/diagram-studio-preview-server.mjs';
import { emptySnapshot } from '../frontend/features/diagrams/diagram-model.mjs';

async function preview(t) {
  const assetRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const server = createDiagramStudioPreviewServer({ assetRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, method = 'GET', value, headers = {}) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { response, status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  return { base, call };
}

test('diagram preview serves synthetic empty bootstrap data and never proxies unsupported APIs', async t => {
  const h = await preview(t);
  const workspace = await h.call('/api/workspace');
  assert.equal(workspace.status, 200);
  assert.deepEqual(workspace.body.repositories, []);
  assert.deepEqual(workspace.body.runConfigurations, []);
  assert.equal((await h.call('/api/backup/access')).body.allowed, false);
  for (const endpoint of ['/api/agents/providers', '/api/background-jobs', '/api/processes', '/api/integrations/bitbucket', '/api/integrations/slack']) {
    assert.deepEqual((await h.call(endpoint)).body, []);
  }
  assert.equal((await h.call('/api/system/select-folder', 'POST', {})).status, 404);
  assert.equal((await h.call('/api/repositories/private/terminal/start', 'POST', {})).status, 404);
  assert.equal((await h.call('/api/internal/shutdown', 'POST', {})).status, 404);
  assert.equal((await h.call('/mcp/coordination', 'POST', {})).status, 404);
  const asset = await fetch(h.base + '/ide-ux-preview.html');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(asset.headers.get('content-security-policy'), /frame-src 'none'/);
  assert.equal(asset.headers.get('x-argus-preview'), 'synthetic-memory-only');
});

test('diagram preview saves revisions and recoverable archives entirely inside one server instance', async t => {
  const h = await preview(t);
  const created = await h.call('/api/diagrams', 'POST', { name: 'Synthetic class design', snapshot: emptySnapshot() });
  assert.equal(created.status, 201);
  assert.equal(created.body.revision, 1);
  const route = '/api/diagrams/' + created.body.id;
  assert.equal((await h.call('/api/diagrams')).body[0].snapshot, undefined);
  const update = { name: 'Renamed in preview', revision: 1, snapshot: emptySnapshot() };
  assert.equal((await h.call(route, 'PUT', update)).body.revision, 2);
  assert.equal((await h.call(route, 'PUT', update)).status, 409);
  assert.equal((await h.call(route + '?revision=1', 'DELETE')).status, 409);
  assert.equal((await h.call(route + '?revision=2', 'DELETE')).body.archived, true);
  assert.equal((await h.call('/api/diagrams')).body.length, 0);
  assert.equal((await h.call('/api/diagrams?archived=true')).body[0].revision, 3);
  assert.deepEqual((await h.call(route)).body.snapshot, emptySnapshot());
  assert.equal((await h.call(route + '/restore', 'POST', { revision: 3 })).body.revision, 4);
  const secondServer = await preview(t);
  assert.deepEqual((await secondServer.call('/api/diagrams?archived=true')).body, []);
  assert.equal((await secondServer.call(route)).status, 404);
});

test('diagram preview rejects untrusted origins, host headers, and asset mutations', async t => {
  const h = await preview(t);
  assert.equal((await h.call('/api/workspace', 'GET', undefined, { origin: 'https://untrusted.example' })).status, 403);
  // fetch normalizes Host; use the native HTTP client to exercise a forged header.
  const forgedHostStatus = await new Promise((resolve, reject) => {
    http.get(h.base + '/api/workspace', { headers: { host: 'untrusted.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await h.call('/api/workspace', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await h.call('/ide-ux-preview.html', 'POST', {})).status, 405);
  assert.equal((await h.call('/api/diagrams', 'POST', { name: 'Missing snapshot' })).status, 400);
  const asset = await fetch(h.base + '/%2e%2e%2f%2e%2e%2fpackage.json');
  assert.equal(asset.status, 400);
});

test('preview permanent deletion checks revisions and removes active and archived boards only when requested', async t => {
  const h = await preview(t);
  for (const archived of [false, true]) {
    const created = await h.call('/api/diagrams', 'POST', { name: 'Disposable preview board', snapshot: emptySnapshot() });
    const route = '/api/diagrams/' + created.body.id;
    if (archived) await h.call(route + '?revision=1', 'DELETE');
    const revision = archived ? 2 : 1;
    assert.equal((await h.call(route + '/permanent', 'DELETE')).status, 409);
    assert.equal((await h.call(route + '/permanent?revision=0', 'DELETE')).status, 409);
    assert.equal((await h.call(route + '/permanent', 'POST', { revision })).status, 405);
    assert.equal((await h.call(route)).status, 200);
    assert.equal((await h.call(route + '/permanent?revision=' + revision, 'DELETE')).status, 204);
    assert.equal((await h.call(route)).status, 404);
    assert.equal((await h.call(route + '/restore', 'POST', { revision })).status, 404);
  }
  assert.deepEqual((await h.call('/api/diagrams?archived=true')).body, []);
});
