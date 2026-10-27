// Real JSX + production CSS, isolated from the user's profile and the network.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const temporary = process.argv[2], root = path.resolve(__dirname, '../..');
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-diagram-replicas-')) throw new Error('Isolated fixture directory required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0;
const timer = setTimeout(() => { console.error('Replica layout timed out'); app.exit(1); }, 40_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
app.whenReady().then(async () => {
  const catalog = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-catalog.mjs')));
  const replicas = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-replicas.mjs')));
  const visuals = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-visuals.mjs')));
  const assets = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/eraser-icon-assets.mjs')));
  const architectureSymbols = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-architecture-symbols.mjs')));
  const expandedLayout = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-expanded-layout.mjs')));
  const sequence = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-sequence.mjs')));
  const expandedRouting = await import(pathToFileURL(path.join(root, 'frontend/features/diagrams/diagram-expanded-routing.mjs')));
  const source = await fs.readFile(path.join(root, 'frontend/features/diagrams/DiagramNodes.jsx'), 'utf8');
  const styles = await fs.readFile(path.join(root, 'frontend/features/diagrams/diagram-nodes.css'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ exports: {}, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return require('react/jsx-runtime');
    if (name === 'react-dom') return { createPortal: () => { throw new Error('Closed notes must not mount a portal'); } };
    if (name === '@xyflow/react') return { Handle: () => null, NodeResizer: () => null, Position: {}, useUpdateNodeInternals: () => () => {} };
    if (name === './diagram-catalog.mjs') return catalog;
    if (name === './diagram-replicas.mjs') return replicas;
    if (name === './diagram-visuals.mjs') return visuals;
    if (name === './eraser-icon-assets.mjs') return assets;
    if (name === './diagram-architecture-symbols.mjs') return architectureSymbols;
    if (name === './diagram-expanded-layout.mjs') return expandedLayout;
    if (name === './diagram-sequence.mjs') return sequence;
    if (name === './diagram-expanded-routing.mjs') return expandedRouting;
    if (name === './useDiagramPopover') return { useDiagramPopover: () => () => {} };
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected import ${name}`);
  } });
  vm.runInContext(compiled, context);
  const isolated = session.fromPartition('diagram-replicas-regression', { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 900, height: 500, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const shell = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>:root{--text:#eceff4;--surface:#171b22;--surface-2:#212833;--line:#303a48;--muted:#a0abba;--muted-2:#667180;--accent:#d5ff52}*{box-sizing:border-box}body{margin:0;font:13px Arial;background:#111419}#fixture{position:absolute;left:70px;top:70px;height:170px}${styles}</style></head><body><div id="fixture"></div></body></html>`;
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(shell));
  let scenarios = 0;
  for (const width of [180, 240, 400]) for (const height of [160, 320]) for (const count of [1, 4, 1000]) for (const componentKey of ['worker', 'redis', 'queue', 'rabbitmq']) for (const selected of [false, true]) {
    const markup = renderToStaticMarkup(React.createElement(context.exports.ComponentNode, { id: 'fixture-node', data: { name: 'Workers with a deliberately long display name', description: 'Processes jobs in parallel', componentKey, replicas: count }, selected, isConnectable: true }));
    const geometry = await window.webContents.executeJavaScript(`(()=>{
      const fixture=document.querySelector('#fixture');fixture.style.width=${width}+'px';fixture.style.height=${height}+'px';fixture.innerHTML=${JSON.stringify(markup)};
      const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const face=document.querySelector('.diagram-architecture-face');
      const symbol=document.querySelector('.diagram-architecture-symbol');
      const primary=symbol.querySelector(':scope > .diagram-component-glyph');
      const faceStyle=getComputedStyle(face);
      return {face:rect(face),symbol:rect(symbol),glyph:rect(primary),badge:rect(document.querySelector('.diagram-replica-count')),name:rect(document.querySelector('[aria-label="Component name"]')),notes:rect(document.querySelector('[aria-label^="Notes for "]')),descriptionVisible:!!document.querySelector('[aria-label="Component description"],[aria-label="Component notes"]'),count:document.querySelector('.diagram-replica-input').value,layers:document.querySelectorAll('.diagram-replica-layers>span').length,ghosts:[...document.querySelectorAll('.diagram-replica-layers>span')].map(n=>({hasGlyph:!!n.querySelector('svg'),background:getComputedStyle(n).backgroundColor,border:getComputedStyle(n).borderTopWidth})),actionsOpacity:getComputedStyle(document.querySelector('.diagram-replica-actions')).opacity,background:faceStyle.backgroundColor,border:faceStyle.borderTopWidth};
    })()`);
    const detail = JSON.stringify({ width, height, count, componentKey, selected, geometry });
    assert.equal(geometry.count, String(count)); assert.equal(geometry.layers, Math.min(3, count - 1));
    assert.equal(geometry.actionsOpacity, selected ? '1' : '0');
    assert.equal(geometry.background, 'rgba(0, 0, 0, 0)', 'HLD retained a card background: ' + detail);
    assert.equal(geometry.border, '0px', 'HLD retained a card border: ' + detail);
    assert.equal(geometry.descriptionVisible, false, 'Description must live in a closed notes popover: ' + detail);
    for (const ghost of geometry.ghosts) {
      assert.equal(ghost.hasGlyph, true, 'Replicas must repeat the symbol: ' + detail);
      assert.equal(ghost.background, 'rgba(0, 0, 0, 0)', 'Replica retained a card background: ' + detail);
      assert.equal(ghost.border, '0px', 'Replica retained a card border: ' + detail);
    }
    for (const item of [geometry.symbol, geometry.glyph, geometry.badge, geometry.name, geometry.notes]) assert.ok(item.left >= geometry.face.left && item.right <= geometry.face.right + .5 && item.top >= geometry.face.top && item.bottom <= geometry.face.bottom + .5, 'Content escaped face: ' + detail);
    assert.ok(geometry.symbol.width >= 64 && geometry.symbol.height >= 64, 'The technology symbol is not prominent: ' + detail);
    assert.ok(geometry.symbol.right <= geometry.notes.left, 'Notes overlap the technology symbol: ' + detail);
    assert.ok(geometry.symbol.bottom <= geometry.name.top, 'Technology symbol overlaps its label: ' + detail);
    assert.ok(geometry.name.bottom <= geometry.badge.top + .5, 'Replica count overlaps label: ' + detail);
    scenarios++;
  }
  console.log('DIAGRAM_REPLICAS_RESULT=' + JSON.stringify({ ok: true, scenarios, networkRequests })); finish(0);
}).catch(error => { console.error(error.stack || error); finish(1); });
