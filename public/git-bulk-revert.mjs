// Selection is view-specific: unstaged edits restore from the index; staged
// edits restore the index from HEAD. Never silently collapse both views.
export function gitBulkRevertSelection(keys) {
  const files = [];
  const paths = new Set();
  for (const key of keys || []) {
    const match = /^(staged|changed):([\s\S]+)$/.exec(String(key));
    if (!match) throw new Error("The file selection is no longer valid. Refresh Changes and select the files again.");
    const file = match[2];
    if (paths.has(file)) throw new Error(`Select ${file} in only one section at a time: Staged or Changes. Each section restores a different version.`);
    paths.add(file);
    files.push({ file, staged: match[1] === "staged" });
  }
  if (files.length > 25) throw new Error("Select up to 25 files per revert so every file can be safely checked and backed up.");
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export function validateGitBulkRevertPreview(preview, requested) {
  const rows = Array.isArray(preview?.files) ? preview.files : [];
  if (!preview?.allowed) {
    const blocked = rows.filter(row => !row.allowed).map(row => `${row.file}: ${row.reason || "Cannot be reverted safely"}`);
    throw new Error([preview?.reason || "The selected files cannot be reverted safely.", ...blocked].join("\n"));
  }
  if (rows.length !== requested.length || !requested.length) throw new Error("The revert preview did not match the selected files. Nothing was changed.");
  const seen = new Set();
  const result = requested.map(item => {
    const row = rows.find(row => row.file === item.file && row.staged === item.staged);
    if (!row?.allowed || typeof row.revision !== "string" || !row.revision || seen.has(row.file)) throw new Error("The revert preview was incomplete or stale. Refresh and preview the selected files again.");
    seen.add(row.file);
    return { file: item.file, staged: item.staged, expectedRevision: row.revision };
  });
  return result;
}

function text(document, tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

export function confirmGitBulkRevert({ document, repository, files, preview, isCurrent = () => true }) {
  if (!isCurrent() || document.querySelector("#git-bulk-revert-dialog")) return Promise.resolve(false);
  const dialog = document.createElement("dialog");
  dialog.id = "git-bulk-revert-dialog";
  dialog.className = "git-bulk-revert-dialog";
  dialog.setAttribute("aria-labelledby", "git-bulk-revert-title");
  dialog.setAttribute("aria-describedby", "git-bulk-revert-description");
  const header = text(document, "header", "", "git-bulk-revert-header");
  const eyebrow = text(document, "small", "LOCAL GIT · REVIEW BEFORE REVERTING");
  const title = text(document, "h2", `Revert ${files.length} selected ${files.length === 1 ? "file" : "files"}?`);
  title.id = "git-bulk-revert-title";
  header.append(eyebrow, title, text(document, "strong", repository.name || repository.id), text(document, "code", repository.path || repository.id));
  const body = text(document, "div", "", "git-bulk-revert-body");
  const explanation = text(document, "p", "Only the exact files and sections below will change. Unselected files stay untouched. Nothing is committed, pushed, or deleted.");
  explanation.id = "git-bulk-revert-description";
  body.append(explanation);
  const legend = text(document, "div", "", "git-bulk-revert-legend");
  if (files.some(file => !file.staged)) legend.append(text(document, "p", "Changes → restore working files from the Git index. Discard the selected unstaged edits; keep their staged edits."));
  if (files.some(file => file.staged)) legend.append(text(document, "p", "Staged → restore the Git index from HEAD. Unstage the selected edits; keep their working files."));
  body.append(legend);
  const list = text(document, "ul", "", "git-bulk-revert-files");
  list.setAttribute("aria-label", "Exact selected file paths and restore scope");
  for (const file of files) {
    const row = text(document, "li", "");
    row.append(text(document, "span", file.staged ? "Staged" : "Changes", "git-bulk-revert-scope"), text(document, "code", file.file));
    list.append(row);
  }
  body.append(list, text(document, "p", "Argus checks every selected revision and saves recovery copies before applying the batch. If a file changes, preview again. Unsaved editor drafts are never discarded.", "git-bulk-revert-safety"));
  if (preview.recoveryDirectory) body.append(text(document, "small", "Local recovery location"), text(document, "code", preview.recoveryDirectory, "git-bulk-revert-recovery"));
  const footer = text(document, "footer", "", "git-bulk-revert-footer");
  const cancel = text(document, "button", "Cancel");
  const approve = text(document, "button", files.every(file => file.staged) ? `Unstage ${files.length} ${files.length === 1 ? "file" : "files"}` : `Revert ${files.length} ${files.length === 1 ? "file" : "files"}`, "git-bulk-revert-confirm");
  cancel.type = approve.type = "button";
  cancel.autofocus = true;
  footer.append(cancel, approve);
  dialog.append(header, body, footer);
  document.body.append(dialog);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(Boolean(value));
    };
    cancel.addEventListener("click", () => finish(false));
    approve.addEventListener("click", () => finish(isCurrent()));
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    dialog.addEventListener("close", () => finish(false));
    try { dialog.showModal(); cancel.focus(); }
    catch { finish(false); }
  });
}

export function renderGitBulkRevertNotice(element, report, document) {
  if (!element) return;
  element.replaceChildren();
  element.hidden = !report;
  if (!report) return;
  element.classList.toggle("git-bulk-revert-failed", Boolean(report.error));
  element.append(text(document, "strong", report.message));
  const rows = Array.isArray(report.results) ? report.results : [];
  const recovery = Array.isArray(report.recoveryPaths) ? report.recoveryPaths : [];
  if (!rows.length && !recovery.length) return;
  const details = text(document, "details", "");
  details.append(text(document, "summary", "File results and recovery locations"));
  for (const row of rows) details.append(text(document, "p", `${row.file} · ${row.staged ? "Staged" : "Changes"} · ${row.status}${row.message ? ` — ${row.message}` : ""}`));
  for (const location of recovery) details.append(text(document, "code", location));
  element.append(details);
}
