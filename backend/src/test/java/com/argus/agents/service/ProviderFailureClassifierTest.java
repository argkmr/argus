package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.ObjectMapper;

class ProviderFailureClassifierTest {
  private final ObjectMapper json = new ObjectMapper();

  private String event(Map<String, Object> value) {
    return json.writeValueAsString(value);
  }

  @Test
  void failedCodexToolOutputCannotPoisonProviderHealth() {
    String transcript =
        String.join(
            "\n",
            event(fields("type", "thread.started", "thread_id", "thread")),
            event(
                fields(
                    "type",
                    "item.completed",
                    "item",
                    fields(
                        "type",
                        "command_execution",
                        "command",
                        "cat test-fixture.json",
                        "aggregated_output",
                        "Line 402: out of tokens; HTTP 429; invalid API key; connection refused. Try again in 2 hours.",
                        "exit_code",
                        1))),
            event(
                fields(
                    "type",
                    "item.completed",
                    "item",
                    fields(
                        "type",
                        "agent_message",
                        "text",
                        "The service fixture contains insufficient_quota and HTTP 402, not a CLI account error."))),
            event(
                fields(
                    "type",
                    "turn.failed",
                    "error",
                    fields("message", "Command execution did not complete"))));
    assertThat(AgentExecutionService.classifyFailure(transcript, "Worker stopped with exit code 1"))
        .isEmpty();
  }

