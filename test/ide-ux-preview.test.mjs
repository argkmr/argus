import test from "node:test";
import assert from "node:assert/strict";
import { createIdeUxServices } from "./fixtures/ide-ux-services.mjs";
import { createIdeRunControls } from "../public/ide-run-controls.mjs";
import { createPreviewServer } from "./fixtures/ide-ux-preview.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));

test("preview logs provide selected-process snapshots for the Copy all UI smoke check", async () => {
  const fixture = createIdeUxServices();
  const process = await fixture.api(`/api/run-configurations/${fixture.configurations[0].id}/start`, { method: "POST" });
  const path = `/api/processes/${process.id}/logs`;
  const result = await fixture.api(`${path}?after=0`);
  assert.equal(result.cursor, 32); assert.equal(result.logs.length, 32); assert.equal(result.dropped, 0);
  assert.match(result.logs[0].line, /no application was launched/);
  assert.equal(result.logs.at(-1).stream, "stderr");
  assert.equal((await fixture.api(`${path}?after=32`)).logs.length, 0);
  await assert.rejects(fixture.api("/api/processes/real-process/logs"), /Unknown synthetic process/);
});

test("isolated preview uses one Services process list for IDE Run, Debug and Services Stop", async () => {
  const fixture = createIdeUxServices(), shared = [];
  const controls = createIdeRunControls({ api: fixture.api, onProcesses: value => shared.push(value) });
  controls.setContext({ repository: fixture.repositories[0], configurations: fixture.configurations, processes: [] });
  const launched = await controls.run("debug");
  assert.equal(launched.configurationId, fixture.configurations[0].id);
  assert.equal(launched.debug.state, "listening");
  assert.equal(controls.state.currentProcess.id, fixture.processes[0].id);
  assert.equal(shared.at(-1)[0].id, fixture.processes[0].id);
  assert.equal(await controls.run("run"), null, "the same configuration cannot be launched twice");
  await fixture.api(`/api/run-configurations/${launched.configurationId}/stop`, { method: "POST" });
  await controls.refresh();
  assert.equal(controls.state.label, "Stopped"); assert.equal(controls.state.canRun, true);
  controls.dispose();
});

test("delayed preview launch retains its original repo and cannot attach after repo switch", async () => {
  const fixture = createIdeUxServices(), started = [];
  const controls = createIdeRunControls({ api: fixture.api, onStarted: value => started.push(value) });
  controls.setContext({ repository: fixture.repositories[0], configurations: fixture.configurations, processes: [] });
  fixture.delayNextStart(); const launching = controls.run("debug"); await flush();
  assert.equal(fixture.pendingLaunch, fixture.configurations[0].id);
  assert.equal(controls.state.busy, "debug");
  controls.setContext({ repository: fixture.repositories[1] });
  assert.equal(controls.state.selectedConfiguration.repositoryId, fixture.repositories[1].id);
  assert.equal(fixture.releaseStart(), true); await launching;
  assert.equal(started.length, 0); assert.equal(controls.state.currentProcess, null);
  assert.equal(fixture.processes[0].repositoryId, fixture.repositories[0].id);
  assert.equal(fixture.calls.filter(call => call.path.endsWith("/start")).length, 1);
  controls.dispose();
});

test("preview terminal transport stays per repo and never interprets typed shell input", async () => {
  const fixture = createIdeUxServices();
  for (const repository of fixture.repositories) {
    const route = `/api/repositories/${repository.id}/terminal`;
    const session = await fixture.api(`${route}/start`, { method: "POST" });
    assert.equal(session.cwd, repository.path);
    assert.ok(session.chunks[0].data.includes(repository.branch));
    assert.ok(session.chunks[0].data.includes("no shell was launched"));
    const result = await fixture.api(`${route}/input`, { method: "POST", body: { sessionId: session.id, input: "rm /synthetic-do-not-execute\r" } });
    assert.equal(result.chunks.at(-1).data.includes("input was not executed"), true);
    assert.equal(result.chunks.some(chunk => chunk.data.includes("rm /")), false);
  }
});

test("preview asset server cannot forward mutations or backend requests", async t => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(base)).text();
  assert.match(page, /class="task-context-visible repository-ide-enabled" data-view="repository"/);
  assert.match(page, /href="\/legacy\/repository-ide-shell\.css"/);
  assert.equal((await fetch(`${base}/ide-ux-services.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/api/processes`)).status, 404);
  assert.equal((await fetch(`${base}/api/run-configurations/x/start`, { method: "POST" })).status, 405);
});
