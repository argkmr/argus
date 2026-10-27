package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import java.math.BigDecimal;
import java.util.*;

/** Local, versioned cost estimates. These values are never evidence of a provider charge. */
public final class ProviderCostEstimate {
  public static final String RATE_CARD_DATE = "2026-10-23";
  public static final String CODEX_SOURCE = "https://learn.chatgpt.com/docs/pricing";
  public static final String SPEED_SOURCE =
      "https://learn.chatgpt.com/docs/agent-configuration/speed";
  public static final String CLAUDE_SOURCE =
      "https://code.claude.com/docs/en/agent-sdk/cost-tracking";
  private static final BigDecimal MILLION = new BigDecimal("1000000");
  private static final long MAX_COUNT = 9_007_199_254_740_991L;

  public record Rates(
      String input,
      String cached,
      String output,
      String fastMultiplier,
      String ultrafastMultiplier) {}

  public record RateCard(
      Map<String, Rates> rates,
      String date,
      String sourceUrl,
      String speedSourceUrl,
      String version,
      String fetchedAt,
      String fastIncludedMultiplier,
      String ultrafastIncludedMultiplier) {
    public RateCard {
      rates = Map.copyOf(rates);
    }
  }

  // Exact model IDs only: no fuzzy matches, default models or inferred future model prices.
  private static final Map<String, Rates> CODEX_RATES =
      Map.of(
          "gpt-6-astra", new Rates("250", "25", "1250", "2", "6"),
          "gpt-6.1-sol", new Rates("50", "2.5", "250", "2", "6"),
          "gpt-6-sol", new Rates("50", "5", "250", "2", null),
          "gpt-6-luna", new Rates("2.5", "0.25", "12.5", "2", null),
          "gpt-5.6-sol", new Rates("100", "10", "500", "2", null),
          "gpt-5.6-terra", new Rates("50", "5", "300", "2", null),
          "gpt-5.6-luna", new Rates("5", "0.5", "30", "2", null));

  private static final RateCard FALLBACK_RATE_CARD =
      new RateCard(
          CODEX_RATES,
          RATE_CARD_DATE,
          CODEX_SOURCE,
          SPEED_SOURCE,
          "bundled-" + RATE_CARD_DATE,
          "",
          "2.5",
          "8");
  // These exact historical rates are not in the current published table. Keep their original
  // provenance and speed policy instead of relabeling them as newly verified rates.
  private static final RateCard LEGACY_RATE_CARD =
      new RateCard(
          Map.of(
              "gpt-5.5", new Rates("125", "12.5", "750", "2.5", null),
              "gpt-5.4", new Rates("62.5", "6.25", "375", "2", null),
              "gpt-5.4-mini", new Rates("18.75", "1.875", "113", null, null)),
          "2026-09-19",
          CODEX_SOURCE,
          SPEED_SOURCE,
          "bundled-legacy-2026-09-19",
          "",
          "",
          "");
  private static volatile RateCard currentRateCard = FALLBACK_RATE_CARD;

  private ProviderCostEstimate() {}

  public static RateCard fallbackRateCard() {
    return FALLBACK_RATE_CARD;
  }

  /** Installs an already-validated immutable catalog snapshot; never performs network I/O. */
  public static void installRateCard(RateCard card) {
    currentRateCard = Objects.requireNonNull(card);
  }

  public static Map<String, Object> calculate(
      String provider,
      String model,
      String speed,
      Map<String, Object> usage,
      Map<String, Object> providerCost) {
    return calculate(provider, model, speed, "", usage, providerCost);
  }

  public static Map<String, Object> calculate(
      String provider,
      String model,
      String speed,
      String effort,
      Map<String, Object> usage,
      Map<String, Object> providerCost) {
    RateCard card = currentRateCard;
    if (!card.rates().containsKey(text(model))) {
      if (FALLBACK_RATE_CARD.rates().containsKey(text(model))) card = FALLBACK_RATE_CARD;
      else if (LEGACY_RATE_CARD.rates().containsKey(text(model))) card = LEGACY_RATE_CARD;
    }
    var result = base(provider, model, speed, effort, card);
    if ("codex".equals(provider)) return codex(result, model, speed, usage, card);
    if ("claude".equals(provider)) return claude(result, usage, providerCost);
    return unavailable(result, "This provider does not expose a supported prompt cost estimate.");
  }

