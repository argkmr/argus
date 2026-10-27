import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizeRepositoryTabGroups, normalizeRepositoryTabOrder, reconcileRepositoryTabOrder, reorderRepositoryTabs, repositoryTabLayout } from "../public/repository-tab-groups.js";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const repo = (id) => ({ type: "repository", id });
const group = (id) => ({ type: "group", id });
function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}
function harness() {
  const repositories = ["a", "b", "c"].map((id) => ({ id, name: id }));
  const groups = [{ id: "g", name: "Group", color: "blue", collapsed: false, repositoryIds: ["a", "b"] }];
  const state = { workspace: { repositories, preferences: { repositoryTabGroups: groups, theme: "dark" } }, activeRepository: repositories[0],
    backgroundJobsInitialized: true, backgroundJobStatuses: new Map([["job", "running"]]) };
  const reads = [], writes = [], rendered = [];
  let failure = null;
  const context = vm.createContext({
    runtimeStateSync: { revision: 0 },
    state, normalizeRepositoryTabGroups, normalizeRepositoryTabOrder, reconcileRepositoryTabOrder, reorderRepositoryTabs,
    $: () => ({ setAttribute() {}, open: false }),
    renderRepositoryTabs() { rendered.push(repositoryTabLayout(state.workspace.repositories, state.workspace.preferences.repositoryTabGroups, state.workspace.preferences.repositoryTabOrder)); },
    ownerVisibleBackgroundJobs: (jobs) => jobs, backgroundJobIsActive: (job) => job.status === "running",
    renderBackgroundJobs() {}, syncRepositoryWorkspacePresence() {}, activateRepository: async () => {}, toast() {},
    api: async (path, options) => {
      if (path === "/api/workspace") return new Promise((resolve) => reads.push({ resolve, options }));
      if (path === "/api/background-jobs") return [{ id: "job", type: "repository-onboarding", status: "completed" }];
      if (path === "/api/preferences") { writes.push(options.body); if (failure) throw failure; return {}; }
      throw new Error(path);
    },
  });
  vm.runInContext(["loadWorkspaceSnapshot", "repositoryTabGroups", "persistRepositoryTabLayout", "moveRepositoryTab", "refreshBackgroundJobs"].map(declaration).join("\n"), context);
  return { context, state, groups, reads, writes, rendered,
    fail(error) { failure = error; },
    async move() { await context.moveRepositoryTab({ source: group("g"), target: repo("c"), position: "after" }); },
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a completed-onboarding GET resolving after a tab save cannot revert its order", async () => {
  const h = harness(), snapshot = structuredClone(h.state.workspace);
  const pending = h.context.refreshBackgroundJobs();
  while (!h.reads.length) await Promise.resolve();
  await h.move();
  assert.equal(h.state.repositoryTabLayoutRevision, 1);
  h.reads[0].resolve(snapshot);
  await pending;
  assert.deepEqual(plain(h.state.workspace.preferences.repositoryTabOrder), [repo("c"), group("g")]);
  assert.deepEqual(h.rendered.at(-1).map((item) => item.type === "group" ? item.group.id : item.repository.id), ["c", "g"]);
});

test("a workspace read started before a service mutation cannot restore old launch settings", async () => {
  const h = harness();
  h.state.workspace.runConfigurations = [{ id: "service", port: 3000 }];
  const snapshot = structuredClone(h.state.workspace);
  const pending = h.context.loadWorkspaceSnapshot();
  h.context.runtimeStateSync.revision++;
  h.state.workspace.runConfigurations = [{ id: "service", port: 4000 }];
  h.reads[0].resolve(snapshot);
  assert.deepEqual(plain((await pending).runConfigurations), [{ id: "service", port: 4000 }]);
});

test("a workspace read cannot replace repositories or launches from a newer accepted runtime snapshot", async () => {
  const h = harness();
  h.state.workspace.runConfigurations = [{ id: "service-a", repositoryId: "a", port: 3000 }];
  const snapshot = structuredClone(h.state.workspace);
  snapshot.preferences.theme = "light";
  const pending = h.context.loadWorkspaceSnapshot();
  // The backend/another window changes state without a mutation from this renderer.
  // The runtime poll accepts that state while the older full workspace read is pending.
  h.state.workspace.repositories = [{ id: "b", name: "Renamed B" }, { id: "new", name: "New repository" }];
  h.state.workspace.runConfigurations = [{ id: "service-b", repositoryId: "b", port: 4000 }];
  h.context.runtimeStateSync.revision++;
  h.reads[0].resolve(snapshot);
  const result = await pending;
  assert.deepEqual(plain(result.repositories), [{ id: "b", name: "Renamed B" }, { id: "new", name: "New repository" }]);
  assert.deepEqual(plain(result.runConfigurations), [{ id: "service-b", repositoryId: "b", port: 4000 }]);
  assert.equal(result.preferences.theme, "light", "unrelated workspace preferences still refresh");
});

