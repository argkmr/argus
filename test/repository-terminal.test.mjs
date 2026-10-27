import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRepositoryTerminal, terminalInputChunks } from "../public/repository-terminal.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function harness() {
  const nodes = new Map(), requests = [], terms = [], notices = [], visibility = [], sessions = new Map(), listeners = new Map();
  let repository = { id: "repo-a", name: "Review", path: "/source/review" }, loads = 0, sequence = 0, hook;
  class Element {
    constructor() { this.children = []; this.hidden = false; this.textContent = ""; this.isConnected = true; const names = new Set(); this.classList = { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name), toggle: (name, value) => value ? names.add(name) : names.delete(name) }; }
    append(child) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(node => node !== child); this.children.push(child); child.parentElement = this; }
    remove() { this.isConnected = false; }
    focus() { document.activeElement = this; this.focused = (this.focused || 0) + 1; }
  }
  const timers = { tasks: new Map(), next: 0, now: 0,
    setTimeout(fn, delay) { const id = ++this.next; this.tasks.set(id, { fn, at: this.now + delay }); return id; },
    clearTimeout(id) { this.tasks.delete(id); },
    runNext() { const selected = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0]; if (!selected) return Promise.resolve(); const [id, task] = selected; this.tasks.delete(id); this.now = task.at; return task.fn(); },
  };
  let observer;
  const win = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key), ResizeObserver: class { constructor(fn) { this.callback = fn; observer = this; } observe() {} disconnect() { this.disconnected = true; } } };
  const document = { defaultView: win, createElement: () => new Element(), querySelector: selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); } };
  document.activeElement = new Element(); const originFocus = document.activeElement;
  document.querySelector("#terminal-panel").classList.add("hidden");
  class Terminal {
    constructor(options) { this.options = options; this.writes = []; this.resets = 0; this.clears = 0; this.cols = 110; this.rows = 24; terms.push(this); }
    loadAddon(addon) { addon.term = this; }
    open(host) { this.host = host; }
    onData(fn) { this.data = fn; return { dispose: () => { this.data = null; } }; }
    attachCustomKeyEventHandler(fn) { this.key = fn; }
    write(text) { this.writes.push(text); }
    reset() { this.resets++; this.writes = []; }
    clear() { this.clears++; }
    focus() { this.host.focus(); }
    dispose() { this.disposed = true; }
  }
  class FitAddon { fit() { this.fits = (this.fits || 0) + 1; } }
  function snapshot(id, after = 0) { const current = sessions.get(id); if (!current) throw new Error("Start the terminal first"); return { ...current, chunks: current.chunks.filter(chunk => chunk.cursor > after) }; }
  const api = async (path, options = {}) => {
    const call = { path, ...options }; requests.push(call);
    const override = hook?.(call); if (override !== undefined) return await override;
    const parsed = /^\/api\/repositories\/([^/]+)\/terminal([^?]*)(?:\?after=(\d+))?$/.exec(path);
    assert.ok(parsed, path); const [, id, action, after] = parsed;
    if (!action) return snapshot(id, Number(after) || 0);
    if (action === "/start") {
      const fresh = { id: `${id}-${++sequence}`, pty: true, shell: "/bin/zsh", repositoryName: id, cwd: `/source/${id}`, running: true, cursor: 1, chunks: [{ cursor: 1, data: `\x1b[32m${id} git:(main)\x1b[0m ` }] };
      sessions.set(id, fresh); return { ...fresh };
    }
    const current = sessions.get(id); assert.equal(options.body.sessionId, current?.id, `${action} targets current session`);
    if (action === "/stop") current.running = false;
    if (action === "/clear") current.chunks = [];
    return snapshot(id);
  };
  const terminal = createRepositoryTerminal({ document, api, getRepository: () => repository, notify: (...args) => notices.push(args), onVisibilityChange: state => visibility.push(state), load: async () => { loads++; return { Terminal, FitAddon }; }, timers });
  return { terminal, document, nodes, requests, terms, notices, visibility, sessions, timers, originFocus, listeners, snapshot,
    get loads() { return loads; }, get observer() { return observer; },
    repo(value) { repository = value; }, hook(value) { hook = value; },
    node: id => document.querySelector(`#${id}`), calls: action => requests.filter(call => call.path.split("?")[0].endsWith(action)),
  };
}

