export function providerAvailability(provider) {
  return provider?.availability || { status: "unknown", canRun: true, message: "Usage status unavailable · you can retry", resetHint: "", source: "not-exposed" };
}

export function providerCanRun(provider) {
  return Boolean(provider?.installed && provider?.authenticated && providerAvailability(provider).canRun !== false && provider?.canRun !== false);
}

export function providerIsVerifiedReady(provider) {
  return providerCanRun(provider) && providerAvailability(provider).status === "available";
}

export function providerOptionSuffix(provider) {
  if (!provider?.installed) return " — not installed";
  if (!provider.authenticated) return " — sign-in required";
  const status = providerAvailability(provider).status;
  if (status === "limited") return " — some usage limited";
  if (status === "exhausted") return " — quota reached";
  if (status === "rate-limited") return " — rate limited";
  return "";
}

export function providerConnectionStatus(provider, refreshing = false) {
  if (refreshing) return "Checking sign-in and usage status…";
  if (!provider?.installed) return "Not installed";
  if (!provider.authenticated) return "Sign-in required";
  const availability = providerAvailability(provider);
  if (!providerCanRun(provider)) return availability.message || "Currently unavailable";
  if (availability.status === "limited") return "Connected · some usage limited · retry allowed";
  if (providerIsVerifiedReady(provider)) return availability.source === "account-rate-limits"
    ? "Connected · account reports capacity" : "Connected · recent request succeeded";
  return provider.id === "claude" ? "Connected · usage checked when you send" : "Connected · usage unknown · retry allowed";
}

export function providerAvailabilitySource(provider) {
  const source = providerAvailability(provider).source;
  if (source === "account-rate-limits") return "Read from Codex account metadata. No AI prompt was sent; model access is checked on use.";
  if (source === "last-run") return "Observed from a recent CLI invocation; not a permanent account restriction.";
  return "Current usage could not be verified. An old error does not establish current account availability.";
}

export function providerSnapshotKey(providers) {
  // A timestamp-only refresh must not rebuild open model menus or composers.
  return JSON.stringify(providers, (key, value) => key === "checkedAt" ? undefined : value);
}

export function createProviderStatusPoller({ read, apply, visible = () => true, now = Date.now, intervalMs = 60_000, onBusy = () => {}, minimumRefreshMs = 10_000 }) {
  let inFlight, lastAttempt = -Infinity, revision = 0;
  return {
    invalidate() { revision++; },
    poll({ force = false } = {}) {
      if (inFlight) return inFlight;
      // Picker-open refreshes must reach the CLI instead of waiting for the
      // background interval, but rapid open/close cannot spawn a process storm.
      if (!visible() || now() - lastAttempt < (force ? minimumRefreshMs : intervalMs)) return Promise.resolve();
      lastAttempt = now();
      const expectedRevision = revision;
      onBusy(true);
      inFlight = Promise.resolve().then(() => read({ force })).then(providers => {
        if (revision === expectedRevision) apply(providers);
      }).catch(() => {
        // A transient read failure must not overwrite last-known account state.
      }).finally(() => { inFlight = undefined; onBusy(false); });
      return inFlight;
    },
  };
}
