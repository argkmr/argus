/** A replica group is one logical node: changing its count never moves ports. */
export function getReplicaLayout(value) {
  const numeric = Number(value);
  const count = Number.isFinite(numeric) ? Math.max(1, Math.min(1000, Math.trunc(numeric))) : 1;
  const layers = Math.min(3, count - 1);
  return { count, extent: layers * 6, offsets: Array.from({ length: layers }, (_, index) => (layers - index) * 6) };
}