test("terminal remains lazy and uses the shell-rendered prompt, never a fake command form", async () => {
  const h = harness(); assert.equal(h.loads, 0); assert.equal(h.requests.length, 0);
  await h.terminal.open();
  assert.equal(h.loads, 1); assert.equal(h.terms.length, 1); assert.match(h.node("terminal-title").textContent, /Review · zsh/);
  assert.deepEqual(h.terms[0].writes, ["\x1b[32mrepo-a git:(main)\x1b[0m "]);
  assert.equal(h.terms[0].options.disableStdin, false); assert.equal(h.terms[0].options.convertEol, false);
  assert.equal(h.terms[0].options.scrollback, 5000);
  const markup = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(markup, /id="terminal-output" aria-label="Interactive zsh terminal"/);
  assert.doesNotMatch(markup, /id="terminal-(?:form|input|prompt-label)"/);
});

test("raw input preserves Ctrl-C, arrows, tab, carriage return, paste and Unicode", async () => {
  const h = harness(); await h.terminal.open();
  const input = ["\x03", "\x1b[A", "\t", "\r", "echo नमस्ते\nsecond line"];
  for (const value of input) h.terms[0].data(value);
  await flush();
  assert.deepEqual(h.calls("/input").map(call => call.body.input), input);
  assert.ok(h.calls("/input").every(call => call.body.sessionId === "repo-a-1"));
  assert.equal(h.terms[0].writes.length, 1, "input is never locally echoed");
});

test("inputs are serialized and queued keystrokes are cancelled by a repository switch", async () => {
  const h = harness(), pending = deferred(); await h.terminal.open();
  h.hook(call => call.path.endsWith("/input") && call.body.input === "a" ? pending.promise : undefined);
  h.terms[0].data("a"); h.terms[0].data("b"); await flush();
  assert.deepEqual(h.calls("/input").map(call => call.body.input), ["a"]);
  h.repo({ id: "repo-b", name: "Other" }); await h.terminal.open();
  pending.resolve({}); await flush();
  assert.deepEqual(h.calls("/input").map(call => call.body.input), ["a"]);
  h.terms[1].data("c"); await flush(); assert.equal(h.calls("/input").at(-1).body.sessionId, "repo-b-2");
});

test("large paste is chunked under 64K without splitting Unicode or reordering later input", async () => {
  const h = harness(); await h.terminal.open();
  const input = `${"a".repeat(63_999)}😀${"b".repeat(90_000)}\r`;
  const pieces = [...terminalInputChunks(input)];
  assert.ok(pieces.every(piece => piece.length <= 64_000)); assert.equal(pieces.join(""), input);
  assert.ok(pieces.every(piece => !/[\uD800-\uDBFF]$/.test(piece) && !/^[\uDC00-\uDFFF]/.test(piece)));
  h.terms[0].data(input); h.terms[0].data("next"); await flush();
  assert.deepEqual(h.calls("/input").map(call => call.body.input), [...pieces, "next"]);
});

test("uncertain input is never retried and queued suffixes pause until explicit reconnect", async () => {
  const h = harness(); await h.terminal.open();
  h.hook(call => call.path.endsWith("/input") ? Promise.reject(new Error("Connection interrupted.")) : undefined);
  h.terms[0].data("part one"); h.terms[0].data("must not run"); await flush();
  assert.deepEqual(h.calls("/input").map(call => call.body.input), ["part one"]);
  assert.equal(h.terms[0].options.disableStdin, true); assert.match(h.node("terminal-status").textContent, /no input was retried/);
  h.hook(undefined); h.terminal.minimize(); await h.terminal.open();
  assert.equal(h.terms[0].options.disableStdin, false); assert.equal(h.calls("/start").length, 1);
});

