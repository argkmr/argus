package com.argus.agents.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class AgentQuestionPromptTest {
  private final AgentPromptService prompts = new AgentPromptService(new ObjectMapper());

  @Test
  void freshNexusRepositoryConversationAndResumeAllExplainTheRealBatchReplyContract() {
    var repositories =
        List.<Map<String, Object>>of(
            Map.of("id", "fixture", "name", "Fixture", "path", "/fixture"));
    for (String prompt :
        List.of(
            prompts.build(Map.of("scope", "global", "prompt", "User asks"), repositories),
            prompts.build(Map.of("scope", "repository", "prompt", "User asks"), repositories),
            prompts.build(Map.of("conversationOnly", true, "prompt", "User asks"), repositories),
            prompts.continuation(Map.of("prompt", "User asks")))) {
      assertThat(prompt)
          .contains(
              "ARGUS INTERACTIVE QUESTIONS",
              "```argus-question",
              "end this turn",
              "not an approval bypass",
              "same chat",
              "User asks");
    }
  }

  @Test
  void internalRawPromptsAreNotRewritten() {
    assertThat(prompts.build(Map.of("rawPrompt", "Private internal operation"), List.of()))
        .isEqualTo("Private internal operation");
  }
}
