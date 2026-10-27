package com.argus.planner.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.planner.domain.PlannerModels.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class DailyPlannerTaskLinksTest {
  @TempDir Path directory;
  private AtomicJsonStore json;
  private DailyPlannerService planner;
  private MutableClock clock;

  @BeforeEach
  void setup() {
    json = new AtomicJsonStore(new ObjectMapper());
    clock = new MutableClock();
    planner = service(json);
  }

  private DailyPlannerService service(AtomicJsonStore store) {
    return new DailyPlannerService(
        new ArgusProperties(directory, directory, "test", ""), store, clock);
  }

  private Path file() {
    return directory.resolve("daily-planner.json");
  }

  private Snapshot add(String title, String date) {
    return planner.addTasks(
        new AddTasks(planner.snapshot().revision(), List.of(new NewTask(title, "", date))));
  }

  private Snapshot edit(Task task, String title, String status, String date) {
    return planner.editTask(
        task.id(), new EditTask(planner.snapshot().revision(), title, null, status, date));
  }

  private Snapshot link(Task first, Task second) {
    return planner.addLink(
        new AddLink(planner.snapshot().revision(), first.id(), second.id(), "related"));
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> stored() {
    return json.read(file(), Map.class);
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> legacy() {
    Task first = add("First historical title", "2026-09-25").tasks().get(0);
    edit(first, null, "done", null);
    Task second = add("Second archived plan", "2026-09-28").tasks().get(1);
    edit(second, null, "archived", null);
    add("Third upcoming plan", "2026-09-30");
    planner.updateSettings(
        new UpdateSettings(planner.snapshot().revision(), "09:00", "18:00", "UTC", true));
    planner.acknowledge("2026-09-25:start");
    planner.updateDayOff(
        new UpdateDayOff(planner.snapshot().revision(), "2026-09-29", "Leave", true));
    planner.addSprint(
        new AddSprint(planner.snapshot().revision(), "Sprint alpha", "2026-09-21", "2026-10-02"));
    Map<String, Object> legacy = new LinkedHashMap<>(stored());
    legacy.remove("nextTaskNumber");
    legacy.remove("links");
    List<Map<String, Object>> tasks = new ArrayList<>();
    for (Map<String, Object> task : (List<Map<String, Object>>) legacy.get("tasks")) {
      Map<String, Object> old = new LinkedHashMap<>(task);
      old.remove("key");
      tasks.add(old);
    }
    legacy.put("tasks", tasks);
    json.write(file(), legacy);
    return legacy;
  }

  @Test
  void legacyMigrationIsDeterministicAtomicAndPreservesAllExistingHistoryAndSettings() {
    Map<String, Object> original = legacy();
    var writes = new AtomicInteger();
    var countingStore =
        new AtomicJsonStore(new ObjectMapper()) {
          @Override
          public void write(Path path, Object value) {
            writes.incrementAndGet();
            super.write(path, value);
          }
        };
    planner = service(countingStore);
    Snapshot migrated = planner.snapshot();
    assertThat(migrated.tasks())
        .extracting(Task::key)
        .containsExactly("TASK-1", "TASK-2", "TASK-3");
    assertThat(migrated.links()).isEmpty();
    assertThat(migrated.revision()).isEqualTo(((Number) original.get("revision")).longValue() + 1);
    Map<String, Object> saved = stored();
    for (String field : List.of("events", "daysOff", "sprints", "settings", "deliveredReminders")) {
      assertThat(saved.get(field)).isEqualTo(original.get(field));
    }
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> newTasks = (List<Map<String, Object>>) saved.get("tasks");
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> oldTasks = (List<Map<String, Object>>) original.get("tasks");
    for (int i = 0; i < newTasks.size(); i++) {
      Map<String, Object> withoutKey = new LinkedHashMap<>(newTasks.get(i));
      withoutKey.remove("key");
      assertThat(withoutKey).isEqualTo(oldTasks.get(i));
    }
    assertThat(((Number) saved.get("nextTaskNumber")).longValue()).isEqualTo(4);
    assertThat(writes.get()).isEqualTo(1);
    assertThat(planner.snapshot()).isEqualTo(migrated);
    assertThat(service(countingStore).snapshot()).isEqualTo(migrated);
    assertThat(writes.get()).isEqualTo(1);
  }

  @Test
  void migrationFailurePublishesNoUncommittedKeysAndRetryUsesSameTaskOrder() throws Exception {
    legacy();
    String bytes = Files.readString(file());
    var store = new FailingStore();
    store.fail = true;
    planner = service(store);
    assertThatThrownBy(planner::snapshot)
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("Disk full");
    assertThat(Files.readString(file())).isEqualTo(bytes);
    assertThatThrownBy(planner::snapshot).isInstanceOf(IllegalStateException.class);
    store.fail = false;
    assertThat(planner.snapshot().tasks())
        .extracting(Task::key)
        .containsExactly("TASK-1", "TASK-2", "TASK-3");
    assertThat(service(json).snapshot()).isEqualTo(planner.snapshot());
  }

  @Test
  @SuppressWarnings("unchecked")
  void partialIdentityMetadataPreservesKeysAndHonorsPersistedHighWaterCounter() {
    Map<String, Object> old = legacy();
    List<Map<String, Object>> tasks = (List<Map<String, Object>>) old.get("tasks");
    tasks.get(0).put("key", "TASK-7");
    old.put("nextTaskNumber", 20L);
    old.put("links", List.of());
    json.write(file(), old);
    planner = service(json);
    assertThat(planner.snapshot().tasks())
        .extracting(Task::key)
        .containsExactly("TASK-7", "TASK-20", "TASK-21");
    assertThat(add("Next", "2026-09-30").tasks().get(3).key()).isEqualTo("TASK-22");
  }

  @Test
  void humanKeysRemainStableThroughEditsArchiveReopenMissedPlanAndRestart() {
    Task first = add("First", "2026-09-25").tasks().get(0);
    assertThat(first.key()).isEqualTo("TASK-1");
    edit(first, "Renamed", null, null);
    edit(first, null, "archived", null);
    Task second = add("Second", "2026-09-25").tasks().get(1);
    assertThat(second.key()).isEqualTo("TASK-2");
    edit(first, null, "todo", null);
    clock.current = Instant.parse("2026-09-28T10:00:00Z");
    Snapshot monday = planner.snapshot();
    assertThat(monday.tasks()).extracting(Task::key).containsExactly("TASK-1", "TASK-2");
    assertThat(monday.tasks()).extracting(Task::id).containsExactly(first.id(), second.id());
    assertThat(monday.tasks()).extracting(Task::date).containsOnly("2026-09-25");
    planner = service(json);
    assertThat(add("Third", "2026-09-28").tasks())
        .extracting(Task::key)
        .containsExactly("TASK-1", "TASK-2", "TASK-3");
  }

  @Test
  void invalidBatchesAndStaleWritesDoNotConsumeOrReassignCommittedIds() {
    add("First", "2026-09-25");
    assertThatThrownBy(
            () ->
                planner.addTasks(
                    new AddTasks(
                        1L,
                        List.of(
                            new NewTask("Valid", "", "2026-09-25"),
                            new NewTask("", "", "2026-09-25")))))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(add("Second", "2026-09-25").tasks())
        .extracting(Task::key)
        .containsExactly("TASK-1", "TASK-2");
    assertThatThrownBy(
            () ->
                planner.addTasks(new AddTasks(1L, List.of(new NewTask("Stale", "", "2026-09-25")))))
        .isInstanceOf(ConflictException.class);
    assertThat(add("Third", "2026-09-25").tasks().get(2).key()).isEqualTo("TASK-3");
  }

  @Test
  @SuppressWarnings("unchecked")
  void duplicateAndInvalidPersistedKeysFailSafelyWithoutRewritingData() throws Exception {
    Map<String, Object> legacy = legacy();
    List<Map<String, Object>> tasks = (List<Map<String, Object>>) legacy.get("tasks");
    tasks.get(0).put("key", "TASK-1");
    tasks.get(1).put("key", "TASK-1");
    json.write(file(), legacy);
    String bytes = Files.readString(file());
    assertThatThrownBy(() -> service(json).snapshot())
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("duplicated");
    assertThat(Files.readString(file())).isEqualTo(bytes);
    tasks.get(1).put("key", "TASK-0");
    json.write(file(), legacy);
    assertThatThrownBy(() -> service(json).snapshot())
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("invalid");
    tasks.get(1).put("key", "TASK-9223372036854775807");
    json.write(file(), legacy);
    assertThatThrownBy(() -> service(json).snapshot())
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("range");
  }

  @Test
  void crossDateLinksAreUndirectedAllowArchivedTasksAndSurviveEveryTaskMutation() {
    Task first = add("First", "2026-09-25").tasks().get(0);
    Task second = add("Second", "2026-09-30").tasks().get(1);
    edit(second, null, "archived", null);
    Snapshot connected = link(second, first);
    TaskLink relation = connected.links().get(0);
    assertThat(relation.type()).isEqualTo("related");
    assertThat(relation.sourceTaskId().compareTo(relation.targetTaskId())).isNegative();
    assertThat(List.of(relation.sourceTaskId(), relation.targetTaskId()))
        .containsExactlyInAnyOrder(first.id(), second.id());
    assertThat(connected.events()).isEqualTo(planner.snapshot().events());
    edit(first, "Renamed", null, null);
    edit(second, null, "todo", null);
    edit(second, null, "done", null);
    clock.current = Instant.parse("2026-09-29T10:00:00Z");
    assertThat(planner.snapshot().links()).containsExactly(relation);
    assertThat(service(json).snapshot().links()).containsExactly(relation);
    assertThat(planner.snapshot().tasks())
        .extracting(Task::key)
        .containsExactly("TASK-1", "TASK-2");
  }

  @Test
  void linkValidationRejectsSelfUnknownTasksUnsupportedTypesAndReverseDuplicates() {
    Task first = add("First", "2026-09-25").tasks().get(0);
    Task second = add("Second", "2026-09-28").tasks().get(1);
    long revision = planner.snapshot().revision();
    assertThatThrownBy(
            () -> planner.addLink(new AddLink(revision, first.id(), first.id(), "related")))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () -> planner.addLink(new AddLink(revision, first.id(), "missing", "related")))
        .isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> planner.addLink(new AddLink(revision, first.id(), null, "related")))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () -> planner.addLink(new AddLink(revision, first.id(), second.id(), "depends-on")))
        .isInstanceOf(IllegalArgumentException.class);
    Snapshot connected = link(first, second);
    assertThatThrownBy(
            () ->
                planner.addLink(
                    new AddLink(connected.revision(), second.id(), first.id(), "related")))
        .isInstanceOf(ConflictException.class);
    assertThat(planner.snapshot()).isEqualTo(connected);
  }

  @Test
  void deletingALinkOnlyRemovesThatRelationshipAndRequiresCurrentRevision() {
    Task first = add("First", "2026-09-25").tasks().get(0);
    Task second = add("Second", "2026-09-28").tasks().get(1);
    Task third = add("Third", "2026-09-30").tasks().get(2);
    TaskLink link = link(first, second).links().get(0);
    Snapshot both = link(second, third);
    assertThatThrownBy(() -> planner.deleteLink(link.id(), both.revision() - 1))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(
            () ->
                planner.addLink(
                    new AddLink(both.revision() - 1, first.id(), third.id(), "related")))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> planner.deleteLink("unknown", both.revision()))
        .isInstanceOf(NotFoundException.class);
    Snapshot removed = planner.deleteLink(link.id(), both.revision());
    assertThat(removed.links()).containsExactly(both.links().get(1));
    assertThat(removed.tasks()).isEqualTo(both.tasks());
    assertThat(removed.events()).isEqualTo(both.events());
    assertThat(service(json).snapshot()).isEqualTo(removed);
  }

  @Test
  void failedLinkCreationAndDeletionLeaveInMemoryAndPersistedStateIntact() throws Exception {
    var store = new FailingStore();
    planner = service(store);
    Task first = add("First", "2026-09-25").tasks().get(0);
    Task second = add("Second", "2026-09-28").tasks().get(1);
    Snapshot before = planner.snapshot();
    String bytes = Files.readString(file());
    store.fail = true;
    assertThatThrownBy(() -> link(first, second)).isInstanceOf(IllegalStateException.class);
    assertThat(planner.snapshot()).isEqualTo(before);
    assertThat(Files.readString(file())).isEqualTo(bytes);
    store.fail = false;
    Snapshot connected = link(first, second);
    bytes = Files.readString(file());
    store.fail = true;
    assertThatThrownBy(
            () -> planner.deleteLink(connected.links().get(0).id(), connected.revision()))
        .isInstanceOf(IllegalStateException.class);
    assertThat(planner.snapshot()).isEqualTo(connected);
    assertThat(Files.readString(file())).isEqualTo(bytes);
  }

  @Test
  void reportsExposeStableKeysAndCurrentCrossPeriodLinksWithoutRewritingHistory() {
    Task first = add("=HYPERLINK(\"evil\")", "2026-09-25").tasks().get(0);
    edit(first, null, "done", null);
    Task second = add("<script>future task</script>", "2026-10-01").tasks().get(1);
    List<Event> events = planner.snapshot().events();
    link(first, second);
    Report report = planner.report("2026-09-25", "2026-09-25", "day");
    ReportTask recorded = report.daily().get(0).tasks().get(0);
    assertThat(recorded.key()).isEqualTo("TASK-1");
    assertThat(recorded.taskId()).isEqualTo(first.id());
    assertThat(recorded.relatedTaskKeys()).containsExactly("TASK-2");
    assertThat(recorded.completed()).isTrue();
    assertThat(planner.snapshot().events()).isEqualTo(events);
    assertThat(PlannerReports.csv(report))
        .contains(
            "Task key,Task UUID,Related task keys",
            "\"TASK-1\"",
            "\"TASK-2\"",
            "\"'=HYPERLINK(\"\"evil\"\")\"");
    String html = PlannerReports.html(report);
    assertThat(html)
        .contains("TASK-1", "Related: TASK-2", "current links")
        .doesNotContain("<script>");
    Report future = planner.report("2026-10-01", "2026-10-01", "day");
    assertThat(future.daily().get(0).tasks().get(0).relatedTaskKeys()).containsExactly("TASK-1");
    assertThat(PlannerReports.html(future)).contains("&lt;script&gt;future task&lt;/script&gt;");
  }

  @Test
  void corruptStoredRelationshipsAreNeverSilentlyDropped() throws Exception {
    add("First", "2026-09-25");
    Map<String, Object> saved = stored();
    saved.put(
        "links",
        List.of(
            Map.of(
                "id",
                "link",
                "sourceTaskId",
                "missing-1",
                "targetTaskId",
                "missing-2",
                "type",
                "related",
                "createdAt",
                "2026-09-25T10:00:00Z")));
    json.write(file(), saved);
    String bytes = Files.readString(file());
    assertThatThrownBy(() -> service(json).snapshot())
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("links are invalid");
    assertThat(Files.readString(file())).isEqualTo(bytes);
  }

  private static final class FailingStore extends AtomicJsonStore {
    boolean fail;

    FailingStore() {
      super(new ObjectMapper());
    }

    @Override
    public void write(Path path, Object value) {
      if (fail) throw new IllegalStateException("Disk full");
      super.write(path, value);
    }
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
