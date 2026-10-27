import test from "node:test";
import assert from "node:assert/strict";
import { createRepositoryPorts, describeRepositoryPortState, describeArgusServicePorts } from "../public/repository-ports.mjs";

const repository = { id: "repo-a", name: "Example API" };
const configuration = { id: "config-a", repositoryId: repository.id, name: "API", port: 8080, managementPort: 10001 };
const otherRepository = { id: "repo-b", name: "Worker" };
const otherConfiguration = { id: "config-b", repositoryId: otherRepository.id, name: "Worker", port: 8081 };
const metadata = (overrides = {}) => ({ configurationId: configuration.id, repositoryId: repository.id, applicationPort: 8080,
  managementPort: 10001, configFile: "src/main/resources/application.yml", contentHash: "original-file-hash", editable: true, running: false, ...overrides });
const inventory = (overrides = {}) => ({ available: true, checkedAt: "2026-09-19T18:30:00Z", listeners: [], configurations: [configuration, otherConfiguration], ...overrides });
const flush = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; this.style = {}; this.hidden = false; this.open = false; this.textContent = ""; this.className = ""; this.value = ""; this.disabled = false; }
  set innerHTML(_) { throw new Error("Port metadata must remain plain text"); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === "class") this.className = String(value); }
  getAttribute(key) { return this.attributes.get(key); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, extra = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...extra }; for (const fn of this.listeners.get(name) || []) fn(event); }
  click() { if (!this.disabled) this.emit("click"); }
  focus() { this.document.activeElement = this; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  getBoundingClientRect() { return { left: 900, bottom: 60 }; }
}
function walk(root) { return root.children.flatMap(child => [child, ...walk(child)]); }
function harness({ handler, ...options } = {}) {
  const document = new Element("document"); document.document = document;
  document.createElement = tag => new Element(tag, document); document.body = document.createElement("body");
  document.createElementNS = (namespace, tag) => { const node = document.createElement(tag); node.namespaceURI = namespace; return node; };
  document.defaultView = document.createElement("window"); document.defaultView.innerWidth = 1024; document.defaultView.innerHeight = 768;
  const host = document.createElement("div"); document.body.append(host); const calls = [], errors = [], saves = [], selections = [];
  const controller = createRepositoryPorts({ host, document, api: (path, init) => {
    calls.push({ path, init });
    if (handler) return Promise.resolve().then(() => handler(path, init));
    return Promise.resolve(path === "/api/runtime-ports" ? inventory() : path === "/api/repositories/repo-a/ports"
      ? metadata({ configurationId: undefined, editable: false, reason: "Configure in Services to edit" }) : metadata());
  }, onError: value => errors.push(value), onSaved: (...value) => saves.push(value), onSelect: (...value) => selections.push(value), ...options });
  const byClass = suffix => walk(document.body).find(node => node.className.split(" ").includes(`repository-ports-${suffix}`));
  const activate = (extra = {}) => controller.setContext({ repository, configurations: [configuration, otherConfiguration], selectedConfigurationId: configuration.id, processes: [], visible: true, ...extra });
  const edit = value => { byClass("input").value = String(value); byClass("input").emit("input"); };
  const submit = () => byClass("form").emit("submit");
  const open = async () => { byClass("trigger").click(); await flush(); };
  return { document, host, controller, byClass, activate, open, edit, submit, calls, errors, saves, selections };
}

