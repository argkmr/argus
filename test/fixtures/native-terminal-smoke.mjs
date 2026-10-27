// Isolated, opt-in packaged Java + native PTY smoke and browser fixture.
// node test/fixtures/native-terminal-smoke.mjs [--keep-running]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { developmentConfiguration, javaArguments } from "../../scripts/dev.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--keep-running"));
const keepRunning = args.includes("--keep-running");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "argus-terminal-347-"));
const home = path.join(temp, "home"), data = path.join(temp, "data"), repository = path.join(temp, "terminal-fixture");
const port = 4197, base = `http://127.0.0.1:${port}`, id = "terminal-fixture";
const env = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, ZDOTDIR: home, SHELL: "/bin/zsh",
  LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  ARGUS_AI_KIT_AUTO_REFRESH_ENABLED: "false", ARGUS_CODEX_EXECUTABLE: "/usr/bin/false",
};
for (const directory of [home, data, repository, path.join(repository, "subdir"), path.join(data, "api-collections")]) await fs.mkdir(directory, { recursive: true });
const git = (...arguments_) => execFileSync("/usr/bin/git", arguments_, { cwd: repository, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-q", "-b", "main");
await fs.writeFile(path.join(repository, "README.md"), "# Disposable terminal QA\n");
git("add", "README.md");
git("-c", "user.name=Argus QA", "-c", "user.email=qa@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture");
await fs.writeFile(path.join(data, "workspace.json"), JSON.stringify({ activeRepositoryId: id, repositories: [{ id, name: id, path: repository, addedAt: new Date().toISOString(), productionBranch: "main" }], preferences: { theme: "dark" }, runConfigurations: [] }));
const build = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).argusBuild;
const config = developmentConfiguration({ ...env, ARGUS_PORT: String(port), ARGUS_DATA_DIR: data, ARGUS_API_COLLECTIONS_DIR: path.join(data, "api-collections"), ARGUS_BUILD_ID: build }, root);
const java = path.join(root, "build/runtime-arm64/bin/java");
for (const file of [java, config.jar, config.environment.ARGUS_PROCESS_LAUNCHER]) await fs.access(file);
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
await new Promise(resolve => probe.close(resolve));
const child = spawn(java, [`-Duser.home=${home}`, ...javaArguments(config.jar)], { cwd: root, env: config.environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
let log = "", stopping = false;
for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { log = (log + bytes.toString()).slice(-16000); });
const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
const stop = () => {
  if (stopping || child.exitCode !== null) return;
  stopping = true;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
};
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, body, expected = 200) {
  const response = await fetch(`${base}${route}`, { ...(body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, expected, `${route} HTTP status`);
  return response.json();
}
const route = `/api/repositories/${id}/terminal`;
let session;
async function send(input) { await api(`${route}/input`, { sessionId: session.id, input }); }
async function waitForOutput(pattern, after = 0) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const snapshot = await api(`${route}?after=${after}`);
    const output = snapshot.chunks.map(chunk => chunk.data).join("").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    if (pattern.test(output)) return { snapshot, output };
    await delay(50);
  }
  throw Error(`Terminal output did not match ${pattern}`);
}
try {
  const readyDeadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < readyDeadline && child.exitCode === null) {
    try { const health = await api("/internal/health"); if (health.status === "ready") { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `Isolated backend failed startup: ${log}`);
  session = await api(`${route}/start`, {}, 201);
  assert.equal(session.pty, true); assert.match(session.shell, /zsh$/);
  await waitForOutput(/git:\(main\)/);
  let before = (await api(route)).cursor;
  await send("printf 'PTY=%s INTERACTIVE=%s\\n' $(test -t 0 && echo yes) $options[interactive]\r");
  await waitForOutput(/PTY=yes INTERACTIVE=on/, before);
  await api(`${route}/resize`, { sessionId: session.id, cols: 101, rows: 31 });
  before = (await api(route)).cursor;
  await send("stty size\r");
  await waitForOutput(/31 101/, before);
  before = (await api(route)).cursor;
  await send("git switch -qc feature/terminal-qa\r");
  await waitForOutput(/git:\(feature\/terminal-qa\)/, before);
  before = (await api(route)).cursor;
  await send("cd subdir\r");
  const changed = await waitForOutput(/subdir.*git:\(feature\/terminal-qa\)/, before);
  assert.equal(await fs.realpath(changed.snapshot.cwd), await fs.realpath(path.join(repository, "subdir")));
  before = (await api(route)).cursor;
  await send("printf '\u0928\u092e\u0938\u094d\u0924\u0947 \ud83d\udc4b\\n'\r");
  await waitForOutput(/\r\nनमस्ते 👋\r\n/, before);
  before = (await api(route)).cursor;
  await send("sleep 30\r"); await delay(150); await send("\x03");
  await waitForOutput(/git:\(feature\/terminal-qa\)/, before);
  const stale = "stale-session-id";
  for (const [operation, payload] of [["input", { input: "echo MUST_NOT_RUN\r" }], ["resize", { cols: 80, rows: 20 }], ["stop", {}], ["clear", {}]]) await api(`${route}/${operation}`, { sessionId: stale, ...payload }, 409);
  const blocked = await fetch(`${base}${route}/input`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" }, body: JSON.stringify({ sessionId: session.id, input: "echo MUST_NOT_RUN\r" }) });
  assert.equal(blocked.status, 403);
  assert.equal((await api(route)).running, true);
  console.log(JSON.stringify({ status: "PASS", build, nativeRuntime: java, temp, pid: child.pid, url: `${base}/repositories/${id}`, checks: ["interactive zsh PTY", "fallback colored branch prompt", "resize", "branch switch", "cwd update", "UTF-8", "Ctrl-C", "stale mutation guards", "cross-origin blocked"] }));
  if (keepRunning) {
    console.log("Ready for browser QA; SIGTERM this fixture runner to stop its isolated backend.");
    await exited;
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  stop();
  let drainTimer;
  const result = await Promise.race([exited, new Promise(resolve => { drainTimer = setTimeout(() => resolve(null), 15000); })]);
  clearTimeout(drainTimer);
  if (!result) { console.error(`Fixture backend did not drain; retained owned PID ${child.pid} for inspection.`); process.exitCode = 1; }
  process.off("SIGINT", stop); process.off("SIGTERM", stop);
  console.log(`Disposable fixture retained at ${temp}; user repositories and installed app were not changed.`);
}
