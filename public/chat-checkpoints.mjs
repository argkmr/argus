/** Navigation-only bookmarks: these helpers never change the model's chat context. */
export function isCheckpointEligible(message) {
  return Boolean(message && typeof message.id === "string" && message.id.trim()
    && ["user", "assistant"].includes(message.role)
    && !message.optimistic && !message.queued && !message.pendingRevision);
}

const timestamp = (value) => {
  const result = Date.parse(value || "");
  return Number.isFinite(result) ? result : null;
};

/** Preserve the saved recent-message sequence; insert bookmarked archived messages by their original time. */
export function conversationMessagesWithCheckpoints(task) {
  const messages = Array.isArray(task?.messages) ? [...task.messages] : [];
  const seen = new Set(messages.map((message) => message?.id).filter(Boolean));
  const archived = [];
  for (const checkpoint of Array.isArray(task?.checkpoints) ? task.checkpoints : []) {
    const message = checkpoint?.message;
    if (!isCheckpointEligible(message) || checkpoint.messageId !== message.id || seen.has(message.id)) continue;
    seen.add(message.id);
    archived.push({ ...message, checkpointArchived: true });
  }
  // Marking an old message today must not move it to today's end of the conversation.
  archived.sort((left, right) => (timestamp(left.createdAt) ?? -Infinity) - (timestamp(right.createdAt) ?? -Infinity));
  for (const message of archived) {
    const time = timestamp(message.createdAt);
    const index = messages.findIndex((candidate) => {
      const other = timestamp(candidate.createdAt);
      return time === null ? !candidate.checkpointArchived : other !== null && other > time;
    });
    if (index < 0) messages.push(message);
    else messages.splice(index, 0, message);
  }
  return messages;
}

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ALIGNMENT_INSET = 12;
const EDGE_TOLERANCE = 3;

