package com.argus.planner.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.planner.domain.PlannerModels.*;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class DailyPlannerManualWorkTest {
  @TempDir Path directory;
  private MutableClock clock;
  private AtomicJsonStore store;
  private DailyPlannerService planner;

  @BeforeEach
  void setup() {
    clock = new MutableClock();
    store = new AtomicJsonStore(new ObjectMapper());
    planner = service();
  }

  private DailyPlannerService service() {
    return new DailyPlannerService(
        new ArgusProperties(directory, directory, "test", ""), store, clock);
  }

  private Task add(String title, String date) {
    Snapshot snapshot =
        planner.addTasks(
            new AddTasks(planner.snapshot().revision(), List.of(new NewTask(title, "", date))));
    return snapshot.tasks().get(snapshot.tasks().size() - 1);
  }

  private Snapshot edit(Task task, String title, String status, String date) {
    return planner.editTask(
        task.id(), new EditTask(planner.snapshot().revision(), title, null, status, date));
  }

  private Task task(Snapshot snapshot, String id) {
    return snapshot.tasks().stream().filter(task -> task.id().equals(id)).findFirst().orElseThrow();
  }

  private Report report(String date) {
    return planner.report(date, date, "day");
  }

  @Test
  void nextWeekTaskCanCompleteEarlyWithoutMovingOrLosingIdentityLinksOrEarlierEvidence() {
    Task original = add("Ship the fix", "2026-10-05");
    Task related = add("Release follow-up", "2026-10-06");
    planner.addLink(
        new AddLink(planner.snapshot().revision(), original.id(), related.id(), "related"));
    Snapshot before = planner.snapshot();

    Snapshot completed = edit(original, null, "done", null);
    Task actual = task(completed, original.id());
    assertThat(actual.date()).isEqualTo("2026-10-05");
    assertThat(actual.status()).isEqualTo("done");
    assertThat(actual.completedAt()).isEqualTo("2026-09-25T10:00:00Z");
    assertThat(actual.id()).isEqualTo(original.id());
    assertThat(actual.key()).isEqualTo(original.key());
    assertThat(actual.originalDate()).isEqualTo(original.originalDate());
    assertThat(completed.links()).isEqualTo(before.links());
    assertThat(completed.events().subList(0, before.events().size())).isEqualTo(before.events());
    assertThat(completed.events()).noneMatch(event -> event.kind().equals("moved"));
    assertThat(completed.events().get(completed.events().size() - 1))
        .satisfies(
            event -> {
              assertThat(event.kind()).isEqualTo("completed");
              assertThat(event.date()).isEqualTo("2026-09-25");
            });
    assertThat(report("2026-09-25").summary().completed()).isEqualTo(1);
    assertThat(report("2026-10-05").summary().completed()).isZero();
    assertThat(report("2026-10-05").daily().get(0).tasks().get(0).moved()).isFalse();
    assertThat(completed.taskTimings().get(original.id()))
        .isEqualTo(new TaskTiming("2026-10-05", "2026-09-25", -10, "on-time", false));
    assertThat(service().snapshot()).isEqualTo(completed);
  }

  @Test
  void startingFutureTaskRecordsActualWorkWithoutMovingItsPlanOrDuplicatingDailyEvidence() {
    Task future = add("Next week's plan", "2026-10-05");
    Snapshot started = edit(future, null, "in-progress", null);
    assertThat(started.tasks().get(0).date()).isEqualTo("2026-10-05");
    assertThat(started.tasks().get(0).completedAt()).isNull();
    assertThat(report("2026-09-25").summary().worked()).isEqualTo(1);
    assertThat(report("2026-10-05").summary().worked()).isZero();
    assertThat(edit(future, null, "in-progress", null).events()).isEqualTo(started.events());

    clock.current = Instant.parse("2026-09-26T11:30:00Z");
    Snapshot nextDay = edit(future, null, "in-progress", null);
    assertThat(nextDay.tasks().get(0).date()).isEqualTo("2026-10-05");
    assertThat(nextDay.events().stream().filter(event -> event.kind().equals("started")))
        .hasSize(2);
    assertThat(report("2026-09-26").summary().worked()).isEqualTo(1);
    assertThat(report("2026-09-26").daily().get(0).dayOff()).isTrue();
    assertThat(planner.reminders().notifications()).isEmpty();
    assertThat(service().snapshot()).isEqualTo(nextDay);
  }

  @Test
  void workAndCompletionAfterEndTimeKeepThePlanAndCountAsOnTimeOnTheSameCalendarDay() {
    Task original = add("Finishing slightly late", "2026-09-25");
    clock.current = Instant.parse("2026-09-25T18:05:00Z");
    Snapshot afterEnd = planner.snapshot();
    assertThat(afterEnd.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(afterEnd.missedByDate()).isEmpty();
    Snapshot started = edit(original, null, "in-progress", null);
    assertThat(started.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(report("2026-09-25").summary().worked()).isEqualTo(1);
    Snapshot completed = edit(original, null, "done", null);
    assertThat(completed.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(completed.tasks().get(0).completedAt()).isEqualTo("2026-09-25T18:05:00Z");
    assertThat(completed.taskTimings().get(original.id()))
        .isEqualTo(new TaskTiming("2026-09-25", "2026-09-25", 0, "on-time", false));
    assertThat(report("2026-09-25").summary().completed()).isEqualTo(1);
    assertThat(report("2026-09-28").summary().completed()).isZero();
    assertThat(planner.snapshot()).isEqualTo(completed);
    assertThat(service().snapshot()).isEqualTo(completed);
    assertThatThrownBy(() -> add("New late task", "2026-09-25"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("workday has ended");
  }

  @Test
  void explicitCompletionOnWeekendOrLeaveDoesNotChangeSchedulingOrNotificationRules() {
    Task weekend = add("Optional weekend finish", "2026-10-05");
    Task leave = add("Optional leave finish", "2026-10-06");
    planner.updateSettings(
        new UpdateSettings(planner.snapshot().revision(), "09:00", "18:00", "UTC", true));
    planner.updateDayOff(
        new UpdateDayOff(planner.snapshot().revision(), "2026-09-28", "Leave", true));
    clock.current = Instant.parse("2026-09-26T11:00:00Z");
    assertThat(task(edit(weekend, null, "done", null), weekend.id()).date())
        .isEqualTo("2026-10-05");
    assertThat(report("2026-09-26").summary().completed()).isEqualTo(1);
    assertThat(planner.reminders().notifications()).isEmpty();
    assertThatThrownBy(() -> add("Cannot schedule weekend", "2026-09-26"))
        .isInstanceOf(IllegalArgumentException.class);

    clock.current = Instant.parse("2026-09-28T11:00:00Z");
    assertThat(task(edit(leave, null, "done", null), leave.id()).date()).isEqualTo("2026-10-06");
    assertThat(report("2026-09-28").summary().completed()).isEqualTo(1);
    assertThat(report("2026-09-28").daily().get(0).label()).isEqualTo("Leave");
    assertThat(planner.reminders().notifications()).isEmpty();
    assertThatThrownBy(() -> add("Cannot schedule leave", "2026-09-28"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(service().snapshot()).isEqualTo(planner.snapshot());
  }

  @Test
  void repeatedCompletionAndLaterTextEditsKeepActualCompletionDayAndTimestamp() {
    Task original = add("Original description", "2026-10-05");
    Snapshot first = edit(original, null, "done", null);
    clock.current = Instant.parse("2026-09-28T12:00:00Z");
    Snapshot repeated = edit(original, null, "done", null);
    assertThat(repeated.events()).isEqualTo(first.events());
    assertThat(repeated.tasks().get(0).date()).isEqualTo("2026-10-05");
    assertThat(repeated.tasks().get(0).completedAt()).isEqualTo(first.tasks().get(0).completedAt());
    edit(original, "New display description", null, null);
    ReportTask recorded = report("2026-09-25").daily().get(0).tasks().get(0);
    assertThat(recorded.title()).isEqualTo("Original description");
    assertThat(recorded.completed()).isTrue();
    assertThat(report("2026-09-28").summary().completed()).isZero();
  }

  @Test
  void explicitCompletionUsesConfiguredLocalDayEvenWhenUtcDayAndSubmittedScheduleDiffer() {
    Task original = add("Future plan", "2026-10-05");
    planner.updateSettings(
        new UpdateSettings(planner.snapshot().revision(), "09:00", "18:00", "Asia/Kolkata", false));
    clock.current = Instant.parse("2026-09-25T20:05:00Z");
    assertThatThrownBy(() -> edit(original, null, "done", "2026-10-06"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("original planned day");
    Snapshot completed = edit(original, null, "done", null);
    assertThat(completed.today()).isEqualTo("2026-09-26");
    assertThat(completed.tasks().get(0).date()).isEqualTo("2026-10-05");
    assertThat(completed.tasks().get(0).completedAt()).isEqualTo("2026-09-25T20:05:00Z");
    assertThat(report("2026-09-25").summary().completed()).isZero();
    assertThat(report("2026-09-26").summary().completed()).isEqualTo(1);
    assertThat(report("2026-10-05").summary().completed()).isZero();
    assertThat(report("2026-10-06").summary().completed()).isZero();
    assertThat(service().snapshot()).isEqualTo(completed);
  }

  @Test
  void archivedTaskRestoresOnOriginalDayWithIdentityLinksAndHistoricalCompletionIntact() {
    Task original = add("Previously completed", "2026-09-25");
    Task related = add("Linked follow-up", "2026-10-06");
    planner.addLink(
        new AddLink(planner.snapshot().revision(), original.id(), related.id(), "related"));
    edit(original, null, "done", null);
    edit(original, null, "archived", null);
    planner.updateDayOff(
        new UpdateDayOff(planner.snapshot().revision(), "2026-09-28", "Leave", true));
    clock.current = Instant.parse("2026-09-26T10:00:00Z");
    Snapshot archived = planner.snapshot();
    assertThat(task(archived, original.id()).date()).isEqualTo("2026-09-25");
    assertThatThrownBy(() -> edit(original, null, "done", null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("Reopen");
    Snapshot restored = edit(original, null, "todo", null);
    Task actual = task(restored, original.id());
    assertThat(actual.status()).isEqualTo("todo");
    assertThat(actual.date()).isEqualTo("2026-09-25");
    assertThat(actual.completedAt()).isNull();
    assertThat(actual.id()).isEqualTo(original.id());
    assertThat(actual.key()).isEqualTo(original.key());
    assertThat(actual.originalDate()).isEqualTo(original.originalDate());
    assertThat(restored.links()).isEqualTo(archived.links());
    assertThat(restored.events().subList(0, archived.events().size())).isEqualTo(archived.events());
    assertThat(report("2026-09-25").summary().completed()).isEqualTo(1);
    assertThat(report("2026-09-29").summary().completed()).isZero();
    assertThat(service().snapshot()).isEqualTo(restored);
  }

  private static final class MutableClock extends Clock {
    Instant current = Instant.parse("2026-09-25T10:00:00Z");

    @Override
    public ZoneId getZone() {
      return ZoneId.of("UTC");
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return Clock.fixed(current, zone);
    }

    @Override
    public Instant instant() {
      return current;
    }
  }
}
