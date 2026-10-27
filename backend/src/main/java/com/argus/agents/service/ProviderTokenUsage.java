package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;

/**
 * Provider-reported accounting for one Argus execution, never a tokenizer estimate. Only outer
 * protocol events are accepted; text, tool payloads and thread/account totals are not usage. Codex
 * exec turn.completed is session-cumulative and can contain compaction estimates: never display it
 * as measured prompt usage. Codex response records are preferred; scoped native/rollout counters
 * are retained as non-billing telemetry, never labelled exact or converted to credits. Claude
 * result.modelUsage includes subagents; result.usage and assistant usage cover only the main loop.
 * Assistant output_tokens is a placeholder and must not be counted. See the official
 * non-interactive-mode and Claude Agent SDK cost-tracking documentation. Each resumed CLI
 * invocation starts independent accounting.
 */
public final class ProviderTokenUsage {
  private static final long MAX = 9_007_199_254_740_991L; // exact in the browser as well as Java
  private static final List<String> COUNTS =
      List.of(
          "inputTokens",
          "outputTokens",
          "totalTokens",
          "uncachedInputTokens",
          "cachedInputTokens",
          "cacheCreationInputTokens",
          "reasoningOutputTokens");
  private final String provider;
  private final String model, speed, effort;
  private final List<Attempt> attempts = new ArrayList<>();
  private boolean finished, cancelled;

  private static final class Attempt {
    final Map<String, Map<String, Object>> messages = new LinkedHashMap<>();
    Map<String, Object> terminal;
    boolean invalid, overflow;
    String measuredAt;
    Map<String, Object> costReport;
    Map<String, Object> observation = Map.of();
    boolean costSeen, costInvalid;
    String codexThread = "", codexTurn = "";
    CodexUsageCounters counters;
    Map<String, Object> counterReport;
    boolean codexTurnDone, counterAmbiguous;
  }

  public ProviderTokenUsage(String provider) {
    this(provider, "", "");
  }

  public ProviderTokenUsage(String provider, String model, String speed) {
    this(provider, model, speed, "");
  }

  public ProviderTokenUsage(String provider, String model, String speed, String effort) {
    this.provider = provider;
    this.model = model;
    this.speed = speed;
    this.effort = effort;
  }

  public synchronized void beginAttempt() {
    attempts.add(new Attempt());
  }

  public synchronized void bindCodexThread(String thread, Map<String, Object> baseline) {
    if (!"codex".equals(provider) || attempts.isEmpty() || finished) return;
    Attempt attempt = attempts.get(attempts.size() - 1);
    attempt.codexThread = thread;
    attempt.counters = new CodexUsageCounters(baseline);
  }

  /** Only receives outer notifications from the owned native connection, never tool payloads. */
  public synchronized void acceptCodexNative(Map<String, Object> event) {
    if (!"codex".equals(provider) || attempts.isEmpty() || finished) return;
    Attempt attempt = attempts.get(attempts.size() - 1);
    var params = obj(event.get("params"));
    if (attempt.counters == null || !attempt.codexThread.equals(text(params.get("threadId"))))
      return;
    String method = text(event.get("method"));
    if ("turn/started".equals(method) && attempt.codexTurn.isBlank())
      attempt.codexTurn = text(obj(params.get("turn")).get("id"));
    if ("turn/completed".equals(method)
        && attempt.codexTurn.equals(text(obj(params.get("turn")).get("id")))) {
      attempt.codexTurnDone = true;
      if (attempt.counterReport != null) attempt.counterReport.put("turnCompleted", true);
    }
    if (!"thread/tokenUsage/updated".equals(method)
        || attempt.codexTurn.isBlank()
        || attempt.codexTurnDone
        || !attempt.codexTurn.equals(text(params.get("turnId")))) return;
    var usage = obj(params.get("tokenUsage"));
    attempt.counters.accept(
        CodexUsageCounters.parse(obj(usage.get("total")), false),
        CodexUsageCounters.parse(obj(usage.get("last")), false));
    attempt.counterReport =
        attempt.counters.projection(
            "codex.app-server.thread/tokenUsage/updated", attempt.codexThread, attempt.codexTurn);
    attempt.measuredAt = Instant.now().toString();
  }

