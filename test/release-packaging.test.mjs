import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire, isBuiltin } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { finalizeRelease, releaseArtifactNames } from "../scripts/finalize-mac-release.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeEntry = "desktop/canvas-sharing.mjs";

// Follow the real desktop sharing graph, not a hand-maintained dependency list.
// The renderer bundler can otherwise hide a dev-only import from desktop tests.
async function runtimeImports() {
  const files = new Set(), packages = new Map();
  async function visit(relative) {
    if (files.has(relative)) return;
    files.add(relative);
    const source = ts.createSourceFile(relative, await fs.readFile(path.join(repositoryRoot, relative), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const specifiers = [];
    function inspect(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    for (const specifier of specifiers) {
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        const target = path.normalize(path.join(path.dirname(relative), specifier));
        assert.ok(!target.startsWith("..") && !path.isAbsolute(target), `Runtime import escapes package: ${relative} → ${specifier}`);
        await visit(target);
      } else {
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (!packages.has(name)) packages.set(name, relative);
      }
    }
  }
  await visit(runtimeEntry);
  return { files, packages };
}

test("desktop Canvas runtime import closure uses production dependencies", async () => {
  const metadata = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  const { packages } = await runtimeImports();
  for (const [name, importer] of packages) {
    assert.ok(metadata.dependencies?.[name], `${importer} imports ${name}, which must be a production dependency for the packaged desktop app`);
    assert.equal(lock.packages[""].dependencies?.[name], metadata.dependencies[name], `Lockfile root production dependency differs for ${name}`);
    assert.notEqual(lock.packages[`node_modules/${name}`]?.dev, true, `${name} is still marked dev-only in the package lock`);
  }
});

test("desktop Canvas bridge imports in an isolated production-only package", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "argus-production-runtime-"));
  try {
    const archive = process.env.ARGUS_RELEASE_TEST_ASAR;
    if (archive) {
      // Optional release gate: import the actual signed payload, with no access
      // to the checkout's node_modules and without starting Electron or a server.
      const { extractFile, listPackage, statFile } = await import("@electron/asar");
      for (const entry of listPackage(archive)) {
        const relative = entry.replace(/^\//, "");
        if (!(relative === "package.json" || relative === runtimeEntry || relative.startsWith("canvas-server/") || relative.startsWith("frontend/features/diagrams/") || relative.startsWith("node_modules/"))) continue;
        const stat = statFile(archive, relative);
        if (stat.files) continue;
        assert.ok(!stat.link, `Unexpected runtime package symlink: ${relative}`);
        const target = path.join(root, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, extractFile(archive, relative));
      }
    } else {
      const metadata = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
      await fs.copyFile(path.join(repositoryRoot, "package.json"), path.join(root, "package.json"));
      const { files } = await runtimeImports();
      for (const relative of files) {
        await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await fs.copyFile(path.join(repositoryRoot, relative), path.join(root, relative));
      }
      const copied = new Set();
      async function copyDependency(name, parent) {
        if (copied.has(name)) return;
        copied.add(name);
        let directory = path.dirname(createRequire(path.join(parent, "package.json")).resolve(name));
        let descriptor;
        while (true) {
          descriptor = await fs.readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse).catch(() => null);
          if (descriptor?.name === name) break;
          const next = path.dirname(directory);
          assert.notEqual(next, directory, `Cannot locate production package ${name}`);
          directory = next;
        }
        await fs.cp(directory, path.join(root, "node_modules", name), {
          recursive: true, filter: candidate => path.basename(candidate) !== "node_modules",
        });
        for (const child of Object.keys(descriptor.dependencies || {})) await copyDependency(child, directory);
      }
      for (const name of Object.keys(metadata.dependencies || {})) await copyDependency(name, repositoryRoot);
    }
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const bridge = await import('./${runtimeEntry}'); if (typeof bridge.createDesktopCanvasSharing !== 'function') throw new Error('Canvas bridge export missing');`], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Production-only Canvas import failed:\n${result.stderr}`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("local release names are build-specific and produce no duplicate app or Drive copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "argus-release-fixture-"));
  try {
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({version:"0.1.0",argusBuild:"fixture-309"}));
    await fs.writeFile(path.join(root,"dist","Argus-0.1.0-arm64.dmg"), "fixture disk image");
    await fs.writeFile(path.join(root,"dist","Argus-0.1.0-arm64.dmg.blockmap"), "fixture blockmap");
    const release=await finalizeRelease({root});
    assert.equal(path.basename(release),"Argus-0.1.0-build-fixture-309-arm64.dmg");
    assert.equal(await fs.readFile(release,"utf8"),"fixture disk image");
    assert.deepEqual((await fs.readdir(path.join(root,"dist"))).sort(),[path.basename(release),`${path.basename(release)}.blockmap`]);
    assert.equal(await finalizeRelease({root}),release);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("release identifiers cannot escape the artifact directory", () => {
  assert.throws(()=>releaseArtifactNames({version:"0.1.0",argusBuild:"../../outside"}),/Invalid/);
  assert.throws(()=>releaseArtifactNames({version:"0.1.0",argusBuild:""}),/Invalid/);
});