test("minimize keeps PTY and scrollback; restore catches up without replay or another start", async () => {
  const h = harness(); await h.terminal.open(); const term = h.terms[0];
  h.terminal.minimize(); assert.equal(h.timers.tasks.size, 0); assert.equal(h.calls("/stop").length, 0);
  assert.equal(h.document.activeElement, h.originFocus);
  const current = h.sessions.get("repo-a"); current.chunks.push({ cursor: ++current.cursor, data: "background output" });
  await h.terminal.open(); assert.equal(h.terms[0], term); assert.equal(term.resets, 1); assert.equal(h.calls("/start").length, 1);
  assert.deepEqual(term.writes, ["\x1b[32mrepo-a git:(main)\x1b[0m ", "background output"]);
});

test("minimize restores focus to the bottom Terminal tab if the original control was removed", async () => {
  const h = harness(), terminalTab = h.document.querySelector('.repository-ide-tool-tab[data-tool="terminal"]');
  await h.terminal.open(); h.originFocus.remove(); h.terminal.minimize();
  assert.equal(h.document.activeElement, terminalTab);
  assert.equal(h.calls("/stop").length, 0); assert.equal(h.calls("/start").length, 1);
  h.terminal.dispose();
});

test("an old poll cannot paint another repository or steal its focus", async () => {
  const h = harness(), pending = deferred(); await h.terminal.open();
  h.hook(call => call.path.includes("repo-a/terminal?after=") ? pending.promise : undefined);
  const polling = h.timers.runNext(); await flush();
  h.repo({ id: "repo-b", name: "Other" }); await h.terminal.open(); const focused = h.document.activeElement;
  pending.resolve({ ...h.snapshot("repo-a"), cwd: "/wrong", cursor: 2, chunks: [{ cursor: 2, data: "WRONG" }] }); await polling;
  assert.match(h.node("terminal-title").textContent, /Other/); assert.notEqual(h.node("terminal-cwd").textContent, "/wrong");
  assert.equal(h.document.activeElement, focused); assert.ok(h.terms.every(term => !term.writes.includes("WRONG")));
});

test("restart invalidates old polls and sends a guarded stop before a new session", async () => {
  const h = harness(), pending = deferred(); await h.terminal.open();
  h.hook(call => call.path.includes("?after=") ? pending.promise : undefined);
  const polling = h.timers.runNext(); await flush(); await h.terminal.restart();
  pending.resolve({ id: "repo-a-1", pty: true, running: true, cursor: 10, chunks: [{ cursor: 10, data: "STALE" }] }); await polling;
  assert.equal(h.calls("/stop").at(-1).body.sessionId, "repo-a-1");
  h.terms[0].data("pwd\r"); await flush(); assert.equal(h.calls("/input").at(-1).body.sessionId, "repo-a-2");
  assert.ok(!h.terms[0].writes.includes("STALE")); assert.equal(h.terms[0].resets, 2);
});

test("clear prevents an in-flight old transcript from reappearing", async () => {
  const h = harness(), pending = deferred(); await h.terminal.open();
  h.hook(call => call.path.includes("?after=") ? pending.promise : undefined);
  const polling = h.timers.runNext(); await flush(); await h.terminal.clear();
  pending.resolve({ ...h.snapshot("repo-a"), cursor: 99, chunks: [{ cursor: 99, data: "OLD TRANSCRIPT" }] }); await polling;
  assert.equal(h.calls("/clear").at(-1).body.sessionId, "repo-a-1"); assert.equal(h.terms[0].clears, 1);
  assert.ok(!h.terms[0].writes.includes("OLD TRANSCRIPT"));
});

test("close during start still stops the newly created PTY without revealing it", async () => {
  const h = harness(), pending = deferred();
  h.hook(call => call.path.endsWith("/start") ? pending.promise : undefined);
  const opening = h.terminal.open(); await flush(); const closing = h.terminal.close();
  const session = { id: "delayed", pty: true, running: true, cursor: 1, chunks: [{ cursor: 1, data: "prompt" }] };
  h.sessions.set("repo-a", session); pending.resolve(session); await Promise.all([opening, closing]);
  assert.equal(h.calls("/stop").length, 1); assert.equal(h.calls("/stop")[0].body.sessionId, "delayed");
  assert.equal(h.node("terminal-panel").classList.contains("hidden"), true); assert.deepEqual(h.terms[0].writes, []);
});

