package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import java.util.*;
import org.junit.jupiter.api.Test;

class CodexUsageCountersTest {
  static Map<String, Object> usage(long input, long output) {
    return fields(
        "inputTokens",
        input,
        "cachedInputTokens",
        input / 2,
        "outputTokens",
        output,
        "reasoningOutputTokens",
        0L,
        "totalTokens",
        input + output);
  }

  static Map<String, Object> nativeEvent(
      String thread, String turn, long totalInput, long totalOutput, long input, long output) {
    return fields(
        "method",
        "thread/tokenUsage/updated",
        "params",
        fields(
            "threadId",
            thread,
            "turnId",
            turn,
            "tokenUsage",
            fields("total", usage(totalInput, totalOutput), "last", usage(input, output))));
  }

  @Test
  void nativeEventsAreScopedDeduplicatedAndNeverPricedAsBilling() {
    var tracker = new ProviderTokenUsage("codex", "gpt-5.6-sol", "standard");
    tracker.beginAttempt();
    tracker.bindCodexThread("thread", CodexUsageCounters.parse(usage(1000, 100), false));
    tracker.acceptCodexNative(
        fields(
            "method",
            "turn/started",
            "params",
            fields("threadId", "thread", "turn", fields("id", "turn"))));
    tracker.acceptCodexNative(nativeEvent("foreign", "turn", 9999, 9999, 9999, 9999));
    tracker.acceptCodexNative(nativeEvent("thread", "old-turn", 9999, 9999, 9999, 9999));
    tracker.acceptCodexNative(nativeEvent("thread", "turn", 1100, 110, 100, 10));
    tracker.acceptCodexNative(nativeEvent("thread", "turn", 1100, 110, 100, 10));
    tracker.acceptCodexNative(nativeEvent("thread", "turn", 1200, 120, 100, 10));
    assertThat(tracker.snapshot())
        .containsEntry("totalTokens", 220L)
        .containsEntry("status", "live");
    tracker.acceptCodexNative(
        fields(
            "method",
            "turn/completed",
            "params",
            fields("threadId", "thread", "turn", fields("id", "turn"))));
    tracker.acceptCodexNative(nativeEvent("thread", "turn", 1300, 130, 100, 10));
    tracker.finish(false);
    var snapshot = tracker.snapshot();
    assertThat(snapshot)
        .containsEntry("totalTokens", 220L)
        .containsEntry("exact", false)
        .containsEntry("measurement", "provider-counters")
        .containsEntry("status", "partial");
    assertThat(obj(snapshot.get("costEstimate")))
        .containsEntry("status", "partial")
        .containsEntry("confidence", "approximate")
        .containsEntry("actualCharge", false)
        .containsEntry("amount", "0.021");
  }

  @Test
  void unknownBaselineDoesNotAttributeWholePriorSessionAndResetsDoNotAddWork() {
    var counters = new CodexUsageCounters(null);
    counters.accept(
        CodexUsageCounters.parse(usage(1000, 100), false),
        CodexUsageCounters.parse(usage(10, 10), false));
    assertThat(counters.projection("native", "thread", "turn")).containsEntry("reported", false);
    counters.accept(
        CodexUsageCounters.parse(usage(1100, 110), false),
        CodexUsageCounters.parse(usage(100, 10), false));
    counters.accept(
        CodexUsageCounters.parse(usage(200, 0), false),
        CodexUsageCounters.parse(usage(200, 0), false));
    counters.accept(
        CodexUsageCounters.parse(usage(300, 10), false),
        CodexUsageCounters.parse(usage(100, 10), false));
    assertThat(counters.projection("native", "thread", "turn"))
        .containsEntry("totalTokens", 220L)
        .containsEntry("incompleteCounterCoverage", true);
  }

  @Test
  void firstFreshThreadReportAndMalformedCounters() {
    var counters = new CodexUsageCounters(CodexUsageCounters.zero());
    var valid = CodexUsageCounters.parse(usage(100, 10), false);
    counters.accept(valid, valid);
    assertThat(counters.projection("native", "thread", "turn")).containsEntry("totalTokens", 110L);
    for (Object invalid : List.of(-1, 1.5, "100", 9_007_199_254_740_992L)) {
      var bad = usage(100, 10);
      bad.put("inputTokens", invalid);
      assertThat(CodexUsageCounters.parse(bad, false)).isNull();
    }
    var bad = usage(100, 10);
    bad.put("cachedInputTokens", 101);
    assertThat(CodexUsageCounters.parse(bad, false)).isNull();
  }

