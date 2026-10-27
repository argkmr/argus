package com.argus.planner.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.planner.domain.PlannerModels.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class DailyPlannerServiceTest {
  @TempDir Path directory;
  MutableClock clock;
  DailyPlannerService planner;
  AtomicJsonStore store;

  @BeforeEach
  void setup() {
    clock = new MutableClock("2026-09-25T10:00:00Z", "UTC"); // Friday
    store = new AtomicJsonStore(new ObjectMapper());
    planner = service(store);
  }

  private DailyPlannerService service(AtomicJsonStore json) {
    return new DailyPlannerService(
        new ArgusProperties(directory, directory, "test", ""), json, clock);
  }

  private Snapshot add(String title, String date) {
    return planner.addTasks(
        new AddTasks(planner.snapshot().revision(), List.of(new NewTask(title, "", date))));
  }

  private Snapshot edit(Task task, String title, String status, String date) {
    return planner.editTask(
        task.id(), new EditTask(planner.snapshot().revision(), title, null, status, date));
  }

  private Snapshot settings(String start, String end, String zone, boolean reminders) {
    return planner.updateSettings(
        new UpdateSettings(planner.snapshot().revision(), start, end, zone, reminders));
  }

  @Test
  void freshIndependentStateDoesNotCreateARepositoryOrAChatAndExposesImmutableCollections() {
    Snapshot snapshot = planner.snapshot();
    assertThat(snapshot.revision()).isZero();
    assertThat(snapshot.today()).isEqualTo("2026-09-25");
    assertThat(snapshot.nextWorkday()).isEqualTo("2026-09-28");
    assertThat(snapshot.settings()).isEqualTo(new Settings("09:00", "18:00", "UTC", false));
    assertThat(snapshot.tasks()).isEmpty();
    assertThat(Files.exists(directory.resolve("daily-planner.json"))).isFalse();
    assertThatThrownBy(() -> snapshot.tasks().add(null))
        .isInstanceOf(UnsupportedOperationException.class);
  }

  @Test
  void batchCreationIsAtomicAndDurable() {
    Snapshot snapshot =
        planner.addTasks(
            new AddTasks(
                0L,
                List.of(
                    new NewTask(" First task ", "Notes", "2026-09-25"),
                    new NewTask("Second task", null, "2026-09-28"))));
    assertThat(snapshot.revision()).isEqualTo(1);
    assertThat(snapshot.tasks())
        .extracting(Task::title)
        .containsExactly("First task", "Second task");
    assertThat(snapshot.events()).extracting(Event::kind).containsExactly("created", "created");
    assertThat(service(store).snapshot()).isEqualTo(snapshot);
    assertThatThrownBy(
            () ->
                planner.addTasks(
                    new AddTasks(
                        1L,
                        List.of(
                            new NewTask("Valid first", "", "2026-09-25"),
                            new NewTask("", "", "2026-09-28")))))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(planner.snapshot()).isEqualTo(snapshot);
    assertThat(service(store).snapshot()).isEqualTo(snapshot);
  }

  @Test
  void weekendsDaysOffPastDatesAndInvalidDatesAreRejected() {
    for (String date :
        List.of(
            "2026-09-26", "2026-09-27", "2026-09-24", "2026-02-30", "2026-9-25", "2035-01-01")) {
      assertThatThrownBy(() -> add("Task", date)).isInstanceOf(IllegalArgumentException.class);
    }
    planner.updateDayOff(new UpdateDayOff(0L, "2026-09-28", "Leave", true));
    assertThatThrownBy(() -> add("Task", "2026-09-28"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(planner.snapshot().tasks()).isEmpty();
  }

  @Test
  void unfinishedWorkStaysOnItsPlannedDayThroughEndWeekendAndLeave() {
    Task task = add("Ship fix", "2026-09-25").tasks().get(0);
    planner.updateDayOff(new UpdateDayOff(1L, "2026-09-28", "Leave", true));
    clock.set("2026-09-25T17:59:59Z");
    assertThat(planner.snapshot().tasks().get(0).date()).isEqualTo("2026-09-25");
    clock.set("2026-09-25T18:00:00Z");
    Snapshot afterEnd = planner.snapshot();
    assertThat(afterEnd.tasks().get(0)).isEqualTo(task);
    assertThat(afterEnd.events()).extracting(Event::kind).containsExactly("created");
    assertThat(afterEnd.missedByDate()).isEmpty();
    clock.set("2026-09-28T18:00:00Z");
    Snapshot missed = planner.snapshot();
    assertThat(missed.tasks().get(0)).isEqualTo(task);
    assertThat(missed.events())
        .extracting(Event::kind)
        .containsExactly("created", "missed-planned-day");
    assertThat(missed.missedByDate()).containsEntry("2026-09-25", 1);
    assertThat(planner.snapshot()).isEqualTo(missed);
    assertThat(service(store).snapshot()).isEqualTo(missed);
  }

  @Test
  void reopeningAfterMonthsRecordsOneMissWithoutMovingOrDuplicatingTheTask() {
    add("Carry this", "2026-09-25");
    clock.set("2026-12-01T10:00:00Z");
    Snapshot current = service(store).snapshot();
    assertThat(current.tasks()).hasSize(1);
    assertThat(current.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(current.events())
        .extracting(Event::kind)
        .containsExactly("created", "missed-planned-day");
    assertThat(current.missedByDate()).containsExactlyEntriesOf(java.util.Map.of("2026-09-25", 1));
    assertThat(service(store).snapshot().events()).hasSameSizeAs(current.events());
  }

  @Test
  void completedWorkAndCompletionDaySurviveLaterTextEditsAndOffDays() {
    Task task = add("Original title", "2026-09-25").tasks().get(0);
    Snapshot completed = edit(task, null, "done", null);
    String completion = completed.tasks().get(0).completedAt();
    clock.set("2026-09-28T10:00:00Z");
    Snapshot renamed = edit(task, "New display title", null, null);
    assertThat(renamed.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(renamed.tasks().get(0).completedAt()).isEqualTo(completion);
    Report report = planner.report("2026-09-25", "2026-09-28", "day");
    assertThat(report.daily().get(0).tasks().get(0).title()).isEqualTo("Original title");
    assertThat(report.daily().get(0).tasks().get(0).completed()).isTrue();
    assertThat(report.daily().get(3).tasks()).isEmpty();
    assertThatThrownBy(() -> edit(task, null, null, "2026-09-29"))
        .isInstanceOf(IllegalArgumentException.class);
    Snapshot reopened = edit(task, null, "todo", null);
    assertThat(reopened.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(reopened.tasks().get(0).completedAt()).isNull();
    assertThat(
            planner
                .report("2026-09-25", "2026-09-28", "day")
                .daily()
                .get(0)
                .tasks()
                .get(0)
                .completed())
        .isTrue();
  }

  @Test
  void dayOffNeverMovesScheduledOrCompletedWorkAndUnmarkingDoesNotChangeHistory() {
    Task done = add("Done", "2026-09-25").tasks().get(0);
    edit(done, null, "done", null);
    Task pending = add("Future", "2026-09-28").tasks().get(1);
    Snapshot off =
        planner.updateDayOff(
            new UpdateDayOff(planner.snapshot().revision(), "2026-09-28", "Holiday", true));
    assertThat(off.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(off.tasks().get(1).date()).isEqualTo("2026-09-28");
    assertThat(off.events())
        .extracting(Event::kind)
        .containsExactly("created", "completed", "created");
    Snapshot back = planner.updateDayOff(new UpdateDayOff(off.revision(), "2026-09-28", "", false));
    assertThat(back.tasks().get(1).id()).isEqualTo(pending.id());
    assertThat(back.tasks().get(1).date()).isEqualTo("2026-09-28");
    assertThat(back.events()).isEqualTo(off.events());
  }

  @Test
  void archivesAreRetainedAndNeverAutomaticallyRolledForward() {
    Task future = add("Next week", "2026-09-28").tasks().get(0);
    Snapshot archived = edit(future, null, "archived", null);
    assertThat(archived.tasks()).hasSize(1);
    assertThat(archived.tasks().get(0).status()).isEqualTo("archived");
    clock.set("2026-10-01T10:00:00Z");
    assertThat(planner.snapshot().tasks().get(0).date()).isEqualTo("2026-09-28");
  }

  @Test
  void staleOrMissingRevisionsCannotOverwriteStateIncludingDurableMissEvidence() {
    add("Task", "2026-09-25");
    assertThatThrownBy(
            () ->
                planner.addTasks(
                    new AddTasks(null, List.of(new NewTask("Other", "", "2026-09-25")))))
        .isInstanceOf(ConflictException.class);
    clock.set("2026-09-28T10:00:00Z");
    assertThatThrownBy(
            () ->
                planner.addTasks(new AddTasks(1L, List.of(new NewTask("Other", "", "2026-09-28")))))
        .isInstanceOf(ConflictException.class);
    assertThat(planner.snapshot().tasks()).hasSize(1);
    assertThat(planner.snapshot().tasks().get(0).date()).isEqualTo("2026-09-25");
  }

  @Test
  void concurrentSameRevisionOnlyOneMutationCommits() throws Exception {
    var start = new CountDownLatch(1);
    var successes = new AtomicInteger();
    var conflicts = new AtomicInteger();
    var executor = Executors.newFixedThreadPool(2);
    try {
      var action =
          (java.util.concurrent.Callable<Void>)
              () -> {
                start.await();
                try {
                  planner.addTasks(
                      new AddTasks(0L, List.of(new NewTask("Task", "", "2026-09-25"))));
                  successes.incrementAndGet();
                } catch (ConflictException expected) {
                  conflicts.incrementAndGet();
                }
                return null;
              };
      var first = executor.submit(action);
      var second = executor.submit(action);
      start.countDown();
      first.get();
      second.get();
      assertThat(successes.get()).isEqualTo(1);
      assertThat(conflicts.get()).isEqualTo(1);
      assertThat(planner.snapshot().tasks()).hasSize(1);
    } finally {
      executor.shutdownNow();
    }
  }

  @Test
  void failedDiskWritesLeaveMemoryAndDurableStateUnchanged() {
    var failing =
        new AtomicJsonStore(new ObjectMapper()) {
          @Override
          public void write(Path path, Object value) {
            throw new IllegalStateException("Disk is full");
          }
        };
    planner = service(failing);
    Snapshot before = planner.snapshot();
    assertThatThrownBy(() -> add("Cannot save", "2026-09-25"))
        .isInstanceOf(IllegalStateException.class);
    assertThat(planner.snapshot()).isEqualTo(before);
    assertThat(Files.exists(directory.resolve("daily-planner.json"))).isFalse();
  }

  @Test
  void validWorkdayAndTimezoneSettingsAreRequired() {
    for (var range :
        List.of(
            List.of("17:00", "09:00"),
            List.of("09:00", "09:30"),
            List.of("25:00", "26:00"),
            List.of("9:00", "18:00"))) {
      assertThatThrownBy(() -> settings(range.get(0), range.get(1), "UTC", true))
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThatThrownBy(() -> settings("09:00", "18:00", "No/Such_Place", true))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(planner.snapshot().revision()).isZero();
    assertThat(settings("08:30", "17:30", "Asia/Kolkata", true).settings().timeZone())
        .isEqualTo("Asia/Kolkata");
  }

  @Test
  void morningAndFinalHourRemindersRespectTimezoneAndAreDurablyOncePerDay() {
    clock.set("2026-09-25T03:29:59Z");
    settings("09:00", "18:00", "Asia/Kolkata", true);
    assertThat(planner.reminders().notifications()).isEmpty();
    clock.set("2026-09-25T03:30:00Z");
    Notification morning = planner.reminders().notifications().get(0);
    assertThat(morning.id()).isEqualTo("2026-09-25:start");
    long revision = planner.snapshot().revision();
    assertThat(planner.acknowledge(morning.id()).notifications()).isEmpty();
    assertThat(planner.snapshot().revision()).isEqualTo(revision);
    assertThat(service(store).reminders().notifications()).isEmpty();
    assertThat(planner.acknowledge(morning.id()).notifications()).isEmpty();
    clock.set("2026-09-25T11:30:00Z");
    assertThat(planner.reminders().notifications())
        .extracting(Notification::kind)
        .containsExactly("end");
    clock.set("2026-09-25T12:30:00Z");
    assertThat(planner.reminders().notifications()).isEmpty();
  }

  @Test
  void missedMorningProducesOnlyFinalHourReminderAndNoMissedDayStorm() {
    settings("09:00", "18:00", "UTC", true);
    clock.set("2026-09-25T17:30:00Z");
    assertThat(planner.reminders().notifications())
        .extracting(Notification::id)
        .containsExactly("2026-09-25:end");
    clock.set("2026-09-26T10:00:00Z");
    assertThat(planner.reminders().notifications()).isEmpty();
    clock.set("2026-09-28T10:00:00Z");
    planner.updateDayOff(
        new UpdateDayOff(planner.snapshot().revision(), "2026-09-28", "Leave", true));
    assertThat(planner.reminders().notifications()).isEmpty();
    clock.set("2026-09-29T10:00:00Z");
    assertThat(planner.reminders().notifications())
        .extracting(Notification::id)
        .containsExactly("2026-09-29:start");
    assertThatThrownBy(() -> planner.acknowledge("2026-09-25:end"))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void remindersFollowDstAndDisabledMeansNoAlerts() {
    settings("09:00", "18:00", "America/New_York", true);
    clock.set("2026-11-02T13:59:59Z");
    assertThat(planner.reminders().notifications()).isEmpty();
    clock.set("2026-11-02T14:00:00Z");
    assertThat(planner.reminders().notifications())
        .extracting(Notification::kind)
        .containsExactly("start");
    settings("09:00", "18:00", "America/New_York", false);
    assertThat(planner.reminders().notifications()).isEmpty();
  }

  @Test
  void finalHourReminderReportsActualRoundedUpMinutesWhenTheLaptopWakesLate() {
    settings("09:00", "18:00", "UTC", true);
    clock.set("2026-09-25T17:00:00Z");
    Notification onTime = planner.reminders().notifications().get(0);
    assertThat(onTime.title()).isEqualTo("60 minutes left in your workday");
    assertThat(onTime.id()).isEqualTo("2026-09-25:end");
    assertThat(onTime.body()).startsWith("Close completed tasks");
    clock.set("2026-09-25T17:45:00Z");
    assertThat(planner.reminders().notifications().get(0).title())
        .isEqualTo("15 minutes left in your workday");
    clock.set("2026-09-25T17:44:59.999999999Z");
    assertThat(planner.reminders().notifications().get(0).title())
        .isEqualTo("16 minutes left in your workday");
    clock.set("2026-09-25T17:59:59.999999999Z");
    assertThat(planner.reminders().notifications().get(0).title())
        .isEqualTo("1 minute left in your workday");
    clock.set("2026-09-25T18:00:00Z");
    assertThat(planner.reminders().notifications()).isEmpty();
  }

  @Test
  void oneHourWorkdayCombinesPlanningAndClosingInOneDurablyAcknowledgedReminder() {
    clock.set("2026-09-25T08:59:59Z");
    settings("09:00", "10:00", "UTC", true);
    assertThat(planner.reminders().notifications()).isEmpty();
    clock.set("2026-09-25T09:00:00Z");
    List<Notification> due = planner.reminders().notifications();
    assertThat(due).hasSize(1);
    assertThat(due.get(0).id()).isEqualTo("2026-09-25:end");
    assertThat(due.get(0).kind()).isEqualTo("end");
    assertThat(due.get(0).title()).isEqualTo("60 minutes left in your workday");
    assertThat(due.get(0).body())
        .contains(
            "Add or review today's tasks", "close completed tasks", "stay on their planned day")
        .doesNotContain("move unfinished work");
    clock.set("2026-09-25T09:45:00Z");
    assertThat(planner.reminders().notifications().get(0).title())
        .isEqualTo("15 minutes left in your workday");
    planner.acknowledge(due.get(0).id());
    assertThat(planner.reminders().notifications()).isEmpty();
    assertThat(service(store).reminders().notifications()).isEmpty();
    clock.set("2026-09-25T10:00:00Z");
    assertThat(planner.reminders().notifications()).isEmpty();
  }

  @Test
  void sprintsRequireNonoverlappingValidWeekdayRanges() {
    Snapshot first = planner.addSprint(new AddSprint(0L, "Sprint 1", "2026-09-21", "2026-10-02"));
    assertThatThrownBy(
            () -> planner.addSprint(new AddSprint(1L, "Overlap", "2026-10-02", "2026-10-09")))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(
            () -> planner.addSprint(new AddSprint(1L, "Weekend", "2026-10-03", "2026-10-09")))
        .isInstanceOf(IllegalArgumentException.class);
    planner.addSprint(new AddSprint(1L, "Sprint 2", "2026-10-05", "2026-10-16"));
    Snapshot removed = planner.deleteSprint(first.sprints().get(0).id(), 2L);
    assertThat(removed.sprints()).extracting(Sprint::name).containsExactly("Sprint 2");
  }

  @Test
  void reportsPreserveFixedPlanAndActualWorkDaysWithoutCountingExtraUniqueTasks() {
    Task task = add("Investigate", "2026-09-25").tasks().get(0);
    edit(task, null, "in-progress", null);
    clock.set("2026-09-28T10:00:00Z");
    planner.snapshot();
    edit(task, "Fix verified", null, null);
    edit(task, null, "done", null);
    Report report = planner.report("2026-09-25", "2026-09-28", "day");
    assertThat(report.summary()).isEqualTo(new Summary(1, 1, 1, 0, 100, 1));
    ReportTask friday = report.daily().get(0).tasks().get(0);
    assertThat(friday.title()).isEqualTo("Investigate");
    assertThat(friday.worked()).isTrue();
    assertThat(friday.moved()).isFalse();
    assertThat(friday.completed()).isFalse();
    assertThat(friday.toDate()).isNull();
    assertThat(friday.plannedDate()).isEqualTo("2026-09-25");
    assertThat(friday.completedDate()).isEqualTo("2026-09-28");
    assertThat(friday.latenessDays()).isEqualTo(3);
    assertThat(friday.timingStatus()).isEqualTo("very-late");
    assertThat(friday.missedPlannedDay()).isTrue();
    ReportTask monday = report.daily().get(3).tasks().get(0);
    assertThat(monday.title()).isEqualTo("Fix verified");
    assertThat(monday.completed()).isTrue();
    assertThat(monday.fromDate()).isNull();
    assertThat(report.daily().get(1).dayOff()).isTrue();
    assertThat(report.daily().get(1).tasks()).isEmpty();
  }

  @Test
  void reportsSupportSixMonthsAndSprintGroupingIncludingUnassignedDates() {
    add("Work", "2026-09-25");
    planner.addSprint(new AddSprint(1L, "Delivery sprint", "2026-09-21", "2026-10-02"));
    Report report = planner.report("2026-07-01", "2026-12-31", "sprint");
    assertThat(report.daily()).hasSize(184);
    assertThat(report.sprints())
        .extracting(ReportSprint::name)
        .containsExactly("Delivery sprint", "Outside sprints");
    assertThat(report.sprints().get(0).summary().planned()).isEqualTo(1);
    assertThatThrownBy(() -> planner.report("2026-12-31", "2026-07-01", "day"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> planner.report("2024-01-01", "2026-01-01", "day"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> planner.report("2026-09-01", "2026-09-30", "week"))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void exportEscapesHtmlAndNeutralizesSpreadsheetFormulaInjection() {
    planner.addTasks(
        new AddTasks(
            0L,
            List.of(
                new NewTask(
                    "=HYPERLINK(\"evil\")",
                    "  +formula\n<script>alert(1)</script>",
                    "2026-09-25"))));
    Report report = planner.report("2026-09-25", "2026-09-25", "day");
    String csv = PlannerReports.csv(report);
    assertThat(csv).contains("\"'=HYPERLINK(\"\"evil\"\")\"");
    assertThat(csv).contains("\"'+formula"); // notes are normalized when entered
    String html = PlannerReports.html(report);
    assertThat(html).contains("&lt;script&gt;alert(1)&lt;/script&gt;").doesNotContain("<script>");
    assertThat(html).contains("default-src 'none'", "Save as PDF");
  }

  @Test
  void carriedInProgressWorkIsNotAssumedWorkedButCanBeExplicitlyMarkedOncePerDay() {
    Task task = add("Continue this", "2026-09-25").tasks().get(0);
    edit(task, null, "in-progress", null);
    clock.set("2026-09-28T10:00:00Z");
    planner.snapshot();
    assertThat(planner.report("2026-09-28", "2026-09-28", "day").summary().worked()).isZero();
    Snapshot marked = edit(task, null, "in-progress", null);
    assertThat(planner.report("2026-09-28", "2026-09-28", "day").summary().worked()).isEqualTo(1);
    assertThat(marked.events().stream().filter(event -> event.kind().equals("started"))).hasSize(2);
    Snapshot twice = edit(task, null, "in-progress", null);
    assertThat(twice.events()).isEqualTo(marked.events());
  }

  @Test
  void archivingRenamedCompletedTaskDoesNotRewriteHistoricalCompletion() {
    Task task = add("Original completed task", "2026-09-25").tasks().get(0);
    Snapshot completed = edit(task, null, "done", null);
    clock.set("2026-09-28T10:00:00Z");
    edit(task, "New display title", null, null);
    Snapshot archived = edit(task, null, "archived", null);
    assertThat(archived.tasks().get(0).completedAt())
        .isEqualTo(completed.tasks().get(0).completedAt());
    ReportTask evidence =
        planner.report("2026-09-25", "2026-09-25", "day").daily().get(0).tasks().get(0);
    assertThat(evidence.completed()).isTrue();
    assertThat(evidence.title()).isEqualTo("Original completed task");
  }

  @Test
  void corruptPersistedStateIsNotSilentlyReplaced() {
    store.write(directory.resolve("daily-planner.json"), java.util.Map.of("revision", 99));
    assertThatThrownBy(() -> planner.snapshot()).isInstanceOf(IllegalStateException.class);
    assertThat(store.read(directory.resolve("daily-planner.json"), java.util.Map.class))
        .containsEntry("revision", 99);
  }

  @Test
  void changingEndTimeAfterFinalReminderCannotProduceBelatedMorningNotification() {
    settings("09:00", "18:00", "UTC", true);
    clock.set("2026-09-25T17:00:00Z");
    planner.acknowledge("2026-09-25:end");
    settings("09:00", "22:00", "UTC", true);
    assertThat(planner.reminders().notifications()).isEmpty();
    clock.set("2026-09-25T21:00:00Z");
    assertThat(planner.reminders().notifications()).isEmpty();
  }

  @Test
  void afterEndNewTasksRequireNextWorkingDay() {
    clock.set("2026-09-25T18:01:00Z");
    assertThatThrownBy(() -> add("Too late", "2026-09-25"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("workday has ended");
    assertThat(add("Monday plan", planner.snapshot().nextWorkday()).tasks()).hasSize(1);
  }

  @Test
  void archivedTaskMustBeReopenedBeforeCompletionOnANewDay() {
    Task task = add("Archived plan", "2026-09-25").tasks().get(0);
    edit(task, null, "archived", null);
    clock.set("2026-09-28T10:00:00Z");
    assertThatThrownBy(() -> edit(task, null, "done", null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("Reopen");
    edit(task, null, "todo", null);
    Snapshot completed = edit(task, null, "done", null);
    assertThat(completed.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(planner.report("2026-09-28", "2026-09-28", "day").summary().completed())
        .isEqualTo(1);
  }

  @Test
  void reopeningCompletedTaskDirectlyIntoProgressRecordsNewDaysWork() {
    Task task = add("Original", "2026-09-25").tasks().get(0);
    edit(task, null, "done", null);
    clock.set("2026-09-28T10:00:00Z");
    edit(task, null, "in-progress", null);
    assertThat(planner.report("2026-09-28", "2026-09-28", "day").summary().worked()).isEqualTo(1);
    assertThat(planner.report("2026-09-25", "2026-09-25", "day").summary().completed())
        .isEqualTo(1);
  }

  private static final class MutableClock extends Clock {
    private Instant current;
    private final ZoneId zone;

    MutableClock(String at, String zone) {
      current = Instant.parse(at);
      this.zone = ZoneId.of(zone);
    }

    void set(String at) {
      current = Instant.parse(at);
    }

    @Override
    public ZoneId getZone() {
      return zone;
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
