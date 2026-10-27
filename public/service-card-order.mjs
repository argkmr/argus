// Layout only: reordering never starts, stops, or changes a service configuration.
const CARD = "[data-service-card]", HANDLE = "[data-service-card-drag]";
const id = value => typeof value === "string" || typeof value === "number" ? String(value) : "";
const reference = card => ({ key: card.key, repositoryId: card.repositoryId });
const signature = value => JSON.stringify(value);

export function buildServiceCards(repositories = [], configurations = []) {
  const byRepository = new Map(repositories.map(repository => [id(repository.id), repository]));
  const configured = new Set(), seen = new Set(), cards = [];
  for (const configuration of configurations) {
    const configurationId = id(configuration.id), repositoryId = id(configuration.repositoryId);
    if (!configurationId || seen.has(configurationId)) continue;
    seen.add(configurationId); configured.add(repositoryId);
    cards.push({ key: `configuration:${configurationId}`, repositoryId, configuration, repository: byRepository.get(repositoryId) });
  }
  for (const [repositoryId, repository] of byRepository) {
    if (repositoryId && !configured.has(repositoryId)) cards.push({ key: `repository:${repositoryId}`, repositoryId, repository });
  }
  return cards;
}

export function normalizeServiceCardOrder(saved, cards) {
  const available = new Map(cards.map(card => [card.key, card]));
  const previous = (Array.isArray(saved) ? saved : []).filter(item => item && typeof item.key === "string");
  const exact = new Set(previous.filter(item => available.has(item.key)).map(item => item.key));
  const used = new Set(), ordered = [];
  const append = card => { if (card && !used.has(card.key)) { used.add(card.key); ordered.push(reference(card)); } };
  for (const item of previous) {
    const card = available.get(item.key);
    // A repository placeholder becomes its first saved configuration in place (and
    // back again after the last configuration is deleted). Other configs keep their slots.
    append(card || cards.find(candidate => candidate.repositoryId === id(item.repositoryId)
      && !exact.has(candidate.key) && !used.has(candidate.key)));
  }
  cards.forEach(append);
  return ordered;
}

export function moveServiceCard(order, source, target, position = "before") {
  const from = order.findIndex(item => item.key === source), to = order.findIndex(item => item.key === target);
  if (from < 0 || to < 0 || source === target || !["before", "after"].includes(position)) return order;
  const result = order.filter(item => item.key !== source);
  result.splice(result.findIndex(item => item.key === target) + (position === "after" ? 1 : 0), 0, order[from]);
  return signature(result) === signature(order) ? order : result;
}

/** `restore` once after loading workspace; call `arrange` before rendering each list.
 * Save callback persists `{ serviceCardOrder: order }` through workspace preferences.
 * Ignore polling DOM replacements while `isDragging()`; onSettled requests a fresh render.
 */