test("a configured header scans only on demand and offers editing directly in the current repo card", async () => {
  const h = harness(); h.activate(); await flush();
  assert.deepEqual(h.calls.map(call => call.path), ["/api/run-configurations/config-a/ports"]); assert.equal(h.byClass("trigger-port").textContent, "localhost:8080");
  assert.equal(h.byClass("trigger-state").textContent, "Service port");
  const chevron = h.byClass("chevron");
  assert.equal(chevron.tagName, "SVG"); assert.equal(chevron.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(chevron.getAttribute("viewBox"), "0 0 16 16"); assert.ok(chevron.className.includes("disclosure-chevron"));
  assert.equal(chevron.getAttribute("aria-hidden"), "true"); assert.equal(chevron.getAttribute("focusable"), "false");
  assert.equal(chevron.children[0].getAttribute("d"), "m4 6 4 4 4-4");
  assert.equal(h.byClass("panel").parentElement, h.document.body);
  assert.equal(h.byClass("panel").hidden, true);
  await h.open();
  assert.deepEqual(h.calls.map(call => call.path), ["/api/run-configurations/config-a/ports", "/api/runtime-ports", "/api/run-configurations/config-a/ports"]);
  assert.equal(h.byClass("panel").style.width, "360px");
  assert.equal(h.byClass("panel").style.left, "652px");
  assert.equal(h.byClass("edit"), undefined);
  assert.equal(h.byClass("current").contains(h.byClass("form")), true);
  assert.equal(h.byClass("form").hidden, false);
  assert.match(h.byClass("file").textContent, /Updates: src\/main\/resources\/application.yml/);
  assert.match(h.byClass("management").textContent, /10001 · unchanged/);
  assert.equal(h.byClass("input").value, "8080"); assert.equal(h.byClass("save").disabled, true);
  h.controller.dispose();
});

test("repositories without configurations detect only their read-only header port, never create Services", async () => {
  const h = harness(); h.activate({ configurations: [] }); await flush();
  assert.deepEqual(h.calls.map(call => call.path), ["/api/repositories/repo-a/ports"]);
  assert.equal(h.byClass("trigger-port").textContent, "localhost:8080");
  await h.open();
  assert.equal(h.byClass("form").hidden, false);
  assert.equal(h.byClass("input").disabled, true); assert.equal(h.byClass("save").hidden, true);
  assert.equal(h.calls.filter(call => call.init?.method).length, 0);
  h.controller.dispose();
});

test("a launch-config port edits Node arguments without requiring a YAML file", async () => {
  const h = harness({ handler: (path, options) => path === "/api/runtime-ports" ? inventory()
    : metadata({ configFile: "", editMode: "launch", affectedFiles: [], ...(options?.method ? { applicationPort: 3333 } : {}) }) });
  h.activate(); await flush(); await h.open(); h.edit(3333);
  assert.equal(h.byClass("save").disabled, false);
  h.submit(); await flush();
  assert.equal(h.saves.length, 1); assert.deepEqual(h.saves[0][1].affectedFiles, []);
  assert.equal(h.calls.find(call => call.init?.method === "POST").init.body.applicationPort, 3333);
});

test("unsupported or unconfigured repositories offer Configure service with the original scope", async () => {
  const configured = [];
  const h = harness({ onConfigure: (...args) => configured.push(args) }); h.activate({ configurations: [] }); await flush(); await h.open();
  assert.equal(h.byClass("configure").hidden, false); h.byClass("configure").click();
  assert.deepEqual(configured, [["", "repo-a"]]); assert.equal(h.controller.state.opened, false);
});

test("listener ownership, configured reservations and running state remain distinct", () => {
  const describe = extra => describeRepositoryPortState({ configuration, inventory: inventory(), ...extra });
  assert.equal(describe({}).state, "configured");
  assert.equal(describe({ inventory: inventory({ listeners: [{ port: 8080, configurationId: configuration.id }] }) }).state, "listening");
  assert.equal(describe({ inventory: inventory({ listeners: [{ port: 8080, configurationId: otherConfiguration.id }] }) }).state, "conflict");
  assert.equal(describe({ inventory: inventory({ listeners: [{ port: 8080, pid: 9, command: "java" }] }) }).state, "occupied");
  assert.equal(describe({ inventory: inventory({ configurations: [configuration, { ...otherConfiguration, managementPort: 8080 }] }) }).state, "shared");
  assert.equal(describe({ inventory: inventory({ listeners: [{ port: 8080, configurationId: configuration.id }],
    configurations: [configuration, { ...otherConfiguration, managementPort: 8080 }] }) }).state, "listening");
  assert.equal(describe({ processes: [{ configurationId: configuration.id, status: "running" }] }).state, "running");
  assert.equal(describe({ inventory: inventory({ available: false }) }).state, "unknown");
  assert.equal(describeRepositoryPortState({ processes: [{ status: "running" }] }).running, false);
  assert.equal(describe({ details: metadata({ applicationPort: 65536 }) }).port, null);
  assert.equal(describe({ details: metadata({ applicationPort: null, editable: false, reason: "Unresolved port override" }) }).port, null);
});

test("Argus port rows show configured service names, never unrelated Mac processes", async () => {
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory({ listeners: [{ port: 8080, pid: 123, command: "java" }] }) : metadata() });
  h.activate(); await h.open();
  assert.equal(h.controller.state.state, "occupied");
  assert.equal(h.byClass("trigger-state").textContent, "Service port");
  assert.equal(h.byClass("row-port").textContent, ":8080");
  assert.equal(h.byClass("row-identity").children[0].textContent, "API");
  assert.doesNotMatch(walk(h.byClass("list")).map(node => node.textContent).join(" "), /java|PID|Local address/);
  h.controller.dispose();
  const owned = harness({ handler: path => path === "/api/runtime-ports" ? inventory({ listeners: [{ port: 8081, pid: 123, command: "java", configurationId: otherConfiguration.id }] }) : metadata() });
  owned.activate(); await owned.open();
  const worker = walk(owned.byClass("list")).find(node => node.className === "repository-ports-row-identity" && node.children[0].textContent === "Worker");
  assert.equal(worker.children[1].textContent, "Application · Listening");
  owned.controller.dispose();
});

