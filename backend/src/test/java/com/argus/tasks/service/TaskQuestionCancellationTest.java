package com.argus.tasks.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.agents.service.AgentQuestion;
import com.argus.agents.service.AgentQuestionCancellation;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskMessage;
import com.argus.tasks.repository.TaskRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.ObjectMapper;

class TaskQuestionCancellationTest {
  @TempDir Path root;
  ObjectMapper mapper;
  TaskRepository repository;
  TaskService tasks;
  private static final String QUESTION = "Which target should we use?";
  private static final String BLOCK =
      "```argus-question\n{\"questions\":[{\"id\":\"target\",\"question\":\""
          + QUESTION
          + "\"}]}\n```";

  @BeforeEach
  void setup() {
    mapper = new ObjectMapper();
    var properties = new ArgusProperties(root, null, "test", "");
    repository = new TaskRepository(properties, new AtomicJsonStore(mapper), mapper);
    tasks = new TaskService(repository, new TaskActivityService(), mapper);
  }

  AiTask questionTask(String scope, boolean structured) {
    var task = tasks.create(fields("scope", scope, "repositoryId", "repo-a"));
    tasks.appendUser(task.id, fields("prompt", "Investigate this issue"), List.of());
    tasks.completeAgentJob(
        fields(
            "id",
            "question-job",
            "taskId",
            task.id,
            "provider",
            "codex",
            "status",
            "completed",
            "output",
            structured ? BLOCK : QUESTION));
    return tasks.get(task.id);
  }

  @Test
  void completedQuestionCancellationSurvivesReloadWithoutChangingMessageTextOrStatus()
      throws Exception {
    for (String scope : List.of("repository", "global")) {
      var task = questionTask(scope, true);
      var message = task.messages.get(1);
      String questionId = AgentQuestion.latest(task, mapper).get("id").toString();
      String transcript = Files.readString(Path.of(task.transcriptPath));
      var cancelled = tasks.cancelQuestion(task.id, "cancel-1", questionId, "");
      assertThat(cancelled.messages).hasSize(2);
      assertThat(cancelled.messages.get(1).content).isEqualTo(message.content);
      assertThat(cancelled.messages.get(1).status).isEqualTo("completed");
      assertThat(cancelled.messages.get(1).id).isEqualTo(message.id);
      var receipt =
          obj(cancelled.messages.get(1).additionalProperties().get("questionCancellation"));
      assertThat(receipt)
          .containsEntry("requestId", "cancel-1")
          .containsEntry("questionId", questionId)
          .containsEntry("status", "cancelled")
          .containsEntry("jobId", "question-job");
      assertThat(Instant.parse(receipt.get("cancelledAt").toString())).isNotNull();
      assertThat(cancelled.additionalProperties().get("questionCancellation")).isEqualTo(receipt);
      var reload = new TaskService(repository, new TaskActivityService(), mapper).get(task.id);
      assertThat(AgentQuestion.latest(reload, mapper)).isEmpty();
      assertThat(reload.messages.get(1).additionalProperties().get("questionCancellation"))
          .isEqualTo(receipt);
      assertThat(Files.readString(Path.of(task.transcriptPath)))
          .contains("Investigate this issue", message.content);
      assertThat(transcript).contains(message.content);
    }
  }

  @Test
  void legacySuggestedQuestionIsAlsoDurablyCancelled() {
    var task = tasks.create(fields("scope", "global"));
    var message = new TaskMessage();
    message.id = "legacy-question";
    message.role = "assistant";
    message.status = "completed";
    message.content = QUESTION;
    task.messages.add(message);
    repository.save(task);
    String questionId = AgentQuestion.latest(tasks.get(task.id), mapper).get("id").toString();
    assertThat(questionId).startsWith("legacy-question:");
    tasks.cancelQuestion(task.id, "cancel-legacy", questionId, "");
    assertThat(AgentQuestion.latest(tasks.get(task.id), mapper)).isEmpty();
    assertThat(tasks.get(task.id).messages.get(0).content).isEqualTo(QUESTION);
  }

