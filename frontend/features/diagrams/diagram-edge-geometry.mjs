// Shared by React Flow and the portable SVG exporter. A loop must finish on
// its actual selected handle, including when its source and target coincide.
export function getSelfLoopGeometry({ sourceX, sourceY, targetX, targetY, sourcePosition = 'right', sequence = false, curvature = .3 }) {
  const bend = Math.max(.05, Math.min(1.2, Number(curvature) || .3));
  const reach = 80 * (1 + bend);
  const horizontal = !['top', 'bottom'].includes(sourcePosition);
  const direction = ['left', 'top'].includes(sourcePosition) ? -1 : 1;
  if (sequence && Math.abs(targetY - sourceY) >= 1) {
    const sideX = (direction > 0 ? Math.max(sourceX, targetX) : Math.min(sourceX, targetX)) + direction * reach;
    return {
      path: `M ${sourceX} ${sourceY} H ${sideX} V ${targetY} H ${targetX}`,
      labelX: (sourceX + sideX) / 2,
      labelY: sourceY,
      controls: [{ x: sourceX, y: sourceY }, { x: sideX, y: sourceY }, { x: sideX, y: targetY }, { x: targetX, y: targetY }],
    };
  }
  const start = { x: sourceX, y: sourceY }, end = { x: targetX, y: targetY };
  let first, second;
  if (horizontal) {
    const outside = (direction > 0 ? Math.max(sourceX, targetX) : Math.min(sourceX, targetX)) + direction * reach;
    first = { x: outside, y: sourceY - 56 };
    second = { x: outside, y: targetY + 56 };
  } else {
    const outside = (direction > 0 ? Math.max(sourceY, targetY) : Math.min(sourceY, targetY)) + direction * reach;
    first = { x: sourceX - 56, y: outside };
    second = { x: targetX + 56, y: outside };
  }
  return {
    path: `M ${sourceX} ${sourceY} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${targetX} ${targetY}`,
    labelX: (sourceX + 3 * first.x + 3 * second.x + targetX) / 8,
    labelY: (sourceY + 3 * first.y + 3 * second.y + targetY) / 8,
    controls: [start, first, second, end],
  };
}
