package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import java.math.BigDecimal;
import java.util.*;

/** Turn-bounded Codex telemetry, deliberately distinct from billable response usage records. */
final class CodexUsageCounters {
  private static final long MAX = 9_007_199_254_740_991L;
  private static final List<String> KEYS =
      List.of(
          "inputTokens",
          "cachedInputTokens",
          "cacheCreationInputTokens",
          "outputTokens",
          "reasoningOutputTokens",
          "totalTokens");
  private Map<String, Object> previous;
  private final Map<String, Object> counts = new LinkedHashMap<>();
  private final Set<List<Object>> seenTotals = new HashSet<>();
  private int reports;
  private boolean incompleteCoverage;

  CodexUsageCounters(Map<String, Object> baseline) {
    previous = baseline == null || baseline.isEmpty() ? null : new LinkedHashMap<>(baseline);
    if (previous != null) seenTotals.add(signature(previous));
    KEYS.forEach(key -> counts.put(key, 0L));
  }

  static Map<String, Object> zero() {
    var result = new LinkedHashMap<String, Object>();
    KEYS.forEach(key -> result.put(key, 0L));
    return result;
  }

  static Map<String, Object> parse(Map<String, Object> source, boolean snake) {
    var result = new LinkedHashMap<String, Object>();
    String[] wire =
        snake
            ? new String[] {
              "input_tokens",
              "cached_input_tokens",
              "cache_write_input_tokens",
              "output_tokens",
              "reasoning_output_tokens",
              "total_tokens"
            }
            : new String[] {
              "inputTokens",
              "cachedInputTokens",
              "cacheWriteInputTokens",
              "outputTokens",
              "reasoningOutputTokens",
              "totalTokens"
            };
    for (int i = 0; i < KEYS.size(); i++) {
      // Codex's protocol explicitly defaults cacheWriteInputTokens to zero.
      Object raw = source.containsKey(wire[i]) ? source.get(wire[i]) : i == 2 ? 0L : null;
      if (!(raw instanceof Number number)) return null;
      try {
        long value = new BigDecimal(number.toString()).longValueExact();
        if (value < 0 || value > MAX) return null;
        result.put(KEYS.get(i), value);
      } catch (RuntimeException ignored) {
        return null;
      }
    }
    long input = (Long) result.get("inputTokens"), output = (Long) result.get("outputTokens");
    if (input > MAX - output
        || input + output != (Long) result.get("totalTokens")
        || (Long) result.get("cachedInputTokens") > input
        || (Long) result.get("cacheCreationInputTokens")
            > input - (Long) result.get("cachedInputTokens")
        || (Long) result.get("reasoningOutputTokens") > output) return null;
    result.put(
        "uncachedInputTokens",
        input
            - (Long) result.get("cachedInputTokens")
            - (Long) result.get("cacheCreationInputTokens"));
    return result;
  }

  void accept(Map<String, Object> total, Map<String, Object> last) {
    if (total == null || last == null || reports >= 10_000) {
      incompleteCoverage = true;
      return;
    }
    // Replayed notifications and context-window resets are not new model work. A previous
    // thread total is only a baseline, never attributed wholesale to the current request.
    if (previous != null
        && KEYS.stream().allMatch(key -> Objects.equals(previous.get(key), total.get(key)))) return;
    // A delayed replay must not rewind the baseline and make already counted work attributable
    // again. Keep a bounded history across resets. A real post-compaction total that happens to
    // equal an older snapshot is indistinguishable from replay, so skip it conservatively; new
    // totals can still establish a reset baseline and contribute subsequent attributable deltas.
    var signature = signature(total);
    if (seenTotals.contains(signature)) {
      incompleteCoverage = true;
      return;
    }
    if (seenTotals.size() >= 10_000) {
      incompleteCoverage = true;
      return;
    }
    seenTotals.add(signature);
    // Unknown history must prime a baseline, even when total==last: a resumed session may
    // replay the counters from its only previous model call using the current turn identity.
    boolean attributable =
        previous != null
            && KEYS.stream()
                .allMatch(
                    key ->
                        (Long) total.get(key) >= (Long) previous.get(key)
                            && (Long) total.get(key) - (Long) previous.get(key)
                                == (Long) last.get(key));
    previous = new LinkedHashMap<>(total);
    if (!attributable) {
      incompleteCoverage = true;
      return;
    }
    for (String key : KEYS)
      if ((Long) counts.get(key) > MAX - (Long) last.get(key)) {
        incompleteCoverage = true;
        return;
      }
    KEYS.forEach(key -> counts.put(key, (Long) counts.get(key) + (Long) last.get(key)));
    reports++;
  }

  private static List<Object> signature(Map<String, Object> value) {
    return KEYS.stream().map(value::get).toList();
  }

  Map<String, Object> projection(String source, String thread, String turn) {
    var result =
        fields(
            "reported",
            reports > 0,
            "source",
            source,
            "measurement",
            "provider-counters",
            "coverage",
            "turn-scoped-provider-counters",
            "threadId",
            thread,
            "turnId",
            turn,
            "recordedResponseCount",
            reports,
            "incompleteCounterCoverage",
            incompleteCoverage,
            "detail",
            "Codex-reported counters scoped to this turn, with repeated snapshots removed. "
                + "These may include provider-side context estimates and omit subagents; they are not a verified billing total.");
    if (incompleteCoverage)
      result.put(
          "detail",
          result.get("detail")
              + " Some updates were skipped because a baseline was missing, counters reset or jumped, or an update was invalid; the displayed tokens are a subtotal.");
    if (reports > 0) {
      result.putAll(counts);
      result.put(
          "uncachedInputTokens",
          (Long) counts.get("inputTokens")
              - (Long) counts.get("cachedInputTokens")
              - (Long) counts.get("cacheCreationInputTokens"));
    }
    return result;
  }
}
