// Local Git operations: deliberately independent of chats and remote approvals.
export function createGitStashActions({ getRepository, busyRepositories, request, invalidate, refresh }) {
  return async function mutate(repository, action, payload) {
    if (!repository?.id || getRepository()?.id !== repository.id) throw new Error("The repository changed. Open the action again in the intended repository.");
    const id = repository.id;
    if (busyRepositories.has(id)) throw new Error("A Git operation is already running for this repository.");
    busyRepositories.add(id);
    invalidate();
    try {
      return await request(`/api/repositories/${encodeURIComponent(id)}/git/${action}`, { method: "POST", body: payload });
    } catch (error) {
      if (!error.status || error.status >= 500) throw new Error("The operation's outcome could not be confirmed. Check the working tree and stash list before retrying; Argus has not retried it.");
      throw error;
    } finally {
      busyRepositories.delete(id);
      invalidate();
      if (getRepository()?.id === id) await refresh(id).catch(() => {});
    }
  };
}

export function initializeGitStashes({ document, getRepository, request, mutate, showDialog }) {
  const list = document.querySelector("#stash-list");
  const notice = document.querySelector("#stash-notice");
  const dialog = document.querySelector("#git-stash-dialog");
  const form = document.querySelector("#git-stash-form");
  const title = document.querySelector("#git-stash-title");
  const repositoryLabel = document.querySelector("#git-stash-repository");
  const description = document.querySelector("#git-stash-description");
  const fields = document.querySelector("#git-stash-fields");
  const confirm = document.querySelector("#git-stash-confirm");
  const cancel = document.querySelector("#git-stash-cancel");
  const errorBox = document.querySelector("#git-stash-error");
  let epoch = 0;
  let selection = null;
  let submitting = false;
  let entries = [];
  const text = (tag, value, className) => {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  function render() {
    list.replaceChildren();
    if (!entries.length) return list.append(text("p", "No stashes in this repository.", "stash-empty"));
    for (const entry of entries) {
      const row = text("article", "", "stash-row");
      const details = text("div", "", "stash-details");
      details.append(text("strong", entry.subject || "Saved changes"));
      const date = new Date(entry.createdAt);
      details.append(text("small", `${entry.ref}${Number.isNaN(date.getTime()) ? "" : ` · ${date.toLocaleString()}`}`));
      const pop = text("button", "Pop");
      pop.type = "button";
      pop.title = `Restore ${entry.ref} and remove it only after a successful apply`;
      pop.addEventListener("click", () => open("pop", entry));
      row.append(details, pop);
      list.append(row);
    }
  }
  async function refresh() {
    const repository = getRepository();
    const revision = ++epoch;
    entries = [];
    list.replaceChildren(text("p", repository ? "Loading stashes…" : "Select a repository to view its stashes.", "stash-empty"));
    if (!repository) return;
    try {
      const response = await request(`/api/repositories/${encodeURIComponent(repository.id)}/git/stashes`, { dedupe: false, cache: "no-store" });
      if (revision !== epoch || getRepository()?.id !== repository.id) return;
      entries = Array.isArray(response) ? response : [];
      render();
    } catch (error) {
      if (revision === epoch && getRepository()?.id === repository.id) list.replaceChildren(text("p", error.message, "stash-error"));
    }
  }
  function open(action, entry) {
    if (submitting) return;
    const repository = getRepository();
    if (!repository) return;
    selection = { repository: { id: repository.id, name: repository.name }, action, entry: entry && { ...entry } };
    form.reset();
    form.ariaBusy = "false";
    form.elements.message.disabled = false;
    form.elements.includeUntracked.disabled = false;
    errorBox.textContent = "";
    confirm.disabled = false;
    cancel.disabled = false;
    cancel.textContent = "Cancel";
    title.textContent = action === "pop" ? `Pop ${entry.ref}?` : "Stash local changes";
    repositoryLabel.textContent = `${repository.name} · Local Git`;
    description.textContent = action === "pop"
      ? `${entry.subject || "Saved changes"}. Restore saved changes and their staged state. Your tracked working tree must be clean. Conflicts keep the stash; nothing is pushed.`
      : "Save staged and unstaged tracked changes, then remove those edits from the working tree. Ignored files are never included. Nothing is pushed.";
    fields.hidden = action === "pop";
    confirm.textContent = action === "pop" ? "Pop stash" : "Stash changes";
    showDialog("git-stash-dialog");
  }
  function repositoryChanged() {
    epoch++;
    entries = [];
    notice.textContent = "";
    list.replaceChildren();
    if (!submitting) { selection = null; if (dialog.open) dialog.close(); }
    if (!document.querySelector("#git-stashes").classList.contains("hidden")) void refresh();
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selection || submitting) return;
    const current = selection;
    submitting = true;
    confirm.disabled = true;
    cancel.disabled = true;
    form.ariaBusy = "true";
    form.elements.message.disabled = true;
    form.elements.includeUntracked.disabled = true;
    confirm.textContent = current.action === "pop" ? "Restoring…" : "Stashing…";
    errorBox.textContent = "";
    try {
      const payload = current.action === "pop"
        ? { id: current.entry.id, ref: current.entry.ref }
        : { message: form.elements.message.value.trim(), includeUntracked: form.elements.includeUntracked.checked };
      const result = await mutate(current.repository, current.action === "pop" ? "stash/pop" : "stash", payload);
      if (getRepository()?.id === current.repository.id) {
        notice.textContent = result.message || (result.status === "popped" ? "Stash restored." : result.status === "empty" ? "No changes to stash." : result.status === "created" ? "Changes stashed locally." : "Check the working tree and retained stash before continuing.");
        notice.classList.toggle("stash-error", !result.ok);
        await refresh();
      }
      dialog.close();
      selection = null;
    } catch (error) {
      errorBox.textContent = error.message;
      if (getRepository()?.id === current.repository.id) {
        notice.textContent = error.message;
        notice.classList.add("stash-error");
        await refresh();
      }
      // A fresh confirmation is required after any failure, including a lost response.
      selection = null;
      cancel.textContent = "Close";
    } finally {
      submitting = false;
      form.ariaBusy = "false";
      confirm.disabled = !selection;
      confirm.textContent = current.action === "pop" ? "Pop stash" : "Stash changes";
      cancel.disabled = false;
    }
  });
  dialog.addEventListener("cancel", (event) => { if (submitting) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (!submitting) selection = null; });
  cancel.addEventListener("click", () => { if (!submitting) dialog.close(); });
  document.querySelector("#stash-button").addEventListener("click", () => open("stash"));
  document.querySelector("#refresh-stashes").addEventListener("click", refresh);
  document.querySelector('[data-git-view="stashes"]').addEventListener("click", refresh);
  return { refresh, repositoryChanged };
}