export function createServiceCardOrder({ list, scrollContainer = list?.parentElement, save = async () => {}, onChange = () => {}, onSettled = () => {}, onError = () => {}, announce = () => {} }) {
  if (!list?.ownerDocument) throw new TypeError("A service list is required.");
  const document = list.ownerDocument, window = document.defaultView, listeners = [];
  let order = [], cards = [], initialized = false, destroyed = false, pending = null, indicator = null;
  let queued = null, saving = null, persisted = "", suppressClick = false;
  let scrollFrame = null, previousFrame = null;
  const listen = (target, event, callback, options) => {
    target.addEventListener(event, callback, options);
    listeners.push(() => target.removeEventListener(event, callback, options));
  };
  function persist() {
    queued = order.map(reference);
    if (saving) return saving;
    saving = Promise.resolve().then(async () => {
      while (queued && !destroyed) {
        const next = queued; queued = null;
        if (signature(next) === persisted) continue;
        try { await save(next); persisted = signature(next); }
        catch (error) { if (!destroyed) onError(error); }
      }
    }).finally(() => { saving = null; });
    return saving;
  }
  function restore(saved, { force = false } = {}) {
    if ((initialized && !force) || pending || saving) return;
    order = (Array.isArray(saved) ? saved : []).filter(item => item && typeof item.key === "string").map(reference);
    persisted = signature(order); initialized = true;
  }
  function arrange(nextCards) {
    cards = nextCards;
    const next = normalizeServiceCardOrder(order, cards);
    initialized = true;
    if (signature(next) !== signature(order)) { order = next; void persist(); }
    const byKey = new Map(cards.map(card => [card.key, card]));
    return order.map(item => byKey.get(item.key)).filter(Boolean);
  }
  function move(source, target, position) {
    if (destroyed) return false;
    const next = moveServiceCard(order, source, target, position);
    if (next === order) return false;
    order = next; void persist(); onChange(order.map(reference));
    const card = cards.find(item => item.key === source);
    announce(`${card?.configuration?.name || card?.repository?.name || "Service"} moved to position ${order.findIndex(item => item.key === source) + 1} of ${order.length}.`);
    return true;
  }
  function sourceFrom(target) {
    const handle = target?.closest?.(HANDLE), card = handle?.closest(CARD);
    return card && list.contains(handle) && !handle.disabled ? { handle, card, key: card.dataset.serviceCard } : null;
  }
  function clearIndicator() {
    indicator?.classList.remove("service-drop-before", "service-drop-after"); indicator = null;
  }
  function dropAt(x, y) {
    clearIndicator();
    if (!pending?.dragging) return null;
    const bounds = list.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    const hit = document.elementFromPoint(x, y);
    if (hit && !list.contains(hit)) return null;
    let target = hit?.closest?.(CARD);
    if (!target) {
      let distance = Infinity;
      for (const candidate of list.querySelectorAll(CARD)) {
        const rect = candidate.getBoundingClientRect();
        const next = Math.hypot(Math.max(rect.left - x, x - rect.right, 0), Math.max(rect.top - y, y - rect.bottom, 0));
        if (rect.width > 0 && rect.height > 0 && next < distance) { target = candidate; distance = next; }
      }
    }
    if (!target || target === pending.source.card) return null;
    const rect = target.getBoundingClientRect();
    const position = y < rect.top + rect.height * .2 ? "before" : y > rect.bottom - rect.height * .2 ? "after"
      : x < rect.left + rect.width / 2 ? "before" : "after";
    if (moveServiceCard(order, pending.source.key, target.dataset.serviceCard, position) === order) return null;
    indicator = target; target.classList.add(`service-drop-${position}`);
    return { target: target.dataset.serviceCard, position };
  }
  function focusHandle(key) {
    const card = [...list.querySelectorAll(CARD)].find(item => item.dataset.serviceCard === key);
    card?.querySelector(HANDLE)?.focus({ preventScroll: true });
    card?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
  function scrollVelocity() {
    if (!pending?.dragging || !scrollContainer?.getBoundingClientRect) return 0;
    const bounds = scrollContainer.getBoundingClientRect(), top = Math.max(0, bounds.top), bottom = Math.min(window.innerHeight || bounds.bottom, bounds.bottom);
    const edge = Math.min(64, (bottom - top) / 4), { lastX: x, lastY: y } = pending;
    if (edge <= 0 || x < bounds.left || x > bounds.right || y < top || y > bottom) return 0;
    return y < top + edge ? -600 * (1 - (y - top) / edge) : y > bottom - edge ? 600 * (1 - (bottom - y) / edge) : 0;
  }
  function autoScroll(timestamp) {
    scrollFrame = null;
    if (!pending?.dragging) return;
    const elapsed = previousFrame === null ? 16 : Math.min(40, timestamp - previousFrame), old = scrollContainer.scrollTop;
    previousFrame = timestamp;
    scrollContainer.scrollTop = Math.max(0, Math.min(scrollContainer.scrollHeight - scrollContainer.clientHeight, old + scrollVelocity() * elapsed / 1000));
    if (scrollContainer.scrollTop !== old) {
      dropAt(pending.lastX, pending.lastY);
      scrollFrame = window.requestAnimationFrame(autoScroll);
    } else previousFrame = null;
  }
  function finish(drop = null) {
    if (!pending) return;
    const current = pending; pending = null;
    if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
    scrollFrame = previousFrame = null;
    clearIndicator(); list.classList.remove("is-service-dragging");
    current.source.card.classList.remove("service-drag-source");
    current.source.handle.removeAttribute("aria-grabbed");
    if (list.hasPointerCapture?.(current.pointerId)) list.releasePointerCapture(current.pointerId);
    if (!current.dragging) return;
    suppressClick = true;
    if (drop) move(current.source.key, drop.target, drop.position);
    if (!destroyed) { onSettled(); focusHandle(current.source.key); }
  }
  listen(list, "pointerdown", event => {
    if (pending || event.button !== 0 || event.isPrimary === false) return;
    suppressClick = false;
    const source = sourceFrom(event.target);
    if (source) pending = { source, pointerId: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, dragging: false };
  });
  listen(window, "pointermove", event => {
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (!list.contains(pending.source.card)) { finish(); return; }
    pending.lastX = event.clientX; pending.lastY = event.clientY;
    if (!pending.dragging) {
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 6) return;
      pending.dragging = true; list.classList.add("is-service-dragging");
      pending.source.card.classList.add("service-drag-source");
      pending.source.handle.setAttribute("aria-grabbed", "true");
      try { list.setPointerCapture(event.pointerId); } catch { /* Window listeners cover capture failure. */ }
    }
    event.preventDefault(); dropAt(event.clientX, event.clientY);
    if (scrollFrame === null && scrollVelocity() && window.requestAnimationFrame) scrollFrame = window.requestAnimationFrame(autoScroll);
  }, { passive: false });
  listen(window, "pointerup", event => {
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (pending.dragging) event.preventDefault();
    finish(dropAt(event.clientX, event.clientY));
  });
  listen(window, "pointercancel", event => { if (pending?.pointerId === event.pointerId) finish(); });
  listen(list, "lostpointercapture", () => finish());
  listen(window, "blur", () => finish());
  listen(list, "dragstart", event => { if (sourceFrom(event.target)) event.preventDefault(); });
  listen(list, "click", event => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  listen(list, "keydown", event => {
    if (pending && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); return; }
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    const delta = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    const source = sourceFrom(event.target);
    if (!delta || !source) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const target = order[order.findIndex(item => item.key === source.key) + delta];
    if (!pending && target && move(source.key, target.key, delta < 0 ? "before" : "after")) focusHandle(source.key);
  }, true);
  return {
    restore, arrange, move,
    snapshot: () => order.map(reference),
    isDragging: () => Boolean(pending),
    flush: () => saving || Promise.resolve(),
    destroy() { if (destroyed) return; destroyed = true; finish(); queued = null; listeners.forEach(remove => remove()); },
  };
}
