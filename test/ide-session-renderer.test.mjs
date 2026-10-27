import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "./fixtures/ide-ux-preview.mjs";

// One private asset origin survives two separate Electron process lifetimes.
// Neither process opens Argus, its backend, any repository or the user's profile.
test("real Monaco reopens the last file, cursor and scroll after a process restart without persisting source", { timeout: 95_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-ide-session-"));
  const server = createPreviewServer(), serveAssets = server.listeners("request")[0];
  let backendRequests = 0;
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url.startsWith("/api/")) backendRequests++;
    if (request.url === "/session-qa") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; frame-src 'self' about:; connect-src 'self'; object-src 'none'" });
      response.end(`<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Isolated IDE session restart QA</title><link rel="stylesheet" href="/legacy/styles.css"><link rel="stylesheet" href="/legacy/repository-ide.css"><style>body{display:flex;flex-direction:column;font:13px/1.4 system-ui,sans-serif}.fixture-header{flex:none;padding:8px 14px;color:var(--muted)}.fixture-header input{width:170px;margin-left:12px}#ide{flex:1;min-height:0}</style></head><body class="repository-ide-enabled" data-view="repository"><header class="fixture-header">ISOLATED QA · Last file and viewport · Synthetic disk only<input id="outside-focus" aria-label="Keep external focus" value="Outside editor"></header><main id="ide"></main></body></html>`);
      return;
    }
    void serveAssets(request, response);
  });
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const run = phase => new Promise((resolve, reject) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/ide-session-electron.cjs", import.meta.url)), temporary, phase, origin],
      { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = chunk => { output = (output + chunk.toString()).slice(-20_000); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 40_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(output)); return; }
      try { resolve(JSON.parse(output.match(/IDE_SESSION_RENDERER_RESULT=(.+)/)?.[1] || "{}")); }
      catch (error) { reject(error); }
    });
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const written = await run("write"), restored = await run("restore");
    for (const result of [written, restored]) {
      assert.equal(result.ok, true); assert.equal(result.sandboxed, true);
      assert.equal(result.windowClosed, true); assert.equal(result.externalRequests, 0);
      assert.equal(result.fileWrites, 0); assert.deepEqual(result.errors, []);
    }
    assert.notEqual(written.pid, restored.pid, "Restoration must cross a real Electron process boundary");
    assert.equal(written.unsavedDiscardPrompts, 1, "Close uses the normal unsaved-draft guard, not destroy/dispose");
    assert.equal(restored.unsavedDiscardPrompts, 0);
    assert.equal(restored.metadataOnly, true); assert.equal(restored.diskReloaded, true);
    assert.equal(restored.focusPreserved, true); assert.equal(restored.repositoryIsolation, true);
    for (const name of ["alpha", "beta"]) {
      assert.deepEqual(restored.views[name].position, written.views[name].position, `${name}: cursor survives restart`);
      assert.equal(restored.views[name].path, written.views[name].path, `${name}: repository's own last file restores`);
      assert.ok(Math.abs(restored.views[name].scrollTop - written.views[name].scrollTop) <= 2, `${name}: vertical viewport survives restart`);
      assert.ok(Math.abs(restored.views[name].scrollLeft - written.views[name].scrollLeft) <= 2, `${name}: horizontal viewport survives restart`);
      assert.ok(written.views[name].scrollTop > 500, `${name}: test exercises a genuinely scrolled document`);
    }
    assert.equal(backendRequests, 0, "No request reaches an actual backend endpoint");
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (process.env.ARGUS_IDE_SESSION_CAPTURE === "1") console.log(`IDE session restart captures: ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
});