  public synchronized void accept(Map<String, Object> event) {
    if (attempts.isEmpty() || finished) return;
    Attempt attempt = attempts.get(attempts.size() - 1);
    String type = text(event.get("type"));
    if ("claude".equals(provider) && "result".equals(type)) {
      // A crash can emit all-zero result fields despite earlier work. Never call these exact.
      boolean crash = "error_during_execution".equals(event.get("subtype"));
      captureClaudeCost(attempt, event, crash);
      var modelUsage = obj(event.get("modelUsage"));
      Map<String, Object> usage = null;
      String source = "claude.result.modelUsage",
          coverage = "provider-execution-including-subagents";
      if (!modelUsage.isEmpty() && modelUsage.size() <= 100) {
        var models = new ArrayList<Map<String, Object>>();
        for (Object value : modelUsage.values()) models.add(claude(obj(value), true, true));
        usage = sum(models);
      } else {
        usage = claude(obj(event.get("usage")), false, true);
        source = "claude.result.usage";
        coverage = "main-agent-only";
      }
      if (crash) {
        attempt.invalid = true;
        // Crash defaults are not measurements, even when there were no earlier usable messages.
        // Keep only the input/cache usage actually observed before the crash, if any.
        return;
      }
      terminal(attempt, usage, source, coverage);
    } else if ("claude".equals(provider)
        && "assistant".equals(type)
        && text(event.get("parent_tool_use_id")).isEmpty()) {
      var message = obj(event.get("message"));
      String id = text(message.get("id"));
      if (id.isBlank() || id.length() > 300) return;
      var usage = claude(obj(message.get("usage")), false, false);
      if (usage == null) return;
      if (!attempt.messages.containsKey(id) && attempt.messages.size() >= 10_000) {
        attempt.overflow = true;
        return;
      }
      // Multiple content blocks share an API message ID and repeat the same usage.
      attempt.messages.put(id, usage);
      attempt.measuredAt = Instant.now().toString();
    }
  }

  private void terminal(
      Attempt attempt, Map<String, Object> usage, String source, String coverage) {
    if (usage == null) {
      attempt.invalid = true;
      return;
    }
    usage.put("source", source);
    usage.put("coverage", coverage);
    // One stdin prompt produces one terminal result. Identical replayed terminal events do not
    // add tokens. Conflicting terminal snapshots are conservatively marked incomplete.
    if (attempt.terminal != null && !attempt.terminal.equals(usage)) attempt.invalid = true;
    attempt.terminal = usage;
    attempt.measuredAt = Instant.now().toString();
  }

  public synchronized void finish(boolean wasCancelled) {
    finished = true;
    cancelled = wasCancelled;
  }

  /** Accept only the numeric projection from Argus's bounded, turn-scoped rollout reader. */
  public synchronized void recordCodexRollout(Map<String, Object> projection) {
    if (!"codex".equals(provider) || attempts.isEmpty() || finished) return;
    Attempt attempt = attempts.get(attempts.size() - 1);
    attempt.observation =
        fields(
            "detail",
            text(projection.get("detail")),
            "threadId",
            projection.get("threadId"),
            "turnId",
            projection.get("turnId"),
            "recordedResponseCount",
            projection.get("recordedResponseCount"),
            "turnCompleted",
            truth(projection.get("turnCompleted")));
    var counterEvidence = obj(projection.get("counterUsage"));
    if (truth(counterEvidence.get("reported"))) recordCounter(attempt, counterEvidence);
    if (!truth(projection.get("reported"))) return;
    if ("provider-counters".equals(projection.get("measurement"))) {
      recordCounter(attempt, projection);
      return;
    }
    var usage = codexCounts(projection);
    if (usage == null) return;
    for (String field : List.of("threadId", "turnId", "recordedResponseCount", "turnCompleted"))
      if (projection.containsKey(field)) usage.put(field, projection.get(field));
    terminal(attempt, usage, "codex.rollout.token_usage_record", "recorded-responses-only");
  }

  private static Map<String, Object> codexCounts(Map<String, Object> projection) {
    var usage = new LinkedHashMap<String, Object>();
    for (String field : COUNTS) {
      Long value = count(projection, field);
      if (invalidOptional(projection, field, value)) return null;
      usage.put(field, value);
    }
    if (usage.get("inputTokens") == null
        || usage.get("outputTokens") == null
        || usage.get("totalTokens") == null) return null;
    Long input = (Long) usage.get("inputTokens"), output = (Long) usage.get("outputTokens");
    if (!Objects.equals(add(input, output), usage.get("totalTokens"))) return null;
    for (String subset :
        List.of("cachedInputTokens", "cacheCreationInputTokens", "uncachedInputTokens"))
      if (usage.get(subset) instanceof Long count && count > input) return null;
    if (usage.get("cachedInputTokens") instanceof Long cached
        && usage.get("cacheCreationInputTokens") instanceof Long created
        && (cached > input - created
            || usage.get("uncachedInputTokens") instanceof Long uncached
                && uncached != input - cached - created)) return null;
    if (usage.get("reasoningOutputTokens") instanceof Long reasoning && reasoning > output)
      return null;
    return usage;
  }

