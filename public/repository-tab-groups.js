export const REPOSITORY_TAB_GROUP_COLORS = ["blue", "violet", "magenta", "orange", "rose", "cyan"];

export function normalizeRepositoryTabGroups(value, repositories = []) {
  const repositoryIds = new Set(repositories.map((repository) => String(repository.id)));
  const assigned = new Set();
  const groupIds = new Set();
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const id = String(candidate.id || `group-${index + 1}`);
    if (groupIds.has(id)) return [];
    groupIds.add(id);
    const members = Array.isArray(candidate.repositoryIds)
      ? candidate.repositoryIds.map(String).filter((repositoryId) => {
        if (!repositoryIds.has(repositoryId) || assigned.has(repositoryId)) return false;
        assigned.add(repositoryId);
        return true;
      })
      : [];
    if (!members.length) return [];
    const name = String(candidate.name || "Repository group").trim().slice(0, 40) || "Repository group";
    const migratedColor = candidate.color === "teal" ? "cyan" : candidate.color === "lime" ? "blue" : candidate.color;
    const color = REPOSITORY_TAB_GROUP_COLORS.includes(migratedColor) ? migratedColor : "blue";
    return [{ id, name, color, collapsed: Boolean(candidate.collapsed), repositoryIds: members }];
  });
}

function tabEntry(value) {
  if (!value || typeof value !== "object" || !["group", "repository"].includes(value.type)) return null;
  if (!["string", "number"].includes(typeof value.id) || String(value.id) === "") return null;
  return { type: value.type, id: String(value.id) };
}

function tabEntryKey(entry) {
  return `${entry.type}:${entry.id}`;
}

function repositoryGroupOwners(groups) {
  return new Map(groups.flatMap((group) => group.repositoryIds.map((id) => [id, group])));
}

/** Keep saved rail positions separate from the workspace's repository list. */
export function normalizeRepositoryTabOrder(value, repositories = [], groups = []) {
  const normalizedGroups = normalizeRepositoryTabGroups(groups, repositories);
  const owners = repositoryGroupOwners(normalizedGroups);
  const defaultOrder = repositories.map((repository) => {
    const id = String(repository.id);
    return owners.has(id) ? { type: "group", id: owners.get(id).id } : { type: "repository", id };
  });
  const available = new Set(defaultOrder.map(tabEntryKey));
  const saved = (Array.isArray(value) ? value : []).map(tabEntry).filter(Boolean);
  const explicitGroups = new Set(saved.filter((entry) => entry.type === "group" && available.has(tabEntryKey(entry))).map((entry) => entry.id));
  const seen = new Set();
  const order = [];
  const append = (entry) => {
    const key = tabEntryKey(entry);
    if (!available.has(key) || seen.has(key)) return;
    seen.add(key);
    order.push({ ...entry });
  };
  saved.forEach((entry) => {
    const owner = entry.type === "repository" && owners.get(entry.id);
    // A newly created group inherits its first saved member's position. An
    // explicit group position always wins over an obsolete member entry.
    if (owner) {
      if (!explicitGroups.has(owner.id)) append({ type: "group", id: owner.id });
    } else append(entry);
  });
  defaultOrder.forEach(append);
  return order;
}

/** Preserve the former group slot when editing membership or deleting groups. */
export function reconcileRepositoryTabOrder(order, repositories = [], previousGroups = [], nextGroups = []) {
  const previous = normalizeRepositoryTabGroups(previousGroups, repositories);
  const next = normalizeRepositoryTabGroups(nextGroups, repositories);
  const previousById = new Map(previous.map((group) => [group.id, group]));
  const survivingGroupIds = new Set(next.map((group) => group.id));
  const expanded = normalizeRepositoryTabOrder(order, repositories, previous).flatMap((entry) => {
    if (entry.type === "repository") return [entry];
    const members = previousById.get(entry.id).repositoryIds.map((id) => ({ type: "repository", id }));
    return survivingGroupIds.has(entry.id) ? [entry, ...members] : members;
  });
  return normalizeRepositoryTabOrder(expanded, repositories, next);
}

