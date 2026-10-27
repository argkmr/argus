// Real picker logic and catalog, with artwork stubbed to keep this fixture offline.
// Never opens a live Argus profile, backend, board or external icon URL.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const ts = require('typescript');
const temporary = process.argv[2], root = path.resolve(__dirname, '../..');
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-insert-library-')) throw new Error('Isolated fixture directory required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0, scenarios = 0;
const errors = [];
const timer = setTimeout(() => { console.error('Insert library fixture timed out'); app.exit(1); }, 50_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(40); } throw new Error('Timed out: ' + label); }

app.whenReady().then(async () => {
  const directory = path.join(root, 'frontend/features/diagrams'), modules = {};
  for (const [name, file] of Object.entries({ react: 'react/cjs/react.production.js', 'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js', 'react-dom': 'react-dom/cjs/react-dom.production.js', 'react-dom/client': 'react-dom/cjs/react-dom-client.production.js', scheduler: 'scheduler/cjs/scheduler.production.js' })) modules[name] = await fs.readFile(path.join(root, 'node_modules', file), 'utf8');
  // Compile real local helpers lazily instead of maintaining a fragile import
  // allowlist when the production catalog adds a bundled product asset.
  for (const file of (await fs.readdir(directory)).filter(file => /\.(jsx|js|mjs)$/.test(file))) {
    modules['./' + file.replace(/\.(jsx|js)$/, '')] = ts.transpileModule(await fs.readFile(path.join(directory, file), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  }
  const catalog = await import(require('node:url').pathToFileURL(path.join(directory, 'diagram-catalog.mjs')));
  const icons = await import('simple-icons');
  modules['simple-icons'] = 'module.exports=' + JSON.stringify(Object.fromEntries(Object.keys(icons).filter(key => Object.values(catalog.COMPONENT_BRAND_ICONS).some(icon => icon === icons[key])).map(key => [key, icons[key]])));
  modules['./DiagramNodes'] = `const React=require('react');exports.ComponentGlyph=({componentKey,size})=>React.createElement('svg',{'data-component-key':componentKey,className:'diagram-component-glyph',width:size,height:size,viewBox:'0 0 24 24','aria-hidden':true},React.createElement('circle',{cx:12,cy:12,r:9,fill:'none',stroke:'currentColor'}));`;
  const styles = await fs.readFile(path.join(directory, 'diagram-studio.css'), 'utf8');
  const theme = await fs.readFile(path.join(root, 'canvas-web/src/styles.css'), 'utf8');
  const isolated = session.fromPartition('argus-insert-library-test', { cache: false });
  isolated.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${theme}${styles}body{margin:0;font:12px system-ui}#fixture{position:absolute;inset:0}</style></head><body><div id="fixture" class="diagram-studio"></div></body></html>`;
  const fixture = path.join(temporary, 'library.html'); await fs.writeFile(fixture, html); await window.loadFile(fixture);
  const run = code => window.webContents.executeJavaScript(code);
  await run(`{
    const sources={${Object.entries(modules).map(([name, source]) => `${JSON.stringify(name)}:function(require,module,exports){${source}\n}`).join(',')}},cache={};
    window.fixtureRequire=function require(name){if(name.endsWith('.css'))return {};if(cache[name])return cache[name].exports;if(!sources[name])throw new Error('Unexpected fixture import '+name);const module={exports:{}};cache[name]=module;sources[name](require,module,module.exports);return module.exports;};
    const React=fixtureRequire('react'),{createRoot}=fixtureRequire('react-dom/client'),Picker=fixtureRequire('./DiagramInsertLibrary').default;
    window.inserted=[];window.fixtureRoot=createRoot(document.querySelector('#fixture'));
    fixtureRoot.render(React.createElement('div',{className:'diagram-workarea'},React.createElement('div',{className:'diagram-palette diagram-palette-library diagram-popover'},React.createElement('div',{className:'diagram-popover-heading'},React.createElement('strong',null,'Insert visual')),React.createElement(Picker,{onAdd:key=>inserted.push(key)}))));
  }`);
  const exists = selector => run(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const click = async selector => { await run(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing '+${JSON.stringify(selector)});node.click();})()`); await pause(); };
  const count = () => run(`document.querySelectorAll('.diagram-insert-grid>button').length`);
  const keys = () => run(`[...document.querySelectorAll('.diagram-insert-grid>button')].map(node=>node.querySelector('[data-component-key]').dataset.componentKey)`);
  const search = async value => { await run(`(()=>{const input=document.querySelector('[aria-label="Search architecture components"]');input.focus();input.select();})()`); await window.webContents.insertText(value); await pause(); };
  const chooseCategory = async value => { await run(`(()=>{const select=document.querySelector('[aria-label="Icon library"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(value)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`); await pause(); };
  await poll(() => exists('.diagram-insert-grid>button'), 'Picker mounted');
  assert.equal(await count(), 36);
  assert.equal(await run(`document.querySelector('[role="status"]').textContent.replace(/[^0-9]/g,'')`), '3951');
  assert.equal(await run(`document.querySelector('[aria-label="Previous icon page"]').disabled`), true);
  scenarios++;

  const first = await keys();
  await click('[aria-label="Next icon page"]');
  assert.equal(await count(), 36); assert.notDeepEqual(await keys(), first);
  await click('[aria-label="Previous icon page"]'); assert.deepEqual(await keys(), first);
  scenarios++;
  await chooseCategory('Google Cloud icons');
  assert.equal(await run(`document.querySelector('[role="status"]').textContent.replace(/[^0-9]/g,'')`), '250');
  assert.ok((await keys()).every(key => key.startsWith('eraser:gcp-')));
  await chooseCategory('all'); scenarios++;

  await search('aws ec2'); assert.ok((await keys()).includes('eraser:aws-ec2'));
  await search('azure web app'); assert.ok((await keys()).includes('eraser:azure-web-app-+-database'));
  await search('cylinder'); assert.ok((await keys()).includes('shape:cylinder'));
  await search('phone'); assert.ok((await keys()).includes('frame:phone'));
  scenarios++;
  await search('aws ec2');
  const keyboardKeys = await keys();
  await run(`document.querySelector('[aria-label="Search architecture components"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`); await pause();
  await run(`document.querySelector('[aria-label="Search architecture components"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`); await pause();
  assert.equal(await run('inserted.at(-1)'), keyboardKeys[1]); scenarios++;
  await click('.diagram-insert-grid>button'); assert.equal(await run('inserted.at(-1)'), keyboardKeys[0]); scenarios++;
  const dragged = await run(`(()=>{const data=new DataTransfer();document.querySelector('.diagram-insert-grid>button').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));return {key:data.getData('application/x-argus-diagram-item'),effect:data.effectAllowed};})()`);
  assert.equal(dragged.key, keyboardKeys[0]); scenarios++;
  await search('there-is-absolutely-no-such-icon-xyz'); assert.equal(await count(), 0);
  const addedBefore = await run('inserted.length');
  await run(`document.querySelector('[aria-label="Search architecture components"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  assert.equal(await run('inserted.length'), addedBefore); scenarios++;
  await click('.diagram-insert-sections button:nth-child(2)'); assert.equal(await count(), 12); assert.ok((await keys()).every(key => key.startsWith('shape:'))); scenarios++;
  await click('.diagram-insert-sections button:nth-child(3)'); assert.equal(await count(), 4); assert.ok((await keys()).every(key => key.startsWith('frame:'))); scenarios++;

  await click('.diagram-insert-sections button:nth-child(1)');
  window.setSize(480, 640); await pause(150);
  for (const selectedTheme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(selectedTheme)}`); await pause();
    const bounds = await run(`(()=>{const panel=document.querySelector('.diagram-palette'),r=panel.getBoundingClientRect(),grid=document.querySelector('.diagram-insert-grid');return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:panel.scrollWidth-panel.clientWidth,gridHeight:grid.getBoundingClientRect().height};})()`);
    assert.ok(bounds.left>=0&&bounds.right<=bounds.width&&bounds.top>=0&&bounds.bottom<=bounds.height,'Picker outside viewport '+JSON.stringify(bounds));
    assert.ok(bounds.overflow<=1,'Picker horizontally clipped'); assert.ok(bounds.gridHeight<=298,'Unbounded icon grid');
    await fs.writeFile(path.join(temporary, `library-${selectedTheme}-480.png`),(await window.webContents.capturePage()).toPNG());
    scenarios++;
  }
  // Focus belongs to the enclosing search row: an inner input outline used to
  // create a second rectangle, mask its padding and collide with the tabs.
  await search('redis');
  const redisKeys = await keys();
  assert.ok(redisKeys.includes('eraser:redis') && redisKeys.includes('redis'));
  assert.ok(redisKeys.indexOf('eraser:redis') < redisKeys.indexOf('redis'), 'Icons search must prioritize the Eraser artwork over legacy Essentials');
  scenarios++;
  const assertFilterGeometry = async context => {
    const metrics = await run(`(()=>{
      const row=document.querySelector('.diagram-insert-filter'),holder=row.querySelector('.diagram-insert-select'),select=holder.querySelector('select'),chevron=holder.querySelector('svg'),count=row.querySelector('[role="status"]');
      const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,center:r.top+r.height/2}};
      return {row:rect(row),holder:rect(holder),select:rect(select),chevron:rect(chevron),count:rect(count),selectHeight:select.offsetHeight,countHeight:count.offsetHeight,appearance:getComputedStyle(select).appearance,columnGap:parseFloat(getComputedStyle(row).columnGap),chevronInset:parseFloat(getComputedStyle(chevron).right),label:select.selectedOptions[0]?.textContent,countText:count.textContent};
    })()`);
    const detail=JSON.stringify({...context,metrics}),scale=context.zoom;
    assert.equal(metrics.selectHeight,32,'Dropdown height changed: '+detail);
    assert.equal(metrics.countHeight,32,'Count chip height changed: '+detail);
    assert.equal(metrics.appearance,'none','Native select arrow must not duplicate the custom chevron: '+detail);
    assert.ok(Math.abs(metrics.select.top-metrics.count.top)<=.5&&Math.abs(metrics.select.bottom-metrics.count.bottom)<=.5&&Math.abs(metrics.select.center-metrics.count.center)<=.5,'Dropdown and count are not aligned: '+detail);
    for(const child of [metrics.select,metrics.count]) assert.ok(child.left>=metrics.row.left-.5&&child.right<=metrics.row.right+.5&&child.top>=metrics.row.top-.5&&child.bottom<=metrics.row.bottom+.5,'Filter control escaped its row: '+detail);
    assert.ok(metrics.select.right<=metrics.holder.right+.5,'Native select padding overflowed the assigned grid column: '+detail);
    assert.ok(metrics.columnGap>=6&&metrics.count.left-metrics.select.right>=metrics.columnGap*scale-.5,'Dropdown and count overlap or lose their gap: '+detail);
    assert.ok(Math.abs(metrics.chevron.center-metrics.select.center)<=.5,'Dropdown chevron is not vertically centered: '+detail);
    assert.ok(metrics.chevronInset>=4&&Math.abs(metrics.select.right-metrics.chevron.right-metrics.chevronInset*scale)<=1,'Dropdown chevron inset is not preserved: '+detail);
    assert.ok(metrics.chevron.left>=metrics.select.left&&metrics.chevron.top>=metrics.select.top&&metrics.chevron.bottom<=metrics.select.bottom,'Dropdown chevron escaped its control: '+detail);
    assert.equal(metrics.countText.replace(/[^0-9]/g,''),String(context.count),'Unexpected filtered result count: '+detail);
    scenarios++;
  };
  for (const width of [1000, 480, 320]) {
    window.setSize(width, 760); await pause(80);
    for (const selectedTheme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(selectedTheme)}`);
      for (const zoom of [.8, 1, 1.25, 2]) {
        await run(`document.body.style.zoom=${JSON.stringify(String(zoom))};document.querySelector('[aria-label="Search architecture components"]').focus()`);
        await pause();
        const metrics = await run(`(()=>{
          const wrapper=document.querySelector('.diagram-insert-search'),input=wrapper.querySelector('input'),icon=wrapper.querySelector('svg'),clear=wrapper.querySelector('button'),tabs=document.querySelector('.diagram-insert-sections');
          const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,center:r.top+r.height/2}};
          const style=getComputedStyle(input),wrapperStyle=getComputedStyle(wrapper);
          const tabButtons=[...tabs.querySelectorAll('button')].map(button=>{const text=document.createRange();text.selectNodeContents(button);return {button:rect(button),text:rect(text)}});
          return {wrapper:rect(wrapper),input:rect(input),icon:rect(icon),clear:rect(clear),tabs:rect(tabs),tabButtons,layoutHeight:wrapper.offsetHeight,inputOutline:style.outlineWidth,inputBorder:style.borderTopWidth,inputShadow:style.boxShadow,wrapperBorder:wrapperStyle.borderTopWidth,wrapperShadow:wrapperStyle.boxShadow,focused:document.activeElement===input};
        })()`);
        const detail=JSON.stringify({width,selectedTheme,zoom,metrics});
        assert.equal(metrics.focused,true,'Search must retain focus: '+detail);
        assert.equal(metrics.inputOutline,'0px','Duplicate input focus outline: '+detail);
        assert.equal(metrics.inputBorder,'0px','Duplicate input border: '+detail);
        assert.equal(metrics.inputShadow,'none','Duplicate input focus shadow: '+detail);
        assert.equal(metrics.layoutHeight,40,'Search row height changed: '+detail);
        assert.notEqual(metrics.wrapperShadow,'none','Outer focus indicator is missing: '+detail);
        for(const child of [metrics.icon,metrics.input,metrics.clear]) {
          assert.ok(child.left>=metrics.wrapper.left&&child.right<=metrics.wrapper.right+.5&&child.top>=metrics.wrapper.top&&child.bottom<=metrics.wrapper.bottom+.5,'Search child escaped row: '+detail);
          assert.ok(Math.abs(child.center-metrics.wrapper.center)<=zoom+0.5,'Search child is not vertically centered: '+detail);
        }
        assert.ok(metrics.icon.right<metrics.input.left&&metrics.input.right<metrics.clear.left,'Search controls overlap: '+detail);
        assert.ok(metrics.tabs.top-metrics.wrapper.bottom>=8*zoom-.5,'Search focus ring collides with tabs: '+detail);
        for(const {button,text} of metrics.tabButtons) {
          assert.ok(button.left>=metrics.tabs.left-.5&&button.right<=metrics.tabs.right+.5&&button.top>=metrics.tabs.top-.5&&button.bottom<=metrics.tabs.bottom+.5,'Section button escaped its tab group: '+detail);
          assert.ok(text.left>=button.left-.5&&text.right<=button.right+.5&&text.top>=button.top-.5&&text.bottom<=button.bottom+.5,'Section label overlaps its neighboring tab: '+detail);
        }
        await assertFilterGeometry({width,selectedTheme,zoom,count:5,query:'redis'});
        if(zoom===1) await fs.writeFile(path.join(temporary,`library-search-${selectedTheme}-${width}.png`),(await window.webContents.capturePage()).toPNG());
        scenarios++;
      }
    }
  }
  await click('[aria-label="Clear library search"]');
  for(const [category,expectedCount] of [['all',3951],['Oracle Cloud icons',26]]) {
    await chooseCategory(category);
    for(const width of [1000,480,320]) {
      window.setSize(width,760); await pause(60);
      for(const selectedTheme of ['dark','light']) {
        await run(`document.documentElement.dataset.theme=${JSON.stringify(selectedTheme)}`);
        for(const zoom of [.8,1,1.25,2]) {
          await run(`document.body.style.zoom=${JSON.stringify(String(zoom))}`); await pause();
          await assertFilterGeometry({width,selectedTheme,zoom,count:expectedCount,category});
          if((zoom===1&&width<=480)||(zoom===2&&width===320)) await fs.writeFile(path.join(temporary,`library-filter-${category==='all'?'all':'long'}-${selectedTheme}-${width}${zoom===1?'':'-zoom-'+zoom}.png`),(await window.webContents.capturePage()).toPNG());
        }
      }
    }
  }
  assert.deepEqual(errors, []); assert.equal(networkRequests,0);
  console.log('DIAGRAM_INSERT_LIBRARY_RESULT='+JSON.stringify({ok:true,scenarios,networkRequests})); finish(0);
}).catch(async error => {
  console.error(error.stack||error); console.error(JSON.stringify(errors));
  if(window&&!window.isDestroyed()) await fs.writeFile(path.join(temporary,'library-failure.png'),(await window.webContents.capturePage()).toPNG()).catch(()=>{});
  finish(1);
});
