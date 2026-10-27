import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRepositoryTabGroups, normalizeRepositoryTabOrder, reconcileRepositoryTabOrder, reorderRepositoryTabs, repositoryTabLayout } from "../public/repository-tab-groups.js";

const repo = (id) => ({ type: "repository", id });
const group = (id) => ({ type: "group", id });
const repositories = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, name: `Repository ${id}`, path: `/source/${id}` }));
const groups = [
  { id: "one", name: "First group", color: "violet", collapsed: false, repositoryIds: ["b", "a"] },
  { id: "two", name: "Second group", color: "cyan", collapsed: true, repositoryIds: ["d", "e"] },
];
const defaultOrder = [group("one"), repo("c"), group("two"), repo("f")];

function rail(repos = repositories, tabGroups = groups, order) {
  return repositoryTabLayout(repos, tabGroups, order).map((entry) => entry.type === "repository" ? entry.repository.id : `${entry.group.id}[${entry.repositories.map((repository) => repository.id).join(",")}]`);
}

function move(source, target, position = "before", tabGroups = groups, order = defaultOrder) {
  return reorderRepositoryTabs(repositories, tabGroups, order, { source, target, position });
}

function freeze(value) {
  Object.freeze(value);
  if (value && typeof value === "object") Object.values(value).forEach((item) => { if (item && typeof item === "object") freeze(item); });
  return value;
}

function assertEveryRepository(repos, result) {
  const layout = repositoryTabLayout(repos, result.groups, result.order);
  const actualIds = layout.flatMap((entry) => entry.type === "repository" ? [String(entry.repository.id)] : entry.repositories.map((repository) => String(repository.id)));
  assert.deepEqual(actualIds.slice().sort(), repos.map((repository) => String(repository.id)).sort());
  assert.equal(new Set(actualIds).size, actualIds.length);
  assert.deepEqual(normalizeRepositoryTabOrder(result.order, repos, result.groups), result.order);
  assert.deepEqual(normalizeRepositoryTabGroups(result.groups, repos), result.groups);
}

test("missing saved order retains the existing rail layout and each group's member order", () => {
  assert.deepEqual(normalizeRepositoryTabOrder(undefined, repositories, groups), defaultOrder);
  assert.deepEqual(rail(), ["one[b,a]", "c", "two[d,e]", "f"]);
  assert.deepEqual(rail(repositories, groups.slice().reverse()), rail());
  assert.deepEqual(rail(repositories, groups, null), rail());
});

test("saved top-level order controls groups and repositories independently of workspace repository order", () => {
  const order = [repo("f"), group("two"), repo("c"), group("one")];
  assert.deepEqual(rail(repositories, groups, order), ["f", "two[d,e]", "c", "one[b,a]"]);
  assert.deepEqual(rail(repositories.slice().reverse(), groups, order), ["f", "two[d,e]", "c", "one[b,a]"]);
  assert.deepEqual(repositories.map((repository) => repository.id), ["a", "b", "c", "d", "e", "f"]);
});

test("order normalization discards invalid or duplicate references and retains newly discovered repositories", () => {
  const order = [null, 123, "f", {}, { type: "other", id: "f" }, { type: "repository" }, repo(""), repo({}), repo("missing"), group("missing"), repo("f"), repo("f"), group("two"), group("two")];
  assert.deepEqual(normalizeRepositoryTabOrder(order, repositories, groups), [repo("f"), group("two"), group("one"), repo("c")]);
  const newest = [{ id: "new-first" }, ...repositories, { id: "new-last" }];
  assert.deepEqual(normalizeRepositoryTabOrder(defaultOrder, newest, groups), [...defaultOrder, repo("new-first"), repo("new-last")]);
  assert.deepEqual(normalizeRepositoryTabOrder({}, repositories, groups), defaultOrder);
});