  @Test
  void mcpResultsAndClaudeModelNarrativeAreNotProviderErrors() {
    String transcript =
        String.join(
            "\n",
            event(
                fields(
                    "type",
                    "item.completed",
                    "item",
                    fields("type", "mcp_tool_call", "error", fields("message", "quota exceeded")))),
            event(
                fields(
                    "type",
                    "assistant",
                    "message",
                    fields(
                        "content",
                        List.of(fields("type", "text", "text", "API Error: 402 out of credits"))))),
            event(
                fields(
                    "type",
                    "user",
                    "message",
                    fields(
                        "content",
                        List.of(
                            fields(
                                "type",
                                "tool_result",
                                "is_error",
                                true,
                                "content",
                                "out of tokens"))))),
            event(
                fields(
                    "type",
                    "result",
                    "is_error",
                    false,
                    "result",
                    "The application authentication failed at source line 401.")));
    assertThat(AgentExecutionService.classifyFailure(transcript, "")).isEmpty();
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "402",
        "401",
        "429",
        "src/service.java:402: failed assertion",
        "402 tests passed",
        "The tool reported out of tokens. That is the bug we are fixing.",
        "Error: expected the fixture text to contain out of tokens",
        "Quota remaining: 50",
        "Rate limit information: 100 requests left",
        "Authentication method: OAuth",
        "{\"quota\":0,\"status\":402}",
        "\"Error: insufficient_quota\"",
        "```json\n{\"type\":\"error\",\"message\":\"out of tokens\"}\n```",
        "{\"type\":\"tool_result\",\"is_error\":true,\"result\":\"quota exceeded\"}"
      })
  void untrustedTextAndNumbersAreNotAvailabilityEvidence(String text) {
    assertThat(AgentExecutionService.classifyFailure(text, "")).isEmpty();
    assertThat(AgentExecutionService.classifyFailure("", text)).isEmpty();
  }

  @Test
  void protocolStreamsNeverPromoteUnwrappedTextOrPartialToolJson() {
    String transcript =
        event(fields("type", "thread.started", "thread_id", "thread"))
            + "\nout of tokens\n"
            + event(fields("type", "turn.failed", "error", fields("message", "Worker stopped")));
    assertThat(AgentExecutionService.classifyFailure(transcript, "")).isEmpty();
    String oversizedTool =
        event(
            fields(
                "type",
                "item.completed",
                "item",
                fields(
                    "type",
                    "command_execution",
                    "aggregated_output",
                    "out of tokens " + "x".repeat(150_000))));
    assertThat(AgentExecutionService.classifyFailure(oversizedTool, "")).isEmpty();
    assertThat(
            AgentExecutionService.classifyFailure(
                oversizedTool
                    + "\n"
                    + event(
                        fields(
                            "type",
                            "turn.failed",
                            "error",
                            fields("message", "HTTP 429 Too Many Requests"))),
                ""))
        .containsEntry("code", "rate_limited");
  }

  @ParameterizedTest
  @CsvSource(
      delimiter = '|',
      value = {
        "Error: insufficient_quota | quota_exhausted",
        "You have hit your usage limit. Try again tomorrow. | quota_exhausted",
        "Your credit balance is too low to access the Anthropic API. | quota_exhausted",
        "Your organization has disabled Claude subscription access for Claude Code | quota_exhausted",
        "API Error: 402 Payment Required | quota_exhausted",
        "HTTP 429 rate limit resets in 2 hours | rate_limited",
        "Error: rate limit reached | rate_limited",
        "API Error: 529 overloaded_error | rate_limited",
        "invalid api key | authentication_required",
        "Error: Not logged in | authentication_required",
        "HTTP 401 Unauthorized | authentication_required",
        "Error: fetch failed | provider_unavailable",
        "connection refused | provider_unavailable",
        "Request timed out | provider_unavailable"
      })
  void preservesRecognizablePlainCliDiagnostics(String text, String code) {
    assertThat(AgentExecutionService.classifyFailure(text, "")).containsEntry("code", code);
    assertThat(AgentExecutionService.classifyFailure("", text)).containsEntry("code", code);
  }

  @Test
  void authoritativeCodexErrorMessageWinsOverToolAndNarrativeContent() {
    String transcript =
        event(
                fields(
                    "type",
                    "item.completed",
                    "item",
                    fields("type", "agent_message", "text", "out of tokens, resets in 6 weeks")))
            + "\n"
            + event(fields("type", "error", "message", "HTTP 429 rate limit resets in 2 hours"));
    assertThat(AgentExecutionService.classifyFailure(transcript, "Error: invalid api key"))
        .containsEntry("code", "rate_limited")
        .containsEntry("resetHint", "2 hours");
  }

  @Test
  void nativeCodexTurnErrorsRecognizeStructuredCodeAndRetainOnlyTheirResetHint() {
    var error =
        fields(
            "message",
            "Try again in 2 hours.",
            "code",
            "usage_limit_reached",
            "data",
            fields("copiedToolOutput", "invalid api key"));
    for (var record :
        List.of(
            fields("type", "turn.failed", "error", error),
            fields("type", "error", "error", error),
            fields(
                "method",
                "turn/completed",
                "params",
                fields("turn", fields("status", "failed", "error", error))),
            fields("method", "error", "params", fields("error", error)))) {
      assertThat(AgentExecutionService.classifyFailure(event(record), ""))
          .containsEntry("code", "quota_exhausted")
          .containsEntry("resetHint", "2 hours");
    }
  }

  @Test
  void arbitraryNestedErrorDataAndNonErrorEventsAreNotScanned() {
    assertThat(
            AgentExecutionService.classifyFailure(
                event(
                    fields(
                        "type",
                        "error",
                        "error",
                        fields(
                            "message",
                            "Command stopped",
                            "details",
                            fields("tool", "out of tokens")))),
                ""))
        .isEmpty();
    assertThat(
            AgentExecutionService.classifyFailure(
                event(
                    fields("type", "turn.completed", "error", fields("message", "quota exceeded"))),
                ""))
        .isEmpty();
  }

  @Test
  void explicitClaudeErrorResultsRemainRecognizable() {
    for (var record :
        List.of(
            fields("type", "result", "is_error", true, "result", "Your credit balance is too low"),
            fields(
                "is_error",
                true,
                "result",
                "Your organization has disabled Claude subscription access"),
            fields("type", "result", "is_error", true, "errors", List.of("insufficient_quota")),
            fields(
                "type",
                "assistant",
                "error",
                "billing_error",
                "message",
                fields("content", List.of())))) {
      assertThat(AgentExecutionService.classifyFailure(event(record), ""))
          .containsEntry("code", "quota_exhausted");
    }
  }

  @Test
  void onlyExplicitHttpStatusInsideAnErrorEnvelopeIsClassified() {
    assertThat(
            AgentExecutionService.classifyFailure(
                event(
                    fields(
                        "type",
                        "turn.failed",
                        "error",
                        fields("message", "Rejected", "status_code", 402))),
                ""))
        .containsEntry("code", "quota_exhausted");
    assertThat(
            AgentExecutionService.classifyFailure(
                event(fields("type", "turn.failed", "error", fields("message", "402"))), ""))
        .isEmpty();
  }
}
