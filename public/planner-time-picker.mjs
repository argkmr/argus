const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const pad = value => String(value).padStart(2, "0");
let fieldSequence = 0;

/** Parse a complete 12-hour display or a 24-hour time, without guessing a period. */
export function parsePlannerTime(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]), period = match[3]?.toUpperCase();
  if (minute > 59 || hour > (period ? 12 : 23) || (period && hour < 1)) return null;
  if (period) hour = hour % 12 + (period === "PM" ? 12 : 0);
  return `${pad(hour)}:${pad(minute)}`;
}

export function plannerTimeParts(value) {
  const canonical = parsePlannerTime(value);
  if (!canonical) return null;
  const [hour, minute] = canonical.split(":").map(Number);
  return { hour: hour % 12 || 12, minute, period: hour >= 12 ? "PM" : "AM" };
}

export function formatPlannerTime(value) {
  const parts = plannerTimeParts(value);
  return parts ? `${parts.hour}:${pad(parts.minute)} ${parts.period}` : "";
}

/** A form-compatible canonical input plus an editable, theme-native display. */
export function plannerTimeFieldMarkup({ name, label, value }) {
  const id = `planner-time-${++fieldSequence}`, canonical = parsePlannerTime(value) || "";
  return `<div class="dp-time-field" data-planner-time-field>
    <label for="${id}-display">${escapeHtml(label)}</label>
    <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(canonical)}" data-time-value>
    <div class="dp-time-input-wrap">
      <input id="${id}-display" class="dp-time-display" type="text" value="${escapeHtml(formatPlannerTime(canonical))}" placeholder="9:00 AM" autocomplete="off" spellcheck="false" required aria-describedby="${id}-hint" data-time-display>
      <button type="button" class="dp-time-trigger" aria-label="Choose ${escapeHtml(String(label).toLowerCase())}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${id}-popup" data-time-toggle><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg></button>
    </div>
    <span class="dp-time-sr-only" id="${id}-hint">Enter a time such as 9:30 AM or 17:30, or use the time picker.</span>
    <div id="${id}-popup" class="dp-time-popup" popover="manual" role="dialog" aria-label="Choose ${escapeHtml(String(label).toLowerCase())}" hidden data-time-popup>
      <div class="dp-time-popup-heading"><strong data-time-preview>${escapeHtml(formatPlannerTime(canonical))}</strong><span>Choose time</span></div>
      <div class="dp-time-columns">
        <div class="dp-time-column"><span id="${id}-hour-label">Hour</span><div class="dp-time-options" role="listbox" aria-labelledby="${id}-hour-label" data-time-list="hour">${Array.from({ length: 12 }, (_, index) => `<button type="button" role="option" tabindex="-1" aria-selected="false" data-time-part="hour" data-time-choice="${index + 1}">${pad(index + 1)}</button>`).join("")}</div></div>
        <div class="dp-time-column"><span id="${id}-minute-label">Minute</span><div class="dp-time-options" role="listbox" aria-labelledby="${id}-minute-label" data-time-list="minute">${Array.from({ length: 60 }, (_, minute) => `<button type="button" role="option" tabindex="-1" aria-selected="false" data-time-part="minute" data-time-choice="${minute}">${pad(minute)}</button>`).join("")}</div></div>
        <div class="dp-time-column dp-time-period"><span id="${id}-period-label">Period</span><div class="dp-time-options" role="listbox" aria-labelledby="${id}-period-label" data-time-list="period">${["AM", "PM"].map(period => `<button type="button" role="option" tabindex="-1" aria-selected="false" data-time-part="period" data-time-choice="${period}">${period}</button>`).join("")}</div></div>
      </div>
      <div class="dp-time-popup-footer"><span>Arrow keys to choose</span><button type="button" data-time-done>Done</button></div>
    </div>
  </div>`;
}

/**
 * Mount after inserting field markup. Canonical changes bubble input/change
 * from the hidden named input and call onChange(name, HH:mm). Invalid manual
 * input blocks the enclosing form instead of silently saving the old value.
 */
