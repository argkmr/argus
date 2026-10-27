package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import java.util.*;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class ProviderTokenUsageTest {
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void failedObserverDiagnosticIsPreservedThroughUsageAndCost() {
    var tracker = new ProviderTokenUsage("codex", "gpt-5.6-sol", "standard");
    tracker.beginAttempt();
    tracker.recordCodexRollout(
        fields(
            "reported",
            false,
            "detail",
            "The rollout window is unavailable. No estimate is substituted."));
    tracker.finish(false);
    var result = tracker.snapshot();
    assertThat(result).containsEntry("reported", false).containsEntry("totalTokens", null);
    assertThat(result.get("detail").toString()).contains("rollout window");
    assertThat(obj(result.get("costEstimate")).get("detail")).isEqualTo(result.get("detail"));
  }

  private ProviderTokenUsage tracker(String provider) {
    var tracker = new ProviderTokenUsage(provider);
    tracker.beginAttempt();
    return tracker;
  }

  private Map<String, Object> model(long input, long output, long read, long write) {
    return fields(
        "inputTokens",
        input,
        "outputTokens",
        output,
        "cacheReadInputTokens",
        read,
        "cacheCreationInputTokens",
        write);
  }

  private Map<String, Object> usage(long input, long output, long read, long write) {
    return fields(
        "input_tokens",
        input,
        "output_tokens",
        output,
        "cache_read_input_tokens",
        read,
        "cache_creation_input_tokens",
        write);
  }

  private Map<String, Object> result(long input, long output, long read, long write) {
    return fields(
        "type",
        "result",
        "subtype",
        "success",
        "modelUsage",
        fields("model", model(input, output, read, write)));
  }

  @Test
  void codexSessionCountersAndSyntheticZeroDefaultsNeverBecomePromptUsage() {
    for (long input : List.of(0L, 1000L, 100_000L)) {
      var tracker = tracker("codex");
      tracker.accept(
          fields(
              "type",
              "turn.completed",
              "usage",
              fields("input_tokens", input, "cached_input_tokens", 0, "output_tokens", 0)));
      tracker.accept(
          fields(
              "method",
              "thread/tokenUsage/updated",
              "params",
              fields("tokenUsage", fields("total", fields("totalTokens", input)))));
      tracker.finish(false);
      assertThat(tracker.snapshot())
          .containsEntry("status", "unavailable")
          .containsEntry("reported", false)
          .containsEntry("totalTokens", null)
          .containsEntry("exact", false);
    }
  }

  @Test
  void trustedCodexRecordedResponsesAreASubtotalNotACompletePromptTotal() {
    var tracker = tracker("codex");
    var projection =
        fields(
            "reported",
            true,
            "inputTokens",
            1000,
            "outputTokens",
            60,
            "totalTokens",
            1060,
            "cachedInputTokens",
            800,
            "cacheCreationInputTokens",
            100,
            "reasoningOutputTokens",
            40);
    tracker.recordCodexRollout(projection);
    tracker.recordCodexRollout(projection);
    tracker.finish(false);
    assertThat(tracker.snapshot())
        .containsEntry("totalTokens", 1060L)
        .containsEntry("cachedInputTokens", 800L)
        .containsEntry("reasoningOutputTokens", 40L)
        .containsEntry("source", "codex.rollout.token_usage_record")
        .containsEntry("coverage", "recorded-responses-only")
        .containsEntry("status", "partial")
        .containsEntry("exact", false);
  }

  @Test
  void codexProjectionMustRemainInternallyConsistent() {
    for (String invalid : List.of("totalTokens", "cachedInputTokens", "reasoningOutputTokens")) {
      var tracker = tracker("codex");
      var projection =
          fields("reported", true, "inputTokens", 100L, "outputTokens", 10L, "totalTokens", 110L);
      projection.put(invalid, 1000L);
      tracker.recordCodexRollout(projection);
      tracker.finish(false);
      assertThat(tracker.snapshot())
          .containsEntry("reported", false)
          .containsEntry("totalTokens", null);
    }
  }

  @Test
  void missingUnknownProviderAndTextPayloadUsageNeverBecomeAnEstimate() {
    for (String provider : List.of("codex", "claude", "custom")) {
      var tracker = tracker(provider);
      tracker.accept(
          fields(
              "type",
              "item.completed",
              "item",
              fields(
                  "type",
                  "agent_message",
                  "text",
                  "x".repeat(1000),
                  "usage",
                  usage(999, 999, 0, 0))));
      tracker.finish(false);
      assertThat(tracker.snapshot())
          .containsEntry("status", "unavailable")
          .containsEntry("totalTokens", null)
          .containsEntry("exact", false);
    }
  }

  @Test
  void claudeModelUsageIncludesSubagentsAndAddsDisjointCacheCategoriesOnce() {
    var tracker = tracker("claude");
    var terminal =
        fields(
            "type",
            "result",
            "subtype",
            "success",
            "modelUsage",
            fields("opus", model(100, 20, 800, 50), "haiku", model(10, 5, 100, 5)),
            "usage",
            usage(100, 20, 800, 50));
    tracker.accept(terminal);
    tracker.accept(terminal);
    assertThat(tracker.snapshot()).containsEntry("status", "live").containsEntry("exact", false);
    tracker.finish(false);
    assertThat(tracker.snapshot())
        .containsEntry("totalTokens", 1090L)
        .containsEntry("inputTokens", 1065L)
        .containsEntry("outputTokens", 25L)
        .containsEntry("cachedInputTokens", 900L)
        .containsEntry("cacheCreationInputTokens", 55L)
        .containsEntry("exact", true)
        .containsEntry("source", "claude.result.modelUsage");
  }

  @Test
  void claudeMainLoopResultRemainsPartialCoverage() {
    var tracker = tracker("claude");
    tracker.accept(fields("type", "result", "usage", usage(100, 20, 80, 10)));
    tracker.finish(false);
    assertThat(tracker.snapshot())
        .containsEntry("totalTokens", 210L)
        .containsEntry("exact", false)
        .containsEntry("status", "partial")
        .containsEntry("coverage", "main-agent-only");
  }

  @Test
  void claudeLiveMessagesDeduplicateInputButNeverCountPlaceholderOutput() {
    var tracker = tracker("claude");
    var event =
        fields(
            "type", "assistant", "message", fields("id", "msg1", "usage", usage(100, 1, 80, 10)));
    tracker.accept(event);
    tracker.accept(event);
    tracker.accept(
        fields(
            "type",
            "assistant",
            "parent_tool_use_id",
            "child",
            "message",
            fields("id", "child-msg", "usage", usage(900, 1, 900, 10))));
    assertThat(tracker.snapshot())
        .containsEntry("inputTokens", 190L)
        .containsEntry("outputTokens", null)
        .containsEntry("totalTokens", null)
        .containsEntry("status", "live");
    tracker.finish(false);
    assertThat(tracker.snapshot()).containsEntry("status", "partial");
  }

  @Test
  void claudeCrashDoesNotReplaceRecordedInputWithSyntheticZeroTotal() {
    var tracker = tracker("claude");
    tracker.accept(
        fields(
            "type", "assistant", "message", fields("id", "msg1", "usage", usage(100, 1, 80, 10))));
    var crash = result(0, 0, 0, 0);
    crash.put("subtype", "error_during_execution");
    tracker.accept(crash);
    tracker.finish(false);
    assertThat(tracker.snapshot())
        .containsEntry("inputTokens", 190L)
        .containsEntry("totalTokens", null)
        .containsEntry("status", "partial")
        .containsEntry("exact", false);
  }

  @Test
  void claudeCrashWithoutObservedUsageDoesNotDisplaySyntheticZero() {
    var tracker = tracker("claude");
    var crash = result(0, 0, 0, 0);
    crash.put("subtype", "error_during_execution");
    tracker.accept(crash);
    tracker.finish(false);
    assertThat(tracker.snapshot())
        .containsEntry("reported", false)
        .containsEntry("totalTokens", null)
        .containsEntry("status", "unavailable");
  }

  @Test
  void claudeBudgetErrorModelUsageStillReportsItsMeasuredTokens() {
    var tracker = tracker("claude");
    var event = result(100, 20, 80, 10);
    event.put("subtype", "error_max_budget_usd");
    tracker.accept(event);
    tracker.finish(false);
    assertThat(tracker.snapshot()).containsEntry("totalTokens", 210L).containsEntry("exact", true);
  }

  @Test
  void missingCacheCategoriesAreNotAssumedZero() {
    var tracker = tracker("claude");
    tracker.accept(
        fields(
            "type",
            "result",
            "modelUsage",
            fields("opus", fields("inputTokens", 100, "outputTokens", 20))));
    tracker.finish(false);
    assertThat(tracker.snapshot())
        .containsEntry("uncachedInputTokens", 100L)
        .containsEntry("outputTokens", 20L)
        .containsEntry("totalTokens", null)
        .containsEntry("exact", false);
  }

  @Test
  void providerReportedZeroIsKnownWhileMissingUsageRemainsUnknown() {
    var tracker = tracker("claude");
    tracker.accept(result(0, 0, 0, 0));
    tracker.finish(false);
    assertThat(tracker.snapshot()).containsEntry("totalTokens", 0L).containsEntry("exact", true);
  }

  @Test
  void numbersMustBeNonnegativeIntegersAndBrowserSafe() {
    for (Object bad : List.of(-1L, 1.2, "100", 9_007_199_254_740_992L)) {
      var tracker = tracker("claude");
      var event = result(100, 10, 0, 0);
      obj(obj(event.get("modelUsage")).get("model")).put("inputTokens", bad);
      tracker.accept(event);
      tracker.finish(false);
      assertThat(tracker.snapshot())
          .containsEntry("totalTokens", null)
          .containsEntry("exact", false);
    }
    var overflow = tracker("claude");
    overflow.accept(result(9_007_199_254_740_991L, 1, 0, 0));
    overflow.finish(false);
    assertThat(overflow.snapshot())
        .containsEntry("totalTokens", null)
        .containsEntry("exact", false);
  }

  @Test
  void independentPromptsDoNotShareCountsButRetriesAggregateOnlyKnownAttempts() {
    var first = tracker("claude");
    first.accept(result(100, 10, 0, 0));
    first.finish(false);
    var resumed = tracker("claude");
    resumed.accept(result(200, 20, 0, 0));
    resumed.finish(false);
    assertThat(resumed.snapshot()).containsEntry("totalTokens", 220L);
    var retry = tracker("claude");
    retry.accept(result(100, 10, 0, 0));
    retry.beginAttempt();
    retry.accept(result(200, 20, 0, 0));
    retry.finish(false);
    assertThat(retry.snapshot()).containsEntry("totalTokens", 330L).containsEntry("exact", true);
    var unknownRetry = tracker("claude");
    unknownRetry.beginAttempt();
    unknownRetry.accept(result(200, 20, 0, 0));
    unknownRetry.finish(false);
    assertThat(unknownRetry.snapshot())
        .containsEntry("totalTokens", 220L)
        .containsEntry("status", "partial");
  }

  @Test
  void cancellationAndConflictingTerminalSnapshotsAreNeverComplete() {
    var tracker = tracker("claude");
    tracker.accept(result(100, 10, 0, 0));
    tracker.finish(true);
    assertThat(tracker.snapshot())
        .containsEntry("totalTokens", 110L)
        .containsEntry("status", "partial")
        .containsEntry("exact", false);
    var conflicting = tracker("claude");
    conflicting.accept(result(100, 10, 0, 0));
    conflicting.accept(result(200, 20, 0, 0));
    conflicting.finish(false);
    assertThat(conflicting.snapshot())
        .containsEntry("status", "partial")
        .containsEntry("exact", false);
  }

  @Test
  void framingTracksUsageBeforeDiagnosticTailAndFinalEventWithoutNewline() {
    var tracker = tracker("claude");
    var stream = new AgentOutputStream(mapper, true, tracker::accept);
    String event = mapper.writeValueAsString(result(100, 10, 0, 0));
    stream.append(event.substring(0, 13));
    stream.append(event.substring(13));
    stream.finish();
    stream.append(
        mapper.writeValueAsString(fields("type", "tool_progress", "output", "x".repeat(510_000)))
            + "\n");
    tracker.finish(false);
    assertThat(tracker.snapshot()).containsEntry("totalTokens", 110L).containsEntry("exact", true);
    assertThat(stream.display()).isEmpty();
  }
}