test("new groups inherit a saved member position while explicit group positions take precedence", () => {
  assert.deepEqual(normalizeRepositoryTabOrder([repo("f"), repo("a"), repo("c"), repo("b")], repositories, groups), [repo("f"), group("one"), repo("c"), group("two")]);
  assert.deepEqual(normalizeRepositoryTabOrder([repo("a"), repo("f"), repo("b"), group("one")], repositories, groups), [repo("f"), group("one"), repo("c"), group("two")]);
});

test("offboarded IDs and empty groups disappear without losing surviving or ungrouped repositories", () => {
  const remaining = repositories.filter((repository) => !["a", "b", "e"].includes(repository.id));
  assert.deepEqual(rail(remaining, groups, defaultOrder), ["c", "two[d]", "f"]);
  assert.deepEqual(rail(repositories, [], defaultOrder), ["c", "f", "a", "b", "d", "e"]);
  assert.deepEqual(rail([], groups, defaultOrder), []);
});

test("deleting a group exposes members in their former group slot and saved member order", () => {
  const savedOrder = [repo("f"), group("two"), repo("c"), group("one")];
  const nextGroups = [groups[0]];
  const reconciled = reconcileRepositoryTabOrder(savedOrder, repositories, groups, nextGroups);
  assert.deepEqual(reconciled, [repo("f"), repo("d"), repo("e"), repo("c"), group("one")]);
  assert.deepEqual(reconcileRepositoryTabOrder(savedOrder, repositories, groups, []), [repo("f"), repo("d"), repo("e"), repo("c"), repo("b"), repo("a")]);
  assert.deepEqual(reconcileRepositoryTabOrder(undefined, repositories, groups, nextGroups), [group("one"), repo("c"), repo("d"), repo("e"), repo("f")]);
});

test("editing membership keeps surviving groups in place and exposes detached members after their group", () => {
  const nextGroups = [{ ...groups[0], name: "Renamed", repositoryIds: ["a", "f"] }, groups[1]];
  const reconciled = reconcileRepositoryTabOrder(defaultOrder, repositories, groups, nextGroups);
  assert.deepEqual(reconciled, [group("one"), repo("b"), repo("c"), group("two")]);
  assert.deepEqual(rail(repositories, nextGroups, reconciled), ["one[a,f]", "b", "c", "two[d,e]"]);
  const metadataOnly = groups.map((entry) => ({ ...entry, collapsed: !entry.collapsed }));
  assert.deepEqual(reconcileRepositoryTabOrder(defaultOrder, repositories, groups, metadataOnly), defaultOrder);
});

test("new or replacement groups inherit members' former positions without disturbing explicit groups", () => {
  const plainOrder = [repo("f"), repo("c"), repo("b"), repo("a"), repo("d"), repo("e")];
  assert.deepEqual(reconcileRepositoryTabOrder(plainOrder, repositories, [], groups), [repo("f"), repo("c"), group("one"), group("two")]);
  const replacement = [{ ...groups[0], id: "replacement" }, groups[1]];
  assert.deepEqual(reconcileRepositoryTabOrder(defaultOrder, repositories, groups, replacement), [group("replacement"), repo("c"), group("two"), repo("f")]);
  const firstGroupRemoved = [{ ...groups[1], repositoryIds: ["d", "e", "a", "b"] }];
  assert.deepEqual(reconcileRepositoryTabOrder(defaultOrder, repositories, groups, firstGroupRemoved), [repo("c"), group("two"), repo("f")]);
});

test("reconciliation handles stale membership and newly added repositories without changing its inputs", () => {
  const repos = [...repositories.filter((repository) => repository.id !== "a"), { id: "new" }];
  const input = freeze(structuredClone({ repos, before: groups, after: [], order: defaultOrder }));
  const snapshot = JSON.stringify(input);
  assert.deepEqual(reconcileRepositoryTabOrder(input.order, input.repos, input.before, input.after), [repo("b"), repo("c"), repo("d"), repo("e"), repo("f"), repo("new")]);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(reconcileRepositoryTabOrder(undefined, repositories, undefined, undefined), repositories.map((repository) => repo(repository.id)));
});

