package com.argus.tasks.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.agents.service.AgentQuestion;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.repository.TaskRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class TaskSteeringHistoryTest {
  @TempDir Path root;
  ObjectMapper mapper;
  TaskRepository repository;
  TaskService tasks;
  private static final String ACCEPTED = "2026-10-13T12:30:00Z";

  @BeforeEach
  void setup() {
    mapper = new ObjectMapper();
    repository =
        new TaskRepository(
            new ArgusProperties(root, null, "test", ""), new AtomicJsonStore(mapper), mapper);
    tasks = new TaskService(repository, new TaskActivityService(), mapper);
  }

  AiTask existingTask() {
    var task =
        tasks.create(
            fields(
                "scope",
                "global",
                "repositoryIds",
                List.of("repo-a"),
                "title",
                "Existing work",
                "provider",
                "codex",
                "model",
                "saved-model",
                "mode",
                "plan",
                "speed",
                "standard",
                "effort",
                "high",
                "contextMode",
                "history",
                "promptNotes",
                List.of(fields("id", "default", "text", "Current chat default", "enabled", true))));
    tasks.appendUser(
        task.id, fields("prompt", "Original request", "contextMode", "history"), List.of());
    return tasks.get(task.id);
  }

  Map<String, Object> queued(AiTask task, String requestId, String prompt) {
    return fields(
        "requestId",
        requestId,
        "taskId",
        task.id,
        "prompt",
        prompt,
        "providerId",
        "other-provider",
        "mode",
        "edit",
        "contextMode",
        "fresh",
        "modelSettings",
        fields("model", "queued-model", "speed", "fast", "effort", "low"),
        "promptNotes",
        List.of(fields("id", "note", "text", "Also run the focused tests", "enabled", true)),
        "attachments",
        List.of(
            fields(
                "id",
                "attachment-a",
                "title",
                "input.json",
                "kind",
                "file",
                "path",
                "/fixture/input.json")));
  }

  Map<String, Object> receipt(AiTask task, String requestId) {
    return fields(
        "requestId",
        requestId,
        "taskId",
        task.id,
        "jobId",
        "live-job",
        "turnId",
        "turn-a",
        "acceptedAt",
        ACCEPTED,
        "providerPayload",
        "not an audit field",
        "prompt",
        "assembled transport text");
  }

  void complete(AiTask task, String jobId) {
    tasks.completeAgentJob(
        fields(
            "id",
            jobId,
            "taskId",
            task.id,
            "provider",
            "codex",
            "status",
            "completed",
            "output",
            "Completed answer",
            "completedAt",
            "2026-10-13T12:31:00Z"));
  }

  @Test
  void acknowledgedInputBecomesOneCanonicalUserMessageWithoutChangingSavedDefaults()
      throws Exception {
    var task = existingTask();
    var queued = queued(task, "queued-1", "Also verify the cancellation path");
    var updated = tasks.appendSteeredUser(task.id, queued, receipt(task, "queued-1"));
    assertThat(updated.messages).hasSize(2);
    var message = updated.messages.get(1);
    assertThat(message.role).isEqualTo("user");
    assertThat(message.status).isEqualTo("steered");
    assertThat(message.content).isEqualTo(queued.get("prompt"));
    assertThat(message.createdAt).isEqualTo(ACCEPTED);
    assertThat(message.id).isNotBlank();
    assertThat(message.attachments).isEqualTo(queued.get("attachments"));
    assertThat(message.additionalProperties())
        .containsEntry("promptNotes", queued.get("promptNotes"))
        .containsEntry("contextMode", "history");
    assertThat(obj(message.additionalProperties().get("steering")))
        .containsExactlyInAnyOrderEntriesOf(
            fields(
                "requestId",
                "queued-1",
                "jobId",
                "live-job",
                "turnId",
                "turn-a",
                "acceptedAt",
                ACCEPTED));
    assertThat(updated.title).isEqualTo(task.title);
    assertThat(updated.scope).isEqualTo(task.scope);
    assertThat(updated.repositoryIds).isEqualTo(task.repositoryIds);
    assertThat(updated.provider).isEqualTo(task.provider);
    assertThat(updated.mode).isEqualTo(task.mode);
    assertThat(updated.model).isEqualTo(task.model);
    assertThat(updated.speed).isEqualTo(task.speed);
    assertThat(updated.effort).isEqualTo(task.effort);
    assertThat(updated.promptNotes).isEqualTo(task.promptNotes);
    assertThat(updated.additionalProperties()).containsEntry("contextMode", "history");
    assertThat(Files.readString(Path.of(updated.transcriptPath)))
        .contains("Original request", "Also verify the cancellation path")
        .doesNotContain("assembled transport text", "not an audit field");
    assertThat(tasks.workingContextWithMetrics(task.id, "cancellation").get("context").toString())
        .contains("Also verify the cancellation path", "/fixture/input.json");
  }

  @Test
  void replaysAreDurableNoOpsButCannotChangeAcceptedContentOrTurn() throws Exception {
    var task = existingTask();
    var queued = queued(task, "queued-1", "Extra request");
    var receipt = receipt(task, "queued-1");
    var first = tasks.appendSteeredUser(task.id, queued, receipt);
    byte[] saved = Files.readAllBytes(root.resolve("ai-tasks").resolve(task.id + ".json"));
    var restarted = new TaskService(repository, new TaskActivityService(), mapper);
    var reordered = new LinkedHashMap<>(queued);
    reordered.put(
        "attachments",
        List.of(
            fields(
                "path",
                "/fixture/input.json",
                "kind",
                "file",
                "title",
                "input.json",
                "id",
                "attachment-a")));
    var again = restarted.appendSteeredUser(task.id, reordered, receipt);
    assertThat(again.messages).hasSize(2);
    assertThat(again.messages.get(1).id).isEqualTo(first.messages.get(1).id);
    assertThat(Files.readAllBytes(root.resolve("ai-tasks").resolve(task.id + ".json")))
        .isEqualTo(saved);
    var changed = new LinkedHashMap<>(queued);
    changed.put("prompt", "Different request");
    assertThatThrownBy(() -> tasks.appendSteeredUser(task.id, changed, receipt))
        .isInstanceOf(ConflictException.class);
    var otherTurn = new LinkedHashMap<>(receipt);
    otherTurn.put("turnId", "turn-b");
    assertThatThrownBy(() -> tasks.appendSteeredUser(task.id, queued, otherTurn))
        .isInstanceOf(ConflictException.class);
    assertThat(tasks.get(task.id).messages).hasSize(2);
  }

  @Test
  void replayAfterRoleCompactionDoesNotReappendAndRetainsOriginalHistory() {
    var task = existingTask();
    var queued =
        queued(task, "queued-early", "Important steering decision: preserve original files");
    tasks.appendSteeredUser(task.id, queued, receipt(task, "queued-early"));
    for (int index = 0; index < 52; index++)
      tasks.appendUser(
          task.id, fields("prompt", "Later request " + index, "contextMode", "history"), List.of());
    var compacted = tasks.get(task.id);
    assertThat(compacted.messages).noneMatch(message -> "steered".equals(message.status));
    assertThat(compacted.rollingContext).contains("preserve original files", "/fixture/input.json");
    var replayed = tasks.appendSteeredUser(task.id, queued, receipt(task, "queued-early"));
    assertThat(replayed.messages).hasSize(compacted.messages.size());
    assertThat(replayed.archivedMessageCount).isEqualTo(compacted.archivedMessageCount);
    assertThat(replayed.rollingContext).isEqualTo(compacted.rollingContext);
  }

  @Test
  void completionBeforeOrAfterPersistenceKeepsUserBeforeAnswerAndSafeAudit() {
    for (boolean completionFirst : List.of(true, false)) {
      var task = existingTask();
      if (completionFirst) complete(task, "live-job");
      tasks.appendSteeredUser(
          task.id, queued(task, "queued-1", "Added while running"), receipt(task, "queued-1"));
      if (!completionFirst) complete(task, "live-job");
      var saved = tasks.get(task.id);
      assertThat(saved.messages)
          .extracting(message -> message.role)
          .containsExactly("user", "user", "assistant");
      assertThat(saved.messages.get(1).status).isEqualTo("steered");
      assertThat(saved.messages.get(2).content).isEqualTo("Completed answer");
      var audit = saved.messages.get(2).execution;
      assertThat(audit).containsEntry("steeredInputCount", 1);
      assertThat((List<?>) audit.get("steeringReceipts")).hasSize(1);
      assertThat(mapper.writeValueAsString(audit))
          .contains("queued-1", "turn-a")
          .doesNotContain(
              "Added while running", "assembled transport text", "fingerprint", "providerPayload");
    }
  }

  @Test
  void simultaneousReplaysAndCompletionHaveOneInputAndOneAnswer() throws Exception {
    var task = existingTask();
    var queued = queued(task, "queued-1", "Concurrent accepted input");
    var receipt = receipt(task, "queued-1");
    var start = new CountDownLatch(1);
    var jobs = new ArrayList<CompletableFuture<Void>>();
    for (int index = 0; index < 6; index++)
      jobs.add(
          CompletableFuture.runAsync(
              () -> {
                try {
                  start.await();
                } catch (InterruptedException failure) {
                  throw new RuntimeException(failure);
                }
                tasks.appendSteeredUser(task.id, queued, receipt);
              }));
    jobs.add(
        CompletableFuture.runAsync(
            () -> {
              try {
                start.await();
              } catch (InterruptedException failure) {
                throw new RuntimeException(failure);
              }
              complete(task, "live-job");
            }));
    start.countDown();
    CompletableFuture.allOf(jobs.toArray(CompletableFuture[]::new)).join();
    assertThat(tasks.get(task.id).messages)
        .extracting(message -> message.role)
        .containsExactly("user", "user", "assistant");
  }

  @Test
  void laterAcknowledgementPersistingFirstDoesNotReverseConversationOrCompletedAudit()
      throws Exception {
    for (boolean completionFirst : List.of(true, false)) {
      var task = existingTask();
      if (completionFirst) complete(task, "live-job");
      var first = receipt(task, "first");
      var second = receipt(task, "second");
      second.put("acceptedAt", "2026-10-13T12:30:00.001Z");
      // B reaches the task file while A is stalled after its earlier native acknowledgement.
      tasks.appendSteeredUser(task.id, queued(task, "second", "Second accepted addition"), second);
      tasks.appendSteeredUser(task.id, queued(task, "first", "First accepted addition"), first);
      if (!completionFirst) complete(task, "live-job");
      var saved = tasks.get(task.id);
      assertThat(saved.messages)
          .extracting(message -> message.content)
          .containsExactly(
              "Original request",
              "First accepted addition",
              "Second accepted addition",
              "Completed answer");
      var audit = saved.messages.get(3).execution;
      assertThat(audit).containsEntry("steeredInputCount", 2);
      assertThat((List<?>) audit.get("steeringReceipts"))
          .extracting(item -> ((Map<?, ?>) item).get("requestId").toString())
          .containsExactly("first", "second");
      assertThat(Files.readString(Path.of(saved.transcriptPath)))
          .containsSubsequence(
              "Original request",
              "First accepted addition",
              "Second accepted addition",
              "Completed answer");
    }
  }

  @Test
  void olderQueueWithoutNotesDoesNotInheritChangedChatDefaults() {
    var task = existingTask();
    var queued = queued(task, "legacy", "Legacy queued input");
    queued.remove("promptNotes");
    var result = tasks.appendSteeredUser(task.id, queued, receipt(task, "legacy"));
    assertThat((List<?>) result.messages.get(1).additionalProperties().get("promptNotes"))
        .isEmpty();
    assertThat(result.promptNotes).isEqualTo(task.promptNotes);
  }

  @Test
  void delayedSteeringHistoryCannotHideTheQuestionAskedByItsRunningTurn() {
    var task = existingTask();
    tasks.completeAgentJob(
        fields(
            "id",
            "live-job",
            "taskId",
            task.id,
            "provider",
            "codex",
            "status",
            "completed",
            "output",
            "Which private bucket should we use?",
            "completedAt",
            "2026-10-13T12:31:00Z"));
    var question = AgentQuestion.latest(tasks.get(task.id), mapper);
    assertThat(question).isNotEmpty();
    tasks.appendSteeredUser(
        task.id, queued(task, "delayed", "Preserve the old bucket"), receipt(task, "delayed"));
    assertThat(AgentQuestion.latest(tasks.get(task.id), mapper)).isEqualTo(question);
    assertThat(tasks.get(task.id).messages.get(2).role).isEqualTo("assistant");
  }

  @Test
  void invalidAcknowledgementOrCrossTaskItemCannotChangeHistory() {
    var task = existingTask();
    var queued = queued(task, "queued-1", "Extra request");
    for (String missing : List.of("jobId", "turnId", "acceptedAt")) {
      var receipt = receipt(task, "queued-1");
      receipt.remove(missing);
      assertThatThrownBy(() -> tasks.appendSteeredUser(task.id, queued, receipt))
          .isInstanceOf(IllegalArgumentException.class);
    }
    var receipt = receipt(task, "queued-1");
    receipt.put("acceptedAt", "not-an-instant");
    assertThatThrownBy(() -> tasks.appendSteeredUser(task.id, queued, receipt))
        .isInstanceOf(IllegalArgumentException.class);
    var wrongTask = queued(task, "queued-1", "Extra request");
    wrongTask.put("taskId", "other");
    assertThatThrownBy(() -> tasks.appendSteeredUser(task.id, wrongTask, receipt(task, "queued-1")))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(tasks.get(task.id).messages).hasSize(1);
  }
}
