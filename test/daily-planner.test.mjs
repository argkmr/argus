import test from "node:test";
import assert from "node:assert/strict";
import { addPlannerDays, validPlannerDate, plannerWeek, plannerWorkingDay, plannerRange, plannerClock, plannerDefaultDate, createPlannerStore, plannerBoardMarkup, plannerPerformanceMarkup, plannerRelatedTasks, plannerSearchTasks, rebasePlannerTaskDraft, plannerTimingIndex, plannerTimingLabel } from "../public/daily-planner.mjs";

const snapshot = (revision = 1) => ({ revision, today: "2026-09-22", tasks: [], events: [], daysOff: [], sprints: [], settings: { startTime: "09:00", endTime: "18:00", timeZone: "Asia/Kolkata", remindersEnabled: false } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("cached task drafts merge newer completion and move while retaining only genuine edits", () => {
  const original = { id: "a", title: "Release", notes: "", date: "2026-09-22", status: "todo" };
  const draft = rebasePlannerTaskDraft({ ...original }, original);
  draft.notes = "Unsaved notes";
  const latest = { ...original, date: "2026-09-24", status: "done" };
  rebasePlannerTaskDraft(draft, latest);
  assert.equal(draft.date, latest.date); assert.equal(draft.status, "done"); assert.equal(draft.notes, "Unsaved notes");
  assert.equal(draft.base.notes, ""); assert.equal(draft.base.status, "done");
});

test("conflicting field bases remain until explicit refresh review, not a background refresh", () => {
  const task = { id: "a", title: "Release", notes: "Original notes", date: "2026-09-22", status: "todo" };
  const draft = rebasePlannerTaskDraft({ ...task }, task); draft.notes = "My draft";
  const latest = { ...task, notes: "Changed elsewhere" };
  rebasePlannerTaskDraft(draft, latest);
  assert.equal(draft.notes, "My draft"); assert.equal(draft.base.notes, "Original notes");
  rebasePlannerTaskDraft(draft, latest, true);
  assert.equal(draft.notes, "My draft"); assert.equal(draft.base.notes, "Changed elsewhere");
});

test("task search crosses all dates and statuses, matches permanent IDs and never mutates snapshot", () => {
  const state = snapshot(); state.tasks = [
    { id: "one", key: "TASK-1", title: "Design <API>", date: "2020-01-01", status: "archived" },
    { id: "two", key: "TASK-2", title: "Ship API", date: "2030-12-01", status: "done" },
    { id: "three", key: "TASK-3", title: "Testing", notes: "API contracts", date: state.today, status: "todo" },
  ];
  const original = structuredClone(state);
  assert.equal(plannerSearchTasks(state).length, 3);
  assert.deepEqual(plannerSearchTasks(state, "task-1").map(task => task.id), ["one"]);
  assert.deepEqual(plannerSearchTasks(state, "API archived").map(task => task.id), ["one"]);
  assert.deepEqual(plannerSearchTasks(state, "2030-12").map(task => task.id), ["two"]);
  assert.deepEqual(plannerSearchTasks(state, "API", ["one", "two"]).map(task => task.id), ["three"]);
  assert.deepEqual(state, original);
});

test("related links are undirected UUID edges and survive moves, title changes and archive", () => {
  const state = snapshot(); state.tasks = [{ id: "a", key: "TASK-1" }, { id: "b", key: "TASK-2" }];
  state.links = [{ id: "edge", sourceTaskId: "a", targetTaskId: "b", type: "related" }];
  assert.equal(plannerRelatedTasks(state, "a")[0].task.id, "b");
  assert.equal(plannerRelatedTasks(state, "b")[0].task.id, "a");
  Object.assign(state.tasks[1], { title: "New title", date: "2030-12-01", status: "archived" });
  assert.equal(plannerRelatedTasks(state, "a")[0].task.key, "TASK-2");
  assert.equal(plannerRelatedTasks(state, "a")[0].link.id, "edge");
  assert.deepEqual(plannerRelatedTasks(state, "missing"), []);
});

test("link mutations use snapshot revision for create and delete and keep IDs on refresh", async () => {
  const state = snapshot(); state.tasks = [{ id: "a", key: "TASK-1" }, { id: "b", key: "TASK-2" }]; state.links = [];
  const calls = [];
  const store = createPlannerStore({ api: async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") { state.links = [{ id: "edge", ...options.body }]; state.revision++; }
    if (options.method === "DELETE") { state.links = []; state.revision++; }
    return structuredClone(state);
  } });
  await store.refresh(); await store.mutate("/links", "POST", { sourceTaskId: "a", targetTaskId: "b", type: "related" });
  assert.deepEqual(calls[1].options.body, { sourceTaskId: "a", targetTaskId: "b", type: "related", revision: 1 });
  await store.refresh(); assert.equal(store.snapshot().links.length, 1); assert.equal(store.snapshot().tasks[0].key, "TASK-1");
  await store.mutate("/links/edge", "DELETE");
  assert.equal(calls.at(-1).url, "/api/daily-planner/links/edge?revision=2");
  assert.equal(store.snapshot().tasks.length, 2); assert.deepEqual(store.snapshot().links, []);
});

test("planner calendar arithmetic is date-only, Monday-first and DST independent", () => {
  assert.equal(validPlannerDate("2026-02-30"), false);
  assert.equal(validPlannerDate("2024-02-29"), true);
  assert.equal(validPlannerDate("2026-09-22<script>"), false);
  assert.equal(addPlannerDays("2024-03-10", 1), "2024-03-11");
  assert.equal(addPlannerDays("2026-12-31", 1), "2027-01-01");
  assert.deepEqual(plannerWeek("2026-09-27"), ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
  assert.deepEqual(plannerWeek("2026-09-21"), plannerWeek("2026-09-27"));
  assert.throws(() => addPlannerDays("no-date", 1));
});

test("next workday skips weekends, consecutive leave and year boundaries", () => {
  assert.equal(plannerWorkingDay("2026-09-25", [{ date: "2026-09-28" }, { date: "2026-09-29" }], true), "2026-09-30");
  assert.equal(plannerWorkingDay("2026-09-26"), "2026-09-28");
  assert.equal(plannerWorkingDay("2026-12-31", ["2027-01-01"], true), "2027-01-04");
  assert.equal(plannerWorkingDay("2026-09-22"), "2026-09-22");
});

test("new tasks default to the next workday after configured end, using the workday timezone", () => {
  const state = snapshot();
  assert.deepEqual(plannerClock("Asia/Kolkata", new Date("2026-09-22T12:29:00Z")), { date: "2026-09-22", time: "17:59" });
  assert.equal(plannerDefaultDate(state, new Date("2026-09-22T12:29:00Z")), "2026-09-22");
  state.daysOff = [{ date: "2026-09-23" }];
  assert.equal(plannerDefaultDate(state, new Date("2026-09-22T12:30:00Z")), "2026-09-24");
  assert.equal(plannerDefaultDate(state, new Date("2026-09-25T13:00:00Z")), "2026-09-28");
});

test("periodic unchanged snapshots do not repaint, while recorded missed-day revisions do", async () => {
  let revision = 1, renders = 0;
  const store = createPlannerStore({ api: async () => snapshot(revision), onChange: () => renders++ });
  await store.refresh(); await store.refresh(); await store.refresh();
  assert.equal(renders, 1); revision = 2; await store.refresh(); assert.equal(renders, 2);
});

test("week, month, six-month and sprint reports retain exact inclusive boundaries", () => {
  assert.deepEqual(plannerRange("2026-09-22"), { from: "2026-09-21", to: "2026-09-27" });
  assert.deepEqual(plannerRange("2024-02-15", "month"), { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(plannerRange("2026-03-15", "six-months"), { from: "2025-10-01", to: "2026-03-31" });
  assert.deepEqual(plannerRange("2026-09-22", "sprint", { startDate: "2026-09-21", endDate: "2026-10-02" }), { from: "2026-09-21", to: "2026-10-02" });
  assert.throws(() => plannerRange("2026-09-22", "sprint"), /choose a sprint/i);
});

test("late refresh cannot overwrite a newer mutation; duplicate saves are refused", async () => {
  const late = deferred(), save = deferred(), calls = [];
  const store = createPlannerStore({ api: async (url, options = {}) => { calls.push({ url, options }); return calls.length === 1 ? snapshot(1) : options.method ? save.promise : late.promise; } });
  await store.refresh();
  const refresh = store.refresh();
  const mutation = store.mutate("/tasks", "POST", { tasks: [{ title: "Release" }] });
  assert.equal(await store.mutate("/tasks", "POST", {}), false);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.signal.aborted, true);
  assert.equal(calls[2].options.body.revision, 1);
  save.resolve(snapshot(2)); assert.equal(await mutation, true);
  late.resolve(snapshot(1)); await refresh;
  assert.equal(store.snapshot().revision, 2);
});

test("close/reopen retires stale reads without cancelling a committed save", async () => {
  const first = deferred(), second = deferred(), saving = deferred(); let reads = 0;
  const store = createPlannerStore({ api: (url, options) => options.method ? saving.promise : (++reads === 1 ? first.promise : second.promise) });
  const old = store.refresh(); store.close(); const fresh = store.refresh();
  second.resolve(snapshot(3)); await fresh; first.resolve(snapshot(1)); await old;
  assert.equal(store.snapshot().revision, 3);
  const mutation = store.mutate("/tasks/id", "PATCH", { status: "done" }); store.close(); saving.resolve(snapshot(4));
  assert.equal(await mutation, true); assert.equal(store.snapshot().revision, 4);
});

test("conflicts preserve current snapshot, release lock and allow an explicit reload", async () => {
  const errors = [], calls = []; let revision = 1;
  const store = createPlannerStore({ api: async (url, options) => { calls.push({ url, options }); if (options.method) throw Object.assign(new Error("Conflict"), { status: 409 }); return snapshot(revision); }, onError: error => errors.push(error) });
  await store.refresh(); assert.equal(await store.mutate("/tasks/id", "PATCH", { title: "Kept draft" }), false);
  assert.equal(store.busy(), false); assert.equal(store.snapshot().revision, 1); assert.equal(errors[0].status, 409);
  revision = 2; await store.refresh(); assert.equal(store.snapshot().revision, 2);
  await store.mutate("/sprints/id", "DELETE"); assert.equal(calls.at(-1).url, "/api/daily-planner/sprints/id?revision=2");
});

test("invalid snapshots and failed initial load remain recoverable", async () => {
  const errors = []; let good = false;
  const store = createPlannerStore({ api: async () => good ? snapshot() : { revision: 1 }, onError: error => errors.push(error) });
  await store.refresh(); assert.equal(store.snapshot(), null); assert.equal(errors.length, 1);
  assert.equal(await store.mutate("/tasks", "POST"), false);
  good = true; await store.refresh(); assert.equal(store.snapshot().revision, 1);
});

test("board escapes user content and pins legacy moved tasks to their original day without duplicate cards", () => {
  const state = snapshot();
  state.tasks = [{ id: 'id"<x>', title: '<script>alert("x")</script>', notes: '<img onerror="bad()">', date: "2026-09-22", originalDate: "2026-09-21", status: "in-progress" }, { id: "done", title: "Finished", date: "2026-09-21", status: "done" }, { id: "archived", title: "Hidden", date: "2026-09-22", status: "archived" }];
  state.events = [{ taskId: state.tasks[0].id, title: state.tasks[0].title, kind: "moved", fromDate: "2026-09-21", toDate: "2026-09-22" }];
  state.daysOff = [{ date: "2026-09-24", label: "Family <holiday>" }];
  state.sprints = [{ name: "Sprint <24>", startDate: "2026-09-21", endDate: "2026-10-02" }];
  const html = plannerBoardMarkup(state, state.today);
  assert.equal((html.match(/class="dp-day(?: |")/g) || []).length, 5);
  assert.ok(!html.includes("<script>")); assert.ok(!html.includes('<img onerror="bad()">'));
  assert.ok(html.includes("&lt;script&gt;")); assert.ok(html.includes("Family &lt;holiday&gt;"));
  assert.ok(!html.includes("Carried over")); assert.ok(!html.includes('data-planner-action="move"'));
  assert.ok(html.includes("1 day overdue"));
  assert.ok(html.includes("1 not completed that day"));
  assert.ok(!html.includes(">Hidden<")); assert.equal((html.match(/data-task="done"/g) || []).length, 1);
  assert.ok(html.includes('aria-pressed="true"'));
});

test("overdue and future tasks stay completable even after the workday ends", () => {
  const state = snapshot(); state.settings.endTime = "00:00";
  state.tasks = [
    { id: "next-week", title: "Planned next week", date: "2026-09-28", originalDate: "2026-09-28", status: "todo" },
    { id: "working", title: "Work already started", date: "2026-09-29", status: "in-progress" },
  ];
  const html = plannerBoardMarkup(state, "2026-09-28");
  for (const action of ["complete", "progress"]) {
    const buttons = html.match(new RegExp(`<button[^>]*data-planner-action="${action}"[^>]*>`, "g"));
    assert.equal(buttons.length, 2);
    assert.ok(buttons.every(button => !button.includes("disabled")));
  }
  assert.ok(html.includes("Mark completed today; keep this card on its planned day"));
  assert.ok(html.includes("Work on today"));
  assert.ok(!html.includes("Start and complete tasks on their planned workday"));
});

test("weekend completion remains on its original weekday, while legacy weekend plans remain visible", () => {
  const state = snapshot(); state.today = "2026-09-26";
  state.tasks = [{ id: "friday-done", title: "Completed on Saturday", date: "2026-09-25", originalDate: "2026-09-25", status: "done", completedAt: "2026-09-26T05:00:00Z" }];
  let html = plannerBoardMarkup(state, state.today);
  assert.equal((html.match(/class="dp-day(?: |")/g) || []).length, 5);
  assert.match(html, /data-task="friday-done" data-timing="late"/);
  assert.match(html, /1 day late/);
  assert.match(html, /1 not completed that day/);
  state.tasks.push({ id: "saturday-done", title: "Legacy Saturday plan", date: state.today, status: "done" });
  html = plannerBoardMarkup(state, state.today);
  assert.equal((html.match(/class="dp-day(?: |")/g) || []).length, 6);
  assert.match(html, /data-task="saturday-done"/);
  assert.match(html, /data-date="2026-09-26" title="Tasks can only be added to an upcoming workday" disabled/);
  state.daysOff = [{ date: "2026-09-25", label: "Leave" }];
  state.tasks.push({ id: "leave-done", title: "Quick follow-up", date: "2026-09-25", status: "done" });
  html = plannerBoardMarkup(state, state.today);
  assert.match(html, /data-task="leave-done"/);
  assert.match(html, /1\/1 completed/);
  state.tasks[1].status = "archived";
  html = plannerBoardMarkup(state, state.today);
  assert.equal((html.match(/class="dp-day(?: |")/g) || []).length, 5);
});

