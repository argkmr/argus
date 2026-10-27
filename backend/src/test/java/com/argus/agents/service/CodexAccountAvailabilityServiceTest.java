package com.argus.agents.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.agents.dto.ProviderAvailability;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class CodexAccountAvailabilityServiceTest {
  private final ObjectMapper json = new ObjectMapper();
  private static final Instant NOW = Instant.parse("2026-10-14T08:00:00Z");
  @TempDir Path directory;

  @Test
  void unlimitedCreditsWithoutQuotaWindowsAreAvailableAndNotInventedZeroUsage() {
    var value =
        evaluate(
            """
        {"rateLimits":{"primary":null,"secondary":null,
        "credits":{"hasCredits":true,"unlimited":true,"balance":null},"rateLimitReachedType":null}}
        """);
    assertThat(value.status()).isEqualTo("available");
    assertThat(value.canRun()).isTrue();
    assertThat(value.source()).isEqualTo("account-rate-limits");
    assertThat(value.message()).doesNotContain("100%", "0%", "unlimited", "verified");
  }

  @Test
  void absentNullOrMalformedMetadataAllowsRetryWithoutInventingAvailability() {
    for (String limits :
        List.of(
            "null",
            "{}",
            "{\"rateLimits\":null}",
            "{\"rateLimits\":{\"primary\":null,\"secondary\":null,\"credits\":null}}",
            "{\"rateLimits\":{\"credits\":{\"hasCredits\":false,\"unlimited\":false,\"balance\":\"0\"}}}")) {
      var value = evaluate(limits);
      assertThat(value.status()).as(limits).isEqualTo("unknown");
      assertThat(value.canRun()).as(limits).isTrue();
    }
  }

  @Test
  void healthyIncludedWindowDoesNotRequirePaidCredits() {
    var value = evaluate(limits(25, NOW.plusSeconds(3600), "\"credits\":{\"hasCredits\":false},"));
    assertThat(value.status()).isEqualTo("available");
    assertThat(value.canRun()).isTrue();
  }

  @Test
  void exhaustedWindowIsBucketWarningNotGlobalModelLock() {
    var value = evaluate(limits(100, NOW.plusSeconds(3600), ""));
    assertThat(value.status()).isEqualTo("limited");
    assertThat(value.canRun()).isTrue();
    assertThat(value.message()).contains("other models", "Retry");
  }

  @Test
  void multiBucketMetadataOverridesLegacyViewAndDoesNotConflateBuckets() {
    var value =
        evaluate(
            """
        {"rateLimits":{"rateLimitReachedType":"quota"},"rateLimitsByLimitId":{
        "model-specific":{"primary":{"usedPercent":100,"resetsAt":%d}},
        "codex":{"primary":{"usedPercent":1,"resetsAt":%d}}}}
        """
                .formatted(
                    NOW.plusSeconds(60).getEpochSecond(), NOW.plusSeconds(60).getEpochSecond()));
    assertThat(value.status()).isEqualTo("limited");
    assertThat(value.canRun()).isTrue();
    var fresh =
        evaluate(
            """
        {"rateLimits":{"rateLimitReachedType":"quota"},"rateLimitsByLimitId":{
        "codex":{"credits":{"hasCredits":true,"unlimited":true}}}}
        """);
    assertThat(fresh.status()).isEqualTo("available");
  }

  @Test
  void explicitReachedTypeCannotBeOverriddenByUnlimitedCreditFlag() {
    var value =
        evaluate(
            """
        {"rateLimits":{"credits":{"hasCredits":true,"unlimited":true},
        "rateLimitReachedType":"workspace_spending_limit"}}
        """);
    assertThat(value.status()).isEqualTo("limited");
    assertThat(value.canRun()).isTrue();
  }

  @Test
  void explicitSpendControlWarningCannotBeOverriddenByCredits() {
    for (String metadata :
        List.of(
            "{\"spendControlReached\":true}",
            "{\"spendControlReached\":true,\"rateLimits\":{\"credits\":{\"unlimited\":true}}}",
            "{\"rateLimits\":{\"spendControlReached\":true,\"credits\":{\"unlimited\":true}}}")) {
      var value = evaluate(metadata);
      assertThat(value.status()).isEqualTo("limited");
      assertThat(value.canRun()).isTrue();
    }
    assertThat(
            evaluate(
                    "{\"rateLimits\":{\"spendControlReached\":false,\"credits\":{\"unlimited\":true}}}")
                .status())
        .isEqualTo("available");
  }

  @Test
  void expiredMissingOrInvalidResetDoesNotKeepExhaustedFlagOrClaimFreshAvailability() {
    for (String resets :
        List.of(
            "null",
            "0",
            "-1",
            "1.25",
            "\"tomorrow\"",
            Long.toString(NOW.getEpochSecond()),
            "9223372036854775807")) {
      for (int used : List.of(1, 100)) {
        var value =
            evaluate(
                "{\"rateLimits\":{\"primary\":{\"usedPercent\":"
                    + used
                    + ",\"resetsAt\":"
                    + resets
                    + "}}}");
        assertThat(value.status()).as(resets).isEqualTo("unknown");
        assertThat(value.canRun()).isTrue();
      }
    }
  }

  @Test
  void invalidUsageOrAccountMetadataDoesNotClaimSuccess() {
    for (String used : List.of("null", "-2", "\"100\"")) {
      var value =
          evaluate(
              "{\"rateLimits\":{\"primary\":{\"usedPercent\":"
                  + used
                  + ",\"resetsAt\":"
                  + NOW.plusSeconds(60).getEpochSecond()
                  + "}}}");
      assertThat(value.status()).isEqualTo("unknown");
      assertThat(value.canRun()).isTrue();
    }
    for (String account :
        List.of(
            "null", "{}", "{\"account\":{}}", "{\"account\":null,\"requiresOpenaiAuth\":false}"))
      assertThat(
              CodexAccountAvailabilityService.evaluate(
                      json.readTree(account),
                      json.readTree(limits(1, NOW.plusSeconds(60), "")),
                      NOW)
                  .status())
          .isEqualTo("unknown");
  }

  @Test
  void explicitSignedOutAccountIsTheOnlyMetadataAuthenticationBlock() {
    var value =
        CodexAccountAvailabilityService.evaluate(
            json.readTree("{\"account\":null,\"requiresOpenaiAuth\":true}"), null, NOW);
    assertThat(value.status()).isEqualTo("authentication-required");
    assertThat(value.canRun()).isFalse();
  }

  @Test
  void cachesBrieflyRefreshBypassesAndResetTimeExpiresCachedResult() {
    var clock = new MutableClock();
    AtomicInteger reads = new AtomicInteger();
    var service =
        new CodexAccountAvailabilityService(
            clock,
            executable -> {
              reads.incrementAndGet();
              return snapshot(limits(100, NOW.plusSeconds(5), ""));
            });
    assertThat(service.availability("fixture", false).status()).isEqualTo("limited");
    service.availability("fixture", false);
    assertThat(reads).hasValue(1);
    service.availability("fixture", true);
    assertThat(reads).hasValue(2);
    clock.advance(Duration.ofSeconds(6));
    assertThat(service.availability("fixture", false).status()).isEqualTo("unknown");
    assertThat(reads).hasValue(3);
    clock.advance(Duration.ofSeconds(16));
    service.availability("fixture", false);
    assertThat(reads).hasValue(4);
  }

  @Test
  void changedAccountFingerprintInvalidatesLimitsAndFailedRefreshNeverRetainsOldAccount() {
    var clock = new MutableClock();
    AtomicReference<String> account = new AtomicReference<>("account-a");
    AtomicInteger reads = new AtomicInteger();
    var service =
        new CodexAccountAvailabilityService(
            clock,
            executable -> {
              reads.incrementAndGet();
              if (account.get().equals("offline"))
                throw new IllegalStateException("private token=not-for-output");
              return snapshot(
                  limits(account.get().equals("account-a") ? 100 : 1, NOW.plusSeconds(60), ""));
            },
            account::get);
    assertThat(service.availability("fixture", false).status()).isEqualTo("limited");
    account.set("account-b");
    assertThat(service.availability("fixture", false).status()).isEqualTo("available");
    account.set("offline");
    var failure = service.availability("fixture", false);
    assertThat(failure.status()).isEqualTo("unknown");
    assertThat(failure.canRun()).isTrue();
    assertThat(json.writeValueAsString(failure))
        .doesNotContain("private", "token", "account-a", "account-b");
    assertThat(reads).hasValue(3);
  }

  @Test
  void authenticationFailureIsNotCachedAcrossLogin() {
    AtomicInteger calls = new AtomicInteger();
    var service =
        new CodexAccountAvailabilityService(
            new MutableClock(),
            executable ->
                calls.incrementAndGet() == 1
                    ? new CodexAccountAvailabilityService.Snapshot(
                        json.readTree("{\"account\":null,\"requiresOpenaiAuth\":true}"), null)
                    : snapshot(limits(1, NOW.plusSeconds(60), "")));
    assertThat(service.availability("fixture", false).canRun()).isFalse();
    assertThat(service.availability("fixture", false).status()).isEqualTo("available");
  }

  @Test
  void fingerprintUsesOnlyAuthFileMetadataAndTracksReplacementAndRemoval() throws Exception {
    Map<String, String> environment = Map.of("CODEX_HOME", directory.toString());
    String absent = CodexAccountAvailabilityService.authFingerprint(environment);
    Files.writeString(directory.resolve("auth.json"), "synthetic-secret-one");
    String before = CodexAccountAvailabilityService.authFingerprint(environment);
    Files.writeString(directory.resolve("auth.json"), "synthetic-secret-two-longer");
    String after = CodexAccountAvailabilityService.authFingerprint(environment);
    assertThat(before).isNotEqualTo(absent).isNotEqualTo(after).doesNotContain("synthetic-secret");
    Files.delete(directory.resolve("auth.json"));
    assertThat(CodexAccountAvailabilityService.authFingerprint(environment)).isEqualTo(absent);
  }

  @Test
  void protocolReadsOnlyAccountAndLimitsWithoutTokenRefreshOrInference() throws Exception {
    var fixture = fixture("ready");
    var reader =
        CodexAccountAvailabilityService.protocolReader(json, Map.of(), Duration.ofSeconds(3));
    var service = new CodexAccountAvailabilityService(new MutableClock(), reader);
    assertThat(service.availability(fixture.toString(), true).status()).isEqualTo("available");
    List<JsonNode> requests =
        Files.readAllLines(directory.resolve("protocol.log")).stream()
            .filter(line -> line.startsWith("{"))
            .map(json::readTree)
            .toList();
    assertThat(requests)
        .extracting(node -> node.path("method").asText())
        .containsExactly("initialize", "initialized", "account/read", "account/rateLimits/read");
    assertThat(requests.get(2).path("params").path("refreshToken").asBoolean()).isFalse();
    assertThat(requests.get(2).path("params").size()).isEqualTo(1);
  }

  @Test
  void rpcFailureAndTimeoutAreUnknownRetryAllowedAndOwnedFixtureIsReaped() throws Exception {
    for (String scenario : List.of("reject", "hang")) {
      var fixture = fixture(scenario);
      var reader =
          CodexAccountAvailabilityService.protocolReader(json, Map.of(), Duration.ofMillis(1200));
      var service = new CodexAccountAvailabilityService(new MutableClock(), reader);
      long started = System.nanoTime();
      var value = service.availability(fixture.toString(), true);
      assertThat(value.status()).isEqualTo("unknown");
      assertThat(value.canRun()).isTrue();
      assertThat(value.message()).doesNotContain("synthetic-secret");
      assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(4));
      long pid =
          Long.parseLong(
              Files.readAllLines(directory.resolve("protocol.log")).stream()
                  .filter(line -> line.startsWith("PID "))
                  .reduce((a, b) -> b)
                  .orElseThrow()
                  .substring(4));
      assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    }
  }

  @Test
  void protocolAllowlistRejectsTokenRefreshLogoutPurchasesAndTurnsBeforeWriting() throws Exception {
    try (var session =
        new CliMetadataSession(
            "/bin/cat", List.of(), directory, Map.of(), json, Duration.ofSeconds(1))) {
      for (String method :
          List.of("turn/start", "account/logout", "account/rateLimitResetCredit/consume"))
        assertThatThrownBy(() -> session.codex(method, Map.of()))
            .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> session.codex("account/read", Map.of("refreshToken", true)))
          .isInstanceOf(IllegalArgumentException.class);
    }
  }

  private ProviderAvailability evaluate(String limits) {
    var snapshot = snapshot(limits);
    return CodexAccountAvailabilityService.evaluate(snapshot.account(), snapshot.limits(), NOW);
  }

  private CodexAccountAvailabilityService.Snapshot snapshot(String limits) {
    return new CodexAccountAvailabilityService.Snapshot(
        json.readTree(
            "{\"account\":{\"type\":\"chatgpt\",\"email\":\"synthetic-private@example.test\"},\"requiresOpenaiAuth\":true}"),
        json.readTree(limits));
  }

  private String limits(int used, Instant reset, String extra) {
    return "{\"rateLimits\":{"
        + extra
        + "\"primary\":{\"usedPercent\":"
        + used
        + ",\"resetsAt\":"
        + reset.getEpochSecond()
        + "}}}";
  }

  private Path fixture(String scenario) throws Exception {
    Path executable = directory.resolve("fake-account-cli-" + scenario);
    String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
    Files.writeString(
        executable,
        "#!/bin/sh\nexec "
            + quote(java)
            + " -cp "
            + quote(System.getProperty("java.class.path"))
            + " "
            + CodexAccountMetadataFixture.class.getName()
            + " "
            + quote(scenario)
            + " "
            + quote(directory.resolve("protocol.log").toString())
            + " \"$@\"\n");
    assertThat(executable.toFile().setExecutable(true)).isTrue();
    return executable;
  }

  private String quote(String value) {
    return "'" + value.replace("'", "'\\''") + "'";
  }

  private static final class MutableClock extends Clock {
    private Instant now = NOW;

    void advance(Duration elapsed) {
      now = now.plus(elapsed);
    }

    @Override
    public ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      return now;
    }
  }
}
