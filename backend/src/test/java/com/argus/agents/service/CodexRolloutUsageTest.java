package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.fields;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import java.io.InputStream;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributeView;
import java.nio.file.attribute.FileTime;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

/** All records are synthetic; these tests never discover the user's real Codex directory. */
class CodexRolloutUsageTest {
  private static final String THREAD = "12345678-1234-1234-1234-123456789abc";
  @TempDir Path home;
  final ObjectMapper mapper = new ObjectMapper();

  CodexRolloutUsage resumed() {
    var observer = new CodexRolloutUsage(home, THREAD, mapper);
    observer.observeThread(THREAD);
    return observer;
  }

  Path path() throws Exception {
    var directory = home.resolve("sessions/2026/09/14");
    Files.createDirectories(directory);
    return directory.resolve("rollout-2026-09-14T10-00-00-" + THREAD + ".jsonl");
  }

  void append(Path file, Object... events) throws Exception {
    var value = new StringBuilder();
    for (Object event : events) value.append(mapper.writeValueAsString(event)).append('\n');
    Files.writeString(file, value, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
  }

  Map<String, Object> meta() {
    return fields("type", "session_meta", "payload", fields("id", THREAD));
  }

  Map<String, Object> boundary(String type, String turn) {
    return fields("type", "event_msg", "payload", fields("type", type, "turn_id", turn));
  }

  Map<String, Object> usage(String turn, String response, long input, long output) {
    return fields(
        "type",
        "token_usage_record",
        "payload",
        fields(
            "thread_id",
            THREAD,
            "turn_id",
            turn,
            "response_id",
            response,
            "usage",
            fields(
                "input_tokens",
                input,
                "output_tokens",
                output,
                "total_tokens",
                input + output,
                "cached_input_tokens",
                input / 2,
                "cache_write_input_tokens",
                0,
                "reasoning_output_tokens",
                output / 2)));
  }

  Map<String, Object> counter(long totalInput, long totalOutput, long input, long output) {
    return fields(
        "type",
        "event_msg",
        "payload",
        fields(
            "type",
            "token_count",
            "info",
            fields(
                "total_token_usage",
                counterValues(totalInput, totalOutput),
                "last_token_usage",
                counterValues(input, output))));
  }

  Map<String, Object> counterValues(long input, long output) {
    return fields(
        "input_tokens",
        input,
        "cached_input_tokens",
        input / 2,
        "output_tokens",
        output,
        "reasoning_output_tokens",
        0,
        "total_tokens",
        input + output);
  }

  @Test
  void counterFallbackUsesPreTurnBaselineAndRecoversHistoricalTurnsWithoutSessionInflation()
      throws Exception {
    var file = path();
    append(
        file,
        meta(),
        timed(boundary("task_started", "old"), "10:00:00"),
        timed(counter(1000, 100, 1000, 100), "10:00:01"),
        timed(boundary("task_complete", "old"), "10:00:02"));
    var observer = resumed();
    assertThat(observer.counterBaseline()).containsEntry("totalTokens", 1100L);
    append(
        file,
        timed(boundary("task_started", "wanted"), "10:01:00"),
        timed(counter(1100, 110, 100, 10), "10:01:01"),
        timed(counter(1100, 110, 100, 10), "10:01:02"),
        timed(counter(1200, 120, 100, 10), "10:01:03"),
        timed(boundary("task_complete", "wanted"), "10:01:04"));
    assertThat(observer.finish())
        .containsEntry("totalTokens", 220L)
        .containsEntry("measurement", "provider-counters")
        .containsEntry("exact", false);
    var recovered =
        CodexRolloutUsage.recover(
            home, THREAD, "2026-09-18T10:00:59Z", "2026-09-18T10:01:05Z", mapper);
    assertThat(recovered)
        .containsEntry("totalTokens", 220L)
        .containsEntry("measurement", "provider-counters");
  }

  @Test
  void recordedResponsesTakePrecedenceOverCounterFallback() throws Exception {
    var observer = new CodexRolloutUsage(home, "", mapper);
    append(
        path(),
        meta(),
        boundary("task_started", "turn"),
        counter(100, 10, 100, 10),
        usage("turn", "response", 100, 10),
        boundary("task_complete", "turn"));
    observer.observeThread(THREAD);
    assertThat(observer.finish())
        .containsEntry("totalTokens", 110L)
        .doesNotContainKey("measurement");
    assertThat(com.argus.agents.domain.AgentValues.obj(observer.finish().get("counterUsage")))
        .containsEntry("totalTokens", 110L)
        .containsEntry("measurement", "provider-counters")
        .containsEntry("turnCompleted", true);
  }

  @Test
  void responseSubtotalRetainsBroaderCountersAsSeparateEvidence() throws Exception {
    var observer = new CodexRolloutUsage(home, "", mapper);
    append(
        path(),
        meta(),
        boundary("task_started", "turn"),
        counter(100, 10, 100, 10),
        usage("turn", "response", 100, 10),
        counter(200, 20, 100, 10),
        boundary("task_complete", "turn"));
    observer.observeThread(THREAD);
    var result = observer.finish();
    assertThat(result)
        .containsEntry("totalTokens", 110L)
        .containsEntry("recordedResponseCount", 1)
        .doesNotContainKey("measurement");
    assertThat(com.argus.agents.domain.AgentValues.obj(result.get("counterUsage")))
        .containsEntry("totalTokens", 220L)
        .containsEntry("recordedResponseCount", 2)
        .containsEntry("incompleteCounterCoverage", false)
        .containsEntry("turnCompleted", true);
  }

  @Test
  void rolloutCounterReplayIsNotCountedTwiceAfterARecordedSubtotal() throws Exception {
    var observer = new CodexRolloutUsage(home, "", mapper);
    append(
        path(),
        meta(),
        boundary("task_started", "turn"),
        counter(100, 10, 100, 10),
        counter(200, 20, 100, 10),
        counter(100, 10, 100, 10),
        counter(200, 20, 100, 10),
        counter(300, 30, 100, 10),
        usage("turn", "response", 100, 10),
        boundary("task_complete", "turn"));
    observer.observeThread(THREAD);
    var result = observer.finish();
    assertThat(result).containsEntry("totalTokens", 110L);
    assertThat(com.argus.agents.domain.AgentValues.obj(result.get("counterUsage")))
        .containsEntry("totalTokens", 330L)
        .containsEntry("incompleteCounterCoverage", true);
  }

  @Test
  void historicalZeroBaselineRequiresProvenFirstTurnNotMerelyTotalEqualToLast() throws Exception {
    var file = path();
    append(
        file,
        meta(),
        timed(boundary("task_started", "first"), "10:00:00"),
        timed(counter(100, 10, 100, 10), "10:00:01"),
        timed(boundary("task_complete", "first"), "10:00:02"));
    assertThat(
            CodexRolloutUsage.recover(
                home, THREAD, "2026-09-18T09:59:59Z", "2026-09-18T10:00:03Z", mapper))
        .containsEntry("totalTokens", 110L);
    append(
        file,
        timed(boundary("task_started", "missing-counters"), "10:01:00"),
        timed(boundary("task_complete", "missing-counters"), "10:01:02"),
        timed(boundary("task_started", "wanted"), "10:02:00"),
        timed(counter(100, 10, 100, 10), "10:02:01"),
        timed(boundary("task_complete", "wanted"), "10:02:02"));
    assertThat(
            CodexRolloutUsage.recover(
                home, THREAD, "2026-09-18T10:01:59Z", "2026-09-18T10:02:03Z", mapper))
        .containsEntry("reported", false);
  }

  @Test
  void newThreadCountsUniqueObservedResponsesAndNeverClaimsCompleteAccounting() throws Exception {
    var observer = new CodexRolloutUsage(home, "", mapper);
    var file = path();
    append(
        file,
        meta(),
        boundary("task_started", "turn-one"),
        usage("turn-one", "response-a", 100, 10),
        usage("turn-one", "response-a", 100, 10),
        usage("turn-one", "response-b", 60, 4),
        boundary("task_complete", "turn-one"));
    observer.observeThread(THREAD);
    var result = observer.finish();
    assertThat(result)
        .containsEntry("reported", true)
        .containsEntry("exact", false)
        .containsEntry("status", "partial")
        .containsEntry("recordedResponseCount", 2)
        .containsEntry("inputTokens", 160L)
        .containsEntry("outputTokens", 14L)
        .containsEntry("totalTokens", 174L)
        .containsEntry("cachedInputTokens", 80L)
        .containsEntry("turnCompleted", true);
    assertThat(observer.finish()).isSameAs(result);
  }

  @Test
  void freshRolloutIdentityDoesNotDependOnCreationTimestampPrecision() throws Exception {
    var observer = new CodexRolloutUsage(home, "", mapper);
    var file = path();
    append(file, meta(), boundary("task_started", "turn"), usage("turn", "response", 2, 1));
    // Some filesystems round creation time down; others ignore attempts to set it. Neither behavior
    // should affect a new provider-identified rollout whose identity was absent before launch.
    Files.getFileAttributeView(file, BasicFileAttributeView.class)
        .setTimes(null, null, FileTime.fromMillis(0));
    observer.observeThread(THREAD);
    assertThat(observer.finish()).containsEntry("reported", true).containsEntry("totalTokens", 3L);
  }

  @Test
  void freshObserverRejectsRenamedPreexistingFileAndReusedThreadIdentity() throws Exception {
    var file = path();
    append(file, meta(), boundary("task_started", "old"), usage("old", "old-response", 2, 1));
    var renamed = new CodexRolloutUsage(home, "", mapper);
    Path moved = file.resolveSibling("rollout-renamed-" + THREAD + ".jsonl");
    Files.move(file, moved);
    renamed.observeThread(THREAD);
    assertUnavailable(renamed.finish());

    var reusedThread = new CodexRolloutUsage(home, "", mapper);
    Files.move(moved, moved.resolveSibling("archived.jsonl"));
    append(file, meta(), boundary("task_started", "new"), usage("new", "new-response", 2, 1));
    reusedThread.observeThread(THREAD);
    assertUnavailable(reusedThread.finish());
  }

  @Test
  void resumeReadsOnlyNewRecordsAndIgnoresSyntheticCountersAndContent() throws Exception {
    var file = path();
    append(
        file,
        meta(),
        boundary("task_started", "old-turn"),
        usage("old-turn", "old-response", 10_000, 1_000),
        boundary("task_complete", "old-turn"));
    var observer = resumed();
    observer.observeThread(THREAD);
    append(
        file,
        boundary("turn_started", "new-turn"),
        fields(
            "type",
            "event_msg",
            "payload",
            fields(
                "type",
                "token_count",
                "info",
                fields(
                    "last_token_usage",
                    fields("input_tokens", 999_999, "output_tokens", 0, "total_tokens", 999_999)))),
        fields(
            "type",
            "response_item",
            "payload",
            fields("type", "message", "content", "PRIVATE PROMPT NOT EXPORTED")),
        usage("new-turn", "new-response", 40, 10),
        boundary("turn_complete", "new-turn"));
    var result = observer.finish();
    assertThat(result)
        .containsEntry("totalTokens", 50L)
        .containsEntry("recordedResponseCount", 1)
        .containsEntry("exact", false);
    assertThat(mapper.writeValueAsString(result))
        .doesNotContain("PRIVATE PROMPT", "999999", "old-response", home.toString());
  }

  @Test
  void largeCompactionToolAndScreenshotPayloadsDoNotDiscardRealUsage() throws Exception {
    var file = path();
    append(file, meta());
    var observer = resumed();
    append(
        file,
        boundary("task_started", "turn"),
        usage("turn", "before", 20, 5),
        fields("type", "compacted", "payload", fields("message", "PRIVATE".repeat(250_000))),
        fields(
            "type",
            "response_item",
            "payload",
            fields("type", "function_call_output", "output", "X".repeat(9 * 1024 * 1024))),
        fields("type", "item_completed", "payload", fields("image", "Y".repeat(600_000))),
        usage("turn", "after", 40, 8),
        boundary("task_complete", "turn"));
    var result = observer.finish();
    assertThat(result)
        .containsEntry("reported", true)
        .containsEntry("totalTokens", 73L)
        .containsEntry("recordedResponseCount", 2);
    assertThat(mapper.writeValueAsString(result)).doesNotContain("PRIVATE", "XXXXX", "YYYYY");
  }

  @Test
  void historicalRecoveryReadsOnlyOneUniquelyBoundedCompletedTurn() throws Exception {
    var file = path();
    append(
        file,
        meta(),
        timed(boundary("task_started", "old"), "10:00:00"),
        usage("old", "old-response", 9000, 1000),
        timed(boundary("task_complete", "old"), "10:00:01"),
        timed(boundary("task_started", "wanted"), "10:01:00"),
        usage("wanted", "one", 100, 20),
        fields("type", "compacted", "payload", fields("message", "x".repeat(1_600_000))),
        usage("wanted", "two", 200, 10),
        timed(boundary("task_complete", "wanted"), "10:01:10"),
        timed(boundary("task_started", "later"), "10:02:00"),
        usage("later", "later", 9000, 2000),
        timed(boundary("task_complete", "later"), "10:02:02"));
    var result =
        CodexRolloutUsage.recover(
            home, THREAD, "2026-09-18T10:00:59Z", "2026-09-18T10:01:11Z", mapper);
    assertThat(result)
        .containsEntry("reported", true)
        .containsEntry("totalTokens", 330L)
        .containsEntry("turnId", "wanted")
        .containsEntry("exact", false);
    assertUnavailable(
        CodexRolloutUsage.recover(
            home, THREAD, "2026-09-18T09:59:59Z", "2026-09-18T10:01:11Z", mapper));
    assertUnavailable(
        CodexRolloutUsage.recover(
            home, THREAD, "2026-09-18T10:00:59Z", "2026-09-18T10:01:05Z", mapper));
    assertUnavailable(CodexRolloutUsage.recover(home, THREAD, "bad", "bad", mapper));
  }

  private Map<String, Object> timed(Map<String, Object> value, String time) {
    value.put("timestamp", "2026-09-18T" + time + "Z");
    return value;
  }

  @Test
  void historicalReadAllowsNewerAppendOutsideCapturedPrefixButLiveReadRemainsStrict()
      throws Exception {
    var file = path();
    for (boolean historical : List.of(true, false)) {
      Files.writeString(file, "");
      append(file, meta());
      var duringRead = spy(new ObjectMapper());
      var observer = new CodexRolloutUsage(home, THREAD, duringRead);
      observer.observeThread(THREAD);
      doAnswer(
              call -> {
                // The append happens after identity/size/newline capture but before parser
                // consumption.
                Files.writeString(file, "{\"type\":", StandardOpenOption.APPEND);
                return call.callRealMethod();
              })
          .when(duringRead)
          .createParser(any(InputStream.class));
      append(
          file,
          timed(boundary("task_started", "wanted"), "10:00:00"),
          usage("wanted", "one", 2, 1),
          timed(boundary("task_complete", "wanted"), "10:00:01"));
      var result =
          historical
              ? CodexRolloutUsage.recover(
                  home, THREAD, "2026-09-18T09:59:59Z", "2026-09-18T10:00:02Z", duringRead)
              : observer.finish();
      if (historical)
        assertThat(result).containsEntry("reported", true).containsEntry("totalTokens", 3L);
      else assertUnavailable(result);
      assertThat(Files.readString(file)).endsWith("{\"type\":");
    }
  }

  @Test
  void historicalRecoveryRequiresMatchingSessionIdentityAndRejectsDuplicateAccountingFields()
      throws Exception {
    var file = path();
    append(
        file,
        fields("type", "session_meta", "payload", fields("id", "foreign")),
        timed(boundary("task_started", "wanted"), "10:00:00"),
        usage("wanted", "one", 2, 1),
        timed(boundary("task_complete", "wanted"), "10:00:01"));
    assertUnavailable(
        CodexRolloutUsage.recover(
            home, THREAD, "2026-09-18T09:59:59Z", "2026-09-18T10:00:02Z", mapper));
    var observer = resumed();
    Files.writeString(
        file,
        "{\"type\":\"response_item\",\"type\":\"token_usage_record\"}\n",
        StandardOpenOption.APPEND);
    assertUnavailable(observer.finish());
  }

  @Test
  void olderVersionWithOnlyTokenCountIsUnavailableNotAnEstimate() throws Exception {
    var observer = new CodexRolloutUsage(home, "", mapper);
    var file = path();
    append(
        file,
        meta(),
        boundary("task_started", "turn"),
        fields(
            "type",
            "event_msg",
            "payload",
            fields(
                "type",
                "token_count",
                "info",
                fields(
                    "last_token_usage",
                    fields("input_tokens", 100, "output_tokens", 5, "total_tokens", 105)))),
        boundary("task_complete", "turn"));
    observer.observeThread(THREAD);
    assertUnavailable(observer.finish());
  }

  @Test
  void completedTurnWithoutUsageCannotFabricateZero() throws Exception {
    var observer = new CodexRolloutUsage(home, "", mapper);
    append(path(), meta(), boundary("task_started", "turn"), boundary("task_complete", "turn"));
    observer.observeThread(THREAD);
    assertUnavailable(observer.finish());
  }

  @Test
  void resumedThreadMismatchAndOverlappingTurnsHaveNoAttributableCount() throws Exception {
    var file = path();
    append(file, meta());
    var mismatch = resumed();
    mismatch.observeThread("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    append(file, boundary("task_started", "turn"), usage("turn", "response", 20, 3));
    assertUnavailable(mismatch.finish());
    var overlapping = resumed();
    append(
        file,
        boundary("task_started", "one"),
        usage("one", "one", 1, 1),
        boundary("task_started", "two"),
        usage("two", "two", 2, 2));
    assertUnavailable(overlapping.finish());
  }

  @Test
  void missingBoundaryForeignThreadAndConflictingDuplicatesFailClosed() throws Exception {
    var file = path();
    append(file, meta());
    var missing = resumed();
    append(file, usage("turn", "missing", 20, 3));
    assertUnavailable(missing.finish());
    var foreign = resumed();
    var foreignRecord = usage("turn", "foreign", 20, 3);
    ((Map<String, Object>) foreignRecord.get("payload"))
        .put("thread_id", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    append(file, boundary("task_started", "turn"), foreignRecord);
    assertUnavailable(foreign.finish());
    var conflicting = resumed();
    append(
        file,
        boundary("task_started", "turn"),
        usage("turn", "same-response", 20, 3),
        usage("turn", "same-response", 30, 4));
    assertUnavailable(conflicting.finish());
  }

  @Test
  void replacedTruncatedAndPartialLineWindowsAreUnavailable() throws Exception {
    var file = path();
    append(file, meta());
    var replaced = resumed();
    Files.move(file, file.resolveSibling("old.jsonl"));
    append(file, meta(), boundary("task_started", "turn"), usage("turn", "response", 2, 1));
    assertUnavailable(replaced.finish());
    var truncated = resumed();
    Files.writeString(file, "{}\n", StandardOpenOption.TRUNCATE_EXISTING);
    assertUnavailable(truncated.finish());
    var partial = resumed();
    Files.writeString(file, "{\"type\":", StandardOpenOption.APPEND);
    assertUnavailable(partial.finish());
  }

  @Test
  void freshObserverRejectsPreexistingRolloutAndDuplicateFiles() throws Exception {
    var file = path();
    append(file, meta(), boundary("task_started", "turn"), usage("turn", "response", 2, 1));
    var old = new CodexRolloutUsage(home, "", mapper);
    old.observeThread(THREAD);
    assertUnavailable(old.finish());
    var observer = resumed();
    Files.copy(file, file.resolveSibling("rollout-duplicate-" + THREAD + ".jsonl"));
    assertUnavailable(observer.finish());
  }

  @Test
  void symlinkAndOversizedAppendAreNotRead() throws Exception {
    var file = path();
    Path outside = home.resolve("outside.jsonl");
    append(outside, meta(), boundary("task_started", "turn"), usage("turn", "response", 2, 1));
    Files.createSymbolicLink(file, outside);
    assertUnavailable(resumed().finish());
    Files.delete(file);
    append(file, meta());
    var huge = resumed();
    Files.writeString(file, "x".repeat(8 * 1024 * 1024 + 1), StandardOpenOption.APPEND);
    assertUnavailable(huge.finish());
  }

  @Test
  void invalidCountersAndSumOverflowNeverProduceMisleadingNumbers() throws Exception {
    var file = path();
    append(file, meta());
    for (long count : new long[] {-1, 9_007_199_254_740_992L}) {
      var invalid = resumed();
      append(file, boundary("task_started", "turn"), usage("turn", "bad", count, 0));
      assertUnavailable(invalid.finish());
    }
    var overflow = resumed();
    append(
        file,
        boundary("task_started", "turn"),
        usage("turn", "one", 9_007_199_254_740_990L, 0),
        usage("turn", "two", 10, 0));
    assertUnavailable(overflow.finish());
  }

  private void assertUnavailable(Map<String, Object> result) {
    assertThat(result)
        .containsEntry("status", "unavailable")
        .containsEntry("reported", false)
        .containsEntry("exact", false);
    assertThat(result.get("totalTokens")).isNull();
  }
}
