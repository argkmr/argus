import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildSourceBundle } from "../scripts/build-source-bundle.mjs";

test("packaged source includes implementations but excludes nested credential/data/build material", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "argus-source-fixture-"));
  try {
    const keep = ["README.md", "backend/src/KeychainSecretStore.java", "scripts/architecture-report/build.py", "frontend/package.json", "backend/src/main/resources/backup-owner-public-key.txt"];
    const omit = ["server/index.mjs", ".argus-data/state.json", "backend/.env", "backend/nested/.env.test", "backend/nested/.AWS/config", "frontend/.npmrc", "backend/.ssh/id_rsa", "backend/.git-credentials", "backend/private-key.pem", "backend/credentials.json", "backend/private-secrets/config.json", "backend/git-recovery/file.txt", "backend/target/fake.class", "frontend/node_modules/pkg/index.js", "frontend/.next/cache.json"];
    omit.push("backend/id_rsa", "docs/id_ed25519", "frontend/kubeconfig");
    omit.push("scripts/architecture-report/__pycache__/build.cpython-312.pyc", "scripts/stale.pyc", "scripts/stale.pyo");
    omit.push("backend/logs/application.log", "backend/logs/application.log.1", "backend/crash.hprof", "frontend/recording.jfr");
    omit.push("backend/src/main/resources/backup-owner.json", "docs/Argus Owner/backup-owner.json", "docs/Argus Owner Signing/backup-owner-private.pem");
    for (const file of [...keep, ...omit]) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), file); }
    await fs.symlink(path.join(root, "backend/.env"), path.join(root, "backend/innocent.txt"));
    const output = await buildSourceBundle(root);
    for (const file of keep) assert.equal(await fs.readFile(path.join(output, file), "utf8"), file);
    for (const file of [...omit, "backend/innocent.txt"]) await assert.rejects(fs.access(path.join(output, file)));
    await fs.writeFile(path.join(output, "stale.txt"), "old generated content");
    await buildSourceBundle(root);
    await assert.rejects(fs.access(path.join(output, "stale.txt")));
    assert.equal(await fs.readFile(path.join(root, "backend/.env"), "utf8"), "backend/.env");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
