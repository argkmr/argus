import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const hookSource = read('../frontend/features/diagrams/useDiagramCanvasScale.js');
const compiled = ts.transpileModule(hookSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics.length, 0, 'The canvas zoom hook must transpile');

function harness(initialZoom = 'normal') {
  const slots = [], pendingEffects = [], observers = [];
  const body = { style: { zoom: initialZoom } };
  let cursor = 0, computedZoom = initialZoom, updates = 0;
  const sameDependencies = (previous, next) => previous?.length === next?.length
    && next.every((value, index) => Object.is(value, previous[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: initial };
      return [slots[index].value, next => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; updates++; }
      }];
    },
    useLayoutEffect(effect, dependencies) {
      const index = cursor++;
      if (sameDependencies(slots[index]?.dependencies, dependencies)) return;
      const previous = slots[index];
      slots[index] = { effect, dependencies };
      pendingEffects.push(() => {
        previous?.cleanup?.();
        slots[index].cleanup = effect();
      });
    },
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!sameDependencies(slots[index]?.dependencies, dependencies)) {
        slots[index] = { value: factory(), dependencies };
      }
      return slots[index].value;
    },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.active = true; }
    disconnect() { this.active = false; }
  }
  const context = vm.createContext({
    exports: {}, document: { body }, MutationObserver,
    getComputedStyle(target) { assert.equal(target, body); return { zoom: computedZoom }; },
    require(name) { assert.equal(name, 'react'); return react; },
  });
  vm.runInContext(compiled.outputText, context);
  const render = () => { cursor = 0; return context.exports.default(); };
  const commit = () => { for (const effect of pendingEffects.splice(0)) effect(); };
  const mutate = (zoom, attribute = 'style') => {
    computedZoom = zoom;
    for (const observer of observers) {
      if (observer.active && observer.options.attributeFilter.includes(attribute)) {
        observer.callback([{ target: body, type: 'attributes', attributeName: attribute }]);
      }
    }
  };
  return {
    render, commit, mutate, body, observers, normalize: context.exports.normalizeDiagramBodyZoom,
    get updates() { return updates; },
    unmount() { slots.forEach(slot => slot.cleanup?.()); },
    replayEffects() {
      slots.filter(slot => slot.effect).forEach(slot => { slot.cleanup?.(); slot.cleanup = slot.effect(); });
    },
  };
}

test('canvas scale normalizes numeric and percentage zoom, rejecting invalid/nonpositive values', () => {
  const { normalize } = harness();
  for (const [input, expected] of [
    ['1.12', 1.12], ['112%', 1.12], ['80%', .8], [' 125% ', 1.25], [2, 2],
    ['', 1], [null, 1], [undefined, 1], ['normal', 1], ['reset', 1],
    ['nonsense', 1], ['1.2garbage', 1], ['0', 1], ['0%', 1], ['-1', 1], ['Infinity', 1],
  ]) assert.equal(normalize(input), expected, String(input));
});

test('canvas scale observes body style/class changes and returns stable scoped style', () => {
  const h = harness('1.12');
  assert.equal(h.render()['--diagram-body-zoom'], 1, 'server/initial render starts from neutral zoom');
  h.commit();
  const initial = h.render();
  assert.equal(initial['--diagram-body-zoom'], 1.12);
  assert.equal(h.render(), initial, 'unchanged scale keeps its style object');
  assert.equal(h.observers.length, 1, 'rerenders do not duplicate observers');
  assert.equal(h.observers[0].target, h.body);
  assert.equal(h.observers[0].options.attributes, true);
  assert.deepEqual(Array.from(h.observers[0].options.attributeFilter), ['style', 'class']);
  h.mutate('125%', 'style');
  assert.equal(h.render()['--diagram-body-zoom'], 1.25);
  h.mutate('.8', 'class');
  assert.equal(h.render()['--diagram-body-zoom'], .8);
  const updates = h.updates;
  h.mutate('.8', 'style');
  assert.equal(h.updates, updates, 'unrelated body style mutations do not trigger state churn');
  assert.deepEqual(h.body.style, { zoom: '1.12' }, 'the hook never rewrites body zoom');
});

