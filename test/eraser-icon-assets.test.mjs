import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ERASER_ICONS, ERASER_ICON_CATEGORIES, ERASER_ICON_CATALOG_METADATA, eraserIconUrl, isEraserIconName } from '../frontend/features/diagrams/diagram-eraser-icons.mjs';
import { createEraserIconAssetStore } from '../frontend/features/diagrams/eraser-icon-assets.mjs';
import { eraserSvgDataUri, isMonochromeEraserSvg, MAX_ERASER_SVG_BYTES, readBoundedIconResponse, sanitizeEraserIconSvg } from '../frontend/features/diagrams/eraser-icon-safety.mjs';
import { createEraserIconFetcher } from '../canvas-server/icon-assets.mjs';

const simpleSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 2L22 22"/></svg>';
const jsonResponse = svg => new Response(JSON.stringify({ svg }), { headers: { 'content-type': 'application/json' } });
const decode = uri => Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
const noCache = { async get() { return null; }, async set() {} };

test('catalog covers every documented family with unique names and an identical Java allowlist', async () => {
  assert.equal(ERASER_ICONS.length, 3951);
  assert.equal(ERASER_ICON_CATALOG_METADATA.count, ERASER_ICONS.length);
  assert.equal(new Set(ERASER_ICONS.map(icon => icon.id)).size, ERASER_ICONS.length);
  assert.deepEqual(ERASER_ICON_CATEGORIES.map(category => category.count), [440, 250, 703, 26, 40, 81, 664, 1747]);
  const names = (await readFile(new URL('../backend/src/main/resources/diagrams/eraser-icon-names.txt', import.meta.url), 'utf8')).trim().split('\n');
  assert.deepEqual(names, ERASER_ICONS.map(icon => icon.iconName));
  assert.ok(ERASER_ICONS.every(icon => icon.role === 'eraser-icon' && icon.id === 'eraser:' + icon.iconName));
});

test('upstream URLs strictly use known names, including documented special characters and legacy alias', () => {
  assert.equal(eraserIconUrl('server'), 'https://storage.googleapis.com/eraser-public-assets/canvas-icons/server.svg');
  assert.ok(eraserIconUrl('aws-elemental-appliances-&-software').endsWith('aws-elemental-appliances-%26-software.svg'));
  assert.ok(eraserIconUrl('azure-web-app-+-database').endsWith('azure-web-app-%2B-database.svg'));
  assert.ok(eraserIconUrl('eraser.io').endsWith('/eraser-io.svg'));
  for (const name of ['../server', 'https://evil.test/x', 'server?x=1', 'SERVER', '%2e%2e%2fserver', 'server\\x', '<script>']) {
    assert.equal(isEraserIconName(name), false);
    assert.throws(() => eraserIconUrl(name), /Unknown/);
  }
});

test('official SVG normalization rejects unsafe or malformed input and removes executable content', async () => {
  for (const raw of ['<html>error</html>', '<svg><animate attributeName="href"/></svg>', '<svg><image href="https://evil.test/a"/></svg>', '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg/>', '<svg><path style="fill:url(https://evil.test/a)"/></svg>', 'x'.repeat(MAX_ERASER_SVG_BYTES + 1)]) {
    await assert.rejects(sanitizeEraserIconSvg(raw, 'server'));
  }
  const cleaned = await sanitizeEraserIconSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><path d="M1 1L2 2"/></svg>', 'server');
  assert.doesNotMatch(cleaned, /script|onload|alert/);
  await assert.rejects(sanitizeEraserIconSvg(simpleSvg, '../server'), /Unknown/);
});

