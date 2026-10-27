import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildJavaRuntime, validateRuntimeProperties } from "../scripts/build-java-runtime.mjs";

test("bundled runtime is Java 17 and matches the native release architecture", () => {
  assert.doesNotThrow(() => validateRuntimeProperties(" java.specification.version = 17\n os.arch = aarch64\n", "arm64"));
  for (const version of ["8", "11", "21", "25", "unknown"]) {
    assert.throws(() => validateRuntimeProperties(`java.specification.version = ${version}\nos.arch = aarch64`, "arm64"), /Java 17/);
  }
  assert.throws(() => validateRuntimeProperties("java.specification.version = 17\nos.arch = x86_64", "arm64"), /architecture mismatch/);
  assert.throws(() => validateRuntimeProperties("", "arm64"), /Java 17/);
});

test("incompatible JAVA_HOME and unsupported target cannot delete an existing runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-runtime-build-"));
  try {
    const jdk = path.join(root, "jdk"), output = path.join(root, "build/runtime-arm64");
    fs.mkdirSync(jdk); fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(jdk, "release"), 'JAVA_VERSION="25.0.2"\nOS_ARCH="aarch64"\n');
    fs.writeFileSync(path.join(output, "sentinel"), "previous runtime");
    let calls = 0;
    const options = {root, environment: {JAVA_HOME: jdk}, platform: "darwin", architecture: "arm64", run: () => {calls++;return "";}, probe: () => 'java.specification.version = 25\nos.arch = aarch64'};
    assert.throws(() => buildJavaRuntime(options), /Java 17/);
    assert.throws(() => buildJavaRuntime({...options, architecture: "x64"}), /macOS arm64/);
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(path.join(output, "sentinel"), "utf8"), "previous runtime");
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

for (const fail of [true, false]) test(`runtime staging ${fail ? "failure preserves old output" : "promotes only a verified runtime"}`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-runtime-stage-"));
  try {
    const jdk = path.join(root, "jdk"), output = path.join(root, "build/runtime-arm64");
    fs.mkdirSync(jdk); fs.mkdirSync(output, {recursive: true});
    const release = 'JAVA_VERSION="17.0.18"\nOS_ARCH="aarch64"\n';
    fs.writeFileSync(path.join(jdk, "release"), release);
    fs.writeFileSync(path.join(output, "sentinel"), "previous runtime");
    const calls = [];
    const run = (executable, args) => {
      calls.push(path.basename(executable));
      if (path.basename(executable) === "jlink") {
        const target = args[args.indexOf("--output") + 1];
        assert.notEqual(target, output);
        assert.equal(fs.readFileSync(path.join(output, "sentinel"), "utf8"), "previous runtime");
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, "release"), release);
        if (fail) throw new Error("Synthetic jlink failure");
      }
      return "";
    };
    const probe = executable => { calls.push(path.basename(executable)); return 'java.specification.version = 17\nos.arch = aarch64'; };
    const options = {root, environment: {JAVA_HOME: jdk}, platform: "darwin", architecture: "arm64", run, probe};
    if (fail) {
      assert.throws(() => buildJavaRuntime(options), /Synthetic jlink failure/);
      assert.equal(fs.readFileSync(path.join(output, "sentinel"), "utf8"), "previous runtime");
    } else {
      assert.equal(buildJavaRuntime(options), output);
      assert.equal(fs.readFileSync(path.join(output, "release"), "utf8"), release);
      assert.deepEqual(calls, ["java", "jlink", "java"]);
    }
    assert.deepEqual(fs.readdirSync(path.join(root, "build")), ["runtime-arm64"]);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

for (const scenario of ["staged-mismatch", "promotion-failure", "rollback-failure"]) test(`runtime ${scenario} retains the known-good runtime`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-runtime-recovery-"));
  try {
    const jdk = path.join(root, "jdk"), output = path.join(root, "build/runtime-arm64");
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, "sentinel"), "known-good");
    let staging;
    const run = (_executable, args) => {
      const target = args[args.indexOf("--output") + 1];
      staging = path.dirname(target);
      fs.mkdirSync(target);
      return "";
    };
    const probe = executable => `java.specification.version = ${scenario === "staged-mismatch" && !executable.startsWith(jdk) ? "25" : "17"}\nos.arch = aarch64`;
    const rename = (from, to) => {
      if (path.basename(from) === "runtime") {
        if (scenario === "rollback-failure") {
          fs.mkdirSync(output); fs.writeFileSync(path.join(output, "external"), "do not erase");
        }
        throw new Error("Synthetic promotion failure");
      }
      if (path.basename(from) === "previous" && scenario === "rollback-failure") throw new Error("Synthetic rollback failure");
      fs.renameSync(from, to);
    };
    const options = {root, environment: {JAVA_HOME: jdk}, platform: "darwin", architecture: "arm64", run, probe, rename};
    assert.throws(() => buildJavaRuntime(options), scenario === "staged-mismatch" ? /Java 17/ : scenario === "rollback-failure" ? /Previous runtime preserved/ : /Synthetic promotion failure/);
    if (scenario === "rollback-failure") {
      assert.equal(fs.readFileSync(path.join(staging, "previous/sentinel"), "utf8"), "known-good");
      assert.equal(fs.readFileSync(path.join(output, "external"), "utf8"), "do not erase");
    } else {
      assert.equal(fs.readFileSync(path.join(output, "sentinel"), "utf8"), "known-good");
      assert.equal(fs.existsSync(staging), false);
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
