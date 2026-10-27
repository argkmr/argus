import { plannerTimeFieldMarkup, mountPlannerTimePickers } from "./planner-time-picker.mjs?v=20261027-404";

const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const API = "/api/daily-planner";
const icons = {
  plus: '<path d="M8 3v10M3 8h10"/>', left: '<path d="m10 3-5 5 5 5"/>', right: '<path d="m6 3 5 5-5 5"/>',
  check: '<path d="m3 8 3 3 7-7"/>', close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  calendar: '<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M5 1v4m6-4v4M2 7h12"/>',
  settings: '<path d="M2 4h12M2 12h12"/><circle cx="6" cy="4" r="2"/><circle cx="10" cy="12" r="2"/>',
  download: '<path d="M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3"/>',
  spark: '<path d="m8 1 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"/>', edit: '<path d="m3 10 7-7 3 3-7 7-4 1Z"/>',
  link: '<path d="m6 10 4-4M5 8 3.5 9.5a2.8 2.8 0 0 0 4 4L10 11M6 5l2.5-2.5a2.8 2.8 0 0 1 4 4L11 8"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
};
const icon = name => `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${icons[name] || icons.calendar}</svg>`;
const button = (action, label, symbol, cls = "", attributes = "") => `<button type="button" data-planner-action="${action}" class="dp-button ${cls}" ${attributes}>${symbol ? icon(symbol) : ""}<span>${esc(label)}</span></button>`;

