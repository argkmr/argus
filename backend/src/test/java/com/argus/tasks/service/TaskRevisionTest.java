package com.argus.tasks.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskHistory;
import com.argus.tasks.domain.TaskMessage;
import com.argus.tasks.repository.PromptQueueRepository;
import com.argus.tasks.repository.TaskRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.ObjectMapper;

class TaskRevisionTest {
  @TempDir Path root;
  ObjectMapper mapper = new ObjectMapper();
  ArgusProperties properties;
  TaskRepository repository;
  TaskActivityService activity;
  TaskService tasks;

  @BeforeEach
  void setup() {
    properties = new ArgusProperties(root, null, "test", "");
    repository = new TaskRepository(properties, new AtomicJsonStore(mapper), mapper);
    activity = new TaskActivityService();
    tasks = new TaskService(repository, activity, mapper);
  }

  AiTask create(String scope) {
    return tasks.create(
        fields(
            "scope",
            scope,
            "repositoryId",
            "repo-a",
            "repositoryIds",
            List.of("repo-a", "repo-b"),
            "title",
            "Keep my title",
            "provider",
            "codex",
            "model",
            "fixture-model",
            "speed",
            "fast",
            "effort",
            "high"));
  }

  Map<String, Object> edit(AiTask task, int message, String requestId, int count, String text) {
    var original = task.messages.get(message);
    return fields(
        "requestId",
        requestId,
        "expectedRevisionCount",
        count,
        "messageId",
        original.id,
        "expectedContent",
        original.content,
        "prompt",
        text);
  }

  @ParameterizedTest
  @ValueSource(strings = {"global", "repository"})
  void cancelledResponseIsArchivedAndLateCompletionCannotRestoreItsSession(String scope) {
    var task = create(scope);
    tasks.appendUser(task.id, fields("prompt", "First"), List.of());
    tasks.completeAgentJob(
        fields("id", "first", "taskId", task.id, "status", "completed", "output", "Prefix answer"));
    var attachment =
        fields("id", "evidence", "kind", "file", "path", root.resolve("file").toString());
    tasks.appendUser(
        task.id,
        fields(
            "prompt",
            "Second",
            "promptNotes",
            List.of(fields("id", "note", "text", "Check tests", "enabled", true))),
        List.of(attachment));
    var cancelled =
        fields(
            "id",
            "cancelled",
            "taskId",
            task.id,
            "status",
            "cancelled",
            "output",
            "Cancelled suffix",
            "provider",
            "codex",
            "cliSessionId",
            "old-context",
            "repositoryIds",
            task.repositoryIds);
    tasks.completeAgentJob(cancelled);
    repository.mutate(
        task.id,
        draft -> draft.additionalProperties().put("questionCancellation", fields("id", "old")));
    var source = tasks.get(task.id);
    var response = tasks.revise(task.id, edit(source, 2, "edit-one", 0, "Revised"));
    var revised = (AiTask) response.get("task");
    assertThat(revised.id).isEqualTo(task.id);
    assertThat(revised.createdAt).isEqualTo(task.createdAt);
    assertThat(revised.title).isEqualTo("Keep my title");
    assertThat(revised.repositoryIds).isEqualTo(task.repositoryIds);
    assertThat(revised.model).isEqualTo("fixture-model");
    assertThat(revised.speed).isEqualTo("fast");
    assertThat(revised.messages)
        .extracting(m -> m.content)
        .containsExactly("First", "Prefix answer");
    assertThat(revised.additionalProperties()).doesNotContainKey("questionCancellation");
    assertThat(((Number) revised.additionalProperties().get("revisionCount")).longValue())
        .isEqualTo(1);
    assertThat(obj(revised.additionalProperties().get("revisionOf")))
        .containsEntry("taskId", task.id)
        .containsEntry("createdAt", revised.additionalProperties().get("revisionCutoffAt"));
    var draft = obj(revised.additionalProperties().get("revisionDraft"));
    assertThat(draft).containsEntry("requestId", "edit-one");
    assertThat(draft.get("attachments")).isEqualTo(List.of(attachment));
    assertThat(draft.get("promptNotes"))
        .isEqualTo(source.messages.get(2).additionalProperties().get("promptNotes"));
    var snapshot =
        (AiTask) tasks.revision(task.id, response.get("revisionId").toString()).get("task");
    assertThat((Object) mapper.valueToTree(snapshot)).isEqualTo(mapper.valueToTree(source));
    tasks.completeAgentJob(cancelled);
    assertThat(tasks.get(task.id).messages).hasSize(2);
    assertThat(tasks.cliSession(task.id, "codex", task.repositoryIds)).isEmpty();
    assertThat(tasks.get(task.id).completedJobIds).containsExactly("first", "cancelled");
    assertThat(tasks.list(scope, null)).hasSize(1);
    assertThat(tasks.workingContextWithMetrics(task.id, "Revised").toString())
        .doesNotContain("Cancelled suffix", "Second");
  }