  @Test
  void unknownBaselineRejectsSinglePreviousCallReplayEvenWhenTotalEqualsLast() {
    var counters = new CodexUsageCounters(null);
    var prior = CodexUsageCounters.parse(usage(100, 10), false);
    counters.accept(prior, prior);
    assertThat(counters.projection("native", "thread", "turn")).containsEntry("reported", false);
    counters.accept(CodexUsageCounters.parse(usage(200, 20), false), prior);
    var projection = counters.projection("native", "thread", "turn");
    assertThat(projection)
        .containsEntry("totalTokens", 110L)
        .containsEntry("incompleteCounterCoverage", true);
    var tracker = new ProviderTokenUsage("codex");
    tracker.beginAttempt();
    tracker.recordCodexRollout(projection);
    tracker.finish(false);
    assertThat(tracker.snapshot()).containsEntry("incompleteCounterCoverage", true);
    assertThat(tracker.snapshot().get("detail").toString())
        .contains("only the attributable portion");
  }

  @Test
  void cancelledAndFailedTurnsKeepOnlyObservedCountsAndNeverBecomeExact() {
    for (boolean cancelled : List.of(false, true)) {
      var tracker = new ProviderTokenUsage("codex");
      tracker.beginAttempt();
      tracker.bindCodexThread("thread", CodexUsageCounters.zero());
      tracker.acceptCodexNative(
          fields(
              "method",
              "turn/started",
              "params",
              fields("threadId", "thread", "turn", fields("id", "turn"))));
      tracker.acceptCodexNative(nativeEvent("thread", "turn", 100, 10, 100, 10));
      tracker.acceptCodexNative(
          fields(
              "method",
              "turn/completed",
              "params",
              fields(
                  "threadId",
                  "thread",
                  "turn",
                  fields("id", "turn", "status", cancelled ? "interrupted" : "failed"))));
      tracker.acceptCodexNative(nativeEvent("thread", "turn", 200, 20, 100, 10));
      tracker.finish(cancelled);
      tracker.acceptCodexNative(nativeEvent("thread", "next-turn", 300, 30, 100, 10));
      assertThat(tracker.snapshot())
          .containsEntry("totalTokens", 110L)
          .containsEntry("status", "partial")
          .containsEntry("exact", false);
    }
  }

  @Test
  void nativeAndRolloutCountersAreNotAddedAndVerifiedRecordsStayPreferred() {
    var tracker = new ProviderTokenUsage("codex");
    tracker.beginAttempt();
    tracker.bindCodexThread("thread", CodexUsageCounters.zero());
    tracker.acceptCodexNative(
        fields(
            "method",
            "turn/started",
            "params",
            fields("threadId", "thread", "turn", fields("id", "turn"))));
    tracker.acceptCodexNative(nativeEvent("thread", "turn", 100, 10, 100, 10));
    var counters = new CodexUsageCounters(CodexUsageCounters.zero());
    var usage = CodexUsageCounters.parse(usage(100, 10), false);
    counters.accept(usage, usage);
    tracker.recordCodexRollout(counters.projection("rollout", "thread", "turn"));
    assertThat(tracker.snapshot()).containsEntry("totalTokens", 110L);
    tracker.recordCodexRollout(
        fields("reported", true, "inputTokens", 50, "outputTokens", 5, "totalTokens", 55));
    tracker.finish(false);
    assertThat(tracker.snapshot())
        .containsEntry("totalTokens", 55L)
        .doesNotContainKey("measurement");
  }

  @Test
  void nonAdjacentReplayDoesNotRewindTheBaselineOrCountWorkTwice() {
    var counters = new CodexUsageCounters(CodexUsageCounters.zero());
    var first = CodexUsageCounters.parse(usage(100, 10), false);
    var second = CodexUsageCounters.parse(usage(200, 20), false);
    counters.accept(first, first);
    counters.accept(second, first);
    counters.accept(first, first);
    counters.accept(second, first);
    counters.accept(CodexUsageCounters.parse(usage(300, 30), false), first);
    assertThat(counters.projection("native", "thread", "turn"))
        .containsEntry("totalTokens", 330L)
        .containsEntry("recordedResponseCount", 3)
        .containsEntry("incompleteCounterCoverage", true);
  }

  @Test
  void resetKeepsPriorUsageAndCountsNewAttributablePostCompactionWork() {
    var counters = new CodexUsageCounters(CodexUsageCounters.zero());
    var first = CodexUsageCounters.parse(usage(1000, 100), false);
    counters.accept(first, first);
    counters.accept(
        CodexUsageCounters.parse(usage(200, 0), false),
        CodexUsageCounters.parse(usage(200, 0), false));
    counters.accept(
        CodexUsageCounters.parse(usage(300, 10), false),
        CodexUsageCounters.parse(usage(100, 10), false));
    counters.accept(first, first); // Old snapshot must not displace the reset baseline.
    counters.accept(
        CodexUsageCounters.parse(usage(400, 20), false),
        CodexUsageCounters.parse(usage(100, 10), false));
    assertThat(counters.projection("native", "thread", "turn"))
        .containsEntry("totalTokens", 1320L)
        .containsEntry("recordedResponseCount", 3)
        .containsEntry("incompleteCounterCoverage", true);
  }

