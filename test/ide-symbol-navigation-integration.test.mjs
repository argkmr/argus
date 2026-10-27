import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { resolveDiffNavigationPosition } from "../public/diff-navigation.mjs";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = app.indexOf("async function navigateEmbeddedDiff(");
const source = app.slice(start, app.indexOf("\n}", start) + 2);

function harness() {
  const text = '@Value("${service.base-url:http://localhost}")', calls = [], reveals = [];
  const context = { repositoryId: "repo-a", file: "src/Config.java", afterContent: text, beforeContent: text };
  let active = true;
  const environment = vm.createContext({ resolveDiffNavigationPosition,
    api: async (url, options) => {
      calls.push({ url, options });
      return url.includes("/ide/file?") ? { content: text, contentHash: "a".repeat(64) }
        : { locations: [{ path: "application.yml", line: 2, column: 3 }] };
    },
    repositoryIdeBridge: { revealNavigation: async (...args) => { reveals.push(args); return true; } },
  });
  vm.runInContext(source, environment);
  return { calls, reveals, context, active: value => { active = value; },
    navigate: (kind, word = "service.base-url") => environment.navigateEmbeddedDiff(context,
      { side: "after", line: 1, column: text.indexOf("service.base-url") + 1, word, kind }, () => active) };
}

test("embedded diff forwards every supported semantic action with its verified source hash", async () => {
  for (const kind of ["definition", "declaration", "typeDefinition", "references", "implementation"]) {
    const h = harness(); assert.equal(await h.navigate(kind), true);
    assert.equal(h.calls[1].options.body.kind, kind);
    assert.equal(h.calls[1].options.body.expectedHash, "a".repeat(64));
    assert.equal(h.reveals.length, 1);
    assert.equal(h.reveals[0][2].kind, kind);
  }
});

test("full configuration keys retain exact diff-to-working-file mapping", async () => {
  const h = harness(); assert.equal(await h.navigate("definition"), true);
  assert.equal(h.calls[1].options.body.column, 11);
  const stale = harness(); await assert.rejects(stale.navigate("declaration", "wrong.key"), /cannot be mapped safely/);
  assert.equal(stale.calls.length, 1); assert.equal(stale.reveals.length, 0);
});

test("navigating away while the saved file loads cancels all semantic actions", async () => {
  const h = harness(), navigation = h.navigate("typeDefinition"); h.active(false);
  assert.equal(await navigation, false); assert.equal(h.calls.length, 1); assert.equal(h.reveals.length, 0);
});
