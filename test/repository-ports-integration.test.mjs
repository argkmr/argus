import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
function declaration(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}
function harness() {
  const calls = [], messages = [], configuration = { id: "config-a", repositoryId: "repo-a", port: 8080 };
  const state = { currentView: "repository", activeRepository: { id: "repo-a" }, processes: [],
    workspace: { runConfigurations: [configuration], preferences: { theme: "dark" } },
    gitActionRepositories: new Set(), gitStatusVersion: 0 };
  let dirty = false, diffDirty = false, toolOpen = false;
  const context = vm.createContext({
    state, serviceOperations: new Map(), repositoryPortRefreshes: new Map(),
    repositoryPorts: { setContext: value => calls.push(["context", clone(value)]) },
    ideRunControls: { state: { selectedId: "config-a" } },
    document: { body: { classList: { contains: () => toolOpen } } },
    repositoryIdeBridge: {
      isFileDirty: () => dirty,
      invalidateSavedFile: (...args) => calls.push(["invalidate", ...args]),
      refreshAfterExternalChange: async (...args) => { calls.push(["editor", ...args]); return { failed: [] }; },
    },
    diffEditIsDirty: () => diffDirty,
    api: async (...args) => { calls.push(["api", ...args]); return { changed: true }; },
    withServiceOperation: async (id, mode, action) => { calls.push(["lock", id, mode]); return action(); },
    loadWorkspaceSnapshot: async () => ({ runConfigurations: [{ ...configuration, port: 8181 }], preferences: { theme: "unrelated-old-value" } }),
    renderServices: () => calls.push(["services"]), refreshVisibleGitStatus: async options => calls.push(["git", options]),
    toast: (...args) => messages.push(args),
  });
  vm.runInContext(["syncRepositoryPorts", "canEditRepositoryPortFile", "repositoryPortsApi", "repositoryPortSaved"].map(declaration).join("\n"), context);
  return { context, state, calls, messages, dirty(value) { dirty = value; }, diffDirty(value) { diffDirty = value; }, toolOpen(value) { toolOpen = value; } };
}

