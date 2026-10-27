import test from "node:test";
import assert from "node:assert/strict";
import { createIdeCodeChat } from "../public/ide-code-chat.mjs";

class Element {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; }
  children = []; listeners = new Map(); attributes = new Map(); style = {}; dataset = {};
  hidden = false; disabled = false; value = ""; className = ""; isConnected = true; open = false;
  clientWidth = 800; clientHeight = 700; offsetHeight = 510; scrollHeight = 400; scrollTop = 0;
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + (this.html || "").replace(/<[^>]*>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&") + this.children.map(child => child.textContent).join(""); }
  set innerHTML(value) { assert.equal(this.className, "chat-message-content", "Only safe assistant Markdown gets HTML"); this.html = value; }
  get innerHTML() { return this.html || ""; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.text = ""; this.append(...nodes); }
  remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
  dispatch(name, values = {}) { return Promise.all((this.listeners.get(name) || []).map(listener => listener({ preventDefault() {}, stopPropagation() {}, ...values }))); }
  focus() { this.ownerDocument.activeElement = this; this.focused = true; }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1))
      : selector.startsWith("[") ? node.getAttribute(selector.slice(1, selector.indexOf("="))) === selector.slice(selector.indexOf('"') + 1, selector.lastIndexOf('"')) : node.tagName === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitUntil = async (condition, message) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await wait(5);
  }
};
const anchor = { version: 1, path: "src/review.js", line: 4, column: 1, endLine: 6, endColumn: 20, side: "source", selection: "const rating = '<img src=x onerror=bad>';", unsaved: true, symbol: "createReview" };
const saved = (id = "d1", job = null, extra = {}) => ({ taskId: "code-task", discussion: { id, anchor, nexusTaskId: null }, messages: [{ id: "m1", role: "user", content: "Explain <script>bad()</script>" }, { id: "m2", role: "assistant", content: "The rating is saved." }], job, status: job?.status || "completed", requestId: "request-1", ...extra });
function harness(override, options = {}) {
  const doc = { createElement: tag => new Element(tag, doc) }, host = new Element("main", doc), trigger = new Element("button", doc);
  doc.activeElement = trigger;
  const calls = [], changes = [], opened = [], errors = []; let counter = 0;
  const h = { calls, changes, opened, errors, doc, host, trigger };
  const api = async (path, opts = {}) => {
    calls.push({ path, ...opts });
    const custom = override?.(path, opts, h); if (custom !== undefined) return custom;
    if (path.startsWith("/api/ai-tasks?")) return [{ id: "nexus-1", title: "Cross-service flow" }];
    if (opts.method === "DELETE") return { ok: true };
    if (path.endsWith("/ask")) return saved("created");
    if (path.endsWith("/code-discussions")) return { taskId: "code-task", discussions: [saved().discussion, saved("d2").discussion] };
    return saved(path.split("/").at(-1));
  };
  h.chat = createIdeCodeChat({ host, document: doc, api, randomUUID: () => `request-${++counter}`, onChanged: value => changes.push(value), onOpenTask: value => opened.push(value), onError: error => errors.push(error), getModelSettings: () => ({ provider: "codex", model: "model-1", effort: "low", speed: "standard", unrelated: "not sent" }), pollDelay: 20, ...options });
  h.find = selector => host.querySelector(selector);
  h.open = values => h.chat.open({ repositoryId: "repo-1", anchor, ...values });
  h.type = async value => { h.find("textarea").value = value; await h.find("textarea").dispatch("input"); };
  h.send = async () => { await h.find("form").dispatch("submit"); await settle(); };
  return h;
}