  private static Map<String, Object> base(
      String provider, String model, String speed, String effort, RateCard card) {
    return fields(
        "status",
        "unavailable",
        "unit",
        "codex".equals(provider) ? "credits" : "claude".equals(provider) ? "USD" : "",
        "amount",
        null,
        "provider",
        provider,
        "model",
        model,
        "speed",
        speed,
        "effort",
        text(effort),
        "basis",
        "codex".equals(provider) ? "selected-model-rate-card" : "provider-reported-estimate",
        "confidence",
        "unavailable",
        "rateCardDate",
        "codex".equals(provider) ? card.date() : null,
        "rateCardVersion",
        "codex".equals(provider) ? card.version() : null,
        "rateCardFetchedAt",
        "codex".equals(provider) ? card.fetchedAt() : null,
        "sourceUrl",
        "codex".equals(provider)
            ? card.sourceUrl()
            : "claude".equals(provider) ? CLAUDE_SOURCE : "",
        "detail",
        "",
        "warning",
        "",
        "breakdown",
        List.of(),
        "actualCharge",
        false);
  }

  private static Map<String, Object> codex(
      Map<String, Object> result,
      String model,
      String speed,
      Map<String, Object> usage,
      RateCard card) {
    result.put(
        "warning",
        "Credit-equivalent at the purchased-credit ChatGPT rate card for the selected model and speed, not credits charged. Actual model routing, service speed and subagent models are not verified. Included subscription usage has different speed multipliers and may cause no extra charge; API-key billing uses different dollar rates.");
    if (card == LEGACY_RATE_CARD)
      result.put(
          "warning",
          result.get("warning")
              + " This model uses a historical rate card dated 2026-09-19; its current pricing and availability have not been verified.");
    boolean counters = "provider-counters".equals(usage.get("measurement"));
    if (counters) result.put("basis", "turn-counter-rate-card");
    Rates rates = card.rates().get(text(model));
    if (rates == null)
      return unavailable(result, "No verified credit rate is available for the recorded model.");
    if (!Set.of("standard", "fast", "ultrafast").contains(text(speed)))
      return unavailable(result, "The request speed was not recorded or has no verified rate.");
    if ("fast".equals(speed) && rates.fastMultiplier() == null)
      return unavailable(result, "No verified Fast credit multiplier is available for this model.");
    if ("ultrafast".equals(speed) && rates.ultrafastMultiplier() == null)
      return unavailable(
          result, "No verified Ultrafast credit multiplier is available for this model.");
    if (!truth(usage.get("reported")))
      return unavailable(
          result,
          text(usage.get("detail")).isBlank()
              ? "No trustworthy prompt-scoped token usage is available yet."
              : text(usage.get("detail")));
    if (counters && !"argus-prompt-execution".equals(usage.get("scope")))
      return unavailable(
          result,
          "These counters are not attributed to this prompt execution. Session totals and unscoped counters are not priced.");

    Long input = count(usage.get("inputTokens")),
        uncached = count(usage.get("uncachedInputTokens")),
        cached = count(usage.get("cachedInputTokens")),
        creation = count(usage.get("cacheCreationInputTokens")),
        output = count(usage.get("outputTokens")),
        reasoning = count(usage.get("reasoningOutputTokens")),
        total = count(usage.get("totalTokens"));
    if (input == null
        || uncached == null
        || cached == null
        || creation == null
        || output == null
        || total == null
        // Reasoning is an optional output subset, never a second billed category. Reject
        // contradictory recorded values, but do not require a missing subset to price output.
        || usage.get("reasoningOutputTokens") != null && reasoning == null
        || reasoning != null && reasoning > output
        || cached > input
        || uncached > input
        || creation > input
        || input > MAX_COUNT - output
        || input + output != total
        || cached > input - creation
        || uncached != input - cached - creation)
      return unavailable(
          result,
          "The recorded usage has an incomplete or inconsistent input/cache/output breakdown. Missing counts are not priced as zero.");
    BigDecimal multiplier =
        new BigDecimal(
            "fast".equals(speed)
                ? rates.fastMultiplier()
                : "ultrafast".equals(speed) ? rates.ultrafastMultiplier() : "1");
    var rows = new ArrayList<Map<String, Object>>();
    // The normalized usage contract partitions input into uncached, cached and cache-write
    // tokens. Codex credits have no separate write surcharge: charge new/write input once.
    rows.add(
        row(
            creation == 0 ? "Uncached input" : "Uncached input (including cache writes)",
            uncached + creation,
            rates.input(),
            multiplier));
    rows.add(row("Cached input", cached, rates.cached(), multiplier));
    rows.add(row("Output", output, rates.output(), multiplier));
    BigDecimal amount = BigDecimal.ZERO;
    for (var row : rows) amount = amount.add(new BigDecimal(text(row.get("amount"))));
    String status = estimateStatus(usage, !counters);
    result.put("status", status);
    result.put("amount", decimal(amount));
    result.put("breakdown", rows);
    result.put("speedMultiplier", decimal(multiplier));
    result.put(
        "includedUsageMultiplier",
        "fast".equals(speed)
            ? card.fastIncludedMultiplier()
            : "ultrafast".equals(speed) ? card.ultrafastIncludedMultiplier() : "1");
    result.put("speedSourceUrl", card.speedSourceUrl());
    result.put("confidence", counters ? "approximate" : "recorded-usage");
    result.put(
        "detail",
        counters
            ? "Approximate credit-equivalent for the attributable turn counters using selected settings. These counters may include context estimates or omit calls and subagents; this is not a complete billing total. Cache reads are counted once, cache writes use the ordinary input rate, and reasoning is already included in output."
            : "estimate".equals(status)
                ? "Estimate for the recorded execution using selected settings. Cached input is charged only once; cache writes use the ordinary input rate and reasoning is already included in output."
                : "live".equals(status)
                    ? "Estimate for recorded tokens so far, not a final prompt total."
                    : "Estimate for the recorded portion only. Missing model calls or subagent usage are not estimated; the full prompt may cost more.");
    return result;
  }