export function mountPlannerTimePickers(container, { onChange = () => {} } = {}) {
  const document = container.ownerDocument, view = document.defaultView;
  const controllers = [];
  let openController = null;
  for (const field of container.querySelectorAll("[data-planner-time-field]")) {
    const valueInput = field.querySelector("[data-time-value]"), display = field.querySelector("[data-time-display]");
    const trigger = field.querySelector("[data-time-toggle]"), popup = field.querySelector("[data-time-popup]");
    const choices = [...popup.querySelectorAll("[data-time-choice]")];
    let isOpen = false;
    const disabled = () => valueInput.disabled || display.disabled || Boolean(field.closest("fieldset:disabled"));
    const validate = () => {
      const value = parsePlannerTime(display.value);
      display.setCustomValidity(value ? "" : "Enter a time such as 9:30 AM or 17:30.");
      display.setAttribute("aria-invalid", value ? "false" : "true");
      return value;
    };
    const paint = () => {
      const parts = plannerTimeParts(valueInput.value) || { hour: 9, minute: 0, period: "AM" };
      popup.querySelector("[data-time-preview]").textContent = formatPlannerTime(valueInput.value) || "9:00 AM";
      for (const choice of choices) {
        const selected = String(parts[choice.dataset.timePart]) === choice.dataset.timeChoice;
        choice.setAttribute("aria-selected", String(selected)); choice.tabIndex = selected ? 0 : -1;
      }
    };
    const commit = (value, normalize = false) => {
      if (!value || disabled()) return;
      if (normalize) display.value = formatPlannerTime(value);
      display.setCustomValidity(""); display.setAttribute("aria-invalid", "false");
      const changed = valueInput.value !== value;
      valueInput.value = value;
      paint();
      if (changed) {
        valueInput.dispatchEvent(new view.Event("input", { bubbles: true }));
        valueInput.dispatchEvent(new view.Event("change", { bubbles: true }));
        onChange(valueInput.name, value);
      }
    };
    const position = () => {
      if (!isOpen) return;
      const dialog = field.closest("dialog"), dialogRect = dialog?.getBoundingClientRect();
      const viewport = view.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0, viewportTop = viewport?.offsetTop || 0;
      const viewportRight = viewportLeft + (viewport?.width || view.innerWidth);
      const viewportBottom = viewportTop + (viewport?.height || view.innerHeight);
      const bounds = {
        left: Math.max(viewportLeft + 8, (dialogRect?.left || viewportLeft) + 8),
        right: Math.min(viewportRight - 8, (dialogRect?.right || viewportRight) - 8),
        top: Math.max(viewportTop + 8, (dialogRect?.top || viewportTop) + 8),
        bottom: Math.min(viewportBottom - 8, (dialogRect?.bottom || viewportBottom) - 8),
      };
      const rect = field.querySelector(".dp-time-input-wrap").getBoundingClientRect();
      const width = Math.max(0, Math.min(272, bounds.right - bounds.left));
      popup.style.width = `${width}px`;
      popup.style.maxHeight = `${Math.max(0, bounds.bottom - bounds.top)}px`;
      const height = popup.getBoundingClientRect().height;
      const below = rect.bottom + 6;
      const top = below + height <= bounds.bottom ? below : Math.max(bounds.top, Math.min(rect.top - height - 6, bounds.bottom - height));
      popup.style.left = `${Math.max(bounds.left, Math.min(rect.left, bounds.right - width))}px`;
      popup.style.top = `${Math.max(bounds.top, top)}px`;
    };
    const close = (focus = false) => {
      if (!isOpen) return;
      isOpen = false;
      if (openController === controller) openController = null;
      if (popup.matches(":popover-open")) popup.hidePopover();
      popup.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (focus && !disabled() && field.isConnected) trigger.focus({ preventScroll: true });
    };
    const open = () => {
      if (disabled()) return;
      openController?.close();
      const valid = validate(); if (valid) commit(valid, true);
      paint(); popup.hidden = false; isOpen = true; openController = controller;
      trigger.setAttribute("aria-expanded", "true");
      popup.showPopover?.(); position();
      for (const choice of choices.filter(item => item.getAttribute("aria-selected") === "true")) {
        const list = choice.parentElement;
        list.scrollTop = Math.max(0, choice.offsetTop - list.clientHeight / 2 + choice.clientHeight / 2);
      }
      popup.querySelector('[data-time-part="hour"][aria-selected="true"]')?.focus({ preventScroll: true });
    };
    const selectChoice = choice => {
      if (disabled()) return;
      const parts = plannerTimeParts(valueInput.value) || { hour: 9, minute: 0, period: "AM" };
      parts[choice.dataset.timePart] = choice.dataset.timePart === "period" ? choice.dataset.timeChoice : Number(choice.dataset.timeChoice);
      commit(parsePlannerTime(`${parts.hour}:${pad(parts.minute)} ${parts.period}`), true);
    };
    const onInput = () => { const value = validate(); if (value) commit(value); };
    const onBlur = () => { const value = validate(); if (value) commit(value, true); };
    const onClick = event => {
      if (event.target.closest("[data-time-toggle]")) { isOpen ? close() : open(); return; }
      if (event.target.closest("[data-time-done]")) { close(true); return; }
      const choice = event.target.closest("[data-time-choice]"); if (choice && popup.contains(choice)) selectChoice(choice);
    };
    const onKey = event => {
      if (event.key === "Escape" && isOpen) { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.target === display && event.key === "ArrowDown" && event.altKey) { event.preventDefault(); open(); return; }
      const choice = event.target.closest("[data-time-choice]");
      if (!choice || !popup.contains(choice)) return;
      const listChoices = [...choice.parentElement.querySelectorAll("[data-time-choice]")], index = listChoices.indexOf(choice);
      let next;
      if (event.key === "ArrowDown") next = listChoices[(index + 1) % listChoices.length];
      if (event.key === "ArrowUp") next = listChoices[(index - 1 + listChoices.length) % listChoices.length];
      if (event.key === "Home") next = listChoices[0];
      if (event.key === "End") next = listChoices.at(-1);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const lists = [...popup.querySelectorAll("[data-time-list]")];
        const listIndex = lists.indexOf(choice.parentElement), target = lists[listIndex + (event.key === "ArrowRight" ? 1 : -1)];
        next = target?.querySelector('[aria-selected="true"]');
      }
      if (next) {
        event.preventDefault(); selectChoice(next); next.focus({ preventScroll: true });
        const list = next.parentElement;
        if (next.offsetTop < list.scrollTop) list.scrollTop = next.offsetTop;
        else if (next.offsetTop + next.clientHeight > list.scrollTop + list.clientHeight) list.scrollTop = next.offsetTop + next.clientHeight - list.clientHeight;
      }
    };
    const syncDisabled = () => {
      const blocked = disabled();
      // Do not rewrite unchanged disabled attributes: this observer also sees
      // the popup's buttons, so unconditional writes would keep it running.
      for (const control of [trigger, ...choices, popup.querySelector("[data-time-done]")]) if (control.disabled !== blocked) control.disabled = blocked;
      if (blocked) close();
    };
    const observer = new view.MutationObserver(syncDisabled);
    observer.observe(field, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
    const fieldset = field.closest("fieldset");
    if (fieldset) observer.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] });
    display.addEventListener("input", onInput); display.addEventListener("blur", onBlur);
    field.addEventListener("click", onClick); field.addEventListener("keydown", onKey);
    const controller = { field, popup, close, position, dispose() { close(); observer.disconnect(); display.removeEventListener("input", onInput); display.removeEventListener("blur", onBlur); field.removeEventListener("click", onClick); field.removeEventListener("keydown", onKey); } };
    controllers.push(controller); syncDisabled();
  }
  const outside = event => { if (openController && !openController.field.contains(event.target)) openController.close(); };
  const reposition = () => openController?.position();
  const closeForDialog = () => openController?.close();
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("focusin", outside, true);
  view.addEventListener("resize", reposition);
  document.addEventListener("scroll", reposition, true);
  view.visualViewport?.addEventListener("resize", reposition);
  view.visualViewport?.addEventListener("scroll", reposition);
  const dialog = container.matches?.("dialog") ? container : container.closest("dialog") || container.querySelector("dialog");
  dialog?.addEventListener("close", closeForDialog);
  return () => {
    for (const controller of controllers) controller.dispose();
    document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside, true);
    view.removeEventListener("resize", reposition); document.removeEventListener("scroll", reposition, true);
    view.visualViewport?.removeEventListener("resize", reposition); view.visualViewport?.removeEventListener("scroll", reposition);
    dialog?.removeEventListener("close", closeForDialog);
  };
}
