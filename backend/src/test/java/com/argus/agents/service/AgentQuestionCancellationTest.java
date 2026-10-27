package com.argus.agents.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.error.ConflictException;
import com.argus.tasks.domain.AiTask;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class AgentQuestionCancellationTest {
  private final String questionId = "job-one:question-" + "a".repeat(24);

  @Test
  void acceptsOnlyQuestionIdentityAndNeverCallerChosenJobOrAnswer() {
    var input =
        new HashMap<String, Object>(
            Map.of(
                "taskId",
                "task-one",
                "requestId",
                "cancel-one",
                "questionId",
                questionId,
                "jobId",
                "unrelated-job",
                "expectedJobId",
                "other",
                "prompt",
                "continue",
                "answers",
                "not needed"));
    assertThat(AgentQuestionCancellation.request(input))
        .containsOnly(
            entry("taskId", "task-one"),
            entry("requestId", "cancel-one"),
            entry("questionId", questionId));
  }

  @Test
  void rejectsMissingMalformedAndUnboundedIdentity() {
    assertThatThrownBy(() -> AgentQuestionCancellation.request(null))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> AgentQuestionCancellation.request(Map.of()))
        .isInstanceOf(IllegalArgumentException.class);
    for (String key : new String[] {"taskId", "requestId", "questionId"})
      for (Object invalid : new Object[] {"", " ", "x".repeat(251), "bad\0id", 10}) {
        var input =
            new HashMap<String, Object>(
                Map.of("taskId", "task-one", "requestId", "cancel-one", "questionId", questionId));
        input.put(key, invalid);
        assertThatThrownBy(() -> AgentQuestionCancellation.request(input))
            .isInstanceOf(IllegalArgumentException.class);
      }
    for (String invalid :
        new String[] {
          "question-only",
          "../job:question-" + "a".repeat(24),
          "job:question-short",
          "job:question-" + "a".repeat(25)
        })
      assertThatThrownBy(
              () ->
                  AgentQuestionCancellation.request(
                      Map.of(
                          "taskId", "task-one", "requestId", "cancel-one", "questionId", invalid)))
          .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void receiptRequiresCorrectTaskAndDurableCancelledStatus() {
    var task = new AiTask();
    task.id = "task-one";
    var request =
        AgentQuestionCancellation.request(
            Map.of("taskId", task.id, "requestId", "cancel-one", "questionId", questionId));
    assertThat(AgentQuestionCancellation.receipt(task, request)).isEmpty();
    task.additionalProperties()
        .put(
            "questionCancellation",
            Map.of(
                "requestId",
                "cancel-one",
                "questionId",
                questionId,
                "status",
                "pending",
                "cancelledAt",
                "2026-09-10T00:00:00Z"));
    assertThat(AgentQuestionCancellation.receipt(task, request)).isEmpty();
    task.id = "different";
    assertThatThrownBy(() -> AgentQuestionCancellation.receipt(task, request))
        .isInstanceOf(ConflictException.class);
  }
}
