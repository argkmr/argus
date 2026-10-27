// Actual shell, styles and search controller against immutable synthetic
// repositories. Never starts Argus, a backend, or a real repository operation.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-tab-search-renderer-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, unexpectedNetworkCount = 0;
const timer = setTimeout(() => { console.error("Repository search fixture timed out"); app.exit(1); }, 75_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
function sourceFunction(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Missing application function: ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
app.whenReady().then(async () => {
  const sourceShell = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const stylesheets = [...sourceShell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  assert.ok(stylesheets.includes("repository-tab-search.css"), "Search stylesheet must ship in the real shell");
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = sourceShell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles}</style>`);
  const isolated = session.fromPartition("repository-tab-search-regression", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { unexpectedNetworkCount++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  for (const file of ["repository-ports.mjs", "repository-tab-search.mjs"]) {
    await window.webContents.executeJavaScript((await fs.readFile(path.join(root, "public", file), "utf8")).replace(/^export /gm, ""));
  }
  const source = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  const functions = ["isRepositoryDestination", "repositoryTabHtml", "escapeHtml"].map(name => sourceFunction(source, name)).join("\n");
  await window.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector);
    const fixture = window.fixture = { selections:[], errors:[], writeCount:0 };
    const repositories = Array.from({ length:50 }, (_, index) => ({ id:"repo-" + index, name:"Service " + String(index).padStart(2, "0"), path:"/synthetic/projects/service-" + index }));
    repositories[0].name = "ReviewRating";
    repositories[17].name = 'Malicious <img src=x onerror="window.fixtureInjected=true">';
    repositories[33].path = "/synthetic/billing-root/nested/a-very-long-customer-and-payments-service-path/application";
    repositories[49].name = "A very long customer-facing repository name that must never push actions beyond the viewport";
    repositories[49].path = "/synthetic/" + "very-long-nested-directory/".repeat(12) + "application";
    for (const repository of repositories) Object.freeze(repository);
    Object.freeze(repositories);
    const groups = Object.freeze([Object.freeze({ id:"hidden-payments", name:"Payments & Billing", collapsed:true, repositoryIds:Object.freeze(["repo-35", "repo-36"]) })]);
    const savedState = Object.freeze({ order:Object.freeze(repositories.map(repository => repository.id).reverse()), drafts:Object.freeze({ "repo-0":"Keep this unsent repository prompt", nexus:"Keep this Nexus draft" }) });
    fixture.before = JSON.stringify({ repositories, groups, savedState });
    const state = { currentView:"repository", activeRepository:repositories[0] };
    ${functions}
    $("#repo-tabs").innerHTML = repositories.slice(0, 12).map(repository => repositoryTabHtml(repository)).join("");
    document.body.dataset.view = "repository"; document.body.classList.add("task-context-visible");
    $("#workspace").classList.remove("hidden"); $("#empty-state").classList.add("hidden");
    $("#context-repo").textContent = "reviewrating"; $("#context-branch").textContent = "feature/repository-search";
    $("#context-change-count").textContent = "12"; $("#repository-chat-toggle").disabled = false;
    const configuration = { id:"review", repositoryId:"repo-0", name:"Review rating", port:8083, managementPort:10106 };
    fixture.ports = createRepositoryPorts({ host:$("#repository-ports"), document, api:async (_route, options = {}) => {
      if (options.method && options.method !== "GET") { fixture.writeCount++; throw new Error("Writes are forbidden"); }
      return { configurationId:"review", repositoryId:"repo-0", applicationPort:8083, managementPort:10106, editable:true, contentHash:"synthetic", configFile:"application.yml" };
    }});
    fixture.ports.setContext({ repository:repositories[0], configurations:[configuration], selectedConfigurationId:"review", visible:true, processes:[] });
    fixture.search = createRepositoryTabSearch({ document, getRepositories:() => repositories, getGroups:() => groups, getActiveRepositoryId:() => "repo-0", onSelect:async id => { fixture.selections.push(id); return true; }, onError:error => fixture.errors.push(String(error)) });
    fixture.frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fixture.rows = () => [...$("#repository-tab-search-results").querySelectorAll("button[data-repository-id]")];
    fixture.ids = () => fixture.rows().map(row => row.dataset.repositoryId);
    fixture.open = async () => {
      if (!$("#repository-tab-search-popover").matches(":popover-open")) $("#repository-tab-search-toggle").click();
      await fixture.frames();
    };
    fixture.query = async query => { const input = $("#repository-tab-search-input"); input.value = query; input.dispatchEvent(new Event("input", { bubbles:true })); await fixture.frames(); return fixture.ids(); };
    fixture.key = async key => { document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles:true, cancelable:true })); await fixture.frames(); return document.activeElement.dataset.repositoryId || document.activeElement.id; };
    fixture.focus = () => document.activeElement.dataset.repositoryId || document.activeElement.id;
    fixture.snapshot = () => ({ open:$("#repository-tab-search-popover").matches(":popover-open"), focus:fixture.focus(), ids:fixture.ids(), status:$("#repository-tab-search-status").textContent, query:$("#repository-tab-search-input").value, selections:fixture.selections.slice() });
    fixture.preserved = () => fixture.before === JSON.stringify({ repositories, groups, savedState });
    fixture.header = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height, centerY:(r.top + r.bottom)/2 }; };
      const boxes = selector => [...$(selector).children].filter(node => node.checkVisibility() && rect(node).width > 0).map(rect);
      return { width:innerWidth, top:rect($("#repository-tab-tools-toggle")), search:rect($("#repository-tab-search-toggle")), project:rect($("#project-structure-toggle")), chat:rect($("#repository-chat-toggle")), titleGroups:boxes(".titlebar"), contextGroups:boxes(".context-strip"), toolbarGroups:boxes(".repository-toolbar"), titleOverflow:$(".titlebar").scrollWidth > $(".titlebar").clientWidth + 1, contextOverflow:$(".context-strip").scrollWidth > $(".context-strip").clientWidth + 1 };
    };
    fixture.geometry = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      const menu = $("#repository-tab-search-popover"), list = $("#repository-tab-search-results"), rows = fixture.rows();
      return { width:innerWidth, height:innerHeight, open:menu.matches(":popover-open"), role:menu.getAttribute("role"), menu:rect(menu), input:rect($("#repository-tab-search-input")), list:rect(list), listHeight:list.clientHeight, listScrollHeight:list.scrollHeight, listOverflowY:getComputedStyle(list).overflowY, menuOverflow:menu.scrollWidth > menu.clientWidth + 1, listOverflow:list.scrollWidth > list.clientWidth + 1, rows:rows.map(row => ({ id:row.dataset.repositoryId, ...rect(row) })), injected:Boolean(window.fixtureInjected), unsafeNodes:list.querySelectorAll("img, script, iframe").length };
    };
    void 0;
  `);
  const evaluate = script => window.webContents.executeJavaScript(script);
  const result = { ok:true, filterScenarios:0, focusScenarios:0, selectionScenarios:0, layoutScenarios:0, repositoryCount:50 };
  await evaluate("fixture.open()");
  let snapshot = await evaluate("fixture.snapshot()");
  assert.equal(snapshot.open, true); assert.equal(snapshot.focus, "repository-tab-search-input"); assert.equal(snapshot.ids.length, 50);
  result.focusScenarios++;
  for (const [query, expected] of [["rEvIeWrAtInG", ["repo-0"]], ["BILLING-root", ["repo-33"]], ["payments & BILLING", ["repo-35", "repo-36"]], ["does-not-exist-anywhere", []], ["Malicious", ["repo-17"]]]) {
    const ids = await evaluate(`fixture.query(${JSON.stringify(query)})`);
    assert.deepEqual(ids.slice().sort(), expected.slice().sort(), query);
    if (!expected.length) assert.match((await evaluate("fixture.snapshot()")).status, /no|0/i);
    result.filterScenarios++;
  }
  const security = await evaluate("fixture.geometry()"); assert.equal(security.unsafeNodes, 0); assert.equal(security.injected, false);
  await evaluate("fixture.query('Payments & Billing'); document.querySelector('#repository-tab-search-input').focus();");
  assert.equal(await evaluate("fixture.key('ArrowDown')"), "repo-35"); result.focusScenarios++;
  assert.equal(await evaluate("fixture.key('ArrowDown')"), "repo-36"); result.focusScenarios++;
  assert.equal(await evaluate("fixture.key('ArrowDown')"), "repo-35"); result.focusScenarios++;
  assert.equal(await evaluate("fixture.key('ArrowUp')"), "repo-36"); result.focusScenarios++;
  // Electron needs the text event as well as down/up to exercise the browser's
  // default Enter activation for a native button (not a synthetic click).
  window.webContents.sendInputEvent({ type:"keyDown", keyCode:"Enter" });
  window.webContents.sendInputEvent({ type:"char", keyCode:"\r" });
  window.webContents.sendInputEvent({ type:"keyUp", keyCode:"Enter" });
  await evaluate("fixture.frames()");
  snapshot = await evaluate("fixture.snapshot()"); assert.equal(snapshot.open, false, JSON.stringify(snapshot)); assert.deepEqual(snapshot.selections, ["repo-36"]); result.selectionScenarios++;
  await evaluate("fixture.open();");
  snapshot = await evaluate("fixture.snapshot()"); assert.equal(snapshot.query, ""); assert.equal(snapshot.ids.length, 50); assert.equal(snapshot.focus, "repository-tab-search-input"); result.focusScenarios++;
  await evaluate("fixture.query('ReviewRating'); document.querySelector('#repository-tab-search-input').focus(); fixture.key('Enter');");
  await evaluate("fixture.frames()");
  snapshot = await evaluate("fixture.snapshot()"); assert.equal(snapshot.open, false); assert.deepEqual(snapshot.selections, ["repo-36", "repo-0"]); result.selectionScenarios++;
  await evaluate("fixture.open();"); await evaluate("fixture.query('BILLING-root')");
  await evaluate("fixture.rows()[0].click(); fixture.frames();");
  snapshot = await evaluate("fixture.snapshot()"); assert.equal(snapshot.open, false); assert.deepEqual(snapshot.selections, ["repo-36", "repo-0", "repo-33"]); result.selectionScenarios++;
  await evaluate("fixture.open()");
  window.webContents.sendInputEvent({ type:"keyDown", keyCode:"Escape" }); window.webContents.sendInputEvent({ type:"keyUp", keyCode:"Escape" });
  await evaluate("fixture.frames()");
  snapshot = await evaluate("fixture.snapshot()"); assert.equal(snapshot.open, false); assert.equal(snapshot.focus, "repository-tab-search-toggle"); result.focusScenarios++;
  await evaluate("fixture.open();"); await evaluate("document.querySelector('#repository-tab-search-close').click(); fixture.frames();");
  snapshot = await evaluate("fixture.snapshot()"); assert.equal(snapshot.open, false); assert.equal(snapshot.focus, "repository-tab-search-toggle"); result.focusScenarios++;
  await evaluate("fixture.open();"); await evaluate("fixture.query('Service 01'); document.querySelector('#repository-tab-search-input').focus(); fixture.search.refresh(); fixture.frames();");
  snapshot = await evaluate("fixture.snapshot()"); assert.equal(snapshot.query, "Service 01"); assert.equal(snapshot.focus, "repository-tab-search-input"); assert.deepEqual(snapshot.ids, ["repo-1"]); result.focusScenarios++;
  await evaluate("fixture.search.close();");
  for (const width of [1440, 820, 680, 380]) for (const zoom of [1, 2]) {
    window.setContentSize(width * zoom, 900); window.webContents.setZoomFactor(zoom);
    await evaluate(`new Promise((resolve, reject) => {
      let matched = 0, frame; const timeout = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error("Search viewport did not settle")); }, 5000);
      const check = () => { matched = Math.abs(innerWidth - ${width}) <= 1 ? matched + 1 : 0; if (matched >= 2) { clearTimeout(timeout); resolve(); } else frame = requestAnimationFrame(check); }; frame = requestAnimationFrame(check);
    })`);
    for (const theme of ["dark", "light"]) for (const font of ["system", "comic-sans"]) for (const enabled of [false, true]) {
      const scenario = { width, zoom, theme, font, enabled };
      const header = await evaluate(`(async () => {
        fixture.search.close(); document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.documentElement.dataset.fontFamily = ${JSON.stringify(font)};
        document.body.classList.add('repository-ide-enabled'); document.body.classList.toggle('repository-ide-chat-hidden', ${!enabled}); document.querySelector('#repository-ide-host').hidden = false;
        document.querySelector('#repository-chat-toggle').setAttribute('aria-label', ${JSON.stringify(enabled ? "Hide AI chat" : "Show AI chat")}); document.querySelector('#repository-chat-toggle').setAttribute('aria-pressed', ${JSON.stringify(String(enabled))}); await fixture.frames(); return fixture.header();
      })()`);
      const headerDiagnostic = JSON.stringify({ scenario, header });
      assert.ok(Math.abs(header.top.right - header.project.right) <= 1, headerDiagnostic);
      assert.ok(Math.abs(header.project.centerY - header.chat.centerY) <= 1 && Math.abs(header.project.height - header.chat.height) <= 1, headerDiagnostic);
      assert.ok(header.chat.right <= header.project.left + 1, headerDiagnostic);
      assert.equal(header.titleOverflow, false, headerDiagnostic); assert.equal(header.contextOverflow, false, headerDiagnostic);
      assert.ok(header.search.width > 0 && header.search.left >= 0 && header.search.right <= header.width, headerDiagnostic);
      for (const name of ["titleGroups", "contextGroups", "toolbarGroups"]) for (let index = 1; index < header[name].length; index++) assert.ok(header[name][index - 1].right <= header[name][index].left + 1, headerDiagnostic);
      await evaluate("fixture.open()");
      const geometry = await evaluate("fixture.geometry()"), diagnostic = JSON.stringify({ scenario, ...geometry });
      assert.equal(geometry.open, true, diagnostic); assert.equal(geometry.role, "dialog", diagnostic);
      assert.ok(geometry.menu.left >= 0 && geometry.menu.right <= geometry.width + 1 && geometry.menu.top >= 0 && geometry.menu.bottom <= geometry.height + 1, diagnostic);
      assert.ok(geometry.menu.height <= 481, `Repository switcher must remain compact on tall windows: ${diagnostic}`);
      if (geometry.height >= header.search.bottom + 8 + geometry.menu.height + 12) {
        assert.ok(geometry.menu.top >= header.search.bottom + 7, `Repository switcher must not cover its own trigger when it fits below: ${diagnostic}`);
      }
      assert.ok(geometry.input.left >= geometry.menu.left && geometry.input.right <= geometry.menu.right && geometry.input.height >= 24, diagnostic);
      assert.equal(geometry.menuOverflow, false, diagnostic); assert.equal(geometry.listOverflow, false, diagnostic);
      assert.equal(geometry.rows.length, 50, diagnostic); assert.ok(geometry.listHeight > 0 && geometry.listScrollHeight > geometry.listHeight, diagnostic); assert.match(geometry.listOverflowY, /auto|scroll/, diagnostic);
      for (const row of geometry.rows) assert.ok(row.left >= geometry.menu.left && row.right <= geometry.menu.right + 1, diagnostic);
      assert.equal(geometry.unsafeNodes, 0); assert.equal(geometry.injected, false);
      const scrolled = await evaluate(`(async () => { const list = document.querySelector('#repository-tab-search-results'); list.scrollTop = list.scrollHeight; await fixture.frames(); const last = fixture.rows().at(-1).getBoundingClientRect(), bounds = list.getBoundingClientRect(); return { top:list.scrollTop, lastTop:last.top, lastBottom:last.bottom, listTop:bounds.top, listBottom:bounds.bottom }; })()`);
      assert.ok(scrolled.top > 0 && scrolled.lastTop >= scrolled.listTop - 1 && scrolled.lastBottom <= scrolled.listBottom + 1, JSON.stringify({ scenario, scrolled }));
      result.layoutScenarios++;
      if (process.env.ARGUS_TAB_SEARCH_CAPTURE === "1" && [1440, 380].includes(width) && font === "comic-sans" && enabled) {
        await evaluate("document.querySelector('#repository-tab-search-results').scrollTop = 0; new Promise(resolve => setTimeout(resolve, 75));");
        await fs.writeFile(path.join(temporary, `repository-search-${width}-${zoom}x-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      }
    }
  }
  result.statePreserved = await evaluate("fixture.preserved()"); result.writeCount = await evaluate("fixture.writeCount"); result.unexpectedNetworkCount = unexpectedNetworkCount;
  assert.equal(result.statePreserved, true); assert.equal(result.writeCount, 0); assert.equal(result.unexpectedNetworkCount, 0); assert.deepEqual(await evaluate("fixture.errors"), []);
  await evaluate("fixture.search.dispose(); fixture.ports.dispose();");
  console.log("REPOSITORY_SEARCH_RESULT=" + JSON.stringify(result)); finish(0);
}).catch(error => { console.error(error); finish(1); });
