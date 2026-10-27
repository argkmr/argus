import test from "node:test";
import assert from "node:assert/strict";
import { describeIdeFileIcon, createIdeFileIcon } from "../public/ide-file-icons.mjs";

test("explorer icons recognize source, package, configuration and binary file types locally", () => {
  for (const [name, kind] of [["OrderService.java", "java"], ["index.tsx", "typescript"], ["app.mjs", "javascript"], ["job.py", "python"], ["Dockerfile-prod", "container"], [".gitignore", "git"], ["build.gradle.kts", "package"], ["package-lock.json", "package"], ["notes.json", "data"], ["README.md", "markdown"], ["logo.svg", "image"], ["gradlew", "terminal"], ["service.yaml", "config"], [".env.local", "config"], ["main.rs", "code"], ["unknown.file", "file"]]) {
    assert.equal(describeIdeFileIcon({ name }).kind, kind, name);
    assert.equal(describeIdeFileIcon({ path: "deep/folder/" + name }).kind, kind, name);
  }
  assert.deepEqual(describeIdeFileIcon({ name: "src", directory: true }), { kind: "folder", tone: "source" });
  assert.deepEqual(describeIdeFileIcon({ name: "tests", directory: true }), { kind: "folder", tone: "test" });
  assert.deepEqual(describeIdeFileIcon({ name: "node_modules", directory: true }), { kind: "folder", tone: "muted" });
});

test("file names cannot inject markup into decorative local icons", () => {
  const doc = { createElement: () => ({ dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }) };
  const icon = createIdeFileIcon(doc, { name: '<img src=x onerror="alert(1)">.java' });
  assert.equal(icon.dataset.kind, "java"); assert.equal(icon.attributes["aria-hidden"], "true");
  assert.match(icon.innerHTML, /<svg.*?focusable="false">/); assert.doesNotMatch(icon.innerHTML, /img|onerror|alert/);
  assert.doesNotMatch(icon.innerHTML, /href|http|src=/);
});
