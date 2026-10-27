package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.common.storage.AtomicJsonStore;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

/** Only synthetic public documentation and loopback HTTP; never reads user accounts or caches. */
class CodexCreditRateCatalogTest {
  private static final Instant FETCHED = Instant.parse("2026-10-23T12:00:00Z");
  private static final String HEADER =
      """
      <thead><tr><th>Credits per 1M tokens</th><th>Input Tokens</th>
      <th>Cached input tokens</th><th>Output Tokens</th></tr></thead>
      """;
  private static final String FUTURE_ROW =
      "<tr><td>GPT-7 Future</td><td>75 credits</td><td>7.5 credits</td><td>375 credits</td></tr>";
  private static final String PRICING =
      """
      # Codex credit pricing
      Codex credit billing has no separate cache-write charge.
      Fast mode uses 2x the Standard rate. Ultrafast mode uses 6x the Standard rate.
      <table class="credit-rates">
      """
          + HEADER
          + """
          <tbody><tr><td><strong>GPT-6.1 Sol</strong></td><td>50 credits</td>
          <td>2.5 credits</td><td>250 credits</td></tr>
          <tr><td>GPT-6 Astra</td><td>250 credits</td><td>25 credits</td><td>1,250 credits</td></tr>
          """
          + FUTURE_ROW
          + "<tr><td>Orion 7</td><td>10 credits</td><td>1 credits</td><td>50 credits</td></tr>"
          + "</tbody></table>";
  private static final String SPEED =
      """
      # Speed modes
      Fast mode speeds up supported models, including GPT-6.1 Sol, GPT-6 Astra and GPT-7 Future, where available.
      Fast mode uses included subscription limits at 2.5x the Standard rate.
      Ultrafast uses included subscription limits at 8x the Standard rate.
      Ultrafast supports GPT-6.1 Sol, GPT-6 Astra and GPT-7 Future.
      """;

  @TempDir Path home;
  private final AtomicJsonStore json = new AtomicJsonStore(new ObjectMapper());

  @BeforeEach
  @AfterEach
  void restoreBundledCard() {
    ProviderCostEstimate.installRateCard(ProviderCostEstimate.fallbackRateCard());
  }

  private Path cache() {
    return home.resolve("pricing-cache/codex-credits.json");
  }

  private CodexCreditRateCatalog catalog(Loopback source, Clock clock) {
    return new CodexCreditRateCatalog(cache(), json, source.fetcher(), clock, false);
  }

  private static Map<String, Object> estimate(String model, String speed) {
    return ProviderCostEstimate.calculate(
        "codex",
        model,
        speed,
        "high",
        fields(
            "status", "partial",
            "reported", true,
            "exact", false,
            "scope", "argus-prompt-execution",
            "inputTokens", 1_000_000L,
            "uncachedInputTokens", 500_000L,
            "cachedInputTokens", 500_000L,
            "cacheCreationInputTokens", 0L,
            "outputTokens", 100_000L,
            "reasoningOutputTokens", 10_000L,
            "totalTokens", 1_100_000L),
        Map.of());
  }

  @Test
  void currentHtmlTableAcceptsExactFutureModelLabelsAndSeparateSpeedPolicies() {
    var card = CodexCreditRateCatalog.parse(PRICING, SPEED, FETCHED);
    assertThat(card.rates())
        .containsOnlyKeys("gpt-6.1-sol", "gpt-6-astra", "gpt-7-future", "orion-7");
    assertThat(card.rates().get("gpt-7-future"))
        .isEqualTo(new ProviderCostEstimate.Rates("75", "7.5", "375", "2", "6"));
    assertThat(card.rates().get("gpt-6-astra").output()).isEqualTo("1250");
    assertThat(card.rates().get("orion-7").ultrafastMultiplier()).isNull();
    assertThat(card.rates().get("orion-7").fastMultiplier()).isNull();
    assertThat(card.fastIncludedMultiplier()).isEqualTo("2.5");
    assertThat(card.ultrafastIncludedMultiplier()).isEqualTo("8");
    assertThat(card.date()).isEqualTo("2026-10-23");
    assertThat(card.fetchedAt()).isEqualTo(FETCHED.toString());
    assertThat(card.version()).matches("[a-f0-9]{64}");
    assertThat(card.sourceUrl()).isEqualTo(ProviderCostEstimate.CODEX_SOURCE);
    assertThatThrownBy(() -> card.rates().clear())
        .isInstanceOf(UnsupportedOperationException.class);
  }