test("code popup is lazy, nonmodal, scoped, safe and shows a read-only snapshot", async () => {
  const h = harness(); assert.equal(h.calls.length, 0); assert.equal(h.find(".ide-code-chat").hidden, true);
  await h.open();
  assert.equal(h.find(".ide-code-chat").getAttribute("aria-modal"), "false");
  assert.equal(h.find("pre").textContent, anchor.selection); assert.match(h.find("summary").textContent, /Unsaved selection.*src\/review.js:4–6/);
  assert.match(h.find(".ide-code-chat-snapshot-note").textContent, /Read-only snapshot/);
  assert.equal(h.doc.activeElement, h.find("textarea")); assert.equal(h.find(".ide-code-chat-send").disabled, true);
  await h.type("Why does this happen?");
  const nexus = h.find('[aria-label="Optional Nexus context"]'); nexus.value = "nexus-1"; await nexus.dispatch("change");
  await h.send(); const ask = h.calls.find(call => call.method === "POST");
  assert.equal(ask.path, "/api/repositories/repo-1/code-discussions/ask");
  assert.deepEqual(ask.body, { anchor, prompt: "Why does this happen?", nexusTaskId: "nexus-1", requestId: "request-1", provider: "codex", model: "model-1", effort: "low", speed: "standard" });
  assert.match(h.find(".ide-code-chat-transcript").textContent, /Explain <script>bad\(\)<\/script>/);
  assert.equal(h.find("textarea").value, ""); assert.equal(h.changes.length, 1);
  await h.find(".ide-code-chat-open").dispatch("click");
  assert.deepEqual(h.opened[0], { repositoryId: "repo-1", taskId: "code-task", discussionId: "created" });
  h.chat.dispose();
});

test("saved discussions stay accessible without a live code anchor", async () => {
  const h = harness(); await h.open({ anchor: undefined });
  assert.equal(h.find("textarea").disabled, true); assert.match(h.find(".ide-code-chat-empty").textContent, /Select code/);
  const select = h.find('[aria-label="Code discussion"]'); assert.equal(select.children.length, 3);
  select.value = "d2"; await select.dispatch("change"); await settle();
  assert.equal(h.find("textarea").disabled, false); assert.match(h.find(".ide-code-chat-snapshot-note").textContent, /saved snapshot/);
  await h.type("Follow up"); await h.send(); const request = h.calls.find(call => call.method === "POST");
  assert.equal(request.body.discussionId, "d2"); assert.equal(request.body.anchor, undefined); h.chat.dispose();
});

test("a full-chat navigation error keeps the popup and draft intact", async () => {
  const h = harness(undefined, { onOpenTask: async () => { throw new Error("Chat could not be opened"); } });
  await h.open({ discussionId: "d1" }); await h.type("Keep this question");
  await h.find(".ide-code-chat-open").dispatch("click");
  assert.match(h.find('[role="alert"]').textContent, /Chat could not be opened/);
  assert.equal(h.find("textarea").value, "Keep this question");
  assert.equal(h.find(".ide-code-chat").hidden, false);
  h.chat.dispose();
});

test("switching repositories aborts reads and ignores a late response even if cancellation was ignored", async () => {
  const first = deferred(); const h = harness(path => path === "/api/repositories/repo-1/code-discussions" ? first.promise : undefined);
  const opening = h.open(); await settle(); const oldRead = h.calls.find(call => call.path.endsWith("code-discussions"));
  await h.open({ repositoryId: "repo-2", anchor: { ...anchor, path: "new.js" } });
  first.resolve({ taskId: "wrong", discussions: [{ id: "wrong", title: "WRONG OLD REPOSITORY" }] }); await opening;
  assert.equal(oldRead.signal.aborted, true); assert.doesNotMatch(h.host.textContent, /WRONG OLD REPOSITORY/);
  assert.match(h.find("summary").textContent, /new.js/); h.chat.dispose();
});

test("drafts belong to discussions and reopen restores the right one", async () => {
  const h = harness(); await h.open({ discussionId: "d1" }); await h.type("draft one");
  await h.open({ discussionId: "d2" }); await h.type("draft two");
  h.chat.close(); await h.open({ discussionId: "d1" }); assert.equal(h.find("textarea").value, "draft one");
  await h.open({ discussionId: "d2" }); assert.equal(h.find("textarea").value, "draft two"); h.chat.dispose();
});

test("close during submit does not cancel it, duplicate sends are blocked and a late acknowledgement stays in its repository", async () => {
  const sent = deferred(); const h = harness((path, opts) => opts.method === "POST" ? sent.promise : undefined);
  await h.open(); await h.type("first request"); await h.send(); await h.send();
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(h.calls.find(call => call.method === "POST").signal, undefined);
  h.chat.close(); await h.open({ repositoryId: "repo-2", anchor: { ...anchor, path: "other.js" } }); await h.type("second repository draft");
  sent.resolve(saved("original-created")); await settle();
  assert.equal(h.find("textarea").value, "second repository draft"); assert.match(h.find("summary").textContent, /other.js/);
  assert.equal(h.changes[0].repositoryId, "repo-1");
  assert.equal(h.calls.filter(call => call.method === "DELETE").length, 0); h.chat.dispose();
});