  @Test
  void repeatCancellationIsIdempotentButCannotReuseItsIdToCancelAnotherQuestion() throws Exception {
    var task = questionTask("global", true);
    String questionId = AgentQuestion.latest(task, mapper).get("id").toString();
    var first = tasks.cancelQuestion(task.id, "same-request", questionId, "");
    var receipt = first.additionalProperties().get("questionCancellation");
    byte[] saved = Files.readAllBytes(root.resolve("ai-tasks").resolve(task.id + ".json"));
    assertThat(tasks.cancelQuestion(task.id, "same-request", questionId, "").additionalProperties())
        .containsEntry("questionCancellation", receipt);
    assertThat(Files.readAllBytes(root.resolve("ai-tasks").resolve(task.id + ".json")))
        .isEqualTo(saved);
    tasks.appendUser(task.id, fields("prompt", "A new request"), List.of());
    tasks.completeAgentJob(
        fields(
            "id",
            "second-job",
            "taskId",
            task.id,
            "provider",
            "codex",
            "status",
            "completed",
            "output",
            BLOCK));
    String nextQuestion = AgentQuestion.latest(tasks.get(task.id), mapper).get("id").toString();
    assertThatThrownBy(() -> tasks.cancelQuestion(task.id, "same-request", nextQuestion, ""))
        .isInstanceOf(ConflictException.class);
    assertThat(AgentQuestion.latest(tasks.get(task.id), mapper)).containsEntry("id", nextQuestion);
    var replay = tasks.cancelQuestion(task.id, "same-request", questionId, "");
    assertThat(AgentQuestion.latest(replay, mapper)).containsEntry("id", nextQuestion);
    assertThat(replay.messages.get(3).additionalProperties())
        .doesNotContainKey("questionCancellation");
  }

  @Test
  void staleQuestionCannotCancelNewUserMessageOrDifferentChat() {
    var task = questionTask("repository", true);
    String questionId = AgentQuestion.latest(task, mapper).get("id").toString();
    tasks.appendUser(task.id, fields("prompt", "Continue a different direction"), List.of());
    assertThatThrownBy(() -> tasks.cancelQuestion(task.id, "stale", questionId, "question-job"))
        .isInstanceOf(ConflictException.class);
    var other = tasks.create(fields("scope", "repository", "repositoryId", "repo-b"));
    assertThatThrownBy(
            () -> tasks.cancelQuestion(other.id, "wrong-chat", questionId, "question-job"))
        .isInstanceOf(ConflictException.class);
    assertThat(tasks.get(task.id).messages).hasSize(3);
    assertThat(tasks.get(other.id).messages).isEmpty();
  }

  @ParameterizedTest
  @ValueSource(strings = {"cancelled", "failed"})
  void stoppedLiveQuestionMarksOnlyTheValidatedDrainedJobEvenWithoutPendingProjection(
      String status) {
    var task = tasks.create(fields("scope", "global"));
    tasks.appendUser(task.id, fields("prompt", "Investigate this issue"), List.of());
    String questionId =
        AgentQuestion.scoped("live-job", AgentQuestion.parse(BLOCK, mapper)).get("id").toString();
    tasks.completeAgentJob(
        fields(
            "id",
            "live-job",
            "taskId",
            task.id,
            "provider",
            "codex",
            "status",
            status,
            "output",
            BLOCK));
    assertThat(AgentQuestion.latest(tasks.get(task.id), mapper)).isEmpty();
    assertThatThrownBy(() -> tasks.cancelQuestion(task.id, "cancel-live", questionId, "other-job"))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> tasks.cancelQuestion(task.id, "cancel-live", questionId, ""))
        .isInstanceOf(ConflictException.class);
    var cancelled = tasks.cancelQuestion(task.id, "cancel-live", questionId, "live-job");
    assertThat(cancelled.messages.get(1).status).isEqualTo(status);
    assertThat(cancelled.messages.get(1).content).contains(QUESTION);
    assertThat(obj(cancelled.messages.get(1).additionalProperties().get("questionCancellation")))
        .containsEntry("questionId", questionId)
        .containsEntry("jobId", "live-job");
  }

  @Test
  void mismatchedCancellationMetadataDoesNotHideAnotherQuestion() {
    var task = questionTask("repository", true);
    String questionId = AgentQuestion.latest(task, mapper).get("id").toString();
    task.messages
        .get(1)
        .additionalProperties()
        .put(
            "questionCancellation",
            Map.of(
                "questionId",
                "other:question-" + "a".repeat(24),
                "requestId",
                "old",
                "status",
                "cancelled",
                "cancelledAt",
                Instant.now().toString()));
    assertThat(AgentQuestion.latest(task, mapper)).containsEntry("id", questionId);
    assertThat(
            AgentQuestionCancellation.receipt(
                task,
                Map.of("taskId", task.id, "requestId", "cancel-new", "questionId", questionId)))
        .isEmpty();
  }
}
