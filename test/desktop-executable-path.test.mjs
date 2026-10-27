import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commonCliPath } from "../desktop/executable-path.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "argus-cli-path-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}
async function nodeAt(root, version, executable = true) {
  const bin = path.join(root, "versions", "node", version, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "node"), "fixture only", { mode: executable ? 0o700 : 0o600 });
  return bin;
}

test("Finder discovery appends Volta and numerically sorted nvm installs without disturbing existing priority", async t => {
  const home = await fixture(t), nvm = path.join(home, ".nvm");
  const bins = await Promise.all(["v22.9.0", "v22.10.0", "v24.1.0"].map(v => nodeAt(nvm, v)));
  const directories = (await commonCliPath({ PATH: "/custom:/usr/bin:/custom" }, home)).split(path.delimiter);
  assert.deepEqual(directories.slice(0, 2), ["/opt/homebrew/bin", "/usr/local/bin"]);
  assert.equal(directories.filter(v => v === "/custom").length, 1);
  assert.ok(directories.indexOf("/custom") < directories.indexOf(path.join(home, ".volta", "bin")));
  assert.deepEqual(directories.filter(v => v.startsWith(nvm)), [bins[2], bins[1], bins[0]]);
});

test("absolute custom manager roots work; relative roots and invalid/incomplete versions are ignored", async t => {
  const home = await fixture(t), nvm = path.join(home, "custom nvm"), volta = path.join(home, "custom volta");
  const valid = await nodeAt(nvm, "v24.3.1");
  await nodeAt(nvm, "v9999999.0.0");
  await nodeAt(nvm, "v99.1.0", false);
  await nodeAt(nvm, "not-a-version");
  const custom = (await commonCliPath({ NVM_DIR: nvm, VOLTA_HOME: volta }, home)).split(path.delimiter);
  assert.ok(custom.includes(path.join(volta, "bin")));
  assert.deepEqual(custom.filter(v => v.startsWith(nvm)), [valid]);
  const defaults = (await commonCliPath({ NVM_DIR: "relative", VOLTA_HOME: "relative" }, home)).split(path.delimiter);
  assert.ok(defaults.includes(path.join(home, ".volta", "bin")));
  assert.ok(defaults.every(v => path.isAbsolute(v)));
});

test("missing tools and inaccessible nvm trees do not prevent startup or execute shell profiles", async t => {
  const home = await fixture(t);
  await fs.writeFile(path.join(home, ".zshrc"), "throw new Error('must never execute')");
  const directories = (await commonCliPath({ PATH: "/usr/bin" }, home)).split(path.delimiter);
  assert.ok(directories.includes("/usr/bin"));
  assert.ok(directories.includes(path.join(home, ".volta", "bin")));
  assert.equal(directories.filter(v => v.includes(".nvm")).length, 0);
});

test("nvm discovery is bounded and refuses nondeterministic oversized directory subsets", async t => {
  const home = await fixture(t), nvm = path.join(home, ".nvm");
  await Promise.all(Array.from({ length: 66 }, (_, i) => nodeAt(nvm, `v22.${i}.0`)));
  let directories = (await commonCliPath({}, home)).split(path.delimiter).filter(v => v.startsWith(nvm));
  assert.equal(directories.length, 64);
  assert.ok(directories[0].includes("v22.65.0"));
  const root = path.join(nvm, "versions", "node");
  await Promise.all(Array.from({ length: 447 }, (_, i) => fs.writeFile(path.join(root, `unrelated-${i}`), "")));
  directories = (await commonCliPath({}, home)).split(path.delimiter).filter(v => v.startsWith(nvm));
  assert.deepEqual(directories, []);
});
