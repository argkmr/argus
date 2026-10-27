import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");

function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

function assertChevron(markup, name) {
  assert.match(markup, new RegExp(`<svg class="${name} disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"><\\/path><\\/svg>`));
  assert.doesNotMatch(markup, /[›⌄▾▼]/);
}

test("storage disclosures retain status and actions with a decorative SVG chevron", () => {
  const context = vm.createContext({ escapeHtml: String, formatBytes: value => `${value} B` });
  vm.runInContext(declaration("renderDataStorageCard"), context);
  const category = { id: "workspace", icon: "WS", title: "Workspace", summary: "Settings", protection: "Local", backup: "Included", detail: "Saved locally", openTarget: "data" };
  for (const available of [false, true]) {
    const markup = context.renderDataStorageCard(category, { locations: { workspace: "/synthetic/workspace" }, availability: { workspace: available }, diskUsage: { sizes: { workspace: 123 } } });
    assertChevron(markup, "storage-card-chevron");
    assert.match(markup, /<details data-storage-category="workspace"/);
    assert.match(markup, /data-copy-storage-path="\/synthetic\/workspace"/);
    assert.match(markup, /data-open-storage="data"/);
    assert.ok(markup.includes(available ? "123 B" : "On first use"));
  }
});

test("API collection SVGs preserve collapsed state, request controls, and saved toggle behavior", () => {
  const nodes = new Map(), writes = [];
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", textContent: "" });
    return nodes.get(selector);
  };
  const request = { id: "request-1", method: "GET", name: "Get status", url: "https://example.invalid/status" };
  const context = vm.createContext({
    $, state: { apiRequests: [request], apiCollections: [], activeApiRequest: request, collapsedApiCollections: new Set() },
    escapeHtml: String, ensureApiPreviewProtocol: String, resolvedApiPreview: String,
    buildApiCollectionTree: () => [{ key: "collection-1", name: "Service", path: ["Service"], requests: [request], children: [], requestCount: 1, collection: { id: "collection-1", name: "Service" } }],
    localStorage: { setItem: (key, value) => writes.push([key, value]) },
  });
  vm.runInContext(["renderApiRequestList", "toggleApiCollection"].map(declaration).join("\n"), context);
  for (const collapsed of [false, true, false]) {
    if (collapsed || writes.length) context.toggleApiCollection("collection-1");
    else context.renderApiRequestList();
    const markup = $("#api-request-list").innerHTML;
    assertChevron(markup, "api-collection-chevron");
    assert.match(markup, new RegExp(`data-api-collection-toggle="collection-1" aria-expanded="${!collapsed}"`));
    assert.match(markup, /data-api-request-id="request-1"/);
    assert.match(markup, /data-delete-api-collection="collection-1"/);
    assert.match(markup, /data-delete-api-request="request-1"/);
  }
  assert.deepEqual(writes, [["argus-collapsed-api-collections", '["collection-1"]'], ["argus-collapsed-api-collections", "[]"]]);
});
