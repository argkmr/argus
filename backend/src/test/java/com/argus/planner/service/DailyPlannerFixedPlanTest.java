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
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class DailyPlannerFixedPlanTest {
  @TempDir Path directory;
  private MutableClock clock;
  private AtomicJsonStore store;
  private DailyPlannerService planner;

  @BeforeEach
  void setup() {
    clock = new MutableClock();
    store = new AtomicJsonStore(new ObjectMapper());
    planner = service(store);
  }

  private DailyPlannerService service(AtomicJsonStore json) {
    return new DailyPlannerService(
        new ArgusProperties(directory, directory, "test", ""), json, clock);
  }

  private Path file() {
    return directory.resolve("daily-planner.json");
  }

  private Task add(String title, String day) {
    Snapshot state =
        planner.addTasks(
            new AddTasks(planner.snapshot().revision(), List.of(new NewTask(title, "Notes", day))));
    return state.tasks().get(state.tasks().size() - 1);
  }

  private Snapshot status(Task task, String status) {
    return planner.editTask(
        task.id(), new EditTask(planner.snapshot().revision(), null, null, status, null));
  }

  private Task legacyTask(String id, String status, String day, String completedAt, String key) {
    return new Task(
        id,
        "Legacy " + id,
        "Original notes",
        status,
        day,
        "2026-09-25",
        "2026-09-25T10:00:00Z",
        "2026-09-29T12:00:00Z",
        completedAt,
        key);
  }

  private Event legacyEvent(String id, Task task, String kind, String day, String from, String to) {
    return new Event(
        id,
        task.id(),
        task.title(),
        task.notes(),
        day,
        kind,
        from,
        to,
        "2026-09-29T12:00:00Z",
        task.status(),
        "legacy");
  }

  private Stored legacy(List<Task> tasks, List<Event> events, List<TaskLink> links) {
    return new Stored(
        7,
        new Settings("09:00", "18:00", "UTC", false),
        tasks,
        events,
        List.of(new DayOff("2026-09-28", "Leave")),
        List.of(new Sprint("sprint", "Delivery", "2026-09-21", "2026-10-02")),
        Set.of("2026-09-25:start"),
        10L,
        links);
  }

  @Test
  void migrationPinsAllStatusesAtomicallyWithoutRewritingIdentityLinksTimestampsOrOldEvidence()
      throws Exception {
    Task pending = legacyTask("a", "todo", "2026-09-30", null, "TASK-7");
    Task completed = legacyTask("b", "done", "2026-09-29", "2026-09-29T12:00:00Z", "TASK-8");
    Task archived = legacyTask("c", "archived", "2026-09-28", null, "TASK-9");
    List<Event> events =
        List.of(
            legacyEvent("created-a", pending, "created", "2026-09-25", null, "2026-09-25"),
            legacyEvent("moved-a", pending, "moved", "2026-09-25", "2026-09-25", "2026-09-30"),
            legacyEvent(
                "completed-b", completed, "completed", "2026-09-29", "2026-09-25", "2026-09-29"));
    TaskLink link = new TaskLink("link", "a", "b", "related", "2026-09-25T10:00:00Z");
    Stored before = legacy(List.of(pending, completed, archived), events, List.of(link));
    store.write(file(), before);
    clock.at("2026-09-30T10:00:00Z");

    Snapshot migrated = planner.snapshot();
    assertThat(migrated.tasks()).hasSize(3);
    for (int i = 0; i < before.tasks().size(); i++) {
      Task original = before.tasks().get(i);
      assertThat(migrated.tasks().get(i))
          .isEqualTo(
              new Task(
                  original.id(),
                  original.title(),
                  original.notes(),
                  original.status(),
                  original.originalDate(),
                  original.originalDate(),
                  original.createdAt(),
                  original.updatedAt(),
                  original.completedAt(),
                  original.key()));
    }
    assertThat(migrated.links()).containsExactly(link);
    assertThat(migrated.settings()).isEqualTo(before.settings());
    assertThat(migrated.daysOff()).isEqualTo(before.daysOff());
    assertThat(migrated.sprints()).isEqualTo(before.sprints());
    assertThat(migrated.events().subList(0, events.size())).isEqualTo(events);
    assertThat(migrated.events().stream().filter(event -> event.kind().equals("schedule-pinned")))
        .hasSize(3);
    assertThat(
            migrated.events().stream().filter(event -> event.kind().equals("missed-planned-day")))
        .hasSize(3);
    assertThat(migrated.taskTimings().get(completed.id()))
        .isEqualTo(new TaskTiming("2026-09-25", "2026-09-29", 4, "very-late", true));
    Stored durable = store.read(file(), Stored.class);
    assertThat(durable.nextTaskNumber()).isEqualTo(10L);
    assertThat(durable.deliveredReminders()).isEqualTo(before.deliveredReminders());
    String bytes = Files.readString(file());
    assertThat(planner.snapshot()).isEqualTo(migrated);
    assertThat(service(store).snapshot()).isEqualTo(migrated);
    assertThat(Files.readString(file())).isEqualTo(bytes);
  }

  @Test
  void legacyCompletionEncodedOnlyInMovedDateIsPreservedBeforePinning() {
    Task completed = legacyTask("old", "done", "2026-09-29", null, "TASK-7");
    store.write(file(), legacy(List.of(completed), List.of(), List.of()));
    clock.at("2026-09-30T10:00:00Z");
    Snapshot migrated = planner.snapshot();
    assertThat(migrated.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(migrated.tasks().get(0).completedAt()).isNull();
    assertThat(migrated.events().get(0).kind()).isEqualTo("completed");
    assertThat(migrated.events().get(0).date()).isEqualTo("2026-09-29");
    assertThat(migrated.events().get(0).reason()).isEqualTo("legacy-completion");
    assertThat(migrated.taskTimings().get(completed.id()).completedDate()).isEqualTo("2026-09-29");
    assertThat(planner.report("2026-09-29", "2026-09-29", "day").summary().completed())
        .isEqualTo(1);
    assertThat(service(store).snapshot()).isEqualTo(migrated);
  }

  @Test
  void alreadyPinnedLegacyCompletionsStayOnTimeAfterTimezoneChangeArchiveAndReopen()
      throws Exception {
    Task done = legacyTask("done", "done", "2026-09-25", "2026-09-25T10:00:00Z", "TASK-7");
    Task archived =
        legacyTask("archived", "archived", "2026-09-25", "2026-09-25T23:30:00Z", "TASK-8");
    Task noTimestamp = legacyTask("no-timestamp", "done", "2026-09-25", null, "TASK-9");
    List<Task> original = List.of(done, archived, noTimestamp);
    store.write(file(), legacy(original, List.of(), List.of()));
    clock.at("2026-09-28T10:00:00Z");

    Snapshot migrated = planner.snapshot();
    assertThat(migrated.tasks()).isEqualTo(original);
    assertThat(migrated.events())
        .extracting(Event::kind)
        .containsExactly("completed", "completed", "completed");
    assertThat(migrated.events()).extracting(Event::date).containsOnly("2026-09-25");
    assertThat(migrated.events()).extracting(Event::status).containsOnly("done");
    assertThat(migrated.events().get(0).at()).isEqualTo(done.completedAt());
    assertThat(migrated.events().get(1).at()).isEqualTo(archived.completedAt());
    assertThat(migrated.missedByDate()).isEmpty();
    assertThat(migrated.revision()).isEqualTo(8);
    String bytes = Files.readString(file());
    assertThat(service(store).snapshot()).isEqualTo(migrated);
    assertThat(Files.readString(file())).isEqualTo(bytes);

    planner.updateSettings(
        new UpdateSettings(migrated.revision(), "09:00", "18:00", "Asia/Kolkata", false));
    status(done, "archived");
    status(done, "todo");
    status(archived, "todo");
    Snapshot reopened = status(noTimestamp, "todo");
    assertThat(reopened.tasks()).extracting(Task::completedAt).containsOnlyNulls();
    assertThat(reopened.taskTimings().values())
        .allSatisfy(
            timing -> {
              assertThat(timing.completedDate()).isEqualTo("2026-09-25");
              assertThat(timing.latenessDays()).isZero();
              assertThat(timing.missedPlannedDay()).isFalse();
            });
    assertThat(reopened.events().stream().filter(event -> event.kind().equals("completed")))
        .hasSize(3);
    assertThat(reopened.missedByDate()).isEmpty();
    assertThat(planner.report("2026-09-25", "2026-09-25", "day").summary().completed())
        .isEqualTo(3);
    assertThat(service(store).snapshot()).isEqualTo(reopened);
  }

  @Test
  void archivedLegacyTimestampUsesStoredZoneAndRetainsLateCompletionAfterReopen() {
    Task archived =
        legacyTask("archived", "archived", "2026-09-25", "2026-09-25T20:00:00Z", "TASK-7");
    Stored old = legacy(List.of(archived), List.of(), List.of());
    store.write(
        file(),
        new Stored(
            old.revision(),
            new Settings("09:00", "18:00", "Asia/Kolkata", false),
            old.tasks(),
            old.events(),
            old.daysOff(),
            old.sprints(),
            old.deliveredReminders(),
            old.nextTaskNumber(),
            old.links()));
    clock.at("2026-09-28T10:00:00Z");
    Snapshot migrated = planner.snapshot();
    assertThat(migrated.tasks()).containsExactly(archived);
    assertThat(migrated.taskTimings().get(archived.id()))
        .isEqualTo(new TaskTiming("2026-09-25", "2026-09-26", 1, "late", true));
    assertThat(migrated.events().get(0).at()).isEqualTo(archived.completedAt());
    assertThat(migrated.events().get(0).date()).isEqualTo("2026-09-26");
    planner.updateSettings(new UpdateSettings(migrated.revision(), "09:00", "18:00", "UTC", false));
    Snapshot reopened = status(archived, "todo");
    assertThat(reopened.tasks().get(0).completedAt()).isNull();
    assertThat(reopened.taskTimings()).isEqualTo(migrated.taskTimings());
    assertThat(reopened.missedByDate()).containsExactlyEntriesOf(Map.of("2026-09-25", 1));
    assertThat(reopened.events().stream().filter(event -> event.kind().equals("completed")))
        .hasSize(1);
    assertThat(
            reopened.events().stream().filter(event -> event.kind().equals("missed-planned-day")))
        .hasSize(1);
    assertThat(service(store).snapshot()).isEqualTo(reopened);
  }

  @Test
  void completionOnlyMigrationFailureCannotPublishOrLoseFallbackEvidence() throws Exception {
    Task done = legacyTask("done", "done", "2026-09-25", "2026-09-25T10:00:00Z", "TASK-7");
    store.write(file(), legacy(List.of(done), List.of(), List.of()));
    String bytes = Files.readString(file());
    clock.at("2026-09-28T10:00:00Z");
    var failing =
        new AtomicJsonStore(new ObjectMapper()) {
          boolean fail = true;

          @Override
          public void write(Path path, Object value) {
            if (fail) throw new IllegalStateException("Disk full");
            super.write(path, value);
          }
        };
    planner = service(failing);
    assertThatThrownBy(planner::snapshot)
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("Disk full");
    assertThatThrownBy(
            () -> planner.editTask(done.id(), new EditTask(7L, null, null, "todo", null)))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("Disk full");
    assertThat(Files.readString(file())).isEqualTo(bytes);
    failing.fail = false;
    Snapshot migrated = planner.snapshot();
    assertThat(migrated.tasks()).containsExactly(done);
    assertThat(migrated.events()).extracting(Event::kind).containsExactly("completed");
    assertThat(migrated.missedByDate()).isEmpty();
    Snapshot reopened = status(done, "todo");
    assertThat(reopened.tasks().get(0).completedAt()).isNull();
    assertThat(reopened.events().stream().filter(event -> event.kind().equals("completed")))
        .hasSize(1);
    assertThat(reopened.missedByDate()).isEmpty();
    assertThat(service(store).snapshot()).isEqualTo(reopened);
  }

  @Test
  void failedMigrationPreservesBytesAndRetriesWithoutHalfPublishedMemory() throws Exception {
    Task pending = legacyTask("old", "todo", "2026-09-29", null, "TASK-7");
    store.write(file(), legacy(List.of(pending), List.of(), List.of()));
    String bytes = Files.readString(file());
    var failing =
        new AtomicJsonStore(new ObjectMapper()) {
          boolean fail = true;

          @Override
          public void write(Path path, Object value) {
            if (fail) throw new IllegalStateException("Disk full");
            super.write(path, value);
          }
        };
    planner = service(failing);
    assertThatThrownBy(planner::snapshot)
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("Disk full");
    assertThatThrownBy(planner::snapshot).isInstanceOf(IllegalStateException.class);
    assertThat(Files.readString(file())).isEqualTo(bytes);
    failing.fail = false;
    Snapshot recovered = planner.snapshot();
    assertThat(recovered.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(recovered.events()).extracting(Event::kind).containsExactly("schedule-pinned");
    assertThat(service(store).snapshot()).isEqualTo(recovered);
  }

  @Test
  void legacyMissingOriginalDatesUseTheExistingPlanAndAreBackfilledDurably() throws Exception {
    Task absent =
        new Task(
            "absent",
            "Old task",
            "",
            "todo",
            "2026-09-25",
            null,
            "2026-09-25T10:00:00Z",
            "2026-09-25T10:00:00Z",
            null,
            "TASK-7");
    Task blank =
        new Task(
            "blank",
            "Old task",
            "",
            "todo",
            "2026-09-28",
            "  ",
            "2026-09-25T10:00:00Z",
            "2026-09-25T10:00:00Z",
            null,
            "TASK-8");
    store.write(file(), legacy(List.of(absent, blank), List.of(), List.of()));
    Snapshot migrated = planner.snapshot();
    assertThat(migrated.tasks()).extracting(Task::date).containsExactly("2026-09-25", "2026-09-28");
    assertThat(migrated.tasks())
        .extracting(Task::originalDate)
        .containsExactly("2026-09-25", "2026-09-28");
    assertThat(migrated.tasks()).extracting(Task::id).containsExactly(absent.id(), blank.id());
    assertThat(migrated.tasks()).extracting(Task::key).containsExactly(absent.key(), blank.key());
    assertThat(migrated.events())
        .extracting(Event::kind)
        .containsExactly("schedule-pinned", "schedule-pinned");
    String bytes = Files.readString(file());
    assertThat(service(store).snapshot()).isEqualTo(migrated);
    assertThat(Files.readString(file())).isEqualTo(bytes);
  }

  @Test
  void invalidOriginalDateFailsSafelyRatherThanInventingAPlan() throws Exception {
    Task invalid =
        new Task(
            "old",
            "Title",
            "",
            "todo",
            "2026-09-29",
            "2026-02-30",
            "2026-09-25T10:00:00Z",
            "2026-09-25T10:00:00Z",
            null,
            "TASK-7");
    store.write(file(), legacy(List.of(invalid), List.of(), List.of()));
    String bytes = Files.readString(file());
    assertThatThrownBy(planner::snapshot).isInstanceOf(IllegalArgumentException.class);
    assertThat(Files.readString(file())).isEqualTo(bytes);
  }

  @Test
  void missedCounterIsPermanentAfterLateCompletionArchiveRestoreAndTimezoneRollback() {
    Task task = add("Friday commitment", "2026-09-25");
    clock.at("2026-09-25T23:59:59Z");
    assertThat(planner.snapshot().missedByDate()).isEmpty();
    clock.at("2026-09-26T00:00:00Z");
    Snapshot missed = planner.snapshot();
    assertThat(missed.missedByDate()).containsExactlyEntriesOf(Map.of("2026-09-25", 1));
    assertThat(missed.events())
        .extracting(Event::kind)
        .containsExactly("created", "missed-planned-day");
    status(task, "done");
    status(task, "archived");
    status(task, "todo");
    planner.updateSettings(
        new UpdateSettings(
            planner.snapshot().revision(), "09:00", "18:00", "America/Los_Angeles", false));
    clock.at("2026-09-25T10:00:00Z");
    Snapshot returned = planner.snapshot();
    assertThat(returned.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(returned.taskTimings().get(task.id()).completedDate()).isEqualTo("2026-09-26");
    assertThat(returned.missedByDate()).containsExactlyEntriesOf(missed.missedByDate());
    assertThat(
            returned.events().stream().filter(event -> event.kind().equals("missed-planned-day")))
        .hasSize(1);
    assertThat(service(store).snapshot()).isEqualTo(returned);
    assertThat(planner.report("2026-09-25", "2026-09-25", "day").summary().missedPlannedDay())
        .isEqualTo(1);
  }

  @Test
  void oneTwoAndThreeDaysLateUseCalendarDaysIncludingWeekendAndKeepOriginalCards() {
    Task one = add("One day late", "2026-09-25");
    Task two = add("Two days late", "2026-09-25");
    Task three = add("Three days late", "2026-09-25");
    clock.at("2026-09-26T10:00:00Z");
    status(one, "done");
    clock.at("2026-09-27T10:00:00Z");
    status(two, "done");
    clock.at("2026-09-28T10:00:00Z");
    Snapshot completed = status(three, "done");
    assertThat(completed.tasks()).extracting(Task::date).containsOnly("2026-09-25");
    assertThat(completed.taskTimings().get(one.id()))
        .isEqualTo(new TaskTiming("2026-09-25", "2026-09-26", 1, "late", true));
    assertThat(completed.taskTimings().get(two.id()))
        .isEqualTo(new TaskTiming("2026-09-25", "2026-09-27", 2, "late", true));
    assertThat(completed.taskTimings().get(three.id()))
        .isEqualTo(new TaskTiming("2026-09-25", "2026-09-28", 3, "very-late", true));
    assertThat(completed.missedByDate()).containsExactlyEntriesOf(Map.of("2026-09-25", 3));
    assertThat(completed.events()).noneMatch(event -> event.kind().equals("moved"));
    Report report = planner.report("2026-09-25", "2026-09-28", "day");
    assertThat(report.summary().completed()).isEqualTo(3);
    assertThat(report.summary().missedPlannedDay()).isEqualTo(3);
    assertThat(service(store).snapshot()).isEqualTo(completed);
  }

  @Test
  void originalPlanCannotBeChangedByStatusTitleOrExplicitDatePatch() {
    Task task = add("Fixed plan", "2026-09-25");
    Snapshot before = planner.snapshot();
    for (String status : List.of("todo", "in-progress", "done", "archived")) {
      assertThatThrownBy(
              () ->
                  planner.editTask(
                      task.id(),
                      new EditTask(before.revision(), "Changed", "Notes", status, "2026-09-28")))
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessageContaining("original planned day");
      assertThat(planner.snapshot()).isEqualTo(before);
    }
    clock.at("2026-09-28T20:00:00Z");
    Snapshot current = planner.snapshot();
    Snapshot changed =
        planner.editTask(
            task.id(),
            new EditTask(
                current.revision(), "Edited late", "Still editable", "in-progress", task.date()));
    assertThat(changed.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(changed.tasks().get(0).title()).isEqualTo("Edited late");
    assertThat(changed.events().get(changed.events().size() - 1).date()).isEqualTo("2026-09-28");
  }

  @Test
  void workdayAndDayOffChangesDoNotMoveAnyTaskOrEraseAnObservedMiss() {
    Task today = add("Original day", "2026-09-25");
    Task future = add("Next week", "2026-09-28");
    Snapshot shorter =
        planner.updateSettings(
            new UpdateSettings(planner.snapshot().revision(), "08:00", "09:00", "UTC", true));
    assertThat(shorter.tasks()).containsExactly(today, future);
    Snapshot off =
        planner.updateDayOff(new UpdateDayOff(shorter.revision(), future.date(), "Leave", true));
    assertThat(off.tasks()).containsExactly(today, future);
    clock.at("2026-09-29T10:00:00Z");
    Snapshot missed = planner.snapshot();
    assertThat(missed.tasks()).containsExactly(today, future);
    assertThat(missed.missedByDate())
        .containsExactlyInAnyOrderEntriesOf(Map.of("2026-09-25", 1, "2026-09-28", 1));
    Snapshot unmarked =
        planner.updateDayOff(new UpdateDayOff(missed.revision(), future.date(), "", false));
    assertThat(unmarked.events()).isEqualTo(missed.events());
    assertThat(unmarked.tasks()).containsExactly(today, future);
  }

  @Test
  void onTimeCompletionRemainsOnTimeAfterReopeningAndSubsequentDays() {
    Task task = add("Complete on Friday", "2026-09-25");
    clock.at("2026-09-25T23:59:59Z");
    status(task, "done");
    clock.at("2026-09-28T10:00:00Z");
    status(task, "todo");
    clock.at("2026-10-05T10:00:00Z");
    Snapshot later = status(task, "done");
    assertThat(later.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(later.taskTimings().get(task.id()))
        .isEqualTo(new TaskTiming("2026-09-25", "2026-09-25", 0, "on-time", false));
    assertThat(later.missedByDate()).isEmpty();
    assertThat(later.events()).noneMatch(event -> event.kind().equals("missed-planned-day"));
  }

  @Test
  void observedMissUsesStrictRevisionAndARefreshedCompletionSucceedsWithoutMoving() {
    Task task = add("Tomorrow's late completion", "2026-09-25");
    long before = planner.snapshot().revision();
    clock.at("2026-09-26T10:00:00Z");
    assertThatThrownBy(
            () -> planner.editTask(task.id(), new EditTask(before, null, null, "done", null)))
        .isInstanceOf(ConflictException.class);
    Snapshot completed = status(task, "done");
    assertThat(completed.tasks().get(0).date()).isEqualTo("2026-09-25");
    assertThat(completed.tasks().get(0).completedAt()).isEqualTo("2026-09-26T10:00:00Z");
    assertThat(completed.missedByDate()).containsEntry("2026-09-25", 1);
  }

  private static final class MutableClock extends Clock {
    Instant current = Instant.parse("2026-09-25T10:00:00Z");

    void at(String instant) {
      current = Instant.parse(instant);
    }

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