export function repositoryTabLayout(repositories = [], groups = [], order) {
  const repositoryById = new Map(repositories.map((repository) => [String(repository.id), repository]));
  const normalizedGroups = normalizeRepositoryTabGroups(groups, repositories);
  const groupById = new Map(normalizedGroups.map((group) => [group.id, group]));
  return normalizeRepositoryTabOrder(order, repositories, normalizedGroups).map((entry) => {
    if (entry.type === "repository") return { type: "repository", repository: repositoryById.get(entry.id) };
    const group = groupById.get(entry.id);
    return { type: "group", group, repositories: group.repositoryIds.map((id) => repositoryById.get(id)) };
  });
}

/**
 * Move a group or repository using stable IDs. A repository dropped before or
 * after another repository adopts that repository's group; before/after a
 * group places it outside the group, and inside a group appends it. Groups
 * move as units and cannot nest. Invalid or stale targets leave the layout
 * unchanged. The returned arrays are new values suitable for preferences.
 */
export function reorderRepositoryTabs(repositories = [], groups = [], order, move) {
  const originalGroups = normalizeRepositoryTabGroups(groups, repositories);
  const originalOrder = normalizeRepositoryTabOrder(order, repositories, originalGroups);
  const unchanged = { groups: originalGroups, order: originalOrder, changed: false };
  const source = tabEntry(move?.source);
  const target = tabEntry(move?.target);
  const position = move?.position;
  if (!source || !target || !["before", "after", "inside"].includes(position)) return unchanged;
  if (tabEntryKey(source) === tabEntryKey(target)) return unchanged;
  const repositoryIds = new Set(repositories.map((repository) => String(repository.id)));
  const groupIds = new Set(originalGroups.map((group) => group.id));
  const exists = (entry) => (entry.type === "group" ? groupIds : repositoryIds).has(entry.id);
  if (!exists(source) || !exists(target)) return unchanged;
  if (position === "inside" && (source.type !== "repository" || target.type !== "group")) return unchanged;

  const owners = repositoryGroupOwners(originalGroups);
  const targetOwner = target.type === "repository" ? owners.get(target.id) : null;
  const topTarget = targetOwner ? { type: "group", id: targetOwner.id } : target;
  let nextGroups = originalGroups;
  let nextOrder = originalOrder.filter((entry) => tabEntryKey(entry) !== tabEntryKey(source));
  const insertBesideTarget = () => {
    const index = nextOrder.findIndex((entry) => tabEntryKey(entry) === tabEntryKey(topTarget));
    nextOrder.splice(index + (position === "after" ? 1 : 0), 0, source);
  };
  if (source.type === "group") {
    if (source.id === topTarget.id && topTarget.type === "group") return unchanged;
    insertBesideTarget();
  } else {
    const destinationGroupId = position === "inside" ? target.id : targetOwner?.id;
    nextGroups = originalGroups.map((group) => {
      const repositoryIds = group.repositoryIds.filter((id) => id !== source.id);
      if (group.id === destinationGroupId) {
        const index = position === "inside" ? repositoryIds.length : repositoryIds.indexOf(target.id) + (position === "after" ? 1 : 0);
        repositoryIds.splice(index, 0, source.id);
      }
      return { ...group, repositoryIds };
    });
    if (!destinationGroupId) insertBesideTarget();
  }

  nextGroups = normalizeRepositoryTabGroups(nextGroups, repositories);
  nextOrder = normalizeRepositoryTabOrder(nextOrder, repositories, nextGroups);
  const changed = JSON.stringify(nextGroups) !== JSON.stringify(originalGroups) || JSON.stringify(nextOrder) !== JSON.stringify(originalOrder);
  return { groups: nextGroups, order: nextOrder, changed };
}