test("an older read preserves the most recent of multiple completed layout saves", async () => {
  const h = harness(), snapshot = structuredClone(h.state.workspace);
  const pending = h.context.loadWorkspaceSnapshot();
  await h.move();
  await h.context.moveRepositoryTab({ source: repo("a"), target: repo("b"), position: "after" });
  h.reads[0].resolve(snapshot);
  const result = await pending;
  assert.deepEqual(plain(result.preferences.repositoryTabOrder), [repo("c"), group("g")]);
  assert.deepEqual(plain(result.preferences.repositoryTabGroups[0].repositoryIds), ["b", "a"]);
  assert.equal(h.state.repositoryTabLayoutRevision, 2);
});

test("stale reads keep newly returned repository records, onboarded groups and unrelated preferences", async () => {
  const h = harness(), snapshot = structuredClone(h.state.workspace);
  snapshot.repositories[0].name = "Updated server name";
  snapshot.repositories.push({ id: "new-member", name: "New member" }, { id: "new-group-member", name: "New group" });
  snapshot.preferences.theme = "light";
  snapshot.preferences.repositoryTabGroups[0].repositoryIds.push("new-member");
  snapshot.preferences.repositoryTabGroups.push({ id: "onboarded", name: "Onboarded", color: "cyan", collapsed: true, repositoryIds: ["new-group-member"] });
  const pending = h.context.loadWorkspaceSnapshot();
  await h.move();
  h.reads[0].resolve(snapshot);
  const result = await pending;
  assert.equal(result.repositories, snapshot.repositories);
  assert.equal(result.repositories[0].name, "Updated server name");
  assert.equal(result.preferences.theme, "light");
  assert.deepEqual(plain(result.preferences.repositoryTabGroups), [
    { ...h.groups[0], repositoryIds: ["a", "b", "new-member"] }, snapshot.preferences.repositoryTabGroups[1],
  ]);
  assert.deepEqual(plain(result.preferences.repositoryTabOrder), [repo("c"), group("g"), group("onboarded")]);
});

test("stale reads cannot resurrect a deleted known group and normalize offboarded repositories", async () => {
  const h = harness(), snapshot = structuredClone(h.state.workspace);
  snapshot.repositories = snapshot.repositories.filter((repository) => repository.id !== "a");
  const pending = h.context.loadWorkspaceSnapshot();
  await h.context.persistRepositoryTabLayout([], [repo("c"), repo("b"), repo("a")]);
  h.reads[0].resolve(snapshot);
  const result = await pending;
  assert.deepEqual(plain(result.preferences.repositoryTabGroups), []);
  assert.deepEqual(plain(result.preferences.repositoryTabOrder), [repo("c"), repo("b")]);
  assert.equal(result.repositories, snapshot.repositories);
});

test("failed saves do not override valid server preferences in a concurrent refresh", async () => {
  const h = harness(), snapshot = structuredClone(h.state.workspace);
  snapshot.preferences.repositoryTabOrder = [repo("c"), group("g")];
  const pending = h.context.loadWorkspaceSnapshot();
  h.fail(new Error("Disk unavailable"));
  await h.move();
  h.reads[0].resolve(snapshot);
  assert.equal(await pending, snapshot);
  assert.equal(h.state.repositoryTabLayoutRevision, undefined);
});

test("reads after a save accept server changes and cannot reuse an older in-flight GET", async () => {
  const h = harness();
  await h.move();
  const snapshot = structuredClone(h.state.workspace);
  snapshot.preferences.repositoryTabGroups[0].name = "Server change";
  const pending = h.context.loadWorkspaceSnapshot();
  assert.deepEqual(plain(h.reads[0].options), { dedupe: false, cache: "no-store" });
  h.reads[0].resolve(snapshot);
  assert.equal(await pending, snapshot);
  assert.equal((app.match(/await api\("\/api\/workspace"/g) || []).length, 1, "every workspace GET uses the guarded loader");
  assert.doesNotMatch(app, /state\.workspace\s*=\s*await api\("\/api\/workspace"/);
});
