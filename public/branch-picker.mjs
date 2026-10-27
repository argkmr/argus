const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export function branchPickerGroups(branches = [], recentBranches = [], query = "") {
  const valid = branches.filter(branch => branch?.selectable && typeof branch.name === "string" && ["local", "remote"].includes(branch.type));
  const locals = new Map(valid.filter(branch => branch.type === "local").map(branch => [branch.ref, branch]));
  const seen = new Set(), recent = [];
  for (const candidate of recentBranches) {
    const branch = locals.get(candidate?.ref);
    if (!branch || branch.name !== candidate.name || branch.current || seen.has(branch.ref)) continue;
    seen.add(branch.ref);
    recent.push(branch);
    if (recent.length === 4) break;
  }
  const normalized = query.trim().toLowerCase();
  const matches = branch => !normalized || branch.name.toLowerCase().includes(normalized);
  return [
    { label: "RECENT BRANCHES", recent: true, branches: recent.filter(matches) },
    { label: "LOCAL BRANCHES", branches: valid.filter(branch => branch.type === "local" && !seen.has(branch.ref) && matches(branch)) },
    { label: "REMOTE BRANCHES", branches: valid.filter(branch => branch.type === "remote" && matches(branch)) },
  ].filter(group => group.branches.length);
}

export function branchPickerMarkup({ branches, recentBranches, query = "", selected = "", branchIcon = "" }) {
  return branchPickerGroups(branches, recentBranches, query).map(group =>
    `<div class="branch-picker-group" role="heading" aria-level="3"${group.recent ? ' title="Last four previously used local branches, newest first"' : ""}>${group.label}</div>`
    + group.branches.map(branch => `<button type="button" class="branch-picker-item ${branch.current ? "current" : ""} ${selected === branch.name ? "selected" : ""}" data-branch-candidate="${escape(branch.name)}" aria-pressed="${selected === branch.name}">${branchIcon}<strong title="${escape(branch.name)}">${escape(branch.name)}</strong><small>${branch.current ? "current" : group.recent ? "recent" : branch.type}</small></button>`).join("")
  ).join("") || '<div class="empty-list">No matching branches.</div>';
}

/** Read only when the picker opens; closing/reopening retires all late responses. */
export function createBranchPickerLoader({ api, onChange = () => {} }) {
  let generation = 0, controller, view = { repositoryId: null, branches: [], recentBranches: [], loading: false, notice: "" };
  const recentCache = new Map();
  return {
    snapshot: () => view,
    close() { generation++; controller?.abort(); controller = null; },
    async open(repositoryId, initialBranches = []) {
      const request = ++generation;
      controller?.abort();
      controller = new AbortController();
      view = { repositoryId, branches: initialBranches, recentBranches: recentCache.get(repositoryId) || [], loading: true, notice: "" };
      onChange(view);
      const prefix = `/api/repositories/${encodeURIComponent(repositoryId)}/git/branches`;
      const options = { dedupe: false, cache: "no-store", signal: controller.signal, timeout: 10_000 };
      const [branches, recent] = await Promise.allSettled([api(prefix, options), api(`${prefix}/recent`, options)]);
      if (request !== generation) return;
      const listOk = branches.status === "fulfilled" && Array.isArray(branches.value);
      const recentOk = recent.status === "fulfilled" && Array.isArray(recent.value);
      // Never leave stale history looking current after an unsuccessful refresh.
      const recentBranches = recentOk ? recent.value : [];
      recentCache.delete(repositoryId);
      if (recentOk) recentCache.set(repositoryId, recentBranches);
      if (recentCache.size > 32) recentCache.delete(recentCache.keys().next().value);
      view = { repositoryId, branches: listOk ? branches.value : initialBranches, recentBranches, loading: false,
        notice: !listOk ? "Branches could not refresh. Close and reopen to retry."
          : !recentOk ? "Recent branches are unavailable. All branches are still listed below."
            : recentBranches.length ? "Last four previously used local branches · newest first" : "" };
      onChange(view);
    },
  };
}