test("port control belongs to the repository context header without changing the IDE action group", () => {
  assert.match(html, /id="context-change-count"[\s\S]*?id="repository-ports" class="context-stat repository-ports"[\s\S]*?class="repository-context-actions"/);
  assert.match(html, /href="\/repository-ports\.css\?v=/);
  assert.match(app, /canEditFile: canEditRepositoryPortFile/);
  assert.match(app, /onSaved: repositoryPortSaved/);
});

test("port context follows the selected service and hides on other workspaces", () => {
  const h = harness(); h.context.syncRepositoryPorts();
  assert.equal(h.calls.at(-1)[1].visible, true); assert.equal(h.calls.at(-1)[1].selectedConfigurationId, "config-a");
  h.state.currentView = "global"; h.context.syncRepositoryPorts(); assert.equal(h.calls.at(-1)[1].visible, false);
  h.state.currentView = "repository"; h.toolOpen(true); h.context.syncRepositoryPorts(); assert.equal(h.calls.at(-1)[1].visible, false);
  h.toolOpen(false); h.state.activeRepository = { id: "repo-b" }; h.context.syncRepositoryPorts(); assert.equal(h.calls.at(-1)[1].repository.id, "repo-b");
});

test("header selection rehydrates cleared IDE context without allowing cross-repository selection", () => {
  const h = harness();
  h.context.syncIdeRunControls = () => h.calls.push(["rehydrate"]);
  h.context.ideRunControls.select = id => h.calls.push(["select", id]);
  vm.runInContext(declaration("selectRepositoryPortConfiguration"), h.context);
  h.context.selectRepositoryPortConfiguration("config-a", "repo-a");
  assert.deepEqual(h.calls, [["rehydrate"], ["select", "config-a"]]);
  h.calls.length = 0; h.context.selectRepositoryPortConfiguration("foreign", "repo-b");
  assert.deepEqual(h.calls, []);
});

test("port writes use Services mutual exclusion and refuse deleted configurations", async () => {
  const h = harness(), path = "/api/run-configurations/config-a/ports", options = { method: "POST", body: { configFile: "module/src/main/resources/application.yml", applicationPort: 8181 } };
  await h.context.repositoryPortsApi(path, options);
  assert.deepEqual(h.calls[0], ["lock", "config-a", "ports"]); assert.equal(h.calls[1][1], path);
  h.context.serviceOperations.set("config-a", { mode: "debug" });
  await assert.rejects(h.context.repositoryPortsApi(path, options), /service operation/);
  h.context.serviceOperations.clear(); h.state.workspace.runConfigurations = [];
  await assert.rejects(h.context.repositoryPortsApi(path, options), /no longer exists/);
  assert.equal(h.calls.filter(call => call[0] === "api").length, 1);
});

test("unsaved source, diff drafts and Git operations block port writes without discarding anything", async () => {
  const h = harness(), file = "src/main/resources/application.yml";
  h.dirty(true); assert.throws(() => h.context.canEditRepositoryPortFile("repo-a", file), /unsaved/);
  h.dirty(false); h.state.diffEditor = { repositoryId: "repo-a", file }; h.diffDirty(true);
  assert.throws(() => h.context.canEditRepositoryPortFile("repo-a", file), /unsaved/);
  h.diffDirty(false); h.state.gitActionRepositories.add("repo-a");
  assert.throws(() => h.context.canEditRepositoryPortFile("repo-a", file), /Git operation/);
  assert.deepEqual(h.calls, []);
});

test("saved ports update Services, clean editor buffers and Git without overwriting preferences or navigating", async () => {
  const h = harness(), paths = ["src/main/resources/application.yml", ".argus-data/environments/config-a.env"];
  await h.context.repositoryPortSaved({ affectedFiles: paths }, { repositoryId: "repo-a", configurationId: "config-a" });
  assert.equal(h.state.workspace.runConfigurations[0].port, 8181); assert.equal(h.state.workspace.preferences.theme, "dark");
  assert.deepEqual(h.calls.filter(call => call[0] === "invalidate").map(call => call[2]), paths);
  assert.ok(h.calls.some(call => call[0] === "git" && call[1].force === true)); assert.deepEqual(h.messages, []);
  h.state.activeRepository = { id: "repo-b" }; h.calls.length = 0;
  await h.context.repositoryPortSaved({ file: paths[0] }, { repositoryId: "repo-a", configurationId: "config-a" });
  assert.equal(h.state.activeRepository.id, "repo-b"); assert.equal(h.calls.some(call => call[0] === "git"), false);
});

test("port saving still works with the IDE unloaded and reports refresh failures separately", async () => {
  const h = harness(); h.context.repositoryIdeBridge.refreshAfterExternalChange = () => undefined;
  h.context.loadWorkspaceSnapshot = async () => { throw new Error("offline"); };
  await h.context.repositoryPortSaved({ file: "application.yml", applicationPort: 8181 }, { repositoryId: "repo-a", configurationId: "config-a" });
  assert.equal(h.state.workspace.runConfigurations[0].port, 8181);
  assert.match(h.messages[0][0], /Port saved.*offline/);
});

test("two quick port saves reconcile only the latest committed snapshot", async () => {
  const h = harness(), pending = [];
  h.context.loadWorkspaceSnapshot = () => new Promise(resolve => pending.push(resolve));
  const source = { repositoryId: "repo-a", configurationId: "config-a" };
  const first = h.context.repositoryPortSaved({ applicationPort: 8181 }, source);
  assert.equal(h.state.workspace.runConfigurations[0].port, 8181);
  const second = h.context.repositoryPortSaved({ applicationPort: 8282 }, source);
  assert.equal(h.state.workspace.runConfigurations[0].port, 8282);
  pending[1]({ runConfigurations: [{ id: "config-a", repositoryId: "repo-a", port: 8282 }] });
  await second;
  pending[0]({ runConfigurations: [{ id: "config-a", repositoryId: "repo-a", port: 8181 }] });
  await first;
  assert.equal(h.state.workspace.runConfigurations[0].port, 8282);
  assert.equal(h.context.repositoryPortRefreshes.size, 0);
});

test("a delayed port refresh cannot overwrite a subsequent Services configuration edit", async () => {
  const h = harness(); let resolve;
  h.context.loadWorkspaceSnapshot = () => new Promise(done => { resolve = done; });
  const pending = h.context.repositoryPortSaved({ applicationPort: 8181 }, { repositoryId: "repo-a", configurationId: "config-a" });
  h.state.workspace.runConfigurations = [{ id: "config-a", port: 8181, name: "Renamed service", env: { NEW_SETTING: "kept" } }];
  resolve({ runConfigurations: [{ id: "config-a", port: 8181, name: "Old name" }] });
  await pending;
  assert.equal(h.state.workspace.runConfigurations[0].name, "Renamed service");
  assert.equal(h.state.workspace.runConfigurations[0].env.NEW_SETTING, "kept");
});