test("planned-date missed counts survive late completion, archive, reopen and a clock rollback", () => {
  const state = snapshot(); state.today = "2026-09-25";
  state.tasks = [{ id: "late", title: "Still planned for Tuesday", date: "2026-09-22", originalDate: "2026-09-22", status: "todo" }];
  let timing = plannerTimingIndex(state);
  assert.equal(timing.missedByDate.get("2026-09-22"), 1);
  assert.equal(timing.timings.get("late").timingStatus, "very-overdue");
  state.events.push({ taskId: "late", kind: "missed-planned-day", date: "2026-09-22" }, { taskId: "late", kind: "completed", date: "2026-09-25" });
  for (const status of ["done", "archived", "todo", "in-progress"]) {
    state.tasks[0].status = status;
    timing = plannerTimingIndex(state);
    assert.equal(timing.missedByDate.get("2026-09-22"), 1);
    assert.equal(timing.timings.get("late").completedDate, "2026-09-25");
    assert.equal(timing.timings.get("late").latenessDays, 3);
    assert.match(plannerBoardMarkup(state, state.today), /1 not completed that day/);
  }
  state.today = "2026-09-21"; state.events = state.events.filter(event => event.kind !== "completed");
  assert.equal(plannerTimingIndex(state).missedByDate.get("2026-09-22"), 1);
});

