import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const css = (await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
function rule(selector) {
  const body = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(match => match[1].trim() === selector)?.[2];
  assert.ok(body, `Missing clone action rule: ${selector}`);
  return Object.fromEntries(body.split(';').flatMap(entry => {
    const colon = entry.indexOf(':');
    return colon < 0 ? [] : [[entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]];
  }));
}
const button = rule('.repo-clone-button');

test('the destination card uses readable light-theme surfaces inside onboarding only', () => {
  const finder = rule(':root[data-theme="light"] .repo-onboarding-source > .finder-button');
  assert.equal(finder.background, 'var(--surface-1)');
  assert.equal(finder.color, 'var(--text)');
  assert.equal(finder['border-color'], 'var(--line)');
});

test('Clone is a scoped primary action without submitting the onboarding form', () => {
  const markup = html.match(/<button\b[^>]*\bid="clone-repository"[^>]*>/)?.[0];
  assert.ok(markup);
  assert.match(markup, /type="button"/);
  assert.match(markup, /class="[^"]*\brepo-clone-button\b/);
  assert.equal(button.background, 'var(--accent)');
  assert.equal(button.color, 'var(--accent-ink)');
  assert.equal(button.border, '1px solid transparent');
  assert.equal(button.appearance, 'none');
  assert.equal(button['-webkit-appearance'], 'none');
});

test('Clone uses compact dialog-action type and padding, retaining the selected font', () => {
  assert.equal(button['font-size'], rule('.primary-button')['font-size']);
  assert.equal(button['font-size'], '11px');
  assert.equal(button['font-family'], 'inherit');
  assert.equal(button['font-weight'], '650');
  assert.equal(button['line-height'], '1.4');
  assert.equal(button['min-height'], rule('.primary-button')['min-height']);
  assert.equal(button.height, 'auto');
  assert.equal(button.padding, '7px 14px');
  assert.equal(button['border-radius'], '8px');
  assert.equal(button.display, 'inline-flex');
  assert.equal(button['align-items'], 'center');
  assert.equal(button['justify-content'], 'center');
  assert.equal(button['justify-self'], 'end');
});

test('Clone remains within narrow dialogs and can grow for enlarged fonts without clipping', () => {
  assert.equal(button['min-width'], 'min(148px, 100%)');
  assert.equal(button['max-width'], '100%');
  assert.equal(button.width, 'auto');
  assert.equal(button['white-space'], 'normal');
  assert.equal(button['overflow-wrap'], 'anywhere');
  for (const property of ['transform', 'zoom', 'overflow', 'text-overflow']) assert.equal(button[property], undefined);
});

test('Clone has explicit disabled, loading, pointer and keyboard states', () => {
  assert.ok(rule('.repo-clone-button:hover:not(:disabled)').background);
  assert.ok(rule('.repo-clone-button:active:not(:disabled)').background);
  const disabled = rule('.repo-clone-button:disabled');
  assert.equal(disabled.cursor, 'not-allowed');
  assert.equal(disabled.opacity, '1');
  assert.equal(disabled.background, 'var(--surface-3)');
  const busy = rule('.repo-clone-button[aria-busy="true"]');
  assert.equal(busy.cursor, 'progress');
  assert.equal(busy.color, 'var(--text)');
  const spinner = rule('.repo-clone-button[aria-busy="true"]::before');
  assert.equal(spinner.width, '12px');
  assert.match(spinner.animation, /refresh-spin/);
  const focus = rule('.repo-clone-button:focus-visible');
  assert.equal(focus.outline, '2px solid var(--blue)');
  assert.equal(focus['outline-offset'], '3px');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.repo-clone-button \{ transition: none; \}\s*\.repo-clone-button\[aria-busy="true"\]::before \{ animation: none; \}/);
  assert.match(css, /@media \(forced-colors: active\)\s*\{\s*\.repo-clone-button \{ border-color: ButtonText; background: ButtonFace; color: ButtonText; \}/);
});

function luminance(hex) {
  return hex.match(/[\da-f]{2}/gi).map(value => Number.parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}
function contrast(first, second) {
  const [bright, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (bright + .05) / (dark + .05);
}
test('Clone label contrast remains readable in dark and light themes', () => {
  const tokens = rule(':root');
  assert.ok(contrast(tokens['--accent'], tokens['--accent-ink']) >= 4.5);
  const light = rule(':root[data-theme="light"] .repo-clone-button:not(:disabled)');
  assert.equal(light.color, '#fff');
  assert.ok(contrast(light.background, '#ffffff') >= 4.5);
  const hover = rule(':root[data-theme="light"] .repo-clone-button:hover:not(:disabled)');
  assert.ok(contrast(hover.background, '#ffffff') >= 4.5);
});