  @Test
  void realHttpRefreshPricesNewModelsAndSendsOnlyPublicDocumentationRequests() throws Exception {
    try (var source = new Loopback();
        var catalog = catalog(source, Clock.fixed(FETCHED, ZoneOffset.UTC))) {
      assertThat(estimate("gpt-7-future", "fast")).containsEntry("amount", null);
      catalog.refresh();
      var expected = CodexCreditRateCatalog.parse(PRICING, SPEED, FETCHED);
      assertThat(estimate("gpt-7-future", "fast"))
          .containsEntry("amount", "157.5")
          .containsEntry("speedMultiplier", "2")
          .containsEntry("includedUsageMultiplier", "2.5")
          .containsEntry("rateCardVersion", expected.version())
          .containsEntry("rateCardFetchedAt", FETCHED.toString())
          .containsEntry("actualCharge", false);
      assertThat(estimate("gpt-7-future", "ultrafast"))
          .containsEntry("amount", "472.5")
          .containsEntry("speedMultiplier", "6")
          .containsEntry("includedUsageMultiplier", "8");
      assertThat(estimate("orion-7", "standard")).containsEntry("amount", "10.5");
      assertThat(estimate("orion-7-preview", "standard")).containsEntry("amount", null);
      assertThat(estimate("orion-7", "fast")).containsEntry("amount", null);
      assertThat(estimate("orion-7", "ultrafast")).containsEntry("amount", null);
      assertThat(source.requests)
          .extracting(Request::path)
          .containsExactly(
              CodexCreditRateCatalog.PRICING.getPath(), CodexCreditRateCatalog.SPEED.getPath());
      for (Request request : source.requests) {
        assertThat(request.method()).isEqualTo("GET");
        assertThat(request.body()).isEmpty();
        assertThat(request.query()).isNull();
        assertThat(request.headers())
            .doesNotContainKeys(
                "authorization", "proxy-authorization", "cookie", "x-api-key", "api-key");
        assertThat(request.headers().get("user-agent")).containsExactly("Argus-Public-Rate-Card/1");
        assertThat(request.headers().get("accept"))
            .containsExactly("text/markdown,text/plain,text/html");
      }
      var saved = json.read(cache(), Map.class);
      assertThat(saved)
          .containsEntry("pricingSource", CodexCreditRateCatalog.PRICING.toString())
          .containsEntry("speedSource", CodexCreditRateCatalog.SPEED.toString())
          .containsEntry("fetchedAt", FETCHED.toString())
          .containsEntry("pricing", PRICING)
          .containsEntry("speed", SPEED);
    }
  }

