import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import { exportStructuredSvg } from '../frontend/features/diagrams/diagram-svg.mjs';

const studioStyles = await readFile(new URL('../frontend/features/diagrams/diagram-studio.css', import.meta.url), 'utf8');
const sharedStyles = await readFile(new URL('../canvas-web/src/styles.css', import.meta.url), 'utf8');
const surfaces = ['bg', 'surface', 'surface-2', 'surface-3'];

function variables(css, selector) {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(match => match[1].trim() === selector);
  assert.ok(rule, `Missing scoped theme rule: ${selector}`);
  return Object.fromEntries([...rule[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
}

const dark = variables(studioStyles, '.diagram-studio');
const light = variables(studioStyles, ':root[data-theme="light"] .diagram-studio');

function rgb(hex) {
  assert.match(hex, /^#[\da-f]{3}(?:[\da-f]{3})?$/i);
  const full = hex.length === 4 ? hex.slice(1).split('').map(value => value + value).join('') : hex.slice(1);
  return full.match(/../g).map(value => Number.parseInt(value, 16));
}

function luminance(hex) {
  const channels = rgb(hex).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}

function contrast(first, second) {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + .05) / (low + .05);
}

test('Canvas dark theme uses deep neutral layers without a blue-grey wash', () => {
  assert.deepEqual(Object.fromEntries(surfaces.map(key => [key, dark[key]])), {
    bg: '#151515', surface: '#1c1c1c', 'surface-2': '#242424', 'surface-3': '#2c2c2c',
  });
  let previous = 0;
  for (const key of surfaces) {
    const [red, green, blue] = rgb(dark[key]);
    assert.ok(red === green && green === blue, `${key} must remain neutral`);
    const value = luminance(dark[key]);
    assert.ok(value > previous && value < .03, `${key} must be a distinct, bounded dark layer`);
    previous = value;
  }
  assert.equal(dark['diagram-grid'], '#ffffff08', 'the grid must not wash out the drawing surface');
});

test('Canvas labels and secondary text remain readable on every dark layer', () => {
  for (const foreground of ['text', 'muted', 'muted-2']) {
    for (const background of surfaces) {
      const ratio = contrast(dark[foreground], dark[background]);
      assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(contrast(dark['diagram-connector'], dark.bg) >= 3, 'connections remain distinguishable');
});

test('Canvas light palette stays independently scoped and unchanged', () => {
  assert.deepEqual(light, {
    bg: '#f6f7f9', surface: '#fff', 'surface-2': '#edf0f5', 'surface-3': '#e4e9f0',
    text: '#28313e', muted: '#647083', 'muted-2': '#758195', line: '#d7dde6',
    'diagram-connector': '#687386', 'diagram-grid': '#24334e16',
  });
  for (const surface of surfaces) {
    assert.ok(luminance(light[surface]) > .7);
    assert.ok(contrast(light.text, light[surface]) >= 4.5);
  }
});

test('standalone shared Canvas chrome uses the same neutral dark surfaces and text', () => {
  const shared = variables(sharedStyles, ':root');
  for (const key of ['bg', 'surface', 'surface-2', 'text', 'muted', 'line']) {
    assert.equal(shared[key], dark[key], `shared Canvas ${key}`);
  }
  assert.equal(variables(sharedStyles, ':root[data-theme="light"]').bg, '#f4f6fa');
});

test('SVG default and invalid-colour fallbacks match the live dark Canvas palette', () => {
  for (const options of [undefined, { background: 'url(unsafe)', foreground: 'var(--unknown)', line: 'url(unsafe)' }]) {
    const errors = [];
    const document = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) })
      .parseFromString(exportStructuredSvg({ nodes: [], edges: [] }, options), 'image/svg+xml');
    assert.deepEqual(errors, []);
    assert.equal(document.documentElement.getAttribute('fill'), dark.text);
    assert.equal(document.getElementsByTagName('rect')[0].getAttribute('fill'), dark.bg);
    const arrow = Array.from(document.getElementsByTagName('marker')).find(element => element.getAttribute('id') === 'argus-arrow');
    assert.equal(arrow.getElementsByTagName('path')[0].getAttribute('stroke'), dark['diagram-connector']);
  }
});