test("typing a new draft during a submission is never cleared by its acknowledgement", async () => {
  const sent = deferred(); const h = harness((path, opts) => opts.method === "POST" ? sent.promise : undefined);
  await h.open(); await h.type("submitted prompt"); await h.send(); await h.type("next thought"); sent.resolve(saved("created")); await settle();
  assert.equal(h.find("textarea").value, "next thought"); h.chat.dispose();
});

test("uncertain delivery retries the exact immutable request, retains newer drafts and never creates a new request ID", async () => {
  let attempts = 0; const h = harness((path, opts) => opts.method === "POST" && attempts++ === 0 ? Promise.reject(new Error("Connection ended")) : undefined);
  await h.open(); await h.type(" original prompt "); await h.send();
  assert.equal(h.find(".ide-code-chat-retry").hidden, false); assert.equal(h.find(".ide-code-chat-send").disabled, true);
  await h.type("new unsent thought"); await h.find(".ide-code-chat-retry").dispatch("click"); await settle();
  const posts = h.calls.filter(call => call.method === "POST"); assert.equal(posts.length, 2); assert.deepEqual(posts[1].body, posts[0].body);
  assert.equal(h.find("textarea").value, "new unsent thought"); assert.equal(h.find(".ide-code-chat-retry").hidden, true); h.chat.dispose();
});

test("validation errors keep the draft editable without claiming uncertain delivery", async () => {
  const h = harness((path, opts) => opts.method === "POST" ? Promise.reject(Object.assign(new Error("Bad model"), { status: 400 })) : undefined);
  await h.open(); await h.type("draft"); await h.send();
  assert.equal(h.find(".ide-code-chat-retry").hidden, true); assert.equal(h.find("textarea").value, "draft");
  assert.equal(h.find(".ide-code-chat-send").disabled, false); assert.equal(h.find(".ide-code-chat-error").textContent, "");
  assert.match(h.host.textContent, /Bad model/); h.chat.dispose();
});

test("live detail polling renders only safe display output and notifies once when the request ends", async t => {
  let reads = 0; const h = harness(path => path.endsWith("/d1") ? saved("d1", ++reads < 3
    ? { id: "job-1", status: "running", displayOutput: "Working on the selected code", output: "SECRET NDJSON RAW", outputFormat: "ndjson" }
    : { id: "job-1", status: "completed", displayOutput: "final" }) : undefined);
  t.after(() => h.chat.dispose());
  await h.open({ discussionId: "d1" }); assert.match(h.host.textContent, /Working on the selected code/); assert.doesNotMatch(h.host.textContent, /SECRET/);
  await waitUntil(() => reads >= 3 && h.find(".ide-code-chat-stop").hidden, "The third detail read must deliver the completed request");
  assert.equal(reads, 3); assert.equal(h.changes.length, 1);
  // Observe beyond a poll interval to prove terminal state does not schedule again.
  assert.equal(h.find(".ide-code-chat-stop").hidden, true); await wait(30); assert.equal(reads, 3);
});

test("closing stops polling and aborts an in-flight read, reopening recovers persisted results", async t => {
  let reads = 0; const late = deferred(); const h = harness(path => path.endsWith("/d1") ? ++reads === 2 ? late.promise : saved("d1", { id: "job", status: reads > 2 ? "completed" : "running", displayOutput: "live" }) : undefined);
  t.after(() => h.chat.dispose());
  await h.open({ discussionId: "d1" });
  await waitUntil(() => reads >= 2, "A second detail read must be in flight before closing");
  assert.equal(reads, 2); h.chat.close();
  const detailRead = h.calls.filter(call => call.path.endsWith("/d1")).at(-1); assert.equal(detailRead.signal.aborted, true);
  late.resolve(saved("d1", { id: "job", status: "running", displayOutput: "OLD LIVE" })); await settle(); await wait(30);
  assert.equal(reads, 2); assert.equal(h.find(".ide-code-chat").hidden, true);
  await h.open({ discussionId: "d1" }); assert.equal(reads, 3); assert.equal(h.find(".ide-code-chat-stop").hidden, true);
});