  private static Map<String, Object> row(
      String label, long tokens, String rate, BigDecimal multiplier) {
    BigDecimal appliedRate = new BigDecimal(rate).multiply(multiplier);
    return fields(
        "label",
        label,
        "tokens",
        tokens,
        "ratePerMillion",
        decimal(appliedRate),
        "amount",
        decimal(BigDecimal.valueOf(tokens).multiply(appliedRate).divide(MILLION)));
  }

  private static Map<String, Object> claude(
      Map<String, Object> result, Map<String, Object> usage, Map<String, Object> providerCost) {
    result.put(
        "warning",
        "Claude's CLI/SDK calculates dollar estimates with its own pricing table. This is not an authoritative bill or a deduction from a subscription allowance; no conversion to Codex credits is made.");
    BigDecimal amount = money(providerCost.get("amount"));
    if (amount == null)
      return unavailable(
          result,
          "No trustworthy prompt-scoped dollar estimate was reported by Claude. Token counts alone are not converted using a guessed price.");
    String status = estimateStatus(usage, truth(providerCost.get("complete")));
    result.put("amount", decimal(amount));
    result.put("status", status);
    result.put("confidence", "provider-reported-estimate");
    result.put("breakdown", providerCost.getOrDefault("breakdown", List.of()));
    result.put("reportedCostSource", providerCost.getOrDefault("source", ""));
    result.put(
        "detail",
        "estimate".equals(status)
            ? "Provider-reported dollar estimate across this request's recorded CLI attempts. The CLI's rate-card version and individual token prices were not reported."
            : "live".equals(status)
                ? "Provider-reported dollar estimate received so far, not a final prompt total."
                : "Partial provider-reported dollar estimate. Missing, conflicting or cancelled attempts and unreported fees are not guessed.");
    return result;
  }

  private static String estimateStatus(Map<String, Object> usage, boolean complete) {
    if ("live".equals(usage.get("status"))) return "live";
    return complete && truth(usage.get("exact")) && "final".equals(usage.get("status"))
        ? "estimate"
        : "partial";
  }

  private static Map<String, Object> unavailable(Map<String, Object> result, String detail) {
    result.put("detail", detail);
    return result;
  }

  static BigDecimal money(Object value) {
    if (!(value instanceof Number number)) return null;
    try {
      BigDecimal amount = new BigDecimal(number.toString());
      // Bounds prevent hostile protocol values from producing enormous decimal strings.
      return amount.signum() >= 0
              && amount.precision() <= 40
              && Math.abs((long) amount.scale()) <= 18
              && amount.compareTo(new BigDecimal("1000000000")) <= 0
          ? amount
          : null;
    } catch (RuntimeException ignored) {
      return null;
    }
  }

  static String decimal(BigDecimal value) {
    return value.stripTrailingZeros().toPlainString();
  }

  private static Long count(Object value) {
    if (!(value instanceof Number number)) return null;
    try {
      long count = new BigDecimal(number.toString()).longValueExact();
      return count >= 0 && count <= MAX_COUNT ? count : null;
    } catch (RuntimeException ignored) {
      return null;
    }
  }
}