test("timing colours use exact calendar days and first completion evidence, including weekends", () => {
  const state = snapshot(); state.today = "2026-10-02";
  state.tasks = [0, 1, 2, 3].map(days => ({ id: `done-${days}`, title: `Completed ${days} days late`, date: "2026-09-25", originalDate: "2026-09-25", status: "done" }));
  state.events = state.tasks.map((task, days) => ({ taskId: task.id, kind: "completed", date: addPlannerDays(task.date, days) }));
  const { timings, missedByDate } = plannerTimingIndex(state);
  assert.deepEqual([...timings.values()].map(t => t.timingStatus), ["on-time", "late", "late", "very-late"]);
  assert.deepEqual([...timings.values()].map(t => t.latenessDays), [0, 1, 2, 3]);
  assert.equal(missedByDate.get("2026-09-25"), 3);
  const html = plannerBoardMarkup(state, "2026-09-25");
  assert.match(html, /data-task="done-0" data-timing="on-time"/);
  assert.match(html, /data-task="done-1" data-timing="late"/);
  assert.match(html, /data-task="done-3" data-timing="very-late"/);
  assert.match(html, /3 not completed that day/);
  assert.equal(plannerTimingLabel(timings.get("done-0")), "Completed same day");
  state.tasks[0].status = "todo";
  state.events.push({ taskId: "done-0", kind: "completed", date: "2026-10-02" });
  assert.equal(plannerTimingIndex(state).timings.get("done-0").missedPlannedDay, false);
});

