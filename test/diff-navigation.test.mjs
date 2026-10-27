import test from "node:test";
import assert from "node:assert/strict";
import { createDiffNavigation, resolveDiffNavigationPosition, renderDiffNavigationCode } from "../public/diff-navigation.mjs";
import { parseUnifiedDiff, expandToFullFile } from "../public/diff-parser.js";

const beforeContent = 'import { service } from "./service";\nservice.run();\n';
const afterContent = '// header\n' + beforeContent;
const rows = expandToFullFile(parseUnifiedDiff('@@ -1,2 +1,3 @@\n+// header\n import { service } from "./service";\n service.run();\n'), beforeContent, afterContent).rows;
const context = { repositoryId: "repo", file: "main.ts", beforeContent, afterContent, rows };
const hit = { side: "after", line: 3, column: 9, word: "run" };

test("diff symbols retain exact text, escaped markup and UTF-16/tab columns", () => {
  const result = renderDiffNavigationCode('\t😀 service.run("<script>");');
  assert.match(result, /data-column="5">service/);
  assert.match(result, /data-column="13">run/);
  assert.doesNotMatch(result, /<script>/);
  assert.ok(result.includes("&lt;"));
  assert.match(renderDiffNavigationCode("$data.écrire()"), />\$data<.*>écrire</);
});

test("current after coordinates are exact and unchanged before lines map through diff rows", () => {
  assert.deepEqual(resolveDiffNavigationPosition(context, hit, afterContent), { path: "main.ts", line: 3, column: 9 });
  assert.deepEqual(resolveDiffNavigationPosition(context, { ...hit, side: "before", line: 2 }, afterContent), { path: "main.ts", line: 3, column: 9 });
  assert.equal(resolveDiffNavigationPosition(context, { ...hit, word: "other" }, afterContent), null);
  assert.equal(resolveDiffNavigationPosition(context, { ...hit, line: 0 }, afterContent), null);
});

test("configuration keys remain one clickable token with exact columns in legacy diffs", () => {
  for (const text of ['@Value("${service.base-url:http://localhost}")', 'environment.getProperty("service.base-url")']) {
    const result = renderDiffNavigationCode(text, "Config.java"), column = text.indexOf("service.base-url") + 1;
    assert.ok(result.includes(`data-column="${column}">service.base-url</span>`));
    assert.equal((result.match(/>service\.base-url<\/span>/g) || []).length, 1);
    assert.deepEqual(resolveDiffNavigationPosition({ file: "Config.java", afterContent: text },
      { side: "after", line: 1, column, word: "service.base-url" }, text), { path: "Config.java", line: 1, column });
  }
  assert.doesNotMatch(renderDiffNavigationCode('`${service.baseUrl}`', "main.ts"), />service\.baseUrl<\/span>/);
  assert.match(renderDiffNavigationCode('`${service.baseUrl}`', "main.ts"), />baseUrl<\/span>/);
  assert.doesNotMatch(renderDiffNavigationCode('"${service.baseUrl}"', "Main.kt"), />service\.baseUrl<\/span>/);
  assert.match(renderDiffNavigationCode('"\\${service.base-url}"', "Main.kt"), />service\.base-url<\/span>/);
});

test("deleted/changed historical lines never use paired rows or identical text elsewhere", () => {
  const ctx = { ...context, beforeContent: 'a.run();\nb.run();', afterContent: 'b.run();\na.run();', rows: [{ oldLine: 1, newLine: 1, oldText: "a.run();", newText: "b.run();", type: "changed" }] };
  assert.equal(resolveDiffNavigationPosition(ctx, { ...hit, side: "before", line: 1, column: 3 }, ctx.afterContent), null);
});

test("staged positions chain through verified index-to-worktree context mappings", () => {
  const working = '// another\n' + afterContent;
  const diff = { beforeContent: afterContent, afterContent: working, rows: [{ oldLine: 3, newLine: 4, oldText: "service.run();", newText: "service.run();" }] };
  assert.deepEqual(resolveDiffNavigationPosition(context, hit, working, diff), { path: "main.ts", line: 4, column: 9 });
  assert.deepEqual(resolveDiffNavigationPosition(context, { ...hit, side: "before", line: 2 }, working, diff), { path: "main.ts", line: 4, column: 9 });
  assert.equal(resolveDiffNavigationPosition(context, hit, working), null);
  assert.equal(resolveDiffNavigationPosition(context, hit, working, { ...diff, beforeContent: "stale" }), null);
  assert.equal(resolveDiffNavigationPosition(context, hit, working, { ...diff, afterContent: "stale" }), null);
});

