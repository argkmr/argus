import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createGitStashActions, initializeGitStashes } from "../public/git-stash.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("stash confirmation is not affected by a global Git outside-click dismissal handler", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /document\.addEventListener\("pointerdown", \(event\) => \{\s*if \(!document\.body\.classList\.contains\("version-control-dock-open"\)\)/);
  assert.match(source, /\$\("#close-git-panel"\)\.addEventListener\("click", \(\) => \{\s*setVersionControlDockOpen\(false\)/);
});

test("background dialog cleanup leaves the stash confirmation lifecycle intact", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function closeOpenDialogs(");
  const end = source.indexOf("\n}", start);
  assert.match(source.slice(start, end), /dialog\.id === "git-stash-dialog"/);
});

test("both shipped shells load stash styles and modal overrides bound and scroll the confirmation", async () => {
  const layout = await fs.readFile(new URL("../frontend/app/layout.jsx", import.meta.url), "utf8");
  const index = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../public/git-stash.css", import.meta.url), "utf8");
  assert.match(layout, /legacy\/git-stash\.css\?v=/);
  assert.match(index, /href="\/git-stash\.css\?v=/);
  const rule = css.slice(css.indexOf("body .git-stash-dialog[open]"));
  for (const declaration of ["calc(100% - 32px)", "display: block", "padding: 20px", "overflow: auto", "backdrop-filter: none"]) assert.ok(rule.includes(declaration));
});

function actionsHarness({ request = async () => ({ ok: true }), busy = new Set(), refresh = async () => {} } = {}) {
  let repository = { id: "repo/a b", name: "Repository A" };
  const calls = [], invalidations = [], refreshes = [];
  const mutate = createGitStashActions({
    getRepository: () => repository,
    busyRepositories: busy,
    request: (url, options) => { calls.push({ url, options }); return request(url, options); },
    invalidate: () => invalidations.push(calls.length),
    refresh: async (id) => { refreshes.push(id); await refresh(id); },
  });
  return { mutate, busy, calls, invalidations, refreshes, get repository() { return repository; }, setRepository(value) { repository = value; } };
}

test("stash mutations reject missing/stale repository identity before locking or sending", async () => {
  const h = actionsHarness();
  for (const repository of [null, {}, { id: "repo-b" }]) await assert.rejects(h.mutate(repository, "stash", {}), /repository changed/i);
  h.setRepository(null);
  await assert.rejects(h.mutate({ id: "repo/a b" }, "stash", {}), /repository changed/i);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.invalidations, []);
  assert.equal(h.busy.size, 0);
});

test("stash respects the shared Git busy set and serializes concurrent mutations", async () => {
  const pending = deferred();
  const h = actionsHarness({ request: () => pending.promise });
  h.busy.add(h.repository.id);
  await assert.rejects(h.mutate(h.repository, "stash", {}), /already running/i);
  assert.equal(h.busy.has(h.repository.id), true, "must not clear another Git operation's lock");
  assert.equal(h.calls.length, 0);
  h.busy.delete(h.repository.id);
  const first = h.mutate(h.repository, "stash", { message: "one", includeUntracked: false });
  await assert.rejects(h.mutate(h.repository, "stash/pop", { id: "a".repeat(40), ref: "stash@{0}" }), /already running/i);
  assert.equal(h.calls.length, 1);
  assert.equal(h.busy.has(h.repository.id), true);
  pending.resolve({ ok: true, status: "created" });
  await first;
  assert.equal(h.busy.size, 0);
  assert.deepEqual(h.invalidations, [0, 1]);
  assert.deepEqual(h.refreshes, [h.repository.id]);
});

test("pop sends the exact captured SHA/ref and encoded repository route once", async () => {
  const h = actionsHarness();
  const payload = { id: "1234567890abcdef1234567890abcdef12345678", ref: "stash@{3}" };
  await h.mutate({ ...h.repository }, "stash/pop", payload);
  assert.deepEqual(h.calls, [{ url: "/api/repositories/repo%2Fa%20b/git/stash/pop", options: { method: "POST", body: payload } }]);
  assert.deepEqual(h.invalidations, [0, 1]);
});

