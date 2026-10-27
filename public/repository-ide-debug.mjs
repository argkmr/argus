// Presentation-only debugger helpers. Counts and output come from the local
// debugger; these helpers never infer a breakpoint hit or a successful attach.
export function describeDebugSession(session, busy = false) {
  const state = session?.state || "detached";
  const labels = { attached: "Running", stopped: "Paused", attaching: "Connecting", detached: "Not attached", terminated: "Ended" };
  return {
    state,
    label: busy ? "Working…" : labels[state] || "Unknown status",
    attached: Boolean(session) && !["detached", "terminated"].includes(state),
    paused: state === "stopped",
    canPause: !busy && state === "attached",
    canStep: !busy && state === "stopped",
  };
}

export function createDebugConsole({ maxEntries = 400, maxCharacters = 80_000 } = {}) {
  const entries = [];
  let characters = 0, discarded = false;
  return {
    get entries() { return entries.slice(); },
    get discarded() { return discarded; },
    clear() { entries.length = 0; characters = 0; discarded = false; },
    append(event) {
      if (event?.event !== "output" || event.body?.category === "telemetry") return false;
      // Keep this plain text. ANSI control sequences have no meaning in a log
      // viewer and must not become HTML or terminal commands.
      const raw = String(event.body?.output ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      if (!raw) return false;
      const text = raw.slice(-maxCharacters);
      discarded ||= raw.length > text.length;
      const category = event.body?.category === "stderr" ? "stderr" : event.body?.category === "stdout" ? "stdout" : "console";
      entries.push({ category, text }); characters += text.length;
      while (entries.length > maxEntries || characters > maxCharacters) { characters -= entries.shift().text.length; discarded = true; }
      return true;
    },
  };
}
