// Production chat rendering and styles in an isolated profile. No saved chats,
// repositories, application bootstrap, backend, clipboard, or AI is accessed.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const temporary = process.argv[2];
if (!temporary || !path.isAbsolute(temporary) || !path.basename(temporary).startsWith("argus-chat-stability-366-")) throw new Error("An isolated fixture directory is required");
const root = path.resolve(__dirname, "../..");
for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(temporary, name));
app.commandLine.appendSwitch("disable-background-networking");
let window, server, blockedRequests = 0;
const timer = setTimeout(() => finish(new Error("Chat stability fixture timed out")), 50_000);
function finish(error, result) {
  clearTimeout(timer);
  if (error) console.error(error.stack || error);
  else console.log("CHAT_STABILITY_366=" + JSON.stringify(result));
  window?.destroy(); server?.closeAllConnections(); server?.close(); app.exit(error ? 1 : 0);
}
function sourceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
async function initialize() {
  const { createChatContentRenderer } = await import("/legacy/chat-content-renderer.mjs");
  const { createStableHtmlRenderer } = await import("/legacy/stable-html-renderer.mjs");
  const { renderChatMessage } = await import("/legacy/message-renderer.js");
  const { initializeMermaidRendering } = await import("/legacy/mermaid-renderer.js");
  const $ = selector => document.querySelector(selector);
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = async predicate => { const deadline = performance.now() + 2000; while (!predicate()) { if (performance.now() > deadline) throw new Error("Synthetic diagram did not settle"); await frame(); } };
  let diagramCalls = 0;
  initializeMermaidRendering(document, { render:async () => { diagramCalls++; return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60"><rect width="240" height="60" fill="#425263"/><text x="12" y="35" fill="white">Synthetic local diagram</text></svg>'; } });
  const render = createChatContentRenderer(renderChatMessage);
  const selected = () => { const value = getSelection(); return { anchor:value.anchorNode, focus:value.focusNode, start:value.anchorOffset, end:value.focusOffset, text:value.toString() }; };
  const select = (node, start, end) => { const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selected(); };
  const sameSelection = before => { const after = selected(); return before.anchor === after.anchor && before.focus === after.focus && before.start === after.start && before.end === after.end && before.text === after.text; };
  const source = [
    "Keep this selected text while the live answer grows.", "",
    "```js", "const stable = true;", "```", "",
    "| Name | State |", "| --- | --- |", "| First | Ready |", "",
    "```mermaid", "flowchart LR", "A-->B", "```", "",
    ...Array.from({ length:45 }, (_, index) => `Completed paragraph ${index + 1} remains readable while more output arrives.\n`),
    "Growing response",
  ].join("\n");
  const observerOptions = { childList:true, subtree:true, characterData:true, attributes:true };
  window.runChatStability = async ({ view, theme }) => {
    document.documentElement.dataset.theme = theme;
    const global = view === "nexus", ide = view === "ide";
    document.body.dataset.view = global ? "global" : "repository";
    document.body.classList.toggle("repository-ide-enabled", ide);
    $("#global-codex-panel").classList.toggle("hidden", !global);
    $("#workspace").classList.toggle("hidden", global);
    $(".global-codex-layout").classList.add("task-panel-collapsed");
    $(".ai-canvas").classList.add("task-panel-collapsed");
    $("#repository-ide-host").hidden = !ide;
    $("#repository-ide-host").textContent = "Synthetic editor · no repository or language server opened";
    $("#repository-workbench").style.setProperty("--ide-editor-height", "180px");
    const prefix = global ? "global-agent" : "agent", target = $("#" + prefix + "-output");
    const conversation = $("#" + prefix + "-conversation");
    conversation.replaceChildren(); conversation.classList.remove("is-empty");
    $("#" + prefix + "-output-card").classList.remove("hidden");
    const scroller = target.closest(".chat-scroll-region");
    target.replaceChildren(); render(target, source); await wait(() => target.querySelector(".chat-diagram-image")); await frame();
    ensure(scroller.clientHeight > 60 && scroller.scrollHeight > scroller.clientHeight + 300, "Production chat scroller must be visible and overflow");
    const paragraph = target.querySelector(".chat-paragraph"), text = paragraph.firstChild;
    const code = target.querySelector(".chat-code-block:not(.chat-mermaid-block)"), codeText = code.querySelector("code").firstChild;
    const table = target.querySelector(".chat-table-scroll"), row = table.querySelector("tbody tr");
    const diagram = target.querySelector(".chat-mermaid-block"), diagramFrame = diagram.querySelector(".chat-diagram-image"), toggle = diagram.querySelector("[data-toggle-mermaid-source]");
    toggle.click(); ensure(!diagram.querySelector("pre").hidden, "Production diagram source toggle must open");
    const focused = code.querySelector("button"); focused.focus({ preventScroll:true });
    const selection = select(text, 5, 23);
    scroller.scrollTop = 180; await frame();
    const top = scroller.scrollTop;
    let mutationCount = 0, removed = [];
    const observer = new MutationObserver(records => { mutationCount += records.length; for (const record of records) removed.push(...record.removedNodes); });
    observer.observe(target, observerOptions);
    for (let index = 0; index < 20; index++) ensure(render(target, source) === false, "Identical content must be a no-op");
    await frame(); ensure(mutationCount === 0, "Metadata-only polls mutated rendered content");
    let current = source;
    for (let index = 0; index < 12; index++) {
      const snapshot = captureLiveScroll(scroller);
      current += ` ${index + 1}`; render(target, current); restoreLiveScroll(scroller, snapshot);
      await frame();
      ensure(target.querySelector(".chat-paragraph") === paragraph && paragraph.firstChild === text, "Streaming append replaced completed paragraph/text");
      ensure(target.querySelector(".chat-code-block:not(.chat-mermaid-block)") === code && code.querySelector("code").firstChild === codeText, "Streaming append replaced completed code");
      ensure(target.querySelector(".chat-table-scroll") === table && table.querySelector("tbody tr") === row, "Streaming append replaced completed table");
      ensure(target.querySelector(".chat-mermaid-block") === diagram && diagram.querySelector(".chat-diagram-image") === diagramFrame, "Streaming append replaced enhanced Mermaid DOM");
      ensure(toggle.getAttribute("aria-pressed") === "true" && !diagram.querySelector("pre").hidden, "Streaming append reset diagram source toggle");
      ensure(document.activeElement === focused, "Streaming append lost focused code control");
      ensure(sameSelection(selection), "Streaming append lost an earlier text selection");
      ensure(Math.abs(scroller.scrollTop - top) <= 1, "Streaming append moved a reader away from their position");
    }
    ensure(!removed.some(node => [paragraph, code, table, diagram].includes(node)), "Completed blocks were removed during streaming");
    const tail = target.lastElementChild, tailText = tail.firstChild, tailSelection = select(tailText, 0, 7);
    render(target, current + " grows safely"); await frame();
    ensure(target.lastElementChild === tail && tail.firstChild === tailText, "Growing paragraph/text node was replaced");
    ensure(sameSelection(tailSelection), "Appending text reset selection offsets in the growing paragraph");
    current += " grows safely";
    render(target, current + "\n\nNew final paragraph."); await frame();
    ensure(target.contains(tail) && target.querySelector(".chat-diagram-image") === diagramFrame, "New final paragraph replaced preceding content");
    ensure(target.lastElementChild.textContent === "New final paragraph.", "Final paragraph content was not rendered");
    observer.disconnect(); getSelection().removeAllRanges();
    // Live-edge tracking uses the same production snapshot/restore functions.
    scroller.scrollTop = scroller.scrollHeight;
    const bottomSnapshot = captureLiveScroll(scroller);
    render(target, current + "\n\nNew final paragraph.\n\nAdditional live output."); restoreLiveScroll(scroller, bottomSnapshot); await frame();
    ensure(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1, "Reader following live output did not remain at its edge");
    return { view, theme, metadataMutations:0, appendUpdates:12, preservedDiagram:true, selectionRetained:true, focusRetained:true, readingScrollRetained:true, liveEdgeRetained:true, scrollHeight:scroller.scrollHeight, viewportHeight:scroller.clientHeight };
  };
  window.runStructureStability = async () => {
    const target = document.createElement("div"); target.className = "chat-message-content"; document.body.append(target);
    render(target, "Stable prefix\n\n| Name | State |");
    const prefix = target.firstElementChild;
    render(target, "Stable prefix\n\n| Name | State |\n| --- | --- |\n| A | Ready |");
    ensure(target.firstElementChild === prefix && !!target.querySelector("table tbody tr"), "Table completion failed or replaced an earlier block");
    const table = target.querySelector("table"), row = table.querySelector("tbody tr");
    render(target, "Stable prefix\n\n| Name | State |\n| --- | --- |\n| A | Ready |\n| B | Ready |");
    ensure(target.querySelector("table") === table && table.querySelector("tbody tr") === row && table.rows.length === 3, "Growing table replaced existing rows");
    render(target, "Stable prefix\n\n```js\nconst value = 1;");
    const code = target.querySelector("code"), codeText = code.firstChild;
    render(target, "Stable prefix\n\n```js\nconst value = 1;\nconst next = 2;\n```");
    ensure(target.querySelector("code") === code && code.firstChild === codeText && code.textContent.includes("next = 2"), "Streaming code fence replaced its code/text nodes");
    render(target, "**Complete**\n\n- Safe list\n\n<script>unsafe()</script> [bad](javascript:evil())\n\n```html\n<img src=x onerror=evil()>\n```");
    ensure(target.querySelector("strong")?.textContent === "Complete" && target.querySelector("ul li")?.textContent === "Safe list", "Changed Markdown structure is incorrect");
    ensure(!target.querySelector("script,img,[onerror],a[href^='javascript:']"), "Incremental rendering introduced unsafe markup");
    render(target, "```mermaid\nflowchart LR\nA-->B\n```"); await wait(() => target.querySelector(".chat-diagram-image"));
    const oldDiagram = target.querySelector(".chat-mermaid-block"), oldFrame = oldDiagram.querySelector("iframe");
    render(target, "```mermaid\nflowchart LR\nA-->C\n```"); await wait(() => target.querySelector(".chat-diagram-image") !== oldFrame && target.querySelector(".chat-diagram-image"));
    ensure(target.querySelector(".chat-mermaid-block") !== oldDiagram && !oldFrame.isConnected, "Changed Mermaid source retained a stale enhanced diagram");
    const expected = "Canonical response"; render(target, expected); target.replaceChildren(document.createTextNode("External replacement")); render(target, expected);
    ensure(target.querySelector("p")?.textContent === expected, "External root replacement was not repaired");
    target.remove();
    const transcript = document.createElement("section"); transcript.className = "chat-thread"; document.body.append(transcript);
    const renderTranscript = createStableHtmlRenderer({ getKey:node => node.nodeType === 1 ? node.getAttribute("data-chat-render-key") : null, replaceChanged:node => node.classList?.contains("chat-mermaid-block") });
    const diagramMarkup = renderChatMessage("Same reply\n\n```mermaid\nflowchart LR\nA-->B\n```");
    const message = (id, status) => `<article data-chat-render-key="${id}" class="chat-message assistant"><div class="chat-message-body"><strong>${status}</strong><details><summary>Details</summary><button>Keep focus</button><p>Operational metadata</p></details><div class="chat-message-content">${diagramMarkup}</div></div></article>`;
    renderTranscript(transcript, '<p data-chat-render-key="loading">Loading historical messages</p>' + message("one", "Working") + message("two", "Working"));
    const first = transcript.querySelector('[data-chat-render-key="one"]'), second = transcript.lastElementChild, details = first.querySelector("details"), focus = details.querySelector("button");
    await wait(() => first.querySelector(".chat-diagram-image"));
    const savedDiagram = first.querySelector(".chat-mermaid-block"), savedFrame = savedDiagram.querySelector("iframe");
    const savedToggle = savedDiagram.querySelector("[data-toggle-mermaid-source]"); savedToggle.click();
    details.open = true; focus.focus({ preventScroll:true });
    const transcriptObserver = new MutationObserver(() => {}); transcriptObserver.observe(transcript, observerOptions);
    renderTranscript(transcript, message("one", "Done") + message("two", "Working") + message("three", "Working"));
    const bannerRemoval = transcriptObserver.takeRecords();
    ensure(transcript.firstElementChild === first && transcript.children[1] === second && details.open && document.activeElement === focus, "Transcript update reset keyed message state");
    ensure(!bannerRemoval.some(record => [...record.removedNodes].includes(first) || [...record.removedNodes].includes(second)), "Removing a preceding banner unnecessarily moved an unchanged article");
    ensure(first.querySelector(".chat-mermaid-block") === savedDiagram && savedDiagram.querySelector("iframe") === savedFrame && savedToggle.getAttribute("aria-pressed") === "true", "Saved article metadata update replaced its enhanced diagram/toggle state");
    renderTranscript(transcript, message("two", "Working") + message("one", "Done"));
    ensure(transcript.firstElementChild === second && transcript.lastElementChild === first && details.open, "Keyed reorder incorrectly matched identical message bodies");
    transcriptObserver.takeRecords(); focus.focus({ preventScroll:true });
    renderTranscript(transcript, message("one", "Done"));
    const precedingRemoval = transcriptObserver.takeRecords();
    ensure(transcript.firstElementChild === first && document.activeElement === focus && savedFrame.isConnected, "Removing the preceding article discarded retained focus/diagram");
    ensure(!precedingRemoval.some(record => [...record.removedNodes].includes(first)), "Removing a preceding article detached the retained article");
    transcriptObserver.disconnect();
    const observer = new MutationObserver(() => {}); observer.observe(transcript, observerOptions);
    ensure(renderTranscript(transcript, message("one", "Done")) === false && observer.takeRecords().length === 0, "Identical transcript created mutations"); observer.disconnect(); transcript.remove();
    return { safeStructureChanges:true, growingCodeRetained:true, growingTableRetained:true, changedDiagramReplaced:true, externalReplacementRecovered:true, keyedTranscriptRetained:true, precedingRemovalRetained:true, savedDiagramRetained:true, diagramCalls };
  };
}
app.whenReady().then(async () => {
  const source = await fs.readFile(path.join(root, "public/index.html"), "utf8");
  const sheets = [...source.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"?]+\.css)/g)].map(match => match[1]);
  const styles = (await Promise.all(sheets.map(file => fs.readFile(path.join(root, "public", file), "utf8")))).join("\n");
  const page = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "").replace("<head>", `<head><style>${styles}</style>`);
  const { createPreviewServer } = await import(pathToFileURL(path.join(__dirname, "ide-ux-preview.mjs")).href);
  server = createPreviewServer(); const serve = server.listeners("request")[0]; server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url.startsWith("/api/")) { blockedRequests++; response.writeHead(403); response.end(); return; }
    if (request.url === "/") { response.writeHead(200, { "Content-Type":"text/html", "Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' about:; object-src 'none'" }); response.end(page); return; }
    if (request.url.startsWith("/assets/")) request.url = "/legacy" + request.url;
    void serve(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isolated = session.fromPartition("chat-stability-366", { cache:false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls:["http://*/*", "https://*/*"] }, (details, callback) => { const denied = !details.url.startsWith(origin + "/"); if (denied) blockedRequests++; callback({ cancel:denied }); });
  window = new BrowserWindow({ show:false, width:1440, height:900, webPreferences:{ session:isolated, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  await window.loadURL(origin);
  const application = await fs.readFile(path.join(root, "public/app.js"), "utf8");
  await window.webContents.executeJavaScript(`const LIVE_SCROLL_EDGE_THRESHOLD = 48; ${["captureLiveScroll", "restoreLiveScroll"].map(name => sourceFunction(application, name)).join("\n")}`);
  await window.webContents.executeJavaScript(`(${initialize.toString()})()`);
  const scenarios = [];
  for (const width of [1440, 640]) {
    window.setContentSize(width, 900);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { let attempts = 0; const check = () => Math.abs(innerWidth - ${width}) <= 1 ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : ++attempts < 100 ? setTimeout(check, 10) : reject(new Error("Viewport did not settle")); check(); })`);
    for (const view of ["nexus", "repository", "ide"]) for (const theme of ["dark", "light"]) {
      const scenario = { view, theme };
      try { scenarios.push({ width, ...await window.webContents.executeJavaScript(`runChatStability(${JSON.stringify(scenario)})`) }); }
      catch (error) { throw new Error(`${JSON.stringify({ width, ...scenario })}: ${error.message}`); }
      if (process.env.ARGUS_CHAT_STABILITY_CAPTURE === "1") await fs.writeFile(path.join(temporary, `${view}-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  const structure = await window.webContents.executeJavaScript("runStructureStability()");
  assert.equal(blockedRequests, 0, "No backend or external network requests are permitted");
  const result = { ok:true, scenarios, structure, blockedRequests };
  await fs.writeFile(path.join(temporary, "results.json"), JSON.stringify(result, null, 2));
  finish(null, result);
}).catch(error => finish(error));