test('normalization keeps genuine gradients and viewboxes while image context adapts monochrome ink', async () => {
  const mono = await sanitizeEraserIconSvg(simpleSvg, 'server');
  assert.ok(isMonochromeEraserSvg(mono));
  assert.match(decode(eraserSvgDataUri(mono, 'server', { color: '#f1f3f5' })), /stroke="#f1f3f5"/);
  assert.match(decode(eraserSvgDataUri(mono, 'server', { color: 'rgb(10, 20, 30)' })), /rgb\(10, 20, 30\)/);
  assert.throws(() => eraserSvgDataUri(mono, 'server', { color: '"><script>' }), /color/);
  const gradient = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><defs><linearGradient id="a"><stop stop-color="#c8511b"/></linearGradient></defs><path fill="url(#a)" d="M0 0L40 40"/></svg>';
  const normalized = await sanitizeEraserIconSvg(gradient, 'aws-lambda');
  assert.match(normalized, /viewBox="0 0 40 40"/);
  assert.equal(isMonochromeEraserSvg(normalized), false);
  assert.match(decode(eraserSvgDataUri(normalized, 'aws-lambda', { color: '#ffffff' })), /#c8511b/);
  const cisco = await sanitizeEraserIconSvg(simpleSvg.replace('viewBox=', 'xmlns:svg="http://www.w3.org/2000/svg" viewBox='), 'cisco-access-point');
  assert.doesNotMatch(cisco, /xmlns:svg/);
  await assert.rejects(sanitizeEraserIconSvg(simpleSvg.replace('viewBox=', 'xmlns:svg="https://evil.test" viewBox='), 'cisco-access-point'));
  const twoTone = await sanitizeEraserIconSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="black"/><circle cx="12" cy="12" r="6" fill="white"/></svg>', 'redis');
  assert.equal(isMonochromeEraserSvg(twoTone), false);
  const twoToneImage = decode(eraserSvgDataUri(twoTone, 'redis', { color: '#123456' }));
  assert.match(twoToneImage, /fill="black"/); assert.match(twoToneImage, /fill="white"/);
  assert.equal(isMonochromeEraserSvg(twoTone.replace(' fill="black"', '')), false);
});

test('response reader enforces declared and streaming sizes', async () => {
  await assert.rejects(readBoundedIconResponse(new Response('abc', { headers: { 'content-length': '1000' } }), 10), /size/);
  await assert.rejects(readBoundedIconResponse(new Response('01234567890'), 10), /size/);
  assert.equal(await readBoundedIconResponse(new Response('okay'), 10), 'okay');
});

test('browser loads are deduplicated and cached raw SVG supports any color variant synchronously', async () => {
  let calls = 0;
  let saved;
  const store = createEraserIconAssetStore({ persistentCache: { ...noCache, async set(name, svg) { saved = { name, svg }; } }, fetcher: async () => { calls++; return jsonResponse(simpleSvg); } });
  const [a, b] = await Promise.all([store.load('server'), store.load('server')]);
  assert.equal(calls, 1); assert.equal(a, b); assert.equal(saved.name, 'server');
  assert.equal(store.isMonochrome('server'), true); assert.equal(store.isMonochrome('user'), null);
  assert.match(decode(store.getCached('server', { color: '#123456' })), /#123456/);
  assert.equal(store.getCached('not-real'), null);
  await assert.rejects(store.load('../server'), /Unknown/);
});

test('persistent icons survive offline reload; malformed stored markup is refetched', async () => {
  const store = createEraserIconAssetStore({ persistentCache: { async get() { return simpleSvg; } }, fetcher: async () => { throw new Error('offline'); } });
  assert.match(await store.load('server'), /^data:image\/svg\+xml;base64,/);
  let calls = 0;
  const badCache = createEraserIconAssetStore({ persistentCache: { async get() { return '<html>not an icon</html>'; } }, fetcher: async () => { calls++; return jsonResponse(simpleSvg); } });
  await badCache.load('server'); assert.equal(calls, 1);
});

test('bounded memory evicts older entries; storage denial does not break display', async () => {
  const store = createEraserIconAssetStore({ maxEntries: 1, persistentCache: { async get() { throw new Error('denied'); }, async set() { throw new Error('quota'); } }, fetcher: async () => jsonResponse(simpleSvg) });
  await store.load('server'); await store.load('user');
  assert.equal(store.getCached('server'), null); assert.ok(store.getCached('user'));
});

test('browser direct loads enforce global concurrency and resolve refreshed authentication at dispatch', async () => {
  let active = 0; let maximum = 0; let token = 'initial'; const observed = [];
  const store = createEraserIconAssetStore({ concurrency: 2, persistentCache: noCache, headers: () => ({ Authorization: `Bearer ${token}` }), proxyBaseUrl: 'https://canvas.example/v1/icons', fetcher: async (url, options) => {
    observed.push([url, options.headers.Authorization]); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5)); token = 'refreshed'; active--; return jsonResponse(simpleSvg);
  } });
  await Promise.all(['server', 'user', 'cloud', 'monitor', 'database'].map(name => store.load(name)));
  assert.equal(maximum, 2); assert.ok(observed.some(([, auth]) => auth === 'Bearer refreshed'));
  assert.ok(observed.every(([url]) => url.startsWith('https://canvas.example/v1/icons/')));
  assert.throws(() => store.configure({ proxyBaseUrl: 'javascript:alert(1)' }), /Invalid/);
  assert.throws(() => store.configure({ proxyBaseUrl: 'https://user:secret@example.com' }), /Invalid/);
});

