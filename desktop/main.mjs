import { app, BrowserWindow, dialog, ipcMain, Notification, powerMonitor, session, shell } from "electron";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drainJavaBackend, stopChild, stopRecordedJava } from "./shutdown.mjs";
import { createEditorExitGuard } from "./editor-exit-guard.mjs";
import { commonCliPath } from "./executable-path.mjs";
import { createDailyPlannerReminders, isTrustedPlannerSender } from "./daily-planner-reminders.mjs";
import { createDesktopCanvasSharing } from "./canvas-sharing.mjs";
import { prepareStoragePaths } from "./storage-paths.mjs";

app.setName("Argus Personal");
app.setPath("userData", path.join(app.getPath("appData"), "Argus Personal"));
const LOCAL_PORT = Number(process.env.ARGUS_PORT || 4175);
if (!Number.isInteger(LOCAL_PORT) || LOCAL_PORT < 1 || LOCAL_PORT > 65535) throw new Error("ARGUS_PORT must be between 1 and 65535");
if (process.env.ARGUS_PROFILE_DIR) {
  if (!path.isAbsolute(process.env.ARGUS_PROFILE_DIR)) throw new Error("ARGUS_PROFILE_DIR must be absolute");
  fs.mkdirSync(process.env.ARGUS_PROFILE_DIR, { recursive: true, mode: 0o700 });
  app.setPath("userData", process.env.ARGUS_PROFILE_DIR);
}
const LOCAL_URL = `http://127.0.0.1:${LOCAL_PORT}`;
const appMetadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
const UI_BUILD = String(appMetadata.argusBuild || appMetadata.version || "development");
let mainWindow;
let springBackend;
let quitting = false;
let springPidFile;
let rendererRetryCount = 0;
let resetScheduled = false;
let plannerReminders;
let pendingPlannerOpen = false;
let canvasSharing;

function openDailyPlanner() {
  if (quitting || resetScheduled) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingPlannerOpen = true;
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // Do not navigate or reload an existing renderer: it may contain unsaved IDE/chat drafts.
  if (mainWindow.webContents.isLoadingMainFrame()) pendingPlannerOpen = true;
  else mainWindow.webContents.send("argus-personal:open-daily-planner", { path: "/daily-tasks" });
}

function resumePlannerReminders() {
  if (!quitting && !resetScheduled && springBackend && springBackend.exitCode == null && springBackend.signalCode == null) plannerReminders?.start();
}

