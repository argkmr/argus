// Production branch dialog/CSS/renderer with synthetic data only. This fixture
// cannot load app.js, application backends, user profiles or outside resources.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const temporary = process.argv[2];
assert.ok(temporary && path.isAbsolute(temporary) && path.basename(temporary).startsWith("argus-recent-branches-layout-"), "Isolated test directory required");
for (const key of ["userData", "sessionData", "logs"]) app.setPath(key, path.join(temporary, key));
app.commandLine.appendSwitch("disable-background-networking");
const root = path.resolve(__dirname, "../.."), publicRoot = path.join(root, "public");
let window, server, unexpectedNetwork = 0, backendCalls = 0;
const timer = setTimeout(() => { console.error("Recent branches fixture timed out"); app.exit(1); }, 35_000);
const finish = code => { clearTimeout(timer); window?.destroy(); server?.close(); app.exit(code); };

app.whenReady().then(async () => {
  const index = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const sheets = [...index.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  assert.ok(sheets.includes("font-family.css"), "Use the actual production font preferences");
  const styles = (await Promise.all(sheets.map(file => fs.readFile(path.join(publicRoot, file), "utf8")))).join("\n");
  const dialog = index.match(/<dialog id="branch-dialog">[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(dialog, "Production branch dialog must exist");
  const appSource = await fs.readFile(path.join(publicRoot, "app.js"), "utf8");
  const branchIcon = appSource.match(/const branchIcon = `([^`]+)`;/)?.[1];
  assert.ok(branchIcon, "Production branch icon must exist");
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style></head><body data-view="repository">${dialog}</body></html>`;
  const moduleSource = await fs.readFile(path.join(publicRoot, "branch-picker.mjs"), "utf8");
  server = http.createServer((request, response) => {
    const route = new URL(request.url, "http://localhost").pathname;
    if (route === "/fixture") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); return; }
    if (route === "/branch-picker.mjs") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(moduleSource); return; }
    if (route.startsWith("/api/")) backendCalls++;
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isolated = session.fromPartition("recent-branches-layout", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url === origin + "/fixture" || details.url === origin + "/branch-picker.mjs" || details.url.startsWith("data:");
    if (!allowed) { unexpectedNetwork++; if (details.url.startsWith(origin + "/api/")) backendCalls++; }
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(origin + "/fixture");
  const run = script => window.webContents.executeJavaScript(script);
  const settle = () => run("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  // setContentSize/setZoomFactor return before Chromium has necessarily applied
  // its new viewport. Under a busy full-suite run, two animation frames can
  // still measure the preceding scenario. Wait for the requested viewport and
  // three identical layout samples before comparing baseline/with-recents.
  const settleViewport = (width, height, zoom) => run(`(async () => {
    await document.fonts.ready;
    const expected = {width:${width / zoom},height:${height / zoom}}, deadline=performance.now()+5000;
    let previous='', stable=0;
    while(performance.now()<deadline) {
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const list=fixture.list.getBoundingClientRect(), card=document.querySelector('.branch-dialog-card').getBoundingClientRect();
      const sample=JSON.stringify([innerWidth,innerHeight,list.width,list.height,card.width,card.height]);
      const matches=Math.abs(innerWidth-expected.width)<=1 && Math.abs(innerHeight-expected.height)<=1;
      stable=matches && sample===previous ? stable+1 : 0; previous=sample;
      if(stable>=3) return;
    }
    throw new Error('Native viewport did not settle: expected '+JSON.stringify(expected)+'; observed '+previous);
  })()`);
  await run(`(async () => {
    const { branchPickerMarkup } = await import('/branch-picker.mjs');
    const list = document.querySelector('#branch-picker-list');
    const form = document.querySelector('#branch-form');
    const make = (name, type = 'local', current = false) => ({name, ref: (type === 'local' ? 'refs/heads/' : 'refs/remotes/') + name, type, current, selectable: true, upstream: ''});
    const longName = 'feature/gjpqy-ÀÉÅ-extremely-long-branch-name-for-responsive-layout-' + 'unbroken'.repeat(18);
    const recent = ['fix/recent-last', longName, 'feature/recent-third', 'fix/recent-fourth'].map(name => make(name));
    const branches = [make('main', 'local', true), ...recent, ...Array.from({length: 14}, (_, i) => make('feature/local-' + i)), ...Array.from({length: 8}, (_, i) => make('origin/remote-' + i, 'remote'))];
    window.fixture = {list, form, branches, recent, submissions: 0};
    form.addEventListener('submit', event => {event.preventDefault(); fixture.submissions++;});
    fixture.render = withRecent => {
      list.innerHTML = branchPickerMarkup({branches, recentBranches: withRecent ? recent : [], query: '', selected: recent[0].name, branchIcon:${JSON.stringify(branchIcon)}});
    };
    fixture.measure = () => {
      const rect = node => {const b = node.getBoundingClientRect(); return {left:b.left, right:b.right, top:b.top, bottom:b.bottom, width:b.width, height:b.height};};
      const card = document.querySelector('.branch-dialog-card');
      const items = [...list.querySelectorAll('[data-branch-candidate]')];
      const groups = [...list.querySelectorAll('.branch-picker-group')].map(node => ({title:node.textContent.trim(), count:(() => {let count=0; for(let n=node.nextElementSibling;n && !n.classList.contains('branch-picker-group');n=n.nextElementSibling) if(n.matches('[data-branch-candidate]'))count++;return count;})()}));
      const names = items.map(node => node.dataset.branchCandidate);
      return {list:rect(list), listClientWidth:list.clientWidth, listScrollWidth:list.scrollWidth, listClientHeight:list.clientHeight, listScrollHeight:list.scrollHeight, heightRule:getComputedStyle(list).height, overflowY:getComputedStyle(list).overflowY, card:rect(card), cardClientWidth:card.clientWidth, cardScrollWidth:card.scrollWidth, viewport:{width:innerWidth,height:innerHeight}, groups, recentCount:groups.find(group => group.title === 'RECENT BRANCHES')?.count || 0, duplicateCount:names.length-new Set(names).size, items:items.map(node => {
        const label = node.querySelector('strong'), css = getComputedStyle(node), labelCss = getComputedStyle(label);
        const lineHeight = parseFloat(labelCss.lineHeight);
        const rowBudget = Math.max(parseFloat(css.minHeight), 2 * lineHeight + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) + parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth));
        return {type:node.type, bounds:rect(node), label:rect(label), labelOverflow:labelCss.overflowX, lineHeight, rowBudget, fullTitle:label.title === node.dataset.branchCandidate};
      })};
    };
    fixture.reachable = async node => {
      node.scrollIntoView({block:'center', inline:'nearest'});
      await new Promise(resolve => requestAnimationFrame(resolve));
      const b = node.getBoundingClientRect();
      const x = (b.left+b.right)/2, y = (b.top+b.bottom)/2;
      return x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && node.contains(document.elementFromPoint(x,y));
    };
    document.querySelector('#branch-dialog-context').textContent = 'post-order-cx-bff · currently on fix/missing-fulfillment-autoheal';
    const status = document.querySelector('#branch-picker-status');
    status.textContent = 'Last four previously used local branches · newest first';
    status.hidden = false;
    document.querySelector('#confirm-branch-switch').disabled = false;
    fixture.render(true);
    document.querySelector('#branch-dialog').show();
  })()`);
  const layouts = [];
  for (const width of [360, 640, 1280]) for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans"]) for (const zoom of [1, 1.22]) {
    window.setContentSize(width, 900);
    // The packaged desktop applies font scale through native webContents zoom.
    window.webContents.setZoomFactor(zoom);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.fontFamily=${JSON.stringify(font)};fixture.render(false);undefined;`);
    await settleViewport(width, 900, zoom);
    const baselineHeight = await run("fixture.list.getBoundingClientRect().height");
    await run("fixture.render(true);fixture.list.scrollTop=0;undefined;");
    await settle();
    const result = await run("fixture.measure()"), diagnostic = JSON.stringify({ width, theme, font, zoom, baselineHeight, ...result });
    if (process.env.ARGUS_RECENT_BRANCHES_CAPTURE === "1") await fs.writeFile(path.join(temporary, `${theme}-${font}-${width}-${zoom}.png`), (await window.webContents.capturePage()).toPNG());
    assert.equal(result.recentCount, 4, diagnostic);
    assert.equal(result.duplicateCount, 0, diagnostic);
    assert.deepEqual(result.groups.map(group => group.title), ["RECENT BRANCHES", "LOCAL BRANCHES", "REMOTE BRANCHES"], diagnostic);
    assert.ok(Math.abs(result.list.height - baselineHeight) <= 1, "Adding recents must not grow the dialog: " + diagnostic);
    assert.ok(parseFloat(result.heightRule) <= 330.5 && result.list.height <= 331, "Picker must retain its existing bounded height: " + diagnostic);
    assert.ok(result.listScrollHeight > result.listClientHeight && ["auto", "scroll"].includes(result.overflowY), "Full branch list must scroll: " + diagnostic);
    assert.ok(result.listScrollWidth <= result.listClientWidth + 1, "Branch list overflows horizontally: " + diagnostic);
    assert.ok(result.cardScrollWidth <= result.cardClientWidth + 1, "Dialog overflows horizontally: " + diagnostic);
    assert.ok(result.card.left >= -1 && result.card.right <= result.viewport.width + 1, "Dialog escapes viewport: " + diagnostic);
    for (const item of result.items) {
      assert.equal(item.type, "button", "A candidate must never submit the form on selection: " + diagnostic);
      assert.ok(item.bounds.left >= result.list.left - 1 && item.bounds.right <= result.list.right + 1, "Branch candidate escapes list: " + diagnostic);
      assert.ok(item.label.left >= item.bounds.left - 1 && item.label.right <= item.bounds.right + 1, "Long label escapes its row: " + diagnostic);
      assert.ok(item.label.height <= 2 * item.lineHeight + 1, "Long branch label exceeds its two-line budget: " + diagnostic);
      assert.ok(item.bounds.height <= item.rowBudget + 1, "Long branch row grows beyond two text lines plus padding: " + diagnostic);
      assert.equal(item.fullTitle, true, "Clamped branch label must retain its full-name tooltip: " + diagnostic);
    }
    assert.ok(result.items[3].bounds.bottom <= result.list.bottom + 1, "All four recent branches should remain visible initially: " + diagnostic);
    const interactions = await run(`(async () => {
      const rows = [...fixture.list.querySelectorAll('[data-branch-candidate]')];
      const before = fixture.submissions;
      rows[0].click();
      const lastReachable = await fixture.reachable(rows.at(-1));
      const actions = [...document.querySelectorAll('#branch-form .dialog-actions button')];
      const actionReachable = [];
      for (const action of actions) actionReachable.push(await fixture.reachable(action));
      return {lastReachable,actionReachable,clickSubmissions:fixture.submissions-before};
    })()`);
    assert.equal(interactions.lastReachable, true, "Last branch cannot be reached by scrolling: " + diagnostic);
    assert.ok(interactions.actionReachable.every(Boolean), "Cancel/switch actions cannot be reached: " + diagnostic);
    assert.equal(interactions.clickSubmissions, 0, "Candidate click submitted unexpectedly");
    layouts.push({ width, theme, font, zoom, ...result, ...interactions });
  }
  await fs.writeFile(path.join(temporary, "results.json"), JSON.stringify({ layouts, unexpectedNetwork, backendCalls }, null, 2));
  finish(0);
}).catch(error => { console.error(error.stack || error); finish(1); });
