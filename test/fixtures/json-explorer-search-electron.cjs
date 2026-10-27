// Exercise the real JSON Explorer module, markup, and styles in an isolated
// renderer. Never load Argus startup, repository data, or its persistent profile.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const temporary = process.argv[2];
assert.ok(path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-json-search-layout-"));
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
let window, networkRequests = 0;
const timer = setTimeout(() => app.exit(1), 55_000);

app.whenReady().then(async () => {
  const publicRoot = path.resolve(__dirname, "../../public");
  const shell = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const panel = shell.slice(shell.indexOf('<section id="json-explorer-panel"'), shell.indexOf('<section id="global-codex-panel"')).trim();
  assert.ok(panel.includes('id="json-code-view"'), "The complete production JSON Explorer must exist");
  const sheets = [...shell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const css = (await Promise.all(sheets.map(name => fs.readFile(path.join(publicRoot, name), "utf8")))).join("\n");
  const bundled = new Map();
  async function moduleUrl(file) {
    if (bundled.has(file)) return bundled.get(file);
    let source = await fs.readFile(file, "utf8");
    for (const match of [...source.matchAll(/\bfrom\s+(["'])(\.\.?\/[^"']+)\1/g)]) {
      const dependency = path.resolve(path.dirname(file), match[2].split("?")[0]);
      assert.ok(dependency.startsWith(publicRoot + path.sep), "Only local production modules can be imported");
      source = source.replace(match[0], `from ${JSON.stringify(await moduleUrl(dependency))}`);
    }
    const url = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
    bundled.set(file, url); return url;
  }
  const script = await moduleUrl(path.join(publicRoot, "json-explorer.js"));
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data:"><style>${css}</style></head><body>${panel}</body></html>`;
  const isolated = session.fromPartition("json-explorer-search-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { networkRequests++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 800, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const run = code => window.webContents.executeJavaScript(code);
  await run(`import(${JSON.stringify(script)}).then(module => {
    const root = document.querySelector('#json-explorer-panel'); root.classList.remove('hidden');
    window.explorer = new module.JsonExplorer(root);
    window.fixture = {
      async settle() { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); },
      async load(text, query, scope = 'all') {
        explorer.source.value = text; explorer.parse(); explorer.setView('code'); explorer.openSearch();
        document.querySelector('#json-search-input').value = query;
        document.querySelector('#json-search-scope').value = scope;
        await explorer.search(); await this.settle(); return this.snapshot();
      },
      async search(query, scope = 'all') {
        const input = document.querySelector('#json-search-input'); input.value = query; input.focus();
        document.querySelector('#json-search-scope').value = scope;
        await explorer.search(); await this.settle(); return this.snapshot();
      },
      snapshot() {
        const code = explorer.code, rect = element => { const r = element.getBoundingClientRect(); return { left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height }; };
        const marks = [...code.querySelectorAll('mark.json-search-highlight')];
        return { source:explorer.source.value, text:code.textContent, count:document.querySelector('#json-search-count').textContent,
          focus:document.activeElement.id, index:explorer.matchIndex, paths:explorer.matches.map(match=>match.path),
          marks:marks.map(mark=>({ text:mark.textContent,index:Number(mark.dataset.jsonMatchIndex),active:mark.classList.contains('current-match'),background:getComputedStyle(mark).backgroundColor,color:getComputedStyle(mark).color,font:getComputedStyle(mark).font,rect:rect(mark) })),
          currentTreeRows:explorer.tree.querySelectorAll('.current-match').length, treeHidden:explorer.tree.classList.contains('hidden'),codeHidden:code.classList.contains('hidden'),
          code:rect(code),codeFont:getComputedStyle(code).font,scrollTop:code.scrollTop,scrollLeft:code.scrollLeft,scrollWidth:code.scrollWidth,clientWidth:code.clientWidth,
          inputEditable:!explorer.source.readOnly,unsafe:code.querySelectorAll('img,script,svg,iframe').length,injected:Boolean(window.__jsonSearchInjected),
          activePath:document.querySelector('#json-active-path').textContent,panel:rect(explorer.root),viewport:innerWidth };
      }
    };
  })`);

  let scenarios = 0, behaviorChecks = 0;
  const demo = {};
  for (let index = 0; index < 65; index++) demo[`orderMetadata${index}`] = index;
  Object.assign(demo, { fulfillmentOrderId: "179015315774248FQ09", loyaltyNtDiscount: null, paymentFailedAlert: false });
  const sample = JSON.stringify(demo, null, 2);
  const assertPreserved = (state, expected, context) => {
    assert.equal(state.source, expected, context); assert.equal(state.text, expected, context);
    assert.equal(state.inputEditable, true, context); assert.equal(state.unsafe, 0, context); assert.equal(state.injected, false, context);
  };
  const assertActive = (state, index, context) => {
    assert.equal(state.index, index, context);
    const active = state.marks.filter(mark => mark.active);
    assert.ok(active.length, `The active formatted result must be visibly marked: ${context}`);
    assert.ok(active.every(mark => mark.index === index), context);
    assert.ok(active.every(mark => mark.background !== "rgba(0, 0, 0, 0)" && mark.background !== "transparent"), context);
    assert.ok(state.marks.every(mark => mark.font === state.codeFont), `Highlighting must not change the JSON's font or character metrics: ${context}`);
    const inactive = state.marks.find(mark => !mark.active);
    if (inactive) assert.notEqual(active[0].background, inactive.background, `The active result must be distinct from other matches: ${context}`);
    assert.equal(state.focus, "json-search-input", context);
  };
  const assertVisible = (state, context) => {
    const active = state.marks.find(mark => mark.active);
    assert.ok(active && active.rect.bottom > state.code.top && active.rect.top < state.code.bottom, `Active result must be vertically visible: ${context}`);
    assert.ok(active.rect.right > state.code.left && active.rect.left < state.code.right, `Active result must be horizontally visible: ${context}`);
  };

  for (const width of [650, 1440]) for (const font of ["system", "comic-sans"]) for (const theme of ["dark", "light"]) {
    window.setContentSize(width, 800);
    await run(`document.documentElement.dataset.fontFamily=${JSON.stringify(font)};document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    const context = JSON.stringify({ width, font, theme });
    const state = await run(`fixture.load(${JSON.stringify(sample)}, 'fulfillmentOrderId')`);
    assertPreserved(state, sample, context); assertActive(state, 0, context); assertVisible(state, context);
    assert.equal(state.count, "1 of 1", context);
    assert.ok(state.marks.some(mark => mark.active && mark.text.includes("fulfillmentOrderId")), context);
    assert.ok(state.scrollTop > 0, `A distant matching key must scroll into view: ${context}`);
    assert.ok(state.panel.left >= 0 && state.panel.right <= state.viewport + 1, context);
    if (width === 1440 && font === "comic-sans") await fs.writeFile(path.join(temporary, `json-search-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    behaviorChecks++;

    const repeated = JSON.stringify({ orders: [{ fulfillmentOrderId: "first" }, { fulfillmentOrderId: "second" }, { fulfillmentOrderId: "third" }], unrelated: "nothing" }, null, 2);
    let current = await run(`fixture.load(${JSON.stringify(repeated)}, 'fulfillmentOrderId', 'keys')`);
    assert.equal(current.count, "1 of 3", context); assertActive(current, 0, context);
    assert.deepEqual([...new Set(current.marks.map(mark => mark.index))], [0, 1, 2], context);
    for (const [action, index] of [["#json-search-next", 1], ["#json-search-next", 2], ["#json-search-next", 0], ["#json-search-previous", 2]]) {
      current = await run(`(async()=>{document.querySelector(${JSON.stringify(action)}).click();await fixture.settle();return fixture.snapshot()})()`);
      assertActive(current, index, context); assertPreserved(current, repeated, context);
    }
    current = await run(`(async()=>{document.querySelector('#json-search-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await fixture.settle();return fixture.snapshot()})()`);
    assertActive(current, 0, context);
    behaviorChecks++;

    const scopeSource = JSON.stringify({ needleKey: "nothing", other: "a needle value", repeated: "needle needle" }, null, 2);
    current = await run(`fixture.load(${JSON.stringify(scopeSource)}, 'needle', 'keys')`);
    assert.equal(current.count, "1 of 1", context); assertActive(current, 0, context); assert.ok(current.marks.every(mark => mark.index === 0), context);
    current = await run(`fixture.search('needle','values')`);
    assert.equal(current.count, "1 of 2", context); assertActive(current, 0, context); assertPreserved(current, scopeSource, context);
    assert.ok(current.marks.every(mark => !mark.text.includes("needleKey")), context);
    behaviorChecks++;

    current = await run(`fixture.load(${JSON.stringify(repeated)}, '$.orders[1]', 'paths')`);
    assert.equal(current.count, "1 of 2", context); assertActive(current, 0, context); assertPreserved(current, repeated, context);
    current = await run(`(async()=>{explorer.moveMatch(1);await fixture.settle();return fixture.snapshot()})()`);
    assertActive(current, 1, context); assert.equal(current.activePath, "$.orders[1].fulfillmentOrderId", context);
    behaviorChecks++;

    current = await run(`(async()=>{document.querySelector('[data-json-view="tree"]').click();await fixture.settle();return fixture.snapshot()})()`);
    assert.equal(current.treeHidden, false, context); assert.equal(current.codeHidden, true, context); assert.equal(current.currentTreeRows, 1, context);
    current = await run(`(async()=>{document.querySelector('[data-json-view="code"]').click();await fixture.settle();return fixture.snapshot()})()`);
    assert.equal(current.treeHidden, true, context); assertActive(current, 1, context); assertVisible(current, context);
    behaviorChecks++;

    current = await run(`fixture.search('definitely-no-results')`);
    assert.equal(current.count, "0 results", context); assert.equal(current.marks.length, 0, context); assertPreserved(current, repeated, context);
    await run(`fixture.search('fulfillmentOrderId')`);
    current = await run(`(async()=>{document.querySelector('#json-close-search').click();await fixture.settle();return fixture.snapshot()})()`);
    assert.equal(current.count, "0 results", context); assert.equal(current.marks.length, 0, context); assertPreserved(current, repeated, context);
    behaviorChecks++;

    const horizontal = JSON.stringify({ prefix: "x".repeat(3000), fulfillmentOrderId: "found after a very long prefix" });
    current = await run(`fixture.load(${JSON.stringify(horizontal)}, 'fulfillmentOrderId', 'keys')`);
    assertActive(current, 0, context); assertVisible(current, context); assertPreserved(current, horizontal, context);
    assert.ok(current.scrollLeft > 0, `A distant minified match must scroll horizontally into view: ${context}`);
    behaviorChecks++;

    const escaped = '{"fulfillment\\u004frderId":"<img src=x onerror=\\"window.__jsonSearchInjected=true\\">","emoji":"\\ud83d\\ude80","raw":"&#39; &quot; &lt;","number":1e+03}';
    current = await run(`fixture.load(${JSON.stringify(escaped)}, 'fulfillmentOrderId', 'keys')`);
    assertActive(current, 0, context); assertPreserved(current, escaped, context);
    current = await run(`fixture.search('<img', 'values')`);
    assertActive(current, 0, context); assertPreserved(current, escaped, context);
    // JSON Explorer intentionally trims outer whitespace before parsing, but
    // source offsets and rendered characters must retain the original BOM/NBSP.
    const padded = '\ufeff {"fulfillmentOrderId":1} \u00a0';
    current = await run(`fixture.load(${JSON.stringify(padded)}, 'fulfillmentOrderId', 'keys')`);
    assert.equal(current.count, "1 of 1", context); assertActive(current, 0, context); assertPreserved(current, padded, context);
    assert.ok(current.marks.some(mark => mark.active && mark.text === "fulfillmentOrderId"), context);
    behaviorChecks++;

    const invalid = '{"fulfillmentOrderId":';
    current = await run(`(async()=>{explorer.source.value=${JSON.stringify(invalid)};explorer.source.dispatchEvent(new Event('input',{bubbles:true}));explorer.parse();await fixture.settle();return fixture.snapshot()})()`);
    assert.equal(current.marks.length, 0, context); assert.equal(current.count, "0 results", context); assertPreserved(current, invalid, context);
    const replacement = '{"replacement":"no old results remain"}';
    current = await run(`fixture.load(${JSON.stringify(replacement)}, 'fulfillmentOrderId')`);
    assert.equal(current.marks.length, 0, context); assert.equal(current.count, "0 results", context); assertPreserved(current, replacement, context);
    behaviorChecks++;

    const racing = JSON.stringify(Array.from({ length: 4000 }, (_, id) => ({ fulfillmentOrderId: id })));
    current = await run(`(async()=>{explorer.source.value=${JSON.stringify(racing)};explorer.parse();document.querySelector('#json-search-input').value='fulfillmentOrderId';const pending=explorer.search();explorer.source.value=${JSON.stringify(replacement)};explorer.source.dispatchEvent(new Event('input',{bubbles:true}));explorer.parse();await pending;await fixture.settle();return fixture.snapshot()})()`);
    assert.equal(current.marks.length, 0, context); assert.equal(current.count, "0 results", context); assertPreserved(current, replacement, context);
    behaviorChecks++; scenarios++;
  }
  await fs.writeFile(path.join(temporary, "result.json"), JSON.stringify({ scenarios, behaviorChecks, networkRequests }));
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timer); window?.destroy(); app.exit(1); });
