// Production markup, styles and presentation controller in a synthetic renderer.
// No bootstrap, backend, user data, clipboard, service or AI request is loaded.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-compact-composer-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const timer = setTimeout(() => { console.error("Compact composer layout timed out"); app.exit(1); }, 50_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };

app.whenReady().then(async () => {
  const html = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const stylesheets = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\/([^"?]+)[^"]*"[^>]*>/g)].map(match => match[1]);
  assert.ok(stylesheets.includes("compact-composer.css"));
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style>`);
  const controller = (await fs.readFile(path.join(root, "public/compact-composer.mjs"), "utf8")).replace(/^export /gm, "");
  const splitController = (await Promise.all(["ide-splitter.mjs", "repository-ide-resize.mjs"].map(file => fs.readFile(path.join(root, "public", file), "utf8"))))
    .map(source => source.replace(/^import .*;\n/gm, "").replace(/^export /gm, "")).join("\n");
  const source = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  const start = source.indexOf("function resizeAgentComposer(");
  assert.ok(start >= 0);
  const resizeComposer = source.slice(start, source.indexOf("\n}", start) + 2);
  const { nexusThemeVariables } = await import(pathToFileURL(path.join(root, "public/nexus-themes.mjs")).href);
  const isolated = session.fromPartition("compact-composer-regression", { cache:false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel:!details.url.startsWith("data:") }));
  window = new BrowserWindow({ show:false, width:1440, height:900, webPreferences:{ session:isolated, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  const run = script => window.webContents.executeJavaScript(script).catch(error => { throw new Error(`${error.message}\nRenderer script: ${script.slice(0, 500)}`); });
  assert.deepEqual(await run(`[...document.querySelectorAll('#agent-context-mode, #global-agent-context-mode')].map(control => ({value:control.value, selected:control.selectedOptions[0].textContent}))`), [
    { value: 'history', selected: 'Include previous chat context' },
    { value: 'history', selected: 'Include previous chat context' },
  ]);
  await run(`
    const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
    ${controller}
    ${splitController}
    ${resizeComposer}
    for (const composer of $$(".compact-composer")) {
      const global = composer.dataset.composerScope === "global", prefix = global ? "global-agent" : "agent";
      composer.querySelector('#' + prefix + '-provider').innerHTML = '<option value="codex">Codex</option><option value="claude">Claude</option>';
      composer.querySelector('#' + prefix + '-model').innerHTML = '<option value="astra">GPT-6-Astra</option><option value="sol">GPT-5.6-Sol</option>';
      composer.querySelector('#' + prefix + '-speed').innerHTML = '<option value="standard">Standard</option><option value="fast">Fast</option>';
      composer.querySelector('#' + prefix + '-effort').innerHTML = '<option value="low">Low</option><option value="high">High</option>';
      composer.querySelector('#' + prefix + '-config-summary').textContent = 'Low · Edit';
      composer.querySelector('.task-notes-bar').innerHTML = '<button class="task-notes-open"><span>NOTE</span> Add notes</button><small>This task</small>';
      composer.querySelector('textarea').value = 'Unsent draft — preserve this exact text.';
    }
    $('#nexus-repository-picker-root').innerHTML = '<section aria-label="Nexus repository scope"><details><summary>Repositories · Auto-select</summary><div><header><small>Select repositories for this request.</small></header><div><label><input type="checkbox"> <strong>reviewrating</strong></label><label><input type="checkbox"> <strong>ticket-management</strong></label></div></div></details></section>';
    for (const id of ['agent-conversation', 'global-agent-conversation']) {
      $('#' + id).classList.remove('is-empty');
      $('#' + id).innerHTML = Array.from({ length:8 }, (_, index) => '<article class="chat-message ' + (index % 2 ? 'assistant' : 'user') + '"><div class="chat-message-body"><div class="chat-message-meta">' + (index % 2 ? 'Argus' : 'You') + '</div><div class="chat-message-content"><p>A compact composer leaves room to read the conversation. This synthetic message does not use a provider or change any saved chat.</p></div></div></article>').join('');
    }
    const fixtureSplit = createRepositoryWorkbenchResize({ document, storage:null });
    $('#repository-ide-host').innerHTML = '<div style="padding:20px;color:var(--muted)">Synthetic code editor — no Monaco or repository opened.</div>';
    const outside = document.createElement('button'); outside.id = 'fixture-outside'; outside.textContent = 'Outside'; outside.style.cssText = 'position:fixed;right:4px;top:4px;z-index:200;width:58px;height:26px;font-size:10px'; document.body.append(outside);
    window.compactComposers = initializeCompactComposers({ document });
    window.configureComposerView = kind => {
      const global = kind === 'nexus', ide = kind === 'ide';
      document.body.dataset.view = global ? 'global' : 'repository';
      document.body.classList.toggle('repository-ide-enabled', ide);
      document.body.classList.add('task-context-visible');
      $('#global-codex-panel').classList.toggle('hidden', !global);
      $('#workspace').classList.toggle('hidden', global);
      $('.global-codex-layout').classList.add('task-panel-collapsed');
      $('.ai-canvas').classList.add('task-panel-collapsed');
      $('#repository-ide-host').hidden = !ide;
      fixtureSplit.setContext('composer-layout-fixture', ide);
      window.activeComposer = document.querySelector('[data-composer-scope="' + (global ? 'global' : 'repository') + '"]');
      window.activePrefix = global ? 'global-agent' : 'agent';
      activeComposer.querySelector('.queue-prompt-button').classList.add('hidden');
      activeComposer.querySelector('textarea').value = 'Unsent draft — preserve this exact text.';
      resizeAgentComposer(activeComposer.querySelector('textarea'));
    };
    window.measureComposer = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      const composer = activeComposer, toolbar = composer.querySelector('.composer-toolbar'), parent = composer.parentElement;
      return {
        viewport:{ width:innerWidth, height:innerHeight }, composer:rect(composer), toolbar:rect(toolbar), chat:rect(parent.querySelector('.chat-scroll-region')), parent:rect(parent),
        controls:[...toolbar.children].filter(node => node.checkVisibility()).map(node => ({ type:node.className, ...rect(node) })),
        draft:composer.querySelector('textarea').value, label:composer.querySelector('[data-composer-model-label]').textContent,
        input:rect(composer.querySelector('textarea')), inputMax:parseFloat(getComputedStyle(composer.querySelector('textarea')).maxHeight),
        textColor:getComputedStyle(composer).color, background:getComputedStyle(composer).backgroundColor,
      };
    };
    undefined;
  `);
  const settle = () => run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const measure = () => run("window.measureComposer()");
  const capture = async (kind, theme, width, phase) => {
    if (process.env.ARGUS_COMPOSER_CAPTURE !== "1") return;
    // Hidden-window geometry settles before its compositor's first painted
    // surface. Wait for fonts and that paint too, avoiding an empty first PNG.
    await run("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80)))))");
    await fs.writeFile(path.join(temporary, `${kind}-${theme}-${width}-${phase}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const checkToolbar = value => {
    const message = JSON.stringify(value);
    assert.ok(value.composer.height <= 110, message);
    assert.ok(value.composer.left >= 0 && value.composer.right <= value.viewport.width + 1 && value.composer.bottom <= value.viewport.height + 1, message);
    assert.ok(value.chat.height > 0, message);
    let previous;
    for (const control of value.controls) {
      assert.ok(control.left >= value.toolbar.left && control.right <= value.toolbar.right + 1, message);
      assert.ok(control.top >= value.toolbar.top && control.bottom <= value.toolbar.bottom + 1, message);
      if (previous) assert.ok(control.left >= previous.right - 1 && Math.abs(control.top - previous.top) <= 1, message);
      previous = control;
    }
    assert.equal(value.draft, "Unsent draft — preserve this exact text.");
  };
  let scenarios = 0;
  for (const kind of ["nexus", "repository", "ide"]) for (const width of [1440, 760, 440]) for (const theme of ["dark", "light"]) {
    window.setContentSize(width, 900);
    await run(`new Promise((resolve, reject) => { let count = 0; const next = () => Math.abs(innerWidth - ${width}) <= 1 ? resolve() : ++count < 100 ? setTimeout(next, 10) : reject(new Error('Resize did not settle')); next(); })`);
    await run(`
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      for (const [key, value] of Object.entries(${JSON.stringify(nexusThemeVariables("ocean", theme))})) $('#global-codex-panel').style.setProperty(key, value);
      configureComposerView(${JSON.stringify(kind)});
    `);
    await settle();
    const closed = await measure(); checkToolbar(closed);
    if (kind === "ide") {
      assert.ok(closed.parent.height >= 700, "right-side chat retains the full workbench height: " + JSON.stringify(closed));
      assert.ok(closed.parent.width <= 500 && closed.parent.right >= width - 1, "chat is a compact right-hand pane: " + JSON.stringify(closed));
      assert.ok(closed.composer.height <= 95, JSON.stringify(closed));
    }
    await capture(kind, theme, width, "closed");
    await run("activeComposer.querySelector('.queue-prompt-button').classList.remove('hidden')");
    await settle(); checkToolbar(await measure());
    if (width === 440) {
      await run("activeComposer.style.width = '300px'");
      await settle(); checkToolbar(await measure());
      await run("activeComposer.style.removeProperty('width')");
      await settle();
    }
    await run(`(() => {
      activeComposer.querySelector('.task-notes-bar').dataset.enabledNoteCount = '2';
      const repos = activeComposer.querySelector('#nexus-repository-picker-root'); if (repos) repos.dataset.selectedRepositoryCount = '3';
      const history = activeComposer.querySelector('#' + activePrefix + '-context-mode'); history.value = 'history'; history.dispatchEvent(new Event('change', { bubbles:true }));
      const model = activeComposer.querySelector('#' + activePrefix + '-model'); model.value = 'sol'; model.dispatchEvent(new Event('change', { bubbles:true }));
    })()`);
    await settle();
    const labels = await run(`({ label:activeComposer.querySelector('[data-composer-model-label]').textContent, badge:activeComposer.querySelector('[data-composer-context-count]').textContent, hidden:activeComposer.querySelector('[data-composer-context-count]').hidden, title:activeComposer.querySelector('.composer-context-toggle').title })`);
    assert.equal(labels.label, "GPT-5.6-Sol"); assert.equal(labels.hidden, false); assert.equal(labels.badge, kind === "nexus" ? "3" : "2"); assert.match(labels.title, /2 enabled notes.*Previous chat context/);
    for (const menu of ["model", "context"]) {
      await run(`activeComposer.querySelector('.composer-${menu}-menu > summary').click()`);
      await settle();
      const popup = await run(`(() => {
        const menu = activeComposer.querySelector('.composer-${menu}-menu'), panel = menu.querySelector('.composer-popover'), r = panel.getBoundingClientRect();
        return { open:panel.matches(':popover-open'), expanded:menu.querySelector('summary').getAttribute('aria-expanded'), left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height, composerHeight:activeComposer.getBoundingClientRect().height, textColor:getComputedStyle(panel).color, background:getComputedStyle(panel).backgroundColor };
      })()`);
      assert.equal(popup.open, true); assert.equal(popup.expanded, "true");
      assert.ok(popup.left >= 0 && popup.top >= 0 && popup.right <= width + 1 && popup.bottom <= 901, JSON.stringify({ kind, theme, width, popup }));
      assert.ok(Math.abs(popup.composerHeight - closed.composer.height) <= 1, JSON.stringify({ closed, popup }));
      assert.equal(popup.background, closed.background, "native top-layer menu keeps the composer palette");
      assert.equal(await run("activeComposer.querySelectorAll('.composer-popover:popover-open').length"), 1);
      const controls = await run(`(() => {
        const panel = activeComposer.querySelector('.composer-${menu}-menu .composer-popover');
        return [...panel.querySelectorAll('select')].map(select => {
          select.scrollIntoView({ block:'nearest' }); select.focus();
          const r = select.getBoundingClientRect(), p = panel.getBoundingClientRect();
          return { id:select.id, visible:select.checkVisibility(), focused:document.activeElement === select, inside:r.top >= p.top - 1 && r.bottom <= p.bottom + 1 && r.left >= p.left && r.right <= p.right + 1 };
        });
      })()`);
      assert.ok(controls.length > 0);
      for (const control of controls) assert.deepEqual({ visible:control.visible, focused:control.focused, inside:control.inside }, { visible:true, focused:true, inside:true }, `${kind}/${width}/${menu} ${control.id}`);
      await capture(kind, theme, width, menu);
      // Actual key events exercise the renderer's focus and native popover path.
      await run(`activeComposer.querySelector('.composer-${menu}-menu [data-composer-menu-close]').focus()`);
      window.webContents.sendInputEvent({ type:"keyDown", keyCode:"Escape" });
      window.webContents.sendInputEvent({ type:"keyUp", keyCode:"Escape" });
      await settle();
      const escaped = await run(`(() => { const menu = activeComposer.querySelector('.composer-${menu}-menu'); return { open:menu.open, popup:menu.querySelector('.composer-popover').matches(':popover-open'), expanded:menu.querySelector('summary').getAttribute('aria-expanded'), focused:document.activeElement === menu.querySelector('summary') }; })()`);
      assert.deepEqual(escaped, { open:false, popup:false, expanded:"false", focused:true });
      await run(`activeComposer.querySelector('.composer-${menu}-menu > summary').click()`); await settle();
      const outside = await run("(() => { const r = $('#fixture-outside').getBoundingClientRect(); return { x:Math.round(r.left + r.width/2), y:Math.round(r.top + r.height/2) }; })()");
      window.webContents.sendInputEvent({ type:"mouseDown", button:"left", clickCount:1, ...outside });
      window.webContents.sendInputEvent({ type:"mouseUp", button:"left", clickCount:1, ...outside });
      await settle();
      const dismissed = await run(`(() => { const menu = activeComposer.querySelector('.composer-${menu}-menu'); return { open:menu.open, popup:menu.querySelector('.composer-popover').matches(':popover-open'), expanded:menu.querySelector('summary').getAttribute('aria-expanded'), focused:document.activeElement === $('#fixture-outside') }; })()`);
      assert.deepEqual(dismissed, { open:false, popup:false, expanded:"false", focused:true });
      assert.equal(await run(`activeComposer.querySelector('.composer-${menu}-menu .composer-popover').checkVisibility()`), false);
      checkToolbar(await measure());
    }
    await run(`(() => { const input = activeComposer.querySelector('textarea'); input.value = Array.from({ length:30 }, (_, index) => 'Multiline draft ' + index).join(String.fromCharCode(10)); resizeAgentComposer(input); })()`);
    const multiline = await run(`(() => { const input = activeComposer.querySelector('textarea'); return { height:input.getBoundingClientRect().height, maximum:parseFloat(getComputedStyle(input).maxHeight), scroll:input.scrollHeight > input.clientHeight, lines:input.value.split(String.fromCharCode(10)).length }; })()`);
    assert.ok(multiline.height <= multiline.maximum + 1, JSON.stringify(multiline)); assert.equal(multiline.scroll, true); assert.equal(multiline.lines, 30);
    scenarios++;
  }
  let zoomScenarios = 0;
  window.setContentSize(760, 900);
  window.webContents.setZoomFactor(1.12);
  await run("new Promise((resolve, reject) => { let count = 0; const next = () => Math.abs(innerWidth - 760/1.12) <= 2 ? resolve() : ++count < 100 ? setTimeout(next, 10) : reject(new Error('Native zoom did not settle')); next(); })");
  for (const kind of ["nexus", "ide"]) {
    await run(`configureComposerView(${JSON.stringify(kind)})`); await settle();
    const closed = await measure(); checkToolbar(closed);
    for (const menu of ["context", "model"]) {
      await run(`activeComposer.querySelector('.composer-${menu}-menu > summary').click()`); await settle();
      const zoomed = await run(`(() => {
        const menu = activeComposer.querySelector('.composer-${menu}-menu'), panel = menu.querySelector('.composer-popover'), r = panel.getBoundingClientRect(), a = menu.querySelector('summary').getBoundingClientRect();
        return { open:panel.matches(':popover-open'), left:r.left, right:r.right, top:r.top, bottom:r.bottom, anchorLeft:a.left, anchorTop:a.top, width:innerWidth, height:innerHeight, composerHeight:activeComposer.getBoundingClientRect().height };
      })()`);
      assert.equal(zoomed.open, true);
      assert.ok(zoomed.left >= 0 && zoomed.top >= 0 && zoomed.right <= zoomed.width + 1 && zoomed.bottom <= zoomed.height + 1, JSON.stringify({ kind, menu, zoomed }));
      assert.ok(Math.abs(zoomed.composerHeight - closed.composer.height) <= 1, JSON.stringify({ closed, zoomed }));
      await capture(kind, "light", 760, `zoom112-${menu}`);
      await run(`activeComposer.querySelector('.composer-${menu}-menu [data-composer-menu-close]').click()`); await settle();
    }
    zoomScenarios++;
  }
  window.webContents.setZoomFactor(1);
  await run(`(() => {
    const probes = document.createElement('div'); probes.id = 'fixture-disclosures'; probes.style.cssText = 'position:fixed;left:-2000px;top:0;width:400px';
    probes.innerHTML = '<style>#fixture-disclosures *::before { transition:none }</style>'
      + ['repository-ide', 'repository-ports-panel', 'chat-revisions-toolbar', 'slack-bot-editor', 'agent-profile-fields', 'project-form-grid', 'json-search-bar', 'repo-production-branch-row'].map(name => '<section class="' + name + '"><select id="probe-' + name + '" class="repository-ports-select"><option>Long current choice</option></select></section>').join('')
      + '<section class="storage-repositories-section"><details><summary>Repositories</summary></details></section><section class="storage-lifecycle-section"><details><summary>Lifecycle</summary></details></section>'
      + ['json-tree-branch', 'execution-final-prompt', 'background-job-logs'].map(name => '<details class="' + name + '"><summary>Details</summary></details>').join('');
    document.body.append(probes);
  })()`);
  let alignmentScenarios = 0;
  // Fixed geometry must stay centered with the user's handwriting font too,
  // not merely with the default font used by the earlier layout cases.
  for (const font of ["system", "comic-sans", "serif", "mono"]) for (const theme of ["dark", "light"]) for (const width of [760, 440]) {
    window.setContentSize(width, 900);
    await run(`new Promise((resolve, reject) => { let count = 0; const next = () => Math.abs(innerWidth - ${width}) <= 1 ? resolve() : ++count < 100 ? setTimeout(next, 10) : reject(new Error('Alignment resize did not settle')); next(); })`);
    for (const kind of ["nexus", "repository", "ide"]) {
      await run(`document.documentElement.dataset.fontFamily = ${JSON.stringify(font)}; document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        for (const [key, value] of Object.entries(${JSON.stringify(nexusThemeVariables("ocean", theme))})) $('#global-codex-panel').style.setProperty(key, value);
        configureComposerView(${JSON.stringify(kind)});`);
      await settle(); checkToolbar(await measure());
      const controls = await run(`(() => {
        const targets = [...activeComposer.querySelectorAll('.composer-menu > summary'), ...(document.body.dataset.view === 'global' ? [$('#nexus-theme-toggle')] : [])];
        return targets.map(control => {
          const box = control.getBoundingClientRect();
          return { label:control.getAttribute('aria-label'), children:[...control.children].filter(child => child.checkVisibility()).map(child => {
            const r = child.getBoundingClientRect(); return { tag:child.tagName, className:child.getAttribute('class'), width:r.width, height:r.height, left:r.left, right:r.right,
              centered:Math.abs((r.top + r.bottom - box.top - box.bottom) / 2), inside:r.left >= box.left && r.right <= box.right + .5,
              hidden:child.getAttribute('aria-hidden'), focusable:child.getAttribute('focusable') };
          }) };
        });
      })()`);
      for (const control of controls) {
        let previous;
        for (const child of control.children) {
          const diagnostic = JSON.stringify({ font, theme, width, kind, control });
          assert.ok(child.centered <= .6 && child.inside, diagnostic);
          if (previous) assert.ok(child.left >= previous.right + 4, diagnostic);
          if (child.tag === "svg") {
            const size = child.className === "composer-context-icon" ? 16 : 14;
            assert.equal(child.width, size, diagnostic); assert.equal(child.height, size, diagnostic);
            assert.equal(child.hidden, "true"); assert.equal(child.focusable, "false");
          }
          previous = child;
        }
      }
      if (font === "comic-sans" && width === 760) await capture(kind, theme, width, "comic-aligned");
      alignmentScenarios++;
    }
    const selects = await run(`(() => {
      const fixture = document.createElement('div'); fixture.innerHTML = '<select multiple><option>Many</option></select><select size="5"><option>List</option></select><select size="1"><option>One</option></select><select size="0"><option>Default</option></select>'; document.body.append(fixture);
      const result = [...document.querySelectorAll('select')].map(select => { const style = getComputedStyle(select); return { id:select.id || select.outerHTML.slice(0,80), list:select.multiple || select.size > 1,
        image:style.backgroundImage, repeat:style.backgroundRepeat, size:style.backgroundSize, position:style.backgroundPosition, padding:parseFloat(style.paddingRight), appearance:style.appearance }; });
      fixture.remove(); return result;
    })()`);
    assert.ok(selects.length > 25, "check actual controls across app dialogs, not just synthetic fields");
    for (const select of selects) {
      const diagnostic = JSON.stringify({ font, theme, select });
      if (select.list) assert.equal(select.image, "none", diagnostic);
      else {
        assert.match(select.image, /svg\+xml/, diagnostic); assert.equal(select.repeat, "no-repeat", diagnostic);
        assert.equal(select.size, "14px 14px", diagnostic); assert.match(select.position, /9px.*50%/, diagnostic);
        assert.ok(select.padding >= 28, diagnostic); assert.equal(select.appearance, "none", diagnostic);
      }
    }
    const disclosures = await run(`(() => [...document.querySelectorAll('#fixture-disclosures details')].map(details => {
      const summary = details.querySelector('summary'), read = () => { const style = getComputedStyle(summary, '::before'); return { content:style.content, width:style.width, height:style.height, mask:style.maskImage, color:style.color, background:style.backgroundColor, transform:style.transform }; };
      details.open = false; const closed = read(); details.open = true; const opened = read(); return { name:details.className || details.parentElement.className, closed, opened };
    }))()`);
    assert.equal(disclosures.length, 5);
    for (const { name, closed, opened } of disclosures) {
      const diagnostic = JSON.stringify({ name, font, theme, closed, opened });
      assert.equal(closed.content, '\"\"', diagnostic);
      assert.equal(closed.width, "14px", diagnostic); assert.equal(closed.height, "14px", diagnostic);
      assert.match(closed.mask, /svg\+xml/, diagnostic); assert.equal(closed.background, closed.color, diagnostic);
      assert.notEqual(closed.transform, opened.transform, diagnostic);
    }
  }
  await run("$('#fixture-disclosures').remove()");
  const { composerDraftFunctions } = await import(pathToFileURL(path.join(root, "test/helpers/composer-draft-functions.mjs")).href);
  const attachmentCardSource = (await fs.readFile(path.join(root, "public/context-attachment-view.mjs"), "utf8")).replace(/^export /gm, "");
  const draftFunctions = [...composerDraftFunctions, "scopedAttachments", "activeTaskId", "renderContextTray", "escapeHtml", "formatBytes"].map(name => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  }).join("\n");
  const recoveryScenarios = await run(`(() => {
    const state = { currentView:'global', activeRepository:{id:'repo'}, activeTaskByRepository:{repo:'task'}, activeGlobalTaskId:'task', repositoryDrafts:{}, globalDraft:'', repositoryAttachments:{repo:[]}, globalAttachments:[] };
    ${attachmentCardSource}
    ${draftFunctions}
    let scenarios = 0;
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    for (const scope of ['global', 'repository']) {
      state.currentView = scope;
      const textarea = $(scope === 'global' ? '#global-agent-prompt' : '#agent-prompt');
      const tray = $(scope === 'global' ? '#global-context-tray' : '#agent-context-tray');
      textarea.value = '  Submitted prompt\\n';
      scopedAttachments(scope).push({id:'sent', title:'Submitted image.png', kind:'image', size:128});
      renderContextTray(scope);
      const snapshot = takeComposerDraft(scope);
      expect(textarea.value === '' && !tray.classList.contains('has-context') && tray.querySelector('.context-chips').children.length === 0, scope + ': clear text, tray and chips synchronously');
      expect(snapshot.attachments[0].id === 'sent', scope + ': original attachment retained');
      textarea.value = 'Newer draft';
      scopedAttachments(scope).push({id:'new', title:'New file.txt', kind:'file', size:64});
      expect(restoreComposerDraft(snapshot) === false, scope + ': protect new draft');
      const recover = [...tray.querySelectorAll('button')].find(button => button.textContent === 'Restore unsent request');
      expect(recover && recover.type === 'button' && !recover.disabled, scope + ': recovery is a usable non-submit button');
      recover.click();
      expect(textarea.value === '  Submitted prompt\\n' && scopedAttachments(scope)[0].id === 'sent', scope + ': restore original');
      const newer = [...tray.querySelectorAll('button')].find(button => button.textContent === 'Restore unsent request');
      newer.click();
      expect(textarea.value === 'Newer draft' && scopedAttachments(scope)[0].id === 'new', scope + ': restore newer draft');
      scenarios++;
    }
    return scenarios;
  })()`);
  assert.equal(recoveryScenarios, 2);
  await run("compactComposers.destroy()");
  console.log("COMPACT_COMPOSER_RESULT=" + JSON.stringify({ ok:true, scenarios, zoomScenarios, alignmentScenarios, recoveryScenarios })); finish(0);
}).catch(error => { console.error(error); finish(1); });
