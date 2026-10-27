const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

// A missing historical ID is never matched by name or silently replaced by
// today's Nexus scope. Only an explicit confirmation may change a saved scope.
export function createRevisionScopePicker({ document }) {
  let active = false;
  return async function choose({ task, repositories, disconnectedRepositories = [] }) {
    if (active) throw new Error("Finish choosing repositories for the current edit first.");
    active = true;
    const saved = new Set(task.repositoryIds || []);
    const connected = new Set(repositories.map(repo => repo.id));
    const missing = [...saved].filter(id => !connected.has(id));
    const names = new Map(disconnectedRepositories.map(repo => [repo.id, repo.name || repo.id]));
    const dialog = document.createElement("dialog");
    dialog.id = "revision-scope-dialog";
    dialog.className = "prompt-edit-dialog revision-scope-dialog";
    dialog.setAttribute("aria-labelledby", "revision-scope-title");
    dialog.innerHTML = `<form><header><h2 id="revision-scope-title">Choose repositories for this retry</h2><p>This chat includes disconnected repositories. Confirm the scope for this response; the chat and previous versions stay here.</p></header><p class="revision-scope-missing">Disconnected: ${missing.map(id => escapeHtml(names.get(id) || id)).join(", ")}</p><fieldset><legend>Connected repositories</legend><div class="revision-scope-list">${repositories.map(repo => `<label><input type="checkbox" name="repository" value="${escapeHtml(repo.id)}" ${saved.has(repo.id) ? "checked" : ""}><span>${escapeHtml(repo.name || repo.id)}</span></label>`).join("") || '<p>No repositories are connected. Reconnect a repository before retrying.</p>'}</div></fieldset><label class="revision-scope-auto"><input type="checkbox" data-scope-auto><span>Use all currently connected repositories (${repositories.length})<small>Auto scope includes every connected repository, not the disconnected ones.</small></span></label><p role="alert" class="prompt-edit-error" data-scope-error></p><footer><button type="button" class="secondary-button" data-scope-cancel>Cancel</button><button type="submit" class="primary-button" ${repositories.length ? "" : "disabled"}>Confirm &amp; resend</button></footer></form>`;
    const opener = document.activeElement;
    document.body.append(dialog);
    return new Promise(resolve => {
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        dialog.close(); dialog.remove(); active = false;
        if (opener?.isConnected) opener.focus();
        resolve(result);
      };
      const boxes = [...dialog.querySelectorAll('input[name="repository"]')];
      const auto = dialog.querySelector("[data-scope-auto]");
      auto.addEventListener("change", () => { for (const box of boxes) box.disabled = auto.checked; });
      dialog.querySelector("[data-scope-cancel]").addEventListener("click", () => finish(null));
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
      dialog.addEventListener("close", () => finish(null));
      dialog.querySelector("form").addEventListener("submit", event => {
        event.preventDefault();
        const selected = boxes.filter(box => box.checked).map(box => box.value);
        const error = dialog.querySelector("[data-scope-error]");
        if (!repositories.length || (!auto.checked && !selected.length)) { error.textContent = "Select at least one connected repository, or explicitly choose all."; return; }
        if (!auto.checked && selected.length > 6) { error.textContent = "Select up to 6 repositories, or explicitly choose all currently connected repositories."; return; }
        finish({ repositoryIds: auto.checked ? [] : selected, expectedRepositoryIds: [...saved] });
      });
      dialog.showModal();
      dialog.querySelector("[data-scope-cancel]").focus({ preventScroll: true });
      dialog.scrollTop = 0;
    });
  };
}