test("switching repositories during a mutation never refreshes the new repository", async () => {
  const pending = deferred();
  const h = actionsHarness({ request: () => pending.promise });
  const first = h.mutate(h.repository, "stash", { includeUntracked: false });
  h.setRepository({ id: "repo-b", name: "Repository B" });
  pending.resolve({ ok: true });
  await first;
  assert.deepEqual(h.refreshes, []);
  assert.equal(h.busy.size, 0);
  assert.deepEqual(h.invalidations, [0, 1]);
  assert.equal(h.calls[0].url, "/api/repositories/repo%2Fa%20b/git/stash");
});

test("unknown network/server outcome is not retried or dropped and always releases the lock", async () => {
  for (const status of [undefined, 500, 503]) {
    const error = Object.assign(new Error("connection lost"), status ? { status } : {});
    const h = actionsHarness({ request: async () => { throw error; } });
    await assert.rejects(h.mutate(h.repository, "stash/pop", { id: "a".repeat(40), ref: "stash@{0}" }), /outcome could not be confirmed[\s\S]*has not retried/i);
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls.every(({ url }) => url.endsWith("/stash/pop")));
    assert.equal(h.busy.size, 0);
    assert.deepEqual(h.invalidations, [0, 1]);
    assert.deepEqual(h.refreshes, [h.repository.id]);
  }
});

test("known validation/conflict errors remain actionable and refresh failure cannot hide a successful mutation", async () => {
  const rejected = Object.assign(new Error("Working tree is not clean"), { status: 409 });
  const h = actionsHarness({ request: async () => { throw rejected; } });
  await assert.rejects(h.mutate(h.repository, "stash/pop", {}), (error) => error === rejected);
  assert.equal(h.busy.size, 0);
  const successful = actionsHarness({ refresh: async () => { throw Error("refresh failed"); } });
  assert.deepEqual(await successful.mutate(successful.repository, "stash", {}), { ok: true });
  assert.equal(successful.busy.size, 0);
});

function element(tag = "div") {
  const listeners = new Map(), classes = new Set();
  let value = "";
  return {
    tag, children: [], hidden: false, disabled: false, open: false, listeners, classes,
    get textContent() { return value + this.children.map((child) => child.textContent).join(""); },
    set textContent(text) { value = String(text); this.children = []; },
    set innerHTML(_) { throw Error("Stash UI must not interpolate HTML"); },
    classList: { contains: (key) => classes.has(key), add: (key) => classes.add(key), toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key) },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { value = ""; this.children = children; },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    trigger(name, overrides = {}) {
      const event = { prevented: false, preventDefault() { this.prevented = true; }, ...overrides };
      event.finished = Promise.all((listeners.get(name) || []).map((fn) => fn(event)));
      return event;
    },
    close() { this.open = false; this.trigger("close"); },
  };
}

function uiHarness({ request = async () => [], mutate = async () => ({ ok: true, status: "created" }) } = {}) {
  let repository = { id: "repo-a", name: "Repository A" };
  const nodes = new Map(), calls = [], mutations = [], dialogs = [];
  const node = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const form = node("#git-stash-form");
  form.elements = { message: { value: "" }, includeUntracked: { checked: false } };
  form.reset = () => { form.elements.message.value = ""; form.elements.includeUntracked.checked = false; };
  const document = { querySelector: node, createElement: element };
  const controller = initializeGitStashes({
    document,
    getRepository: () => repository,
    request: (url, options) => { calls.push({ url, options }); return request(url, options); },
    mutate: (repo, action, payload) => { mutations.push({ repo, action, payload }); return mutate(repo, action, payload); },
    showDialog: (id) => { dialogs.push(id); node(`#${id}`).open = true; },
  });
  return { node, form, calls, mutations, dialogs, controller, get repository() { return repository; }, setRepository(value) { repository = value; }, popButton(index = 0) { return node("#stash-list").children[index].children[1]; } };
}

