import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("desktop, Next shell, and legacy assets share package argusBuild", () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const legacy = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const desktop = fs.readFileSync(path.join(root, "desktop", "main.mjs"), "utf8");
  const page = fs.readFileSync(path.join(root, "frontend", "app", "page.jsx"), "utf8");
  const layout = fs.readFileSync(path.join(root, "frontend", "app", "layout.jsx"), "utf8");

  assert.match(metadata.argusBuild, /^\d{8}-\d+$/);
  assert.ok(legacy.includes(`app.js?v=${metadata.argusBuild}`));
  assert.ok(legacy.includes(`styles.css?v=${metadata.argusBuild}`));
  assert.ok(legacy.includes(`planner-time-picker.css?v=${metadata.argusBuild}`));
  assert.match(layout, /planner-time-picker\.css\?v=\$\{argusBuild\}/);
  const planner = fs.readFileSync(path.join(root, "public", "daily-planner.mjs"), "utf8");
  assert.ok(planner.includes(`planner-time-picker.mjs?v=${metadata.argusBuild}`));
  const explorer = fs.readFileSync(path.join(root, "public", "json-explorer.js"), "utf8");
  assert.ok(explorer.includes(`json-source-ranges.mjs?v=${metadata.argusBuild}`));
  const processLogs = fs.readFileSync(path.join(root, "public", "ide-process-logs.mjs"), "utf8");
  assert.ok(processLogs.includes(`process-log-format.mjs?v=${metadata.argusBuild}`), "IDE log formatter must use the current build cache key");
  assert.match(desktop, /appMetadata\.argusBuild/);
  assert.match(page, /argusBuild/);
  assert.match(layout, /argusBuild/);
  for (const source of [desktop, page, layout]) {
    assert.doesNotMatch(source, /2026\d{4}-\d+/);
  }
});
