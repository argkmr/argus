package com.argus.tasks.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskHistory;
import com.argus.tasks.domain.TaskMessage;
import com.argus.tasks.repository.TaskRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class TaskCheckpointServiceTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();
  TaskRepository repository;
  TaskService tasks;
  TaskActivityService activity;
  TaskCheckpointService checkpoints;

  @BeforeEach
  void setup() {
    repository = repository();
    activity = new TaskActivityService();
    tasks = new TaskService(repository, activity, mapper);
    checkpoints = new TaskCheckpointService(repository, mapper);
  }

  TaskRepository repository() {
    return new TaskRepository(
        new ArgusProperties(root, null, "test", ""), new AtomicJsonStore(mapper), mapper);
  }

  AiTask create(String scope) {
    return tasks.create(
        Map.of("scope", scope, "repositoryId", "repo-a", "repositoryIds", List.of("repo-a")));
  }

  String prompt(AiTask task, String text) {
    var saved = tasks.appendUser(task.id, Map.of("prompt", text), List.of());
    return saved.messages.get(saved.messages.size() - 1).id;
  }

  Path taskPath(AiTask task) {
    return root.resolve("ai-tasks").resolve(task.id + ".json");
  }

  @Test
  void marksSavedMessagesDurablyWithoutChangingConversationOrRecency() throws Exception {
    var task = create("global");
    String messageId = prompt(task, "Keep this **important decision** 🐟");
    repository.mutate(
        task.id,
        value -> {
          var message = value.messages.get(0);
          message.attachments =
              new ArrayList<>(List.of(Map.of("id", "attachment-a", "title", "Evidence")));
          message.additionalProperties().put("futureMetadata", Map.of("kept", true));
        });
    var before = tasks.get(task.id);
    String messagesBefore = mapper.writeValueAsString(before.messages);
    var contextBefore = TaskHistory.workingContext(before, "decision");
    byte[] indexBefore = Files.readAllBytes(root.resolve("ai-tasks/index.json"));
    byte[] transcriptBefore = Files.readAllBytes(Path.of(before.transcriptPath));

    var result = checkpoints.mark(task.id, messageId);

    assertThat(result.checkpointRevision).isEqualTo(1);
    assertThat(result.checkpoints).hasSize(1);
    var saved = result.checkpoints.get(0);
    assertThat(saved.messageId()).isEqualTo(messageId);
    assertThat(Instant.parse(saved.markedAt())).isNotNull();
    assertThat(mapper.writeValueAsString(saved.message()))
        .isEqualTo(mapper.writeValueAsString(before.messages.get(0)));
    assertThat(mapper.writeValueAsString(result.messages)).isEqualTo(messagesBefore);
    assertThat(result.updatedAt).isEqualTo(before.updatedAt);
    assertThat(TaskHistory.workingContext(result, "decision")).isEqualTo(contextBefore);
    assertThat(Files.readAllBytes(root.resolve("ai-tasks/index.json"))).isEqualTo(indexBefore);
    assertThat(Files.readAllBytes(Path.of(before.transcriptPath))).isEqualTo(transcriptBefore);
    var restarted = repository().get(task.id);
    assertThat(restarted.checkpointRevision).isEqualTo(1);
    assertThat(mapper.writeValueAsString(restarted.checkpoints))
        .isEqualTo(mapper.writeValueAsString(result.checkpoints));
  }

  @Test
  void duplicateMarkAndMissingRemovalAreByteIdenticalNoOps() throws Exception {
    var task = create("repository");
    String id = prompt(task, "Saved prompt");
    var marked = checkpoints.mark(task.id, id);
    byte[] before = Files.readAllBytes(taskPath(task));
    var duplicate = checkpoints.mark(task.id, id);
    var missingRemoval = checkpoints.remove(task.id, "not-marked");
    assertThat(duplicate.checkpointRevision).isEqualTo(1);
    assertThat(missingRemoval.checkpointRevision).isEqualTo(1);
    assertThat(duplicate.checkpoints.get(0).markedAt())
        .isEqualTo(marked.checkpoints.get(0).markedAt());
    assertThat(Files.readAllBytes(taskPath(task))).isEqualTo(before);
    var removed = checkpoints.remove(task.id, id);
    assertThat(removed.checkpoints).isEmpty();
    assertThat(removed.checkpointRevision).isEqualTo(2);
    byte[] removedBytes = Files.readAllBytes(taskPath(task));
    assertThat(checkpoints.remove(task.id, id).checkpointRevision).isEqualTo(2);
    assertThat(Files.readAllBytes(taskPath(task))).isEqualTo(removedBytes);
  }

  @Test
  void compactionPreservesSnapshotButDoesNotAlterPromptBudgetOrHistory() {
    var task = create("global");
    String firstId = prompt(task, "Important original decision and attachment");
    checkpoints.mark(task.id, firstId);
    var marked = repository.readTask(task.id);
    var plain = mapper.convertValue(marked, AiTask.class);
    plain.checkpoints.clear();
    plain.checkpointRevision = 0;
    for (int i = 1; i <= 60; i++) {
      var message = new TaskMessage();
      message.id = "later-" + i;
      message.role = "user";
      message.createdAt = "2026-09-08T10:" + String.format("%02d", i / 60) + ":00Z";
      message.content = "Later decision " + i + "\n" + "Some body content. ".repeat(100);
      marked.messages.add(message);
      plain.messages.add(mapper.convertValue(message, TaskMessage.class));
    }
    TaskHistory.cap(marked);
    TaskHistory.cap(plain);
    assertThat(marked.messages).hasSize(50);
    assertThat(marked.archivedMessageCount).isEqualTo(11);
    assertThat(marked.messages).extracting(message -> message.id).doesNotContain(firstId);
    assertThat(marked.checkpoints.get(0).message().content)
        .isEqualTo("Important original decision and attachment");
    assertThat(marked.rollingContext).isEqualTo(plain.rollingContext);
    assertThat(TaskHistory.workingContext(marked, "original decision"))
        .isEqualTo(TaskHistory.workingContext(plain, "original decision"));
    repository.save(marked);
    assertThat(checkpoints.mark(task.id, firstId).checkpointRevision).isEqualTo(1);
    assertThat(checkpoints.remove(task.id, firstId).checkpoints).isEmpty();
    assertThatThrownBy(() -> checkpoints.mark(task.id, firstId))
        .isInstanceOf(NotFoundException.class)
        .hasMessageContaining("no longer available");
  }

  @Test
  void assistantMessagesCanBeMarkedWhileTaskIsActive() {
    var task = create("global");
    String userId = prompt(task, "Saved user prompt");
    tasks.completeAgentJob(
        Map.of("id", "job-a", "taskId", task.id, "status", "completed", "output", "Saved answer"));
    String assistantId = tasks.get(task.id).messages.get(1).id;
    try (var ignored = activity.reserve(task.id)) {
      assertThat(checkpoints.mark(task.id, userId).checkpoints).hasSize(1);
      assertThat(checkpoints.mark(task.id, assistantId).checkpoints).hasSize(2);
      assertThat(checkpoints.remove(task.id, userId).checkpoints).hasSize(1);
    }
    assertThat(tasks.get(task.id).checkpoints.get(0).message().role).isEqualTo("assistant");
  }

  @Test
  void sameTaskRevisionRetainsOnlyPrefixMarkersAndAdvancesCheckpointVersion() {
    var original = create("repository");
    String firstId = prompt(original, "Original prompt");
    String secondId = prompt(original, "Prompt to revise");
    checkpoints.mark(original.id, firstId);
    checkpoints.mark(original.id, secondId);
    var other = create("global");
    prompt(other, "Different chat");
    assertThatThrownBy(() -> checkpoints.mark(other.id, firstId))
        .isInstanceOf(NotFoundException.class);
    assertThat(tasks.get(other.id).checkpoints).isEmpty();
    var fork =
        (AiTask)
            tasks
                .revise(
                    original.id,
                    Map.of(
                        "requestId",
                        "edit-checkpoint",
                        "expectedRevisionCount",
                        0,
                        "messageId",
                        secondId,
                        "expectedContent",
                        "Prompt to revise",
                        "prompt",
                        "Edited prompt"))
                .get("task");
    assertThat(fork.messages).extracting(message -> message.id).containsExactly(firstId);
    assertThat(fork.id).isEqualTo(original.id);
    assertThat(fork.checkpoints).extracting(item -> item.messageId()).containsExactly(firstId);
    assertThat(fork.checkpointRevision).isEqualTo(3);
    checkpoints.mark(fork.id, firstId);
    checkpoints.remove(fork.id, firstId);
    assertThat(tasks.get(original.id).checkpoints).isEmpty();
    assertThat(tasks.get(original.id).checkpointRevision).isEqualTo(4);
  }

  @Test
  void invalidMissingAmbiguousAndNonChatMessagesNeverMutateStoredTask() throws Exception {
    var task = create("global");
    String first = prompt(task, "Saved prompt");
    byte[] before = Files.readAllBytes(taskPath(task));
    for (String invalid : new String[] {null, "", "../file", "a b", "a".repeat(201)}) {
      assertThatThrownBy(() -> checkpoints.mark(task.id, invalid))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> checkpoints.remove(task.id, invalid))
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThatThrownBy(() -> checkpoints.mark(task.id, "queued-or-unsent-message"))
        .isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> checkpoints.mark("../outside", first))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(Files.readAllBytes(taskPath(task))).isEqualTo(before);
    repository.mutate(
        task.id,
        value -> {
          var message = new TaskMessage();
          message.id = "internal-tool";
          message.role = "tool";
          message.content = "Internal tool output";
          value.messages.add(message);
        });
    assertThatThrownBy(() -> checkpoints.mark(task.id, "internal-tool"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("saved user or assistant");
    repository.mutate(
        task.id,
        value -> value.messages.add(mapper.convertValue(value.messages.get(0), TaskMessage.class)));
    assertThatThrownBy(() -> checkpoints.mark(task.id, first))
        .isInstanceOf(ConflictException.class);
    assertThat(tasks.get(task.id).checkpoints).isEmpty();
    assertThat(tasks.get(task.id).checkpointRevision).isZero();
  }

  @Test
  void legacyTasksNeedNoMigrationAndSnapshotsAreDetached() throws Exception {
    Path path = root.resolve("ai-tasks/legacy-task.json");
    Files.createDirectories(path.getParent());
    Files.writeString(
        path,
        """
        {"id":"legacy-task","scope":"global","title":"Legacy","updatedAt":"2026-09-01T00:00:00Z","messages":[{"role":"user","createdAt":"2026-09-01T00:00:00Z","content":"Legacy prompt"}],"checkpoints":null}
        """);
    var legacy = repository.get("legacy-task");
    assertThat(legacy.checkpointRevision).isZero();
    String messageId = legacy.messages.get(0).id;
    var marked = checkpoints.mark(legacy.id, messageId);
    marked.checkpoints.get(0).message().content = "Local detached mutation";
    assertThat(marked.messages.get(0).content).isEqualTo("Legacy prompt");
    var reloaded = repository().get(legacy.id);
    assertThat(reloaded.checkpoints.get(0).message().content).isEqualTo("Legacy prompt");
    assertThat(reloaded.updatedAt).isEqualTo("2026-09-01T00:00:00Z");
    assertThat(reloaded.messages.get(0).id).isEqualTo(messageId);
  }

  @Test
  void concurrentAppendAndMarkerChangesDoNotLoseMessagesOrResurrectMarkers() throws Exception {
    var task = create("global");
    String first = prompt(task, "Oldest saved prompt");
    checkpoints.mark(task.id, first);
    var start = new CountDownLatch(1);
    var executor = Executors.newFixedThreadPool(2);
    try {
      var appender =
          executor.submit(
              () -> {
                start.await();
                for (int i = 0; i < 60; i++) prompt(task, "Concurrent prompt " + i);
                return null;
              });
      var reader =
          executor.submit(
              () -> {
                start.await();
                for (int i = 0; i < 20; i++) {
                  assertThat(checkpoints.mark(task.id, first).checkpoints).hasSize(1);
                  assertThat(repository.get(task.id).checkpoints).hasSize(1);
                }
                checkpoints.remove(task.id, first);
                return null;
              });
      start.countDown();
      appender.get(20, TimeUnit.SECONDS);
      reader.get(20, TimeUnit.SECONDS);
    } finally {
      executor.shutdownNow();
      assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
    }
    var finalTask = repository().get(task.id);
    assertThat(finalTask.messages.size() + finalTask.archivedMessageCount).isEqualTo(61);
    assertThat(finalTask.messages.get(finalTask.messages.size() - 1).content)
        .isEqualTo("Concurrent prompt 59");
    assertThat(finalTask.checkpoints).isEmpty();
    assertThat(finalTask.checkpointRevision).isEqualTo(2);
  }
}