  @Test
  void durableReplayDuringAnActiveRunDoesNotRestoreConsumedDraftOrCreateAnotherArchive()
      throws Exception {
    var task = create("global");
    tasks.appendUser(task.id, fields("prompt", "Original"), List.of());
    var request = edit(tasks.get(task.id), 0, "durable-request", 0, "Revised");
    var first = tasks.revise(task.id, request);
    var draft = obj(((AiTask) first.get("task")).additionalProperties().get("revisionDraft"));
    String runRequestId = draft.get("runRequestId").toString();
    tasks.updateRevisionDraft(task.id, fields("expectedPrompt", "Revised", "prompt", "Revised"));
    assertThat(obj(tasks.get(task.id).additionalProperties().get("revisionDraft")))
        .containsEntry("runRequestId", runRequestId);
    tasks.appendUser(task.id, fields("prompt", "Revised"), List.of());
    var restarted =
        new TaskService(
            new TaskRepository(properties, new AtomicJsonStore(mapper), mapper), activity, mapper);
    byte[] before = Files.readAllBytes(root.resolve("ai-tasks").resolve(task.id + ".json"));
    try (var running = activity.reserve(task.id)) {
      var replay = restarted.revise(task.id, request);
      assertThat(replay)
          .containsEntry("replayed", true)
          .containsEntry("revisionId", first.get("revisionId"));
      assertThat(((AiTask) replay.get("task")).additionalProperties())
          .doesNotContainKey("revisionDraft");
    }
    assertThat(Files.readAllBytes(root.resolve("ai-tasks").resolve(task.id + ".json")))
        .isEqualTo(before);
    assertThat(restarted.revisions(task.id)).hasSize(1);
    assertThat(restarted.get(task.id).messages)
        .extracting(m -> m.content)
        .containsExactly("Revised");
    var changed = new java.util.LinkedHashMap<>(request);
    changed.put("prompt", "Different");
    assertThatThrownBy(() -> restarted.revise(task.id, changed))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void repeatedEditsKeepNewestFirstImmutableSnapshotsAndRejectStaleTabs() throws Exception {
    var task = create("repository");
    tasks.appendUser(task.id, fields("prompt", "Original"), List.of());
    var originalRequest = edit(tasks.get(task.id), 0, "one", 0, "First edit");
    var first = tasks.revise(task.id, originalRequest);
    String firstId = first.get("revisionId").toString();
    byte[] snapshotBytes =
        Files.readAllBytes(
            root.resolve("ai-tasks/revisions").resolve(task.id).resolve(firstId + ".json"));
    tasks.appendUser(task.id, fields("prompt", "First edit"), List.of());
    var stale = edit(tasks.get(task.id), 0, "stale-tab", 0, "Should reject");
    assertThatThrownBy(() -> tasks.revise(task.id, stale)).isInstanceOf(ConflictException.class);
    var second = tasks.revise(task.id, edit(tasks.get(task.id), 0, "two", 1, "Second edit"));
    assertThat(tasks.revisions(task.id))
        .extracting(s -> s.get("id"))
        .containsExactly(second.get("revisionId"), firstId);
    assertThat(tasks.revisions(task.id).get(0).keySet())
        .containsExactlyInAnyOrder(
            "id", "createdAt", "messageCount", "editedMessageId", "promptPreview");
    assertThat(
            Files.readAllBytes(
                root.resolve("ai-tasks/revisions").resolve(task.id).resolve(firstId + ".json")))
        .isEqualTo(snapshotBytes);
    var replay = tasks.revise(task.id, originalRequest);
    assertThat(obj(((AiTask) replay.get("task")).additionalProperties().get("revisionDraft")))
        .containsEntry("requestId", "two")
        .containsEntry("prompt", "Second edit");
    assertThat(tasks.list(null, null)).hasSize(1);
    assertThatThrownBy(() -> tasks.revision(task.id, "../../elsewhere"))
        .isInstanceOf(NotFoundException.class);
    var draft = obj(tasks.get(task.id).additionalProperties().get("revisionDraft"));
    assertThatThrownBy(
            () ->
                tasks.updateRevisionDraft(
                    task.id,
                    fields(
                        "expectedPrompt",
                        "Second edit",
                        "prompt",
                        "Wrong generation",
                        "expectedRevisionCount",
                        1)))
        .isInstanceOf(ConflictException.class);
    tasks.updateRevisionDraft(
        task.id, fields("expectedPrompt", "Second edit", "prompt", "Updated draft"));
    assertThat(
            obj(tasks.get(task.id).additionalProperties().get("revisionDraft")).get("runRequestId"))
        .isNotEqualTo(draft.get("runRequestId"));
    assertThat(tasks.get(task.id).title).isEqualTo("Keep my title");
  }

  @Test
  void queueIsPreservedAndPreparedEnqueuesCannotCrossTheRevisionBoundary() {
    var queue =
        new PromptQueueService(
            new PromptQueueRepository(properties, new AtomicJsonStore(mapper), mapper), mapper);
    var guarded = new TaskService(repository, activity, mapper, queue);
    var task = create("repository");
    tasks.appendUser(task.id, fields("prompt", "Original"), List.of());
    var request = edit(tasks.get(task.id), 0, "queue-edit", 0, "Revised");
    long preparedEpoch = activity.queueEpoch(task.id);
    queue.enqueue(
        task,
        fields(
            "requestId",
            "queued",
            "taskId",
            task.id,
            "repositoryId",
            task.repositoryId,
            "repositoryIds",
            task.repositoryIds,
            "prompt",
            "Queued original branch",
            "providerId",
            "codex"),
        List.of());
    assertThatThrownBy(() -> guarded.revise(task.id, request))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("queued prompts");
    assertThat(queue.list(task.id)).hasSize(1);
    assertThat(tasks.get(task.id).messages).hasSize(1);
    assertThat(tasks.revisions(task.id)).isEmpty();
    assertThatThrownBy(
            () -> activity.acceptQueuedPrompt(task.id, preparedEpoch, () -> "must not save"))
        .isInstanceOf(ConflictException.class);
    queue.purgeTasks(List.of(task.id));
    long secondEpoch = activity.queueEpoch(task.id);
    guarded.revise(task.id, request);
    assertThatThrownBy(
            () -> activity.acceptQueuedPrompt(task.id, secondEpoch, () -> "must not save"))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void explicitTaskDeletionRemovesOnlyThatTasksSnapshotsWithoutFollowingLinks() throws Exception {
    var first = create("global");
    var second = create("repository");
    for (var task : List.of(first, second)) {
      tasks.appendUser(task.id, fields("prompt", "Original"), List.of());
      tasks.revise(task.id, edit(tasks.get(task.id), 0, "delete-fixture", 0, "Revised"));
    }
    Path firstDirectory = root.resolve("ai-tasks/revisions").resolve(first.id);
    Path secondDirectory = root.resolve("ai-tasks/revisions").resolve(second.id);
    tasks.remove(first.id);
    assertThat(firstDirectory).doesNotExist();
    assertThat(secondDirectory).isDirectory();
    assertThat(tasks.revisions(second.id)).hasSize(1);
    Path outside = root.resolve("outside-snapshot.json");
    Files.writeString(outside, "do not remove");
    Path secondSnapshot =
        secondDirectory.resolve(tasks.revisions(second.id).get(0).get("id") + ".json");
    Files.delete(secondSnapshot);
    Files.createSymbolicLink(secondSnapshot, outside);
    tasks.remove(second.id);
    assertThat(Files.readString(outside)).isEqualTo("do not remove");
    assertThat(secondDirectory).doesNotExist();
  }

  @Test
  void manifestCommitFailureIsVisibleAndReplaysWithoutRepeatingTheEdit() {
    var task = create("global");
    tasks.appendUser(task.id, fields("prompt", "Original"), List.of());
    var request = edit(tasks.get(task.id), 0, "manifest-recovery", 0, "Revised");
    var failingStore =
        new AtomicJsonStore(mapper) {
          int writes;

          @Override
          public void write(Path path, Object value) {
            if (path.equals(
                    root.resolve("ai-tasks/revisions").resolve(task.id).resolve("index.json"))
                && ++writes == 2)
              throw new IllegalStateException("Fixture interrupted manifest commit");
            super.write(path, value);
          }
        };
    var interrupted =
        new TaskService(new TaskRepository(properties, failingStore, mapper), activity, mapper);
    assertThatThrownBy(() -> interrupted.revise(task.id, request))
        .hasMessageContaining("manifest commit");
    assertThat(tasks.revisions(task.id)).hasSize(1);
    var replay = tasks.revise(task.id, request);
    assertThat(replay).containsEntry("replayed", true);
    assertThat(
            ((Number) ((AiTask) replay.get("task")).additionalProperties().get("revisionCount"))
                .longValue())
        .isEqualTo(1);
    tasks.appendUser(task.id, fields("prompt", "Revised"), List.of());
    tasks.revise(task.id, edit(tasks.get(task.id), 0, "after-manifest", 1, "Again"));
    assertThat(tasks.revisions(task.id)).hasSize(2);
  }

  @Test
  void interruptedWriteRecoversExactlyOnceAndNeverDropsTheOriginalConversation() {
    var task = create("global");
    tasks.appendUser(task.id, fields("prompt", "Original"), List.of());
    var request = edit(tasks.get(task.id), 0, "recover", 0, "Revised");
    var failingStore =
        new AtomicJsonStore(mapper) {
          boolean fail = true;

          @Override
          public void write(Path path, Object value) {
            if (fail && path.equals(root.resolve("ai-tasks").resolve(task.id + ".json"))) {
              fail = false;
              throw new IllegalStateException("Fixture interrupted task write");
            }
            super.write(path, value);
          }
        };
    var recovering =
        new TaskService(new TaskRepository(properties, failingStore, mapper), activity, mapper);
    assertThatThrownBy(() -> recovering.revise(task.id, request))
        .hasMessageContaining("Fixture interrupted");
    assertThat(tasks.get(task.id).messages).extracting(m -> m.content).containsExactly("Original");
    assertThat(tasks.revisions(task.id)).isEmpty();
    var accepted = recovering.revise(task.id, request);
    assertThat(tasks.revisions(task.id)).hasSize(1);
    assertThat(tasks.get(task.id).messages).isEmpty();
    assertThat(
            ((AiTask) tasks.revision(task.id, accepted.get("revisionId").toString()).get("task"))
                .messages)
        .extracting(m -> m.content)
        .containsExactly("Original");
  }

  @Test
  void onlyProvenContiguousCompactionSurvivesRevision() {
    var task = create("repository");
    for (int i = 0; i < 101; i++) {
      var message = new TaskMessage();
      message.role = i % 2 == 0 ? "user" : "assistant";
      message.content = "Message " + i;
      task.messages.add(message);
    }
    repository.save(task);
    assertThat(task.additionalProperties()).containsEntry("rollingContextIsPrefix", true);
    tasks.revise(task.id, edit(task, 1, "prefix", 0, "Revised"));
    assertThat(tasks.get(task.id).rollingContext).contains("Message 0").doesNotContain("Message 2");
    assertThat(tasks.get(task.id).archivedMessageCount).isEqualTo(1);

    var interleaved = create("global");
    for (int i = 0; i < 52; i++) {
      var message = new TaskMessage();
      message.role = i == 0 ? "user" : "assistant";
      message.content = "Interleaved " + i;
      interleaved.messages.add(message);
    }
    TaskHistory.cap(interleaved);
    assertThat(interleaved.additionalProperties()).containsEntry("rollingContextIsPrefix", false);
    repository.save(interleaved);
    var result = tasks.revise(interleaved.id, edit(interleaved, 0, "mixed", 0, "Revised"));
    assertThat(tasks.get(interleaved.id).rollingContext).isEmpty();
    var snapshot =
        (AiTask) tasks.revision(interleaved.id, result.get("revisionId").toString()).get("task");
    assertThat(snapshot.rollingContext).contains("Interleaved 1");
  }
}