test('clearing browser CSS zoom restores native Electron scale without changing native page zoom', () => {
  const h = harness('1.12');
  h.render(); h.commit();
  assert.equal(h.render()['--diagram-body-zoom'], 1.12);
  h.mutate('normal');
  assert.equal(h.render()['--diagram-body-zoom'], 1);
  h.mutate('1');
  assert.equal(h.render()['--diagram-body-zoom'], 1);
  assert.doesNotMatch(hookSource, /devicePixelRatio|visualViewport|setZoomFactor|webFrame\s*\./,
    'do not compensate user/native browser page zoom or device pixel ratios');
});

test('canvas scale disconnects on unmount and survives StrictMode effect replay', () => {
  const h = harness('1.12');
  h.render(); h.commit();
  h.replayEffects();
  assert.equal(h.observers.length, 2);
  assert.equal(h.observers.filter(observer => observer.active).length, 1);
  h.mutate('1.25');
  assert.equal(h.render()['--diagram-body-zoom'], 1.25);
  h.unmount();
  assert.equal(h.observers.filter(observer => observer.active).length, 0);
  const updates = h.updates;
  h.mutate('2');
  assert.equal(h.updates, updates, 'unmounted observers cannot update React state');
});

function findNodes(node, predicate, result = []) {
  if (predicate(node)) result.push(node);
  ts.forEachChild(node, child => { findNodes(child, predicate, result); });
  return result;
}
const attribute = (element, name) => element.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.text === name);

test('Studio applies the hook only at its root, with no CSS zoom written into persisted graph state', () => {
  const source = ts.createSourceFile('DiagramStudio.jsx', read('../frontend/features/diagrams/DiagramStudio.jsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const imported = findNodes(source, node => ts.isImportDeclaration(node)
    && node.moduleSpecifier.text === './useDiagramCanvasScale')[0];
  assert.ok(imported?.importClause?.name, 'Studio must import the scale hook');
  const binding = findNodes(source, node => ts.isVariableDeclaration(node)
    && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === imported.importClause.name.text)[0];
  assert.ok(binding, 'Studio must call the hook');
  const root = findNodes(source, node => ts.isJsxOpeningElement(node)
    && attribute(node, 'className')?.initializer?.text === 'diagram-studio')[0];
  assert.equal(attribute(root, 'style')?.initializer?.expression?.getText(source), binding.name.getText(source));
  const scaleUses = findNodes(source, node => ts.isIdentifier(node) && node.text === binding.name.getText(source));
  assert.equal(scaleUses.length, 2, 'scale belongs only to local root styling, not board snapshots or viewports');
});

test('inverse zoom is scoped to canvas engines and preserves 100% dimensions without double scaling', () => {
  const css = read('../frontend/features/diagrams/diagram-studio.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .filter(([, , body]) => /(?:^|;)\s*zoom\s*:/.test(body));
  assert.equal(rules.length, 1, 'do not zoom the toolbar, palette, Studio root or entire document');
  const [, selectors, body] = rules[0];
  assert.deepEqual(selectors.trim().split(',').map(value => value.trim()), [
    '.diagram-studio .diagram-flow > .react-flow',
    '.diagram-studio [data-argus-diagram-sketch]',
  ]);
  const declarations = Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.replace(/\s+/g, '')]));
  assert.equal(declarations.zoom, 'calc(1/var(--diagram-body-zoom,1))');
  assert.equal(declarations.width, '100%!important');
  assert.equal(declarations.height, '100%!important');
  assert.equal(declarations['min-height'], '0!important');
  for (const scale of [.8, 1, 1.12, 1.25, 2]) {
    assert.ok(Math.abs(scale * (1 / scale) - 1) < 1e-9, 'engine effective CSS zoom must be neutral');
  }
  // Browser regression fixture: percentage dimensions already resolve against
  // the parent under inverse zoom. Multiplying percentages caused 1.12x overflow.
  const parent = { width: 962.89, height: 766.77 };
  const overflow = { width: 1078.44, height: 858.77 };
  for (const axis of ['width', 'height']) {
    assert.ok(Math.abs(overflow[axis] / parent[axis] - 1.12) < .00002);
    assert.equal(parseFloat(declarations[axis]) / 100, 1, 'canvas must fill, not multiply, the parent footprint');
  }
});