test("service assignments deduplicate socket addresses without showing unrelated listeners", async () => {
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory({ listeners: [
    { port: 8080, host: "127.0.0.1", pid: 11, command: "java", configurationId: configuration.id },
    { port: 8080, host: "::1", pid: 12, command: "java", configurationId: configuration.id },
    { port: 3000, host: "127.0.0.1", pid: 23, command: "node" },
    { port: 3000, host: "::1", pid: 23, command: "node" },
    { port: 8081, host: "127.0.0.1", pid: 31, command: "java" },
    { port: 8081, host: "::1", pid: 32, command: "java" },
    { port: 0, host: "*", pid: 99, command: "invalid" },
  ] }) : metadata() });
  h.activate(); await h.open();
  const rows = walk(h.byClass("list")).filter(node => node.className === "repository-ports-row");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.children[0].textContent), [":8080", ":8081", ":10001"]);
  assert.equal(rows[0].children[1].children[0].textContent, "API");
  assert.doesNotMatch(walk(h.byClass("list")).map(node => node.textContent).join(" "), /127\.0\.0\.1|::1|PID/);
  h.controller.dispose();
});

test("stopped Services configurations remain visible but are not labelled occupied", async () => {
  const h = harness(); h.activate(); await h.open();
  const panelText = walk(h.byClass("panel")).map(node => node.textContent).join(" ");
  assert.ok(walk(h.byClass("panel")).some(node => node.textContent === "Argus service ports"));
  assert.match(panelText, /Worker/);
  assert.doesNotMatch(walk(h.byClass("list")).map(node => node.textContent).join(" "), /Listening|Running/);
  assert.equal(walk(h.byClass("list")).filter(node => node.className === "repository-ports-row").length, 3);
  h.controller.dispose();
});

test("compact summaries distinguish this service running from an occupied or merely configured port", async () => {
  const scenarios = [
    [{ listeners: [] }, "localhost:8080 · not running"],
    [{ listeners: [{ port: 8080, configurationId: configuration.id }] }, "Listening on localhost:8080"],
    [{ listeners: [{ port: 8080, configurationId: otherConfiguration.id, command: "java" }] }, "localhost:8080 · occupied by Worker"],
    [{ listeners: [{ port: 8080, pid: 9, command: "java" }] }, "localhost:8080 · in use, service unverified"],
    [{ available: false }, "localhost:8080 · configured"],
    [{ configurations: [configuration, { ...otherConfiguration, port: 8080 }] }, "localhost:8080 · not running"],
  ];
  for (const [overrides, expected] of scenarios) {
    const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory(overrides) : metadata() });
    h.activate(); await h.open();
    assert.equal(h.byClass("summary").textContent, expected);
    assert.equal(h.byClass("trigger-port").textContent, "localhost:8080");
    h.controller.dispose();
  }
});

test("missing listener inspection is explicit and cannot turn known reservations into live listeners", async () => {
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory({ available: false, notice: "lsof unavailable", listeners: [{ port: 8080, configurationId: configuration.id }] }) : metadata() });
  h.activate(); await h.open();
  assert.equal(h.controller.state.state, "unknown");
  assert.equal(h.byClass("list").hidden, false);
  assert.ok(walk(h.document.body).some(node => node.textContent === "Live status unavailable. Showing configured service ports."));
  assert.doesNotMatch(walk(h.byClass("list")).map(node => node.textContent).join(" "), /Listening/);
  h.controller.dispose();
});

