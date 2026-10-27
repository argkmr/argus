import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../frontend/features/diagrams/DiagramStudio.jsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('DiagramStudio.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
let method;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'imageExport') method = node.getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(method, 'the production image export method must exist');
const compiled = ts.transpileModule(method, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics.length, 0);

function harness({ output = new Blob(['png'], { type: 'image/png' }), failure, nodes = [{ id: 'class' }], edges = [], bounds = { width: 300, height: 400 }, expandedBounds = null } = {}) {
  const downloads = [], errors = [], calls = [];
  const viewport = { name: 'react-flow viewport' };
  const root = { querySelector(selector) { assert.equal(selector, '.react-flow__viewport'); return viewport; } };
  const graph = { nodes, edges };
  const context = vm.createContext({
    Blob, graph, expandedBounds, flowRoot: { current: root }, board: { name: 'System diagram' },
    flow: { getNodes: () => graph.nodes, getEdges: () => graph.edges },
    window: { document: { fonts: { ready: Promise.resolve() } } },
    getNodesBounds: () => bounds,
    getStructuredBounds: value => { calls.push(['structured-bounds', value]); return bounds; },
    getViewportForBounds: (...args) => { calls.push(['bounds', args]); return { x: 12, y: 24, zoom: .75 }; },
    getComputedStyle(target) {
      assert.equal(target, root);
      return { getPropertyValue: name => ({ '--bg': '#111419', '--text': '#fafafa', '--muted': '#888888' })[name] || '' };
    },
    filename: value => value,
    download: (...args) => downloads.push(args),
    onError: message => errors.push(message),
    exportStructuredSvg: (...args) => { calls.push(['svg', args]); return '<svg />'; },
    prefetchEraserIcons: async () => new Map(),
    fetch: () => { assert.fail('PNG export must not fetch a data URL under connect-src self'); },
    require(name) {
      assert.equal(name, 'html-to-image');
      calls.push(['import', name]);
      return { toBlob: async (...args) => {
        calls.push(['blob', args]);
        if (failure) throw failure;
        return output;
      } };
    },
  });
  vm.runInContext(compiled.outputText, context);
  return { downloads, errors, calls, viewport, output, run: kind => context.imageExport(kind) };
}

test('PNG export downloads the direct Blob without fetching or converting a data URL', async () => {
  const h = harness();
  await h.run('png');
  assert.deepEqual(h.errors, []);
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0][0], 'System diagram.png');
  assert.equal(h.downloads[0][1], h.output, 'download receives the actual canvas Blob');
  const [viewport, options] = h.calls.find(([name]) => name === 'blob')[1];
  assert.equal(viewport, h.viewport);
  assert.equal(options.width, 1200);
  assert.equal(options.height, 800);
  assert.equal(options.pixelRatio, 1);
  assert.equal(options.backgroundColor, '#111419');
  assert.equal(options.style.transform, 'translate(12px,24px) scale(0.75)');
  const element = (className = '', tag = 'div') => ({ classList: { contains: value => value === className }, matches: value => value.split(',').some(selector => selector.trim() === tag || selector.trim() === `.${className}`) });
  assert.equal(options.filter(element()), true);
  assert.equal(options.filter(element('react-flow__handle')), false);
  assert.equal(options.filter(element('react-flow__resize-control')), false);
  assert.equal(options.filter(element('', 'button')), false);
  assert.equal(options.filter(element('diagram-structure-tools')), false);
  assert.equal(options.filter(element('diagram-structure-stepper')), false);
  assert.doesNotMatch(method, /\bfetch\s*\(|\btoPng\b|toDataURL|\.blob\s*\(/);
});

test('PNG export reports a null Blob and does not download a corrupt placeholder', async () => {
  const h = harness({ output: null });
  await h.run('png');
  assert.deepEqual(h.downloads, []);
  assert.deepEqual(h.errors, ['Could not export image: The browser could not create a PNG image. Try again or export SVG.']);
});

test('compact PNG includes manually routed arrows and moved labels outside node bounds',async()=>{
  const h=harness({edges:[{id:'route',data:{routing:'elbow',waypoints:[{x:-900,y:-400}],labelOffset:{x:0,y:-80}}}]});
  await h.run('png');assert.deepEqual(h.errors,[]);assert.equal(h.calls.filter(([name])=>name==='structured-bounds').length,1);
});

test('expanded PNG includes the routed connector and label extents, not only node bounds', async () => {
  const expandedBounds={x:-200,y:-150,width:1600,height:900};
  const h=harness({expandedBounds});
  await h.run('png');
  assert.deepEqual(h.errors,[]);
  assert.equal(h.calls.find(([name])=>name==='bounds')[1][0],expandedBounds);
  const options=h.calls.find(([name])=>name==='blob')[1][1];
  assert.equal(options.width,1720);
  assert.equal(options.height,1020);
});

test('sequence PNG includes captions and self-calls using the shared vector bounds', async () => {
  const bounds={x:-100,y:-80,width:900,height:650};
  const h=harness({nodes:[{id:'actor',type:'participant'}],bounds});
  await h.run('png');
  assert.deepEqual(h.errors,[]);
  assert.equal(h.calls.filter(([name])=>name==='structured-bounds').length,1);
  assert.equal(h.calls.find(([name])=>name==='bounds')[1][0],bounds);
});

test('PNG export reports rasterizer rejection and bounds export dimensions', async () => {
  const h = harness({ failure: new Error('Canvas is unavailable'), bounds: { width: 9000, height: 6000 } });
  await h.run('png');
  assert.deepEqual(h.downloads, []);
  assert.deepEqual(h.errors, ['Could not export image: Canvas is unavailable']);
  const options = h.calls.find(([name]) => name === 'blob')[1][1];
  assert.equal(options.width, 4096);
  assert.equal(options.height, 4096);
});

test('empty scenes stop before loading the PNG renderer and SVG keeps its vector path', async () => {
  const empty = harness({ nodes: [] });
  await empty.run('png');
  assert.equal(empty.calls.length, 0);
  assert.deepEqual(empty.errors, ['Could not export image: Add an object before exporting.']);
  const svg = harness();
  await svg.run('svg');
  assert.deepEqual(svg.errors, []);
  assert.deepEqual(svg.downloads, [['System diagram.svg', '<svg />', 'image/svg+xml;charset=utf-8']]);
  assert.equal(svg.calls.some(([name]) => name === 'import' || name === 'blob'), false);
});
