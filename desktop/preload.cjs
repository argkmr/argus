const { contextBridge, ipcRenderer } = require("electron");
const plannerOpenListeners = new Set();
let pendingPlannerOpen = false;
ipcRenderer.on("argus-personal:open-daily-planner", () => {
  if (!plannerOpenListeners.size) { pendingPlannerOpen = true; return; }
  for (const listener of plannerOpenListeners) listener({ path: "/daily-tasks" });
});

contextBridge.exposeInMainWorld("argusDesktop", {
  canvasSharing: (request) => ipcRenderer.invoke("argus-personal:canvas-sharing", request),
  setZoomFactor: (factor) => ipcRenderer.send("argus-personal:set-zoom-factor", factor),
  resetAllData: (confirmation) => ipcRenderer.invoke("argus-personal:reset-all-data", confirmation),
  restartAfterMaintenance: () => ipcRenderer.invoke("argus-personal:restart-after-maintenance"),
  getPlannerNotificationStatus: () => ipcRenderer.invoke("argus-personal:planner-notification-status"),
  onPlannerOpen: (callback) => {
    if (typeof callback !== "function") throw new TypeError("A planner navigation callback is required");
    plannerOpenListeners.add(callback);
    if (pendingPlannerOpen) {
      pendingPlannerOpen = false;
      queueMicrotask(() => { if (plannerOpenListeners.has(callback)) callback({ path: "/daily-tasks" }); });
    }
    return () => plannerOpenListeners.delete(callback);
  },
});