test("unsupported configurations explain the disabled edit instead of hiding the option", async () => {
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory() : metadata({ editable: false, reason: "Multiple active YAML profiles; choose one in Services." }) });
  h.activate(); await h.open(); h.edit(8084); h.submit(); await flush();
  assert.equal(h.byClass("save").disabled, true);
  assert.equal(h.byClass("form").hidden, false);
  assert.ok(walk(h.byClass("form")).some(node => node.textContent === "Multiple active YAML profiles; choose one in Services."));
  assert.equal(h.calls.filter(call => call.init?.method === "POST").length, 0); h.controller.dispose();
});

test("profile-based configurations expose the local override notice and keep saved prefill separate from effective port", async () => {
  const notice = "Updates this YAML and Argus’s local SERVER_PORT override; profiles and imports stay unchanged.";
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory() : metadata({ applicationPort: null,
    savedApplicationPort: 8080, environmentOverrideRequired: true, editNotice: notice }) });
  h.activate(); await h.open();
  assert.equal(h.byClass("trigger-port").textContent, "No port");
  assert.equal(h.byClass("input").value, "8080");
  assert.equal(h.byClass("save").disabled, false);
  assert.ok(walk(h.byClass("form")).some(node => node.textContent === notice));
  h.controller.dispose();
});

test("saving guards every affected file and posts the exact selected identity and content hash", async () => {
  const guards = []; let value = metadata({ running: true, affectedFiles: ["src/main/resources/application.yml", ".env.local"] });
  const h = harness({ canEditFile: (...args) => { guards.push(args); return true; }, handler: (path, init) => {
    if (init?.method === "POST") { value = metadata({ applicationPort: init.body.applicationPort, contentHash: "new-hash", running: true }); return { applicationPort: init.body.applicationPort, configFile: init.body.configFile, changed: true, restartRequired: true }; }
    return path === "/api/runtime-ports" ? inventory() : value;
  } });
  h.activate(); await h.open(); h.edit(9090); assert.equal(h.byClass("save").disabled, false); h.submit(); await flush();
  assert.deepEqual(guards, [["repo-a", "src/main/resources/application.yml"], ["repo-a", ".env.local"]]);
  const post = h.calls.find(call => call.init?.method === "POST");
  assert.equal(post.path, "/api/run-configurations/config-a/ports");
  assert.deepEqual(post.init.body, { applicationPort: 9090, configFile: "src/main/resources/application.yml", expectedContentHash: "original-file-hash" });
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0][1].repositoryId, "repo-a"); assert.equal(h.saves[0][1].configurationId, "config-a");
  assert.match(h.byClass("success").textContent, /Restart this service when ready/);
  assert.equal(h.byClass("trigger-port").textContent, "localhost:9090");
  assert.equal(h.calls.some(call => /\/(start|stop|restart)$/.test(call.path)), false);
  h.controller.dispose();
});

test("invalid port input and unsaved source buffers never submit", async () => {
  const h = harness({ canEditFile: () => false }); h.activate(); await h.open();
  for (const value of ["", "-1", "0", "65536", "8080.5", "1e3", "not-a-port"]) { h.edit(value); assert.equal(h.byClass("save").disabled, true, value); h.submit(); }
  h.edit(8085); h.submit(); await flush();
  assert.equal(h.calls.some(call => call.init?.method === "POST"), false);
  assert.match(h.controller.state.error, /unsaved edits/); assert.equal(h.errors.length, 1);
  // Do not silently clear the error with an automatic refresh after failure.
  assert.match(h.byClass("message").textContent, /unsaved edits/); h.controller.dispose();
});

test("content-hash conflicts remain visible and do not claim a save", async () => {
  const h = harness({ handler: (path, init) => { if (init?.method === "POST") throw new Error("Configuration changed on disk; refresh and try again."); return path === "/api/runtime-ports" ? inventory() : metadata(); } });
  h.activate(); await h.open(); h.edit(8085); h.submit(); await flush();
  assert.equal(h.saves.length, 0); assert.match(h.byClass("message").textContent, /changed on disk/);
  assert.equal(h.byClass("input").value, "8085"); h.controller.dispose();
});

