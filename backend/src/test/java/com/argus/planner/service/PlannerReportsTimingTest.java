package com.argus.planner.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.planner.domain.PlannerModels.*;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class PlannerReportsTimingTest {
  private static final String PLANNED = "2026-09-25";

  private Task task(String id, String status, String date, String original, String completedAt) {
    return new Task(
        id,
        "Current " + id,
        "Current notes",
        status,
        date,
        original,
        "2026-09-20T10:00:00Z",
        "2026-10-05T10:00:00Z",
        completedAt,
        "TASK-" + id);
  }

  private Event event(String id, String day, String kind, String title) {
    return new Event(
        kind + "-" + id + "-" + day,
        id,
        title,
        "Recorded notes",
        day,
        kind,
        PLANNED,
        PLANNED,
        day + "T10:00:00Z",
        "completed".equals(kind) ? "done" : "todo",
        "manual");
  }

  private Stored state(List<Task> tasks, List<Event> events) {
    return state(tasks, events, "UTC", List.of());
  }

  private Stored state(List<Task> tasks, List<Event> events, String zone, List<Sprint> sprints) {
    return new Stored(
        1,
        new Settings("09:00", "18:00", zone, true),
        tasks,
        events,
        List.of(new DayOff("2026-09-28", "Leave")),
        sprints,
        Set.of(),
        20L,
        List.of());
  }

  private TaskTiming timing(Stored state, String today, String id) {
    return PlannerTaskTiming.build(state, LocalDate.parse(today)).get(id);
  }

  private Report report(Stored state, String from, String to, String today) {
    return PlannerReports.build(
        state, LocalDate.parse(from), LocalDate.parse(to), "day", LocalDate.parse(today));
  }

  @Test
  void firstCompletionUsesCalendarDaysIncludingWeekendsDaysOffAndEarlyCompletion() {
    var tasks = new ArrayList<Task>();
    var events = new ArrayList<Event>();
    for (int offset = -1; offset <= 3; offset++) {
      String id = String.valueOf(offset + 2);
      tasks.add(task(id, "done", PLANNED, PLANNED, null));
      events.add(
          event(
              id,
              LocalDate.parse(PLANNED).plusDays(offset).toString(),
              "completed",
              "Finished " + id));
    }
    var timings = PlannerTaskTiming.build(state(tasks, events), LocalDate.parse("2026-10-05"));
    assertThat(timings.values())
        .extracting(TaskTiming::latenessDays)
        .containsExactly(-1, 0, 1, 2, 3);
    assertThat(timings.values())
        .extracting(TaskTiming::timingStatus)
        .containsExactly("on-time", "on-time", "late", "late", "very-late");
    assertThat(PlannerTaskTiming.missedByDate(timings))
        .containsExactlyEntriesOf(Map.of(PLANNED, 3));
  }

  @Test
  void unfinishedTasksRemainPendingThroughThePlannedCalendarDayThenBecomeOverdue() {
    var state = state(List.of(task("1", "archived", PLANNED, PLANNED, null)), List.of());
    assertThat(timing(state, "2026-09-24", "1").timingStatus()).isEqualTo("pending");
    assertThat(timing(state, PLANNED, "1"))
        .isEqualTo(new TaskTiming(PLANNED, null, null, "pending", false));
    assertThat(timing(state, "2026-09-26", "1"))
        .isEqualTo(new TaskTiming(PLANNED, null, null, "overdue", true));
    assertThat(timing(state, "2026-09-27", "1").timingStatus()).isEqualTo("overdue");
    assertThat(timing(state, "2026-09-28", "1").timingStatus()).isEqualTo("very-overdue");
  }

  @Test
  void earliestCompletionEvidenceWinsOverCurrentStatusTimestampAndEventOrdering() {
    var stored =
        state(
            List.of(task("1", "todo", PLANNED, PLANNED, "2026-10-03T10:00:00Z")),
            List.of(
                event("1", "2026-10-02", "completed", "Second completion"),
                event("1", PLANNED, "completed", "First completion"),
                event("1", "2026-10-03", "reopened", "Reopened")));
    assertThat(timing(stored, "2026-10-05", "1"))
        .isEqualTo(new TaskTiming(PLANNED, PLANNED, 0, "on-time", false));
  }

  @Test
  void lateCompletionAndRecordedMissSurviveReopeningArchivingAndClockOrTimezoneChanges() {
    var evidence =
        List.of(
            event("1", "2026-09-26", "completed", "Completed late"),
            event("1", PLANNED, "missed-planned-day", "Missed"),
            event("1", "2026-10-02", "edited", "Changed text"));
    for (String status : List.of("todo", "in-progress", "done", "archived")) {
      var stored =
          state(
              List.of(task("1", status, PLANNED, PLANNED, null)),
              evidence,
              "Pacific/Honolulu",
              List.of());
      assertThat(timing(stored, "2026-09-24", "1"))
          .isEqualTo(new TaskTiming(PLANNED, "2026-09-26", 1, "late", true));
    }
    var recordedOnly =
        state(
            List.of(task("1", "archived", PLANNED, PLANNED, null)),
            List.of(event("1", PLANNED, "missed-planned-day", "Missed")));
    assertThat(timing(recordedOnly, "2026-09-24", "1").missedPlannedDay()).isTrue();
    assertThat(
            PlannerTaskTiming.missedByDate(
                PlannerTaskTiming.build(recordedOnly, LocalDate.parse("2026-09-24"))))
        .containsEntry(PLANNED, 1);
  }

  @Test
  void legacyFallbacksUseConfiguredTimezoneThenDoneDateAndOriginalDateFallback() {
    Task timestamp = task("1", "archived", PLANNED, PLANNED, "2026-09-25T20:00:00Z");
    assertThat(
            timing(
                state(List.of(timestamp), List.of(), "Asia/Kolkata", List.of()), "2026-10-01", "1"))
        .isEqualTo(new TaskTiming(PLANNED, "2026-09-26", 1, "late", true));
    Task legacy = task("2", "done", "2026-09-28", PLANNED, null);
    assertThat(timing(state(List.of(legacy), List.of()), "2026-10-01", "2"))
        .isEqualTo(new TaskTiming(PLANNED, "2026-09-28", 3, "very-late", true));
    Task noOriginal = task("3", "todo", "2026-10-02", null, null);
    assertThat(timing(state(List.of(noOriginal), List.of()), "2026-10-01", "3"))
        .isEqualTo(new TaskTiming("2026-10-02", null, null, "pending", false));
  }

  @Test
  void plannedPeriodIncludesOutOfPeriodCompletionWithoutInventingWorkOnThePlannedDay() {
    var stored =
        state(
            List.of(task("1", "archived", PLANNED, PLANNED, null)),
            List.of(
                event("1", PLANNED, "created", "Original plan"),
                event("1", "2026-09-28", "completed", "Verified result")));
    Report planned = report(stored, PLANNED, PLANNED, "2026-10-01");
    ReportTask plan = planned.daily().get(0).tasks().get(0);
    assertThat(plan.title()).isEqualTo("Original plan");
    assertThat(plan.planned()).isTrue();
    assertThat(plan.worked()).isFalse();
    assertThat(plan.completed()).isFalse();
    assertThat(plan.completedDate()).isEqualTo("2026-09-28");
    assertThat(plan.latenessDays()).isEqualTo(3);
    assertThat(plan.timingStatus()).isEqualTo("very-late");
    assertThat(planned.summary().missedPlannedDay()).isEqualTo(1);
    assertThat(planned.summary().completed()).isZero();
    Report actual = report(stored, "2026-09-28", "2026-09-28", "2026-10-01");
    assertThat(actual.summary().completed()).isEqualTo(1);
    assertThat(actual.summary().missedPlannedDay()).isZero();
    assertThat(actual.daily().get(0).tasks().get(0).title()).isEqualTo("Verified result");
    assertThat(actual.daily().get(0).tasks().get(0).missedPlannedDay()).isTrue();
  }

  @Test
  void missingCreationEventStillGetsAnImmutablePlannedAccountabilityRow() {
    var stored =
        state(
            List.of(task("1", "todo", PLANNED, PLANNED, null)),
            List.of(event("1", "2026-09-28", "completed", "Recorded completed title")));
    Report planned = report(stored, PLANNED, PLANNED, "2026-10-01");
    assertThat(planned.daily().get(0).tasks()).hasSize(1);
    assertThat(planned.daily().get(0).tasks().get(0).title()).isEqualTo("Recorded completed title");
    assertThat(planned.summary().planned()).isEqualTo(1);
    assertThat(planned.summary().missedPlannedDay()).isEqualTo(1);
  }

  @Test
  void legacyCompletionFallbackProducesSeparatePlanAndActualCompletionRows() {
    var stored = state(List.of(task("1", "done", "2026-09-28", PLANNED, null)), List.of());
    Report report = report(stored, PLANNED, "2026-09-28", "2026-10-01");
    assertThat(report.daily().get(0).tasks().get(0).completed()).isFalse();
    assertThat(report.daily().get(3).tasks().get(0).completed()).isTrue();
    assertThat(report.summary()).isEqualTo(new Summary(1, 1, 1, 0, 100, 1));
  }

  @Test
  void reopeningUsesItsActualEventDayWithoutRewritingOriginalCompletionOrCreatingAMiss() {
    var stored =
        state(
            List.of(task("1", "in-progress", PLANNED, PLANNED, null)),
            List.of(
                event("1", PLANNED, "completed", "Original completed title"),
                event("1", "2026-10-02", "reopened", "Reopened title"),
                event("1", "2026-10-02", "started", "New work title")));
    Report original = report(stored, PLANNED, PLANNED, "2026-10-05");
    assertThat(original.daily().get(0).tasks().get(0).title())
        .isEqualTo("Original completed title");
    assertThat(original.daily().get(0).tasks().get(0).completed()).isTrue();
    assertThat(original.summary().missedPlannedDay()).isZero();
    Report reopened = report(stored, "2026-10-02", "2026-10-02", "2026-10-05");
    assertThat(reopened.daily().get(0).tasks().get(0).title()).isEqualTo("New work title");
    assertThat(reopened.summary().worked()).isEqualTo(1);
    assertThat(reopened.summary().completed()).isZero();
    assertThat(reopened.summary().missedPlannedDay()).isZero();
  }

  @Test
  void sprintAndPeriodTotalsCountTheOriginalMissOnlyOnceWhileKeepingLegacyMovementEvidence() {
    Event moved =
        new Event(
            "m",
            "1",
            "Moved title",
            "",
            PLANNED,
            "moved",
            PLANNED,
            "2026-09-28",
            "2026-09-28T09:00:00Z",
            "todo",
            "rollover");
    var stored =
        state(
            List.of(task("1", "done", PLANNED, PLANNED, null)),
            List.of(
                event("1", PLANNED, "created", "Plan"),
                moved,
                event("1", "2026-09-28", "completed", "Completed")),
            "UTC",
            List.of(
                new Sprint("s1", "Plan sprint", "2026-09-21", PLANNED),
                new Sprint("s2", "Completion sprint", "2026-09-28", "2026-10-02")));
    Report report =
        PlannerReports.build(
            stored,
            LocalDate.parse(PLANNED),
            LocalDate.parse("2026-10-02"),
            "sprint",
            LocalDate.parse("2026-10-05"));
    assertThat(report.summary()).isEqualTo(new Summary(1, 1, 1, 1, 100, 1));
    assertThat(report.sprints().get(0).summary().missedPlannedDay()).isEqualTo(1);
    assertThat(report.sprints().get(1).summary().missedPlannedDay()).isZero();
    assertThat(report.daily().get(0).tasks().get(0).toDate()).isEqualTo("2026-09-28");
  }

  @Test
  void csvExportsDatesNumericLatenessTextStatusesAndPermanentDailyCountsIncludingEmptyDays() {
    var stored =
        state(
            List.of(task("1", "done", PLANNED, PLANNED, null)),
            List.of(event("1", "2026-09-23", "completed", "=HYPERLINK(\"evil\")")));
    String csv = PlannerReports.csv(report(stored, PLANNED, "2026-09-26", "2026-10-01"));
    String[] lines = csv.split("\r\n");
    assertThat(lines[0])
        .contains(
            "Planned date,First completed date,Lateness (calendar days),Timing status,Missed original planned day,Day missed planned count");
    assertThat(lines[1])
        .contains(
            "\"'=HYPERLINK(\"\"evil\"\")\"",
            "\"2026-09-25\",\"2026-09-23\",\"-2\",\"on-time\",\"No\",\"0\"");
    assertThat(lines[2].split(",", -1)).hasSize(21);
    assertThat(lines[2]).endsWith("\"0\"");
  }

  @Test
  void htmlIncludesAccessibleTimingLabelsColorLegendPersistentCountsAndSafeEscaping() {
    var stored =
        state(
            List.of(task("1", "done", PLANNED, PLANNED, null)),
            List.of(
                event("1", PLANNED, "created", "<script>bad()</script>"),
                event("1", "2026-09-26", "completed", "Completed")));
    String html = PlannerReports.html(report(stored, PLANNED, PLANNED, "2026-10-01"));
    assertThat(html)
        .contains(
            "&lt;script&gt;bad()&lt;/script&gt;",
            "default-src 'none'",
            "Green · on time or early",
            "Yellow · 1–2 calendar days",
            "Brown · 3+ calendar days",
            "class=\"timing timing-late\">late",
            "First completed: 2026-09-26",
            "Missed original planned day: <b>1</b>",
            "CSV does not support colors",
            "Save as PDF")
        .doesNotContain("<script>");
    assertThat(html.indexOf(".timing-on-time")).isLessThan(html.indexOf("</head>"));
  }
}
