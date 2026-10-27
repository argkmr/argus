import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { historyRequestAddress, historyEntryLabel, historyRowsMarkup } from "../public/api-request-history-view.mjs";

const entry = overrides => ({ id: "history-1", kind: "draft", name: "Order details", method: "GET", url: "https://api.example.test/orders?id=123", createdAt: "2026-09-23T08:00:00Z", ...overrides });

test("history identifies drafts, sent requests and errors without sending controls", () => {
  const markup = historyRowsMarkup([entry(), entry({ id: "history-2", kind: "sent", status: 201 }), entry({ id: "history-3", kind: "sent", status: 500 }), entry({ id: "history-4", kind: "failed" })]);
  assert.match(markup, />Draft<\/span>/);
  assert.match(markup, />Sent · 201<\/span>/);
  assert.match(markup, /class="api-history-kind failed">Sent · 500/);
  assert.match(markup, />Failed<\/span>/);
  assert.equal((markup.match(/data-api-history-id=/g) ?? []).length, 4);
  assert.equal((markup.match(/data-delete-api-history=/g) ?? []).length, 4);
  assert.doesNotMatch(markup, /type="submit"|onclick=|data-send/);
});

test("addresses never expose query values, fragments or URL credentials", () => {
  assert.equal(historyRequestAddress("https://user:password@api.example.test:8443/orders?token=secret#private"), "api.example.test:8443/orders");
  assert.equal(historyRequestAddress("{{baseUrl}}/orders?apiKey=secret#private"), "{{baseUrl}}/orders");
  assert.equal(historyRequestAddress("//user:password@host.test/orders?token=secret"), "//host.test/orders");
  assert.equal(historyRequestAddress("user:password@host.test/orders?token=secret"), "host.test/orders");
  assert.equal(historyRequestAddress("{{scheme}}://user:password@{{host}}/orders"), "{{scheme}}://{{host}}/orders");
  assert.equal(historyRequestAddress("curl -H 'Authorization: secret' https://example.test"), "Unparsed cURL draft");
  assert.equal(historyRequestAddress("/orders?token=secret"), "/orders");
  const markup = historyRowsMarkup([entry({ name: "", url: "https://user:password@api.example.test/orders?token=secret#private", headers: { authorization: "token" }, body: "private-body" })]);
  assert.doesNotMatch(markup, /password|secret|private|authorization|token=/);
  assert.match(markup, />api.example.test\/orders<\/strong>/);
  assert.equal(historyEntryLabel({ name: "" }), "No URL yet");
});

test("search is case insensitive and matches visible safe metadata only", () => {
  const items = [entry({ method: "POST", kind: "sent", status: 201 }), entry({ id: "history-2", name: "Account", url: "https://example.test/profile?token=confidential" })];
  for (const query of ["order", " POST ", "201", "api.example.test"]) {
    const markup = historyRowsMarkup(items, query);
    assert.match(markup, /data-api-history-id="history-1"/);
    assert.doesNotMatch(markup, /data-api-history-id="history-2"/);
  }
  assert.match(historyRowsMarkup(items, "confidential"), /No matching requests/);
  assert.match(historyRowsMarkup([], "anything"), /Previous requests will appear/);
});

test("untrusted metadata is escaped once and cannot create elements or handlers", () => {
  const markup = historyRowsMarkup([entry({ id: '"><img src=x>', name: '<script>alert("x")</script> & it\'s', method: '"><svg onload=bad>', url: "https://example.test/<tag>?password=hidden" })]);
  assert.doesNotMatch(markup, /<img|<script|<tag>|<svg onload/);
  assert.match(markup, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; it&#39;s/);
  assert.match(markup, /class="api-method HTTP"/);
  assert.match(historyRowsMarkup([entry({ name: "literal &#39;" })]), /literal &amp;#39;/);
});

test("invalid records and timestamps cannot break history rendering", () => {
  assert.match(historyRowsMarkup(null), /Previous requests/);
  assert.match(historyRowsMarkup([null, {}, { id: 12 }]), /Previous requests/);
  const markup = historyRowsMarkup([entry({ updatedAt: "not-a-date", createdAt: null, status: -100, kind: "sent" })]);
  assert.doesNotMatch(markup, /<time|Invalid Date|-100/);
  assert.match(markup, />Sent<\/span>/);
});

test("timestamps prefer last edit and preserve a machine-readable datetime", () => {
  const markup = historyRowsMarkup([entry({ updatedAt: "2026-09-24T09:30:00Z" })]);
  assert.match(markup, /datetime="2026-09-24T09:30:00.000Z"/);
  assert.doesNotMatch(markup, /2026-09-23/);
});

test("production sidebar exposes accessible history tabs, search and compact overlay controls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const [tab, pane] of [["api-saved-tab", "api-saved-pane"], ["api-history-tab", "api-request-history"]]) {
    assert.match(html, new RegExp(`id="${tab}"[^>]*role="tab"[^>]*aria-controls="${pane}"`));
    assert.match(html, new RegExp(`id="${pane}"[^>]*role="tabpanel"[^>]*aria-labelledby="${tab}"`));
  }
  assert.match(html, /for="api-history-search">Search request history/);
  assert.match(html, /id="api-history-status"[^>]*role="status"/);
  assert.match(html, /id="open-api-history"[^>]*aria-controls="api-request-sidebar"/);
  assert.match(html, /id="close-api-history"[^>]*aria-label="Close request history"/);
  assert.match(html, /Stored on this Mac. Requests may include sensitive data./);
});
