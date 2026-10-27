import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("disconnect-only confirmation and long action remain contained at narrow widths and enlarged text", { timeout:45_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "argus-alignment-audit-363-"));
  const env = { ...process.env, AUDIT_KINDS:"close-repo-dialog", AUDIT_WIDTHS:"1440,380,320",
    AUDIT_HEIGHTS:"900,557", AUDIT_ZOOMS:"1,1.22", AUDIT_ASSERT_ACTIONS:"1" };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve,reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/alignment-audit-363-electron.cjs", import.meta.url)), temporary], { env, detached:true, stdio:["ignore","pipe","pipe"] });
      let output = "";
      const collect = chunk => { output = (output + chunk).slice(-30000); };
      child.stdout.on("data",collect); child.stderr.on("data",collect);
      const timer = setTimeout(() => { try { process.kill(-child.pid,"SIGKILL"); } catch { child.kill("SIGKILL"); } },40_000);
      child.once("error",error => { clearTimeout(timer); reject(error); });
      child.once("close",code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
    });
    const { network, results } = JSON.parse(await readFile(join(temporary,"alignment-audit-363-results.json"),"utf8"));
    assert.equal(network,0); assert.equal(results.length,48);
    for (const result of results) {
      const diagnostic = JSON.stringify(result);
      assert.equal(result.error,undefined,diagnostic);
      assert.equal(result.bodyOverflow,false,diagnostic);
      assert.deepEqual(result.issues,[],diagnostic);
      assert.deepEqual(result.trapped,[],diagnostic);
      const actions = result.actionRows.flatMap(row => row.buttons);
      assert.equal(actions.length,2,diagnostic);
      assert.ok(actions.some(action => action.text === "Disconnect & keep data"),diagnostic);
      for (const action of actions) {
        assert.ok(action.bounds.left >= result.bounds.left && action.bounds.right <= result.bounds.right + 1,diagnostic);
        assert.ok(action.bounds.top >= result.bounds.top && action.bounds.bottom <= result.bounds.bottom + 1,diagnostic);
      }
    }
  } finally {
    if (process.env.ARGUS_OFFBOARD_CAPTURE === "1") console.log(`Offboarding layout captures: ${temporary}`);
    else await rm(temporary,{ recursive:true,force:true });
  }
});