  private static boolean sameCodexScope(Map<String, Object> first, Map<String, Object> second) {
    return !text(first.get("threadId")).isBlank()
        && !text(first.get("turnId")).isBlank()
        && Objects.equals(first.get("threadId"), second.get("threadId"))
        && Objects.equals(first.get("turnId"), second.get("turnId"));
  }

  private static boolean covers(Map<String, Object> larger, Map<String, Object> smaller) {
    return COUNTS.stream()
        .allMatch(
            key ->
                smaller.get(key) == null
                    || larger.get(key) instanceof Number value
                        && value.longValue() >= ((Number) smaller.get(key)).longValue());
  }

  private static boolean completeCounter(Map<String, Object> counter) {
    return Boolean.FALSE.equals(counter.get("incompleteCounterCoverage"))
        && COUNTS.stream().allMatch(key -> counter.get(key) instanceof Number);
  }

  private void recordCounter(Attempt attempt, Map<String, Object> projection) {
    if (!"provider-counters".equals(projection.get("measurement"))) return;
    var usage = codexCounts(projection);
    if (usage == null) return;
    var candidate = new LinkedHashMap<>(projection);
    candidate.putAll(usage);
    var prior = attempt.counterReport;
    if (prior == null || !truth(prior.get("reported"))) attempt.counterReport = candidate;
    else if (!sameCodexScope(prior, candidate)) attempt.counterAmbiguous = true;
    else if (!covers(prior, candidate) && !covers(candidate, prior))
      attempt.counterAmbiguous = true;
    else if (covers(candidate, prior) && (completeCounter(candidate) || !completeCounter(prior))) {
      // Native and rollout snapshots overlap. Select one compatible projection, never sum them.
      attempt.counterReport = candidate;
    }
    attempt.measuredAt = Instant.now().toString();
  }

  private static boolean broaderCounter(Attempt attempt) {
    var response = attempt.terminal;
    var counter = attempt.counterReport;
    return response != null
        && counter != null
        && !attempt.invalid
        && !attempt.overflow
        && !attempt.counterAmbiguous
        && completeCounter(counter)
        && truth(response.get("turnCompleted"))
        && truth(counter.get("turnCompleted"))
        && sameCodexScope(response, counter)
        && covers(counter, response)
        && ((Number) counter.get("totalTokens")).longValue()
            > ((Number) response.get("totalTokens")).longValue();
  }

  private static Map<String, Object> evidence(List<Map<String, Object>> parts) {
    var result = parts.size() == 1 ? new LinkedHashMap<>(parts.get(0)) : sum(parts);
    if (result == null) return Map.of();
    result.put("reported", true);
    result.put("exact", false);
    if (parts.size() > 1) {
      result.put("coverage", "incomplete-provider-execution");
      result.put(
          "source",
          String.join(
              " + ", parts.stream().map(part -> text(part.get("source"))).distinct().toList()));
    }
    return result;
  }