const entry = (overrides = {}) => ({ id: "a".repeat(40), ref: "stash@{0}", subject: "WIP: local changes", createdAt: "2026-09-08T10:00:00Z", ...overrides });

test("stale stash GET completions cannot replace newer data or another repository's list", async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const h = uiHarness({ request: () => ++count === 1 ? first.promise : second.promise });
  const old = h.controller.refresh();
  const latest = h.controller.refresh();
  second.resolve([entry({ subject: "Latest stash" })]);
  await latest;
  first.resolve([entry({ subject: "Old stash" })]);
  await old;
  assert.match(h.node("#stash-list").textContent, /Latest stash/);
  assert.doesNotMatch(h.node("#stash-list").textContent, /Old stash/);
  assert.deepEqual(h.calls[0].options, { dedupe: false, cache: "no-store" });

  const switched = deferred();
  const other = uiHarness({ request: () => switched.promise });
  const loading = other.controller.refresh();
  other.setRepository({ id: "repo-b", name: "Repository B" });
  switched.resolve([entry({ subject: "Repository A secret title" })]);
  await loading;
  assert.doesNotMatch(other.node("#stash-list").textContent, /secret title/);
});

test("stale GET errors and repository invalidation cannot leak old failures or selections", async () => {
  const pending = deferred();
  const h = uiHarness({ request: () => pending.promise });
  const loading = h.controller.refresh();
  h.node("#stash-button").trigger("click");
  h.node("#git-stashes").classes.add("hidden");
  h.setRepository({ id: "repo-b", name: "Repository B" });
  h.controller.repositoryChanged();
  pending.reject(Error("Old repository error"));
  await loading;
  assert.equal(h.node("#git-stash-dialog").open, false);
  assert.equal(h.node("#stash-list").textContent, "");
  await h.form.trigger("submit").finished;
  assert.equal(h.mutations.length, 0);
});

test("stash metadata and errors render literally through textContent, never HTML", async () => {
  const malicious = '<img src=x onerror="alert(1)"><script>run()</script>';
  const h = uiHarness({ request: async () => [entry({ subject: malicious, ref: 'stash@{0}<svg onload="run()">' })] });
  await h.controller.refresh();
  assert.ok(h.node("#stash-list").textContent.includes(malicious));
  h.popButton().trigger("click");
  assert.ok(h.node("#git-stash-description").textContent.includes(malicious));
  assert.ok(h.node("#git-stash-title").textContent.includes("<svg"));
  const failure = uiHarness({ request: async () => { throw Error(malicious); } });
  await failure.controller.refresh();
  assert.equal(failure.node("#stash-list").textContent, malicious);
});

test("stash confirmation defaults to tracked files only and resets previous untracked consent", async () => {
  const h = uiHarness();
  h.form.elements.includeUntracked.checked = true;
  h.node("#stash-button").trigger("click");
  assert.equal(h.form.elements.includeUntracked.checked, false);
  h.form.elements.message.value = "  Named local stash  ";
  await h.form.trigger("submit").finished;
  assert.deepEqual(h.mutations[0], { repo: { id: "repo-a", name: "Repository A" }, action: "stash", payload: { message: "Named local stash", includeUntracked: false } });
  h.node("#stash-button").trigger("click");
  h.form.elements.includeUntracked.checked = true;
  await h.form.trigger("submit").finished;
  assert.equal(h.mutations[1].payload.includeUntracked, true);
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const checkbox = html.match(/<input[^>]*name="includeUntracked"[^>]*>/)?.[0];
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox, /\bchecked\b/);
});

