import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const appearance = app.slice(app.indexOf("const appearancePreferenceWrites ="), app.indexOf("function applyFontSize("));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function harness({ storageUnavailable = false } = {}) {
  const requests = [], messages = [], cache = new Map(), elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", title: "", attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); }, querySelector: child => element(`${selector} ${child}`) });
    return elements.get(selector);
  };
  const document = { documentElement: { dataset: { theme: "dark" } } };
  const state = { currentView: "global", activeGlobalTaskId: "running-chat", globalJob: { id: "active-job", status: "running" }, repositoryDrafts: { "repo-a": "unsent draft" } };
  const context = vm.createContext({
    document, state, $: element,
    localStorage: { setItem(key, value) { if (storageUnavailable) throw Error("Unavailable"); cache.set(key, value); } },
    api(url, options) { const request = deferred(); requests.push({ url, options, ...request }); return request.promise; },
    toast: (message, type) => messages.push({ message, type }),
  });
  vm.runInContext(appearance, context);
  return { context, document, state, requests, messages, cache, element };
}

test("appearance paints immediately and persists only its key without touching chats or jobs", async () => {
  const h = harness(), before = JSON.stringify(h.state);
  const saved = h.context.applyTheme("light");
  assert.equal(h.document.documentElement.dataset.theme, "light");
  assert.equal(h.cache.get("argus-theme"), "light");
  assert.equal(h.element("#theme-menu-label").textContent, "Dark mode");
  assert.equal(h.element("#theme-toggle").attributes.get("aria-label"), "Switch to dark mode");
  assert.equal(h.requests.length, 0);
  await Promise.resolve();
  assert.equal(h.requests[0].url, "/api/preferences");
  assert.equal(JSON.stringify(h.requests[0].options), JSON.stringify({ method: "PATCH", body: { theme: "light" } }));
  h.requests[0].resolve({ theme: "light" }); await saved;
  assert.equal(JSON.stringify(h.state), before);
});

test("an in-flight appearance save finishes before the latest selection is sent", async () => {
  const h = harness();
  const first = h.context.applyTheme("light"); await Promise.resolve();
  const latest = h.context.applyTheme("dark");
  assert.equal(h.document.documentElement.dataset.theme, "dark");
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ theme: "light" }); await first; await Promise.resolve();
  assert.equal(h.requests[1].options.body.theme, "dark");
  assert.equal(h.document.documentElement.dataset.theme, "dark");
  h.requests[1].resolve({ theme: "dark" }); await latest;
  assert.deepEqual(h.messages, []);
});

test("rapid queued appearances coalesce to the latest selection", async () => {
  const h = harness();
  const first = h.context.applyTheme("light"), middle = h.context.applyTheme("dark"), latest = h.context.applyTheme("light");
  await first; await middle; await Promise.resolve();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.body.theme, "light");
  h.requests[0].resolve(); await latest;
});

test("an obsolete appearance failure cannot toast or revert a newer selection", async () => {
  const h = harness();
  const first = h.context.applyTheme("light"); await Promise.resolve();
  const latest = h.context.applyTheme("dark");
  h.requests[0].reject(Error("offline")); await first; await Promise.resolve();
  assert.deepEqual(h.messages, []);
  assert.equal(h.document.documentElement.dataset.theme, "dark");
  h.requests[1].resolve(); await latest;
});

test("the latest appearance failure is visible and choosing the same mode retries", async () => {
  const h = harness();
  const first = h.context.applyTheme("light"); await Promise.resolve();
  h.requests[0].reject(Error("offline")); await first;
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].type, "error");
  assert.match(h.messages[0].message, /could not be saved.*retry/);
  assert.equal(h.document.documentElement.dataset.theme, "light");
  const retry = h.context.applyTheme("light"); await Promise.resolve();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(); await retry;
});

test("blocked localStorage cannot prevent appearance painting or Java persistence", async () => {
  const h = harness({ storageUnavailable: true });
  const saved = h.context.applyTheme("light"); await Promise.resolve();
  assert.equal(h.document.documentElement.dataset.theme, "light");
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(); await saved;
});

test("nonpersistent appearance restoration performs no writes and unsupported modes normalize to dark", async () => {
  const h = harness();
  h.context.applyTheme("light", false);
  assert.equal(h.document.documentElement.dataset.theme, "light");
  h.context.applyTheme("invalid", false); await Promise.resolve();
  assert.equal(h.document.documentElement.dataset.theme, "dark");
  assert.equal(h.cache.size, 0);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.messages, []);
});
