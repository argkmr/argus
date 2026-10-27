import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { DEFAULT_FONT_FAMILY, FONT_FAMILIES, FONT_FAMILY_CACHE_KEY, normalizeFontFamily, createFontFamilyPreference, initializeFontFamilyPicker } from '../public/font-family.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function harness(cached = null) {
  const cache = new Map(cached ? [[FONT_FAMILY_CACHE_KEY, cached]] : []);
  const writes = [], changes = [], statuses = [];
  const storage = { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) };
  const preference = createFontFamilyPreference({ storage, save(id) {
    const request = deferred(); writes.push({ id, ...request }); return request.promise;
  }, onChange: id => changes.push(id), onStatus: status => statuses.push(status) });
  return { preference, writes, changes, statuses, cache, storage };
}

test('exactly four safe native font choices include Comic Sans and retain System as default', () => {
  assert.equal(DEFAULT_FONT_FAMILY, 'system');
  assert.deepEqual(FONT_FAMILIES.map(({ id, label }) => [id, label]), [
    ['system', 'System'], ['serif', 'Serif'], ['mono', 'Mono'], ['comic-sans', 'Comic Sans'],
  ]);
  assert.ok(Object.isFrozen(FONT_FAMILIES));
  for (const font of FONT_FAMILIES) {
    assert.ok(Object.isFrozen(font));
    assert.equal(normalizeFontFamily(font.id), font.id);
    assert.doesNotMatch(font.stack, /url\(|https?:/);
  }
  assert.match(FONT_FAMILIES[3].stack, /^"Comic Sans MS", "Chalkboard SE", cursive$/);
});

test('legacy and Next shells both load the font picker and restore its Java preference', async () => {
  const [html, next, app, metadata] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../frontend/app/layout.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  const build = JSON.parse(metadata).argusBuild;
  assert.ok(html.includes(`/font-family.css?v=${build}`));
  assert.ok(next.includes('/legacy/font-family.css?v=${argusBuild}'));
  for (const shell of [html, next]) assert.ok(shell.includes('argus-font-family'));
  const picker = html.match(/<select id="font-family-select"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...picker.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(([, id, label]) => [id, label]), FONT_FAMILIES.map(({ id, label }) => [id, label]));
  assert.ok(app.includes(`./font-family.mjs?v=${build}`));
  assert.match(app, /fontFamilyPicker\.restore\(state\.workspace\.preferences\?\.fontFamily\)/);
  assert.match(app, /save: \(fontFamily\) => api\("\/api\/preferences", \{ method: "PATCH", body: \{ fontFamily \} \}\)/);
});

test('font choice normalization trims known IDs and rejects unsafe or unsupported values', () => {
  assert.equal(normalizeFontFamily(' Comic-Sans '), 'comic-sans');
  for (const value of [undefined, null, {}, [], 3, '', 'Times', '__proto__', 'constructor', '<script>', 'url(https://example.test)']) {
    assert.equal(normalizeFontFamily(value), 'system');
  }
});

test('Java preference restores over the local first-paint cache without writing', () => {
  const h = harness('comic-sans');
  assert.equal(h.preference.selected, 'comic-sans');
  h.preference.restore('serif');
  assert.equal(h.preference.selected, 'serif');
  assert.equal(h.cache.get(FONT_FAMILY_CACHE_KEY), 'serif');
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.changes, ['serif']);
  assert.deepEqual(h.statuses, ['ready']);
  h.preference.restore('mono');
  assert.equal(h.preference.selected, 'mono');
});

test('invalid cache and missing Java preference use the current System font', () => {
  const h = harness('unavailable');
  assert.equal(h.preference.selected, 'system');
  h.preference.restore(undefined);
  assert.equal(h.cache.get(FONT_FAMILY_CACHE_KEY), 'system');
});

test('a selected font is cached immediately and survives a fresh picker initialization', async () => {
  const h = harness();
  const saved = h.preference.select('comic-sans');
  assert.equal(h.cache.get(FONT_FAMILY_CACHE_KEY), 'comic-sans');
  const reloaded = createFontFamilyPreference({ storage: h.storage, save() { throw Error('no startup write'); } });
  assert.equal(reloaded.selected, 'comic-sans');
  await Promise.resolve(); h.writes[0].resolve(); await saved;
  reloaded.restore('comic-sans');
  assert.equal(reloaded.selected, 'comic-sans');
});

test('late workspace restore cannot replace a newer user choice before or after save', async () => {
  const h = harness('system');
  const saved = h.preference.select('comic-sans');
  h.preference.restore('serif');
  assert.equal(h.preference.selected, 'comic-sans');
  assert.equal(h.statuses.at(-1), 'saving');
  await Promise.resolve(); h.writes[0].resolve(); await saved;
  h.preference.restore('system');
  assert.equal(h.preference.selected, 'comic-sans');
  assert.equal(h.statuses.at(-1), 'saved');
});

test('rapid queued font choices coalesce to one final Java save', async () => {
  const h = harness();
  const first = h.preference.select('serif');
  const second = h.preference.select('mono');
  const last = h.preference.select('comic-sans');
  await first; await second; await Promise.resolve();
  assert.deepEqual(h.writes.map(write => write.id), ['comic-sans']);
  assert.deepEqual(h.changes, ['serif', 'mono', 'comic-sans']);
  h.writes[0].resolve(); assert.equal(await last, true);
  assert.equal(h.statuses.at(-1), 'saved');
});

