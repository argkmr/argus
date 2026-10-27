// Actual composer markup/styles and app model-control functions, with synthetic
// providers/tasks only. No AI, user profile or installed Argus is contacted.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-speed-ui-")) throw new Error("An isolated test directory is required");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, server, completed = false, backendRequests = 0;
const timer = setTimeout(() => finish(new Error("Speed-control fixture timed out")), 35_000);
async function finish(error, result) {
  if (completed) return; completed = true; clearTimeout(timer);
  if (error) console.error(error.stack || error);
  else console.log(`SPEED_RENDERER_RESULT=${JSON.stringify(result)}`);
  if (window && !window.isDestroyed()) window.destroy();
  server?.closeAllConnections(); server?.close(); app.exit(error ? 1 : 0);
}
const page = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Isolated composer speed controls</title><link rel="stylesheet" href="/legacy/styles.css"><link rel="stylesheet" href="/legacy/repository-ide-shell.css">
<style>body{display:block;overflow:auto;font:13px/1.4 system-ui,sans-serif;padding:20px}.fixture-title{margin:18px 0 8px;color:var(--muted)}.ai-main-content{padding:0;overflow:visible;height:auto;width:100%}#global-codex-panel{display:block;padding:0;position:static;width:100%}.chat-composer{margin-bottom:28px}</style><link rel="stylesheet" href="/legacy/compact-composer.css"></head><body><h3>Speed controls · Isolated UI verification</h3><p class="fixture-title">Repository chat</p><main class="ai-main-content" id="repository-fixture"></main><p class="fixture-title">Nexus chat</p><section id="global-codex-panel"></section></body></html>`;

async function initialize() {
  const html = new DOMParser().parseFromString(await (await fetch("/legacy/index.html")).text(), "text/html");
  document.querySelector("#repository-fixture").append(html.querySelector(".prompt-card.chat-composer"));
  document.querySelector("#global-codex-panel").append(html.querySelector(".global-prompt-card.chat-composer"));
  const module = await import("/legacy/model-selection.js");
  const source = await (await fetch("/legacy/app.js")).text();
  const names = ["modelControlElements", "modelOptionsMarkup", "effortOptionsMarkup", "renderModelControls", "modelSelectionError", "renderModelConfigurationSummary", "selectedModelSettings", "handleModelChange", "handleSpeedChange", "persistModelSelection"];
  const definitions = names.map(name => { const start = source.indexOf(`function ${name}(`); return source.slice(start, source.indexOf("\nfunction ", start + 1)); }).join("\n");
  const $ = selector => document.querySelector(selector);
  const state = { activeRepository: { id: "repo-a" }, providers: [{ id: "codex", name: "Codex", supportsFastMode: true, modelCatalogSource: "cli-adapter", modelCatalog: [
    { id: "gpt-6-astra", displayName: "GPT-6 Astra", defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "high", "ultra"], supportsFastMode: true },
    { id: "standard-only", displayName: "Standard-only model", supportedReasoningEfforts: ["high"], supportsFastMode: false },
  ] }] };
  const writes = [], activeTaskId = scope => `${scope}-task`, currentModelSelectionKey = scope => module.modelSelectionKey(scope, "repo-a", activeTaskId(scope));
  const store = module.createModelSelectionStore({ getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value) });
  const environment = { ...module, $, state, modelSelections: store, activeTaskId, currentModelSelectionKey, scopedModelSelection: () => ({}), providerCanRun: () => true,
    selectedProvider: scope => state.providers.find(provider => provider.id === $(`#${scope === "global" ? "global-agent" : "agent"}-provider`).value),
    runningAgentJob: () => null, setComposerActionState() {}, syncTaskModelSelection: (id, settings) => writes.push({ id, settings }),
    escapeHtml: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") };
  const controls = new Function(...Object.keys(environment), `${definitions}\nreturn {${names.join(",")}}`)(...Object.values(environment));
  for (const scope of ["repository", "global"]) {
    controls.modelControlElements(scope).provider.innerHTML = '<option value="codex">Codex</option>';
    controls.renderModelControls(scope, { provider: "codex", model: "gpt-6-astra", effort: "ultra", speed: "standard" });
    controls.modelControlElements(scope).speed.addEventListener("change", () => controls.handleSpeedChange(scope));
    controls.modelControlElements(scope).model.addEventListener("change", () => controls.handleModelChange(scope));
  }
  const { initializeCompactComposers } = await import("/legacy/compact-composer.mjs");
  const compact = initializeCompactComposers({ document });
  window.fixture = { ...controls, state, store, writes, currentModelSelectionKey, compact };
  return true;
}

