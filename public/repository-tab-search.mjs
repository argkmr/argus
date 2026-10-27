// Local switcher over already-onboarded repositories, including hidden group tabs.
// This controller never discovers, fetches, changes group state, or persists anything.
export function createRepositoryTabSearch({ document, getRepositories, getGroups, getActiveRepositoryId, onSelect, onError = () => {} }) {
  const byId = suffix => document.querySelector(`#repository-tab-search-${suffix}`);
  const toggle = byId("toggle"), panel = byId("popover"), input = byId("input"), results = byId("results"), status = byId("status"), dismiss = byId("close");
  if (![toggle, panel, input, results, status, dismiss].every(Boolean) || typeof onSelect !== "function") throw new TypeError("Repository search requires its controls and a selection callback.");
  const win = document.defaultView, listeners = [], rowById = new Map();
  let disposed = false, opened = false, needsFocus = false, epoch = 0, pending = null, rows = [], errorMessage = "";
  const listen = (node, event, callback) => { node?.addEventListener(event, callback); listeners.push(() => node?.removeEventListener(event, callback)); };
  const element = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const report = error => { try { Promise.resolve(onError(error)).catch(() => {}); } catch { /* Reporting cannot break keyboard or selection cleanup. */ } };
  const isOpen = () => !disposed && panel.matches(":popover-open");
  function repositories() {
    const seen = new Set();
    return (getRepositories?.() || []).filter(repository => {
      if (!repository || !["string", "number"].includes(typeof repository.id)) return false;
      const id = String(repository.id); if (!id || seen.has(id)) return false;
      seen.add(id); return true;
    });
  }
  function position() {
    if (!isOpen()) return;
    const viewport = document.documentElement, scale = panel.getBoundingClientRect().width / panel.offsetWidth || 1;
    panel.style.maxWidth = `${Math.max(1, viewport.clientWidth - 24) / scale}px`;
    panel.style.maxHeight = `${Math.min(480, Math.max(1, viewport.clientHeight - 24) / scale)}px`;
    const anchor = toggle.getBoundingClientRect(), size = panel.getBoundingClientRect();
    panel.style.right = `${Math.max(12, Math.min(viewport.clientWidth - anchor.right, viewport.clientWidth - size.width - 12)) / scale}px`;
    panel.style.top = `${Math.max(12, Math.min(anchor.bottom + 8, viewport.clientHeight - size.height - 12)) / scale}px`;
  }
  function close(restoreFocus = false) {
    if (disposed) return;
    opened = false; needsFocus = false; epoch++;
    if (panel.matches(":popover-open")) panel.hidePopover();
    toggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) toggle.focus({ preventScroll: true });
  }
  async function select(id) {
    if (!isOpen() || pending) return;
    // Re-check live ownership: an old result must not activate an offboarded repo.
    try {
      if (!repositories().some(repository => String(repository.id) === id)) { refresh(); return; }
    } catch (error) { status.textContent = "Could not load repository choices. Try reopening search."; report(error); return; }
    const selection = { id, epoch }; pending = selection; errorMessage = ""; refresh();
    try {
      const selected = await onSelect(id);
      if (!disposed && selection.epoch === epoch && isOpen()) {
        if (selected === true) close();
        else errorMessage = "Selection cancelled. Choose a repository to continue.";
      }
    } catch (error) {
      if (!disposed) {
        report(error);
        if (selection.epoch === epoch && isOpen()) errorMessage = "Could not open this repository. Try again.";
      }
    } finally {
      if (pending === selection) pending = null;
      if (!disposed && isOpen()) refresh();
    }
  }
  function refresh() {
    if (disposed || !opened) return;
    try {
      const all = repositories(), groups = getGroups?.() || [], owner = new Map();
      for (const group of groups) for (const id of group?.repositoryIds || []) if (!owner.has(String(id))) owner.set(String(id), group);
      const terms = String(input.value || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const current = String(getActiveRepositoryId?.() ?? "");
      const active = document.activeElement, focused = rows.find(row => row === active || row.contains(active));
      const focusedId = focused?.dataset.repositoryId;
      const matched = all.filter(repository => {
        const haystack = [repository.name, repository.path, owner.get(String(repository.id))?.name].join("\n").toLocaleLowerCase();
        return terms.every(term => haystack.includes(term));
      });
      const liveIds = new Set(all.map(repository => String(repository.id)));
      for (const id of rowById.keys()) if (!liveIds.has(id)) rowById.delete(id);
      rows = matched.map(repository => {
        const id = String(repository.id), group = owner.get(id);
        let entry = rowById.get(id);
        if (!entry) {
          const row = element("button", "repository-tab-search-result"); row.type = "button"; row.dataset.repositoryId = id;
          const copy = element("span", "repository-tab-search-copy"), name = element("strong", ""), path = element("small", ""), label = element("em", "");
          copy.append(name, path, label); row.append(copy); row.addEventListener("click", () => { void select(id); });
          entry = { row, name, path, label }; rowById.set(id, entry);
        }
        entry.name.textContent = String(repository.name || repository.path || id);
        entry.path.textContent = String(repository.path || ""); entry.path.hidden = !entry.path.textContent;
        entry.label.textContent = group ? `${String(group.name || "Repository group")}${group.collapsed ? " · tabs hidden" : ""}` : ""; entry.label.hidden = !group;
        entry.row.title = [entry.name.textContent, entry.path.textContent, entry.label.textContent].filter(Boolean).join("\n");
        entry.row.setAttribute("aria-current", id === current ? "page" : "false"); entry.row.disabled = Boolean(pending);
        return entry.row;
      });
      // Avoid replacing identical rows on each workspace/status refresh. When
      // order or filtering changes, restore only focus that belonged to this list.
      const children = [...results.children];
      if (rows.length) {
        if (children.length !== rows.length || rows.some((row, index) => row !== children[index])) results.replaceChildren(...rows);
      } else results.replaceChildren(element("p", "repository-tab-search-empty", all.length ? "No repositories match your search." : "No repositories connected. Onboard one from Tab tools."));
      if (focusedId && isOpen() && document.activeElement !== active) (rows.find(row => row.dataset.repositoryId === focusedId) || input).focus({ preventScroll: true });
      else if (focusedId && !rows.includes(focused)) input.focus({ preventScroll: true });
      results.setAttribute("aria-busy", String(Boolean(pending)));
      status.textContent = pending ? "Opening repository…" : errorMessage || `${rows.length} ${rows.length === 1 ? "repository" : "repositories"}${terms.length ? " found" : " available"}.`;
      position();
    } catch (error) { errorMessage = "Could not load repository choices. Try reopening search."; status.textContent = errorMessage; report(error); }
  }
  function beginOpen() {
    opened = true; needsFocus = true; epoch++; input.value = ""; errorMessage = ""; refresh();
  }
  listen(panel, "beforetoggle", event => {
    if (event.newState === "open") beginOpen();
    else { opened = false; needsFocus = false; epoch++; toggle.setAttribute("aria-expanded", "false"); }
  });
  listen(panel, "toggle", () => {
    const visible = isOpen();
    if (visible && !opened) beginOpen();
    if (!visible) { opened = false; needsFocus = false; }
    toggle.setAttribute("aria-expanded", String(visible)); position();
    if (visible && needsFocus) { needsFocus = false; input.focus({ preventScroll: true }); }
  });
  listen(input, "input", () => { errorMessage = ""; refresh(); });
  listen(dismiss, "click", () => close(true));
  listen(panel, "keydown", event => {
    if (!isOpen() || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || pending) return;
    const target = event.target;
    if (target === input) {
      if (event.key === "Enter") { event.preventDefault(); if (rows[0]) void select(rows[0].dataset.repositoryId); }
      else if (["ArrowDown", "ArrowUp"].includes(event.key) && rows.length) { event.preventDefault(); (event.key === "ArrowDown" ? rows[0] : rows.at(-1)).focus(); }
      return;
    }
    const index = rows.findIndex(row => row === target || row.contains(target));
    if (index < 0) return;
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % rows.length;
    else if (event.key === "ArrowUp") next = (index + rows.length - 1) % rows.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    if (next !== undefined) { event.preventDefault(); rows[next].focus(); }
    // Native button Enter/Space dispatches click; do not trigger it twice here.
  });
  listen(win, "resize", position);
  const resize = win?.ResizeObserver ? new win.ResizeObserver(position) : null; resize?.observe(panel);
  const observer = win?.MutationObserver ? new win.MutationObserver(position) : null;
  observer?.observe(document.body, { attributes: true, attributeFilter: ["style"] });
  toggle.setAttribute("aria-expanded", String(isOpen()));
  if (isOpen()) { beginOpen(); needsFocus = false; input.focus({ preventScroll: true }); }
  return { refresh, close, dispose() { if (disposed) return; close(); disposed = true; listeners.forEach(remove => remove()); resize?.disconnect(); observer?.disconnect(); rowById.clear(); rows = []; } };
}