test("today remains pending until its calendar day passes, and backend evidence takes precedence", () => {
  const state = snapshot(); state.tasks = [{ id: "today", title: "Today's plan", date: state.today, status: "todo" }];
  assert.equal(plannerTimingIndex(state).timings.get("today").timingStatus, "pending");
  assert.equal(plannerTimingIndex(state).missedByDate.size, 0);
  state.taskTimings = { today: { plannedDate: state.today, completedDate: null, latenessDays: null, timingStatus: "overdue", missedPlannedDay: true } };
  state.missedByDate = { [state.today]: 1 };
  assert.equal(plannerTimingIndex(state).timings.get("today"), state.taskTimings.today);
  assert.equal(plannerTimingIndex(state).missedByDate.get(state.today), 1);
});

test("obsolete unsaved reschedule drafts cannot override a fixed planned date", () => {
  const task = { id: "a", title: "Release", notes: "", date: "2026-09-22", status: "todo" };
  const draft = rebasePlannerTaskDraft({ ...task }, task);
  draft.date = "2026-09-28"; draft.notes = "Keep my notes";
  rebasePlannerTaskDraft(draft, task);
  assert.equal(draft.date, task.date); assert.equal(draft.base.date, task.date);
  assert.equal(draft.notes, "Keep my notes");
});