test("explicit stop cancels preparation and catches a late-starting job", async () => {
  const sent = deferred(); const h = harness((path, opts) => opts.method === "POST" ? sent.promise : undefined);
  await h.open(); await h.type("start"); await h.send();
  await h.find(".ide-code-chat-stop").dispatch("click");
  assert.equal(h.calls.find(call => call.method === "DELETE").path, "/api/agents/preparations/request-1");
  sent.resolve(saved("created", { id: "late-job", status: "running" })); await settle();
  assert.equal(h.calls.filter(call => call.method === "DELETE")[1].path, "/api/agents/jobs/late-job");
  assert.equal(h.calls.filter(call => call.method === "DELETE")[1].headers["X-Argus-Cancel-Control"], "ide-code-discussion-stop"); h.chat.dispose();
});

test("a preparation reopened from persistent history can be stopped using its original request ID", async () => {
  let stopped = false;
  const h = harness((path, opts) => {
    if (opts.method === "DELETE") { stopped = true; return { ok: true }; }
    if (path.endsWith("/d1")) return saved("d1", null, { status: stopped ? "cancelled" : "preparing", requestId: "persisted-request" });
  });
  await h.open({ discussionId: "d1" }); assert.equal(h.find(".ide-code-chat-stop").hidden, false);
  await h.find(".ide-code-chat-stop").dispatch("click");
  assert.equal(h.calls.find(call => call.method === "DELETE").path, "/api/agents/preparations/persisted-request");
  assert.match(h.find(".ide-code-chat-status").textContent, /Request stopped/); h.chat.dispose();
});

test("a failed stop after confirmed submission never turns the already accepted prompt into an uncertain retry", async t => {
  let detailReads = 0;
  const sent = deferred(); const h = harness((path, opts) => opts.method === "POST" ? sent.promise
    : path.includes("/agents/jobs/") ? Promise.reject(new Error("Stop unavailable"))
    // Failed cancellation leaves this provider job running. The generic fixture
    // returns completed details, which used to race this test's Stop assertion.
    : path.endsWith("/created") ? (++detailReads, saved("created", { id: "job", status: "running" })) : undefined);
  t.after(() => h.chat.dispose());
  await h.open(); await h.type("start"); await h.send(); await h.find(".ide-code-chat-stop").dispatch("click");
  sent.resolve(saved("created", { id: "job", status: "running" }));
  await waitUntil(() => h.errors.some(error => error.message === "Stop unavailable")
    && h.changes.some(change => change.job?.id === "job") && detailReads >= 1,
  "The acknowledged running job must report its failed stop and survive a detail poll");
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(h.find("textarea").value, "");
  assert.equal(h.find(".ide-code-chat-retry").hidden, true); assert.equal(h.find(".ide-code-chat-stop").hidden, false);
});

test("failed reads offer refresh and optional Nexus failure does not block a repository-only question", async () => {
  let fail = true; const h = harness(path => path.startsWith("/api/ai-tasks") ? Promise.reject(new Error("offline"))
    : path.endsWith("/code-discussions") && fail ? Promise.reject(new Error("Cannot load <index>")) : undefined);
  await h.open(); assert.equal(h.find(".ide-code-chat-refresh").hidden, false); assert.match(h.host.textContent, /Cannot load <index>/);
  fail = false; await h.find(".ide-code-chat-refresh").dispatch("click"); await h.type("without Nexus"); await h.send();
  assert.equal(h.calls.find(call => call.method === "POST").body.nexusTaskId, null); assert.match(h.host.textContent, /Nexus chats could not be loaded/); h.chat.dispose();
});

test("Escape restores focus, deactivate does not steal focus, and dispose ignores late submission changes", async () => {
  const sent = deferred(); const h = harness((path, opts) => opts.method === "POST" ? sent.promise : undefined);
  await h.open(); await h.find(".ide-code-chat").dispatch("keydown", { key: "Escape" });
  assert.equal(h.doc.activeElement, h.trigger); assert.equal(h.find(".ide-code-chat").hidden, true);
  await h.open(); const other = new Element("button", h.doc); other.focus(); h.chat.deactivate(); assert.equal(h.doc.activeElement, other);
  await h.open(); await h.type("in flight"); await h.send(); h.chat.dispose(); sent.resolve(saved("created")); await settle();
  assert.equal(h.host.children.length, 0); assert.equal(h.changes.length, 0); assert.equal(h.calls.filter(call => call.method === "DELETE").length, 0);
});