test('an in-flight earlier Java save completes before the final font save', async () => {
  const h = harness();
  const first = h.preference.select('serif'); await Promise.resolve();
  const middle = h.preference.select('mono');
  const last = h.preference.select('comic-sans');
  assert.equal(h.writes.length, 1);
  assert.equal(h.preference.selected, 'comic-sans');
  h.writes[0].resolve(); await first; await middle; await Promise.resolve();
  assert.deepEqual(h.writes.map(write => write.id), ['serif', 'comic-sans']);
  assert.equal(h.statuses.at(-1), 'saving');
  h.writes[1].resolve(); await last;
  assert.equal(h.statuses.at(-1), 'saved');
});

test('a stale failure cannot show a failure or repaint over a newer choice', async () => {
  const h = harness();
  const first = h.preference.select('serif'); await Promise.resolve();
  const last = h.preference.select('mono');
  h.writes[0].reject(Error('offline')); await first; await Promise.resolve();
  assert.ok(!h.statuses.includes('error'));
  assert.equal(h.preference.selected, 'mono');
  h.writes[1].resolve(); await last;
  assert.deepEqual(h.changes, ['serif', 'mono']);
  assert.equal(h.statuses.at(-1), 'saved');
});

test('failure preserves the preview, survives late restore, and retries the selected font', async () => {
  const h = harness();
  const first = h.preference.select('comic-sans'); await Promise.resolve();
  h.writes[0].reject(Error('offline')); assert.equal(await first, false);
  assert.equal(h.statuses.at(-1), 'error');
  h.preference.restore('system');
  assert.equal(h.preference.selected, 'comic-sans');
  assert.equal(h.statuses.at(-1), 'error');
  const retried = h.preference.retry(); await Promise.resolve();
  assert.equal(h.writes[1].id, 'comic-sans');
  h.writes[1].resolve(); assert.equal(await retried, true);
  assert.equal(h.statuses.at(-1), 'saved');
});

test('blocked or absent storage cannot prevent Java persistence', async () => {
  for (const storage of [undefined, { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } }]) {
    const writes = [];
    const preference = createFontFamilyPreference({ storage, save: async id => writes.push(id) });
    preference.restore('mono');
    await preference.select('comic-sans');
    assert.equal(preference.selected, 'comic-sans');
    assert.deepEqual(writes, ['comic-sans']);
  }
});

function pickerDocument() {
  const elements = Object.fromEntries(['select', 'status', 'retry', 'preview'].map(id => [id, {
    dataset: {}, listeners: {}, hidden: false, textContent: '', value: '',
    addEventListener(event, callback) { this.listeners[event] = callback; },
  }]));
  return { elements, document: {
    documentElement: { dataset: {} },
    querySelector(selector) { return elements[selector.replace('#font-family-', '')] ?? null; },
  } };
}

test('picker paints the global font without changing themes or chat state and handles its select', async () => {
  const { elements, document } = pickerDocument();
  document.documentElement.dataset.theme = 'light';
  const writes = [];
  const picker = initializeFontFamilyPicker({ document, save: async id => writes.push(id) });
  assert.equal(elements.select.value, 'system');
  assert.equal(document.documentElement.dataset.fontFamily, 'system');
  assert.equal(elements.retry.hidden, true);
  picker.restore('serif');
  assert.equal(elements.select.value, 'serif');
  assert.equal(elements.preview.title, 'Serif font preview');
  elements.select.value = 'comic-sans'; elements.select.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['comic-sans']);
  assert.equal(document.documentElement.dataset.fontFamily, 'comic-sans');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(elements.status.dataset.state, 'saved');
  assert.match(elements.status.textContent, /Code stays monospace/);
});

test('picker exposes a visible save failure and its retry succeeds without clearing the preview', async () => {
  const { elements, document } = pickerDocument();
  let fail = true;
  const picker = initializeFontFamilyPicker({ document, save: async () => { if (fail) throw Error('offline'); } });
  await picker.select('mono');
  assert.equal(elements.status.dataset.state, 'error');
  assert.equal(elements.retry.hidden, false);
  assert.match(elements.status.textContent, /Could not save font/);
  assert.equal(document.documentElement.dataset.fontFamily, 'mono');
  fail = false; elements.retry.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.status.dataset.state, 'saved');
  assert.equal(elements.retry.hidden, true);
});

test('missing optional picker nodes do not prevent the font from restoring', () => {
  const document = { documentElement: { dataset: {} }, querySelector: () => null };
  const picker = initializeFontFamilyPicker({ document, save: async () => {} });
  picker.restore('comic-sans');
  assert.equal(document.documentElement.dataset.fontFamily, 'comic-sans');
});

test('font CSS uses exactly the four native stacks without overriding code, source or terminal fonts', async () => {
  const css = await fs.readFile(new URL('../public/font-family.css', import.meta.url), 'utf8');
  const module = await fs.readFile(new URL('../public/font-family.mjs', import.meta.url), 'utf8');
  for (const font of FONT_FAMILIES) {
    assert.ok(css.includes(`:root[data-font-family="${font.id}"] { --font-ui: ${font.stack}; }`));
  }
  assert.match(css, /\.agent-output-card > \.agent-rendered-output \{ font-family: inherit; \}/);
  assert.match(css, /\.api-url-input-shell > input, \.api-url-highlight,/);
  assert.match(css, /\.service-command \.service-type \{ font-family: var\(--font-ui\); \}/);
  assert.match(css, /#font-family-retry\[hidden\] \{ display: none; \}/);
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g).join('\n');
  assert.doesNotMatch(selectors, /\b(?:code|pre|monaco|terminal|source-reference|chat-inline-code|chat-code-block)\b/);
  assert.doesNotMatch(css, /@import|@font-face|url\(|--font-mono\s*:|--mono\s*:/);
  assert.doesNotMatch(module, /fetch\(|innerHTML|switchPrimaryView|activeTaskByRepository|activeGlobalTaskId|runAgent/);
});
