package com.argus.agents.repository;

import com.argus.agents.dto.ProviderAvailability;
import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Repository
public class ProviderHealthRepository {
  private final ObjectMapper json;
  private final AtomicJsonStore store;
  private final Path path;
  private final Clock clock;

  @org.springframework.beans.factory.annotation.Autowired
  public ProviderHealthRepository(
      ObjectMapper json, AtomicJsonStore store, ArgusProperties properties) {
    this(json, store, properties, Clock.systemUTC());
  }

  ProviderHealthRepository(
      ObjectMapper json, AtomicJsonStore store, ArgusProperties properties, Clock clock) {
    this.json = json;
    this.store = store;
    this.path = properties.dataDirectory().resolve("provider-health.json");
    this.clock = clock;
  }

  public ProviderAvailability availability(String providerId) {
    if (!Files.exists(path)) return ProviderAvailability.unknown();
    try {
      JsonNode node = json.readTree(path.toFile()).path("providers").path(providerId);
      if (node.isMissingNode() || !node.isObject()) return ProviderAvailability.unknown();
      ProviderAvailability recorded =
          new ProviderAvailability(
              text(node, "status", "unknown"),
              node.path("canRun").isMissingNode() || node.path("canRun").asBoolean(),
              text(node, "message", "Availability was recorded by the CLI adapter"),
              text(node, "resetHint", ""),
              text(node, "source", "last-run"),
              node.path("checkedAt").isTextual() ? node.path("checkedAt").asText() : null);
      // A past request describes one account/model/run, not every future request. Persist the
      // observation for diagnostics, but never turn it into a permanent provider-wide lock.
      if (!recorded.canRun()
          || !"available".equals(recorded.status())
          || !fresh(recorded.checkedAt()))
        return new ProviderAvailability(
            "unknown",
            true,
            recorded.canRun()
                ? "Previous CLI availability is unverified or expired; retry is allowed."
                : "A previous CLI request failed; current availability is unverified and retry is allowed.",
            "",
            "last-run-unverified",
            recorded.checkedAt());
      return recorded;
    } catch (RuntimeException ignored) {
      return ProviderAvailability.unknown();
    }
  }

  private boolean fresh(String checkedAt) {
    try {
      Instant at = Instant.parse(checkedAt);
      Duration age = Duration.between(at, clock.instant());
      return !age.isNegative() && age.compareTo(Duration.ofMinutes(5)) < 0;
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  public synchronized void record(String providerId, ProviderAvailability availability) {
    Map<String, Object> root = new LinkedHashMap<>();
    Map<String, Object> providers = new LinkedHashMap<>();
    if (Files.exists(path)) {
      try {
        JsonNode existing = json.readTree(path.toFile());
        if (existing.isObject()) root.putAll(json.convertValue(existing, Map.class));
        JsonNode existingProviders = existing.path("providers");
        if (existingProviders.isObject())
          providers.putAll(json.convertValue(existingProviders, Map.class));
      } catch (RuntimeException ignored) {
      }
    }
    providers.put(providerId, availability);
    root.put("providers", providers);
    store.write(path, root);
  }

  private static String text(JsonNode node, String field, String fallback) {
    String value = node.path(field).asText("").trim();
    return value.isEmpty() ? fallback : value;
  }
}