test("a pending save is single-flight and retains its source when switching repositories", async () => {
  const pending = deferred();
  const h = harness({ handler: (path, init) => init?.method === "POST" ? pending.promise : path === "/api/runtime-ports" ? inventory() : path.includes("config-b")
    ? metadata({ repositoryId: "repo-b", configurationId: "config-b", applicationPort: 8081 }) : metadata() });
  h.activate(); await h.open(); h.edit(9090); h.submit(); h.submit(); await flush();
  assert.equal(h.calls.filter(call => call.init?.method === "POST").length, 1);
  h.activate({ repository: otherRepository, selectedConfigurationId: "config-b" });
  pending.resolve({ applicationPort: 9090, changed: true, restartRequired: false }); await flush();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0][1].repositoryId, "repo-a");
  assert.equal(h.controller.state.repository.id, "repo-b");
  assert.equal(h.byClass("trigger-port").textContent, "localhost:8081"); assert.equal(h.controller.state.success, ""); h.controller.dispose();
});

test("navigation during an asynchronous unsaved-file guard cancels the write", async () => {
  const guard = deferred(); const h = harness({ canEditFile: () => guard.promise });
  h.activate(); await h.open(); h.edit(9090); h.submit(); await flush();
  h.activate({ repository: otherRepository, selectedConfigurationId: "config-b" }); guard.resolve(true); await flush();
  assert.equal(h.calls.some(call => call.init?.method === "POST"), false); h.controller.dispose();
});

test("stale reads are aborted, serialized, and cannot render after switching repository", async () => {
  const pending = deferred(); const h = harness({ handler: path => path.includes("config-a") ? pending.promise : path === "/api/runtime-ports" ? inventory()
    : metadata({ repositoryId: "repo-b", configurationId: "config-b", applicationPort: 8081 }) });
  h.activate(); h.byClass("trigger").click(); await flush();
  const first = h.controller.refresh(), second = h.controller.refresh(); assert.equal(first, second);
  assert.equal(h.calls.length, 1);
  h.activate({ repository: otherRepository, selectedConfigurationId: "config-b" }); assert.equal(h.calls[0].init.signal.aborted, true);
  pending.resolve(metadata({ applicationPort: 7777 })); await flush();
  assert.equal(h.byClass("trigger-port").textContent, "localhost:8081"); assert.equal(h.controller.state.details.configurationId, "config-b");
  assert.equal(h.calls.length, 3); h.controller.dispose();
});

test("escape returns focus; outside clicks and hidden contexts close without starting background scans", async () => {
  const h = harness(); h.activate(); await h.open();
  h.document.emit("keydown", { key: "Escape" }); assert.equal(h.controller.state.opened, false); assert.equal(h.document.activeElement, h.byClass("trigger"));
  await h.open(); const count = h.calls.length;
  h.document.emit("pointerdown", { target: h.document.body }); assert.equal(h.controller.state.opened, false);
  await h.controller.refresh(); assert.equal(h.calls.length, count + 1); assert.equal(h.calls.at(-1).path, "/api/run-configurations/config-a/ports");
  await h.open(); h.controller.setContext({ visible: false });
  assert.equal(h.host.hidden, true); assert.equal(h.byClass("panel").hidden, true); await h.controller.refresh();
  h.controller.dispose(); assert.equal(walk(h.document.body).some(node => node.className === "repository-ports-panel"), false);
  assert.equal(h.document.listeners.get("keydown").size, 0);
});

test("closed panels discard late reads and duplicate shared process snapshots preserve input", async () => {
  const pending = deferred(); const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory() : pending.promise });
  h.activate(); h.byClass("trigger").click(); await flush();
  h.document.emit("keydown", { key: "Escape" }); pending.resolve(metadata({ applicationPort: 9000 })); await flush();
  assert.equal(h.controller.state.details, null); assert.equal(h.byClass("trigger-port").textContent, "localhost:8080");
  await h.open(); h.edit(9001); const count = h.calls.length;
  h.activate({ processes: [{ configurationId: configuration.id, status: "running" }] }); await flush();
  assert.equal(h.byClass("input").value, "9001"); assert.equal(h.calls.length, count); h.controller.dispose();
});

