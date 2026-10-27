import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopCanvasSharing } from '../desktop/canvas-sharing.mjs';

const id = '11111111-1111-4111-8111-111111111111';
test('desktop bridge rejects non-loopback upstreams', () => {
  assert.throws(() => createDesktopCanvasSharing({ dataDir: '/unused', baseUrl: 'https://example.com' }), /local Argus/);
  for (const baseUrl of ['http://user:password@localhost:4173', 'http://localhost:4173/other', 'http://localhost:4173/?token=value']) {
    assert.throws(() => createDesktopCanvasSharing({ dataDir: '/unused', baseUrl }), /local Argus/);
  }
});

test('a failed optional listener is cleaned up without blocking private backend shutdown', async () => {
  let closes = 0;
  const bridge = createDesktopCanvasSharing({ dataDir: '/unused', baseUrl: 'http://127.0.0.1:4173',
    serviceFactory: () => ({ start: async () => { throw new Error('Port occupied'); }, close: async () => { closes++; } }),
  });
  const start = assert.rejects(bridge.resume(), /Port occupied/);
  await bridge.close(); await start;
  assert.equal(closes, 1);
});
test('desktop owner operations never accept arbitrary URLs or proxy paths', async () => {
  const requests = []; let callbacks, starts = 0, closes = 0;
  const service = { start: async () => starts++, close: async () => closes++, status: () => ({ running: true }),
    share: value => value, ownerSession: boardId => ({ boardId }), configure: value => value };
  const bridge = createDesktopCanvasSharing({ dataDir: '/unused', baseUrl: 'http://127.0.0.1:4173',
    serviceFactory: options => { callbacks = options; return service; },
    fetchImpl: async (url, options) => { requests.push({ url: String(url), options }); return { ok: true, json: async () => ({ id, revision: 4 }) }; },
  });
  await assert.rejects(bridge.invoke({ action: 'proxy', url: '/api/terminal' }), /Unsupported/);
  await bridge.invoke({ action: 'status' });
  await bridge.invoke({ action: 'share', boardId: id });
  await callbacks.saveBoard({ id, name: 'Shared', snapshot: {} }, 3);
  assert.equal(starts, 1);
  assert.equal(requests[0].url, `http://127.0.0.1:4173/api/diagrams/${id}`);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(JSON.parse(requests[1].options.body).revision, 3);
  await assert.rejects(bridge.invoke({ action: 'share', boardId: '../../terminal' }), /Invalid board/);
  await bridge.close(); assert.equal(closes, 1);
});