  @Test
  void boundedSnapshotHistoryStopsWithoutDroppingDeduplicationProtection() {
    var counters = new CodexUsageCounters(CodexUsageCounters.zero());
    var last = CodexUsageCounters.parse(usage(2, 1), false);
    for (int index = 1; index <= 10_002; index++)
      counters.accept(CodexUsageCounters.parse(usage(index * 2L, index), false), last);
    assertThat(counters.projection("native", "thread", "turn"))
        .containsEntry("totalTokens", 29_997L)
        .containsEntry("recordedResponseCount", 9999)
        .containsEntry("incompleteCounterCoverage", true);
  }

  private Map<String, Object> responseProjection(long input, long output) {
    var result = CodexUsageCounters.parse(usage(input, output), false);
    result.putAll(
        fields(
            "reported",
            true,
            "threadId",
            "thread",
            "turnId",
            "turn",
            "turnCompleted",
            true,
            "recordedResponseCount",
            1));
    return result;
  }

  private Map<String, Object> counterProjection(long input, long output) {
    var counters = new CodexUsageCounters(CodexUsageCounters.zero());
    var value = CodexUsageCounters.parse(usage(input, output), false);
    counters.accept(value, value);
    var result = counters.projection("codex.rollout.token_count", "thread", "turn");
    result.put("turnCompleted", true);
    return result;
  }

  @Test
  void broaderCompatibleCompletedCountersPreserveResponseEvidenceWithoutAddingSources() {
    var tracker = new ProviderTokenUsage("codex");
    tracker.beginAttempt();
    var response = responseProjection(100, 10);
    response.put("counterUsage", counterProjection(200, 20));
    tracker.recordCodexRollout(response);
    tracker.finish(false);
    var snapshot = tracker.snapshot();
    assertThat(snapshot)
        .containsEntry("totalTokens", 220L)
        .containsEntry("measurement", "provider-counters")
        .containsEntry("coverage", "turn-scoped-provider-counters")
        .containsEntry("source", "codex.rollout.token_count")
        .containsEntry("counterSelection", "broader-compatible-turn-counters")
        .containsEntry("status", "partial")
        .containsEntry("exact", false);
    assertThat(obj(snapshot.get("responseUsage")))
        .containsEntry("totalTokens", 110L)
        .containsEntry("source", "codex.rollout.token_usage_record")
        .containsEntry("coverage", "recorded-responses-only");
    assertThat(obj(snapshot.get("counterUsage"))).containsEntry("totalTokens", 220L);
  }

  @Test
  void equalSmallerIncompleteForeignAndIncompatibleCountersNeverReplaceMeasuredResponses() {
    for (String scenario :
        List.of(
            "equal", "smaller", "incomplete", "foreign", "missing-scope", "unfinished", "cache")) {
      var tracker = new ProviderTokenUsage("codex");
      tracker.beginAttempt();
      var response = responseProjection(100, 10);
      var counter =
          counterProjection(
              scenario.equals("equal") ? 100 : scenario.equals("smaller") ? 50 : 200,
              scenario.equals("equal") ? 10 : scenario.equals("smaller") ? 4 : 20);
      switch (scenario) {
        case "incomplete" -> counter.put("incompleteCounterCoverage", true);
        case "foreign" -> counter.put("turnId", "another-turn");
        case "missing-scope" -> counter.remove("threadId");
        case "unfinished" -> counter.put("turnCompleted", false);
        case "cache" -> {
          counter.put("cachedInputTokens", 0L);
          counter.put("uncachedInputTokens", 200L);
        }
        default -> {}
      }
      response.put("counterUsage", counter);
      tracker.recordCodexRollout(response);
      tracker.finish(false);
      assertThat(tracker.snapshot())
          .as(scenario)
          .containsEntry("totalTokens", 110L)
          .containsEntry("source", "codex.rollout.token_usage_record")
          .doesNotContainKey("measurement");
    }
  }

  @Test
  void nativeAndRolloutUseOneBroaderCompatibleProjectionAndConflictsFailClosed() {
    for (boolean conflict : List.of(false, true)) {
      var tracker = new ProviderTokenUsage("codex");
      tracker.beginAttempt();
      tracker.bindCodexThread("thread", CodexUsageCounters.zero());
      tracker.acceptCodexNative(
          fields(
              "method",
              "turn/started",
              "params",
              fields("threadId", "thread", "turn", fields("id", "turn"))));
      tracker.acceptCodexNative(nativeEvent("thread", "turn", 200, 20, 200, 20));
      tracker.acceptCodexNative(
          fields(
              "method",
              "turn/completed",
              "params",
              fields("threadId", "thread", "turn", fields("id", "turn"))));
      var response = responseProjection(100, 10);
      response.put("counterUsage", counterProjection(conflict ? 100 : 300, conflict ? 40 : 30));
      tracker.recordCodexRollout(response);
      tracker.finish(false);
      assertThat(tracker.snapshot()).containsEntry("totalTokens", conflict ? 110L : 330L);
      if (conflict) assertThat(tracker.snapshot()).doesNotContainKey("measurement");
    }
  }
}
