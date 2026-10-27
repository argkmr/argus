import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [html, css] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/font-family.css', import.meta.url), 'utf8'),
]);
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
function declarations(selector) {
  const matching = rules.filter(([, selectors]) => selectors.trim().split(/\s*,\s*/).includes(selector));
  assert.ok(matching.length, `Missing appearance rule: ${selector}`);
  return Object.fromEntries(matching.flatMap(([, , body]) => body.split(';').flatMap(entry => {
    const colon = entry.indexOf(':');
    return colon < 0 ? [] : [[entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]];
  })));
}
const card = html.match(/<section\b[^>]*class="appearance-settings"[^>]*>[\s\S]*?<\/section>/)?.[0];
function element(tag, id) {
  const markup = card?.match(new RegExp(`<${tag}\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
  assert.ok(markup, `Missing ${tag}#${id} inside Appearance`);
  return markup;
}

test('Appearance groups three labeled rows and preserves existing control hooks', () => {
  assert.ok(card);
  assert.match(card, /aria-labelledby="appearance-settings-heading"/);
  assert.match(card, /<h2 id="appearance-settings-heading">Appearance<\/h2>/);
  assert.equal([...card.matchAll(/class="[^"]*\bappearance-row\b[^"]*"/g)].length, 3);
  assert.match(card, /<span\b[^>]*id="font-size-label"[^>]*>Font size<\/span>/);
  assert.match(card, /role="group" aria-labelledby="font-size-label"/);
  assert.match(card, /<label\b[^>]*for="font-family-select"[^>]*>Font<\/label>/);
  assert.match(element('select', 'font-family-select'), /aria-describedby="font-family-status"/);
  assert.match(card, /class="appearance-label">Theme<\/span>/);
  assert.match(element('button', 'theme-toggle'), /type="button"[^>]*aria-label="Switch to light mode"/);
  element('strong', 'theme-menu-label');
  assert.match(card, /class="theme-menu-icon" aria-hidden="true"/);
  assert.match(element('button', 'font-family-retry'), /type="button"[^>]*\bhidden\b/);
  for (const size of ['compact', 'comfortable', 'large']) {
    const button = card.match(new RegExp(`<button\\b[^>]*data-font-size="${size}"[^>]*>`))?.[0];
    assert.ok(button, `Missing ${size} font-size control`);
    assert.match(button, /type="button"/);
    assert.match(button, /aria-label="[^"]+ font size"/);
  }
});

test('footer owns spacing while all appearance rows share label and control columns', () => {
  const footer = declarations('.appearance-settings');
  assert.equal(footer['margin-top'], 'auto');
  assert.equal(footer.flex, '0 0 auto');
  const row = declarations('.appearance-settings .appearance-row');
  assert.equal(row.display, 'grid');
  assert.match(row['grid-template-columns'], /^\d+px minmax\(0,\s*1fr\)$/);
  assert.equal(row['align-items'], 'center');
  assert.equal(row.margin, '0');
  assert.equal(row.padding, '0');
  assert.equal(row['min-width'], '0');
  const label = declarations('.appearance-settings .appearance-label');
  assert.equal(label.margin, '0');
  assert.equal(label.padding, '0');
  const segment = declarations('.appearance-settings .font-size-setting > div');
  const select = declarations('#font-family-select');
  const theme = declarations('.appearance-settings #theme-toggle');
  assert.match(segment['grid-template-columns'], /^repeat\(3,\s*minmax\(0,\s*1fr\)\)$/);
  for (const control of [segment, select, theme]) {
    assert.equal(control.width, '100%');
    assert.equal(control.height, row['min-height']);
  }
});

test('nested theme action resets the icon-only layout and keeps its label beside the icon', () => {
  const theme = declarations('.appearance-settings #theme-toggle');
  assert.equal(theme.display, 'flex');
  assert.equal(theme.flex, 'none');
  assert.equal(theme['align-items'], 'center');
  assert.equal(theme['justify-content'], 'flex-start');
  assert.equal(theme['text-align'], 'left');
  assert.ok(Number.parseFloat(theme.gap) > 0);
  assert.equal(declarations('.appearance-settings #theme-menu-label')['white-space'], 'nowrap');
});

test('routine save announcements remain accessible and failures restore readable inline feedback', () => {
  const markup = element('small', 'font-family-status');
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.doesNotMatch(markup, /\bhidden\b|aria-hidden/);
  const routine = declarations('#font-family-status');
  assert.equal(routine.position, 'absolute');
  assert.equal(routine.width, '1px');
  assert.equal(routine.height, '1px');
  assert.equal(routine.display, undefined);
  assert.equal(routine.visibility, undefined);
  const failure = { ...routine, ...declarations('#font-family-status[data-state="error"]') };
  assert.equal(failure.position, 'static');
  assert.equal(failure.width, 'auto');
  assert.equal(failure.height, 'auto');
  assert.equal(failure.margin, '0');
  assert.equal(failure.overflow, 'visible');
  assert.equal(failure['clip-path'], 'none');
  assert.equal(failure['white-space'], 'normal');
  assert.equal(failure['overflow-wrap'], 'anywhere');
  assert.equal(failure['grid-column'], '1 / -1');
  assert.equal(declarations('#font-family-retry[hidden]').display, 'none');
});

test('keyboard focus is visible for buttons and the select without erasing its shared arrow', () => {
  for (const selector of ['.appearance-settings button:focus-visible', '#font-family-select:focus-visible']) {
    const focus = declarations(selector);
    assert.match(focus.outline, /^[1-9]\d*px solid var\(--accent\)$/);
    assert.ok(Number.parseFloat(focus['outline-offset']) > 0);
  }
  assert.equal(declarations('.appearance-settings .font-size-setting > div').overflow, 'visible');
  const select = declarations('#font-family-select');
  assert.equal(select['background-color'], 'var(--surface)');
  assert.equal(select.background, undefined, 'background shorthand would remove the shared dropdown arrow');
  assert.equal(select['background-image'], undefined);
});