test("pop confirmation freezes exact SHA/ref rather than a later list object mutation", async () => {
  const original = entry({ ref: "stash@{2}" });
  const h = uiHarness({ request: async () => [original] });
  await h.controller.refresh();
  h.popButton().trigger("click");
  original.id = "b".repeat(40);
  original.ref = "stash@{0}";
  await h.form.trigger("submit").finished;
  assert.deepEqual(h.mutations[0].payload, { id: "a".repeat(40), ref: "stash@{2}" });
  assert.equal(h.mutations[0].action, "stash/pop");
  assert.equal(h.node("#git-stash-fields").hidden, true);
});

test("pending stash blocks duplicate submission and dismissal without altering the captured request", async () => {
  const pending = deferred();
  const h = uiHarness({ mutate: () => pending.promise });
  h.node("#stash-button").trigger("click");
  const submit = h.form.trigger("submit").finished;
  await h.form.trigger("submit").finished;
  assert.equal(h.mutations.length, 1);
  assert.equal(h.node("#git-stash-confirm").disabled, true);
  assert.equal(h.node("#git-stash-cancel").disabled, true);
  assert.equal(h.node("#git-stash-confirm").textContent, "Stashing…");
  assert.equal(h.form.ariaBusy, "true");
  assert.equal(h.form.elements.message.disabled, true);
  assert.equal(h.form.elements.includeUntracked.disabled, true);
  assert.equal(h.node("#git-stash-dialog").trigger("cancel").prevented, true);
  h.node("#git-stash-cancel").trigger("click");
  assert.equal(h.node("#git-stash-dialog").open, true);
  h.setRepository({ id: "repo-b", name: "Repository B" });
  pending.resolve({ ok: true, status: "created" });
  await submit;
  assert.equal(h.node("#stash-notice").textContent, "");
  assert.equal(h.calls.length, 0, "completion must not load the new repository's stash list");
  assert.equal(h.node("#git-stash-cancel").disabled, false);
  assert.equal(h.form.ariaBusy, "false");
  assert.equal(h.node("#git-stash-dialog").open, false);
});

test("failed pop requires a fresh confirmation and never retries or drops automatically", async () => {
  let attempt = 0;
  const h = uiHarness({ request: async () => [entry()], mutate: async () => { if (++attempt === 1) throw Error("Outcome unknown; inspect the retained stash"); return { ok: true, status: "popped" }; } });
  await h.controller.refresh();
  h.popButton().trigger("click");
  await h.form.trigger("submit").finished;
  assert.equal(h.mutations.length, 1);
  assert.equal(h.node("#git-stash-confirm").disabled, true);
  assert.match(h.node("#git-stash-error").textContent, /Outcome unknown/);
  assert.equal(h.form.ariaBusy, "false");
  assert.equal(h.node("#git-stash-cancel").textContent, "Close");
  await h.form.trigger("submit").finished;
  assert.equal(h.mutations.length, 1, "disabled confirmation must also have no remaining selection");
  h.popButton().trigger("click");
  assert.equal(h.node("#git-stash-confirm").disabled, false);
  assert.equal(h.node("#git-stash-cancel").textContent, "Cancel");
  assert.equal(h.form.elements.message.disabled, false);
  assert.equal(h.form.elements.includeUntracked.disabled, false);
  await h.form.trigger("submit").finished;
  assert.equal(h.mutations.length, 2);
  assert.ok(h.mutations.every(({ action }) => action === "stash/pop"));
  assert.equal(h.node("#git-stash-dialog").open, false);
});

test("conflicted pop reports retained stash result and never issues a drop", async () => {
  const h = uiHarness({ request: async () => [entry()], mutate: async () => ({ ok: false, status: "conflicts", message: "Resolve conflicts; stash retained." }) });
  await h.controller.refresh();
  h.popButton().trigger("click");
  await h.form.trigger("submit").finished;
  assert.match(h.node("#stash-notice").textContent, /stash retained/);
  assert.equal(h.node("#stash-notice").classes.has("stash-error"), true);
  assert.equal(h.mutations.length, 1);
  assert.equal(h.mutations[0].action, "stash/pop");
  assert.equal(h.node("#git-stash-dialog").open, false);
});
