// Job GETs contain full presentation metadata and bounded diagnostic tails.
// Delta GETs use absolute UTF-16 cursors; their text must be applied to the
// snapshot used to issue the request, never blindly appended to a newer poll.
const OUTPUT_LIMIT = 500_000;
const terminal = new Set(["completed", "failed", "cancelled", "aborted", "interrupted"]);
const cursor = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const phase = job => terminal.has(job?.status) ? job.completionPending ? 2 : 3 : job?.status === "starting" ? 0 : 1;
const fallbackAttempt = job => job?.cliSessionFallback === true ? 1 : 0;
const sameJob = (left, right) => Boolean(left && right && (!left.id || !right.id || left.id === right.id));

/** Accept a full job snapshot only if it does not rewind the same attempt. */
export function reconcileAgentJob(current, incoming) {
  if (!incoming) return current;
  if (!sameJob(current, incoming)) return incoming;
  // A stop is irreversible even while stdout is still draining. A missing-
  // session fallback is permitted only before terminal processing begins.
  if (current.stopRequested === true && incoming.stopRequested !== true) return current;
  if (terminal.has(current.status) && incoming.status && phase(incoming) < phase(current)) return current;
  const attempt = fallbackAttempt(incoming) - fallbackAttempt(current);
  if (attempt < 0) return current;
  if (attempt === 0) {
    for (const field of ["outputCursor", "errorCursor"]) {
      const before = cursor(current[field]), after = cursor(incoming[field]);
      if (before !== null && after !== null && after < before) return current;
    }
    if (incoming.status && current.status && phase(incoming) < phase(current)) return current;
  }
  // An intentionally empty displayOutput must remain empty: raw stdout may
  // contain tool events or private machine blocks, not a visible answer.
  return { ...current, ...incoming };
}

function deltaText(base, incoming, field) {
  const value = incoming[field];
  if (typeof value !== "string") return base?.[field] || "";
  if (incoming[`${field}Reset`] === true || !base) return value.slice(-OUTPUT_LIMIT);
  const before = cursor(base[`${field}Cursor`]);
  const after = cursor(incoming[`${field}Cursor`]);
  const prior = String(base[field] || "");
  if (before === null || after === null) return (prior + value).slice(-OUTPUT_LIMIT);
  const start = after - value.length;
  if (before > after) return prior;
  if (before < start) return value.slice(-OUTPUT_LIMIT); // a gap: retain only the known tail
  return (prior + value.slice(before - start)).slice(-OUTPUT_LIMIT);
}

/** `base` is the immutable job used to construct the afterOutput/Error query. */
export function mergeAgentJob(current, incoming, base = current) {
  if (!incoming) return current;
  if (!sameJob(base, incoming)) return reconcileAgentJob(current, incoming);
  // A missing-session retry is a new stream under the same job ID. The backend
  // marks it and resets its cursors; never prefix it with the failed attempt.
  const sameAttempt = fallbackAttempt(base) === fallbackAttempt(incoming);
  const snapshot = { ...base, ...incoming,
    output: deltaText(sameAttempt ? base : null, incoming, "output"),
    error: deltaText(sameAttempt ? base : null, incoming, "error"),
  };
  return reconcileAgentJob(current, snapshot);
}