app.whenReady().then(async () => {
  const { createPreviewServer } = await import(pathToFileURL(path.join(__dirname, "ide-ux-preview.mjs")).href);
  server = createPreviewServer(); const assets = server.listeners("request")[0]; server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url.startsWith("/api/")) backendRequests++;
    if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'" }); response.end(page); }
    else void assets(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, isolated = session.fromPartition("isolated-speed-control", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }));
  window = new BrowserWindow({ show: false, width: 1320, height: 760, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(origin); await window.webContents.executeJavaScript(`(${initialize.toString()})()`);
  const run = source => window.webContents.executeJavaScript(`(async () => {${source}})()`);
  const settings = await run(`
    const select = fixture.modelControlElements('repository').speed; select.value = 'fast'; select.dispatchEvent(new Event('change', { bubbles: true }));
    return { repo: fixture.selectedModelSettings('repository'), nexus: fixture.selectedModelSettings('global'), saved: fixture.store.get(fixture.currentModelSelectionKey('repository')), writes: fixture.writes };
  `);
  assert.deepEqual(settings.repo, { model: "gpt-6-astra", effort: "ultra", speed: "fast" });
  assert.equal(settings.nexus.speed, "standard"); assert.equal(settings.saved.speed, "fast"); assert.equal(settings.writes.length, 1);
  const structure = await run(`
    return ['repository', 'global'].map(scope => {
      const prefix = scope === 'global' ? 'global-agent' : 'agent';
      const panel = document.querySelector('#' + scope + '-composer-model');
      return { scope, native: panel.getAttribute('popover'), closed: !panel.matches(':popover-open'),
        controls: ['provider', 'model', 'speed', 'effort', 'mode'].map(suffix => {
          const nodes = document.querySelectorAll('#' + prefix + '-' + suffix);
          return { suffix, count: nodes.length, contained: panel.contains(nodes[0]) };
        }) };
    });
  `);
  for (const item of structure) {
    assert.equal(item.native, "auto"); assert.equal(item.closed, true);
    for (const control of item.controls) { assert.equal(control.count, 1); assert.equal(control.contained, true); }
  }
  for (const [width, theme] of [[1320, "dark"], [560, "dark"], [390, "light"], [310, "light"]]) {
    window.setContentSize(width, 920);
    for (const scope of ["repository", "global"]) {
      const item = await run(`
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        const scope = ${JSON.stringify(scope)}, prefix = scope === 'global' ? 'global-agent' : 'agent';
        const select = document.querySelector('#' + prefix + '-speed'), label = select.closest('label');
        const menu = select.closest('details'), summary = menu.querySelector(':scope > summary'), panel = label.closest('[popover]');
        summary.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = label.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
        const siblings = [...label.parentElement.children].filter(node => node.checkVisibility()).map(node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; });
        return { display: getComputedStyle(label).display, width: box.width, left:box.left, right:box.right, top:box.top, bottom:box.bottom,
          panel: {left:bounds.left, right:bounds.right, top:bounds.top, bottom:bounds.bottom}, viewport: {width:document.documentElement.clientWidth, height:document.documentElement.clientHeight},
          siblings, insideDetails: Boolean(menu), open: panel.matches(':popover-open'), expanded: summary.getAttribute('aria-expanded'), selected: select.value, selectWidth:select.getBoundingClientRect().width };
      `);
      assert.equal(item.insideDetails, true); assert.equal(item.open, true); assert.equal(item.expanded, "true");
      assert.notEqual(item.display, "none"); assert(item.width >= 100, `${width}px ${scope}: ${JSON.stringify(item)}`);
      assert(item.left >= item.panel.left && item.right <= item.panel.right, JSON.stringify(item));
      assert(item.top >= item.panel.top && item.bottom <= item.panel.bottom, JSON.stringify(item));
      assert(item.panel.left >= 0 && item.panel.right <= item.viewport.width + 1, JSON.stringify(item));
      assert(item.panel.top >= 0 && item.panel.bottom <= item.viewport.height + 1, JSON.stringify(item));
      for (let i = 0; i < item.siblings.length; i++) for (let j = i + 1; j < item.siblings.length; j++) {
        const a = item.siblings[i], b = item.siblings[j];
        assert(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, `overlap at ${width}px`);
      }
      const closed = await run(`
        const panel = document.querySelector('#' + ${JSON.stringify(scope)} + '-composer-model');
        const summary = panel.closest('details').querySelector(':scope > summary');
        panel.querySelector('[data-composer-menu-close]').click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { open:panel.matches(':popover-open'), expanded:summary.getAttribute('aria-expanded'), focus:document.activeElement === summary };
      `);
      assert.deepEqual(closed, { open: false, expanded: "false", focus: true });
    }
    if (process.env.ARGUS_SPEED_CAPTURE === "1") await fs.writeFile(path.join(temporary, `speed-${width}-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  const unavailable = await run(`
    const select = fixture.modelControlElements('global').model; select.value = 'standard-only'; select.dispatchEvent(new Event('change', { bubbles: true }));
    const speed = fixture.modelControlElements('global').speed;
    return {disabled:speed.disabled, title:speed.closest('label').title, value:speed.value, options:[...speed.options].map(option => option.value), repo:fixture.selectedModelSettings('repository')};
  `);
  assert.equal(unavailable.disabled, true); assert.equal(unavailable.value, "standard"); assert.deepEqual(unavailable.options, ["standard"]); assert.match(unavailable.title, /Standard only/); assert.equal(unavailable.repo.speed, "fast");
  window.setContentSize(900, 700);
  const compact = await run(`
    document.body.classList.add('repository-ide-enabled'); document.documentElement.dataset.theme = 'dark';
    document.querySelector('#global-codex-panel').style.display = 'none';
    const main = document.querySelector('#repository-fixture'); main.style.height = '250px'; main.style.padding = '8px 12px'; main.style.overflow = 'hidden auto';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const select = fixture.modelControlElements('repository').speed, label = select.closest('label'), panel = label.closest('[popover]');
    panel.closest('details').querySelector(':scope > summary').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = select.getBoundingClientRect(), bounds = panel.getBoundingClientRect(), frame = main.getBoundingClientRect();
    select.focus();
    return {height:box.height, visible:box.width > 0 && box.height > 0, focused:document.activeElement === select,
      open:panel.matches(':popover-open'), escaped:bounds.bottom > frame.bottom || bounds.top < frame.top,
      panelRight:bounds.right, right:box.right, viewportWidth:document.documentElement.clientWidth, viewportHeight:document.documentElement.clientHeight, top:bounds.top, bottom:bounds.bottom};
  `);
  assert.equal(compact.height, 34); assert.equal(compact.visible, true); assert.equal(compact.focused, true); assert.equal(compact.open, true);
  assert.equal(compact.escaped, true, "native model popover escapes the short scrollable IDE chat");
  assert(compact.right <= compact.panelRight && compact.panelRight <= compact.viewportWidth);
  assert(compact.top >= 0 && compact.bottom <= compact.viewportHeight);
  const escaped = await run(`
    const select = fixture.modelControlElements('repository').speed, panel = select.closest('[popover]'), summary = panel.closest('details').querySelector(':scope > summary');
    select.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {open:panel.matches(':popover-open'), expanded:summary.getAttribute('aria-expanded'), focused:document.activeElement === summary, settings:fixture.selectedModelSettings('repository')};
  `);
  assert.equal(escaped.open, false); assert.equal(escaped.expanded, "false"); assert.equal(escaped.focused, true);
  assert.deepEqual(escaped.settings, { model: "gpt-6-astra", effort: "ultra", speed: "fast" });
  if (process.env.ARGUS_SPEED_CAPTURE === '1') await fs.writeFile(path.join(temporary, 'speed-ide-bottom.png'), (await window.webContents.capturePage()).toPNG());
  const dynamicModels = await run(`
    const before = fixture.selectedModelSettings('repository');
    fixture.state.providers[0].modelCatalog.unshift({ id:'future-family', displayName:'Future family', isDefault:true,
      supportedReasoningEfforts:[{effort:'future-effort'}] });
    fixture.state.providers[0].modelCatalogSource = 'codex-app-server';
    fixture.renderModelControls('repository', { provider:'codex', ...before });
    const options = [...fixture.modelControlElements('repository').model.options].map(option => option.value);
    const after = fixture.selectedModelSettings('repository');
    fixture.state.providers.push({ id:'claude', name:'Claude', modelCatalogSource:'claude-initialize', modelCatalog:[
      { id:'future-alias', displayName:'Future alias', resolvedModel:'claude-future-generation', supportedReasoningEfforts:[{effort:'auto'}] }
    ] });
    fixture.renderModelControls('global', { provider:'claude', model:'future-alias', effort:'auto', speed:'standard' });
    return { before, after, options, identity:document.querySelector('#global-agent-model-identity').textContent,
      title:fixture.modelControlElements('global').model.title,
      status:document.querySelector('#agent-catalog-source').textContent,
      refreshButtons:document.querySelectorAll('[data-refresh-model-catalog]').length };
  `);
  assert.deepEqual(dynamicModels.after, dynamicModels.before, 'new default never changes an existing chat choice');
  assert(dynamicModels.options.includes('future-family'), 'unknown future IDs appear in the real native select');
  assert.equal(dynamicModels.identity, 'future-alias → claude-future-generation');
  assert.match(dynamicModels.title, /currently resolves to claude-future-generation/);
  assert.match(dynamicModels.status, /Auto-sync on · 3 models/);
  assert.equal(dynamicModels.refreshButtons, 2);
  assert.equal(backendRequests, 0); await finish(null, { ok: true, backendRequests, dynamicModels: true });
}).catch(finish);