async function hasUnsavedEditorDrafts() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  let timer;
  try {
    return await Promise.race([
      // app.exit() bypasses renderer unload. Flush navigation metadata before
      // the existing dirty check; this never saves or discards editor contents.
      mainWindow.webContents.executeJavaScript("(() => { window.dispatchEvent(new Event('argus:before-native-exit')); return document.documentElement.dataset.argusIdeDirty === 'true' || document.documentElement.dataset.argusDiagramDirty === 'true'; })()"),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Editor draft check timed out")), 2000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function draftDialogOptions(action, checkFailed = false) {
  const label = action === "reset" ? "reset" : action === "close" ? "close" : "quit";
  return {
    type: "warning", title: "Unsaved changes", buttons: ["Keep editing", `Discard and ${label}`],
    defaultId: 0, cancelId: 0, noLink: true,
    message: checkFailed ? "Argus could not check for unsaved editor or diagram drafts." : "You have unsaved editor or diagram changes.",
    detail: "Discarding loses these drafts. Choose Keep editing to save them first.",
  };
}

function setWindowEnabled(enabled) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setEnabled(enabled);
}

const editorExit = createEditorExitGuard({
  readDirty: hasUnsavedEditorDrafts,
  confirmDiscard: async ({ action, checkFailed }) => {
    const options = draftDialogOptions(action, checkFailed);
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  },
  confirmPreventedUnload: () => dialog.showMessageBoxSync(mainWindow, draftDialogOptions("close")) === 1,
  setQuitting: value => { quitting = value; }, setWindowEnabled,
  drain: () => drainBackend(),
  exit: ({ restart = false } = {}) => { if (restart) app.relaunch(); app.exit(0); },
  onFailure: error => {
    resumePlannerReminders();
    console.error("Argus backend shutdown failed", error);
    dialog.showErrorBox("Argus is still finishing background work", `${error.message}\nWait for the operation to finish, then quit again. No data cleanup was performed.`);
  },
});



let preparedStorage;
function storagePaths() {
  if (!preparedStorage) {
    const userData = app.getPath("userData");
    preparedStorage = prepareStoragePaths({ userData });
  }
  return preparedStorage;
}

function readJsonFile(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function deleteKeychainService(service) {
  for (let index = 0; index < 100; index += 1) {
    const result = spawnSync("security", ["delete-generic-password", "-s", service], { encoding: "utf8" });
    if (result.status !== 0) break;
  }
}

async function resetAllArgusData() {
  if (!await editorExit.confirmDraftLoss("reset")) { resetScheduled = false; return; }
  quitting = true;
  setWindowEnabled(false);
  const userData = app.getPath("userData");
  const workspace = readJsonFile(path.join(userData, "workspace.json"));
  const driveDirectory = String(workspace.preferences?.backup?.driveDirectory || "");
  const runConfigurationIds = (workspace.runConfigurations || []).map((item) => item.id).filter(Boolean);
  const exactDirectories = [
    userData,
    path.join(path.dirname(userData), "Argus Personal Backup Repository"),
    storagePaths().collections,
  ];
  // Only remove the explicitly configured Argus backup directory. Never walk
  // upward into a Drive account or any other user-selected parent folder.
  if (driveDirectory && path.basename(driveDirectory).toLowerCase().includes("argus")) exactDirectories.push(driveDirectory);

  await drainBackend();
  const failures = [];
  for (const target of [...new Set(exactDirectories.map((item) => path.resolve(item)))]) {
    try { fs.rmSync(target, { recursive: true, force: true }); }
    catch (error) { failures.push(new Error(`Could not erase ${target}: ${error.message}`)); }
  }
  if (failures.length) throw new AggregateError(failures, "Reset is incomplete. Credentials were preserved; restart Argus and resolve the storage error before retrying.");
  if (process.platform === "darwin") {
    for (const service of ["argus-personal:argus-backup", "argus-personal:browser-extension", ...runConfigurationIds.map((id) => `argus-personal:${id}`)]) deleteKeychainService(service);
  }
  app.relaunch();
  app.exit(0);
}

function removeSpringPidFile() {
  try { if (springPidFile) fs.rmSync(springPidFile, { force: true }); } catch (error) { console.error("Could not remove Spring PID file", error); }
}

async function terminateRecordedSpring() {
  springPidFile = path.join(app.getPath("userData"), "spring-backend.pid.json");
  if (!fs.existsSync(springPidFile)) return;
  const record = readJsonFile(springPidFile);
  await stopRecordedJava(record, {
    readCommand: pid => {
      const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (result.error || (result.status !== 0 && result.status !== 1)) throw result.error || new Error("Could not inspect the previous Java backend");
      return result.stdout || "";
    },
    signal: (pid, signal) => process.kill(pid, signal),
  });
  removeSpringPidFile();
}

async function stopSpringBackend() {
  plannerReminders?.stop();
  await canvasSharing?.close();
  const child = springBackend;
  if (!child) return;
  await stopChild(child, { gracefulMs: 60_000, forceMs: 2_000 });
  removeSpringPidFile();
}

async function drainBackend() {
  plannerReminders?.stop();
  // Drain board writes before shutting down the local storage API.
  await canvasSharing?.close();
  await drainJavaBackend({ child: springBackend, baseUrl: LOCAL_URL, token: process.env.ARGUS_MCP_TOKEN });
  removeSpringPidFile();
}

async function addCommonCliLocationsToPath() {
  process.env.PATH = await commonCliPath(process.env, os.homedir());
  // Java selects one versioned CLI for both catalogue discovery and execution.
}

function packagedResource(...parts) {
  return path.join(process.resourcesPath, ...parts);
}

function resolveSpringRuntime() {
  const bundled = packagedResource("runtime", "bin", "java");
  if (app.isPackaged && fs.existsSync(bundled)) return bundled;
  if (process.env.JAVA_HOME) return path.join(process.env.JAVA_HOME, "bin", "java");
  return "java";
}

function resolveSpringJar() {
  if (app.isPackaged) return packagedResource("backend", "argus-backend.jar");
  return path.resolve(app.getAppPath(), "backend", "target", "argus-backend-0.1.0.jar");
}

async function waitForSpring(timeoutMs = 90_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${LOCAL_URL}/internal/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const health = await response.json();
        if (health.build === UI_BUILD && Number(health.pid) === springBackend?.pid) return;
        lastError = new Error(`another Argus backend build is using port 4175 (${health.build || "unknown"})`);
      }
    } catch (error) {
      lastError = error;
    }
    if (springBackend?.exitCode != null || springBackend?.signalCode != null) throw new Error("The Java backend exited before becoming ready; check the startup log for details");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Spring Boot did not become ready: ${lastError?.message || "timeout"}`);
}

async function startBackend() {
  await terminateRecordedSpring();
  process.env.ARGUS_DESKTOP = "1";
  process.env.ARGUS_PORT = String(LOCAL_PORT);
  process.env.ARGUS_PUBLIC_PORT = String(LOCAL_PORT);
  process.env.ARGUS_MCP_TOKEN = crypto.randomBytes(32).toString("base64url");
  process.env.ARGUS_DATA_DIR = app.getPath("userData");
  process.env.ARGUS_BACKUP_REPOSITORY_DIR = app.isPackaged
    ? path.join(path.dirname(app.getPath("userData")), "Argus Personal Backup Repository")
    : path.resolve(app.getAppPath());
  process.env.ARGUS_SOURCE_ROOT = app.isPackaged
    ? packagedResource("source")
    : path.resolve(app.getAppPath());
  process.env.ARGUS_API_COLLECTIONS_DIR = storagePaths().collections;
  const ideTools = app.isPackaged ? packagedResource("ide-tools") : path.join(app.getAppPath(), "build", "ide-tools");
  process.env.ARGUS_IDE_TYPESCRIPT_SERVER = path.join(ideTools, "typescript-language-server", "lib", "cli.mjs");
  process.env.ARGUS_IDE_JS_DEBUG_SERVER = path.join(ideTools, "js-debug", "src", "dapDebugServer.js");
  process.env.ARGUS_IDE_TYPESCRIPT_SDK = path.join(ideTools, "typescript", "lib", "tsserver.js");
  process.env.ARGUS_IDE_JDTLS_HOME = path.join(ideTools, "jdtls");
  await addCommonCliLocationsToPath();
  const launcher = app.isPackaged ? packagedResource("native", "argus-process-launcher")
    : path.join(app.getAppPath(), "build", `native-${process.arch}`, "argus-process-launcher");
  fs.accessSync(launcher, fs.constants.X_OK);
  process.env.ARGUS_PROCESS_LAUNCHER = launcher;

  const springJar = resolveSpringJar();
  if (!fs.existsSync(springJar)) throw new Error(`Spring Boot artifact is missing: ${springJar}`);
  springBackend = spawn(resolveSpringRuntime(), [
    "-XX:TieredStopAtLevel=1",
    "-Xms32m",
    "-Xmx768m",
    "-Djava.awt.headless=true",
    "-Dspring.jmx.enabled=false",

    "-jar",
    springJar,
  ], {
    env: { ...process.env, ARGUS_PORT: String(LOCAL_PORT), ARGUS_BUILD_ID: UI_BUILD },
    stdio: ["ignore", "pipe", "pipe"],
  });
  springBackend.stdout.on("data", (chunk) => console.log(`[Spring] ${String(chunk).trimEnd()}`));
  springBackend.stderr.on("data", (chunk) => console.error(`[Spring] ${String(chunk).trimEnd()}`));
  springPidFile = path.join(app.getPath("userData"), "spring-backend.pid.json");
  fs.writeFileSync(springPidFile, JSON.stringify({ pid: springBackend.pid, build: UI_BUILD, jar: springJar }));
  springBackend.once("exit", (code, signal) => {
    plannerReminders?.stop();
    removeSpringPidFile();
    if (!quitting) console.error(`Argus Spring backend exited unexpectedly (${code ?? signal})`);
  });
  await waitForSpring();
}

function loadRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(`${LOCAL_URL}/?argusBuild=${UI_BUILD}${pendingPlannerOpen ? "&openDailyPlanner=1" : ""}`).catch((error) => {
    if (!quitting) console.error("Argus renderer failed to load", error);
  });
}

async function retryRendererLoad() {
  if (quitting || rendererRetryCount >= 3) return;
  rendererRetryCount += 1;
  try {
    await waitForSpring(5_000);
    loadRenderer();
  } catch (error) {
    if (!quitting) console.error("Argus renderer retry failed", error);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Argus Personal",
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: "#080c0f",
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  loadRenderer();
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("did-finish-load", () => {
    rendererRetryCount = 0;
    if (pendingPlannerOpen) {
      pendingPlannerOpen = false;
      mainWindow.webContents.send("argus-personal:open-daily-planner", { path: "/daily-tasks" });
    }
  });
  mainWindow.webContents.on("did-fail-load", (_event, _code, _description, url, isMainFrame) => {
    if (isMainFrame && url.startsWith(LOCAL_URL)) setTimeout(retryRendererLoad, 250);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(LOCAL_URL)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(LOCAL_URL)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.on("will-prevent-unload", event => {
    if (!resetScheduled) editorExit.handlePreventedUnload(event);
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

ipcMain.on("argus-personal:set-zoom-factor", (event, requestedFactor) => {
  const factor = Number(requestedFactor);
  if (!Number.isFinite(factor)) return;
  event.sender.setZoomFactor(Math.max(0.9, Math.min(1.3, factor)));
});

ipcMain.handle("argus-personal:planner-notification-status", event => {
  if (!isTrustedPlannerSender(event, mainWindow, LOCAL_URL)) throw new Error("Planner notification status is available only to the Argus main window");
  return plannerReminders?.status() || { supported: Notification.isSupported(), appMustBeRunning: true, permission: "system-controlled", lastDeliveryError: null };
});

ipcMain.handle("argus-personal:canvas-sharing", (event, request) => {
  if (!isTrustedPlannerSender(event, mainWindow, LOCAL_URL)) throw new Error("Canvas sharing controls are available only to the Argus main window");
  if (quitting || resetScheduled || !canvasSharing) throw new Error("Argus is not ready for Canvas sharing.");
  return canvasSharing.invoke(request);
});

ipcMain.handle("argus-personal:restart-after-maintenance", () => {
  setTimeout(() => editorExit.requestQuit({ restart: true }), 100);
  return { ok: true, restarting: true };
});

ipcMain.handle("argus-personal:reset-all-data", (_event, confirmation) => {
  if (String(confirmation || "").trim().toLowerCase() !== "delete all argus data") {
    throw new Error('Type "delete all argus data" exactly to confirm');
  }
  if (resetScheduled) return { ok: true, restarting: true };
  resetScheduled = true;
  setTimeout(() => resetAllArgusData().catch((error) => {
    resetScheduled = false;
    quitting = false;
    resumePlannerReminders();
    setWindowEnabled(true);
    console.error("Argus full reset failed", error);
    dialog.showErrorBox("Argus reset did not complete", error.message);
  }), 100);
  return { ok: true, restarting: true };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      await startBackend();
      canvasSharing = createDesktopCanvasSharing({ dataDir: app.getPath("userData"), baseUrl: LOCAL_URL, port: Number(process.env.ARGUS_CANVAS_PORT || 4187) });
      // Sharing failures must not prevent private Argus work from opening.
      await canvasSharing.resume().catch(error => console.error("Canvas sharing unavailable:", error.message));
      // Packaged updates reuse the same localhost origin. Clear only HTTP/cache
      // storage so a newly installed renderer can never inherit old assets;
      // localStorage preferences and saved workspace state remain untouched.
      await session.defaultSession.clearCache();
      createWindow();
      plannerReminders = createDailyPlannerReminders({
        baseUrl: LOCAL_URL,
        createNotification: options => new Notification(options),
        isSupported: () => Notification.isSupported(),
        getHeaders: () => ({ authorization: `Bearer ${process.env.ARGUS_MCP_TOKEN}` }),
        onOpenPlanner: openDailyPlanner,
        onError: error => console.error("Argus planner reminder", error.message),
      });
      plannerReminders.start();
      powerMonitor.on("resume", () => { if (!quitting && !resetScheduled) void plannerReminders?.poll(); });
    } catch (error) {
      console.error("Argus failed to start", error);
      try { await stopSpringBackend(); } catch (stopError) { console.error("Java startup cleanup failed", stopError); }
      dialog.showErrorBox("Argus could not start", error.message);
      app.exit(1);
    }
  });

  app.on("activate", () => {
    if (!mainWindow && springBackend && springBackend.exitCode == null && springBackend.signalCode == null) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    event.preventDefault();
    if (!resetScheduled) void editorExit.requestQuit();
  });

  process.once("exit", () => { plannerReminders?.stop(); try { springBackend?.kill("SIGKILL"); } catch {} });
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
}
