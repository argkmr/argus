import test from "node:test";
import assert from "node:assert/strict";
import { parsePlannerTime, plannerTimeParts, formatPlannerTime, plannerTimeFieldMarkup } from "../public/planner-time-picker.mjs";

test("time input preserves exact minutes and normalizes explicit 12-hour or 24-hour input", () => {
  assert.equal(parsePlannerTime("11:37 AM"), "11:37");
  assert.equal(parsePlannerTime("6:04 pm"), "18:04");
  assert.equal(parsePlannerTime("  01:59PM  "), "13:59");
  assert.equal(parsePlannerTime("23:59"), "23:59");
  assert.equal(parsePlannerTime("7:02"), "07:02");
  assert.equal(formatPlannerTime("18:04"), "6:04 PM");
  assert.equal(formatPlannerTime("11:37"), "11:37 AM");
});

test("midnight and noon are mapped without a twelve-hour offset error", () => {
  assert.equal(parsePlannerTime("12:00 AM"), "00:00");
  assert.equal(parsePlannerTime("12:00 PM"), "12:00");
  assert.equal(formatPlannerTime("00:00"), "12:00 AM");
  assert.equal(formatPlannerTime("12:00"), "12:00 PM");
  assert.deepEqual(plannerTimeParts("00:59"), { hour: 12, minute: 59, period: "AM" });
  assert.deepEqual(plannerTimeParts("12:59"), { hour: 12, minute: 59, period: "PM" });
});

test("incomplete and out-of-range times never become a different valid time", () => {
  for (const value of [undefined, null, 930, "", "9", "9:3", "9:", "24:00", "00:00 AM", "13:30 PM", "12:60 PM", "-1:00", "1:00 XM", "1:00 AM extra", "01:00:30", "9.30 AM"]) {
    assert.equal(parsePlannerTime(value), null, String(value));
    assert.equal(formatPlannerTime(value), "", String(value));
  }
});

test("every minute survives canonical/display round trips", () => {
  for (let minute = 0; minute < 24 * 60; minute++) {
    const canonical = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    assert.equal(parsePlannerTime(formatPlannerTime(canonical)), canonical);
  }
});

test("time fields contain no OS picker and expose all exact-minute choices accessibly", () => {
  const html = plannerTimeFieldMarkup({ name: "startTime", label: "Start time", value: "11:37" });
  assert.ok(!html.includes('type="time"')); assert.ok(!html.includes("<select"));
  assert.ok(html.includes('type="hidden" name="startTime" value="11:37"'));
  assert.ok(html.includes('value="11:37 AM"'));
  assert.ok(html.includes('aria-haspopup="dialog"')); assert.ok(html.includes('popover="manual"'));
  assert.equal((html.match(/data-time-part="minute"/g) || []).length, 60);
  assert.equal((html.match(/data-time-part="hour"/g) || []).length, 12);
  assert.equal((html.match(/data-time-part="period"/g) || []).length, 2);
  assert.ok(html.includes('data-time-choice="37"'));
  assert.ok(html.includes('type="text"')); assert.ok(html.includes(" required "));
});

test("field labels and names are escaped and repeated fields get distinct DOM identities", () => {
  const first = plannerTimeFieldMarkup({ name: '"><script>', label: '<img src="x">', value: '" onfocus="x"' });
  const second = plannerTimeFieldMarkup({ name: "endTime", label: "End time", value: "18:00" });
  assert.ok(!first.includes("<script>")); assert.ok(!first.includes('<img src="x">'));
  assert.ok(first.includes("&lt;script&gt;")); assert.ok(first.includes("&lt;img"));
  assert.ok(first.includes('data-time-value')); assert.ok(first.includes('value=""'));
  const getId = html => html.match(/id="(planner-time-\d+)-display"/)[1];
  assert.notEqual(getId(first), getId(second));
});
