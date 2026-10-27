package com.argus.background.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class BackgroundJobServiceTest {
  @TempDir Path root;

  BackgroundJobService service() {
    return new BackgroundJobService(
        new AtomicJsonStore(new ObjectMapper()), new ArgusProperties(root, root, "test", ""));
  }

  @Test
  void tracksProgressAndWarningsWithoutResurrectingOldSessionCards() throws Exception {
    var jobs = service();
    String id =
        text(
            jobs.create(
                object(
                    "type",
                    "knowledge-rebuild",
                    "title",
                    "Rebuild",
                    "total",
                    2,
                    "items",
                    List.of(object("repositoryId", "one"), object("repositoryId", "two")))),
            "id");
    jobs.update(id, object("status", "running", "completed", 1, "currentItem", "two"));
    assertThat(jobs.get(id)).containsEntry("percent", 50L);
    jobs.update(id, object("percent", 73, "message", "Downloading model"));
    jobs.appendLog(
        id,
        object(
            "repository",
            "two",
            "stage",
            "indexing",
            "durationMillis",
            1250,
            "message",
            "Built core knowledge"));
    assertThat(jobs.get(id)).containsEntry("percent", 73L);
    assertThat(map(list(jobs.get(id).get("logs")).get(1)))
        .containsEntry("repository", "two")
        .containsEntry("durationMillis", 1250L);
    jobs.update(id, object("status", "completed-with-warning", "warnings", 1, "percent", 100));
    assertThat(jobs.get(id)).containsEntry("warnings", 1).containsEntry("failed", 0);
    assertThat(Files.readString(root.resolve("background-jobs.json")))
        .contains(id, "completed-with-warning");
    assertThat(service().list())
        .isEmpty(); // The durable refresh queue, not old cards, owns restart recovery.
  }

  @Test
  void preservesAiKitRepositoryNamesAndResultsForTheActivityCard() throws Exception {
    var jobs = service();
    var queued =
        jobs.create(
            object(
                "type",
                "ai-kit-generation",
                "title",
                "Updating AI kits from production changes",
                "total",
                2,
                "items",
                List.of(
                    object("repositoryId", "orders-id", "name", "orders-api"),
                    object("repositoryId", "billing-id", "name", "billing-worker"))));
    String id = text(queued, "id");
    assertThat(list(queued.get("items")).stream().map(item -> map(item)).toList())
        .containsExactly(
            object(
                "repositoryId", "orders-id", "name", "orders-api", "status", "queued", "error", ""),
            object(
                "repositoryId",
                "billing-id",
                "name",
                "billing-worker",
                "status",
                "queued",
                "error",
                ""));

    jobs.update(id, object("status", "running", "currentItem", "orders-api"));
    jobs.updateItem(id, 0, object("status", "running", "stage", "business-flow discovery"));
    assertThat(map(list(jobs.get(id).get("items")).get(0)))
        .containsEntry("repositoryId", "orders-id")
        .containsEntry("name", "orders-api")
        .containsEntry("status", "running");
    jobs.updateItem(id, 0, object("status", "completed", "skillCount", 3));
    jobs.updateItem(id, 1, object("status", "failed", "error", "Fixture generation failed"));
    jobs.update(
        id,
        object("status", "completed-with-errors", "completed", 1, "failed", 1, "currentItem", ""));

    var finished = jobs.get(id);
    assertThat(finished)
        .containsEntry("status", "completed-with-errors")
        .containsEntry("currentItem", "")
        .containsEntry("percent", 100L);
    assertThat(map(list(finished.get("items")).get(0)))
        .containsEntry("repositoryId", "orders-id")
        .containsEntry("name", "orders-api")
        .containsEntry("status", "completed")
        .containsEntry("skillCount", 3);
    assertThat(map(list(finished.get("items")).get(1)))
        .containsEntry("repositoryId", "billing-id")
        .containsEntry("name", "billing-worker")
        .containsEntry("status", "failed")
        .containsEntry("error", "Fixture generation failed");
    assertThat(jobs.list()).containsExactly(finished);
    assertThat(Files.readString(root.resolve("background-jobs.json")))
        .contains(
            "orders-id", "orders-api", "billing-id", "billing-worker", "Fixture generation failed");
  }

  @Test
  void boundsCardsAndLogsAndProtectsTheCurrentOffboardingCard() {
    var jobs = service();
    String keep =
        text(
            jobs.create(
                object(
                    "type",
                    "repository-offboarding",
                    "items",
                    List.of(object("repositoryId", "one")))),
            "id");
    String remove =
        text(
            jobs.create(
                object(
                    "type",
                    "repository-onboarding",
                    "items",
                    List.of(object("repositoryId", "one")))),
            "id");
    String other =
        text(
            jobs.create(
                object(
                    "type", "knowledge-rebuild", "items", List.of(object("repositoryId", "two")))),
            "id");
    assertThat(jobs.purgeRepositories(List.of("one"), keep))
        .containsEntry("backgroundJobsDeleted", 1);
    assertThatThrownBy(() -> jobs.get(remove)).hasMessageContaining("not found");
    assertThat(jobs.get(keep)).isNotEmpty();
    for (int i = 0; i < 205; i++) jobs.appendLog(other, object("message", "entry " + i));
    assertThat(list(jobs.get(other).get("logs"))).hasSize(200);
    var returned = jobs.get(other);
    map(list(returned.get("items")).get(0)).put("status", "corrupted");
    assertThat(map(list(jobs.get(other).get("items")).get(0))).containsEntry("status", "queued");
    for (int i = 0; i < 31; i++) {
      String finished = text(jobs.create(object("type", "fixture", "title", "Fixture " + i)), "id");
      jobs.update(finished, object("status", "completed"));
    }
    assertThat(jobs.list()).hasSize(30);
  }

  @Test
  void activeCardsSurviveHistoryPressureAndRemainCancellable() {
    var jobs = service();
    var controls = new BackgroundOperationService(jobs);
    String id = text(jobs.create(object("type", "repository-onboarding")), "id");
    try (var operation = controls.register(id, () -> {}, () -> {}, () -> {})) {
      jobs.update(id, object("status", "paused"));
      for (int i = 0; i < 35; i++) jobs.create(object("type", "fixture", "title", "Active " + i));
      assertThat(jobs.list()).hasSize(36);
      assertThat(jobs.get(id)).containsEntry("status", "paused");
      controls.resume(id);
      operation.checkpoint();
      controls.cancel(id);
      assertThat(operation.isCancelled()).isTrue();
      assertThat(jobs.get(id)).containsEntry("status", "cancelled");
    }
    jobs.create(object("type", "fixture"));
    assertThatThrownBy(() -> jobs.get(id)).hasMessageContaining("not found");
    assertThat(jobs.list()).hasSize(36);
  }

  @Test
  void terminalCardRemainsAddressableUntilItsProducerReleasesOwnership() {
    var jobs = service();
    var controls = new BackgroundOperationService(jobs);
    String id = text(jobs.create(object("type", "ai-kit-generation")), "id");
    try (var operation = controls.register(id, () -> {}, () -> {}, () -> {})) {
      jobs.update(id, object("status", "completed"));
      for (int i = 0; i < 35; i++) jobs.create(object("type", "fixture", "title", "Active " + i));
      assertThat(jobs.get(id)).containsEntry("status", "completed");
      operation.checkpoint();
      jobs.appendLog(id, object("message", "Producer finished publishing its durable result"));
    }
    assertThatThrownBy(() -> jobs.get(id)).hasMessageContaining("not found");
    assertThat(jobs.list()).hasSize(35);
  }
}
