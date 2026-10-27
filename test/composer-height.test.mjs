import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function resizeAgentComposer('), app.indexOf('function selectedModelSettings('));
function resize({ minHeight = '68px', maxHeight = '150px', scrollHeight = 80 } = {}) {
  const input = { value: 'Keep the draft unchanged.', style: {}, scrollHeight };
  const context = vm.createContext({ getComputedStyle: () => ({ minHeight, maxHeight }) });
  vm.runInContext(source, context);
  context.resizeAgentComposer(input);
  assert.equal(input.value, 'Keep the draft unchanged.');
  return input.style.height;
}

test('normal composer auto-height keeps its existing minimum and maximum', () => {
  assert.equal(resize({ scrollHeight: 0 }), '68px');
  assert.equal(resize({ scrollHeight: 95 }), '95px');
  assert.equal(resize({ scrollHeight: 900 }), '150px');
});
test('compact frame CSS limits control empty and multiline composer heights', () => {
  assert.equal(resize({ minHeight: '48px', maxHeight: '96px', scrollHeight: 0 }), '48px');
  assert.equal(resize({ minHeight: '48px', maxHeight: '96px', scrollHeight: 72 }), '72px');
  assert.equal(resize({ minHeight: '48px', maxHeight: '96px', scrollHeight: 900 }), '96px');
});
test('missing CSS geometry retains safe existing limits and inverted limits honor the minimum', () => {
  assert.equal(resize({ minHeight: 'auto', maxHeight: 'none', scrollHeight: 900 }), '150px');
  assert.equal(resize({ minHeight: '68px', maxHeight: '40px', scrollHeight: 900 }), '68px');
});
test('absent composer is harmless', () => {
  const context = vm.createContext({ getComputedStyle: () => { throw Error('Should not read a missing element'); } });
  vm.runInContext(source, context);
  context.resizeAgentComposer(null);
});