test("close and immediate reopen are serialized and cannot stop the replacement session", async () => {
  const h = harness(), pending = deferred(); await h.terminal.open();
  h.hook(call => call.path.endsWith("/stop") ? pending.promise.then(() => { h.sessions.get("repo-a").running = false; return {}; }) : undefined);
  const closing = h.terminal.close(), reopening = h.terminal.open(); await flush();
  assert.equal(h.calls("/start").length, 1); pending.resolve(); await Promise.all([closing, reopening]);
  assert.equal(h.calls("/stop").length, 1); assert.equal(h.calls("/stop")[0].body.sessionId, "repo-a-1");
  assert.equal(h.sessions.get("repo-a").id, "repo-a-2"); assert.equal(h.sessions.get("repo-a").running, true);
});

test("close during initial status lookup also stops a previously existing PTY", async () => {
  const h = harness(), pending = deferred();
  const existing = { id: "pre-existing", pty: true, running: true, cursor: 1, chunks: [{ cursor: 1, data: "prompt" }] };
  h.sessions.set("repo-a", existing);
  h.hook(call => call.path.includes("?after=") ? pending.promise : undefined);
  const opening = h.terminal.open(); await flush(); const closing = h.terminal.close();
  pending.resolve(existing); await Promise.all([opening, closing]);
  assert.equal(h.calls("/start").length, 0); assert.equal(h.calls("/stop")[0].body.sessionId, "pre-existing");
  assert.equal(h.node("terminal-panel").classList.contains("hidden"), true);
});

test("clear drains already typed input without injecting shell keystrokes or losing the draft", async () => {
  const h = harness(), pending = deferred(); await h.terminal.open();
  h.hook(call => call.path.endsWith("/input") && call.body.input === "a" ? pending.promise : undefined);
  h.terms[0].data("a"); h.terms[0].data("b"); await flush(); const clearing = h.terminal.clear();
  pending.resolve({}); await clearing;
  assert.deepEqual(h.calls("/input").map(call => call.body.input), ["a", "b"]);
  assert.equal(h.terms[0].resets, 1, "clear does not reset the parser or current prompt line");
});

test("resize sends integer geometry with the exact session, throttles, and ignores hidden panes", async () => {
  const h = harness(); await h.terminal.open();
  assert.deepEqual(h.calls("/resize")[0].body, { sessionId: "repo-a-1", cols: 110, rows: 24 });
  h.terms[0].cols = 87; h.terms[0].rows = 18;
  for (let i = 0; i < 6; i++) h.observer.callback();
  assert.equal(h.calls("/resize").length, 1); await h.timers.runNext(); await flush();
  assert.deepEqual(h.calls("/resize").at(-1).body, { sessionId: "repo-a-1", cols: 87, rows: 18 });
  h.terminal.minimize(); h.observer.callback(); await h.timers.runNext();
  assert.equal(h.calls("/resize").length, 2);
});

test("stopped sessions disable stdin and local errors remain plain accessible text", async () => {
  const h = harness(); await h.terminal.open(); h.sessions.get("repo-a").running = false;
  await h.timers.runNext(); assert.equal(h.terms[0].options.disableStdin, true); assert.match(h.node("terminal-status").textContent, /stopped/);
  h.terms[0].data("must not send"); await flush(); assert.equal(h.calls("/input").length, 0);
  h.hook(call => call.path.endsWith("/start") ? Promise.reject(new Error("<img src=x>\x1b]52;clipboard\x07")) : undefined);
  await h.terminal.restart(); assert.equal(h.node("terminal-status").textContent, "<img src=x>\x1b]52;clipboard\x07");
  assert.ok(!h.terms[0].writes.some(text => text.includes("clipboard")));
});

test("shell control keys stay out of global find while terminal toggle remains available", async () => {
  const h = harness(); await h.terminal.open(); let stopped = false;
  assert.equal(h.terms[0].key({ type: "keydown", key: "f", ctrlKey: true, stopPropagation() { stopped = true; } }), true);
  assert.equal(stopped, true);
  assert.equal(h.terms[0].key({ type: "keydown", key: "`", code: "Backquote", ctrlKey: true }), false);
  assert.equal(h.terms[0].options.linkHandler.activate({}, "https://example.com"), undefined);
});