test("code snapshots distinguish old and new diff sides and placement stays within the IDE host", async () => {
  const h = harness(); h.host.clientWidth = 320; h.host.clientHeight = 350;
  await h.open({ anchor: { ...anchor, side: "before", staged: true }, position: { left: 900, top: 800 } });
  assert.match(h.find("summary").textContent, /Before diff/); assert.match(h.find(".ide-code-chat-snapshot-note").textContent, /staged diff/);
  const card = h.find(".ide-code-chat"); assert.equal(card.style.width, "304px"); assert.equal(card.style.left, "8px"); assert.equal(card.style.top, "8px");
  await h.open({ anchor: { ...anchor, side: "after" } }); assert.match(h.find("summary").textContent, /After diff/); h.chat.dispose();
});

test("assistant Markdown uses the shared escaping renderer while user prompts and code remain literal", async () => {
  const h = harness(path => path.endsWith("/d1") ? saved("d1", null, { messages: [
    { role: "user", content: "**literal prompt** <img src=x onerror=bad>" },
    { role: "assistant", content: "**Summary**\n\n- First\n- Second\n\n```java\nreturn review;\n```\n\n<script>alert(1)</script> [bad](javascript:alert(1))" },
  ] }) : undefined);
  await h.open({ discussionId: "d1" });
  const rendered = h.find(".chat-message-content").innerHTML;
  assert.match(rendered, /<strong>Summary<\/strong>/); assert.match(rendered, /class="chat-code-block"/); assert.match(rendered, /<ul class="chat-list">/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(rendered, /<script|href="javascript:/);
  assert.equal(h.find(".ide-code-chat-message-text").textContent, "**literal prompt** <img src=x onerror=bad>");
  assert.equal(h.find(".ide-code-chat-model").textContent, "Read-only · codex / model-1"); h.chat.dispose();
});

test("HTTP-success launch failure preserves the prompt and shows the provider error without a duplicate-retry claim", async () => {
  const h = harness((path, opts) => opts.method === "POST" ? saved("created", null, { status: "failed", error: "Provider not authenticated" }) : undefined);
  await h.open(); await h.type("keep my question"); await h.send();
  assert.equal(h.find("textarea").value, "keep my question"); assert.match(h.host.textContent, /Provider not authenticated/);
  assert.match(h.find(".ide-code-chat-status").textContent, /Request failed/); assert.equal(h.find(".ide-code-chat-retry").hidden, true); h.chat.dispose();
});

test("a submit acknowledgement beats a stale reopen detail without leaving the popup stuck loading", async () => {
  let reads = 0; const sent = deferred(), oldDetail = deferred();
  const h = harness((path, opts) => opts.method === "POST" ? sent.promise : path.endsWith("/d1") && ++reads === 2 ? oldDetail.promise : undefined);
  await h.open({ discussionId: "d1" }); await h.type("submitted"); await h.send(); h.chat.close();
  const reopening = h.open({ discussionId: "d1" }); await settle();
  assert.equal(h.find(".ide-code-chat").getAttribute("aria-busy"), "true");
  sent.resolve(saved("d1", null, { messages: [{ role: "assistant", content: "Fresh acknowledged answer" }] })); await settle();
  assert.equal(h.find(".ide-code-chat").getAttribute("aria-busy"), "false");
  oldDetail.resolve(saved("d1", null, { messages: [{ role: "assistant", content: "STALE READ" }] })); await reopening;
  assert.match(h.host.textContent, /Fresh acknowledged answer/); assert.doesNotMatch(h.host.textContent, /STALE READ/); h.chat.dispose();
});

test("host notification failure cannot relabel an acknowledged submission as uncertain", async () => {
  const h = harness(undefined, { onChanged() { throw new Error("Host refresh failed"); } });
  await h.open(); await h.type("one question"); await h.send();
  assert.equal(h.find("textarea").value, ""); assert.equal(h.find(".ide-code-chat-retry").hidden, true);
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1); assert.equal(h.errors[0].message, "Host refresh failed"); h.chat.dispose();
});
