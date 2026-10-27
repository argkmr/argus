// Real React input/effect/drag behavior in an isolated renderer. No live profile.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..'), temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith('argus-structure-picker-')) throw new Error('Isolated fixture directory required');
for (const name of ['userData', 'sessionData', 'logs']) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch('disable-background-networking');
let window, networkRequests = 0;
const timer = setTimeout(() => { console.error('Picker fixture timed out'); app.exit(1); }, 30_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
app.whenReady().then(async () => {
  const sources = {};
  for (const file of ['diagram-structure-layout.mjs', 'diagram-structures.mjs', 'diagram-structure-types.mjs', 'diagram-custom-structure-parser.mjs', 'diagram-structure-parser.mjs', 'DiagramStructurePicker.jsx']) {
    sources[`./${file}`] = ts.transpileModule(await fs.readFile(path.join(root, 'frontend/features/diagrams', file), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  }
  const isolated = session.fromPartition('structure-picker-regression', { cache: false });
  isolated.setPermissionRequestHandler((_c,_p,callback)=>callback(false));
  isolated.webRequest.onBeforeRequest({ urls:['http://*/*','https://*/*'] }, (_d,callback)=>{networkRequests++;callback({cancel:true});});
  window = new BrowserWindow({ show: false, width: 650, height: 850, webPreferences: { session: isolated, nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>'));
  const result = await window.webContents.executeJavaScript(`(async()=>{
    global.window=window;global.document=document;global.navigator=navigator;
    // data: fixtures lack secure-context crypto; the real localhost app has it.
    Object.defineProperty(globalThis.crypto,'randomUUID',{value:require('node:crypto').randomUUID,configurable:true});
    const assert=require(${JSON.stringify(require.resolve('node:assert/strict'))});
    const React=require(${JSON.stringify(require.resolve('react'))}), {createRoot}=require(${JSON.stringify(require.resolve('react-dom/client'))}), {flushSync}=require(${JSON.stringify(require.resolve('react-dom'))});
    const compiled=${JSON.stringify(sources)}, cache={};
    function localRequire(name){
      if(name==='react')return React;
      if(name==='react/jsx-runtime')return require(${JSON.stringify(require.resolve('react/jsx-runtime'))});
      if(cache[name])return cache[name].exports;
      if(!compiled[name])throw new Error('Unexpected fixture dependency '+name);
      const module={exports:{}};cache[name]=module;new Function('require','module','exports',compiled[name])(localRequire,module,module.exports);return module.exports;
    }
    const Picker=localRequire('./DiagramStructurePicker.jsx').default;
    const root=createRoot(document.querySelector('#root')), added=[];
    function Harness(){const [open,setOpen]=React.useState(true);return open?React.createElement(Picker,{onAdd:items=>{added.push(items);setOpen(false);}}):React.createElement('p',{'data-added':'yes'},'Added');}
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async(predicate,label)=>{for(let attempt=0;attempt<160;attempt++){if(predicate())return;await wait(25);}throw new Error('Timed out waiting for '+label);};
    const clickText=text=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent.includes(text));assert.ok(button,'Missing '+text);button.click();};
    const input=(selector,value)=>{const target=document.querySelector(selector);assert.ok(target,selector);Object.getOwnPropertyDescriptor(target.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:target.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(target,value);target.dispatchEvent(new Event(target.tagName==='SELECT'?'change':'input',{bubbles:true}));};
    flushSync(()=>root.render(React.createElement(Harness)));await wait(20);
    const array=[...document.querySelectorAll('.diagram-structure-catalog button')].find(node=>node.textContent==='Array');assert.ok(array);let transfer=new DataTransfer();array.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));assert.equal(JSON.parse(transfer.getData('application/x-argus-data-structure')).entries.length,0);
    clickText('Code');await until(()=>document.querySelector('textarea'),'code input');
    input('textarea','const old = [1];');await until(()=>document.querySelector('.diagram-structure-results strong')?.textContent==='old','old preview');assert.equal(document.querySelector('.diagram-structure-results strong').textContent,'old');
    input('textarea','const latest = [2,3];');await until(()=>document.querySelectorAll('.diagram-structure-results button').length===0,'stale preview removal');assert.equal(document.querySelectorAll('.diagram-structure-results button').length,0);
    input('textarea','const invalid = [fetch("x")];');await until(()=>document.querySelector('.diagram-structure-parser-error'),'parser error');assert.ok(document.querySelector('.diagram-structure-parser-error'));assert.equal(document.querySelectorAll('.diagram-structure-results button').length,0);
    input('textarea','Map<String, Map<String, ArrayList<String>>>');await until(()=>document.querySelector('.diagram-structure-results small')?.textContent.includes('Map<String, Map<String, ArrayList<String>>>'),'nested type preview');assert.ok(document.querySelector('.diagram-structure-results small').textContent.includes('Map<String, Map<String, ArrayList<String>>>'));
    transfer=new DataTransfer();document.querySelector('.diagram-structure-results button').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));const nested=JSON.parse(transfer.getData('application/x-argus-data-structure'));assert.equal(nested.structureKind,'map');assert.equal(nested.entries.length,0);assert.equal(nested.typeSignature,'Map<String, Map<String, ArrayList<String>>>');
    input('textarea','const groups = new Map([["region", new Map([["team", ["alice", "bob"]]])]]);');await until(()=>document.querySelector('.diagram-structure-results small')?.textContent.includes('4 units including nested'),'nested units preview');assert.ok(document.querySelector('.diagram-structure-results small').textContent.includes('4 units including nested'));
    transfer=new DataTransfer();document.querySelector('.diagram-structure-results button').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));const tree=JSON.parse(transfer.getData('application/x-argus-data-structure'));assert.equal(tree.entries[0].valueContainer.entries[0].valueContainer.entries[1].value,'bob');
    input('textarea','const latest = [2,3];');await until(()=>document.querySelector('.diagram-structure-results strong')?.textContent==='latest','latest preview');assert.equal(document.querySelector('.diagram-structure-results strong').textContent,'latest');
    const result=document.querySelector('.diagram-structure-results button');transfer=new DataTransfer();result.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));const payload=JSON.parse(transfer.getData('application/x-argus-data-structure'));assert.equal(payload.name,'latest');assert.deepEqual(payload.entries.map(row=>row.value),['2','3']);
    result.click();await until(()=>document.querySelector('[data-added="yes"]'),'picker close');assert.equal(added.length,1);assert.equal(added[0][0].name,'latest');assert.equal(document.querySelectorAll('.diagram-structure-picker').length,0);
    root.unmount();return {ok:true,assertions:14};
  })()`);
  assert.equal(networkRequests, 0);
  console.log('DIAGRAM_PICKER_RESULT='+JSON.stringify({...result,networkRequests}));finish(0);
}).catch(error=>{console.error(error.stack||error);finish(1);});