test("any service lifecycle change invalidates listener status without scanning or disturbing an edit", async () => {
  const running = { id: "run-a", configurationId: configuration.id, pid: 101, status: "running", running: true };
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory({ listeners: [{ port: 8080, configurationId: configuration.id }] }) : metadata() });
  h.activate({ processes: [running] }); await h.open();
  assert.equal(h.controller.state.state, "listening"); h.edit(9001);
  const count = h.calls.length;
  h.controller.setContext({ processes: [running, { id: "unrelated", configurationId: otherConfiguration.id, status: "running" }] });
  assert.equal(h.controller.state.state, "running");
  h.controller.setContext({ processes: [{ ...running, status: "stopped", running: false }] }); await flush();
  assert.equal(h.calls.length, count); assert.equal(h.controller.state.inventory, null);
  assert.equal(h.controller.state.running, false); assert.equal(h.byClass("list").hidden, false);
  assert.doesNotMatch(h.byClass("summary").textContent, /Listening on|Running on/);
  assert.equal(h.byClass("input").value, "9001"); assert.equal(h.byClass("form").hidden, false);
  assert.ok(walk(h.byClass("panel")).some(node => node.textContent === "Configured ports · refresh to check live status."));
  h.controller.dispose();
});

test("service rows use effective inventory ports and preserve unresolved current metadata", () => {
  const rows = describeArgusServicePorts({ configurations: [configuration], inventory: inventory({ configurations: [
    { ...configuration, port: 8181, running: true }, otherConfiguration, otherConfiguration,
  ] }), configurationId: configuration.id, details: metadata({ applicationPort: null }) });
  assert.deepEqual(rows.map(row => [row.port, row.kind]), [[8081, "Application"], [10001, "Management"]]);
  assert.equal(rows[1].status, "Running · unverified");
  assert.equal(describeArgusServicePorts({ configurations: [configuration], inventory: inventory({ configurations: [] }) }).length, 0);
});

test("adding or editing another service refreshes visible assignments without losing the current port draft", async () => {
  const h = harness(); h.activate(); await h.open(); h.edit(9001);
  const count = h.calls.length;
  h.controller.setContext({ configurations: [configuration, { ...otherConfiguration, port: 9010 }] });
  assert.equal(h.calls.length, count);
  assert.equal(h.byClass("input").value, "9001");
  const rows = walk(h.byClass("list")).filter(node => node.className === "repository-ports-row");
  assert.deepEqual(rows.map(row => row.children[0].textContent), [":8080", ":9010", ":10001"]);
  h.controller.dispose();
});

test("listener responses captured before a process stopped cannot revive stale live status", async () => {
  const pending = deferred(), running = { id: "run-a", configurationId: configuration.id, pid: 101, status: "running", running: true };
  const h = harness({ handler: path => path === "/api/runtime-ports" ? pending.promise : metadata() });
  h.activate({ processes: [running] }); await flush(); h.byClass("trigger").click(); await flush();
  assert.equal(h.controller.state.loading, true);
  h.controller.setContext({ processes: [{ ...running, status: "stopped", running: false }] });
  const count = h.calls.length;
  pending.resolve(inventory({ listeners: [{ port: 8080, configurationId: configuration.id }] })); await flush();
  assert.equal(h.calls.length, count); assert.equal(h.controller.state.loading, false);
  assert.equal(h.controller.state.inventory, null); assert.equal(h.byClass("list").hidden, false);
  assert.doesNotMatch(h.byClass("summary").textContent, /Listening on|Running on/);
  assert.ok(walk(h.byClass("panel")).some(node => node.textContent === "Configured ports · refresh to check live status."));
  h.controller.dispose();
});

test("multiple configurations synchronize selection without editing another configuration", async () => {
  const second = { ...otherConfiguration, repositoryId: repository.id };
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory() : path.includes("config-b") ? metadata({ configurationId: "config-b", applicationPort: 8081 }) : metadata() });
  h.activate({ configurations: [configuration, second] }); await h.open();
  assert.equal(h.byClass("select").parentElement.hidden, false);
  h.byClass("select").value = "config-b"; h.byClass("select").emit("change"); await flush();
  assert.deepEqual(h.selections, [["config-b", "repo-a"]]); assert.equal(h.byClass("input").value, "8081");
  assert.equal(h.byClass("form").hidden, false);
  assert.equal(h.calls.at(-1).path, "/api/run-configurations/config-b/ports"); h.controller.dispose();
});

