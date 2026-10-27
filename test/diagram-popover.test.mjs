import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../frontend/features/diagrams/useDiagramPopover.js', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(open = true) {
  const listeners = new Map(), frames = new Map(), changes = [], focused = [];
  let cleanup, nextFrame = 0;
  const input = { focus: () => focused.push('input') };
  const panel = { contains: target => target === input, querySelector: () => input };
  const trigger = { contains: target => target === trigger, focus: () => focused.push('trigger') };
  const context = vm.createContext({
    exports: {},
    require: () => ({ useCallback: fn => fn, useRef: value => ({ current: value }), useEffect: fn => { cleanup = fn(); } }),
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
    document: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } },
  });
  vm.runInContext(compiled, context);
  const close = context.exports.useDiagramPopover(open, value => changes.push(value), { current: panel }, { current: trigger });
  return { listeners, frames, changes, focused, input, trigger, close, dispose: () => cleanup?.(), frame: () => { for (const fn of frames.values()) fn(); frames.clear(); } };
}

test('closed pickers install no handlers and do not take focus', () => {
  const h = harness(false);
  assert.equal(h.listeners.size, 0); assert.equal(h.frames.size, 0); assert.deepEqual(h.focused, []);
});
test('open picker focuses search, Escape dismisses and restores the opener', () => {
  const h = harness(); h.frame();
  assert.deepEqual(h.focused, ['input']);
  const event = { key: 'Escape', preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  h.listeners.get('keydown')(event);
  assert.deepEqual(h.changes, [false]); assert.deepEqual(h.focused, ['input', 'trigger']);
  assert.ok(event.prevented && event.stopped);
});
test('outside pointer and keyboard focus dismiss without stealing destination focus', () => {
  const h = harness(); h.frame();
  for (const name of ['pointerdown', 'focusin']) {
    h.listeners.get(name)({ target: h.input }); h.listeners.get(name)({ target: h.trigger });
  }
  assert.deepEqual(h.changes, []);
  h.listeners.get('pointerdown')({ target: {} }); h.listeners.get('focusin')({ target: {} });
  assert.deepEqual(h.changes, [false, false]); assert.deepEqual(h.focused, ['input']);
});
test('explicit close restores focus and unmount cancels pending work and listeners', () => {
  const h = harness(); h.close(); h.dispose();
  assert.deepEqual(h.focused, ['trigger']); assert.equal(h.frames.size, 0); assert.equal(h.listeners.size, 0);
});

test('Studio mounts pickers only on demand and keeps relationship choices outside them', () => {
  const studio = fs.readFileSync(new URL('../frontend/features/diagrams/DiagramStudio.jsx', import.meta.url), 'utf8');
  assert.match(studio, /\[boardsOpen,setBoardsOpen\]=useState\(false\)/);
  assert.match(studio, /\[paletteOpen,setPaletteOpen\]=useState\(false\)/);
  assert.match(studio, /\{boardsOpen&&<section/);
  assert.match(studio, /\{paletteOpen&&!readOnly&&<section/);
  assert.ok(studio.indexOf('aria-label="New connection type"') < studio.indexOf('{paletteOpen&&!readOnly&&<section'));
  assert.match(studio, /aria-label="Selected relationship"/);
  for (const action of ['store.restore(item)', 'store.open(item.id)', 'store.archive()', 'exportBoard(doc)', 'store.flush()', 'store.change(']) assert.ok(studio.includes(action), action);
});
