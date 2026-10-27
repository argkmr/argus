import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

test("terminal dependencies are pinned and bundled locally with licenses", async () => {
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.devDependencies["@xterm/xterm"], "6.0.0");
  assert.equal(pkg.devDependencies["@xterm/addon-fit"], "0.11.0");
  for (const [pkgName, source, target] of [
    ["xterm", "lib/xterm.mjs", "xterm.mjs"],
    ["xterm", "css/xterm.css", "xterm.css"],
    ["xterm", "LICENSE", "LICENSE-xterm"],
    ["addon-fit", "lib/addon-fit.mjs", "addon-fit.mjs"],
    ["addon-fit", "LICENSE", "LICENSE-addon-fit"],
  ]) {
    const [installed, bundled] = await Promise.all([
      fs.readFile(new URL(`../node_modules/@xterm/${pkgName}/${source}`, import.meta.url)),
      fs.readFile(new URL(`../public/vendor/xterm/${target}`, import.meta.url)),
    ]);
    assert.deepEqual(bundled, installed, target);
  }
  const sync = await fs.readFile(new URL("../scripts/sync-next-assets.mjs", import.meta.url), "utf8");
  assert.match(sync, /import "\.\/vendor-terminal\.mjs"/);
});

test("bundled ESM terminal imports do not conflict with Monaco's AMD loader", async () => {
  const original = globalThis.define;
  globalThis.define = Object.assign(() => { throw Error("Terminal must not register anonymous AMD modules"); }, { amd: {} });
  try {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("../public/vendor/xterm/xterm.mjs"),
      import("../public/vendor/xterm/addon-fit.mjs"),
    ]);
    assert.equal(typeof Terminal, "function");
    assert.equal(typeof FitAddon, "function");
  } finally {
    if (original === undefined) delete globalThis.define;
    else globalThis.define = original;
  }
});
