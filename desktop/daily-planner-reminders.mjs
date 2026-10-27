/** Native reminders are driven only by the local planner's opted-in, due reminders. */
export function createDailyPlannerReminders({
  baseUrl,
  fetchImpl = fetch,
  createNotification,
  isSupported,
  onOpenPlanner,
  getHeaders = () => ({}),
  intervalMs = 30_000,
  requestTimeoutMs = 5_000,
  deliveryTimeoutMs = 10_000,
  maxRemembered = 256,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onError = () => {},
}) {
  const endpoint = new URL("/api/daily-planner/reminders", baseUrl).href;
  const remembered = new Map();
  const memoryLimit = Math.max(1, Math.min(1_024, Math.trunc(maxRemembered) || 256));
  let active = false;
  let timer;
  let inFlight;
  let controller;
  let lastDeliveryError = null;

  function supported() {
    try { return Boolean(isSupported()); } catch { return false; }
  }

  function status() {
    return { supported: supported(), appMustBeRunning: true, permission: "system-controlled", lastDeliveryError };
  }

  async function request(url, options, signal) {
    const timeout = new AbortController();
    const timeoutId = setTimeoutImpl(() => timeout.abort(), requestTimeoutMs);
    try {
      const result = await fetchImpl(url, {
        ...options,
        headers: { accept: "application/json", ...getHeaders() },
        redirect: "error",
        signal: AbortSignal.any([signal, timeout.signal]),
      });
      if (!result.ok) throw new Error(`Planner reminder request failed (${result.status || "unavailable"})`);
      return result;
    } finally { clearTimeoutImpl(timeoutId); }
  }

  function remember(id, record) {
    remembered.set(id, record);
    while (remembered.size > memoryLimit) remembered.delete(remembered.keys().next().value);
  }

  function show(reminder, signal) {
    return new Promise((resolve, reject) => {
      let notification;
      let timeoutId;
      let settled = false;
      const record = { delivered: false, acknowledged: false };
      const cleanup = () => {
        clearTimeoutImpl(timeoutId);
        signal.removeEventListener("abort", cancelled);
        notification?.removeListener("show", shown);
        notification?.removeListener("failed", failed);
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          remembered.delete(reminder.id);
          try { notification?.close(); } catch {}
          reject(error);
        } else resolve(record);
      };
      const cancelled = () => finish(new Error("Planner reminder delivery cancelled"));
      const failed = () => finish(new Error("macOS or the operating system could not show the planner notification. Check notification settings for Argus."));
      const shown = () => {
        record.delivered = true;
        lastDeliveryError = null;
        finish();
      };
      try {
        if (signal.aborted) { cancelled(); return; }
        notification = createNotification({ title: reminder.title, body: reminder.body });
        record.notification = notification;
        notification.once("show", shown);
        notification.once("failed", failed);
        notification.on("click", () => {
          if (active) {
            try { onOpenPlanner(); } catch (error) { onError(error); }
          }
        });
        notification.once("close", () => { record.notification = undefined; });
        signal.addEventListener("abort", cancelled, { once: true });
        timeoutId = setTimeoutImpl(() => finish(new Error("Planner notification delivery was not confirmed. Check notification settings for Argus.")), deliveryTimeoutMs);
        remember(reminder.id, record);
        notification.show();
      } catch (error) { finish(error); }
    });
  }

  function validReminder(value) {
    return value && typeof value.id === "string" && /^\d{4}-\d{2}-\d{2}:(?:start|end)$/.test(value.id)
      && typeof value.title === "string" && value.title.length > 0 && value.title.length <= 256
      && typeof value.body === "string" && value.body.length <= 2_000;
  }

  async function check(signal) {
    if (!supported()) return;
    const response = await request(endpoint, { method: "GET", cache: "no-store" }, signal);
    const data = await response.json();
    if (signal.aborted || !active || data?.settings?.remindersEnabled !== true) return;
    for (const reminder of (Array.isArray(data.notifications) ? data.notifications : []).slice(0, 16)) {
      if (signal.aborted || !active) break;
      if (!validReminder(reminder)) continue;
      let record = remembered.get(reminder.id);
      if (record?.acknowledged) continue;
      if (!record?.delivered) {
        try { record = await show(reminder, signal); }
        catch (error) {
          if (!signal.aborted) { lastDeliveryError = String(error.message); onError(error); }
          continue;
        }
      }
      if (signal.aborted || !active) break;
      // If acknowledgment fails, retain the delivered ID and retry only the ACK.
      // The bounded session ledger prevents replay when the next poll retries it.
      try {
        await request(`${endpoint}/${encodeURIComponent(reminder.id)}/ack`, { method: "POST" }, signal);
        record.acknowledged = true;
      } catch (error) { if (!signal.aborted) onError(error); }
    }
  }

  function poll() {
    if (!active) return Promise.resolve();
    if (inFlight) return inFlight;
    const current = new AbortController();
    controller = current;
    const operation = check(current.signal).catch(error => { if (!current.signal.aborted) onError(error); });
    inFlight = operation.finally(() => {
      if (controller === current) controller = undefined;
      inFlight = undefined;
      if (active && current.signal.aborted) queueMicrotask(() => { void poll(); });
    });
    return inFlight;
  }

  function start() {
    if (active) return;
    active = true;
    timer = setIntervalImpl(() => { void poll(); }, intervalMs);
    timer?.unref?.();
    void poll();
  }

  function stop() {
    active = false;
    clearIntervalImpl(timer);
    timer = undefined;
    controller?.abort();
  }

  return { start, stop, poll, status };
}

/** Reject even same-origin iframes and other webContents when exposing native state. */
export function isTrustedPlannerSender(event, window, baseUrl) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
      || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === new URL(baseUrl).origin; }
  catch { return false; }
}