test("dispose removes observers and renderer without implicitly killing background PTYs", async () => {
  const h = harness(); await h.terminal.open(); h.terminal.dispose();
  assert.equal(h.timers.tasks.size, 0); assert.equal(h.observer.disconnected, true); assert.equal(h.terms[0].disposed, true);
  assert.equal(h.calls("/stop").length, 0); assert.equal(h.listeners.has("resize"), false);
});

test("mounting the IDE dock is lazy and moving it preserves the exact renderer and PTY", async () => {
  const h = harness(), first = h.document.createElement("section"), second = h.document.createElement("section");
  assert.equal(h.terminal.mount(first), true);
  assert.equal(h.node("terminal-panel").parentElement, first);
  assert.equal(h.loads, 0); assert.equal(h.requests.length, 0); assert.equal(h.timers.tasks.size, 0);
  assert.deepEqual(h.terminal.getState(), { visible: false, repositoryId: null });
  await h.terminal.open({ repositoryId: "repo-a" });
  const term = h.terms[0]; term.cols = 76; term.rows = 12;
  assert.equal(h.terminal.mount(second), true);
  assert.equal(first.children.length, 0); assert.equal(second.children[0], h.node("terminal-panel"));
  await h.timers.runNext(); await flush();
  assert.deepEqual(h.calls("/resize").at(-1).body, { sessionId: "repo-a-1", cols: 76, rows: 12 });
  assert.equal(h.terms[0], term); assert.equal(h.loads, 1);
  assert.equal(h.calls("/start").length, 1); assert.equal(h.calls("/stop").length, 0);
  assert.deepEqual(h.terminal.getState(), { visible: true, repositoryId: "repo-a" });
});

test("stale IDE repository clicks cannot start or reveal a terminal for the newly selected repository", async () => {
  const h = harness();
  h.repo({ id: "repo-b", name: "Other", path: "/source/other" });
  await h.terminal.open({ repositoryId: "repo-a" });
  assert.equal(h.loads, 0); assert.equal(h.requests.length, 0); assert.equal(h.visibility.length, 0);
  assert.equal(h.node("terminal-panel").classList.contains("hidden"), true);
  await h.terminal.open({ repositoryId: "repo-b" });
  assert.ok(h.requests.every(request => request.path.includes("/repo-b/terminal")));
  assert.deepEqual(h.visibility, [{ visible: true, repositoryId: "repo-b" }]);
});

test("hiding the IDE silently preserves its repo terminal without stealing new navigation focus", async () => {
  const h = harness(), toolbarButton = h.document.createElement("button"), nextButton = h.document.createElement("button");
  await h.terminal.open({ repositoryId: "repo-a", returnFocus: toolbarButton });
  nextButton.focus(); h.terminal.minimize({ restoreFocus: false });
  assert.equal(h.document.activeElement, nextButton);
  assert.equal(h.calls("/stop").length, 0);
  assert.deepEqual(h.visibility.at(-1), { visible: false, repositoryId: "repo-a" });
  h.repo({ id: "repo-b", name: "Other", path: "/source/other" });
  assert.equal(h.calls("/start").length, 1, "switching context never starts the other repository shell");
  h.repo({ id: "repo-a", name: "Review", path: "/source/review" });
  await h.terminal.open({ repositoryId: "repo-a", returnFocus: () => toolbarButton }); h.terminal.minimize();
  assert.equal(h.document.activeElement, toolbarButton);
  assert.equal(h.calls("/start").length, 1);
  h.terminal.dispose();
  assert.deepEqual(h.visibility.at(-1), { visible: false, repositoryId: null });
  assert.equal(h.terminal.mount(h.document.createElement("section")), false);
});

test("a repository switch during terminal status loading cannot start either shell", async () => {
  const h = harness(), pending = deferred();
  h.hook(call => call.path.includes("repo-a/terminal?after=") ? pending.promise : undefined);
  const opening = h.terminal.open({ repositoryId: "repo-a" }); await flush();
  h.terminal.minimize({ restoreFocus: false });
  h.repo({ id: "repo-b", name: "Other", path: "/source/other" });
  pending.resolve({ running: false }); await opening;
  assert.equal(h.calls("/start").length, 0); assert.equal(h.calls("/stop").length, 0);
  assert.equal(h.node("terminal-panel").classList.contains("hidden"), true);
});
