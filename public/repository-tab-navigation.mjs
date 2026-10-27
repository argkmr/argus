// All scroll distances are CSS pixels. Callers normalize zoomed DOM rectangles.
export function repositoryTabScrollState({ scrollLeft = 0, scrollWidth = 0, clientWidth = 0 }) {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  const position = Math.max(0, Math.min(scrollLeft, maxScrollLeft));
  const overflow = maxScrollLeft > 2;
  return { overflow, canScrollLeft: overflow && position > 2, canScrollRight: overflow && position < maxScrollLeft - 2, maxScrollLeft, scrollLeft: position };
}

export function repositoryTabRevealLeft({ scrollLeft, clientWidth, tabLeft, tabRight, railLeft, scrollWidth }) {
  const { maxScrollLeft, scrollLeft: position } = repositoryTabScrollState({ scrollLeft, clientWidth, scrollWidth });
  const left = tabLeft - railLeft;
  const right = tabRight - railLeft;
  let next = position;
  if (left < 4 || right - left > clientWidth) next += left - 4;
  else if (right > clientWidth - 4) next += right - clientWidth + 4;
  next = Math.max(0, Math.min(maxScrollLeft, next));
  return Math.abs(next - position) > 1 ? next : null;
}

export function repositoryTabWheelDelta(event, dimensions) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY || 0)) return 0;
  const { overflow, scrollLeft, maxScrollLeft } = repositoryTabScrollState(dimensions);
  if (!overflow) return 0;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? dimensions.clientWidth : 1;
  const delta = (event.deltaY || 0) * unit;
  return Math.max(0, Math.min(maxScrollLeft, scrollLeft + delta)) - scrollLeft;
}

export function repositoryTabFocusIndex(index, key, count) {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight') return index < 0 ? 0 : (index + 1) % count;
  if (key === 'ArrowLeft') return index < 0 ? count - 1 : (index - 1 + count) % count;
  return null;
}