test("large day backlogs render bounded pages, pending work first, with full totals", () => {
  const state = snapshot();
  state.tasks = Array.from({ length: 120 }, (_, index) => ({ id: `task-${index}`, key: `TASK-${index + 1}`, title: `Task ${index}`, date: state.today, status: index < 20 ? "done" : "todo" }));
  const before = structuredClone(state);
  let html = plannerBoardMarkup(state, state.today);
  assert.equal((html.match(/<article class="dp-task/g) || []).length, 40);
  assert.match(html, /20\/120 completed · 100 open/);
  assert.ok(html.indexOf('data-task="task-20"') < html.indexOf('data-task="task-21"'));
  assert.ok(!html.includes('data-task="task-0"'));
  assert.match(html, /Show 40 more · 80 remaining/);
  html = plannerBoardMarkup(state, state.today, { taskLimits: new Map([[state.today, 120]]) });
  assert.equal((html.match(/<article class="dp-task/g) || []).length, 120);
  assert.ok(html.indexOf('data-task="task-119"') < html.indexOf('data-task="task-0"'));
  assert.ok(!html.includes('data-planner-action="more-day-tasks"'));
  assert.deepEqual(state, before);
});

test("move history is deduplicated, collapsible and bounded without deleting archive history", () => {
  const state = snapshot();
  state.tasks = Array.from({ length: 100 }, (_, index) => ({ id: `task-${index}`, key: `TASK-${index + 1}`, title: `Task ${index}`, date: "2026-10-01", status: index === 0 ? "archived" : "todo" }));
  state.events = state.tasks.flatMap(task => ["2026-09-23", "2026-10-01"].map(toDate => ({ kind: "moved", taskId: task.id, title: task.title, fromDate: state.today, toDate })));
  let html = plannerBoardMarkup(state, state.today);
  assert.match(html, /data-day-history="2026-09-22"><summary>/);
  assert.match(html, /class="dp-history-count">100<\/span>/);
  assert.equal((html.match(/class="dp-moved-record"/g) || []).length, 40);
  assert.ok(html.includes("· Archived"));
  assert.ok(!html.includes('data-task="task-0"'));
  assert.match(html, /Show 40 more · 60 remaining/);
  html = plannerBoardMarkup(state, state.today, { historyLimits: new Map([[state.today, 120]]) });
  assert.equal((html.match(/class="dp-moved-record"/g) || []).length, 100);
  assert.ok(!html.includes('data-planner-action="more-day-history"'));
});

test("performance uses distinct backend totals, not invented time or duplicate daily sums", () => {
  const html = plannerPerformanceMarkup({ summary: { planned: 2, worked: 1, completed: 1, moved: 1 }, daily: [{ date: "2026-09-21", summary: { planned: 1, completed: 1, moved: 0 }, tasks: [{ title: '<a href="bad">unsafe</a>', completed: true, worked: true }] }, { date: "2026-09-22", summary: { planned: 1, completed: 0, moved: 1 }, tasks: [] }] });
  assert.ok(html.includes("Totals count distinct tasks")); assert.ok(html.includes("Worked on” means marked"));
  assert.ok(html.includes('aria-label="1 of 1 planned tasks completed"'));
  assert.ok(!html.includes('<a href="bad">')); assert.ok(html.includes("&lt;a href="));
});