test("numeric IDs and type-qualified IDs stay stable across JSON preference persistence", () => {
  const repos = [{ id: 0 }, { id: 1 }, { id: "one" }];
  const tabGroups = [{ id: "one", name: "One", color: "blue", collapsed: false, repositoryIds: [0] }];
  const order = [repo("one"), repo(1), group("one")];
  assert.deepEqual(normalizeRepositoryTabOrder(order, repos, tabGroups), [repo("one"), repo("1"), group("one")]);
  const saved = JSON.parse(JSON.stringify({ groups: tabGroups, order }));
  assert.deepEqual(rail(repos, saved.groups, saved.order), ["one", 1, "one[0]"]);
});

test("a group moves as a whole before or after a repository or group", () => {
  const before = move(group("two"), group("one"));
  assert.equal(before.changed, true);
  assert.deepEqual(before.order, [group("two"), group("one"), repo("c"), repo("f")]);
  assert.deepEqual(before.groups, groups);
  const after = move(group("one"), repo("f"), "after");
  assert.deepEqual(after.order, [repo("c"), group("two"), repo("f"), group("one")]);
  assert.deepEqual(after.groups, groups);
  assert.deepEqual(move(group("one"), repo("d"), "after").order, [repo("c"), group("two"), group("one"), repo("f")]);
  assert.deepEqual(move(group("two"), repo("b"), "before").order, before.order);
});

test("ungrouped repositories move before and after one another", () => {
  const before = move(repo("f"), repo("c"));
  assert.deepEqual(before.order, [group("one"), repo("f"), repo("c"), group("two")]);
  assert.deepEqual(before.groups, groups);
  const after = move(repo("c"), repo("f"), "after");
  assert.deepEqual(after.order, [group("one"), group("two"), repo("f"), repo("c")]);
});

test("repository movement within a group preserves group identity, appearance, collapse and rail position", () => {
  const result = move(repo("a"), repo("b"));
  assert.equal(result.changed, true);
  assert.deepEqual(result.groups, [{ ...groups[0], repositoryIds: ["a", "b"] }, groups[1]]);
  assert.deepEqual(result.order, defaultOrder);
  assert.deepEqual(move(repo("d"), repo("e"), "after").groups[1], { ...groups[1], repositoryIds: ["e", "d"] });
});

test("dropping next to a grouped repository joins its group in the indicated position", () => {
  const before = move(repo("f"), repo("e"));
  assert.deepEqual(before.groups[1], { ...groups[1], repositoryIds: ["d", "f", "e"] });
  assert.deepEqual(before.order, [group("one"), repo("c"), group("two")]);
  const after = move(repo("a"), repo("d"), "after");
  assert.deepEqual(after.groups, [{ ...groups[0], repositoryIds: ["b"] }, { ...groups[1], repositoryIds: ["d", "a", "e"] }]);
  assert.deepEqual(after.order, defaultOrder);
  assertEveryRepository(repositories, before);
  assertEveryRepository(repositories, after);
});

test("dropping inside expanded or collapsed groups appends without changing collapse", () => {
  for (const targetId of ["one", "two"]) {
    const result = move(repo("f"), group(targetId), "inside");
    const original = groups.find((entry) => entry.id === targetId);
    assert.deepEqual(result.groups.find((entry) => entry.id === targetId), { ...original, repositoryIds: [...original.repositoryIds, "f"] });
    assertEveryRepository(repositories, result);
  }
  assert.deepEqual(move(repo("b"), group("one"), "inside").groups[0].repositoryIds, ["a", "b"]);
});

test("dropping outside either group edge ungroups a repository at the chosen position", () => {
  const before = move(repo("a"), group("two"));
  assert.deepEqual(before.order, [group("one"), repo("c"), repo("a"), group("two"), repo("f")]);
  assert.deepEqual(before.groups[0], { ...groups[0], repositoryIds: ["b"] });
  const after = move(repo("d"), group("two"), "after");
  assert.deepEqual(after.order, [group("one"), repo("c"), group("two"), repo("d"), repo("f")]);
  assert.deepEqual(after.groups[1], { ...groups[1], repositoryIds: ["e"] });
  const nextToUngrouped = move(repo("a"), repo("c"));
  assert.deepEqual(nextToUngrouped.order, [group("one"), repo("a"), repo("c"), group("two"), repo("f")]);
});

