// Keep compact visual values and their full hover descriptions in sync. Use
// textContent/attributes only: repository and branch names are untrusted text.
export function renderRepositoryContextSummary(document, { repository, branch = "Loading…", changeCount = null, detached = false } = {}) {
  const name = String(repository?.name || "Repository");
  const branchName = String(branch || "—");
  const knownCount = Number.isSafeInteger(changeCount) && changeCount >= 0;
  const count = knownCount ? String(changeCount) : "—";
  const descriptions = {
    "context-repository-item": `${name} · isolated chat context${repository?.path ? `\n${repository.path}` : ""}`,
    "context-branch-item": `${detached ? "Detached HEAD" : "Current branch"}: ${branchName}`,
    "context-changes-item": knownCount ? `${count} changed ${changeCount === 1 ? "file" : "files"}` : "Checking changed files…",
  };
  for (const [id, value] of Object.entries({ "context-repo": name, "context-branch": branchName, "context-change-count": count })) {
    const node = document.querySelector(`#${id}`);
    if (node) node.textContent = value;
  }
  for (const [id, description] of Object.entries(descriptions)) {
    const node = document.querySelector(`#${id}`);
    if (!node) continue;
    node.title = description;
    node.setAttribute("aria-label", description.replaceAll("\n", ". "));
  }
  document.querySelector("#context-changes-item")?.setAttribute("data-change-state", knownCount ? (changeCount > 0 ? "changed" : "clean") : "unknown");
}
