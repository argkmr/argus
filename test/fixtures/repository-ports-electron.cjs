// Isolated renderer; no real application, services, network or repository writes.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-ports-layout-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const timer = setTimeout(() => { console.error("Port layout timed out"); app.exit(1); }, 30_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
app.whenReady().then(async () => {
  const styles = (await Promise.all(["styles.css", "repository-ide-shell.css", "repository-ports.css", "repository-ide.css", "repository-context-bar.css"].map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = (await fs.readFile(path.join(root, "public/index.html"), "utf8"))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${styles}</style>`);
  const isolated = session.fromPartition("ports-layout-regression", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  await window.webContents.executeJavaScript((await fs.readFile(path.join(root, "public/repository-ports.mjs"), "utf8")).replace(/^export /gm, ""));
  await window.webContents.executeJavaScript(`
    document.body.dataset.view = "repository";
    document.body.classList.add("task-context-visible");
    document.querySelector("#workspace").classList.remove("hidden");
    document.querySelector("#context-repo").textContent = "reviewrating";
    document.querySelector("#context-branch").textContent = "feature/port-layout-with-a-long-branch-name";
    document.querySelector("#repository-chat-toggle").setAttribute("aria-label", "Hide AI chat");
    document.querySelector("#repository-chat-toggle").setAttribute("aria-pressed", "true");
    const configuration = { id: "review", repositoryId: "repo", name: "Review rating", port: 8083, managementPort: 10106 };
    const details = { configurationId: "review", repositoryId: "repo", applicationPort: 8083, managementPort: 10106, configFile: "web-service/src/main/resources/application.yml", contentHash: "synthetic", editable: true };
    const other = { id: "other", repositoryId: "other-repo", name: "Ticket management", port: 8082, managementPort: 10105 };
    const inventory = { checkedAt: new Date().toISOString(), available: true, listeners: [{ port: 8083, host: "*", pid: 123, command: "java", configurationId: "review", repositoryId: "repo" }, { port: 8083, host: "::1", pid: 123, command: "java", configurationId: "review", repositoryId: "repo" }, { port: 3000, host: "127.0.0.1", pid: 124, command: "node" }, { port: 9090, host: "127.0.0.1", pid: 125, command: "Postman" }, { port: 2375, host: "127.0.0.1", pid: 126, command: "Docker" }], configurations: [configuration, other] };
    window.fixtureCalls = [];
    window.fixtureInventoryMode = "available";
    window.fixtureWriteCount = 0;
    window.ports = createRepositoryPorts({ host: document.querySelector("#repository-ports"), document, api: async (route, options) => {
      window.fixtureCalls.push(route); if (options?.method === "POST") { window.fixtureWriteCount++; throw new Error("No writes permitted"); }
      if (route !== "/api/runtime-ports") return details;
      if (window.fixtureInventoryMode === "failed") throw new Error("Listener scan unavailable in isolated fixture");
      return window.fixtureInventoryMode === "unavailable" ? { ...inventory, available: false, listeners: [] } : inventory;
    }});
    window.ports.setContext({ repository: { id: "repo", name: "Review rating" }, configurations: [configuration, other], selectedConfigurationId: "review", processes: [], visible: true });
  `);
  let scenarios = 0;
  for (const width of [1440, 1050, 820, 640, 500, 380]) for (const theme of ["dark", "light"]) {
    window.setContentSize(width, 760);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => Math.abs(innerWidth - ${width}) <= 1 ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : ++attempts < 100 ? setTimeout(check, 10) : reject(new Error("Resize did not settle")); check();
    })`);
    const result = await window.webContents.executeJavaScript(`(async () => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      if (ports.state.opened) document.querySelector('[aria-label="Close local ports"]').click();
      document.querySelector(".repository-ports-trigger").click();
      for (let attempt = 0; !ports.state.opened && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      await ports.refresh();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      const header = document.querySelector(".context-strip"), trigger = document.querySelector(".repository-ports-trigger"), panel = document.querySelector(".repository-ports-panel");
      const input = panel.querySelector("input"), save = panel.querySelector(".repository-ports-save"), current = panel.querySelector(".repository-ports-current");
      const chevron = trigger.querySelector("svg.disclosure-chevron"), chevronStyle = getComputedStyle(chevron);
      return { width: innerWidth, height: innerHeight, header:rect(header), trigger:rect(trigger), portLabel:rect(trigger.querySelector(".repository-ports-trigger-port")), stateLabel:rect(trigger.querySelector(".repository-ports-trigger-state")), chevron:rect(chevron), chevronStyle:{ display:chevronStyle.display, fill:chevronStyle.fill, strokeWidth:chevronStyle.strokeWidth, transform:chevronStyle.transform }, panel:rect(panel), panelPosition:getComputedStyle(panel).position, actions:rect(document.querySelector(".repository-context-actions")), label:trigger.textContent, subtitle:trigger.querySelector(".repository-ports-trigger-state").textContent, inputVisible:input.checkVisibility(), saveVisible:save.checkVisibility(), input:rect(input), save:rect(save), current:rect(current), editorInCurrent:current.contains(input) && current.contains(save), disclosureCount:panel.querySelectorAll("details, .repository-ports-edit-toggle").length, rows:[...panel.querySelectorAll(".repository-ports-row")].map(row => ({ port:row.querySelector(".repository-ports-row-port").textContent, text:row.innerText, rect:rect(row) })), visibleText:panel.innerText, bodyOverflow:document.documentElement.scrollWidth > innerWidth + 1, panelOverflow:panel.scrollWidth > panel.clientWidth + 1 };
    })()`);
    assert.ok(result.trigger.width >= 80, JSON.stringify(result));
    assert.ok(result.trigger.left >= result.header.left && result.trigger.right <= result.actions.left + 1, JSON.stringify(result));
    assert.ok(result.portLabel.left >= result.trigger.left && result.portLabel.right <= result.trigger.right, JSON.stringify(result));
    assert.equal(result.chevron.width, 14); assert.equal(result.chevron.height, 14);
    assert.ok(Math.abs((result.chevron.top + result.chevron.bottom) - (result.trigger.top + result.trigger.bottom)) <= 1, JSON.stringify(result));
    assert.ok(result.chevron.left >= result.portLabel.right + 4 && result.chevron.right <= result.trigger.right, JSON.stringify(result));
    assert.equal(result.chevronStyle.display, "block"); assert.equal(result.chevronStyle.fill, "none"); assert.equal(result.chevronStyle.strokeWidth, "1.8px");
    assert.equal(result.chevronStyle.transform, "matrix(-1, 0, 0, -1, 0, 0)");
    assert.ok(result.actions.right <= result.width + 1, JSON.stringify(result));
    assert.ok(result.panel.width >= 200 && result.panel.width <= 361 && result.panel.height >= 100 && result.panel.height < 580, JSON.stringify(result));
    assert.ok(result.panel.left >= 0 && result.panel.right <= result.width && result.panel.bottom <= result.height, JSON.stringify(result));
    assert.equal(result.panelPosition, "fixed", JSON.stringify(result));
    assert.equal(result.stateLabel.height, 0, "The repeated Service port subtitle should not consume a second row");
    assert.equal(result.header.height, 38, JSON.stringify(result));
    assert.equal(result.bodyOverflow, false, JSON.stringify(result));
    assert.equal(result.panelOverflow, false, JSON.stringify(result));
    assert.match(result.label, /localhost:8083/); assert.equal(result.subtitle, "Service port");
    assert.equal(result.inputVisible, true); assert.equal(result.saveVisible, true); assert.equal(result.editorInCurrent, true);
    assert.equal(result.disclosureCount, 0); assert.equal(result.rows.length, 4);
    assert.ok(Math.abs(result.input.top - result.save.top) <= 1, JSON.stringify(result));
    assert.ok(result.input.right <= result.save.left && result.save.right <= result.current.right, JSON.stringify(result));
    assert.ok(result.current.height < 230, JSON.stringify(result));
    assert.match(result.visibleText, /Argus service ports/); assert.match(result.visibleText, /Application port/); assert.match(result.visibleText, /Save port/);
    assert.deepEqual(result.rows.map(row => Number(row.port.replace(/[^0-9]/g, ""))).sort((a, b) => a - b), [8082, 8083, 10105, 10106]);
    for (const row of result.rows) {
      const management = /10105|10106/.test(row.port), review = /8083|10106/.test(row.port);
      assert.match(row.text, review ? /Review rating/ : /Ticket management/);
      assert.match(row.text, /8083/.test(row.port) ? /Listening/i : /Configured/i);
      if (management) assert.match(row.text, /Management/);
      else assert.doesNotMatch(row.text, /Management/);
      assert.ok(row.rect.left >= result.panel.left && row.rect.right <= result.panel.right && row.rect.bottom <= result.panel.bottom, JSON.stringify(result));
    }
    assert.doesNotMatch(result.visibleText, /\bnode\b|Postman|Docker|:3000|:9090|:2375|PID|127\.0\.0\.1|::1|Change port/);
    if (process.env.ARGUS_PORTS_CAPTURE === "1" && [1440, 640, 380].includes(width)) await fs.writeFile(path.join(temporary, `ports-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
    scenarios++;
  }
  let fallbackScenarios = 0;
  for (const mode of ["unavailable", "failed"]) for (const theme of ["dark", "light"]) {
    const result = await window.webContents.executeJavaScript(`(async () => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      window.fixtureInventoryMode = ${JSON.stringify(mode)};
      await ports.refresh();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const panel = document.querySelector(".repository-ports-panel"), box = panel.getBoundingClientRect();
      return { width:innerWidth, height:innerHeight, right:box.right, bottom:box.bottom, rows:[...panel.querySelectorAll(".repository-ports-row")].map(row => row.innerText), text:panel.innerText, inputVisible:panel.querySelector("input").checkVisibility(), overflow:panel.scrollWidth > panel.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1 };
    })()`);
    assert.equal(result.width, 380); assert.equal(result.rows.length, 4); assert.equal(result.inputVisible, true);
    for (const port of [8082, 8083, 10105, 10106]) assert.ok(result.rows.some(row => row.includes(String(port))), JSON.stringify(result));
    for (const row of result.rows) assert.match(row, /Configured/i);
    assert.doesNotMatch(result.rows.join("\n"), /Listening|\bnode\b|Postman|Docker/);
    assert.ok(result.right <= result.width && result.bottom <= result.height, JSON.stringify(result));
    assert.equal(result.overflow, false, JSON.stringify(result));
    if (process.env.ARGUS_PORTS_CAPTURE === "1") await fs.writeFile(path.join(temporary, `ports-${theme}-380-${mode}.png`), (await window.webContents.capturePage()).toPNG());
    fallbackScenarios++;
  }
  const hidden = await window.webContents.executeJavaScript(`ports.setContext({ visible:false }); ({ host:document.querySelector("#repository-ports").getClientRects().length, panel:document.querySelector(".repository-ports-panel").getClientRects().length })`);
  assert.deepEqual(hidden, { host:0, panel:0 });
  const writeCount = await window.webContents.executeJavaScript("window.fixtureWriteCount");
  assert.equal(writeCount, 0);
  console.log("PORTS_LAYOUT_RESULT=" + JSON.stringify({ ok:true, scenarios, fallbackScenarios, writeCount })); finish(0);
}).catch(error => { console.error(error); finish(1); });