test('a cold board with150distinct icons queues successfully within bounded global concurrency', async () => {
  let active = 0; let maximum = 0; let calls = 0;
  const store = createEraserIconAssetStore({ persistentCache: noCache, fetcher: async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--; return jsonResponse(simpleSvg);
  } });
  const results = await Promise.all(ERASER_ICONS.slice(0, 150).map(icon => store.load(icon.iconName)));
  assert.equal(calls, 150); assert.equal(maximum, 4); assert.equal(results.length, 150);
  assert.ok(results.every(result => result.startsWith('data:image/svg+xml;base64,')));
});

test('failures back off and explicit retry recovers; prefetch exposes missing icons', async () => {
  let calls = 0;
  const store = createEraserIconAssetStore({ persistentCache: noCache, fetcher: async () => ++calls === 1 ? new Response('', { status: 503 }) : jsonResponse(simpleSvg) });
  await assert.rejects(store.load('server'), /503/);
  await assert.rejects(store.load('server'), /503/); assert.equal(calls, 1);
  await store.load('server', { retry: true }); assert.equal(calls, 2);
  const result = await store.prefetch(['server', 'user', '../private']);
  assert.equal(result.size, 2); assert.ok(result.get('user'));
});

test('server fetcher uses fixed encoded URL, never forwards credentials, deduplicates and bounds concurrency', async () => {
  let calls = 0; let active = 0; let maximum = 0;
  const fetchIcon = createEraserIconFetcher({ concurrency: 2, fetcher: async (url, options) => {
    calls++; active++; maximum = Math.max(maximum, active);
    assert.match(url, /^https:\/\/storage\.googleapis\.com\/eraser-public-assets\/canvas-icons\//);
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return new Response(simpleSvg);
  } });
  await Promise.all(['server', 'server', 'user', 'cloud', 'monitor'].map(fetchIcon));
  assert.equal(calls, 4); assert.equal(maximum, 2);
  await fetchIcon('server'); assert.equal(calls, 4);
  await assert.rejects(fetchIcon('https://evil.test'), /Unknown/);
});

test('server failures and oversize assets do not enter cache; recovery retries after backoff', async () => {
  let calls = 0; let clock = 0;
  const fetchIcon = createEraserIconFetcher({ now: () => clock, retryDelayMs: 50, fetcher: async () => ++calls === 1 ? new Response('<html>oops</html>') : new Response(simpleSvg) });
  await assert.rejects(fetchIcon('server')); await assert.rejects(fetchIcon('server')); assert.equal(calls, 1);
  clock = 51; assert.match(await fetchIcon('server'), /<svg/); assert.equal(calls, 2);
  const huge = createEraserIconFetcher({ fetcher: async () => new Response('x'.repeat(MAX_ERASER_SVG_BYTES + 1)) });
  await assert.rejects(huge('server'), /size/);
});