function harness() {
  const events = () => ({ listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener(name) { delete this.listeners[name]; } });
  const win = events(), doc = { ...events(), defaultView: win };
  const classes = new Set();
  const dialog = { ...events(), contains: () => true, classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, remove(name) { classes.delete(name); } } };
  let current = context, disk = { content: afterContent, contentHash: "a".repeat(64) }, deferred;
  const reads = [], navigations = [], reveals = [], statuses = [];
  const control = createDiffNavigation({ dialog, document: doc, getContext: () => current,
    readFile: async (ctx, signal) => { reads.push({ ctx, signal }); return deferred ? await deferred : disk; },
    navigate: async (ctx, body, signal) => { navigations.push({ ctx, body, signal }); return { locations: [{ path: "service.ts", line: 2, column: 3 }] }; },
    reveal: async (...args) => { reveals.push(args); return true; }, onStatus: (...args) => statuses.push(args) });
  const code = { dataset: { diffSide: "after", diffLine: "3" } };
  const symbol = { dataset: { column: "9" }, textContent: "run", closest: () => code };
  const event = (overrides = {}) => ({ button: 0, metaKey: true, ctrlKey: false, clientX: 20, clientY: 30,
    target: { closest: () => symbol }, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...overrides });
  return { control, dialog, doc, win, classes, reads, navigations, reveals, statuses, event, current: value => { current = value; }, disk: value => { disk = value; }, defer: value => { deferred = value; } };
}

test("definition lookup sends provider-independent saved content hash and only then reveals", async () => {
  const h = harness(); await h.control.follow(hit);
  assert.deepEqual(h.navigations[0].body, { path: "main.ts", line: 3, column: 9, kind: "definition", expectedHash: "a".repeat(64) });
  assert.equal(h.reveals.length, 1); assert.equal(h.reveals[0][3](), true);
});

test("stale, closed or edited diff cannot reveal or alter status after lookup begins", async () => {
  for (const mode of ["context", "close", "invalidate"]) {
    const h = harness(); let resolve; h.defer(new Promise(done => { resolve = done; }));
    const result = h.control.follow(hit);
    if (mode === "context") h.current({ ...context, repositoryId: "other" });
    else if (mode === "close") h.dialog.listeners.close(); else h.control.invalidate();
    resolve({ content: afterContent, contentHash: "b".repeat(64) }); await result;
    assert.equal(h.navigations.length, 0); assert.equal(h.reveals.length, 0); assert.equal(h.statuses.length, 1);
  }
});

test("missing mapping or file hash gives honest status without a language request", async () => {
  for (const disk of [{ content: "different", contentHash: "a".repeat(64) }, { content: afterContent }]) {
    const h = harness(); h.disk(disk); await h.control.follow(hit);
    assert.equal(h.navigations.length, 0); assert.equal(h.reveals.length, 0); assert.equal(h.statuses.length, 2);
  }
});

test("ordinary click remains selection; Cmd click and Mac Control context sequence navigate once", async () => {
  const h = harness(); h.dialog.listeners.mousedown(h.event({ metaKey: false }));
  assert.equal(h.reads.length, 0);
  const down = h.event({ metaKey: false, ctrlKey: true }); h.dialog.listeners.mousedown(down);
  h.dialog.listeners.click(h.event({ metaKey: false, ctrlKey: true }));
  h.current(null); // Destination can change before macOS dispatches contextmenu.
  const menu = h.event({ metaKey: false, ctrlKey: true }); h.dialog.listeners.contextmenu(menu);
  assert.equal(down.prevented, true); assert.equal(menu.prevented, true); assert.equal(h.reads.length, 1);
  await Promise.resolve();
});

test("modifier visuals clear on release/blur and disposal removes event listeners", () => {
  const h = harness(); h.doc.listeners.keydown(h.event()); assert.ok(h.classes.has("diff-definition-modifier"));
  h.doc.listeners.keyup(h.event({ metaKey: false })); assert.equal(h.classes.size, 0);
  h.doc.listeners.keydown(h.event()); h.win.listeners.blur(); assert.equal(h.classes.size, 0);
  h.control.dispose(); assert.deepEqual(Object.keys(h.dialog.listeners), []); assert.deepEqual(Object.keys(h.doc.listeners), []);
});

test("Monaco iframe focus does not cancel a lookup, but leaving the application does", async () => {
  for (const focused of [true, false]) {
    const h = harness(); h.doc.hasFocus = () => focused;
    let resolve; h.defer(new Promise(done => { resolve = done; }));
    const pending = h.control.follow(hit);
    h.win.listeners.blur();
    resolve({ content: afterContent, contentHash: "a".repeat(64) });
    await pending;
    assert.equal(h.reveals.length, focused ? 1 : 0);
    h.control.dispose();
  }
});