test("port editing remains directly available after reopening or changing repositories", async () => {
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory() : path.includes("config-b")
    ? metadata({ repositoryId: "repo-b", configurationId: "config-b", applicationPort: 8081 }) : metadata() });
  h.activate(); await h.open(); assert.equal(h.byClass("input").disabled, false);
  h.document.emit("keydown", { key: "Escape" }); await h.open();
  assert.equal(h.byClass("input").disabled, false);
  h.activate({ repository: otherRepository, selectedConfigurationId: "config-b" }); await flush();
  assert.equal(h.byClass("input").disabled, false);
  assert.equal(h.byClass("trigger-port").textContent, "localhost:8081");
  h.controller.dispose();
});

test("metadata and service names render as bounded plain text", async () => {
  const dangerous = '<img src=x onerror="alert(1)">';
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory({ configurations: Array.from({ length: 120 }, (_, index) => ({ id: `config-${index}`, port: index + 1, name: dangerous })) }) : metadata({ configFile: dangerous }) });
  h.activate(); await h.open();
  assert.match(h.byClass("file").textContent, /<img src=x/);
  assert.equal(walk(h.byClass("list")).filter(node => node.className === "repository-ports-row").length, 80);
  assert.ok(walk(h.byClass("list")).some(node => node.textContent === "Showing 80 of 120 entries."));
  assert.equal(walk(h.document.body).some(node => node.tagName === "IMG"), false); h.controller.dispose();
});

test("opening coordinates other dialogs and malformed cross-repo metadata cannot enable edits", async () => {
  let beforeOpen = 0;
  const h = harness({ beforeOpen: () => beforeOpen++, handler: path => path === "/api/runtime-ports" ? inventory() : metadata({ repositoryId: "wrong-repository" }) });
  h.activate(); await h.open(); assert.equal(beforeOpen, 1);
  assert.equal(h.controller.state.details, null); assert.equal(h.byClass("input").disabled, true);
  assert.match(h.byClass("message").textContent, /Could not read/); h.controller.dispose();
});

test("a declined or failing dialog-close guard prevents opening and listener inspection", async () => {
  for (const beforeOpen of [() => false, () => { throw new Error("Unsaved diff edits"); }, async () => false]) {
    const h = harness({ beforeOpen }); h.activate(); await flush(); await h.open();
    assert.equal(h.controller.state.opened, false); assert.equal(h.byClass("panel").hidden, true);
    assert.equal(h.calls.some(call => call.path === "/api/runtime-ports"), false); h.controller.dispose();
  }
});

test("closed header reads effective metadata once, ignores process polls, and respects hidden state", async () => {
  const h = harness({ handler: path => path === "/api/runtime-ports" ? inventory() : metadata({ applicationPort: 8181, running: true }) });
  h.activate({ visible: false }); await flush(); assert.equal(h.calls.length, 0);
  h.controller.setContext({ visible: true }); await flush();
  assert.equal(h.byClass("trigger-port").textContent, "localhost:8181"); assert.equal(h.calls.length, 1);
  for (let index = 0; index < 5; index++) h.activate({ processes: [{ configurationId: configuration.id, status: "running" }] });
  await flush(); assert.equal(h.calls.length, 1); assert.equal(h.controller.state.running, true);
  h.controller.setContext({ processes: [{ configurationId: configuration.id, status: "stopped" }] });
  assert.equal(h.controller.state.running, false); assert.equal(h.controller.state.state, "configured");
  h.controller.dispose();
});

test("hiding a header aborts its in-flight metadata read and invalidates an opening guard", async () => {
  const read = deferred(), guard = deferred();
  const h = harness({ beforeOpen: () => guard.promise, handler: () => read.promise });
  h.activate(); await flush(); h.byClass("trigger").click();
  h.controller.setContext({ visible: false }); assert.equal(h.calls[0].init.signal.aborted, true);
  read.resolve(metadata({ applicationPort: 9898 })); guard.resolve(true); await flush();
  assert.equal(h.controller.state.opened, false); assert.equal(h.controller.state.details, null); h.controller.dispose();
});