  public synchronized Map<String, Object> snapshot() {
    var parts = new ArrayList<Map<String, Object>>();
    var sources = new LinkedHashSet<String>();
    var responseEvidence = new ArrayList<Map<String, Object>>();
    var counterEvidence = new ArrayList<Map<String, Object>>();
    boolean broaderCounters = false;
    boolean complete = !attempts.isEmpty(), any = false;
    String measuredAt = null;
    for (Attempt attempt : attempts) {
      Map<String, Object> part = attempt.terminal;
      if ("codex".equals(provider)) {
        if (attempt.terminal != null) responseEvidence.add(attempt.terminal);
        if (attempt.counterReport != null && truth(attempt.counterReport.get("reported")))
          counterEvidence.add(attempt.counterReport);
        if (broaderCounter(attempt)) {
          part = attempt.counterReport;
          broaderCounters = true;
        }
      }
      if (part == null
          && attempt.counterReport != null
          && truth(attempt.counterReport.get("reported"))) part = attempt.counterReport;
      if (part == null && !attempt.messages.isEmpty()) {
        part = sum(new ArrayList<>(attempt.messages.values()));
        if (part != null) {
          part.put("source", "claude.assistant.message.usage");
          part.put("coverage", "main-agent-input-only");
        }
      }
      if (part == null) {
        complete = false;
        continue;
      }
      any = true;
      parts.add(part);
      sources.add(text(part.get("source")));
      measuredAt = attempt.measuredAt;
      complete &=
          attempt.terminal != null
              && !attempt.invalid
              && !attempt.overflow
              && part.get("totalTokens") != null
              && text(part.get("coverage")).startsWith("provider-execution");
    }
    var totals = sum(parts);
    if (totals == null) totals = new LinkedHashMap<>();
    boolean exact = any && complete && totals.get("totalTokens") != null && finished && !cancelled;
    String status = !any ? "unavailable" : !finished ? "live" : exact ? "final" : "partial";
    var result =
        fields(
            "provider",
            provider,
            "status",
            status,
            "exact",
            exact,
            "reported",
            any,
            "source",
            String.join(" + ", sources),
            "scope",
            "argus-prompt-execution",
            "attemptCount",
            attempts.size(),
            "measuredAt",
            measuredAt);
    for (String field : COUNTS) result.put(field, totals.get(field));
    result.put(
        "coverage",
        exact
            ? "provider-execution"
            : parts.size() == 1 && attempts.size() == 1
                ? parts.get(0).get("coverage")
                : "incomplete-provider-execution");
    String detail =
        !any
            ? "No trustworthy prompt-scoped provider usage was recorded. Session/context-window counters and local token estimates are not substituted."
            : exact
                ? "Provider-reported tokens for this prompt execution, including its context and tool round trips. Cached input and reasoning output are subsets, not extra tokens."
                : !finished
                    ? "Provider-reported usage received so far; the complete execution total is not available yet."
                    : cancelled
                        ? "The request was cancelled. These are only the provider counts received before cancellation, not a confirmed full total."
                        : "Only a provider-recorded subtotal is available, not a confirmed complete prompt total. Some providers omit usage for responses or subagents; no missing counts are estimated.";
    result.put("detail", detail);
    if (parts.stream().anyMatch(part -> "provider-counters".equals(part.get("measurement")))) {
      result.put("measurement", "provider-counters");
      result.put(
          "detail",
          "Codex-reported counters scoped to this request, with repeated snapshots removed. "
              + "They may include provider-side context estimates and omit subagents; they are not a verified billing total.");
      if (broaderCounters) {
        result.put("counterSelection", "broader-compatible-turn-counters");
        result.put(
            "detail",
            result.get("detail")
                + " The complete observed counter sequence covers more tokens than the compatible response-record subtotal. These overlapping sources are not added together; the recorded response subtotal is preserved separately.");
      }
      boolean incompleteCounters =
          attempts.stream()
              .anyMatch(
                  attempt ->
                      attempt.counterAmbiguous
                          || attempt.counterReport != null
                              && truth(attempt.counterReport.get("incompleteCounterCoverage")));
      result.put("incompleteCounterCoverage", incompleteCounters);
      if (incompleteCounters)
        result.put(
            "detail",
            result.get("detail")
                + " Some updates were skipped because a reliable baseline was unavailable or counters reset, jumped or were invalid. Displayed tokens cover only the attributable portion of the turn.");
    }
    if ("codex".equals(provider)) {
      if (!responseEvidence.isEmpty() && !counterEvidence.isEmpty()) {
        result.put("responseUsage", evidence(responseEvidence));
        result.put("counterUsage", evidence(counterEvidence));
      }
      var observations =
          attempts.stream()
              .map(attempt -> attempt.observation)
              .filter(observation -> !observation.isEmpty())
              .toList();
      result.put("observations", observations);
      if (!any && !observations.isEmpty()) {
        String reason =
            observations.stream()
                .map(item -> text(item.get("detail")))
                .filter(value -> !value.isBlank())
                .distinct()
                .reduce((a, b) -> a + " " + b)
                .orElse("");
        if (!reason.isBlank()) result.put("detail", reason);
      }
    }
    result.put(
        "costEstimate",
        ProviderCostEstimate.calculate(provider, model, speed, effort, result, costSnapshot()));
    return result;
  }

