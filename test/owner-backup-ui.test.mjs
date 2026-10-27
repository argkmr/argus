import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DOMParser } from "@xmldom/xmldom";
import { backupFieldsValid, normalizeBackupRepositoryUrl } from "../public/backup-form.js";
import { createApiClient } from "../public/api-client.mjs";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const privateStatus = {
  repositoryUrl: "git@bitbucket.org:synthetic-owner/private-backup.git",
  driveDirectory: "/synthetic/Owner Drive", localDirectory: "/synthetic/Owner Backup",
  sourceRoot: "/synthetic/Owner Source", driveAccount: "synthetic-owner@example.invalid", driveAutoDetected: true,
  hasRecoveryPassphrase: true, bitbucketAccessConfirmed: true, branch: "private-branch", changedFiles: ["private-file"],
  diffSummary: "private-diff", lastBackup: { createdAt: "2026-01-01T00:00:00Z", sizeBytes: 12 },
};

function harness() {
  const markup = [html.match(/<button id="backup-toggle"[\s\S]*?<\/button>/)[0],
    ...["backup-dialog", "backup-confirm-dialog", "data-storage-dialog"].map(id => html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`))[0])].join("\n");
  const document = new DOMParser({ errorHandler: {
    warning(message) { if (!/attribute "(?:required|disabled|readonly|checked|multiple|autofocus|open|hidden)" missed value/.test(message)) throw new Error(message); },
    error(message) { throw new Error(message); }, fatalError(message) { throw new Error(message); },
  } }).parseFromString(`<html><body>${markup}</body></html>`, "text/html");
  const elements = Array.from(document.getElementsByTagName("*"));
  for (const element of elements) {
    for (const [property, attribute] of [["readOnly", "readonly"], ["disabled", "disabled"], ["required", "required"], ["open", "open"], ["hidden", "hidden"]]) {
      Object.defineProperty(element, property, { get: () => element.hasAttribute(attribute), set: value => value ? element.setAttribute(attribute, "") : element.removeAttribute(attribute) });
    }
    for (const [property, attribute] of [["value", "value"], ["className", "class"], ["title", "title"], ["placeholder", "placeholder"]]) {
      Object.defineProperty(element, property, { get: () => element.getAttribute(attribute) || "", set: value => element.setAttribute(attribute, String(value)) });
    }
    const classes = () => new Set((element.getAttribute("class") || "").split(/\s+/).filter(Boolean));
    const setClasses = values => element.setAttribute("class", [...values].join(" "));
    element.classList = {
      contains: value => classes().has(value),
      add(...values) { const all = classes(); values.forEach(value => all.add(value)); setClasses(all); },
      remove(...values) { const all = classes(); values.forEach(value => all.delete(value)); setClasses(all); },
      toggle(value, force) { const all = classes(), present = force ?? !all.has(value); present ? all.add(value) : all.delete(value); setClasses(all); return present; },
    };
    element.focus = () => { document.activeElement = element; };
    element.close = () => { element.open = false; };
    element.remove = () => element.parentNode?.removeChild(element);
  }
  const $$ = selector => {
    if (selector === "[data-backup-step].running") return [];
    const match = selector.match(/^\[([\w-]+)="([^"]+)"\]$/);
    assert.ok(match, selector);
    return elements.filter(element => element.getAttribute(match[1]) === match[2]);
  };
  const $ = selector => selector.startsWith("#") ? document.getElementById(selector.slice(1)) : $$(selector)[0];
  const state = { backupAccessAllowed: false, backupAccessEpoch: 0, backupAccessRequest: 0, backupStatus: null, backupSaving: false, backupRestoring: false, backupFolderSelecting: false, backgroundJobs: [], backgroundJobStatuses: new Map(), dismissedBackgroundJobs: new Set() };
  const requests = [], toasts = [], opened = [];
  const context = vm.createContext({ $, $$, state, backupFieldsValid, normalizeBackupRepositoryUrl, window: {},
    confirm: () => { throw new Error("Unexpected restore prompt"); },
    api: async (...args) => { requests.push(args); throw new Error("Unexpected API request"); },
    toast: (...args) => toasts.push(args), escapeHtml: value => String(value), formatBytes: value => `${value} B`,
    setRefreshLoading: (button, loading) => { button.disabled = loading; },
    showAppDialog: id => { opened.push(id); $("#" + id).open = true; },
    renderBackgroundJobs: () => {},
  });
  const active = source.slice(source.indexOf("function backgroundJobIsActive("), source.indexOf("function backgroundJobStatusLabel("));
  const backup = source.slice(source.indexOf("function formatBackupSize("), source.indexOf("function setRefreshLoading("));
  vm.runInContext(`${active}\n${backup}`, context);
  context.setBackupConfirmationStep = () => {};
  return { context, state, $, requests, toasts, opened,
    api(handler) { context.api = async (...args) => { requests.push(args); return handler(...args); }; },
    enroll() { context.setBackupAccess(true); context.renderBackupStatus(privateStatus); },
  };
}

function assertDenied(h) {
  assert.equal(h.state.backupAccessAllowed, false);
  assert.equal(h.$("#backup-toggle").hidden, true);
  assert.equal(h.$("#backup-toggle").disabled, true);
  assert.equal(h.$("#backup-toggle").classList.contains("hidden"), true);
  assert.equal(h.$("#backup-dialog").open, false);
  assert.equal(h.$("#backup-confirm-dialog").open, false);
  assert.equal(h.state.backupStatus, null);
  assert.equal(h.state.pendingBackup, null);
  assert.equal(h.state.backupDraftRepositoryUrl, null);
  assert.equal(h.state.backupDraftDriveDirectory, null);
  assert.equal(h.$("#backup-repository-url").value, "");
  assert.equal(h.$("#backup-passphrase").value, "");
  assert.equal(h.$("#backup-drive-directory").textContent, "Not configured");
  for (const id of ["backup-diff-summary", "backup-change-count", "backup-confirm-local", "backup-confirm-remote", "backup-confirm-drive"]) assert.equal(h.$("#" + id).textContent, "", id);
  for (const id of ["save-argus-backup", "restore-argus-backup", "choose-backup-folder", "backup-confirm-submit", "backup-confirm-back", "refresh-backup-status"]) assert.equal(h.$("#" + id).disabled, true, id);
}

test("owner backup control ships hidden and stays hidden while access is pending", async () => {
  const h = harness();
  assert.equal(h.$("#backup-toggle").hidden, true);
  assert.equal(h.$("#backup-toggle").disabled, true);
  let resolve;
  h.api(() => new Promise(done => { resolve = done; }));
  const pending = h.context.refreshBackupAccess();
  assert.equal(h.$("#backup-toggle").hidden, true);
  assert.deepEqual(h.requests.map(([path]) => path), ["/api/backup/access"]);
  resolve({ allowed: false });
  assert.equal(await pending, false);
  assertDenied(h);
  assert.match(source, /initialize\(\);\s*refreshBackupAccess\(\);/);
});

test("only literal server permission reveals owner backup; errors and malformed replies deny", async () => {
  for (const response of [{ allowed: false }, {}, null, { allowed: "true" }, { allowed: 1 }, new Error("offline")]) {
    const h = harness();
    h.api(() => { if (response instanceof Error) throw response; return response; });
    assert.equal(await h.context.refreshBackupAccess(), false);
    assertDenied(h);
    assert.equal(h.toasts.length, 0, "normal workspaces are not interrupted by unavailable owner tools");
  }
  const h = harness(); h.api(() => ({ allowed: true }));
  assert.equal(await h.context.refreshBackupAccess(), true);
  assert.equal(h.$("#backup-toggle").hidden, false);
  assert.equal(h.$("#backup-toggle").disabled, false);
  assert.equal(h.$("#backup-toggle").classList.contains("hidden"), false);
});

test("denied workspace handlers never fetch private status, pick a folder, prompt restore or save", async () => {
  const h = harness(); h.context.setBackupAccess(false);
  await h.context.refreshBackupStatus(); await h.context.chooseBackupFolder();
  await h.context.openBackupConfirmation(); await h.context.saveArgusChanges(); await h.context.restoreArgusBackup();
  h.context.renderBackupStatus(privateStatus);
  assert.equal(h.requests.length, 0);
  h.api(() => ({ allowed: false }));
  await h.context.openBackupDialog();
  assert.deepEqual(h.requests.map(([path]) => path), ["/api/backup/access"]);
  assert.equal(h.opened.length, 0);
  assertDenied(h);
});

test("opening an enrolled owner dialog rechecks access before revealing private status", async () => {
  const h = harness();
  h.api(path => path === "/api/backup/access" ? { allowed: true } : privateStatus);
  await h.context.openBackupDialog();
  assert.deepEqual(h.requests.map(([path]) => path), ["/api/backup/access", "/api/backup/status"]);
  assert.equal(h.$("#backup-dialog").open, true);
  assert.equal(h.$("#backup-repository-url").value, privateStatus.repositoryUrl);
  assert.equal(h.$("#save-argus-backup").disabled, false);
  h.api(() => ({ allowed: false }));
  await h.context.openBackupDialog();
  assertDenied(h);
});

test("known owner sees access progress immediately and cancel prevents delayed reopening", async () => {
  const h = harness(); h.enroll(); const pending = [];
  h.api(path => new Promise(resolve => pending.push({ path, resolve })));
  const opening = h.context.openBackupDialog();
  assert.equal(h.$("#backup-dialog").open, true);
  assert.equal(h.$("#backup-loading-title").textContent, "Checking backup access…");
  assert.equal(h.$("#backup-repository-requirement").textContent, "Checking…");
  assert.equal(h.$("#backup-passphrase-requirement").textContent, "Checking…");
  assert.equal(h.$("#save-argus-backup").disabled, true);
  assert.equal(h.$("#backup-settings-fields").getAttribute("aria-busy"), "true");
  h.$("#backup-dialog").close(); h.context.closeBackupDialog();
  pending[0].resolve({ allowed: true }); await opening;
  assert.equal(h.$("#backup-dialog").open, false);
  assert.deepEqual(h.requests.map(([path]) => path), ["/api/backup/access"]);
  const reopened = h.context.openBackupDialog();
  pending[1].resolve({ allowed: true }); await new Promise(setImmediate);
  assert.equal(pending[2].path, "/api/backup/status");
  assert.equal(h.$("#backup-loading-title").textContent, "Refreshing backup settings…");
  pending[2].resolve(privateStatus); await reopened;
  assert.equal(h.$("#backup-dialog").open, true);
  assert.equal(h.$("#save-argus-backup").disabled, false);
});

test("closing before the native close event is dispatched cannot reopen after an access response", async () => {
  const h = harness(); h.enroll(); let resolveAccess;
  h.api(path => {
    assert.equal(path, "/api/backup/access", "a closed dialog must not continue to settings");
    return new Promise(resolve => { resolveAccess = resolve; });
  });
  const opening = h.context.openBackupDialog();
  assert.equal(h.$("#backup-dialog").open, true);
  h.$("#backup-dialog").close(); // Native close event has not been dispatched yet.
  resolveAccess({ allowed: true }); await opening;
  assert.equal(h.$("#backup-dialog").open, false);
  assert.deepEqual(h.opened, ["backup-dialog"], "the original opening must show the dialog only once");
  assert.deepEqual(h.requests.map(([path]) => path), ["/api/backup/access"]);
  assert.equal(h.state.backupStatusLoading, false);
  if (!h.$("#backup-dialog").open) h.context.closeBackupDialog(); // Queued close event.
  assert.equal(h.$("#backup-dialog").open, false);
});

test("an enrolled owner can select a destination, review and save with a fresh confirmation", async () => {
  const h = harness(); h.enroll(); let confirmations = 0;
  h.api(path => {
    if (path === "/api/system/select-backup-folder") return { path: "/synthetic/New Owner Drive" };
    if (path === "/api/backup/confirmation") return { confirmationId: `confirmation-${++confirmations}`, plan: { sourceFileCount: 1, privateDataEntries: ["workspace"], driveDestination: "/synthetic/New Owner Drive/Argus" } };
    if (path === "/api/backup/settings") return {};
    if (path === "/api/backup/sync") return { id: "owner-backup-job", type: "backup-sync", status: "queued" };
    throw new Error(`Unexpected request: ${path}`);
  });
  await h.context.chooseBackupFolder();
  await h.context.openBackupConfirmation();
  assert.equal(h.$("#backup-confirm-dialog").open, true);
  assert.equal(h.state.pendingBackup.driveDirectory, "/synthetic/New Owner Drive");
  await h.context.saveArgusChanges();
  assert.deepEqual(h.requests.slice(-3).map(([path]) => path), ["/api/backup/settings", "/api/backup/confirmation", "/api/backup/sync"]);
  assert.equal(h.requests.at(-1)[1].body.confirmationId, "confirmation-2");
  assert.equal(h.state.backupAccessAllowed, true);
  assert.equal(h.state.backgroundJobs[0].id, "owner-backup-job");
  assert.equal(h.state.pendingBackup, null);
  assert.equal(h.state.backupSaving, false);
  assert.equal(h.$("#backup-confirm-dialog").open, false);
});

test("revocation clears private drafts, confirmation details and open dialogs without closing normal storage", async () => {
  const h = harness(); h.enroll();
  h.$("#backup-dialog").open = true; h.$("#backup-confirm-dialog").open = true; h.$("#data-storage-dialog").open = true;
  h.state.pendingBackup = { ...privateStatus, passphrase: "synthetic-private-passphrase" };
  h.state.backupDraftRepositoryUrl = privateStatus.repositoryUrl; h.state.backupDraftDriveDirectory = privateStatus.driveDirectory;
  h.$("#backup-passphrase").value = "synthetic-private-passphrase";
  for (const id of ["backup-confirm-local", "backup-confirm-remote", "backup-confirm-drive"]) h.$("#" + id).textContent = "private-confirmation";
  h.api(() => { throw new Error("lost connection"); });
  await h.context.refreshBackupAccess();
  assertDenied(h);
  assert.equal(h.$("#data-storage-dialog").open, true);
  assert.doesNotMatch(h.$("#backup-drive-help").textContent, /synthetic-owner/);
  assert.equal(h.$("#backup-last-result").innerHTML, "");
  assert.equal(h.$("#backup-confirm-result").innerHTML, "");
});

test("forbidden status, folder, confirmation, save and restore responses revoke the owner UI", async () => {
  for (const action of ["refreshBackupStatus", "chooseBackupFolder", "openBackupConfirmation", "saveArgusChanges", "restoreArgusBackup"]) {
    const h = harness(); h.enroll(); h.$("#backup-dialog").open = true;
    h.state.pendingBackup = { ...privateStatus, passphrase: "" };
    h.context.confirm = () => true;
    h.api(() => { throw Object.assign(new Error("Owner backup access required"), { status: 403 }); });
    await h.context[action]();
    assert.equal(h.requests.length, 1, action);
    assertDenied(h);
  }
});

test("delayed private responses cannot repopulate UI or continue saving after revocation and reenrollment", async () => {
  for (const action of ["refreshBackupStatus", "chooseBackupFolder", "openBackupConfirmation", "saveArgusChanges"]) {
    const h = harness(); h.enroll();
    h.state.pendingBackup = { ...privateStatus, passphrase: "" };
    let resolve;
    h.api(() => new Promise(done => { resolve = done; }));
    const pending = h.context[action]();
    h.context.setBackupAccess(false);
    h.context.setBackupAccess(true);
    resolve({ ...privateStatus, path: privateStatus.driveDirectory, confirmationId: "stale-confirmation" });
    await pending;
    assert.equal(h.requests.length, 1, action);
    assert.equal(h.state.backupStatus, null, action);
    assert.equal(h.state.pendingBackup, null, action);
    assert.equal(h.$("#backup-repository-url").value, "", action);
    assert.equal(h.$("#backup-drive-directory").textContent, "Loading folder…", action);
    assert.equal(h.$("#backup-confirm-dialog").open, false, action);
  }
});

test("a stale access response cannot reveal controls after a newer denial", async () => {
  const h = harness(); const pending = [];
  h.api(() => new Promise(resolve => pending.push(resolve)));
  const older = h.context.refreshBackupAccess(), newer = h.context.refreshBackupAccess();
  pending[1]({ allowed: false }); await newer;
  pending[0]({ allowed: true }); await older;
  assertDenied(h);
});

test("normal storage inventory remains available and backup destinations require owner access", () => {
  const h = harness();
  const inventory = { dataDirectory: "/synthetic/data", locations: { workspace: "/synthetic/workspace", backupRepository: privateStatus.localDirectory }, availability: { workspace: true, backupRepository: true }, diskUsage: { totalBytes: 100, sizes: { workspace: 100 } }, backup: { repositoryUrl: privateStatus.repositoryUrl, googleDriveDirectory: privateStatus.driveDirectory }, repositories: [{ name: "Normal repository", path: "/synthetic/source" }] };
  h.context.renderDataStorage(inventory);
  assert.equal(h.$("#data-storage-root").textContent, inventory.dataDirectory);
  assert.match(h.$("#data-storage-list").innerHTML, /Workspace & project settings/);
  assert.match(h.$("#storage-repository-list").innerHTML, /Normal repository/);
  assert.doesNotMatch(h.$("#data-storage-list").innerHTML, /synthetic-owner|Owner Backup|Owner Drive|Encrypted backup working copy/);
  h.enroll(); h.context.renderDataStorage(inventory);
  assert.match(h.$("#data-storage-list").innerHTML, /Encrypted backup working copy/);
  assert.match(h.$("#data-storage-list").innerHTML, /synthetic-owner/);
});

test("storage folder actions guard only the owner backup target and revoke on forbidden responses", async () => {
  const h = harness();
  const event = target => {
    const button = { dataset: { openStorage: target }, disabled: false };
    return { target: { closest: selector => selector === "[data-open-storage]" ? button : null } };
  };
  await h.context.handleDataStorageAction(event("backupRepository"));
  assert.equal(h.requests.length, 0);
  h.api(() => ({}));
  await h.context.handleDataStorageAction(event("data"));
  assert.equal(h.requests[0][1].body.target, "data");
  h.enroll();
  h.api(() => { throw Object.assign(new Error("Owner backup access required"), { status: 403 }); });
  await h.context.handleDataStorageAction(event("backupRepository"));
  assertDenied(h);
});

test("revocation removes cached backup activity and later polls retain ordinary background work", async () => {
  const h = harness(); h.enroll();
  const backup = { id: "private-backup-job", type: "backup-sync", status: "running", message: privateStatus.repositoryUrl };
  const ordinary = { id: "normal-index-job", type: "ai-kit-generation", status: "running" };
  h.state.backgroundJobs = [backup, ordinary];
  let renders = 0; h.context.renderBackgroundJobs = () => { renders++; };
  h.context.setBackupAccess(false);
  assert.deepEqual(h.state.backgroundJobs.map(job => job.id), [ordinary.id]);
  assert.equal(renders, 1);
  vm.runInContext(source.slice(source.indexOf("async function refreshBackgroundJobs("), source.indexOf("function repositoryArtifactMarkup(")), h.context);
  h.api(() => [backup, ordinary]);
  await h.context.refreshBackgroundJobs();
  assert.deepEqual(h.state.backgroundJobs.map(job => job.id), [ordinary.id]);
  h.context.setBackupAccess(true);
  await h.context.refreshBackgroundJobs();
  assert.deepEqual(h.state.backgroundJobs.map(job => job.id), [backup.id, ordinary.id]);
});

test("the shared API preserves forbidden status for access revocation", async () => {
  const context = { api: createApiClient(async () => ({ ok: false, status: 403, json: async () => ({ error: "Owner backup access required" }) })) };
  await assert.rejects(context.api("/api/backup/status"), error => error.status === 403);
});
