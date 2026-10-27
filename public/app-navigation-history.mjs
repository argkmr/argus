// Navigation only: no file contents, undo operations, network calls, or disk writes.
// Each direction is bounded independently, including after returning from the past.
export function createAppNavigationHistory(limit = 10) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("History limit must be a positive integer.");
  let previous = [], next = [], current = null;
  const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    record(value, { replace = false } = {}) {
      const entry = copy(value);
      if (!entry || equal(current, entry)) return false;
      if (!replace && current) { previous.push(current); previous = previous.slice(-limit); }
      current = entry;
      if (!replace) next = [];
      return true;
    },
    peek(direction) { return copy((direction < 0 ? previous : next).at(-1)); },
    move(direction) {
      const source = direction < 0 ? previous : next;
      if (!source.length) return null;
      const target = source.pop();
      if (current) {
        if (direction < 0) next = [...next, current].slice(-limit);
        else previous = [...previous, current].slice(-limit);
      }
      current = target;
      return copy(current);
    },
    get current() { return copy(current); },
    get backCount() { return previous.length; },
    get forwardCount() { return next.length; },
  };
}
