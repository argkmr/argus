import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const styles = (await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
function rule(selector) {
  const body = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].trim() === selector).at(-1)?.[2];
  assert.ok(body, `Missing rule ${selector}`);
  return Object.fromEntries(body.split(';').flatMap(entry => {
    const colon = entry.indexOf(':');
    return colon < 0 ? [] : [[entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]];
  }));
}

test('Nexus is a compact shortcut with a usable target centered on the tab baseline', () => {
  const shortcut = rule('.repository-nexus-button');
  assert.equal(shortcut.height, '28px');
  assert.equal(shortcut['min-height'], shortcut.height);
  assert.ok(parseFloat(shortcut.height) >= 24);
  // Repository cards leave a separate underline lane; Nexus remains a compact
  // centered action, without shrinking its existing 28px hit target.
  assert.equal(rule('.repo-tab').height, '26px');
  assert.equal(parseFloat(shortcut.height) - parseFloat(rule('.repo-tab').height), 2);
  assert.equal(shortcut.padding, '0 9px');
  assert.equal(shortcut.gap, '5px');
  assert.equal(shortcut['border-radius'], '7px');
  assert.equal(shortcut['align-items'], 'center');
  assert.equal(rule('.repository-toolbar')['align-items'], 'center');
  assert.equal(shortcut.transform, undefined, 'Shrink layout dimensions, not the hit target with a transform');
});

test('compact Nexus retains readable repository-sized type, selected font and explicit icon size', () => {
  const label = rule('.repository-nexus-button strong');
  assert.equal(label['font-size'], rule('.repo-tab-label')['font-size']);
  assert.equal(label['font-weight'], rule('.repo-tab-label')['font-weight']);
  assert.equal(rule('.repository-nexus-button span')['font-size'], '14px');
  assert.equal(label['font-family'], undefined);
});

test('shortcut retains its accessible action, active palette and keyboard focus', () => {
  assert.match(html, /<button id="nexus-shortcut" class="repository-nexus-button" type="button"[^>]*aria-label="Open Nexus"><span aria-hidden="true">✦<\/span><strong>Nexus<\/strong><\/button>/);
  const selected = rule('body[data-view="global"] #nexus-shortcut');
  assert.equal(selected['border-color'], 'var(--nexus-accent)');
  assert.equal(selected.background, 'var(--nexus-surface-3)');
  assert.equal(selected.height, undefined, 'Active theme must not restore the oversized button');
  assert.equal(rule('.repository-nexus-button:focus-visible, .chat-message-edit:focus-visible').outline, '2px solid var(--accent)');
});
