// Real production composer markup, cascade and disclosure controller. Synthetic
// content only: no application bootstrap, repository, profile or backend.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-alignment-composer-363-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const timeout = setTimeout(() => { console.error("Composer alignment timed out"); app.exit(1); }, 45_000);
const finish = code => { clearTimeout(timeout); window?.destroy(); app.exit(code); };
app.whenReady().then(async () => {
  const html = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const files = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\/([^"?]+)[^"]*"[^>]*>/g)].map(match => match[1]);
  const styles = (await Promise.all(files.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const controller = (await fs.readFile(path.join(root, "public/compact-composer.mjs"), "utf8")).replace(/^export /gm, "");
  const { nexusThemeVariables } = await import(pathToFileURL(path.join(root, "public/nexus-themes.mjs")).href);
  const isolated = session.fromPartition("alignment-composer-363", { cache:false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel:!details.url.startsWith("data:") }));
  window = new BrowserWindow({ show:false, width:900, height:720, webPreferences:{ session:isolated, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}\nbody { display:block; margin:0; } #fixture { position:fixed; left:24px; bottom:24px; height:260px; display:flex; flex-direction:column; justify-content:flex-end; padding:0; } #fixture > section { display:block; flex:none; width:100%; min-width:0; padding:0; margin:0; border:0; } #fixture .chat-composer { margin:0; } </style></head><body><div id="fixture"></div></body></html>`)}`);
  const run = script => window.webContents.executeJavaScript(script);
  await run(`
    ${controller}
    const template = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html');
    window.prepare = (scope, width, empty) => {
      window.composers?.destroy();
      const host = document.querySelector('#fixture'); host.style.width = width + 'px'; host.replaceChildren();
      const section = document.createElement('section');
      if (scope === 'global') section.id = 'global-codex-panel'; else section.className = 'ai-main-content';
      const composer = template.querySelector('[data-composer-scope="' + scope + '"]').cloneNode(true);
      section.append(composer); host.append(section);
      window.active = composer;
      const prefix = scope === 'global' ? 'global-agent' : 'agent';
      const model = composer.querySelector('#' + prefix + '-model');
      if (!empty) model.innerHTML = '<option>A very long descriptive model identifier for a custom provider</option>';
      composer.querySelector('#' + prefix + '-config-summary').textContent = empty ? 'Configure' : 'Ultra · Plan only · Standard';
      const notes = composer.querySelector('.task-notes-bar');
      notes.dataset.enabledNoteCount = empty ? '0' : '9';
      notes.innerHTML = '<button class="task-notes-open"><span>NOTE</span> 9 enabled</button><small>This task</small><button class="task-notes-toggle">Skip this prompt</button>';
      composer.querySelector('textarea').value = empty ? '' : 'An unsent draft stays intact.';
      composer.querySelector('.queue-prompt-button').classList.toggle('hidden', empty);
      if (!empty) {
        const tray = composer.querySelector('.context-tray'); tray.classList.add('has-context');
        tray.querySelector('.context-chips').innerHTML = '<span class="context-chip"><span class="context-kind">▧</span><span><strong>An extremely long attachment filename with useful context.png</strong><small>Image · 128.7 MB</small></span><button type="button" aria-label="Remove attachment">×</button></span>';
      }
      window.composers = initializeCompactComposers({ document });
    };
    window.inspect = () => {
      const box = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      const toolbar = active.querySelector('.composer-toolbar');
      return { composer:box(active), toolbar:box(toolbar), controls:[...toolbar.children].filter(node => node.checkVisibility()).map(node => ({ name:node.className, ...box(node), children:[...node.children].filter(child => child.checkVisibility()).map(child => ({ name:child.className || child.tagName, ...box(child), scrollWidth:child.scrollWidth })) })),
        summaries:[...active.querySelectorAll('.composer-menu > summary')].map(node => ({ ...box(node), children:[...node.children].filter(child => child.checkVisibility()).map(box) })),
        chips:[...active.querySelectorAll('.context-chip')].map(node => ({ ...box(node), children:[...node.children].map(box) })),
        draft:active.querySelector('textarea').value };
    };
    undefined;
  `);
  const settle = () => run("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  const capture = async name => {
    if (process.env.ARGUS_ALIGNMENT_COMPOSER_CAPTURE !== "1") return;
    await settle();
    const region = await run(`(() => {
      const rects = [active, ...active.querySelectorAll('.composer-popover:popover-open')].map(node => node.getBoundingClientRect());
      const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - 10)), y = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - 10));
      return { x, y, width:Math.min(innerWidth - x, Math.ceil(Math.max(...rects.map(r => r.right)) - x + 10)), height:Math.min(innerHeight - y, Math.ceil(Math.max(...rects.map(r => r.bottom)) - y + 10)) };
    })()`);
    await fs.writeFile(path.join(temporary, name + ".png"), (await window.webContents.capturePage(region)).toPNG());
  };
  let scenarios = 0;
  for (const scope of ["global", "repository"]) for (const font of ["system", "comic-sans"]) for (const theme of ["dark", "light"]) for (const width of [260, 320, 480, 800]) for (const empty of [true, false]) {
    await run(`document.documentElement.dataset.fontFamily = ${JSON.stringify(font)}; document.documentElement.dataset.theme = ${JSON.stringify(theme)}; prepare(${JSON.stringify(scope)}, ${width}, ${empty});`);
    if (scope === "global") await run(`for (const [key, value] of Object.entries(${JSON.stringify(nexusThemeVariables("ocean", theme))})) document.querySelector('#global-codex-panel').style.setProperty(key, value);`);
    await settle();
    const value = await run("inspect()");
    const diagnostic = JSON.stringify({ scope, font, theme, width, empty, value });
    await capture(`${scope}-${font}-${theme}-${width}-${empty ? "empty" : "context"}`);
    assert.equal(value.draft, empty ? "" : "An unsent draft stays intact.");
    let previous;
    for (const control of value.controls) {
      assert.ok(control.left >= value.toolbar.left && control.right <= value.toolbar.right + .5, diagnostic);
      assert.ok(control.top >= value.toolbar.top && control.bottom <= value.toolbar.bottom + .5, diagnostic);
      if (previous) assert.ok(control.left >= previous.right + 4, diagnostic);
      previous = control;
    }
    for (const chip of value.chips) for (const child of chip.children) {
      assert.ok(child.top >= chip.top && child.bottom <= chip.bottom + .5, diagnostic);
      assert.ok(child.left >= chip.left && child.right <= chip.right + .5, diagnostic);
    }
    for (const summary of value.summaries) {
      let previousChild;
      for (const child of summary.children) {
        assert.ok(Math.abs((child.top + child.bottom - summary.top - summary.bottom) / 2) <= .5, diagnostic);
        assert.ok(child.left >= summary.left && child.right <= summary.right + .5, diagnostic);
        if (previousChild) assert.ok(child.left >= previousChild.right + 4, diagnostic);
        previousChild = child;
      }
    }
    if (width === 320) for (const name of ["context", "model"]) {
      await run(`active.querySelector('.composer-${name}-menu > summary').click()`); await settle();
      const popup = await run(`(() => {
        const panel = active.querySelector('.composer-${name}-popover, .composer-${name}-menu .composer-popover'), r = panel.getBoundingClientRect();
        const title = panel.querySelector('header strong').getBoundingClientRect(), close = panel.querySelector('[data-composer-menu-close]').getBoundingClientRect();
        return { open:panel.matches(':popover-open'), left:r.left, right:r.right, top:r.top, bottom:r.bottom, scrollWidth:panel.scrollWidth, width:panel.clientWidth,
          titleCloseCenterDifference:Math.abs((title.top + title.bottom - close.top - close.bottom) / 2),
          fields:[...panel.querySelectorAll('select')].map(select => { const box = select.getBoundingClientRect(); return { left:box.left, right:box.right }; }) };
      })()`);
      assert.ok(popup.open && popup.left >= 0 && popup.top >= 0 && popup.right <= 900 && popup.bottom <= 720, JSON.stringify(popup));
      assert.ok(popup.scrollWidth <= popup.width + 1, JSON.stringify(popup));
      for (const field of popup.fields) assert.ok(field.left >= popup.left && field.right <= popup.right, JSON.stringify(popup));
      await capture(`${scope}-${font}-${theme}-${name}`);
      assert.ok(popup.titleCloseCenterDifference <= .5, JSON.stringify({ scope, font, theme, name, popup }));
      await run(`active.querySelector('.composer-${name}-menu [data-composer-menu-close]').click()`);
    }
    scenarios++;
  }
  console.log(`ALIGNMENT_COMPOSER_363_RESULT=${JSON.stringify({ ok:true, scenarios })}`);
  finish(0);
}).catch(error => { console.error(error); finish(1); });
