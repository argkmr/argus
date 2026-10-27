package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskMessage;
import com.argus.workspace.domain.Repository;
import java.util.*;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class AgentQuestionReplyTest {
  final ObjectMapper mapper = new ObjectMapper();

  AiTask legacy() {
    var task = new AiTask();
    task.id = "task";
    task.scope = "global";
    task.repositoryId = "global";
    task.repositoryIds = List.of("creation-repo");
    task.provider = "changed-provider";
    task.model = "changed-model";
    task.mode = "edit";
    var message = new TaskMessage();
    message.id = "legacy-message";
    message.role = "assistant";
    message.status = "completed";
    message.provider = "codex";
    message.content = "Which private bucket should we use?";
    message.execution =
        fields(
            "provider",
            "codex",
            "model",
            "original-model",
            "access",
            "Read-only investigation",
            "contextMode",
            "fresh",
            "operationalSteps",
            List.of(
                fields(
                    "phase",
                    "skills",
                    "detail",
                    fields("repositories", List.of("last-run-repo")))));
    task.messages.add(message);
    return task;
  }

  Map<String, Object> reply(AiTask task) {
    return AgentQuestionReply.request(
        fields(
            "taskId",
            task.id,
            "requestId",
            "answer-1",
            "questionId",
            AgentQuestion.latest(task, mapper).get("id"),
            "answers",
            List.of(fields("id", "question-1", "answer", "The private existing bucket"))));
  }

  @Test
  void legacyNexusUsesLastRunScopeNotCreationScopeOrChangedPicker() {
    var task = legacy();
    var input = AgentQuestionReply.runInput(task, reply(task), mapper);
    assertThat(input)
        .containsEntry("repositoryIds", List.of("last-run-repo"))
        .containsEntry("provider", "codex")
        .containsEntry("model", "original-model")
        .containsEntry("mode", "plan")
        .containsEntry("effort", "auto")
        .containsEntry("speed", "standard");
  }

  @Test
  void questionContinuationKeepsOriginalNotesUnlessUserExplicitlyOverrides() {
    var task = legacy();
    var notes = List.of(fields("id", "original", "text", "Original note", "enabled", true));
    var original = AgentQuestionReply.runInput(task, reply(task), mapper);
    original.put("promptNotes", notes);
    task.messages.get(0).additionalProperties().put("questionContext", original);
    task.promptNotes = List.of(fields("id", "later", "text", "Later default", "enabled", true));
    assertThat(AgentQuestionReply.runInput(task, reply(task), mapper).get("promptNotes"))
        .isEqualTo(notes);
    var override = reply(task);
    override.put("promptNotes", List.of());
    assertThat(
            AgentQuestionReply.runInput(task, AgentQuestionReply.request(override), mapper)
                .get("promptNotes"))
        .isEqualTo(List.of());
    assertThat(AgentQuestionReply.fingerprint(reply(task), mapper))
        .isNotEqualTo(AgentQuestionReply.fingerprint(AgentQuestionReply.request(override), mapper));
  }

  @Test
  void unverifiableLegacyScopeFailsClosedInsteadOfExpandingToEveryRepo() {
    var task = legacy();
    task.messages.get(0).execution.remove("operationalSteps");
    assertThatThrownBy(() -> AgentQuestionReply.runInput(task, reply(task), mapper))
        .hasMessageContaining("chat composer");
  }

  @Test
  void completedAnswerRequestIdIsNeverReplayedEvenIfQuestionComesBack() {
    var task = legacy();
    var reply = reply(task);
    var earlier = new TaskMessage();
    earlier.role = "user";
    earlier.additionalProperties().put("questionReply", reply);
    task.messages.add(0, earlier);
    assertThatThrownBy(() -> AgentQuestionReply.runInput(task, reply, mapper))
        .hasMessageContaining("already recorded");
  }

  @Test
  void emptyDuplicateUnknownAndOversizedAnswersAreRejected() {
    var task = legacy();
    var request = reply(task);
    for (Object answers :
        List.of(
            List.of(),
            List.of(fields("id", "question-1", "answer", " ")),
            List.of(
                fields("id", "question-1", "answer", "ok"),
                fields("id", "question-1", "answer", "again")),
            List.of(fields("id", "question-1", "answer", "x".repeat(20_001))))) {
      var input = new LinkedHashMap<>(request);
      input.put("answers", answers);
      assertThatThrownBy(() -> AgentQuestionReply.request(input))
          .isInstanceOf(IllegalArgumentException.class);
    }
    request.put("answers", List.of(fields("id", "wrong-question", "answer", "ok")));
    assertThatThrownBy(() -> AgentQuestionReply.runInput(task, request, mapper))
        .hasMessageContaining("question selection changed");
  }

  @Test
  void sourceOccurrenceRejectsIdenticalQuestionFromAnotherMessage() {
    var task = legacy();
    var request = reply(task);
    task.messages.get(0).id = "new-identical-question";
    assertThatThrownBy(() -> AgentQuestionReply.runInput(task, request, mapper))
        .hasMessageContaining("no longer awaiting");
  }

  @Test
  void exactServerScopeCanKeepMoreThanSixWithoutAddingConnectedRepos() {
    var connected = new ArrayList<Repository>();
    for (int index = 0; index < 14; index++)
      connected.add(
          new Repository("repo-" + index, "Repo " + index, "/fixture/" + index, "", "main"));
    var original = connected.subList(0, 13).stream().map(Repository::id).toList();
    var scopes = new RepositoryScopeService();
    assertThat(scopes.questionReply(connected, original).repositories())
        .hasSize(13)
        .doesNotContain(connected.get(13));
    assertThatThrownBy(() -> scopes.questionReply(connected.subList(1, 14), original))
        .hasMessageContaining("no longer connected");
    assertThatThrownBy(() -> scopes.questionReply(connected, List.of()))
        .hasMessageContaining("safe saved repository scope");
  }
}
