package com.argus.agents.repository;

import static org.assertj.core.api.Assertions.assertThat;

import com.argus.agents.dto.ProviderAvailability;
import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class ProviderHealthRepositoryTest {
  private static final Instant NOW = Instant.parse("2026-10-14T08:00:00Z");

  @Test
  void legacyQuotaFlagIsAnObservationNotAnIndefiniteProviderLock(@TempDir Path directory)
      throws Exception {
    Files.writeString(
        directory.resolve("provider-health.json"),
        """
        {
          "version": 1,
          "providers": {
            "future-cli": {
              "status": "exhausted",
              "canRun": false,
              "message": "Usage quota reached",
              "resetHint": "2 hours",
              "source": "last-run",
              "checkedAt": "2026-08-31T12:00:00Z"
            }
          }
        }
        """);
    String original = Files.readString(directory.resolve("provider-health.json"));
    var availability = repository(directory).availability("future-cli");
    assertThat(availability.status()).isEqualTo("unknown");
    assertThat(availability.canRun()).isTrue();
    assertThat(availability.resetHint()).isEmpty();
    assertThat(availability.source()).isEqualTo("last-run-unverified");
    assertThat(availability.message()).contains("retry is allowed");
    assertThat(Files.readString(directory.resolve("provider-health.json"))).isEqualTo(original);
  }

  @Test
  void evenRecentFailuresDoNotBlockOtherAccountsOrModels(@TempDir Path directory) {
    var repository = repository(directory);
    for (String status : java.util.List.of("exhausted", "unavailable", "authentication-required")) {
      repository.record(
          "codex",
          new ProviderAvailability(
              status, false, "Past run failed", "tomorrow", "last-run", NOW.toString()));
      assertThat(repository.availability("codex").status()).isEqualTo("unknown");
      assertThat(repository.availability("codex").canRun()).isTrue();
    }
  }

  @Test
  void oldInvalidAndFutureSuccessRecordsExpireWithoutClaimingFreshAvailability(
      @TempDir Path directory) {
    var repository = repository(directory);
    for (String timestamp :
        java.util.Arrays.asList(
            null,
            "invalid",
            NOW.minusSeconds(300).toString(),
            NOW.minusSeconds(3600).toString(),
            NOW.plusSeconds(1).toString())) {
      repository.record(
          "claude",
          new ProviderAvailability("available", true, "Past success", "", "last-run", timestamp));
      assertThat(repository.availability("claude").status()).isEqualTo("unknown");
      assertThat(repository.availability("claude").canRun()).isTrue();
    }
  }

  @Test
  void recentSuccessRemainsARecentObservationAndMissingProviderRemainsUnknown(
      @TempDir Path directory) {
    var repository = repository(directory);
    var observation =
        new ProviderAvailability(
            "available", true, "Recent success", "", "last-run", NOW.minusSeconds(299).toString());
    repository.record("claude", observation);
    assertThat(repository.availability("claude")).isEqualTo(observation);
    assertThat(repository.availability("unknown").status()).isEqualTo("unknown");
    assertThat(repository.availability("unknown").canRun()).isTrue();
  }

  private ProviderHealthRepository repository(Path directory) {
    ArgusProperties properties = new ArgusProperties(directory, directory, "test", "token");
    ObjectMapper mapper = new ObjectMapper();
    return new ProviderHealthRepository(
        mapper, new AtomicJsonStore(mapper), properties, Clock.fixed(NOW, ZoneOffset.UTC));
  }
}