export function validPlannerDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
export function addPlannerDays(value, days) {
  if (!validPlannerDate(value) || !Number.isInteger(days)) throw new Error("A valid calendar date is required.");
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
export function plannerWeek(value) {
  const weekday = new Date(`${value}T12:00:00Z`).getUTCDay();
  const monday = addPlannerDays(value, -(weekday + 6) % 7);
  return Array.from({ length: 5 }, (_, index) => addPlannerDays(monday, index));
}
export function plannerWorkingDay(value, daysOff = [], strictlyAfter = false) {
  const excluded = new Set(daysOff.map(day => typeof day === "string" ? day : day.date));
  let date = strictlyAfter ? addPlannerDays(value, 1) : value;
  // An explicit bound protects against malformed settings, without timezone/DST arithmetic.
  for (let count = 0; count < 3660; count++, date = addPlannerDays(date, 1)) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6 && !excluded.has(date)) return date;
  }
  throw new Error("No available workday found. Review your days off.");
}
export function plannerRange(anchor, period = "week", sprint) {
  if (!validPlannerDate(anchor)) throw new Error("Choose a valid report date.");
  if (period === "sprint") {
    if (!sprint || !validPlannerDate(sprint.startDate) || !validPlannerDate(sprint.endDate)) throw new Error("Create or choose a sprint first.");
    return { from: sprint.startDate, to: sprint.endDate };
  }
  if (period === "week") { const dates = plannerWeek(anchor); return { from: dates[0], to: addPlannerDays(dates[4], 2) }; }
  const month = new Date(`${anchor.slice(0, 7)}-01T12:00:00Z`);
  const end = new Date(month); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  if (period === "six-months") month.setUTCMonth(month.getUTCMonth() - 5);
  return { from: month.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
export function plannerClock(timeZone, instant = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
export function plannerDefaultDate(state, instant = new Date()) {
  const clock = plannerClock(state.settings.timeZone, instant);
  const today = clock.date > state.today ? clock.date : state.today;
  return plannerWorkingDay(today, state.daysOff, clock.date === today && clock.time >= state.settings.endTime);
}
const dateLabel = (date, options = { day: "numeric", month: "short" }) => validPlannerDate(date) ? new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)) : "";
const plural = (count, label) => `${count} ${label}${count === 1 ? "" : "s"}`;
const rangeLabel = ({ from, to }) => `${dateLabel(from)} – ${dateLabel(to, { day: "numeric", month: "short", year: "numeric" })}`;
const safeCount = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const taskLabel = task => task.key || task.id;
const taskStatus = status => ({ todo: "To do", "in-progress": "In progress", done: "Completed", archived: "Archived" })[status] || status;
const taskFields = ["title", "notes", "date", "status"];
const calendarDaysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
/** Prefer server timing, with an evidence-based fallback for retained/older snapshots. */
export function plannerTimingIndex(state) {
  const completed = new Map(), missed = new Set(), timings = new Map(), missedByDate = new Map();
  for (const event of state.events || []) {
    if (event.kind === "completed" && validPlannerDate(event.date) && (!completed.has(event.taskId) || event.date < completed.get(event.taskId))) completed.set(event.taskId, event.date);
    if (event.kind === "missed-planned-day") missed.add(event.taskId);
  }
  for (const task of state.tasks || []) {
    const plannedDate = validPlannerDate(task.originalDate) ? task.originalDate : task.date;
    let completedDate = completed.get(task.id) || null;
    if (!completedDate && task.completedAt && !Number.isNaN(Date.parse(task.completedAt))) completedDate = plannerClock(state.settings.timeZone, new Date(task.completedAt)).date;
    if (!completedDate && task.status === "done") completedDate = task.date;
    const latenessDays = completedDate ? calendarDaysBetween(plannedDate, completedDate) : null;
    const overdueDays = calendarDaysBetween(plannedDate, state.today);
    const fallback = { plannedDate, completedDate, latenessDays,
      timingStatus: completedDate ? (latenessDays <= 0 ? "on-time" : latenessDays <= 2 ? "late" : "very-late") : overdueDays <= 0 ? "pending" : overdueDays <= 2 ? "overdue" : "very-overdue",
      missedPlannedDay: missed.has(task.id) || (completedDate ? completedDate > plannedDate : plannedDate < state.today) };
    const timing = state.taskTimings?.[task.id] || fallback;
    timings.set(task.id, timing);
    if (timing.missedPlannedDay) missedByDate.set(timing.plannedDate, (missedByDate.get(timing.plannedDate) || 0) + 1);
  }
  for (const [date, count] of Object.entries(state.missedByDate || {})) missedByDate.set(date, safeCount(count));
  return { timings, missedByDate };
}
export function plannerTimingLabel(timing, open = false, today) {
  if (open) {
    const days = calendarDaysBetween(timing.plannedDate, today);
    return days > 0 ? `${plural(days, "day")} overdue` : "Planned";
  }
  if (!timing.completedDate) return "Not completed";
  if (timing.latenessDays < 0) return "Completed early";
  return timing.latenessDays === 0 ? "Completed same day" : `${plural(timing.latenessDays, "day")} late`;
}
/** Update clean draft fields without overwriting edits or forgetting conflicting base values. */
export function rebasePlannerTaskDraft(draft, task, acknowledge = false) {
  if (!task) return draft;
  draft.base ||= Object.fromEntries(taskFields.map(name => [name, task[name] || ""]));
  for (const name of taskFields) {
    const value = task[name] || "";
    if (name === "date" || draft[name] === draft.base[name]) { draft[name] = value; draft.base[name] = value; }
    else if (acknowledge || draft[name] === value) draft.base[name] = value;
  }
  return draft;
}
/** Links use durable UUID endpoints, never dates, titles, array positions or display keys. */
export function plannerRelatedTasks(state, taskId) {
  const tasks = new Map((state.tasks || []).map(task => [task.id, task]));
  return (state.links || []).flatMap(link => {
    const other = link.sourceTaskId === taskId ? link.targetTaskId : link.targetTaskId === taskId ? link.sourceTaskId : null;
    return other && tasks.has(other) ? [{ link, task: tasks.get(other) }] : [];
  });
}
export function plannerSearchTasks(state, query = "", excludedIds = []) {
  const excluded = new Set(excludedIds), words = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return (state.tasks || []).filter(task => !excluded.has(task.id) && words.every(word =>
    `${task.key || ""} ${task.id} ${task.title} ${task.notes || ""} ${task.date} ${task.status} ${taskStatus(task.status)}`.toLocaleLowerCase().includes(word)))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")) || String(a.key || a.id).localeCompare(String(b.key || b.id), undefined, { numeric: true }));
}

/** One mutation at a time; late reads never roll back a newer revision. */
export function createPlannerStore({ api, onChange = () => {}, onError = () => {} }) {
  let state = null, busy = false, generation = 0, controller;
  const accept = next => {
    if (!next || !Number.isFinite(next.revision) || !Array.isArray(next.tasks)) throw new Error("Argus returned an invalid planner snapshot.");
    const changed = !state || next.revision > state.revision || next.today !== state.today;
    if (!state || next.revision >= state.revision) { state = next; if (changed) onChange({ state, busy }); }
    return state;
  };
  return {
    snapshot: () => state, busy: () => busy,
    close() { generation++; controller?.abort(); },
    async refresh() {
      const request = ++generation; controller?.abort(); controller = new AbortController();
      try {
        const next = await api(API, { dedupe: false, cache: "no-store", signal: controller.signal });
        if (request === generation) return accept(next);
      } catch (error) { if (request === generation && error?.name !== "AbortError") onError(error); }
      return state;
    },
    async mutate(path, method, data = {}) {
      if (busy || !state) return false;
      busy = true; generation++; controller?.abort(); onChange({ state, busy });
      try {
        const separator = path.includes("?") ? "&" : "?";
        const result = await api(API + path + (method === "DELETE" ? `${separator}revision=${state.revision}` : ""), {
          method, ...(method === "DELETE" ? {} : { body: { ...data, revision: state.revision } }),
        });
        accept(result); return true;
      } catch (error) { onError(error); return false; }
      finally { busy = false; onChange({ state, busy }); }
    },
  };
}

export function plannerBoardMarkup(state, anchor, { taskLimits = new Map(), historyLimits = new Map() } = {}) {
  const days = plannerWeek(anchor), tasks = state.tasks || [], events = state.events || [];
  const { timings, missedByDate } = plannerTimingIndex(state);
  const tasksById = new Map(tasks.map(task => [task.id, task])), linkCounts = new Map(), cardsByDate = new Map(), movedByDate = new Map(), workedToday = new Set();
  // Index once: a large backlog must not scan the entire history for every card.
  for (const task of tasks) if (task.status !== "archived") {
    const date = timings.get(task.id).plannedDate;
    if (!cardsByDate.has(date)) cardsByDate.set(date, []);
    cardsByDate.get(date).push(task);
  }
  // Only legacy weekend plans need extra columns; completing on Saturday never moves a Friday card.
  for (const offset of [1, 2]) {
    const date = addPlannerDays(days[4], offset);
    if (cardsByDate.has(date) || missedByDate.has(date)) days.push(date);
  }
  for (const event of events) {
    if (event.date === state.today && ["started", "completed"].includes(event.kind)) workedToday.add(event.taskId);
    if (event.kind !== "moved" || !days.includes(event.fromDate)) continue;
    const task = tasksById.get(event.taskId);
    if (timings.get(task?.id)?.plannedDate === event.fromDate && task?.status !== "archived") continue;
    if (!movedByDate.has(event.fromDate)) movedByDate.set(event.fromDate, new Map());
    movedByDate.get(event.fromDate).set(event.taskId, event);
  }
  for (const link of state.links || []) {
    if (!tasksById.has(link.sourceTaskId) || !tasksById.has(link.targetTaskId)) continue;
    for (const id of [link.sourceTaskId, link.targetTaskId]) linkCounts.set(id, (linkCounts.get(id) || 0) + 1);
  }
  const firstAvailable = plannerDefaultDate(state);
  return days.map(date => {
    const weekend = new Date(`${date}T12:00:00Z`).getUTCDay() % 6 === 0;
    const dayOff = (state.daysOff || []).find(day => day.date === date) || (weekend ? { label: "Weekend" } : null);
    const cards = [...(cardsByDate.get(date) || [])].sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
    const completed = cards.filter(task => task.status === "done").length, missedCount = missedByDate.get(date) || 0;
    const moved = movedByDate.get(date) || new Map(), taskLimit = taskLimits.get(date) || 40, historyLimit = historyLimits.get(date) || 40;
    const sprint = (state.sprints || []).find(item => date >= item.startDate && date <= item.endDate);
    const canAdd = !dayOff && date >= firstAvailable;
    return `<section class="dp-day${date === state.today ? " is-today" : ""}${dayOff ? " is-off" : ""}${missedCount ? " has-missed-tasks" : ""}" data-date="${date}" aria-label="${esc(dateLabel(date, { weekday: "long", day: "numeric", month: "long" }))}">
      <header class="dp-day-heading"><div><span class="dp-weekday">${esc(dateLabel(date, { weekday: "short" }))}${date === state.today ? '<i>Today</i>' : ""}</span><strong>${esc(dateLabel(date))}</strong></div>
        ${weekend ? '<span class="dp-day-off" title="Weekends stay excluded from scheduling and reminders">Weekend</span>' : `<button type="button" class="dp-day-off" data-planner-action="day-off" data-date="${date}" aria-label="${dayOff ? "Edit day off" : "Mark day off"} ${date}" title="${dayOff ? esc(dayOff.label || "Day off") : "Mark day off"}">${dayOff ? "Day off" : icon("calendar")}</button>`}</header>
      ${sprint ? `<div class="dp-sprint-strip" title="${esc(sprint.name)}">${esc(sprint.name)}</div>` : ""}
      <div class="dp-day-meta"><span>${dayOff && !cards.length ? esc(dayOff.label || "Take a well-earned break") : `${completed}/${cards.length} completed${cards.length > completed ? ` · ${cards.length - completed} open` : ""}`}</span>${button("new-task", "Add task", "plus", "dp-icon-button", `data-date="${date}" title="${canAdd ? `Add task for ${date}` : "Tasks can only be added to an upcoming workday"}"${canAdd ? "" : " disabled"}`)}</div>
      ${missedCount ? `<div class="dp-day-missed" title="Permanent count: not completed on the planned date, including tasks finished later or archived">${missedCount} not completed that day</div>` : ""}
      <div class="dp-day-tasks" data-day-scroll="${date}" tabindex="0" aria-label="Tasks for ${date}">
      ${cards.slice(0, taskLimit).map(task => {
        const timing = timings.get(task.id), open = task.status !== "done", overdueDays = calendarDaysBetween(timing.plannedDate, state.today);
        const tone = open ? (overdueDays > 2 ? "very-overdue" : overdueDays > 0 ? "overdue" : "pending") : timing.timingStatus;
        return `<article class="dp-task${task.status === "done" ? " is-done" : ""}${task.status === "in-progress" ? " is-progress" : ""}" data-task="${esc(task.id)}" data-timing="${esc(tone)}">
        <div class="dp-task-identity"><span class="dp-task-key">${esc(taskLabel(task))}</span>${button("task-links", String(linkCounts.get(task.id) || "Link"), "link", "dp-task-link-button", `data-id="${esc(task.id)}" aria-label="Related tasks for ${esc(taskLabel(task))}" title="Link tasks across any day"`)}</div>
        <div class="dp-task-main"><button type="button" class="dp-check" data-planner-action="complete" data-id="${esc(task.id)}" aria-label="${task.status === "done" ? "Reopen" : "Complete"} ${esc(task.title)}" aria-pressed="${task.status === "done"}" title="${task.status === "done" ? "Reopen here; keep its planned date and history" : "Mark completed today; keep this card on its planned day"}">${task.status === "done" ? icon("check") : ""}</button><button type="button" class="dp-task-title" data-planner-action="edit-task" data-id="${esc(task.id)}">${esc(task.title)}</button></div>
        ${task.notes ? `<p class="dp-task-notes">${esc(task.notes)}</p>` : ""}
        <div class="dp-task-timing">${esc(plannerTimingLabel(timing, open, state.today))}${timing.completedDate ? `<small>First completed ${esc(dateLabel(timing.completedDate, { day: "numeric", month: "short", year: "numeric" }))}</small>` : ""}</div>
        <footer><button type="button" class="dp-status" data-planner-action="progress" data-id="${esc(task.id)}"${task.status === "done" ? ' data-work-unavailable="true" disabled' : ' title="Record work today; keep the planned date"'}>${task.status === "in-progress" ? (!workedToday.has(task.id) ? "Work on today" : "In progress") : task.status === "done" ? "Completed" : "To do"}</button></footer>
      </article>`; }).join("")}
      ${cards.length > taskLimit ? button("more-day-tasks", `Show ${Math.min(40, cards.length - taskLimit)} more · ${cards.length - taskLimit} remaining`, "", "dp-show-more", `data-date="${date}"`) : ""}
      ${!cards.length && !moved.size ? `<div class="dp-day-empty">${dayOff ? `${icon("calendar")}<span>No reminders today.</span>` : `<span>${!canAdd ? "No tasks recorded" : "A little room to plan"}</span>${canAdd ? `<button type="button" data-planner-action="new-task" data-date="${date}">+ Add a task</button>` : ""}`}</div>` : ""}
      ${moved.size ? `<details class="dp-moved-history" data-day-history="${date}"${moved.size <= 3 ? " open" : ""}><summary>${icon("right")}<span>Moved tasks</span><span class="dp-history-count">${moved.size}</span></summary>${[...moved.values()].slice(0, historyLimit).map(event => `<div class="dp-moved-record"><button type="button" data-planner-action="edit-task" data-id="${esc(event.taskId)}">${esc(tasksById.get(event.taskId)?.key || "")} ${esc(event.title)}</button><small>${icon("right")} Moved to ${esc(dateLabel(event.toDate))}${tasksById.get(event.taskId)?.status === "archived" ? " · Archived" : ""}</small></div>`).join("")}${moved.size > historyLimit ? button("more-day-history", `Show ${Math.min(40, moved.size - historyLimit)} more · ${moved.size - historyLimit} remaining`, "", "dp-show-more", `data-date="${date}"`) : ""}</details>` : ""}</div></section>`;
  }).join("");
}

export function plannerPerformanceMarkup(report) {
  const summary = report?.summary || {}, daily = report?.daily || [];
  const stats = [["planned", "Tasks planned"], ["worked", "Worked on"], ["completed", "Completed"], ["missedPlannedDay", "Not completed on planned day"]];
  return `<div class="dp-metrics">${stats.map(([key, label]) => `<article><span>${label}</span><strong>${safeCount(summary[key])}</strong></article>`).join("")}</div>
    <p class="dp-report-definition">Totals count distinct tasks in this period, not hours or productivity. “Worked on” means marked in progress or completed. Actual work is recorded on its own date; the planned-day missed count stays permanent, even after later completion or archive.</p>
    <div class="dp-performance-days">${daily.map(day => {
      const counts = day.summary || {}, planned = safeCount(counts.planned), completed = safeCount(counts.completed);
      const progress = planned ? Math.min(100, Math.round(completed / planned * 100)) : 0;
      return `<details class="dp-performance-day"><summary><span class="dp-report-date">${icon("right")}${esc(dateLabel(day.date, { weekday: "short", day: "numeric", month: "short" }))}${day.dayOff ? '<small>Day off</small>' : ""}</span><span class="dp-progress-meter" role="img" aria-label="${completed} of ${planned} planned tasks completed"><i style="width:${progress}%"></i></span><span>${completed}/${planned} done</span><span class="dp-report-missed" title="Permanent count for this planned day">${safeCount(counts.missedPlannedDay)} missed</span></summary><div class="dp-report-task-list">${(day.tasks || []).map(task => `<div class="dp-report-task-row" data-timing="${esc(task.timingStatus || "pending")}"><div><button type="button" class="dp-report-task-open" data-planner-action="edit-task" data-id="${esc(task.taskId)}"><span class="dp-task-key">${esc(task.key || task.taskId)}</span><strong>${esc(task.title)}</strong></button><p class="dp-report-task-dates">${task.plannedDate ? `Planned ${esc(dateLabel(task.plannedDate, { day: "numeric", month: "short", year: "numeric" }))} · ` : ""}${task.completedDate ? `First completed ${esc(dateLabel(task.completedDate, { day: "numeric", month: "short", year: "numeric" }))}` : "Not completed"}</p></div><div class="dp-report-task-outcome"><span class="dp-task-timing">${esc(plannerTimingLabel(task))}</span><small>${[task.worked ? "Worked on this day" : "", task.completed ? "Completed this day" : "", task.moved ? `Historical move${task.toDate ? ` → ${dateLabel(task.toDate)}` : ""}` : "", task.status === "archived" ? "Archived" : "", task.missedPlannedDay && task.plannedDate === day.date ? "Not completed on planned day" : ""].filter(Boolean).map(esc).join(" · ") || "Planned"}</small></div></div>`).join("") || '<p>No tasks recorded for this day.</p>'}</div></details>`;
    }).join("") || '<p class="dp-empty-state">No activity recorded in this period yet.</p>'}</div>`;
}

export function createDailyPlanner({ root, api, toast = () => {}, desktop = globalThis.argusDesktop, fetcher = globalThis.fetch }) {
  if (!root || typeof api !== "function") throw new Error("Daily planner needs a root and an API client.");
  let visible = false, anchor = "", mode = "week", period = "week", reportGeneration = 0, reportController;
  let reportCache = null, dialogKind = "", dialogKey = "", dialogReturnFocus, conflict = false, boardStamp = "", disposeTimePickers;
  let aiJob = null, aiGeneration = 0, aiTimer, aiBusy = false, downloadBusy = false;
  let notificationStatus = { supported: Boolean(desktop), appMustBeRunning: true }, refreshTimer;
  const drafts = new Map(), taskLimits = new Map(), historyLimits = new Map(), historyOpen = new Map();
  root.classList.add("daily-planner");
  root.innerHTML = `<header class="dp-header"><div class="dp-title"><span class="dp-eyebrow">YOUR WORKWEEK</span><h1>Daily tasks</h1></div><div class="dp-main-actions">${button("ai", "Plan with AI", "spark")}${button("new-task", "Add task", "plus", "dp-primary")}</div></header>
    <div class="dp-toolbar"><div class="dp-date-navigation">${button("previous", "Previous period", "left", "dp-icon-button", 'title="Previous period"')}${button("today", "Today", "")}${button("next", "Next period", "right", "dp-icon-button", 'title="Next period"')}<h2 data-dp="range"></h2></div><div class="dp-toolbar-actions"><div class="dp-view-switch" role="group" aria-label="Planner view">${button("view-week", "Week board", "calendar", "", 'aria-pressed="true"')}${button("view-performance", "Performance", "", "", 'aria-pressed="false"')}</div>${button("reports", "Reports", "download")}${button("settings", "Workday settings", "settings", "dp-icon-button", 'title="Workday settings"')}</div></div>
    <div class="dp-subbar"><div data-dp="context"></div><div class="dp-subbar-actions"><label class="dp-period-picker" hidden>Period <select data-dp="period"><option value="week">Weekly</option><option value="month">Monthly</option></select></label>${button("task-browser", "Find task", "search", "dp-text-button")}${button("sprints", "Sprints", "")}${button("refresh", "Refresh", "", "dp-text-button")}</div></div>
    <div class="dp-timing-legend" aria-label="Task timing colours"><span data-timing="on-time">On time</span><span data-timing="late">1–2 days late</span><span data-timing="very-late">3+ days late</span><small>Calendar days · cards stay on their planned day</small></div>
    <div class="dp-notice" data-dp="notice" role="status" hidden></div><main class="dp-body" data-dp="body" aria-label="Daily task planner"><div class="dp-empty-state">Loading your workweek…</div></main>
    <dialog id="daily-planner-dialog" class="dp-dialog" aria-labelledby="dp-dialog-title"><form class="dp-dialog-form"><header><div><span class="dp-eyebrow" data-dp="dialog-eyebrow">DAILY TASKS</span><h2 id="dp-dialog-title"></h2></div>${button("close-dialog", "Close", "close", "dp-icon-button", 'title="Close"')}</header><div class="dp-dialog-content" data-dp="dialog-content"></div><p class="dp-form-message" data-dp="form-message" role="status" hidden></p><footer data-dp="dialog-footer"></footer></form></dialog>`;
  const $ = name => root.querySelector(`[data-dp="${name}"]`), dialog = root.querySelector("dialog"), form = dialog.querySelector("form");
  const store = createPlannerStore({ api, onChange: render, onError: showError });
  function showError(error) {
    conflict = error?.status === 409;
    const message = conflict ? "Your planner changed elsewhere. Refresh to load the latest version; your form is kept so you can review and save again." : error?.message || "Unable to update your planner. Your draft is still here.";
    $("notice").textContent = message; $("notice").hidden = false;
    if (dialog.open) formMessage(message);
    const reload = form.querySelector('[data-planner-action="refresh"]'); if (reload) reload.hidden = !conflict;
    if (!store.snapshot()) $("body").innerHTML = `<div class="dp-empty-state">Your planner could not load. ${button("refresh", "Try again", "")}</div>`;
    toast(message, "error");
  }
  function formMessage(message = "") { $("form-message").textContent = message; $("form-message").hidden = !message; }
  function captureBoardFocus() {
    const focused = document.activeElement?.closest?.("[data-planner-action]");
    return focused && $("body").contains(focused) ? { action: focused.dataset.plannerAction, id: focused.dataset.id, date: focused.dataset.date, day: focused.closest("[data-day-scroll]")?.dataset.dayScroll } : null;
  }
  function restoreBoardFocus(focus) {
    if (!focus) return;
    const nextFocus = [...$("body").querySelectorAll("[data-planner-action]")].find(node => node.dataset.plannerAction === focus.action && node.dataset.id === focus.id && node.dataset.date === focus.date && !node.disabled);
    (nextFocus || [...$("body").querySelectorAll("[data-day-scroll]")].find(node => node.dataset.dayScroll === focus.day))?.focus({ preventScroll: true });
  }
  function render() {
    const state = store.snapshot(); if (!state) return;
    if (!anchor) anchor = state.today;
    if (!visible) return;
    if (dialog.open && dialogKind === "task") syncTaskDraft();
    const range = plannerRange(anchor, mode === "week" ? "week" : period);
    $("range").textContent = rangeLabel(range);
    $("context").textContent = `${state.settings.startTime}–${state.settings.endTime} · ${state.settings.timeZone} · Weekends off${state.settings.remindersEnabled ? " · Reminders on" : ""}`;
    $("period").closest("label").hidden = mode !== "performance";
    root.querySelector('[data-planner-action="view-week"]').setAttribute("aria-pressed", String(mode === "week"));
    root.querySelector('[data-planner-action="view-performance"]').setAttribute("aria-pressed", String(mode === "performance"));
    $("body").classList.toggle("dp-week-grid", mode === "week");
    $("body").classList.toggle("dp-performance", mode === "performance");
    const nextBoardStamp = `${state.revision}:${state.today}:${anchor}:${plannerDefaultDate(state)}`;
    if (mode === "week" && boardStamp !== nextBoardStamp) {
      const positions = new Map([...root.querySelectorAll("[data-day-scroll]")].map(node => [node.dataset.dayScroll, node.scrollTop]));
      for (const node of root.querySelectorAll("[data-day-history]")) historyOpen.set(node.dataset.dayHistory, node.open);
      const horizontal = $("body").scrollLeft;
      const focus = captureBoardFocus();
      $("body").innerHTML = plannerBoardMarkup(state, anchor, { taskLimits, historyLimits });
      $("body").style.setProperty("--dp-day-count", String($("body").children.length));
      boardStamp = nextBoardStamp;
      for (const node of root.querySelectorAll("[data-day-history]")) if (historyOpen.has(node.dataset.dayHistory)) node.open = historyOpen.get(node.dataset.dayHistory);
      for (const node of root.querySelectorAll("[data-day-scroll]")) node.scrollTop = positions.get(node.dataset.dayScroll) || 0;
      $("body").scrollLeft = horizontal;
      restoreBoardFocus(focus);
    } else if (mode === "performance" && reportCache?.revision === state.revision && reportCache.today === state.today && reportCache.from === range.from && reportCache.to === range.to) $("body").innerHTML = plannerPerformanceMarkup(reportCache.data);
    else if (mode === "performance" && !store.busy()) void loadReport();
    syncBusy();
  }
  function syncBusy() {
    const busy = store.busy(); root.setAttribute("aria-busy", String(busy));
    for (const element of root.querySelectorAll('[data-planner-action="complete"], [data-planner-action="archive-task"], [data-planner-action="restore-task"], [data-planner-action="delete-task"], [data-planner-action="delete-sprint"], [data-planner-action="add-link"], [data-planner-action="remove-link"]')) element.disabled = busy;
    for (const element of root.querySelectorAll('[data-planner-action="progress"]')) element.disabled = busy || element.dataset.workUnavailable === "true";
    for (const element of form.querySelectorAll('[type="submit"]')) element.disabled = busy || downloadBusy || (dialogKind === "ai" && (aiBusy || !currentDraft().proposals?.length));
    for (const element of form.querySelectorAll("input, textarea, select")) element.disabled = busy || downloadBusy || element.dataset.readonlyTask === "true" || element.dataset.fixedPlan === "true" || (dialogKind === "ai" && aiBusy && !element.closest("[data-proposal]"));
    const propose = form.querySelector('[data-planner-action="propose"]'); if (propose) propose.disabled = aiBusy || busy;
  }
  async function loadReport() {
    if (!visible || mode !== "performance" || !store.snapshot()) return;
    const request = ++reportGeneration, revision = store.snapshot().revision, today = store.snapshot().today, range = plannerRange(anchor, period);
    reportController?.abort(); reportController = new AbortController();
    $("body").innerHTML = '<div class="dp-empty-state">Loading your activity…</div>';
    try {
      const data = await api(`${API}/report?${new URLSearchParams({ ...range, groupBy: "day" })}`, { signal: reportController.signal, dedupe: false, cache: "no-store" });
      if (request !== reportGeneration || !visible || mode !== "performance" || store.snapshot().revision !== revision || store.snapshot().today !== today) return;
      reportCache = { ...range, revision, today, data }; $("body").innerHTML = plannerPerformanceMarkup(data);
    } catch (error) { if (request === reportGeneration && error?.name !== "AbortError") { $("body").innerHTML = '<div class="dp-empty-state">Could not load this report. Use Refresh to try again.</div>'; showError(error); } }
  }
  function defaultDate() { return plannerDefaultDate(store.snapshot()); }
  function currentDraft() { return drafts.get(dialogKey) || {}; }
  function openDialog(kind, data = {}) {
    const state = store.snapshot(); if (!state) return;
    dialogKind = kind; dialogKey = `${kind}:${data.id || data.date || ""}`;
    if (!drafts.has(dialogKey)) {
      const task = data.id ? state.tasks.find(item => item.id === data.id) : null;
      drafts.set(dialogKey, kind === "task" ? { id: task?.id || "", title: task?.title || "", notes: task?.notes || "", date: task?.date || data.date || defaultDate(), status: task?.status || "todo" }
        : kind === "settings" ? { ...state.settings }
        : kind === "day-off" ? { date: data.date, label: state.daysOff.find(day => day.date === data.date)?.label || "Day off", off: true }
        : kind === "sprints" ? { name: "", startDate: plannerWeek(anchor)[0], endDate: addPlannerDays(plannerWeek(anchor)[0], 11) }
        : kind === "reports" ? { period: "week", anchor, sprintId: state.sprints[0]?.id || "", groupBy: "day", format: "csv" }
        : kind === "task-browser" ? { taskQuery: "", taskStatusFilter: "all", resultLimit: 40 }
        : { prompt: "", provider: "codex", date: defaultDate(), proposals: [] });
    }
    if (kind === "task" && data.links) currentDraft().linksOpen = true;
    if (kind === "task" && currentDraft().id) rebasePlannerTaskDraft(currentDraft(), state.tasks.find(task => task.id === currentDraft().id));
    if (!dialog.open) dialogReturnFocus = document.activeElement;
    renderDialog();
    if (!dialog.open) dialog.showModal();
    (data.links ? form.elements.linkQuery : form.querySelector("input:not([type=checkbox]):not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled)"))?.focus();
  }
  function closeDialog() { disposeTimePickers?.(); disposeTimePickers = null; dialog.close(); formMessage(); dialogReturnFocus?.isConnected && dialogReturnFocus.focus({ preventScroll: true }); }
  const input = (label, name, value, attributes = "") => `<label>${label}<input name="${name}" value="${esc(value)}" ${attributes}></label>`;
  function renderDialog() {
    disposeTimePickers?.(); disposeTimePickers = null;
    const draft = currentDraft(), state = store.snapshot(); formMessage();
    const archived = dialogKind === "task" && state.tasks.find(task => task.id === draft.id)?.status === "archived";
    const titles = { task: archived ? "Archived task" : draft.id ? "Edit task" : "Add a task", settings: "Your workday", "day-off": "Plan a day off", sprints: "Sprint planning", reports: "Download your report", ai: "Plan your tasks with AI", "task-browser": "Find any task" };
    root.querySelector("#dp-dialog-title").textContent = titles[dialogKind];
    let content = "", submit = "Save", extra = "";
    if (dialogKind === "task") {
      content = `${input("Task", "title", draft.title, 'required maxlength="240" placeholder="What would you like to finish?"')}<label><span>Notes <span class="dp-optional">optional</span></span><textarea name="notes" rows="3" maxlength="8000" placeholder="Details, links, or a little context">${esc(draft.notes)}</textarea></label><div class="dp-form-row">${input("Planned for", "date", draft.date, `type="date" required${draft.id ? ' data-fixed-plan="true" title="The original planned day is permanent"' : ""}`)}${draft.id ? `<label>Status<select name="status">${["todo", "in-progress", "done"].map(value => `<option value="${value}"${draft.status === value ? " selected" : ""}>${({ todo: "To do", "in-progress": "In progress", done: "Completed" })[value]}</option>`).join("")}</select></label>` : ""}</div>${archived ? "" : '<p class="dp-hint">Tasks stay on their original planned day. You can edit or complete them later; unfinished tasks are highlighted instead of moved.</p>'}`;
      submit = archived ? "" : draft.id ? "Save task" : "Add task";
      if (draft.id) {
        const task = state.tasks.find(item => item.id === draft.id);
        const timing = plannerTimingIndex(state).timings.get(task.id);
        content = `<div class="dp-task-detail-identity"><span class="dp-task-key">${esc(taskLabel(task))}</span><span>${archived ? "Archived · history preserved" : "Permanent ID and planned day"}</span></div>${content}<p class="dp-task-detail-timing" data-timing="${esc(timing.timingStatus)}">${timing.completedDate ? `First completed ${esc(dateLabel(timing.completedDate, { day: "numeric", month: "short", year: "numeric" }))} · ${esc(plannerTimingLabel(timing))}` : "Not completed yet"}${timing.missedPlannedDay ? " · Not completed on planned day (permanent)" : ""}</p><details class="dp-related-section"${draft.linksOpen ? " open" : ""}><summary>${icon("link")}Related tasks <span data-related-count></span></summary><p class="dp-hint">Connect related work from any day, including completed and archived tasks. Links save immediately and do not move or block tasks.</p><div data-related-list></div>${input("Find a task to link", "linkQuery", draft.linkQuery || "", 'type="search" autocomplete="off" placeholder="Search ID, title, or date · all days"')}<div data-link-results class="dp-task-results"></div></details>`;
        if (archived) {
          content += '<p class="dp-hint">Archived tasks stay searchable and keep their ID, notes, links and report history. Restore returns this task to To do on its original planned day. Earlier completions and missed-day counts stay in your reports.</p>';
          extra = button("restore-task", "Restore task", "", "dp-primary", `data-id="${esc(draft.id)}"`);
        } else {
          content += '<p class="dp-hint">Completion records today’s actual date without moving this card. Archive hides it without deleting its history or changing its missed-day count; restore it through Find task.</p>';
          extra = button("archive-task", "Archive task", "", "dp-danger", `data-id="${esc(draft.id)}" title="Keep its history but remove it from the active board"`);
        }
        extra += button("delete-task", "Delete permanently", "", "dp-danger", `data-id="${esc(draft.id)}" title="Permanently delete this task, its activity and related-task links"`);
      }
    } else if (dialogKind === "settings") {
      content = `<div class="dp-form-row">${plannerTimeFieldMarkup({ label: "Start time", name: "startTime", value: draft.startTime })}${plannerTimeFieldMarkup({ label: "End time", name: "endTime", value: draft.endTime })}</div>${input("Time zone", "timeZone", draft.timeZone, 'required list="dp-timezones" placeholder="Asia/Kolkata"')}<datalist id="dp-timezones">${(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [draft.timeZone, "UTC"]).map(zone => `<option value="${esc(zone)}"></option>`).join("")}</datalist><label class="dp-check-label"><input type="checkbox" name="remindersEnabled"${draft.remindersEnabled ? " checked" : ""}> Desktop reminders</label><div class="dp-settings-note"><strong>A gentle workday nudge</strong><p>At your start time: plan today's tasks. One hour before your end time: review unfinished tasks and mark completed work. These combine for a one-hour workday. Tasks never move automatically.</p><p>Saturday, Sunday, and days you mark off are quiet. Reminders work while Argus is running${notificationStatus.supported ? "; allow notifications in your laptop’s notification settings." : ". Desktop notifications are unavailable here; open the Argus desktop app."}</p></div>`;
    } else if (dialogKind === "day-off") {
      content = `${input("Date", "date", draft.date, 'type="date" required')}${input("Label", "label", draft.label, 'maxlength="100" placeholder="Day off / holiday / leave"')}<label class="dp-check-label"><input type="checkbox" name="off"${draft.off ? " checked" : ""}> Mark this as a day off</label><p class="dp-hint">No reminders on this date. Existing tasks stay on their original planned day and remain editable; their deadlines and missed-day counts are unchanged.</p>`;
    } else if (dialogKind === "sprints") {
      content = `${input("Sprint name", "name", draft.name, 'required maxlength="120" placeholder="Sprint 24"')}<div class="dp-form-row">${input("Starts", "startDate", draft.startDate, 'type="date" required')}${input("Ends", "endDate", draft.endDate, 'type="date" required')}</div><p class="dp-hint">Choose the weeks covered by this sprint. Tasks are grouped by their recorded activity dates.</p><div class="dp-sprint-list">${state.sprints.map(sprint => `<div><span><strong>${esc(sprint.name)}</strong><small>${esc(rangeLabel({ from: sprint.startDate, to: sprint.endDate }))}</small></span>${button("delete-sprint", "Remove", "", "dp-text-button", `data-id="${esc(sprint.id)}" title="Remove this sprint label, not its tasks"`)}</div>`).join("") || '<p>No sprints yet. Your tasks work independently of sprints.</p>'}</div>`;
      submit = "Add sprint";
    } else if (dialogKind === "reports") {
      content = `<div class="dp-form-row"><label>Report period<select name="period">${[["week", "Weekly"], ["month", "Monthly"], ["six-months", "Six months"], ["sprint", "Sprint"]].map(([value, label]) => `<option value="${value}"${draft.period === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>${input("Date within period", "anchor", draft.anchor, 'type="date" required')}</div><label data-report-sprint${draft.period === "sprint" ? "" : " hidden"}>Sprint<select name="sprintId">${state.sprints.map(sprint => `<option value="${esc(sprint.id)}"${draft.sprintId === sprint.id ? " selected" : ""}>${esc(sprint.name)}</option>`).join("") || '<option value="">No sprints yet</option>'}</select></label><div class="dp-form-row"><label>Group by<select name="groupBy"><option value="day"${draft.groupBy === "day" ? " selected" : ""}>Day by day</option><option value="sprint"${draft.groupBy === "sprint" ? " selected" : ""}>Sprint, then day</option></select></label><label>Format<select name="format"><option value="csv"${draft.format === "csv" ? " selected" : ""}>CSV · spreadsheet with timing labels</option><option value="html"${draft.format === "html" ? " selected" : ""}>Colour report · HTML / PDF</option></select></label></div><p class="dp-report-range" data-report-range></p><p class="dp-hint">Includes original planned dates, actual completion dates, lateness, and permanent missed-day counts. HTML uses green, yellow, and brown; CSV includes timing labels without colours. A six-month report covers the selected month and the five preceding months. Open the HTML report and Print to save a PDF.</p>`;
      submit = "Download report";
    } else if (dialogKind === "task-browser") {
      content = `<div class="dp-task-search-fields">${input("Search all tasks", "taskQuery", draft.taskQuery || "", 'type="search" autocomplete="off" placeholder="ID, title, notes, or date"')}<label>Show<select name="taskStatusFilter">${[["all", "All tasks"], ["active", "Open tasks"], ["done", "Completed"], ["archived", "Archived"]].map(([value, label]) => `<option value="${value}"${draft.taskStatusFilter === value ? " selected" : ""}>${label}</option>`).join("")}</select></label></div><p class="dp-hint">Every day, including completed and archived tasks. Open an archived task to restore it; no history is deleted.</p><div data-task-results class="dp-task-results"></div>`;
      submit = "";
    } else {
      content = `<label>What are you planning?<textarea name="prompt" rows="4" maxlength="12000" placeholder="Turn these into today's tasks: review the release, fix the login bug, and prepare the demo…" required>${esc(draft.prompt)}</textarea></label><div class="dp-form-row">${input("Plan for", "date", draft.date, 'type="date" required')}<label>AI provider<select name="provider"><option value="codex"${draft.provider === "codex" ? " selected" : ""}>Codex</option><option value="claude"${draft.provider === "claude" ? " selected" : ""}>Claude</option></select></label></div><p class="dp-hint">Uses your configured AI provider to suggest tasks, not execute them. Review and edit the preview before adding it to your board.</p><div class="dp-ai-actions">${button("propose", "Suggest tasks", "spark")}${button("cancel-ai", "Cancel generation", "", "dp-text-button", aiBusy ? "" : "hidden")}</div><div class="dp-ai-status" data-ai-status role="status">${aiBusy ? "Preparing your task suggestions…" : ""}</div><div class="dp-proposals" data-ai-preview></div>`;
      submit = "Add selected tasks";
    }
    $("dialog-content").innerHTML = content;
    $("dialog-footer").innerHTML = `${extra}<span class="dp-footer-spacer"></span>${button("refresh", "Reload latest", "", "", conflict ? "" : "hidden")}${button("close-dialog", submit ? "Cancel" : "Done", "")}${submit ? `<button type="submit" class="dp-button dp-primary">${esc(submit)}</button>` : ""}`;
    if (dialogKind === "settings") disposeTimePickers = mountPlannerTimePickers($("dialog-content"), { onChange: (name, value) => { currentDraft()[name] = value; } });
    if (dialogKind === "task-browser") renderTaskResults();
    if (dialogKind === "ai") renderProposals();
    if (dialogKind === "reports") updateReportRange();
    if (dialogKind === "task") {
      if (!draft.id) form.elements.date.min = defaultDate();
      updateTaskStatusOptions();
      if (archived) {
        for (const name of ["title", "notes", "date", "status"]) if (form.elements[name]) form.elements[name].dataset.readonlyTask = "true";
        form.elements.status.innerHTML = '<option value="archived">Archived</option>';
      }
      form.querySelector(".dp-related-section")?.addEventListener("toggle", event => { currentDraft().linksOpen = event.target.open; });
      renderTaskResults();
    }
    if (dialogKind === "ai") form.elements.date.min = defaultDate();
    syncBusy();
  }
  function updateTaskStatusOptions() {
    if (dialogKind !== "task" || !form.elements.status) return;
    for (const option of form.elements.status.options) option.disabled = false;
  }
  function syncTaskDraft(acknowledge = false) {
    const draft = currentDraft(); if (dialogKind !== "task" || !draft.id) return;
    const task = store.snapshot().tasks.find(task => task.id === draft.id);
    rebasePlannerTaskDraft(draft, task, acknowledge);
    // Another window can archive or restore the task while this editor stays open.
    // Rebuild its actions/readonly state, not just the values, retaining any unsaved draft.
    if (task && (task.status === "archived") !== (form.elements.title?.dataset.readonlyTask === "true")) { renderDialog(); return; }
    for (const name of taskFields) if (form.elements[name] && form.elements[name].value !== draft[name]) form.elements[name].value = draft[name];
    updateTaskStatusOptions();
  }
  function taskResultRow(task, action, label, attributes = "") {
    return `<div class="dp-task-result"><button type="button" class="dp-task-result-open" data-planner-action="edit-task" data-id="${esc(task.id)}"><span class="dp-task-key">${esc(taskLabel(task))}</span><strong>${esc(task.title)}</strong><small>${esc(dateLabel(task.date, { day: "numeric", month: "short", year: "numeric" }))} · ${esc(taskStatus(task.status))}</small></button>${action ? button(action, label, action === "add-link" ? "plus" : "close", "dp-task-result-action", attributes) : ""}</div>`;
  }
  function renderTaskResults() {
    const state = store.snapshot(), draft = currentDraft();
    if (dialogKind === "task-browser") {
      const results = plannerSearchTasks(state, draft.taskQuery).filter(task => !draft.taskStatusFilter || draft.taskStatusFilter === "all" || (draft.taskStatusFilter === "active" ? ["todo", "in-progress"].includes(task.status) : task.status === draft.taskStatusFilter)), limit = draft.resultLimit || 40;
      form.querySelector("[data-task-results]").innerHTML = results.slice(0, limit).map(task => taskResultRow(task)).join("") || '<p class="dp-hint">No matching tasks. Try a different ID, title, or date.</p>';
      if (results.length > limit) form.querySelector("[data-task-results]").insertAdjacentHTML("beforeend", button("more-tasks", `Show more · ${results.length - limit} remaining`, "", "dp-text-button"));
    }
    const related = form.querySelector("[data-related-list]");
    if (dialogKind !== "task" || !draft.id || !related) return;
    const links = plannerRelatedTasks(state, draft.id);
    form.querySelector("[data-related-count]").textContent = String(links.length);
    related.innerHTML = links.map(({ task, link }) => taskResultRow(task, "remove-link", "Unlink", `data-link-id="${esc(link.id)}" aria-label="Unlink ${esc(taskLabel(task))}; keep both tasks"`)).join("") || '<p class="dp-hint">No related tasks yet.</p>';
    const results = plannerSearchTasks(state, draft.linkQuery, [draft.id, ...links.map(({ task }) => task.id)]), limit = draft.linkLimit || 20;
    form.querySelector("[data-link-results]").innerHTML = results.slice(0, limit).map(task => taskResultRow(task, "add-link", "Link", `data-id="${esc(task.id)}" aria-label="Link ${esc(taskLabel(task))}"`)).join("") || '<p class="dp-hint">No unlinked tasks match. Try another search or create a task first.</p>';
    if (results.length > limit) form.querySelector("[data-link-results]").insertAdjacentHTML("beforeend", button("more-links", `Show more · ${results.length - limit} remaining`, "", "dp-text-button"));
  }
  function renderProposals() {
    const preview = form.querySelector("[data-ai-preview]"); if (!preview) return;
    preview.innerHTML = (currentDraft().proposals || []).map((task, index) => `<fieldset class="dp-proposal" data-proposal="${index}"><legend>Task ${index + 1}</legend>${input("Task title", "proposalTitle", task.title, 'required maxlength="240"')}<div class="dp-form-row">${input("Date", "proposalDate", task.date, 'type="date" required')}${button("remove-proposal", "Remove", "close", "dp-text-button", `data-index="${index}"`)}</div><label>Notes<textarea name="proposalNotes" rows="2" maxlength="8000">${esc(task.notes)}</textarea></label></fieldset>`).join("");
    syncBusy();
  }
  function updateReportRange() {
    const draft = currentDraft();
    const showSprint = draft.period === "sprint";
    form.querySelector("[data-report-sprint]").hidden = !showSprint;
    form.elements.anchor.closest("label").hidden = showSprint;
    try { form.querySelector("[data-report-range]").textContent = rangeLabel(plannerRange(draft.anchor, draft.period, store.snapshot().sprints.find(item => item.id === draft.sprintId))); }
    catch (error) { form.querySelector("[data-report-range]").textContent = error.message; }
  }
  async function mutate(path, method, data, close = false) {
    // Disabling a focused checkbox during the pending save blurs it before the next render.
    // Capture it before the busy transition, but never steal focus from a newly opened editor.
    const submittedKey = dialogKey, submittedDraft = currentDraft(), focus = captureBoardFocus();
    const result = await store.mutate(path, method, data);
    if (result) {
      conflict = false; $("notice").hidden = true; formMessage(); const reload = form.querySelector('[data-planner-action="refresh"]'); if (reload) reload.hidden = true; reportCache = null;
      if (close) { if (drafts.get(submittedKey) === submittedDraft) drafts.delete(submittedKey); if (dialogKey === submittedKey) closeDialog(); }
      if (mode === "performance") void loadReport();
    }
    if (!dialog.open && (!document.activeElement || document.activeElement === document.body)) restoreBoardFocus(focus);
    return result;
  }
  async function submitForm(event) {
    event.preventDefault(); if (store.busy() || downloadBusy || !form.reportValidity()) return;
    const draft = currentDraft();
    try {
      if (conflict) { formMessage("Refresh the planner first, then review your retained draft and save again."); return; }
      if (dialogKind === "task") {
        if (store.snapshot().tasks.find(task => task.id === draft.id)?.status === "archived") return;
        if (!draft.title?.trim()) throw new Error("Add a task title first.");
        if (draft.id) {
          const task = store.snapshot().tasks.find(task => task.id === draft.id);
          syncTaskDraft();
          const changed = taskFields.filter(name => draft[name] !== draft.base[name]);
          if (changed.some(name => (task[name] || "") !== draft.base[name] && (task[name] || "") !== draft[name])) {
            conflict = true; form.querySelector('[data-planner-action="refresh"]').hidden = false;
            throw new Error("This task changed while you were editing. Reload latest, review your retained edits, then save again.");
          }
          if (!changed.length) { drafts.delete(dialogKey); closeDialog(); return; }
          await mutate(`/tasks/${encodeURIComponent(draft.id)}`, "PATCH", Object.fromEntries(changed.map(name => [name, name === "title" ? draft[name].trim() : draft[name]])), true);
        } else await mutate("/tasks", "POST", { tasks: [{ title: draft.title.trim(), notes: draft.notes || "", date: draft.date }] }, true);
      } else if (dialogKind === "settings") await mutate("/settings", "PUT", draft, true);
      else if (dialogKind === "day-off") await mutate("/days-off", "PUT", draft, true);
      else if (dialogKind === "sprints") { const submittedKey = dialogKey; if (await mutate("/sprints", "POST", draft)) { if (drafts.get(submittedKey) === draft) drafts.delete(submittedKey); if (dialog.open && dialogKey === submittedKey) { closeDialog(); openDialog("sprints"); } } }
      else if (dialogKind === "reports") await downloadReport();
      else if (dialogKind === "task-browser") return;
      else if (draft.proposals?.length && !aiBusy) {
        if (draft.proposals.some(task => !task.title.trim() || !validPlannerDate(task.date))) throw new Error("Each suggested task needs a title and valid date.");
        await mutate("/tasks", "POST", { tasks: draft.proposals.map(task => ({ title: task.title.trim(), notes: task.notes || "", date: task.date })) }, true);
      }
    } catch (error) { formMessage(error.message); }
  }
  async function downloadReport() {
    const draft = currentDraft(), range = plannerRange(draft.anchor, draft.period, store.snapshot().sprints.find(item => item.id === draft.sprintId));
    downloadBusy = true; syncBusy();
    try {
      const response = await fetcher(`${API}/report.${draft.format === "html" ? "html" : "csv"}?${new URLSearchParams({ ...range, groupBy: draft.groupBy === "sprint" ? "sprint" : "day" })}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("The report could not be downloaded. Please retry.");
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `Argus-tasks-${range.from}-${range.to}.${draft.format === "html" ? "html" : "csv"}`; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
      formMessage("Report downloaded. Your tasks and history are unchanged.");
    } catch (error) { formMessage(error.message); }
    finally { downloadBusy = false; syncBusy(); }
  }
  function updateAiState(message = "") {
    if (dialogKind === "ai") {
      const status = form.querySelector("[data-ai-status]"); if (status) status.textContent = message;
      const cancel = form.querySelector('[data-planner-action="cancel-ai"]'); if (cancel) cancel.hidden = !aiBusy;
      syncBusy();
    }
  }
  async function propose() {
    const draft = currentDraft(); if (aiBusy || !draft.prompt?.trim()) { formMessage("Describe the tasks you would like to plan first."); return; }
    const request = ++aiGeneration, draftKey = dialogKey;
    aiBusy = true; formMessage(); updateAiState("Preparing your task suggestions…");
    try {
      const result = await api(`${API}/ai/proposals`, { method: "POST", body: { prompt: draft.prompt.trim(), date: draft.date, provider: draft.provider } });
      if (request !== aiGeneration) { if (result.id) { aiJob = result.id; await cancelAi(); } else { aiBusy = false; updateAiState("Generation cancelled. Your draft is kept."); } return; }
      aiJob = result.id;
      const receive = async job => {
        if (request !== aiGeneration) return;
        if (job.cleanupRequired) { aiBusy = true; aiJob = job.id || aiJob; updateAiState(`${job.error || "The AI process could not finish cleaning up."} Use Cancel generation to retry cleanup. Your draft is kept.`); return; }
        if (job.status === "running" || job.status === "queued" || job.status === "paused") {
          if (job.status === "paused") updateAiState("Suggestions paused in Agents. Resume there or cancel.");
          else if (job.id) updateAiState("Preparing your task suggestions…");
          aiTimer = setTimeout(async () => {
            try { await receive(await api(`${API}/ai/proposals/${encodeURIComponent(aiJob)}`, { dedupe: false, cache: "no-store" })); }
            catch (error) { if (request === aiGeneration) { updateAiState("Connection interrupted. Retrying; you can still cancel generation. Your prompt is preserved."); await receive({ status: "running" }); } }
          }, 800); return;
        }
        aiBusy = false; aiJob = null;
        if (job.status !== "completed") { updateAiState(job.error || (job.status === "cancelled" ? "Generation cancelled. Your prompt is still here." : "Could not prepare suggestions. Your prompt is preserved.")); return; }
        const proposals = (job.tasks || []).slice(0, 40).map(task => ({ title: String(task.title || "").slice(0, 240), notes: String(task.notes || "").slice(0, 8000), date: validPlannerDate(task.date) ? task.date : draft.date }));
        drafts.set(draftKey, { ...drafts.get(draftKey), proposals });
        if (dialogKey === draftKey) { renderProposals(); updateAiState(proposals.length ? `${plural(proposals.length, "suggestion")} ready. Edit anything before adding.` : "No tasks suggested. Try adding more detail to your prompt."); }
      };
      await receive(result);
    } catch (error) { if (request === aiGeneration || !aiJob) { aiBusy = false; updateAiState(error.message || "Could not prepare suggestions. Your prompt is preserved."); } }
  }
  async function cancelAi() {
    const job = aiJob; aiGeneration++; clearTimeout(aiTimer);
    if (!job) { updateAiState("Cancellation requested. Waiting for the pending request to identify its job; your draft is kept."); return; }
    updateAiState("Cancelling generation…");
    try { const result = await api(`${API}/ai/proposals/${encodeURIComponent(job)}`, { method: "DELETE" }); if (result.cleanupRequired) { aiBusy = true; aiJob = job; updateAiState("Cleanup is not confirmed yet. Use Cancel generation to retry. Your draft is kept."); } else { aiBusy = false; aiJob = null; updateAiState("Generation cancelled. Your prompt and previous suggestions are kept."); } }
    catch (error) { aiBusy = true; aiJob = job; updateAiState(`Cancellation could not be confirmed: ${error.message}. Use Cancel generation to retry. Your draft is kept.`); }
  }
  async function handleAction(event) {
    const target = event.target.closest("[data-planner-action]"); if (!target || !root.contains(target) || target.disabled) return;
    const action = target.dataset.plannerAction, state = store.snapshot();
    if (!state && action !== "refresh") return;
    if (action === "close-dialog") { closeDialog(); return; }
    if (action === "refresh") { $("notice").hidden = true; formMessage(); const before = store.snapshot(); await store.refresh(); if (store.snapshot() !== before) { conflict = false; const reload = form.querySelector('[data-planner-action="refresh"]'); if (reload) reload.hidden = true; if (dialog.open) { syncTaskDraft(true); renderTaskResults(); } } reportCache = null; if (mode === "performance") void loadReport(); return; }
    if (action === "today" || action === "previous" || action === "next") {
      if (action === "today") anchor = state.today;
      else if (mode === "performance" && period === "month") { const date = new Date(`${anchor.slice(0, 7)}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + (action === "next" ? 1 : -1)); anchor = date.toISOString().slice(0, 10); }
      else anchor = addPlannerDays(anchor, action === "next" ? 7 : -7);
      reportGeneration++; reportController?.abort(); render(); return;
    }
    if (action === "view-week" || action === "view-performance") { mode = action === "view-week" ? "week" : "performance"; boardStamp = ""; reportGeneration++; reportController?.abort(); render(); return; }
    if (action === "new-task") { openDialog("task", { date: target.dataset.date || defaultDate() }); return; }
    if (action === "edit-task") { openDialog("task", { id: target.dataset.id }); return; }
    if (action === "task-links") { openDialog("task", { id: target.dataset.id, links: true }); return; }
    if (action === "more-day-tasks" || action === "more-day-history") {
      const limits = action === "more-day-tasks" ? taskLimits : historyLimits;
      limits.set(target.dataset.date, (limits.get(target.dataset.date) || 40) + 40);
      boardStamp = ""; render(); return;
    }
    if (["settings", "reports", "sprints", "ai", "task-browser"].includes(action)) { openDialog(action); return; }
    if (action === "more-tasks" || action === "more-links") { const key = action === "more-tasks" ? "resultLimit" : "linkLimit"; currentDraft()[key] = (currentDraft()[key] || (key === "resultLimit" ? 40 : 20)) + 40; renderTaskResults(); syncBusy(); return; }
    if (action === "add-link" || action === "remove-link") {
      if (dialogKind !== "task" || !currentDraft().id || store.busy()) return;
      if (conflict) { formMessage("Reload the latest planner before changing links. Your task draft is kept."); return; }
      const sourceId = currentDraft().id;
      const result = action === "add-link" ? await mutate("/links", "POST", { sourceTaskId: sourceId, targetTaskId: target.dataset.id, type: "related" })
        : await mutate(`/links/${encodeURIComponent(target.dataset.linkId)}`, "DELETE");
      if (result && dialogKind === "task" && currentDraft().id === sourceId) { renderTaskResults(); syncBusy(); formMessage(action === "add-link" ? "Tasks linked. Both tasks keep their dates and history." : "Link removed. Both tasks and their history are kept."); form.elements.linkQuery?.focus({ preventScroll: true }); }
      return;
    }
    if (action === "day-off") { openDialog("day-off", { date: target.dataset.date }); return; }
    if (action === "propose") { await propose(); return; }
    if (action === "cancel-ai") { await cancelAi(); return; }
    if (action === "remove-proposal") { currentDraft().proposals.splice(Number(target.dataset.index), 1); renderProposals(); return; }
    if (action === "delete-sprint") { const submittedKey = dialogKey; if (await mutate(`/sprints/${encodeURIComponent(target.dataset.id)}`, "DELETE") && dialog.open && dialogKey === submittedKey) renderDialog(); return; }
    const task = state.tasks.find(item => item.id === target.dataset.id); if (!task) return;
    if (action === "delete-task") {
      if (store.busy()) return;
      if (conflict) { formMessage("Reload the latest planner before deleting. Your draft is kept."); return; }
      if (!root.ownerDocument.defaultView.confirm(`Permanently delete ${taskLabel(task)}: ${task.title}?\n\nThis removes the task, its notes, activity/report history and related-task links. This cannot be undone. Archive instead to keep its history. Existing backups and exported reports are not erased.`)) return;
      if (await mutate(`/tasks/${encodeURIComponent(task.id)}`, "DELETE", {}, true)) {
        drafts.delete(`task:${task.id}`);
        toast("Task permanently deleted.");
      }
      return;
    }
    if (action === "complete") {
      if (await mutate(`/tasks/${encodeURIComponent(task.id)}`, "PATCH", { status: task.status === "done" ? "todo" : "done" })) {
        const updated = store.snapshot().tasks.find(item => item.id === task.id);
        const completedDate = updated.completedAt ? plannerClock(store.snapshot().settings.timeZone, new Date(updated.completedAt)).date : store.snapshot().today;
        toast(task.status === "done" ? `Task reopened on its planned day, ${dateLabel(updated.date)}.` : `Completed ${dateLabel(completedDate)}. Task stays on ${dateLabel(updated.date)}.`);
      }
    }
    if (action === "progress") {
      const recordedToday = state.events.some(event => event.taskId === task.id && event.date === state.today && ["started", "completed"].includes(event.kind));
      await mutate(`/tasks/${encodeURIComponent(task.id)}`, "PATCH", { status: task.status === "in-progress" && recordedToday ? "todo" : "in-progress" });
    }
    if (action === "archive-task" && task.status !== "archived") {
      if (dialogKind === "task" && currentDraft().id === task.id) {
        syncTaskDraft();
        if (taskFields.some(name => currentDraft()[name] !== (task[name] || ""))) {
          formMessage("Save your edits before archiving this task. Your draft is still here."); return;
        }
      }
      if (await mutate(`/tasks/${encodeURIComponent(task.id)}`, "PATCH", { status: "archived" }, true)) toast("Task archived, not deleted. Use Find task → Archived to restore it.");
    }
    // Keep the editor open: a draft retained across an external archive must become editable again,
    // not be discarded by the restore action.
    if (action === "restore-task" && task.status === "archived" && await mutate(`/tasks/${encodeURIComponent(task.id)}`, "PATCH", { status: "todo" })) {
      const message = `Task restored to its planned day, ${dateLabel(store.snapshot().tasks.find(item => item.id === task.id).date)}. History, links and missed-day count kept.`;
      formMessage(message); toast(message);
    }
  }
  root.addEventListener("click", event => { void handleAction(event).catch(showError); });
  form.addEventListener("submit", submitForm);
  form.addEventListener("input", event => {
    const name = event.target.name; if (!name) return;
    const proposal = event.target.closest("[data-proposal]");
    if (proposal) { const task = currentDraft().proposals[Number(proposal.dataset.proposal)]; if (task) task[({ proposalTitle: "title", proposalNotes: "notes", proposalDate: "date" })[name]] = event.target.value; }
    else currentDraft()[name] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    if (dialogKind === "reports") updateReportRange();
    if (dialogKind === "task" && name === "date") updateTaskStatusOptions();
    if (name === "taskQuery" || name === "linkQuery" || name === "taskStatusFilter") { currentDraft()[name === "linkQuery" ? "linkLimit" : "resultLimit"] = name === "linkQuery" ? 20 : 40; renderTaskResults(); syncBusy(); }
  });
  // Native select changes also fire input in Chromium; this explicit handler is
  // useful for accessibility clients that dispatch a change event directly.
  form.addEventListener("change", event => { if (event.target.name && !event.target.closest("[data-proposal]")) { currentDraft()[event.target.name] = event.target.type === "checkbox" ? event.target.checked : event.target.value; if (dialogKind === "reports") updateReportRange(); if (event.target.name === "taskStatusFilter") { currentDraft().resultLimit = 40; renderTaskResults(); syncBusy(); } } });
  $("period").addEventListener("change", event => { period = event.target.value; reportGeneration++; reportController?.abort(); render(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  return {
    async open() {
      visible = true; root.hidden = false; render();
      if (desktop?.getPlannerNotificationStatus) Promise.resolve(desktop.getPlannerNotificationStatus()).then(value => { notificationStatus = value; }).catch(() => {});
      clearInterval(refreshTimer);
      // Reconcile at most once per minute, including the calendar-day missed deadline.
      // Unchanged revisions do not repaint cards; open drafts are never rebuilt.
      refreshTimer = setInterval(() => {
        const state = store.snapshot(); if (!visible || !state || store.busy()) return;
        void store.refresh().then(() => render());
      }, 60_000);
      return store.refresh();
    },
    close() { visible = false; root.hidden = true; store.close(); reportGeneration++; reportController?.abort(); clearInterval(refreshTimer); disposeTimePickers?.(); disposeTimePickers = null; if (dialog.open) dialog.close(); },
    refresh: () => store.refresh(), snapshot: () => store.snapshot(),
    destroy() { this.close(); aiGeneration++; clearTimeout(aiTimer); if (aiJob) void api(`${API}/ai/proposals/${encodeURIComponent(aiJob)}`, { method: "DELETE" }).catch(() => {}); root.replaceChildren(); },
  };
}
