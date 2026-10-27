// Actual application functions and CSS in an isolated renderer. All reads are
// deferred in-memory fakes; no real workspace, processes, services, or writes.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-services-loading-")) throw new Error("An isolated test directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, unexpectedNetworkCount = 0;
const timer = setTimeout(() => { console.error("Services renderer test timed out"); app.exit(1); }, 35_000);
const finish = code => { clearTimeout(timer); window?.destroy(); app.exit(code); };
function sourceFunction(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Missing application function: ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
const expectedOrder = ["repository:fresh", "configuration:web", "configuration:api"];
function assertCards(snapshot, expected = expectedOrder) {
  assert.deepEqual(snapshot.keys, expected, JSON.stringify(snapshot));
  assert.equal(snapshot.visible, true, JSON.stringify(snapshot));
  assert.equal(snapshot.skeletonCount, 0, JSON.stringify(snapshot));
}
function assertGeometry(result) {
  assert.equal(result.bodyOverflow, false, JSON.stringify(result));
  assert.equal(result.drawerOverflow, false, JSON.stringify(result));
  assert.ok(result.drawer.left >= 0 && result.drawer.right <= result.width + 1, JSON.stringify(result));
  for (const card of result.cards) {
    assert.ok(card.bounds.width > 200 && card.bounds.left >= result.drawer.left && card.bounds.right <= result.drawer.right + 1, JSON.stringify(result));
    assert.equal(card.overflow, false, JSON.stringify(result));
    if (card.bounds.top < result.height - 40) assert.equal(card.uncovered, true, JSON.stringify(result));
    for (const button of card.buttons) assert.ok(button.left >= card.bounds.left && button.right <= card.bounds.right + 1, JSON.stringify(result));
  }
}
app.whenReady().then(async () => {
  const sourceShell = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const stylesheets = [...sourceShell.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(stylesheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const shell = sourceShell
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${styles}</style>`);
  const isolated = session.fromPartition("services-loading-regression", { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { unexpectedNetworkCount++; callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
  const source = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  const functions = ["launchWorkspaceTool", "switchPrimaryView", "runtimeDetectionKey", "syncServicesRefreshState", "refreshRuntimeDetections", "refreshProcesses", "acceptServiceProcesses", "renderServices", "syncServicePendingControls", "activeServiceProcesses", "syncStopAllServicesControl", "setTextIfChanged", "setRefreshLoading", "escapeHtml"].map(name => sourceFunction(source, name)).join("\n");
  await window.webContents.executeJavaScript((await fs.readFile(path.join(root, "public/service-card-order.mjs"), "utf8")).replace(/^export /gm, ""));
  await window.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
    let state, serviceCardOrder, serviceProcessRevision = 0;
    const serviceOperations = new Map();
    const projectSyncLifecycle = { observe() {} }, repositoryIdeBridge = { sync() {} };
    const closeOpenDialogs = () => true, setWorkspaceToolsOpen = () => {}, setVersionControlDockOpen = () => {};
    const syncRepositoryTabSelection = () => {}, syncWorkspaceRail = () => {}, syncViewUrl = () => {}, syncIdeRunControls = () => {};
    const toast = message => fixture.messages.push(message);
    const fixture = window.fixture = { calls: [], pending: [], messages: [], writeCount: 0 };
    const api = (route, options = {}) => {
      fixture.calls.push(route);
      if (options.method && options.method !== "GET") { fixture.writeCount++; throw new Error("Writes are forbidden in this fixture"); }
      if (!["/api/processes", "/api/runtime-detections"].includes(route)) throw new Error("Unexpected API: " + route);
      return new Promise((resolve, reject) => fixture.pending.push({ route, resolve, reject }));
    };
    ${functions}
    const repositories = [
      { id: "api-repo", name: "Review rating", path: "/synthetic/reviewrating" },
      { id: "web-repo", name: "A very long customer-facing Next.js application repository", path: "/synthetic/nextjs-web" },
      { id: "fresh", name: "Fresh project with no saved run configuration", path: "/synthetic/fresh" }
    ];
    const runConfigurations = [
      { id: "api", repositoryId: "api-repo", name: "Review rating", executable: "./mvnw", args: ["spring-boot:run"], port: 8083, managementPort: 10106, environmentKeys: ["EXAMPLE"] },
      { id: "web", repositoryId: "web-repo", name: "A very long customer-facing Next.js application repository", executable: "npm", args: ["run", "dev", "--", "--port", "3001"], runtimeType: "ui", packageManager: "npm", port: 3001 }
    ];
    const savedOrder = [{ key: "repository:fresh", repositoryId: "fresh" }, { key: "configuration:web", repositoryId: "web-repo" }, { key: "configuration:api", repositoryId: "api-repo" }];
    fixture.nextProcesses = [{ id: "new-api-process", configurationId: "api", running: true, status: "running", startedAt: "2026-09-20T10:00:00Z" }];
    fixture.detections = [{ repositoryId: "fresh", detected: true, executable: "node", args: ["app.js"], runtimeType: "service", port: 8088 }];
    fixture.reset = kind => {
      if (fixture.pending.length) throw new Error("Unsettled reads before reset");
      serviceCardOrder?.destroy(); serviceOperations.clear(); serviceProcessRevision = 0;
      fixture.calls = []; fixture.messages = [];
      const workspace = kind === "empty" ? { repositories: [], runConfigurations: [], preferences: {} }
        : kind === "fresh" ? { repositories: [repositories[2]], runConfigurations: [], preferences: { serviceCardOrder: [savedOrder[0]] } }
        : { repositories, runConfigurations, preferences: { serviceCardOrder: savedOrder } };
      state = { workspace, activeRepository: workspace.repositories[0], currentView: "repository", detectedRuntimes: [], runtimeDetectionPromise: null, runtimeDetectionLoadedKey: "", runtimeDetectionCheckedAt: 0, processRefreshPromise: null, serviceRefreshVisible: false,
        processes: kind === "configured" ? [{ id: "cached-web-process", configurationId: "web", running: true, status: "running", startedAt: "2026-09-20T09:00:00Z" }] : [], serviceProcessSignature: kind === "configured" ? "cached" : undefined };
      $("#service-list").replaceChildren(); $("#services-drawer").scrollTop = 0;
      serviceCardOrder = createServiceCardOrder({ list: $("#service-list"), scrollContainer: $("#services-drawer"), save: async order => { state.workspace.preferences.serviceCardOrder = order; }, onChange: () => renderServices(), onSettled: () => renderServices() });
      document.body.classList.add("task-context-visible"); $("#workspace").classList.remove("hidden"); $("#empty-state").classList.add("hidden");
      switchPrimaryView("repository");
    };
    fixture.snapshot = () => ({
      keys: $$("#service-list [data-service-card]").map(card => card.dataset.serviceCard),
      states: Object.fromEntries($$("#service-list [data-service-card]").map(card => [card.dataset.serviceCard, card.querySelector(".service-state").textContent])),
      visible: $("#services-drawer").checkVisibility(), skeletonCount: $("#service-list").querySelectorAll('[class*="skeleton"]').length,
      detectionsPending: Boolean(state.runtimeDetectionPromise), processesPending: Boolean(state.processRefreshPromise), text: $("#service-list").innerText
    });
    fixture.open = () => { fixture.openStartedAt = performance.now(); launchWorkspaceTool(() => switchPrimaryView("services")); return { ...fixture.snapshot(), synchronousCardsMs: performance.now() - fixture.openStartedAt }; };
    fixture.frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fixture.reply = async (route, value) => {
      const item = fixture.pending.find(entry => entry.route === route);
      if (!item) throw new Error("No pending read for " + route);
      fixture.pending.splice(fixture.pending.indexOf(item), 1);
      const promise = route === "/api/processes" ? state.processRefreshPromise : state.runtimeDetectionPromise;
      const startedAt = performance.now();
      item.resolve(value); await promise;
      const liveProcessAppliedMs = performance.now() - startedAt;
      await fixture.frames();
      return { ...fixture.snapshot(), liveProcessAppliedMs };
    };
    fixture.geometry = () => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      return { width: innerWidth, height: innerHeight, drawer: rect($("#services-drawer")), bodyOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        drawerOverflow: $("#services-drawer").scrollWidth > $("#services-drawer").clientWidth + 1,
        cards: $$("#service-list [data-service-card]").map(card => ({ bounds: rect(card), overflow: card.scrollWidth > card.clientWidth + 1,
          uncovered: card.contains(document.elementFromPoint(card.getBoundingClientRect().left + 30, card.getBoundingClientRect().top + 30)),
          outside: [...card.querySelectorAll("*")].filter(child => child.getBoundingClientRect().right > card.getBoundingClientRect().right + 1).map(child => ({ tag: child.tagName, className: child.className, text: child.textContent.slice(0, 100), bounds: rect(child) })),
          buttons: [...card.querySelectorAll("button")].map(rect) })) };
    };
    void 0;
  `);
  async function resize(width, theme) {
    window.setContentSize(width, 900);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      let attempts = 0;
      const check = () => Math.abs(innerWidth - ${width}) <= 1 ? fixture.frames().then(resolve) : ++attempts < 100 ? setTimeout(check, 10) : reject(new Error("Resize did not settle")); check();
    })`);
  }
  let configuredScenarios = 0;
  const timingSamples = [];
  for (const width of [1440, 820, 500, 380]) for (const theme of ["dark", "light"]) {
    await resize(width, theme);
    // This return is synchronous: neither process status nor discovery can have resolved.
    const immediate = await window.webContents.executeJavaScript(`fixture.reset("configured"); fixture.open()`);
    assertCards(immediate); assert.equal(immediate.states["configuration:web"], "running");
    assert.equal(immediate.processesPending, true); assert.equal(immediate.detectionsPending, true);
    const painted = await window.webContents.executeJavaScript(`(async () => { await fixture.frames(); return { snapshot: fixture.snapshot(), geometry: fixture.geometry(), calls: fixture.calls, twoFrameReadyMs: performance.now() - fixture.openStartedAt, enabled: !document.querySelector('[data-configure-service="api"]').disabled }; })()`);
    if (process.env.ARGUS_SERVICES_CAPTURE === "1" && [1440, 380].includes(width)) {
      // Hidden Electron windows can return an older compositor frame. The
      // synchronous/two-frame assertions above still run without this delay.
      await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 100))");
      await fs.writeFile(path.join(temporary, `services-${theme}-${width}-loading.png`), (await window.webContents.capturePage()).toPNG());
    }
    assertCards(painted.snapshot); assertGeometry(painted.geometry); assert.equal(painted.enabled, true);
    assert.deepEqual(painted.calls.slice().sort(), ["/api/processes", "/api/runtime-detections"]);
    const live = await window.webContents.executeJavaScript(`fixture.reply("/api/processes", fixture.nextProcesses)`);
    assertCards(live); assert.equal(live.detectionsPending, true);
    assert.equal(live.states["configuration:api"], "running"); assert.equal(live.states["configuration:web"], "stopped");
    timingSamples.push({ synchronousCardsMs: immediate.synchronousCardsMs, twoFrameReadyMs: painted.twoFrameReadyMs, liveProcessAppliedMs: live.liveProcessAppliedMs });
    const reopened = await window.webContents.executeJavaScript(`(async () => {
      const first = document.querySelector("[data-service-card]");
      switchPrimaryView("repository"); fixture.open(); void refreshProcesses(true); await fixture.frames();
      return { snapshot: fixture.snapshot(), sameCard: first === document.querySelector("[data-service-card]"), calls: fixture.calls };
    })()`);
    assertCards(reopened.snapshot); assert.equal(reopened.sameCard, true);
    assert.equal(reopened.calls.filter(route => route === "/api/runtime-detections").length, 1);
    await window.webContents.executeJavaScript(`fixture.reply("/api/processes", fixture.nextProcesses)`);
    const enriched = await window.webContents.executeJavaScript(`fixture.reply("/api/runtime-detections", fixture.detections)`);
    assertCards(enriched); assert.equal(enriched.states["configuration:api"], "running"); assert.equal(enriched.detectionsPending, false);
    assert.match(enriched.text, /node app\.js/); assert.match(enriched.text, /8088/);
    assertGeometry(await window.webContents.executeJavaScript("fixture.geometry()"));
    if (process.env.ARGUS_SERVICES_CAPTURE === "1" && [1440, 380].includes(width)) await fs.writeFile(path.join(temporary, `services-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
    configuredScenarios++;
  }
  let boundaryScenarios = 0;
  for (const kind of ["fresh", "empty", "cold"]) for (const width of [1440, 380]) for (const theme of ["dark", "light"]) {
    await resize(width, theme);
    const immediate = await window.webContents.executeJavaScript(`fixture.reset(${JSON.stringify(kind)}); fixture.open()`);
    const expected = kind === "empty" ? [] : kind === "fresh" ? ["repository:fresh"] : expectedOrder;
    assertCards(immediate, expected);
    if (kind === "empty") assert.match(immediate.text, /No repositories are connected yet/);
    else { assert.match(immediate.text, /Configure this repository/); assert.match(immediate.text, /Configure/); }
    if (kind === "cold") {
      assert.equal(immediate.states["configuration:api"], "Checking…"); assert.equal(immediate.states["configuration:web"], "Checking…");
      assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-service-action], [data-service-debug], [data-service-maintenance]')].every(button => button.disabled)`), true);
    }
    await window.webContents.executeJavaScript("fixture.frames()");
    assertGeometry(await window.webContents.executeJavaScript("fixture.geometry()"));
    if (kind === "fresh") {
      // Discovery can finish first, but must not enable launch while process
      // status is unknown (the service may already be running).
      const discovered = await window.webContents.executeJavaScript(`fixture.reply("/api/runtime-detections", fixture.detections)`);
      assertCards(discovered, expected); assert.match(discovered.text, /node app\.js/);
      assert.equal(discovered.processesPending, true);
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-start-detected-runtime="fresh"]').disabled`), true);
    }
    const status = await window.webContents.executeJavaScript(`fixture.reply("/api/processes", [])`);
    assertCards(status, expected);
    if (kind === "fresh") assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-start-detected-runtime="fresh"]').disabled`), false);
    else if (kind === "cold") {
      assert.equal(status.states["configuration:api"], "stopped"); assert.equal(status.detectionsPending, true);
      assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-service-action], [data-service-debug], [data-service-maintenance]')].every(button => !button.disabled)`), true);
      assertCards(await window.webContents.executeJavaScript(`fixture.reply("/api/runtime-detections", fixture.detections)`), expected);
    } else {
      const calls = await window.webContents.executeJavaScript("fixture.calls");
      assert.deepEqual(calls, ["/api/processes"]);
    }
    boundaryScenarios++;
  }
  const writeCount = await window.webContents.executeJavaScript("fixture.writeCount");
  assert.equal(writeCount, 0); assert.equal(unexpectedNetworkCount, 0);
  const maximum = key => Math.round(Math.max(...timingSamples.map(sample => sample[key])) * 100) / 100;
  const timings = { samples: timingSamples.length, synchronousCardsMaxMs: maximum("synchronousCardsMs"), twoFrameReadyMaxMs: maximum("twoFrameReadyMs"), liveProcessAppliedMaxMs: maximum("liveProcessAppliedMs") };
  console.log("SERVICES_LOADING_RESULT=" + JSON.stringify({ ok: true, configuredScenarios, boundaryScenarios, writeCount, unexpectedNetworkCount, timings }));
  finish(0);
}).catch(error => { console.error(error); finish(1); });