function scrollViewportScale(scroller, rectangle, view) {
  // offsetHeight rounds to an integer. That rounding compounds over long chats
  // when a pane is zoomed, making a correctly selected checkpoint miss its anchor.
  // The resolved CSS height retains subpixel precision; convert content-box sizes
  // to a border box before comparing them with the visual DOM rectangle.
  const style = view?.getComputedStyle?.(scroller);
  let cssHeight = Number.parseFloat(style?.height);
  if (Number.isFinite(cssHeight) && style?.boxSizing !== "border-box") {
    for (const property of ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"])
      cssHeight += Number.parseFloat(style?.[property]) || 0;
  }
  if (!(cssHeight > 0)) cssHeight = scroller.offsetHeight;
  return cssHeight > 0 && rectangle.height > 0 ? rectangle.height / cssHeight : 1;
}

/** Distances are CSS pixels; checkpoint order is the rendered conversation order. */
export function checkpointNavigationState({ checkpoints = [], scrollTop = 0, scrollHeight = 0, clientHeight = 0, selectedId = null } = {}) {
  const maximum = Math.max(0, finite(scrollHeight) - finite(clientHeight));
  const top = clamp(finite(scrollTop), 0, maximum);
  const targets = checkpoints.map((checkpoint) => ({ ...checkpoint, targetTop: clamp(finite(checkpoint.top) - ALIGNMENT_INSET, 0, maximum) }));
  const candidate = targets.findIndex((checkpoint) => checkpoint.id === selectedId);
  const selectedIndex = candidate >= 0 && Math.abs(targets[candidate].targetTop - top) <= EDGE_TOLERANCE ? candidate : -1;
  const atBottom = maximum - top <= EDGE_TOLERANCE;
  let previousIndex = -1;
  let nextIndex = -1;
  if (selectedIndex >= 0) {
    previousIndex = selectedIndex - 1;
    nextIndex = selectedIndex + 1 < targets.length ? selectedIndex + 1 : -1;
  } else if (atBottom && maximum > EDGE_TOLERANCE) {
    // The newest checkpoint may be visible in the final viewport, rather than above its top.
    previousIndex = targets.length - 1;
  } else {
    for (let index = 0; index < targets.length; index++) {
      if (targets[index].targetTop < top - EDGE_TOLERANCE) previousIndex = index;
      else if (nextIndex < 0) nextIndex = index;
    }
  }
  return { targets, maximum, top, atBottom, overflow: maximum > EDGE_TOLERANCE,
    selectedIndex, previousIndex, nextIndex, count: targets.length };
}

/** One controller per repository/Nexus scroll region; it never activates a task or focuses the composer. */
export function createChatCheckpointNavigation({ scroller, conversation, rail, window: view = globalThis.window, onNavigate } = {}) {
  if (!scroller || !conversation || !rail) return { setTask() {}, refresh() {}, resetSelection() {}, destroy() {} };
  const previous = rail.querySelector('[data-chat-nav="previous"]');
  const next = rail.querySelector('[data-chat-nav="next"]');
  const bottom = rail.querySelector('[data-chat-nav="bottom"]');
  const count = rail.querySelector("[data-chat-checkpoint-count]");
  const status = rail.querySelector("[data-chat-checkpoint-status]");
  let taskId = null;
  let selectedId = null;
  let frame = null;
  let destroyed = false;
  let highlighted = null;

  function entries() {
    const rectangle = scroller.getBoundingClientRect();
    // Argus font scaling can zoom the containing pane. Rectangles are visual pixels, scrollTop is not.
    const scale = scrollViewportScale(scroller, rectangle, view);
    return [...conversation.querySelectorAll('[data-chat-message-id][data-chat-checkpoint="true"]')].map((element) => ({
      id: element.dataset.chatMessageId, element,
      top: (element.getBoundingClientRect().top - rectangle.top) / scale + scroller.scrollTop - (scroller.clientTop || 0),
    }));
  }

  function state() {
    return checkpointNavigationState({ checkpoints: entries(), selectedId,
      scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight });
  }

  function clearHighlight() {
    highlighted?.classList.remove("checkpoint-navigation-target");
    highlighted = null;
  }

  function refresh() {
    if (destroyed) return;
    const current = state();
    rail.hidden = !current.overflow && current.count === 0;
    if (previous) previous.disabled = current.previousIndex < 0;
    if (next) next.disabled = current.nextIndex < 0;
    if (bottom) bottom.disabled = current.atBottom;
    const description = `${current.count} saved checkpoint${current.count === 1 ? "" : "s"}`;
    if (count) {
      count.textContent = current.selectedIndex >= 0 ? `${current.selectedIndex + 1} / ${current.count}` : String(current.count);
      count.title = description;
      count.setAttribute("aria-label", current.selectedIndex >= 0 ? `Checkpoint ${current.selectedIndex + 1} of ${current.count}` : description);
    }
    if (previous) previous.title = current.count ? "Previous checkpoint · earlier in this chat" : "Mark a saved message to add a checkpoint";
    if (next) next.title = current.count ? "Next checkpoint · later in this chat" : "Mark a saved message to add a checkpoint";
    if (bottom) bottom.title = current.atBottom ? "At the bottom of this chat" : "Scroll to bottom";
    const element = current.selectedIndex >= 0 ? current.targets[current.selectedIndex].element : null;
    if (highlighted !== element) {
      clearHighlight();
      highlighted = element;
      highlighted?.classList.add("checkpoint-navigation-target");
    }
  }

  function schedule() {
    if (destroyed || frame !== null) return;
    if (typeof view?.requestAnimationFrame !== "function") return refresh();
    frame = view.requestAnimationFrame(() => { frame = null; refresh(); });
  }

  function resetCursor() {
    selectedId = null;
    clearHighlight();
    schedule();
  }

  function click(event) {
    const button = event.target.closest?.("[data-chat-nav]");
    if (!button || !rail.contains(button) || button.disabled || destroyed) return;
    const action = button.dataset.chatNav;
    if (!["previous", "next", "bottom"].includes(action)) return;
    const current = state();
    const index = action === "previous" ? current.previousIndex : current.nextIndex;
    const checkpoint = action === "bottom" ? null : current.targets[index];
    if (action !== "bottom" && !checkpoint) return;
    event.preventDefault();
    selectedId = checkpoint?.id || null;
    const targetTop = checkpoint?.targetTop ?? current.maximum;
    // A direct jump makes repeated arrow clicks deterministic, including targets near the bottom
    // that share a clamped position, and respects reduced-motion preferences without animation.
    if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top: targetTop, behavior: "instant" });
    else scroller.scrollTop = targetTop;
    refresh();
    if (status) status.textContent = checkpoint ? `Checkpoint ${index + 1} of ${current.count}` : "Bottom of chat";
    onNavigate?.({ taskId, action, messageId: checkpoint?.id || null, index, count: current.count });
  }

  function keydown(event) {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) resetCursor();
  }

  rail.addEventListener("click", click);
  scroller.addEventListener("scroll", schedule, { passive: true });
  scroller.addEventListener("wheel", resetCursor, { passive: true });
  scroller.addEventListener("touchstart", resetCursor, { passive: true });
  scroller.addEventListener("pointerdown", resetCursor, { passive: true });
  scroller.addEventListener("keydown", keydown);
  view?.addEventListener?.("resize", schedule);
  const resizeObserver = typeof view?.ResizeObserver === "function" ? new view.ResizeObserver(schedule) : null;
  resizeObserver?.observe(scroller);
  resizeObserver?.observe(conversation);
  const mutationObserver = typeof view?.MutationObserver === "function" ? new view.MutationObserver(schedule) : null;
  mutationObserver?.observe(scroller, { childList: true, characterData: true, subtree: true });

  return {
    setTask(id) {
      const nextId = id || null;
      if (taskId !== nextId) {
        taskId = nextId;
        selectedId = null;
        clearHighlight();
        if (status) status.textContent = "";
      }
      refresh();
    },
    refresh,
    resetSelection() {
      selectedId = null;
      clearHighlight();
      if (status) status.textContent = "";
      refresh();
    },
    destroy() {
      destroyed = true;
      if (frame !== null) view?.cancelAnimationFrame?.(frame);
      frame = null;
      clearHighlight();
      rail.removeEventListener("click", click);
      scroller.removeEventListener("scroll", schedule);
      scroller.removeEventListener("wheel", resetCursor);
      scroller.removeEventListener("touchstart", resetCursor);
      scroller.removeEventListener("pointerdown", resetCursor);
      scroller.removeEventListener("keydown", keydown);
      view?.removeEventListener?.("resize", schedule);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    },
  };
}
