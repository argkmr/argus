package com.argus.planner.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.planner.domain.PlannerModels.*;
import java.nio.file.Path;
import java.time.*;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class DailyPlannerDeletionTest {
  @TempDir Path root;

  @Test
  void deletesOnlyTargetAndItsEvidenceAtomicallyAndPersists() {
    var properties = new ArgusProperties(root, root, "test", "");
    var json = new AtomicJsonStore(new ObjectMapper());
    var clock = Clock.fixed(Instant.parse("2026-10-27T10:00:00Z"), ZoneOffset.UTC);
    var planner = new DailyPlannerService(properties, json, clock);
    var state =
        planner.addTasks(
            new AddTasks(
                0L,
                List.of(
                    new NewTask("Delete me", "Private notes", "2026-10-27"),
                    new NewTask("Keep me", "", "2026-10-27"))));
    var removed = state.tasks().get(0);
    var kept = state.tasks().get(1);
    state = planner.addLink(new AddLink(state.revision(), removed.id(), kept.id(), "related"));
    state =
        planner.editTask(
            removed.id(), new EditTask(state.revision(), null, null, "archived", null));
    long revision = state.revision();
    assertThatThrownBy(() -> planner.deleteTask(removed.id(), revision - 1))
        .isInstanceOf(ConflictException.class);
    assertThat(planner.snapshot().tasks()).hasSize(2);
    state = planner.deleteTask(removed.id(), revision);
    assertThat(state.revision()).isEqualTo(revision + 1);
    assertThat(state.tasks()).containsExactly(kept);
    assertThat(state.events()).noneMatch(event -> removed.id().equals(event.taskId()));
    assertThat(state.links()).isEmpty();
    assertThat(state.taskTimings()).doesNotContainKey(removed.id());
    assertThat(new DailyPlannerService(properties, json, clock).snapshot().tasks())
        .containsExactly(kept);
    long latest = state.revision();
    assertThatThrownBy(() -> planner.deleteTask(removed.id(), latest))
        .isInstanceOf(NotFoundException.class);
    assertThat(planner.snapshot().revision()).isEqualTo(latest);
    state = planner.addTasks(new AddTasks(latest, List.of(new NewTask("New", "", "2026-10-27"))));
    assertThat(state.tasks().get(1).key()).isNotEqualTo(removed.key()).isNotEqualTo(kept.key());
  }
}
