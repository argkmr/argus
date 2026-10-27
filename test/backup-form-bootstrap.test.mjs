import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DOMParser } from "@xmldom/xmldom";
import { backupFieldsValid, normalizeBackupRepositoryUrl } from "../public/backup-form.js";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

// Parse the shipped markup, not handwritten lookalike controls. Reflect the few
// HTML properties/events used by these functions over this real DOM Level 2 tree.
function harness(status = {}) {
  const dialogs = ["backup-dialog", "backup-confirm-dialog"].map(id => {
    const markup = html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`))?.[0];
    assert.ok(markup, `${id} is present in the shipped page`);
    return markup;
  });
  const document = new DOMParser({ errorHandler: {
    // HTML boolean attributes are valid without an XML-style value.
    warning(message) { if (!/attribute "(?:required|disabled|readonly|checked|multiple|autofocus|open)" missed value/.test(message)) throw new Error(message); },
    error(message) { throw new Error(message); }, fatalError(message) { throw new Error(message); },
  } }).parseFromString(`<html><body>${dialogs.join("\n")}</body></html>`, "text/html");
  for (const element of Array.from(document.getElementsByTagName("*"))) {
    for (const [property, attribute] of [["readOnly", "readonly"], ["disabled", "disabled"], ["required", "required"], ["open", "open"]]) {
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
    const listeners = new Map();
    element.addEventListener = (event, listener) => listeners.set(event, listener);
    element.dispatchEvent = event => listeners.get(event.type)?.(event);
    element.focus = () => { document.activeElement = element; };
    element.close = () => { element.open = false; };
  }
  const $ = selector => {
    assert.match(selector, /^#[\w-]+$/);
    const element = document.getElementById(selector.slice(1));
    assert.ok(element, `Production control ${selector} exists`);
    return element;
  };
  const requests = [], toasts = [];
  // These destination/form regressions run as an explicitly enrolled owner.
  const state = { backupAccessAllowed: true, backupAccessEpoch: 0, backupAccessRequest: 0, backupStatus: null, backupSaving: false, backupRestoring: false, backupFolderSelecting: false, backgroundJobs: [] };
  const context = vm.createContext({ $, $$: () => [], state, backupFieldsValid, normalizeBackupRepositoryUrl, window: {}, confirm: () => false,
    api: async (...args) => { requests.push(args); throw new Error("Unexpected mock API request"); },
    toast: (...args) => toasts.push(args), escapeHtml: value => String(value),
    setRefreshLoading: (button, loading) => { button.disabled = loading; button.classList.toggle("refreshing", loading); },
  });
  const active = source.slice(source.indexOf("function backgroundJobIsActive("), source.indexOf("function backgroundJobStatusLabel("));
  const backup = source.slice(source.indexOf("function formatBackupSize("), source.indexOf("const DATA_STORAGE_CATEGORIES ="));
  vm.runInContext(`${active}\n${backup}`, context);
  for (const id of ["backup-repository-url", "backup-passphrase"]) {
    const listener = source.split("\n").find(line => line.includes(`$("#${id}").addEventListener("input"`));
    assert.ok(listener, `${id} input is wired to production validation`);
    vm.runInContext(listener, context);
  }
  const render = overrides => context.renderBackupStatus({ repositoryUrl: "", driveDirectory: "", bitbucketAccessConfirmed: false, hasRecoveryPassphrase: false, ...status, ...overrides });
  const input = (id, value) => { const field = $(`#${id}`); assert.equal(field.readOnly, false); assert.equal(field.disabled, false); field.value = value; field.dispatchEvent({ type: "input", target: field }); };
  return { $, context, state, render, input, requests, toasts, document };
}

const configured = { repositoryUrl: "git@bitbucket.org:workspace/argus-backup.git", driveDirectory: "/synthetic/My Drive", hasRecoveryPassphrase: true };

function deferredStatus(h) {
  const pending = [];
  h.context.api = (...args) => {
    h.requests.push(args);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  return pending;
}

test("shipped backup fields start with an accessible loader and neutral locked settings", () => {
  const h = harness();
  assert.equal(h.$("#backup-bitbucket-destination").classList.contains("hidden"), false);
  assert.equal(h.$("#backup-repository-url").readOnly, true);
  assert.equal(h.$("#backup-repository-url").getAttribute("aria-readonly"), "true");
  assert.equal(h.$("#backup-repository-url").disabled, false);
  assert.equal(h.$("#backup-repository-url").getAttribute("type"), "text", "SSH URLs are valid input, not browser type=url");
  assert.equal(h.$("#backup-repository-requirement").textContent, "Checking…");
  assert.doesNotMatch(h.$("#backup-repository-help").textContent, /verified|can push/i);
  assert.equal(h.$("#backup-passphrase-requirement").textContent, "Checking…");
  assert.equal(h.$("#backup-passphrase").required, false);
  assert.equal(h.$("#backup-passphrase").disabled, true);
  assert.equal(h.$("#backup-settings-fields").getAttribute("aria-busy"), "true");
  assert.equal(h.$("#backup-loading-status").getAttribute("role"), "status");
  assert.equal(h.$("#backup-loading-spinner").getAttribute("aria-hidden"), "true");
  assert.equal(h.$("#backup-loading-status").classList.contains("hidden"), false);
  for (const id of ["choose-backup-folder", "restore-argus-backup", "save-argus-backup"]) assert.equal(h.$(`#${id}`).disabled, true);
});

test("delayed initial settings show progress without false requirements and block dependent actions", async () => {
  const h = harness(), pending = deferredStatus(h);
  const loading = h.context.refreshBackupStatus();
  assert.equal(h.$("#backup-loading-status").classList.contains("hidden"), false);
  assert.equal(h.$("#backup-loading-spinner").classList.contains("hidden"), false);
  assert.equal(h.$("#backup-loading-title").textContent, "Loading backup settings…");
  assert.equal(h.$("#backup-settings-fields").getAttribute("aria-busy"), "true");
  for (const id of ["backup-repository-requirement", "backup-passphrase-requirement", "backup-drive-requirement"]) assert.equal(h.$(`#${id}`).textContent, "Checking…");
  assert.equal(h.$("#backup-repository-url").classList.contains("field-invalid"), false);
  assert.equal(h.$("#choose-backup-folder").classList.contains("field-invalid"), false);
  assert.equal(h.context.selectedBackupDriveDirectory(), "");
  for (const action of ["chooseBackupFolder", "openBackupConfirmation", "saveArgusChanges", "restoreArgusBackup"]) await h.context[action]();
  assert.deepEqual(h.requests.map(([path]) => path), ["/api/backup/status"]);
  assert.equal(h.toasts.length, 0, "unknown settings must not produce missing-field validation errors");
  pending[0].resolve({ ...configured, bitbucketAccessConfirmed: true }); await loading;
  assert.equal(h.$("#backup-loading-status").classList.contains("hidden"), true);
  assert.equal(h.$("#backup-settings-fields").getAttribute("aria-busy"), "false");
  assert.equal(h.$("#backup-repository-requirement").textContent, "Access verified");
  assert.equal(h.$("#backup-passphrase-requirement").textContent, "Saved in Keychain");
  assert.equal(h.$("#save-argus-backup").disabled, false);
  assert.equal(h.$("#refresh-backup-status").disabled, false);
});

test("failed refresh retains all drafts, stops progress and retries before enabling save", async () => {
  const h = harness({ ...configured, bitbucketAccessConfirmed: true }); h.render();
  h.input("backup-repository-url", "git@bitbucket.org:personal/draft.git");
  h.input("backup-passphrase", "retained recovery phrase");
  h.state.backupDraftDriveDirectory = "/synthetic/Draft Drive"; h.render();
  const pending = deferredStatus(h), loading = h.context.refreshBackupStatus();
  assert.equal(h.$("#backup-loading-title").textContent, "Refreshing backup settings…");
  assert.equal(h.$("#backup-passphrase-requirement").textContent, "Checking…");
  assert.equal(h.$("#backup-drive-directory").textContent, "/synthetic/Draft Drive");
  assert.equal(h.$("#save-argus-backup").disabled, true);
  pending[0].reject(new Error("Synthetic settings timeout")); await loading;
  assert.equal(h.$("#backup-loading-status").classList.contains("error"), true);
  assert.equal(h.$("#backup-loading-spinner").classList.contains("hidden"), true);
  assert.equal(h.$("#backup-settings-fields").getAttribute("aria-busy"), "false");
  assert.equal(h.$("#retry-backup-status").disabled, false);
  assert.match(h.$("#backup-loading-detail").textContent, /Synthetic settings timeout.*entries are kept/);
  assert.equal(h.$("#backup-passphrase-requirement").textContent, "Unavailable");
  assert.equal(h.$("#backup-repository-url").value, "git@bitbucket.org:personal/draft.git");
  assert.equal(h.$("#backup-passphrase").value, "retained recovery phrase");
  assert.equal(h.context.backupFormDraft().driveDirectory, "/synthetic/Draft Drive");
  for (const action of ["chooseBackupFolder", "openBackupConfirmation", "saveArgusChanges", "restoreArgusBackup"]) await h.context[action]();
  assert.equal(h.requests.length, 1);
  const retry = h.context.refreshBackupStatus();
  assert.equal(h.$("#retry-backup-status").disabled, true);
  pending[1].resolve({ ...configured, driveDirectory: "/synthetic/New Saved Drive" }); await retry;
  assert.equal(h.$("#backup-loading-status").classList.contains("hidden"), true);
  assert.equal(h.$("#backup-repository-url").value, "git@bitbucket.org:personal/draft.git");
  assert.equal(h.$("#backup-passphrase").value, "retained recovery phrase");
  assert.equal(h.context.backupFormDraft().driveDirectory, "/synthetic/Draft Drive");
  assert.equal(h.$("#save-argus-backup").disabled, false);
});

test("first-load failure has neutral unavailable fields and can recover", async () => {
  const h = harness(), pending = deferredStatus(h), loading = h.context.refreshBackupStatus();
  pending[0].reject(new Error("Synthetic offline")); await loading;
  assert.equal(h.state.backupStatus, null);
  assert.equal(h.$("#backup-loading-title").textContent, "Couldn’t load backup settings");
  assert.equal(h.$("#backup-repository-url").placeholder, "Settings unavailable");
  assert.equal(h.$("#backup-drive-label").textContent, "Google Drive folder");
  assert.equal(h.$("#backup-drive-directory").textContent, "Settings unavailable");
  assert.equal(h.context.selectedBackupDriveDirectory(), "");
  assert.equal(h.$("#save-argus-backup").disabled, true);
  const retry = h.context.refreshBackupStatus();
  pending[1].resolve({ repositoryUrl: "", driveDirectory: "", hasRecoveryPassphrase: false }); await retry;
  assert.equal(h.$("#backup-repository-requirement").textContent, "Required");
  assert.equal(h.$("#backup-passphrase-requirement").textContent, "Required");
  assert.equal(h.$("#backup-repository-url").readOnly, false);
  assert.equal(h.$("#backup-passphrase").disabled, false);
});

test("out-of-order status responses cannot overwrite a newer result or end its loader", async () => {
  for (const olderFails of [false, true]) {
    const h = harness(), pending = deferredStatus(h);
    const older = h.context.refreshBackupStatus(), newer = h.context.refreshBackupStatus();
    olderFails ? pending[0].reject(new Error("Stale failure")) : pending[0].resolve(configured);
    await older;
    assert.equal(h.state.backupStatus, null);
    assert.equal(h.$("#backup-settings-fields").getAttribute("aria-busy"), "true");
    assert.equal(h.$("#refresh-backup-status").disabled, true);
    pending[1].resolve({ ...configured, repositoryUrl: "git@bitbucket.org:latest/backup.git" }); await newer;
    assert.equal(h.$("#backup-repository-url").value, "git@bitbucket.org:latest/backup.git");
    assert.equal(h.state.backupLoadError, "");
  }
  const h = harness(), pending = deferredStatus(h);
  const older = h.context.refreshBackupStatus(), newer = h.context.refreshBackupStatus();
  pending[1].resolve({ ...configured, repositoryUrl: "git@bitbucket.org:latest/backup.git" }); await newer;
  pending[0].resolve(configured); await older;
  assert.equal(h.$("#backup-repository-url").value, "git@bitbucket.org:latest/backup.git");
});

test("closing invalidates pending settings and cannot disturb a later dialog load", async () => {
  const h = harness(), pending = deferredStatus(h);
  const older = h.context.refreshBackupStatus();
  h.context.closeBackupDialog();
  const reopened = h.context.refreshBackupStatus();
  pending[0].resolve({ ...configured, repositoryUrl: "git@bitbucket.org:stale/backup.git" }); await older;
  assert.equal(h.state.backupStatus, null);
  assert.equal(h.$("#backup-settings-fields").getAttribute("aria-busy"), "true");
  pending[1].resolve(configured); await reopened;
  assert.equal(h.$("#backup-repository-url").value, configured.repositoryUrl);
  assert.match(source, /dialog\.id === "backup-dialog" && !dialog\.open\) closeBackupDialog\(\)/);
});

test("unconfigured destination accepts typing and requires both destinations plus a valid passphrase", () => {
  const h = harness(); h.render({ bitbucketAccessConfirmed: true });
  assert.equal(h.$("#backup-repository-requirement").textContent, "Required", "empty URL can never be verified");
  assert.equal(h.$("#save-argus-backup").disabled, true);
  h.input("backup-repository-url", configured.repositoryUrl);
  assert.equal(h.$("#backup-repository-requirement").textContent, "Not verified");
  h.input("backup-passphrase", "twelve chars long");
  assert.equal(h.$("#save-argus-backup").disabled, true, "Drive is also required");
  h.$("#backup-drive-directory").textContent = configured.driveDirectory;
  h.context.updateBackupFormValidity();
  assert.equal(h.$("#save-argus-backup").disabled, false);
  h.input("backup-passphrase", "short");
  assert.equal(h.$("#save-argus-backup").disabled, true);
  h.input("backup-repository-url", "");
  h.input("backup-passphrase", "twelve chars long");
  assert.equal(h.$("#save-argus-backup").disabled, true, "Drive alone is not sufficient");
  assert.equal(h.requests.length, 0, "typing/validation makes no API request");
});

test("unverified saved destination remains editable and present in the draft", () => {
  const h = harness(configured); h.render();
  assert.equal(h.$("#backup-repository-url").value, configured.repositoryUrl);
  assert.equal(h.$("#backup-repository-url").readOnly, false);
  assert.equal(h.$("#backup-repository-requirement").textContent, "Not verified");
  assert.match(h.$("#backup-repository-help").textContent, /has not been verified/);
  assert.equal(h.$("#save-argus-backup").disabled, false, "saved recovery passphrase may be reused before access verification");
  assert.equal(h.context.backupFormDraft().repositoryUrl, configured.repositoryUrl);
  h.input("backup-repository-url", "https://bitbucket.org/another/backup.git");
  assert.equal(h.context.backupFormDraft().repositoryUrl, "https://bitbucket.org/another/backup.git");
  assert.equal(h.requests.length, 0);
});

test("verification applies only to the exact saved destination and is invalidated by edits", () => {
  const h = harness({ ...configured, bitbucketAccessConfirmed: true }); h.render();
  assert.equal(h.$("#backup-repository-url").readOnly, false);
  assert.equal(h.$("#backup-repository-requirement").textContent, "Access verified");
  assert.equal(h.$("#backup-repository-requirement").classList.contains("stored"), true);
  h.input("backup-repository-url", "git@bitbucket.org:other/backup.git");
  assert.equal(h.$("#backup-repository-requirement").textContent, "Not verified");
  assert.equal(h.$("#backup-repository-requirement").classList.contains("stored"), false);
  assert.match(h.$("#backup-repository-help").textContent, /Destination changed/);
  assert.equal(h.state.backupStatus.repositoryUrl, configured.repositoryUrl, "editing does not rewrite saved configuration");
  h.input("backup-repository-url", "");
  assert.equal(h.$("#backup-repository-requirement").textContent, "Required");
});

test("active backup, restore and offboarding states lock settings and reject actions without API calls", async () => {
  for (const active of [
    { syncing: true }, { backupSaving: true }, { backupRestoring: true },
    ...["queued", "running", "paused"].map(status => ({ job: { type: "backup-sync", status } })),
    { job: { type: "repository-offboarding", status: "running" } },
  ]) {
    const h = harness({ ...configured, bitbucketAccessConfirmed: true });
    h.state.backupSaving = Boolean(active.backupSaving); h.state.backupRestoring = Boolean(active.backupRestoring);
    h.state.backgroundJobs = active.job ? [active.job] : [];
    h.render({ syncing: Boolean(active.syncing) });
    assert.equal(h.$("#backup-repository-url").readOnly, true);
    assert.equal(h.$("#backup-repository-url").getAttribute("aria-readonly"), "true");
    assert.equal(h.$("#backup-repository-requirement").textContent, "Temporarily locked");
    for (const id of ["backup-passphrase", "choose-backup-folder", "save-argus-backup", "restore-argus-backup"]) assert.equal(h.$(`#${id}`).disabled, true, id);
    await h.context.chooseBackupFolder(); await h.context.openBackupConfirmation(); await h.context.saveArgusChanges(); await h.context.restoreArgusBackup();
    assert.equal(h.requests.length, 0);
    h.state.backupSaving = false; h.state.backupRestoring = false; h.state.backgroundJobs = [];
    h.state.backupStatus.syncing = false; h.context.updateBackupFormValidity();
    assert.equal(h.$("#backup-repository-url").readOnly, false);
    assert.equal(h.$("#backup-passphrase").disabled, false);
    assert.equal(h.$("#save-argus-backup").disabled, false);
    assert.equal(h.$("#backup-repository-requirement").textContent, "Access verified");
  }
});

test("failed local save unlocks the same destination and duplicate clicks cannot submit twice", async () => {
  const h = harness({ ...configured, bitbucketAccessConfirmed: true }); h.render();
  h.state.pendingBackup = { ...configured, passphrase: "" };
  h.context.setBackupConfirmationStep = () => {};
  let reject;
  h.context.api = (...args) => { h.requests.push(args); return new Promise((resolve, failure) => { reject = failure; }); };
  const saving = h.context.saveArgusChanges();
  assert.equal(h.$("#backup-repository-url").readOnly, true);
  await h.context.saveArgusChanges();
  assert.equal(h.requests.length, 1, "only a fake settings request was made");
  reject(new Error("Synthetic access rejection")); await saving;
  assert.equal(h.state.backupSaving, false);
  assert.equal(h.$("#backup-repository-url").value, configured.repositoryUrl);
  assert.equal(h.$("#backup-repository-url").readOnly, false);
  assert.equal(h.$("#save-argus-backup").disabled, false);
});

test("folder picker completion revalidates without unlocking an operation that started meanwhile", async () => {
  const h = harness(configured); h.render();
  let finish;
  h.context.api = (...args) => { h.requests.push(args); return new Promise(resolve => { finish = resolve; }); };
  const choosing = h.context.chooseBackupFolder();
  assert.equal(h.$("#save-argus-backup").disabled, true);
  await h.context.chooseBackupFolder(); assert.equal(h.requests.length, 1);
  h.state.backupSaving = true;
  finish({ path: "/synthetic/Other Drive" }); await choosing;
  assert.equal(h.state.backupFolderSelecting, false);
  assert.equal(h.$("#choose-backup-folder").disabled, true);
  assert.equal(h.$("#save-argus-backup").disabled, true);
  h.state.backupSaving = false; h.context.updateBackupFormValidity();
  assert.equal(h.$("#save-argus-backup").disabled, false);
});

test("restore request locks the form until completion and rejects duplicate confirmation", async () => {
  const h = harness(configured); h.render();
  h.input("backup-passphrase", "retained recovery passphrase");
  let reject, confirmations = 0;
  h.context.confirm = () => { confirmations++; return true; };
  h.context.api = (...args) => { h.requests.push(args); return new Promise((resolve, failure) => { reject = failure; }); };
  const restoring = h.context.restoreArgusBackup();
  assert.equal(h.state.backupRestoring, true);
  assert.equal(h.$("#backup-repository-url").readOnly, true);
  await h.context.restoreArgusBackup();
  assert.equal(confirmations, 1); assert.equal(h.requests.length, 1);
  reject(new Error("Synthetic restore rejection")); await restoring;
  assert.equal(h.state.backupRestoring, false);
  assert.equal(h.$("#backup-repository-url").readOnly, false);
  assert.equal(h.$("#backup-passphrase").value, "retained recovery passphrase");
  assert.equal(h.$("#restore-argus-backup").disabled, false);
});

test("unrelated jobs and finished backups do not leave backup settings locked", () => {
  const h = harness(configured);
  h.state.backgroundJobs = [{ type: "ai-kit-generation", status: "running" }, { type: "backup-sync", status: "completed" }];
  h.render();
  assert.equal(h.$("#backup-repository-url").readOnly, false);
  assert.equal(h.$("#save-argus-backup").disabled, false);
});
test("backup draft never drops an existing destination because access is unverified", () => {
  const body = source.slice(source.indexOf("function backupFormDraft()"), source.indexOf("function selectedBackupDriveDirectory()"));
  const context = vm.createContext({
    $: selector => selector === "#backup-repository-url" ? { value: " git@bitbucket.org:workspace/argus-backup.git " } : { value: "", classList: { contains: () => true } },
    selectedBackupDriveDirectory: () => "/synthetic/My Drive",
    normalizeBackupRepositoryUrl,
  });
  vm.runInContext(body, context);
  assert.equal(context.backupFormDraft().repositoryUrl, "git@bitbucket.org:workspace/argus-backup.git");
});
test("Bitbucket field stays visible for first setup and Drive selection revalidates Save", () => {
  assert.match(source, /\$\("#backup-bitbucket-destination"\)\.classList\.remove\("hidden"\)/);
  assert.doesNotMatch(source, /\$\("#backup-bitbucket-destination"\)\.classList\.toggle\("hidden", !status\.bitbucketAccessConfirmed\)/);
  const choose = source.slice(source.indexOf("async function chooseBackupFolder()"), source.indexOf("function backupFormDraft()"));
  assert.match(choose, /finally \{ state\.backupFolderSelecting = false; updateBackupFormValidity\(\); \}/);
});
test("backup privacy text reflects the encrypted SQLite snapshot and push-before-mirror contract", () => {
  assert.match(source, /Consistent snapshot included in encrypted backup/);
  assert.match(source, /If the push fails, the previous Drive snapshot stays untouched/);
  assert.doesNotMatch(source, /Without a successful Bitbucket push, Google Drive receives encrypted private data only/);
});

test("subsequent status refreshes retain typed and intentionally empty destinations", () => {
  const h = harness({ ...configured, bitbucketAccessConfirmed: true });
  h.render();
  const draft = "git@bitbucket.org:personal/separate-backup.git";
  h.input("backup-repository-url", draft);
  h.render();
  assert.equal(h.$("#backup-repository-url").value, draft);
  assert.equal(h.$("#backup-repository-requirement").textContent, "Not verified");
  h.render({ syncing: true });
  assert.equal(h.$("#backup-repository-url").value, draft);
  h.render({ syncing: false, repositoryUrl: "https://bitbucket.org/saved/another.git" });
  assert.equal(h.$("#backup-repository-url").value, draft);
  h.input("backup-repository-url", "");
  h.render();
  assert.equal(h.$("#backup-repository-url").value, "", "clearing a saved destination is also a draft");
  assert.equal(h.$("#backup-repository-requirement").textContent, "Required");
  assert.equal(h.requests.length, 0);
});

test("selected Drive draft and picker cancellation survive status refresh", async () => {
  const h = harness(configured); h.render();
  h.context.api = async () => ({ path: "/synthetic/Personal Drive" });
  await h.context.chooseBackupFolder();
  h.render({ driveDirectory: "/synthetic/Old Drive", driveAutoDetected: true, driveAccount: "Old account" });
  assert.equal(h.context.backupFormDraft().driveDirectory, "/synthetic/Personal Drive");
  assert.equal(h.$("#backup-drive-label").textContent, "Selected Google Drive folder");
  assert.doesNotMatch(h.$("#backup-drive-help").textContent, /Old account|Detected from/);
  let finish;
  h.context.api = () => new Promise(resolve => { finish = resolve; });
  const choosing = h.context.chooseBackupFolder();
  h.render();
  assert.match(h.$("#backup-drive-directory").textContent, /^Finder is open/);
  finish({ cancelled: true }); await choosing;
  assert.equal(h.context.backupFormDraft().driveDirectory, "/synthetic/Personal Drive");
});

test("pending backup confirmation captures destinations and blocks duplicate requests until it settles", async () => {
  const h = harness(configured); h.render();
  h.input("backup-repository-url", "https://bitbucket.org/personal/backup/src/main/");
  let reject;
  h.context.api = (...args) => { h.requests.push(args); return new Promise((resolve, failure) => { reject = failure; }); };
  const pending = h.context.openBackupConfirmation();
  assert.equal(h.state.backupConfirming, true);
  assert.equal(h.$("#backup-repository-url").readOnly, true);
  await h.context.openBackupConfirmation();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][1].body.repositoryUrl, "https://bitbucket.org/personal/backup.git");
  assert.equal(h.requests[0][1].body.driveDirectory, configured.driveDirectory);
  reject(new Error("Synthetic confirmation rejection")); await pending;
  assert.equal(h.state.backupConfirming, false);
  assert.equal(h.$("#backup-repository-url").readOnly, false);
  assert.equal(h.$("#backup-repository-url").value, "https://bitbucket.org/personal/backup/src/main/");
});

test("browser URL and copied clone command show their normalized destination without submitting", () => {
  const h = harness(configured); h.render();
  h.input("backup-repository-url", "https://bitbucket.org/personal/argus-backup/src/main/");
  assert.equal(h.context.backupFormDraft().repositoryUrl, "https://bitbucket.org/personal/argus-backup.git");
  assert.match(h.$("#backup-repository-help").textContent, /Will use https:\/\/bitbucket.org\/personal\/argus-backup.git/);
  h.input("backup-repository-url", "git clone git@bitbucket.org:personal/argus-backup.git");
  assert.equal(h.context.backupFormDraft().repositoryUrl, "git@bitbucket.org:personal/argus-backup.git");
  h.input("backup-repository-url", "git clone --mirror git@bitbucket.org:personal/argus-backup.git");
  assert.equal(h.$("#backup-repository-requirement").textContent, "Invalid URL");
  assert.equal(h.$("#save-argus-backup").disabled, true);
  assert.equal(h.requests.length, 0);
});

test("destination markup is personal and warns about dedicated main-history replacement", () => {
  const h = harness();
  assert.equal(h.$("#backup-repository-url").value, "");
  assert.match(h.$("#backup-repository-warning").textContent, /separate backup repository/);
  assert.match(h.$("#backup-repository-warning").textContent, /replaces its main branch history/);
  assert.match(h.$("#backup-repository-warning").textContent, /local setting; it is not bundled/);
});

test("saved HTTPS clone URLs keep their exact verification while a confirmation captures normalized drafts", async () => {
  const saved = "https://bitbucket.org/personal/backup";
  const h = harness({ ...configured, repositoryUrl: saved, bitbucketAccessConfirmed: true }); h.render();
  assert.equal(h.$("#backup-repository-requirement").textContent, "Access verified");
  assert.equal(h.context.backupFormDraft().repositoryUrl, saved);
  h.input("backup-repository-url", "https://bitbucket.org/personal/new-backup/src/main/");
  h.state.backupDraftDriveDirectory = "/synthetic/New Drive";
  h.render();
  const captured = h.context.backupFormDraft();
  h.input("backup-repository-url", "https://bitbucket.org/personal/newer-backup");
  h.render();
  assert.equal(captured.repositoryUrl, "https://bitbucket.org/personal/new-backup.git");
  assert.equal(captured.driveDirectory, "/synthetic/New Drive");
  assert.equal(h.context.backupFormDraft().repositoryUrl, "https://bitbucket.org/personal/newer-backup");
});
