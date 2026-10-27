package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import java.math.BigDecimal;
import java.util.*;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class ProviderCostEstimateTest {
  @Test
  void wireJsonPreservesProviderDecimalPrecisionWithoutChangingSharedMapper() {
    var mapper = new ObjectMapper();
    var tracker = tracker("claude");
    var stream = new AgentOutputStream(mapper, true, tracker::accept);
    String event =
        """
        {"type":"result","subtype":"success","total_cost_usd":0.123456789012345678,
        "modelUsage":{"opus":{"inputTokens":100,"outputTokens":10,
        "cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.123456789012345678}}}
        """
            .replace("\n", "");
    stream.append(event.substring(0, event.length() / 2));
    stream.append(event.substring(event.length() / 2));
    stream.finish();
    tracker.finish(false);
    assertThat(cost(tracker)).containsEntry("amount", "0.123456789012345678");
    var persisted = mapper.readValue(mapper.writeValueAsString(tracker.snapshot()), Map.class);
    assertThat(obj(persisted.get("costEstimate"))).containsEntry("amount", "0.123456789012345678");
    assertThat(mapper.readValue("0.123456789012345678", Object.class)).isInstanceOf(Double.class);
  }

  private Map<String, Object> codexUsage() {
    return fields(
        "reported",
        true,
        "status",
        "partial",
        "exact",
        false,
        "inputTokens",
        194377,
        "uncachedInputTokens",
        1353,
        "cachedInputTokens",
        193024,
        "cacheCreationInputTokens",
        0,
        "outputTokens",
        11,
        "reasoningOutputTokens",
        0,
        "totalTokens",
        194388);
  }

  private Map<String, Object> calculate(String model, String speed, Map<String, Object> usage) {
    return ProviderCostEstimate.calculate("codex", model, speed, usage, Map.of());
  }

  private ProviderTokenUsage tracker(String provider) {
    var tracker =
        new ProviderTokenUsage(
            provider, "codex".equals(provider) ? "gpt-5.6-sol" : "claude-opus-4-6", "standard");
    tracker.beginAttempt();
    return tracker;
  }

  private Map<String, Object> cost(ProviderTokenUsage tracker) {
    return obj(tracker.snapshot().get("costEstimate"));
  }

  private Map<String, Object> claudeModel(Object cost) {
    var model =
        fields(
            "inputTokens",
            100,
            "outputTokens",
            10,
            "cacheReadInputTokens",
            200,
            "cacheCreationInputTokens",
            50);
    if (cost != null) model.put("costUSD", cost);
    return model;
  }

  private Map<String, Object> claudeResult(Object total) {
    var result =
        fields(
            "type",
            "result",
            "subtype",
            "success",
            "modelUsage",
            fields(
                "opus",
                claudeModel(new BigDecimal("0.2")),
                "haiku",
                claudeModel(new BigDecimal("0.1"))));
    if (total != null) result.put("total_cost_usd", total);
    return result;
  }

  @Test
  void screenshotCountsArePricedWithoutDoubleCountingCacheOrRoundingEarly() {
    var estimate = calculate("gpt-5.6-sol", "standard", codexUsage());
    assertThat(estimate)
        .containsEntry("status", "partial")
        .containsEntry("unit", "credits")
        .containsEntry("amount", "2.07104")
        .containsEntry("actualCharge", false)
        .containsEntry("basis", "selected-model-rate-card")
        .containsEntry("confidence", "recorded-usage")
        .containsEntry("rateCardDate", "2026-10-23")
        .containsEntry("sourceUrl", ProviderCostEstimate.CODEX_SOURCE);
    var rows = ProviderCostEstimateTest.<Map<String, Object>>asList(estimate.get("breakdown"));
    assertThat(rows).hasSize(3);
    assertThat(rows.get(0))
        .containsEntry("amount", "0.1353")
        .containsEntry("ratePerMillion", "100");
    assertThat(rows.get(1))
        .containsEntry("amount", "1.93024")
        .containsEntry("ratePerMillion", "10");
    assertThat(rows.get(2))
        .containsEntry("amount", "0.0055")
        .containsEntry("ratePerMillion", "500");
    assertThat(text(estimate.get("warning")))
        .contains("not credits charged", "service speed", "API-key");
  }

  @SuppressWarnings("unchecked")
  private static <T> List<T> asList(Object value) {
    return (List<T>) value;
  }

  @Test
  void fastRatesApplyPreciselyOnceAndReasoningIsNotExtraOutput() {
    var usage = codexUsage();
    usage.put("reasoningOutputTokens", 11);
    assertThat(calculate("gpt-5.6-sol", "fast", usage))
        .containsEntry("amount", "4.14208")
        .containsEntry("speedMultiplier", "2")
        .containsEntry("includedUsageMultiplier", "2.5")
        .containsEntry("speedSourceUrl", ProviderCostEstimate.SPEED_SOURCE);
    var standard = calculate("gpt-5.4", "standard", usage);
    var fast = calculate("gpt-5.4", "fast", usage);
    assertThat(new BigDecimal(text(fast.get("amount"))))
        .isEqualByComparingTo(
            new BigDecimal(text(standard.get("amount"))).multiply(new BigDecimal("2")));
  }

  @Test
  void effortIsRecordedButDoesNotInventAPriceMultiplier() {
    for (String effort : List.of("low", "high", "ultra", "auto", "")) {
      var estimate =
          ProviderCostEstimate.calculate(
              "codex", "gpt-5.6-sol", "standard", effort, codexUsage(), Map.of());
      assertThat(estimate).containsEntry("effort", effort).containsEntry("amount", "2.07104");
    }
    assertThat(calculate("gpt-5.6-sol", "standard", codexUsage())).containsEntry("effort", "");
    var tracker = new ProviderTokenUsage("codex", "gpt-5.6-sol", "fast", "ultra");
    tracker.beginAttempt();
    tracker.recordCodexRollout(codexUsage());
    tracker.finish(false);
    assertThat(cost(tracker)).containsEntry("effort", "ultra").containsEntry("amount", "4.14208");
  }

  @Test
  void currentExactModelRatesAndUltrafastEligibilityAreVersioned() {
    var usage = codexUsage();
    usage.putAll(
        fields(
            "inputTokens", 2_000_000L,
            "uncachedInputTokens", 1_000_000L,
            "cachedInputTokens", 1_000_000L,
            "outputTokens", 1_000_000L,
            "totalTokens", 3_000_000L));
    var expected =
        Map.of(
            "gpt-6-astra", "1525",
            "gpt-6.1-sol", "302.5",
            "gpt-6-sol", "305",
            "gpt-6-luna", "15.25",
            "gpt-5.6-sol", "610",
            "gpt-5.6-terra", "355",
            "gpt-5.6-luna", "35.5");
    expected.forEach(
        (model, amount) -> {
          assertThat(calculate(model, "standard", usage))
              .containsEntry("amount", amount)
              .containsEntry("speedMultiplier", "1")
              .containsEntry("rateCardDate", "2026-10-23");
          assertThat(calculate(model, "fast", usage))
              .containsEntry(
                  "amount",
                  ProviderCostEstimate.decimal(
                      new BigDecimal(amount).multiply(new BigDecimal("2"))));
        });
    for (String model : List.of("gpt-6-astra", "gpt-6.1-sol"))
      assertThat(calculate(model, "ultrafast", usage))
          .containsEntry("speedMultiplier", "6")
          .containsEntry("includedUsageMultiplier", "8")
          .containsEntry(
              "amount",
              ProviderCostEstimate.decimal(
                  new BigDecimal(expected.get(model)).multiply(new BigDecimal("6"))));
    for (String model : List.of("gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"))
      assertThat(calculate(model, "ultrafast", usage))
          .containsEntry("status", "unavailable")
          .containsEntry("amount", null);
  }

  @Test
  void screenshotTurnCountersHaveAnApproximateFastCreditEquivalent() {
    var usage = codexUsage();
    usage.putAll(
        fields(
            "measurement", "provider-counters",
            "scope", "argus-prompt-execution",
            "coverage", "turn-scoped-provider-counters",
            "inputTokens", 1_048_840L,
            "uncachedInputTokens", 16_392L,
            "cachedInputTokens", 1_032_448L,
            "outputTokens", 5_007L,
            "reasoningOutputTokens", 2_857L,
            "totalTokens", 1_053_847L));
    var estimate = calculate("gpt-6-sol", "fast", usage);
    assertThat(estimate)
        .containsEntry("amount", "14.46718")
        .containsEntry("status", "partial")
        .containsEntry("confidence", "approximate")
        .containsEntry("basis", "turn-counter-rate-card")
        .containsEntry("actualCharge", false);
    assertThat(text(estimate.get("detail")))
        .contains("Approximate", "context estimates", "not a complete billing total");
    var tracker = new ProviderTokenUsage("codex", "gpt-6-sol", "fast", "high");
    tracker.beginAttempt();
    tracker.recordCodexRollout(usage);
    assertThat(cost(tracker)).containsEntry("status", "live").containsEntry("amount", "14.46718");
    tracker.finish(false);
    assertThat(cost(tracker))
        .containsEntry("status", "partial")
        .containsEntry("confidence", "approximate")
        .containsEntry("amount", "14.46718");
    // Even a mislabeled final/exact counter snapshot cannot become a final billing claim.
    usage.put("status", "final");
    usage.put("exact", true);
    assertThat(calculate("gpt-6-sol", "fast", usage)).containsEntry("status", "partial");
  }

  @Test
  void unscopedOrInvalidCountersAreNeverPricedAndMissingCoverageStaysPartial() {
    var usage = codexUsage();
    usage.put("measurement", "provider-counters");
    for (String scope : List.of("", "session", "context-window", "whole-thread")) {
      usage.put("scope", scope);
      assertThat(calculate("gpt-6-sol", "standard", usage))
          .containsEntry("status", "unavailable")
          .containsEntry("confidence", "unavailable")
          .containsEntry("amount", null);
    }
    usage.put("scope", "argus-prompt-execution");
    usage.put("incompleteCounterCoverage", true);
    assertThat(calculate("gpt-6-sol", "standard", usage))
        .containsEntry("status", "partial")
        .containsEntry("confidence", "approximate");
    usage.put("cachedInputTokens", 194_378L);
    assertThat(calculate("gpt-6-sol", "standard", usage))
        .containsEntry("status", "unavailable")
        .containsEntry("amount", null);
  }

  @Test
  void cacheWritesUseOrdinaryInputRateExactlyOnceWithoutASeparateSurcharge() {
    var usage = codexUsage();
    usage.put("uncachedInputTokens", 353L);
    usage.put("cacheCreationInputTokens", 1_000L);
    var estimate = calculate("gpt-5.6-sol", "standard", usage);
    assertThat(estimate).containsEntry("amount", "2.07104");
    var rows = ProviderCostEstimateTest.<Map<String, Object>>asList(estimate.get("breakdown"));
    assertThat(rows).hasSize(3);
    assertThat(rows.get(0))
        .containsEntry("label", "Uncached input (including cache writes)")
        .containsEntry("tokens", 1_353L)
        .containsEntry("amount", "0.1353");
    usage.put("uncachedInputTokens", 1_353L);
    assertThat(calculate("gpt-5.6-sol", "standard", usage))
        .containsEntry("status", "unavailable")
        .containsEntry("amount", null);
  }

  @Test
  void runtimeCatalogUsesOneImmutableSnapshotAndFallbackKeepsItsOwnMetadata() {
    var rates = new LinkedHashMap<String, ProviderCostEstimate.Rates>();
    rates.put("verified-new-model", new ProviderCostEstimate.Rates("1", "1", "1", "3", "7"));
    var card =
        new ProviderCostEstimate.RateCard(
            rates,
            "2026-10-24",
            ProviderCostEstimate.CODEX_SOURCE,
            ProviderCostEstimate.SPEED_SOURCE,
            "verified-snapshot-hash",
            "2026-10-24T00:00:00Z",
            "4",
            "9");
    rates.clear();
    assertThat(card.rates()).containsKey("verified-new-model");
    assertThatThrownBy(() -> card.rates().clear())
        .isInstanceOf(UnsupportedOperationException.class);
    try {
      ProviderCostEstimate.installRateCard(card);
      assertThat(calculate("verified-new-model", "fast", codexUsage()))
          .containsEntry("amount", "0.583164")
          .containsEntry("speedMultiplier", "3")
          .containsEntry("includedUsageMultiplier", "4")
          .containsEntry("rateCardVersion", "verified-snapshot-hash")
          .containsEntry("rateCardDate", "2026-10-24")
          .containsEntry("rateCardFetchedAt", "2026-10-24T00:00:00Z");
      assertThat(calculate("verified-new-model", "ultrafast", codexUsage()))
          .containsEntry("speedMultiplier", "7")
          .containsEntry("includedUsageMultiplier", "9");
      assertThat(calculate("gpt-5.6-sol", "standard", codexUsage()))
          .containsEntry("amount", "2.07104")
          .containsEntry("rateCardDate", "2026-10-23")
          .containsEntry("rateCardVersion", "bundled-2026-10-23")
          .containsEntry("rateCardFetchedAt", "");
      assertThat(calculate("gpt-5.4", "standard", codexUsage()))
          .containsEntry("rateCardDate", "2026-09-19")
          .containsEntry("rateCardVersion", "bundled-legacy-2026-09-19")
          .containsEntry("rateCardFetchedAt", "");
      assertThat(calculate("unverified-new-model", "standard", codexUsage()))
          .containsEntry("status", "unavailable")
          .containsEntry("amount", null);
    } finally {
      ProviderCostEstimate.installRateCard(ProviderCostEstimate.fallbackRateCard());
    }
  }

  @Test
  void legacyModelsKeepHistoricalProvenanceAndDoNotClaimCurrentVerification() {
    assertThat(ProviderCostEstimate.fallbackRateCard().rates())
        .hasSize(7)
        .doesNotContainKeys("gpt-5.5", "gpt-5.4", "gpt-5.4-mini");
    for (String model : List.of("gpt-5.5", "gpt-5.4", "gpt-5.4-mini")) {
      var estimate = calculate(model, "standard", codexUsage());
      assertThat(estimate)
          .doesNotContainEntry("amount", null)
          .containsEntry("rateCardDate", "2026-09-19")
          .containsEntry("rateCardVersion", "bundled-legacy-2026-09-19")
          .containsEntry("rateCardFetchedAt", "");
      assertThat(text(estimate.get("warning")))
          .contains(
              "historical rate card", "current pricing and availability have not been verified");
    }
    assertThat(calculate("gpt-5.5", "fast", codexUsage()))
        .containsEntry("speedMultiplier", "2.5")
        .containsEntry("includedUsageMultiplier", "");
    assertThat(calculate("gpt-5.4", "fast", codexUsage()))
        .containsEntry("speedMultiplier", "2")
        .containsEntry("includedUsageMultiplier", "");
  }

  @Test
  void missingReasoningSubsetIsOptionalButContradictoryCountsAreNotPriced() {
    var usage = codexUsage();
    usage.remove("reasoningOutputTokens");
    assertThat(calculate("gpt-5.6-sol", "standard", usage)).containsEntry("amount", "2.07104");
    for (Object invalid : List.of(12, -1, 0.5, "11", Double.NaN)) {
      usage.put("reasoningOutputTokens", invalid);
      assertThat(calculate("gpt-5.6-sol", "standard", usage))
          .containsEntry("status", "unavailable")
          .containsEntry("amount", null);
    }
  }

  @Test
  void missingModelsSpeedsAndUnknownFastRatesAreNeverGuessed() {
    for (String model :
        List.of("", "provider default", "gpt-5.6-sol-future", "gpt-5.3-codex-spark", "gpt-image-2"))
      assertThat(calculate(model, "standard", codexUsage()))
          .containsEntry("amount", null)
          .containsEntry("status", "unavailable");
    for (String speed : List.of("", "normal", "auto", "ultra", "priority"))
      assertThat(calculate("gpt-5.6-sol", speed, codexUsage()))
          .containsEntry("amount", null)
          .containsEntry("status", "unavailable");
    assertThat(calculate("gpt-5.4-mini", "fast", codexUsage())).containsEntry("amount", null);
    assertThat(calculate("gpt-5.4-mini", "standard", codexUsage()))
        .doesNotContainEntry("amount", null);
  }

  @Test
  void allNumericCategoriesMustBeCompleteNonnegativeAndConsistent() {
    for (String field :
        List.of(
            "inputTokens",
            "uncachedInputTokens",
            "cachedInputTokens",
            "cacheCreationInputTokens",
            "outputTokens",
            "totalTokens")) {
      for (Object bad :
          Arrays.asList(
              null, -1, 0.2, "100", Double.NaN, Double.POSITIVE_INFINITY, 9_007_199_254_740_992L)) {
        var usage = codexUsage();
        usage.put(field, bad);
        assertThat(calculate("gpt-5.6-sol", "standard", usage))
            .as(field + ": " + bad)
            .containsEntry("status", "unavailable")
            .containsEntry("amount", null);
      }
    }
    for (String field :
        List.of(
            "inputTokens",
            "uncachedInputTokens",
            "cachedInputTokens",
            "totalTokens",
            "cacheCreationInputTokens")) {
      var usage = codexUsage();
      usage.put(field, ((Number) usage.get(field)).longValue() + 1);
      assertThat(calculate("gpt-5.6-sol", "standard", usage)).containsEntry("amount", null);
    }
  }

  @Test
  void reportedZeroIsFreeButMissingUsageIsNotZeroAndLiveIsNotFinal() {
    var zero = codexUsage();
    zero.replaceAll((key, value) -> key.endsWith("Tokens") ? 0 : value);
    assertThat(calculate("gpt-5.6-sol", "standard", zero)).containsEntry("amount", "0");
    zero.put("reported", false);
    assertThat(calculate("gpt-5.6-sol", "standard", zero)).containsEntry("amount", null);
    var live = codexUsage();
    live.put("status", "live");
    assertThat(calculate("gpt-5.6-sol", "standard", live)).containsEntry("status", "live");
  }

  @Test
  void actualTrackerSnapshotsCarryPricingUsingTheRecordedSettings() {
    var tracker = tracker("codex");
    tracker.recordCodexRollout(codexUsage());
    assertThat(cost(tracker)).containsEntry("status", "live").containsEntry("amount", "2.07104");
    tracker.finish(false);
    assertThat(cost(tracker)).containsEntry("status", "partial").containsEntry("amount", "2.07104");
    assertThat(obj(ProviderTokenUsage.unavailable("codex").get("costEstimate")))
        .containsEntry("status", "unavailable")
        .containsEntry("amount", null);
  }

  @Test
  void claudeTotalCostIsNotAddedToPerModelCostsAndDuplicateResultsAreDeduplicated() {
    var tracker = tracker("claude");
    var result =
        claudeResult(new BigDecimal("0.35")); // includes a provider fee beyond model subtotal
    tracker.accept(result);
    tracker.accept(result);
    assertThat(cost(tracker)).containsEntry("status", "live").containsEntry("amount", "0.35");
    tracker.finish(false);
    assertThat(cost(tracker))
        .containsEntry("status", "estimate")
        .containsEntry("amount", "0.35")
        .containsEntry("unit", "USD")
        .containsEntry("actualCharge", false)
        .containsEntry("rateCardDate", null)
        .containsEntry("basis", "provider-reported-estimate");
    assertThat(text(cost(tracker).get("warning")))
        .contains("not an authoritative bill", "no conversion");
  }

  @Test
  void claudeModelCostsWithoutTotalRemainPartialBecauseFeesMayBeMissing() {
    var tracker = tracker("claude");
    tracker.accept(claudeResult(null));
    tracker.finish(false);
    assertThat(cost(tracker))
        .containsEntry("status", "partial")
        .containsEntry("amount", "0.3")
        .containsEntry("reportedCostSource", "claude.result.modelUsage.costUSD");
    var missing = tracker("claude");
    var event = claudeResult(null);
    obj(obj(event.get("modelUsage")).get("haiku")).remove("costUSD");
    missing.accept(event);
    missing.finish(false);
    assertThat(cost(missing)).containsEntry("amount", null);
  }

  @Test
  void malformedTotalsDoNotFallBackToPlausibleLookingModelCosts() {
    for (Object bad :
        Arrays.asList(
            -1,
            "0.3",
            Double.NaN,
            Double.POSITIVE_INFINITY,
            new BigDecimal("1e100000"),
            new BigDecimal("1e-100000"),
            new BigDecimal("1000000001"))) {
      var tracker = tracker("claude");
      tracker.accept(claudeResult(bad));
      tracker.finish(false);
      assertThat(cost(tracker))
          .as(String.valueOf(bad))
          .containsEntry("status", "unavailable")
          .containsEntry("amount", null);
    }
    var zero = tracker("claude");
    zero.accept(claudeResult(BigDecimal.ZERO));
    zero.finish(false);
    assertThat(cost(zero)).containsEntry("amount", "0");
  }

  @Test
  void independentAttemptsSumOnceButMissingCancelledAndConflictingOnesStayIncomplete() {
    var tracker = tracker("claude");
    tracker.accept(claudeResult(new BigDecimal("0.3")));
    tracker.beginAttempt();
    tracker.accept(claudeResult(new BigDecimal("0.4")));
    tracker.finish(false);
    assertThat(cost(tracker)).containsEntry("amount", "0.7").containsEntry("status", "estimate");
    assertThat(asList(cost(tracker).get("breakdown"))).hasSize(2);
    var missing = tracker("claude");
    missing.beginAttempt();
    missing.accept(claudeResult(new BigDecimal("0.4")));
    missing.finish(false);
    assertThat(cost(missing)).containsEntry("amount", "0.4").containsEntry("status", "partial");
    var cancelled = tracker("claude");
    cancelled.accept(claudeResult(new BigDecimal("0.4")));
    cancelled.finish(true);
    assertThat(cost(cancelled)).containsEntry("amount", "0.4").containsEntry("status", "partial");
    var conflict = tracker("claude");
    conflict.accept(claudeResult(new BigDecimal("0.3")));
    conflict.accept(claudeResult(new BigDecimal("0.4")));
    conflict.finish(false);
    assertThat(cost(conflict)).containsEntry("amount", null).containsEntry("status", "unavailable");
  }

  @Test
  void costFingerprintNormalizesDecimalScaleButMissingOrConflictingAttemptsCannotRecover() {
    var tracker = tracker("claude");
    tracker.accept(claudeResult(new BigDecimal("0.30")));
    tracker.accept(claudeResult(new BigDecimal("0.3")));
    tracker.finish(false);
    assertThat(cost(tracker)).containsEntry("amount", "0.3").containsEntry("status", "estimate");
    var conflict = tracker("claude");
    conflict.accept(claudeResult(new BigDecimal("0.3")));
    conflict.accept(claudeResult(new BigDecimal("0.4")));
    conflict.accept(claudeResult(new BigDecimal("0.3")));
    conflict.beginAttempt();
    conflict.accept(claudeResult(new BigDecimal("0.2")));
    conflict.finish(false);
    assertThat(cost(conflict)).containsEntry("amount", "0.2").containsEntry("status", "partial");
  }

  @Test
  void crashDefaultZeroAndToolPayloadCostsAreNotTrustworthyReports() {
    var tracker = tracker("claude");
    var crash = claudeResult(BigDecimal.ZERO);
    crash.put("subtype", "error_during_execution");
    tracker.accept(crash);
    tracker.finish(false);
    assertThat(cost(tracker)).containsEntry("amount", null);
    var payload = tracker("claude");
    payload.accept(fields("type", "assistant", "message", claudeResult(new BigDecimal("99"))));
    payload.finish(false);
    assertThat(cost(payload)).containsEntry("amount", null);
    assertThat(
            ProviderCostEstimate.calculate("custom", "model", "standard", codexUsage(), Map.of()))
        .containsEntry("amount", null)
        .containsEntry("status", "unavailable");
  }
}