test("moving the last member removes only its empty group and keeps every repository", () => {
  const single = [{ ...groups[0], repositoryIds: ["a"] }, groups[1]];
  const order = normalizeRepositoryTabOrder(defaultOrder, repositories, single);
  const across = move(repo("a"), group("two"), "inside", single, order);
  assert.deepEqual(across.groups, [{ ...groups[1], repositoryIds: ["d", "e", "a"] }]);
  assert.deepEqual(across.order, [repo("c"), group("two"), repo("f"), repo("b")]);
  for (const position of ["before", "after"]) {
    const outsideOwnGroup = move(repo("a"), group("one"), position, single, order);
    assert.deepEqual(outsideOwnGroup.order, [repo("a"), repo("c"), group("two"), repo("f"), repo("b")]);
    assert.deepEqual(outsideOwnGroup.groups, [groups[1]]);
    assertEveryRepository(repositories, outsideOwnGroup);
  }
  assertEveryRepository(repositories, across);
});

test("self, adjacent, stale, malformed and unsupported operations are harmless no-ops", () => {
  const operations = [
    {}, null,
    { source: repo("a"), target: repo("a"), position: "after" },
    { source: group("one"), target: group("one"), position: "after" },
    { source: group("one"), target: repo("b"), position: "before" },
    { source: group("missing"), target: repo("c"), position: "before" },
    { source: repo("a"), target: repo("missing"), position: "before" },
    { source: repo("missing"), target: group("two"), position: "inside" },
    { source: repo("a"), target: group("missing"), position: "inside" },
    { source: group("one"), target: group("two"), position: "inside" },
    { source: repo("a"), target: repo("b"), position: "inside" },
    { source: repo("a"), target: repo("b"), position: "invalid" },
    { source: repo("a"), target: repo("b"), position: "after" },
    { source: repo("a"), target: group("one"), position: "inside" },
    { source: group("one"), target: repo("c"), position: "before" },
    { source: { type: "other", id: "a" }, target: repo("c"), position: "before" },
  ];
  for (const operation of operations) {
    assert.deepEqual(reorderRepositoryTabs(repositories, groups, defaultOrder, operation), { groups, order: defaultOrder, changed: false }, JSON.stringify(operation));
  }
});

test("reordering and rendering never mutate workspace records, group membership, order or operation inputs", () => {
  const input = freeze(structuredClone({ repositories, groups, order: defaultOrder, operation: { source: repo("a"), target: repo("e"), position: "after" } }));
  const before = JSON.stringify(input);
  const result = reorderRepositoryTabs(input.repositories, input.groups, input.order, input.operation);
  repositoryTabLayout(input.repositories, input.groups, input.order);
  assert.equal(JSON.stringify(input), before);
  result.groups[0].repositoryIds.push("extra");
  result.order[0].id = "changed";
  assert.equal(JSON.stringify(input), before);
});

test("all source/target/position combinations conserve repositories and normalize to a stable persisted layout", () => {
  const sources = [...repositories.map((repository) => repo(repository.id)), ...groups.map((entry) => group(entry.id))];
  for (const source of sources) {
    for (const target of sources) {
      for (const position of ["before", "after", "inside"]) {
        const result = move(source, target, position);
        assertEveryRepository(repositories, result);
        const saved = JSON.parse(JSON.stringify(result));
        assert.deepEqual(rail(repositories, saved.groups, saved.order), rail(repositories, result.groups, result.order));
        for (const surviving of result.groups) {
          const original = groups.find((entry) => entry.id === surviving.id);
          assert.equal(surviving.name, original.name);
          assert.equal(surviving.color, original.color);
          assert.equal(surviving.collapsed, original.collapsed);
        }
      }
    }
  }
});
