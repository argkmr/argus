const TAB = "[data-repository-tab]";
const CHIP = "[data-toggle-tab-group]";
const GROUP = "[data-tab-group-block]";
const DROP_CLASSES = ["repo-drop-before", "repo-drop-after", "repo-drop-inside"];
const identity = ({ type, id }) => ({ type, id });

// Geometry is kept separate from pointer events so grouped drops have one contract.
export function resolveRepositoryTabDrop({ source, hit, clientX }) {
  if (!source?.id || !hit?.id || !Number.isFinite(clientX)) return null;
  let target = identity(hit);
  let left = hit.left, right = hit.right;
  if (source.type === "group" && hit.groupId) {
    target = { type: "group", id: hit.groupId };
    left = hit.groupLeft ?? left;
    right = hit.groupRight ?? right;
  }
  if (source.type === target.type && source.id === target.id) return null;
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return null;
  const fraction = (clientX - left) / (right - left);
  const position = hit.edgePosition || (source.type === "repository" && target.type === "group"
    ? fraction < .25 ? "before" : fraction > .75 ? "after" : "inside"
    : fraction < .5 ? "before" : "after");
  return { source: identity(source), target, position };
}

export function setupRepositoryTabDrag({ rail, onMove, canDrag = () => true, onSettled = () => {} }) {
  if (!rail?.ownerDocument) throw new TypeError("A repository tab rail is required.");
  const document = rail.ownerDocument;
  const window = document.defaultView;
  const listeners = [];
  let pending = null;
  let indicator = null;
  let frame = null;
  let previousFrame = null;
  let suppressClick = false;
  let destroyed = false;
  let keyboardPending = false;
  let dragLabel = null;

  function listen(node, name, callback, options) {
    node.addEventListener(name, callback, options);
    listeners.push(() => node.removeEventListener(name, callback, options));
  }
  function groupFor(node) { return node.closest(GROUP); }
  function groupIdFor(node) { return groupFor(node)?.dataset.tabGroupBlock || node.dataset.tabGroup || null; }
  function clearIndicator() {
    if (indicator) indicator.classList.remove(...DROP_CLASSES);
    indicator = null;
  }
  function createDragLabel() {
    const parent = rail.parentElement;
    if (!parent || !document.createElement) return;
    dragLabel = document.createElement("span");
    dragLabel.classList.add("repo-tab-drag-label");
    dragLabel.setAttribute("aria-hidden", "true");
    dragLabel.style.pointerEvents = "none";
    const name = pending.source.button.querySelector(".repo-tab-label, .repo-tab-group-name");
    dragLabel.textContent = (name?.textContent || pending.source.button.textContent || pending.source.id).trim();
    parent.append(dragLabel);
  }
  function positionDragLabel() {
    if (!dragLabel || !pending) return;
    const parent = dragLabel.parentElement;
    const bounds = parent.getBoundingClientRect();
    const scaleX = parent.offsetWidth ? bounds.width / parent.offsetWidth : 1;
    const scaleY = parent.offsetHeight ? bounds.height / parent.offsetHeight : 1;
    const x = (pending.x - bounds.left) / (scaleX || 1) - (parent.clientLeft || 0);
    const y = (pending.y - bounds.top) / (scaleY || 1) - (parent.clientTop || 0);
    const width = parent.clientWidth || parent.offsetWidth;
    const height = parent.clientHeight || parent.offsetHeight;
    dragLabel.style.left = `${Math.max(4, Math.min(x + 12, width - dragLabel.offsetWidth - 4))}px`;
    dragLabel.style.top = `${Math.max(2, Math.min(y - dragLabel.offsetHeight / 2, height - dragLabel.offsetHeight - 2))}px`;
  }
  function insideRail(x, y) {
    const bounds = rail.getBoundingClientRect();
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  }
  function sourceFrom(target) {
    if (target?.closest?.("[data-close-repository]")) return null;
    const button = target?.closest?.(`.repo-tab-main, ${CHIP}`);
    if (!button || !rail.contains(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return null;
    const tab = button.closest(TAB);
    if (tab) return { type: "repository", id: tab.dataset.repositoryTab, groupId: groupIdFor(tab), node: tab, button };
    return { type: "group", id: button.dataset.toggleTabGroup, node: groupFor(button) || button, button };
  }
  function hitAt(x, y) {
    if (!insideRail(x, y)) return null;
    const underPointer = document.elementFromPoint(x, y);
    if (underPointer && !rail.contains(underPointer)) return null;
    let node = underPointer?.closest?.(`${TAB}, ${CHIP}`);
    // Small inter-tab gaps and the empty end of the rail are useful drop zones too.
    if (!node || !rail.contains(node)) {
      let distance = Infinity;
      const railBounds = rail.getBoundingClientRect();
      for (const candidate of rail.querySelectorAll(`${TAB}, ${CHIP}`)) {
        const bounds = candidate.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.right < railBounds.left || bounds.left > railBounds.right) continue;
        const nextDistance = Math.max(bounds.left - x, x - bounds.right, 0);
        if (nextDistance < distance) { node = candidate; distance = nextDistance; }
      }
    }
    if (!node) return null;
    const group = groupFor(node);
    const groupBounds = group?.getBoundingClientRect();
    let edgePosition;
    if (group) {
      const members = [...group.querySelectorAll(`${TAB}, ${CHIP}`)].map((member) => member.getBoundingClientRect()).filter((bounds) => bounds.width > 0);
      if (x < Math.min(...members.map((bounds) => bounds.left))) edgePosition = "before";
      else if (x > Math.max(...members.map((bounds) => bounds.right))) edgePosition = "after";
      // The group's outer gap remains reachable even when its last member is the source.
      if (edgePosition) node = group;
    }
    const bounds = node.getBoundingClientRect();
    return {
      type: node.matches(TAB) ? "repository" : "group",
      id: node.dataset.repositoryTab || node.dataset.toggleTabGroup || node.dataset.tabGroupBlock,
      groupId: groupIdFor(node), node, group,
      left: bounds.left, right: bounds.right,
      groupLeft: groupBounds?.left, groupRight: groupBounds?.right,
      edgePosition,
    };
  }
  function topLevelNodes() {
    return [...rail.querySelectorAll(`${GROUP}, ${TAB}`)].filter((node) => node.matches(GROUP) || !groupFor(node));
  }
  function alreadyAdjacent(nodes, sourceNode, targetNode, position) {
    const sourceIndex = nodes.indexOf(sourceNode), targetIndex = nodes.indexOf(targetNode);
    return sourceIndex >= 0 && targetIndex >= 0
      && (position === "before" ? sourceIndex + 1 === targetIndex : sourceIndex - 1 === targetIndex);
  }
  function meaningful(drop, hit) {
    const source = pending.source;
    if (source.type === "repository" && drop.target.type === "repository") {
      if (source.groupId !== hit.groupId) return true;
      const siblings = source.groupId
        ? [...rail.querySelectorAll(TAB)].filter((node) => groupIdFor(node) === source.groupId)
        : topLevelNodes();
      return !alreadyAdjacent(siblings, source.node, hit.node, drop.position);
    }
    if (source.type === "repository" && drop.position === "inside") {
      if (source.groupId !== drop.target.id) return true;
      return [...rail.querySelectorAll(TAB)].filter((node) => groupIdFor(node) === source.groupId).at(-1) !== source.node;
    }
    if (source.type === "repository" && source.groupId) return true;
    return !alreadyAdjacent(topLevelNodes(), source.node, drop.target.type === "group" ? hit.group || hit.node : hit.node, drop.position);
  }
  function updateDrop() {
    clearIndicator();
    if (!pending?.dragging) return null;
    const hit = hitAt(pending.x, pending.y);
    if (!hit) return null;
    const drop = resolveRepositoryTabDrop({ source: pending.source, hit, clientX: pending.x });
    if (!drop || !meaningful(drop, hit)) return null;
    indicator = drop.target.type === "group" ? hit.group || hit.node : hit.node;
    indicator.classList.add(`repo-drop-${drop.position}`);
    return drop;
  }
  function scrollVelocity() {
    if (!pending?.dragging || !insideRail(pending.x, pending.y)) return 0;
    const bounds = rail.getBoundingClientRect();
    const edge = Math.min(48, bounds.width / 4);
    if (!edge) return 0;
    if (pending.x < bounds.left + edge) return -720 * (1 - (pending.x - bounds.left) / edge);
    if (pending.x > bounds.right - edge) return 720 * (1 - (bounds.right - pending.x) / edge);
    return 0;
  }
  function scrollFrame(timestamp) {
    frame = null;
    if (!pending?.dragging) return;
    if (!canDrag(identity(pending.source))) { finish(); return; }
    const elapsed = previousFrame === null ? 16 : Math.min(40, timestamp - previousFrame);
    previousFrame = timestamp;
    const oldScroll = rail.scrollLeft;
    rail.scrollLeft = Math.max(0, Math.min(rail.scrollWidth - rail.clientWidth, oldScroll + scrollVelocity() * elapsed / 1000));
    if (rail.scrollLeft !== oldScroll) {
      updateDrop();
      frame = window.requestAnimationFrame(scrollFrame);
    } else previousFrame = null;
  }
  function scheduleScroll() {
    if (frame === null && scrollVelocity()) frame = window.requestAnimationFrame(scrollFrame);
  }
  function finish(drop = null) {
    const current = pending;
    if (!current) return;
    pending = null;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = previousFrame = null;
    clearIndicator();
    dragLabel?.remove();
    dragLabel = null;
    current.source.node.classList.remove("repo-drag-source");
    rail.classList.remove("is-tab-dragging");
    if (rail.hasPointerCapture?.(current.pointerId)) rail.releasePointerCapture(current.pointerId);
    if (!current.dragging) return;
    suppressClick = true;
    try { if (drop) onMove(drop); }
    finally { onSettled(); }
  }
  function pointerDown(event) {
    if (pending || keyboardPending || event.button !== 0 || event.isPrimary === false) return;
    suppressClick = false;
    const source = sourceFrom(event.target);
    if (!source || !canDrag(identity(source))) return;
    pending = { source, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, dragging: false };
  }
  function pointerMove(event) {
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (!canDrag(identity(pending.source)) || !rail.contains(pending.source.node)) { finish(); return; }
    pending.x = event.clientX;
    pending.y = event.clientY;
    if (!pending.dragging) {
      if (Math.hypot(pending.x - pending.startX, pending.y - pending.startY) < 6) return;
      pending.dragging = true;
      rail.classList.add("is-tab-dragging");
      pending.source.node.classList.add("repo-drag-source");
      createDragLabel();
      try { rail.setPointerCapture(event.pointerId); } catch { /* Window listeners also cover pointers without capture. */ }
    }
    event.preventDefault();
    positionDragLabel();
    updateDrop();
    scheduleScroll();
  }
  function pointerUp(event) {
    if (!pending || event.pointerId !== pending.pointerId) return;
    pending.x = event.clientX;
    pending.y = event.clientY;
    const drop = pending.dragging && canDrag(identity(pending.source)) ? updateDrop() : null;
    if (pending.dragging) event.preventDefault();
    finish(drop);
  }
  function pointerCancel(event) {
    if (pending && event.pointerId === pending.pointerId) finish();
  }
  async function keyboardMove(event) {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const source = sourceFrom(event.target);
    if (!source) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pending || keyboardPending || !canDrag(identity(source))) return;
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const candidates = source.type === "group"
      ? topLevelNodes()
      : [...rail.querySelectorAll(`${TAB}, ${CHIP}`)];
    const target = candidates[candidates.indexOf(source.node) + direction];
    if (!target) return;
    const targetGroup = target.matches(GROUP) || target.matches(CHIP);
    const targetId = target.dataset.repositoryTab || target.dataset.toggleTabGroup || target.dataset.tabGroupBlock;
    const position = source.type === "repository" && targetGroup && source.groupId !== targetId
      ? "inside" : direction < 0 ? "before" : "after";
    const drop = { source: identity(source), target: { type: targetGroup ? "group" : "repository", id: targetId }, position };
    const fallbackGroupId = targetGroup ? targetId : groupIdFor(target);
    keyboardPending = true;
    try { await onMove(drop); }
    finally {
      keyboardPending = false;
      if (!destroyed) {
        onSettled();
        const selector = source.type === "group" ? CHIP : TAB;
        const replacement = [...rail.querySelectorAll(selector)].find((node) => (node.dataset.repositoryTab || node.dataset.toggleTabGroup) === source.id);
        const fallback = [...rail.querySelectorAll(CHIP)].find((node) => node.dataset.toggleTabGroup === fallbackGroupId);
        const focus = replacement?.matches(TAB) ? replacement.querySelector(".repo-tab-main") : replacement || fallback;
        focus?.focus({ preventScroll: true });
        (replacement || fallback)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      }
    }
  }
  listen(rail, "pointerdown", pointerDown);
  listen(window, "pointermove", pointerMove, { passive: false });
  listen(window, "pointerup", pointerUp);
  listen(window, "pointercancel", pointerCancel);
  listen(rail, "lostpointercapture", pointerCancel);
  listen(window, "blur", () => finish());
  listen(window, "keydown", (event) => {
    if (pending && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); }
  }, true);
  listen(rail, "click", (event) => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  listen(rail, "dragstart", (event) => { if (sourceFrom(event.target)) event.preventDefault(); });
  listen(rail, "keydown", keyboardMove, true);
  return {
    isDragging: () => Boolean(pending?.dragging),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      finish();
      for (const remove of listeners) remove();
      suppressClick = false;
    },
  };
}