  @Test
  void malformedOrDuplicateRowsCannotInstallAPartialRateTable() {
    var badRows =
        List.of(
            "<tr><td>GPT-8 Broken</td><td>100 credits</td></tr>",
            "<tr><td>Orion 8</td><td>100 credits</td><td>10 credits</td><td>500 credits</td><td>extra</td></tr>",
            "<tr><td>GPT-8 Broken</td><td>not published</td><td>10 credits</td><td>500 credits</td></tr>",
            "<tr><td>GPT-8 Broken</td><td>10 credits</td><td>11 credits</td><td>50 credits</td></tr>",
            "<tr><td>GPT-8 Broken</td><td>-1 credits</td><td>0 credits</td><td>50 credits</td></tr>",
            "<tr><td>GPT-8 Broken</td><td>1.1234567 credits</td><td>0 credits</td><td>50 credits</td></tr>",
            "<tr><td>GPT-8 Broken</td><td>1000001 credits</td><td>0 credits</td><td>50 credits</td></tr>",
            FUTURE_ROW,
            FUTURE_ROW.replace("GPT-7 Future", "gpt-7 future"));
    for (String row : badRows)
      assertThatThrownBy(
              () ->
                  CodexCreditRateCatalog.parse(
                      PRICING.replace("</tbody>", row + "</tbody>"), SPEED, FETCHED))
          .as(row)
          .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                CodexCreditRateCatalog.parse(
                    PRICING + "<table>" + HEADER + FUTURE_ROW + "</table>", SPEED, FETCHED))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void missingOrChangedBillingPoliciesAreNotGuessed() {
    for (String pricing :
        List.of(
            PRICING.replace(
                "Codex credit billing has no separate cache-write charge",
                "Cache-write billing changed"),
            PRICING.replace("Fast mode uses 2x", "Fast mode uses an unspecified amount"),
            PRICING.replace("Ultrafast mode uses 6x", "Ultrafast mode uses 101x")))
      assertThatThrownBy(() -> CodexCreditRateCatalog.parse(pricing, SPEED, FETCHED))
          .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                CodexCreditRateCatalog.parse(
                    PRICING, SPEED.replace("Ultrafast supports", "Models unavailable"), FETCHED))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                CodexCreditRateCatalog.parse(
                    PRICING,
                    SPEED.replace(
                        "Fast mode speeds up supported models, including", "Models unavailable"),
                    FETCHED))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void eligibilityDoesNotConfuseResidencyTextAndConflictingPoliciesFailClosed() {
    var card =
        CodexCreditRateCatalog.parse(
            PRICING,
            SPEED + "\nGPT-6.1 Sol Ultrafast supports inference residency in Europe.\n",
            FETCHED);
    assertThat(card.rates().get("gpt-7-future").ultrafastMultiplier()).isEqualTo("6");
    assertThatThrownBy(
            () ->
                CodexCreditRateCatalog.parse(
                    PRICING + " Fast mode uses 3x the Standard rate.", SPEED, FETCHED))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                CodexCreditRateCatalog.parse(
                    PRICING, SPEED + "\nUltrafast supports Orion 7.\n", FETCHED))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void cachedRestartWorksOfflineAndFailedRefreshPreservesCardAndOriginalTimestamp()
      throws Exception {
    try (var source = new Loopback()) {
      try (var first = catalog(source, Clock.fixed(FETCHED, ZoneOffset.UTC))) {
        first.refresh();
      }
      byte[] originalCache = Files.readAllBytes(cache());
      var originalEstimate = estimate("gpt-7-future", "fast");
      ProviderCostEstimate.installRateCard(ProviderCostEstimate.fallbackRateCard());
      source.reply(CodexCreditRateCatalog.PRICING.getPath(), 503, "offline");
      int requestsBeforeRestart = source.requests.size();
      var clock = new MutableClock(FETCHED.plus(Duration.ofDays(2)));
      try (var restarted = catalog(source, clock)) {
        assertThat(source.requests).hasSize(requestsBeforeRestart);
        assertThat(estimate("gpt-7-future", "fast")).isEqualTo(originalEstimate);
        assertThatThrownBy(restarted::refresh).isInstanceOf(Exception.class);
        assertThat(Files.readAllBytes(cache())).isEqualTo(originalCache);
        assertThat(estimate("gpt-7-future", "fast"))
            .containsEntry("rateCardFetchedAt", FETCHED.toString())
            .isEqualTo(originalEstimate);
        source.reply(
            CodexCreditRateCatalog.PRICING.getPath(),
            200,
            PRICING.replace("</tbody>", FUTURE_ROW + "</tbody>"));
        clock.set(FETCHED.plus(Duration.ofDays(3)));
        assertThatThrownBy(restarted::refresh).isInstanceOf(IllegalArgumentException.class);
        assertThat(Files.readAllBytes(cache())).isEqualTo(originalCache);
        assertThat(estimate("gpt-7-future", "fast")).isEqualTo(originalEstimate);
      }
    }
  }

  @Test
  void realHttpRejectsOversizedStatusAndRedirectWithoutFollowingIt() throws Exception {
    try (var source = new Loopback()) {
      source.reply("/too-large", 200, "x".repeat(CodexCreditRateCatalog.MAX_BYTES + 1));
      source.reply("/unavailable", 503, "maintenance");
      source.reply("/partial", 206, "partial documentation");
      source.reply("/redirected", 200, "must not be requested");
      source.replies.put("/redirect", new Reply(302, "redirect", "/redirected"));
      for (String path : List.of("/too-large", "/unavailable", "/partial", "/redirect"))
        assertThatThrownBy(
                () -> CodexCreditRateCatalog.fetch(source.uri(path), Duration.ofSeconds(5)))
            .as(path)
            .isInstanceOf(Exception.class);
      assertThat(source.requests).extracting(Request::path).doesNotContain("/redirected");
    }
  }

  @Test
  void untrustedFutureStaleAndCorruptCachesLeaveBundledFallbackUntouched() throws Exception {
    try (var source = new Loopback()) {
      for (String kind : List.of("source", "future", "stale", "corrupt")) {
        var saved =
            new LinkedHashMap<String, Object>(
                Map.of(
                    "pricingSource", CodexCreditRateCatalog.PRICING.toString(),
                    "speedSource", CodexCreditRateCatalog.SPEED.toString(),
                    "fetchedAt", FETCHED.toString(),
                    "pricing", PRICING,
                    "speed", SPEED));
        switch (kind) {
          case "source" -> saved.put("pricingSource", "https://example.invalid/pricing");
          case "future" -> saved.put("fetchedAt", FETCHED.plusSeconds(301).toString());
          case "stale" -> saved.put("fetchedAt", "2026-10-22T23:59:59Z");
          case "corrupt" -> saved.put("pricing", PRICING.replace("75 credits", "unknown credits"));
          default -> throw new AssertionError(kind);
        }
        json.write(cache(), saved);
        try (var ignored = catalog(source, Clock.fixed(FETCHED, ZoneOffset.UTC))) {
          assertThat(estimate("gpt-7-future", "fast")).as(kind).containsEntry("amount", null);
          assertThat(estimate("gpt-6-sol", "fast"))
              .containsEntry("rateCardVersion", "bundled-2026-10-23")
              .containsEntry("rateCardFetchedAt", "");
          assertThat(source.requests).isEmpty();
        }
      }
    }
  }

  @Test
  @EnabledIfSystemProperty(named = "argus.rateOfficialSmoke", matches = "true")
  void officialPublicDocumentsParseThroughProductionFetchAndTemporaryCache() throws Exception {
    CodexCreditRateCatalog.Fetcher fetcher =
        official -> {
          assertThat(official).isIn(CodexCreditRateCatalog.PRICING, CodexCreditRateCatalog.SPEED);
          return CodexCreditRateCatalog.fetch(official, Duration.ofSeconds(10));
        };
    try (var catalog =
        new CodexCreditRateCatalog(cache(), json, fetcher, Clock.systemUTC(), false)) {
      catalog.refresh();
      var saved = json.read(cache(), Map.class);
      var card =
          CodexCreditRateCatalog.parse(
              (String) saved.get("pricing"),
              (String) saved.get("speed"),
              Instant.parse((String) saved.get("fetchedAt")));
      var rates = card.rates().get("gpt-6-sol");
      assertThat(rates).isNotNull();
      assertThat(rates.input()).isEqualTo("50");
      assertThat(rates.cached()).isEqualTo("5");
      assertThat(rates.output()).isEqualTo("250");
      assertThat(rates.fastMultiplier()).isEqualTo("2");
      assertThat(estimate("gpt-6-sol", "fast").get("amount")).isInstanceOf(String.class);
    }
  }

  @Test
  @EnabledIfSystemProperty(named = "argus.rateSimulationUrl", matches = ".+")
  void postmanSimulationUsesRealHttpAndRetainsValidatedCardOnFailedRefresh() throws Exception {
    String endpoint = System.getProperty("argus.rateSimulationUrl").replaceAll("/+$", "");
    URI base = URI.create(endpoint);
    assertThat(base.getScheme()).isIn("http", "https");
    assertThat(base.getUserInfo()).isNull();
    assertThat(base.getRawQuery()).isNull();
    assertThat(base.getRawFragment()).isNull();
    var scenario = new AtomicReference<>("success");
    var clock = new MutableClock(FETCHED);
    CodexCreditRateCatalog.Fetcher fetcher =
        official -> {
          assertThat(official).isIn(CodexCreditRateCatalog.PRICING, CodexCreditRateCatalog.SPEED);
          return CodexCreditRateCatalog.fetch(
              URI.create(endpoint + "/" + scenario.get() + official.getPath()),
              Duration.ofSeconds(10));
        };
    try (var catalog = new CodexCreditRateCatalog(cache(), json, fetcher, clock, false)) {
      catalog.refresh();
      var original = estimate("gpt-7-future", "standard");
      assertThat(original.get("amount")).isInstanceOf(String.class);
      assertThat(original)
          .containsEntry("actualCharge", false)
          .containsEntry("rateCardFetchedAt", FETCHED.toString());
      byte[] saved = Files.readAllBytes(cache());
      scenario.set("errors500");
      clock.set(FETCHED.plus(Duration.ofDays(1)));
      assertThatThrownBy(catalog::refresh).isInstanceOf(Exception.class);
      assertThat(Files.readAllBytes(cache())).isEqualTo(saved);
      assertThat(estimate("gpt-7-future", "standard")).isEqualTo(original);
    }
  }

  private record Reply(int status, String body, String redirect) {}

  private record Request(
      String path, String query, String method, String body, Map<String, List<String>> headers) {}

  private static final class Loopback implements AutoCloseable {
    final HttpServer server;
    final Map<String, Reply> replies = new ConcurrentHashMap<>();
    final List<Request> requests = new CopyOnWriteArrayList<>();

    Loopback() throws IOException {
      server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      reply(CodexCreditRateCatalog.PRICING.getPath(), 200, PRICING);
      reply(CodexCreditRateCatalog.SPEED.getPath(), 200, SPEED);
      server.createContext(
          "/",
          exchange -> {
            try {
              var headers = new LinkedHashMap<String, List<String>>();
              exchange
                  .getRequestHeaders()
                  .forEach(
                      (key, value) ->
                          headers.put(key.toLowerCase(Locale.ROOT), List.copyOf(value)));
              requests.add(
                  new Request(
                      exchange.getRequestURI().getPath(),
                      exchange.getRequestURI().getRawQuery(),
                      exchange.getRequestMethod(),
                      new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8),
                      headers));
              Reply response =
                  replies.getOrDefault(
                      exchange.getRequestURI().getPath(), new Reply(404, "not found", null));
              if (response.redirect() != null)
                exchange.getResponseHeaders().set("Location", response.redirect());
              exchange.getResponseHeaders().set("Content-Type", "text/markdown; charset=utf-8");
              byte[] bytes = response.body().getBytes(StandardCharsets.UTF_8);
              exchange.sendResponseHeaders(response.status(), bytes.length);
              exchange.getResponseBody().write(bytes);
            } catch (IOException ignored) {
              // The bounded production subscriber intentionally closes oversized responses early.
            } finally {
              exchange.close();
            }
          });
      server.start();
    }

    void reply(String path, int status, String body) {
      replies.put(path, new Reply(status, body, null));
    }

    URI uri(String path) {
      return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path);
    }

    CodexCreditRateCatalog.Fetcher fetcher() {
      return official -> {
        assertThat(official).isIn(CodexCreditRateCatalog.PRICING, CodexCreditRateCatalog.SPEED);
        // Only adapt the fixed official destination to this isolated server; use the actual
        // production HttpClient, response size limiter, status and redirect handling unchanged.
        return CodexCreditRateCatalog.fetch(uri(official.getPath()), Duration.ofSeconds(5));
      };
    }

    @Override
    public void close() {
      server.stop(0);
    }
  }

  private static final class MutableClock extends Clock {
    private final AtomicReference<Instant> now;

    MutableClock(Instant value) {
      now = new AtomicReference<>(value);
    }

    void set(Instant value) {
      now.set(value);
    }

    @Override
    public ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return Clock.fixed(instant(), zone);
    }

    @Override
    public Instant instant() {
      return now.get();
    }
  }
}