  private void captureClaudeCost(Attempt attempt, Map<String, Object> event, boolean crash) {
    if (crash) {
      attempt.costInvalid = true;
      return;
    }
    Map<String, Object> report = null;
    if (event.containsKey("total_cost_usd")) {
      BigDecimal total = ProviderCostEstimate.money(event.get("total_cost_usd"));
      if (total != null)
        report =
            fields(
                "amount",
                total.stripTrailingZeros(),
                "complete",
                true,
                "source",
                "claude.result.total_cost_usd");
    } else {
      var models = obj(event.get("modelUsage"));
      if (!models.isEmpty() && models.size() <= 100) {
        BigDecimal total = BigDecimal.ZERO;
        boolean valid = true;
        for (Object item : models.values()) {
          BigDecimal cost = ProviderCostEstimate.money(obj(item).get("costUSD"));
          if (cost == null) {
            valid = false;
            break;
          }
          total = total.add(cost);
        }
        if (valid && ProviderCostEstimate.money(total) != null)
          report =
              fields(
                  "amount",
                  total.stripTrailingZeros(),
                  "complete",
                  false,
                  "source",
                  "claude.result.modelUsage.costUSD");
      }
    }
    if (attempt.costSeen && !Objects.equals(attempt.costReport, report)) attempt.costInvalid = true;
    attempt.costSeen = true;
    attempt.costReport = report;
  }

  private Map<String, Object> costSnapshot() {
    BigDecimal total = BigDecimal.ZERO;
    boolean complete = !attempts.isEmpty(), any = false;
    var rows = new ArrayList<Map<String, Object>>();
    var sources = new LinkedHashSet<String>();
    for (int index = 0; index < attempts.size(); index++) {
      Attempt attempt = attempts.get(index);
      if (attempt.costReport == null || attempt.costInvalid) {
        complete = false;
        continue;
      }
      BigDecimal amount = (BigDecimal) attempt.costReport.get("amount");
      any = true;
      total = total.add(amount);
      complete &=
          truth(attempt.costReport.get("complete")) && !attempt.invalid && !attempt.overflow;
      sources.add(text(attempt.costReport.get("source")));
      rows.add(
          fields(
              "label",
              "CLI attempt " + (index + 1),
              "tokens",
              null,
              "ratePerMillion",
              null,
              "amount",
              ProviderCostEstimate.decimal(amount)));
    }
    return fields(
        "amount",
        any && ProviderCostEstimate.money(total) != null ? total : null,
        "complete",
        complete && finished && !cancelled,
        "breakdown",
        rows,
        "source",
        String.join(" + ", sources));
  }

  public static Map<String, Object> unavailable(String provider) {
    return new ProviderTokenUsage(provider).snapshot();
  }

  private static Map<String, Object> claude(
      Map<String, Object> usage, boolean camel, boolean outputKnown) {
    String inputKey = camel ? "inputTokens" : "input_tokens",
        outputKey = camel ? "outputTokens" : "output_tokens",
        readKey = camel ? "cacheReadInputTokens" : "cache_read_input_tokens",
        createKey = camel ? "cacheCreationInputTokens" : "cache_creation_input_tokens";
    Long input = count(usage, inputKey),
        output = outputKnown ? count(usage, outputKey) : null,
        read = count(usage, readKey),
        create = count(usage, createKey);
    if (input == null
        || outputKnown && output == null
        || invalidOptional(usage, readKey, read)
        || invalidOptional(usage, createKey, create)) return null;
    Long allInput =
        input != null && read != null && create != null ? add(input, read, create) : null;
    if (input != null && read != null && create != null && allInput == null) return null;
    Long total = allInput != null && output != null ? add(allInput, output) : null;
    if (allInput != null && output != null && total == null) return null;
    return fields(
        "inputTokens",
        allInput,
        "uncachedInputTokens",
        input,
        "outputTokens",
        output,
        "totalTokens",
        total,
        "cachedInputTokens",
        read,
        "cacheCreationInputTokens",
        create);
  }

  private static Map<String, Object> sum(List<Map<String, Object>> parts) {
    if (parts.isEmpty() || parts.stream().anyMatch(Objects::isNull)) return null;
    var result = new LinkedHashMap<String, Object>();
    for (String field : COUNTS) {
      Long value = 0L;
      for (var part : parts) {
        if (!(part.get(field) instanceof Number number)) {
          value = null;
          break;
        }
        value = add(value, number.longValue());
        if (value == null) break;
      }
      result.put(field, value);
    }
    return result;
  }

  private static Long count(Map<String, Object> usage, String field) {
    if (!(usage.get(field) instanceof Number number)) return null;
    try {
      long value = new BigDecimal(number.toString()).longValueExact();
      return value >= 0 && value <= MAX ? value : null;
    } catch (RuntimeException ignored) {
      return null;
    }
  }

  private static boolean invalidOptional(Map<String, Object> usage, String field, Long parsed) {
    return usage.containsKey(field) && usage.get(field) != null && parsed == null;
  }

  private static Long add(Long... values) {
    long total = 0;
    for (Long value : values) {
      if (value == null || value < 0 || value > MAX - total) return null;
      total += value;
    }
    return total;
  }
}
