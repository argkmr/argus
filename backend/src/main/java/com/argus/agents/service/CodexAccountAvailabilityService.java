package com.argus.agents.service;

import com.argus.agents.dto.ProviderAvailability;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Read-only account metadata, never a model request or a persistent provider-wide quota latch. */
@Service
public class CodexAccountAvailabilityService {
  static final String SOURCE = "account-rate-limits";
  static final Duration CACHE_TTL = Duration.ofSeconds(15);
  private final Clock clock;
  private final Reader reader;
  private final Supplier<String> authenticationFingerprint;
  private final LinkedHashMap<String, Cached> cache = new LinkedHashMap<>();

  record Snapshot(JsonNode account, JsonNode limits) {}

  @FunctionalInterface
  interface Reader {
    Snapshot read(String executable) throws Exception;
  }

  private record Cached(ProviderAvailability value, Instant expiresAt) {}

  @Autowired
  public CodexAccountAvailabilityService(ObjectMapper json) {
    this(
        Clock.systemUTC(),
        protocolReader(json, System.getenv(), Duration.ofSeconds(6)),
        () -> authFingerprint(System.getenv()));
  }

  CodexAccountAvailabilityService(Clock clock, Reader reader) {
    this(clock, reader, () -> "fixture");
  }

  CodexAccountAvailabilityService(Clock clock, Reader reader, Supplier<String> fingerprint) {
    this.clock = clock;
    this.reader = reader;
    this.authenticationFingerprint = fingerprint;
  }

  static Reader protocolReader(
      ObjectMapper json, Map<String, String> environment, Duration timeout) {
    return executable -> {
      try (CliMetadataSession session =
          new CliMetadataSession(
              executable, List.of("app-server"), null, environment, json, timeout)) {
        session.initializeCodex("argus_account_status");
        JsonNode account = session.codex("account/read", Map.of("refreshToken", false));
        // An explicitly signed-out account has no rate-limit metadata to ask for.
        if (signedOut(account)) return new Snapshot(account, null);
        JsonNode limits = session.codex("account/rateLimits/read", Map.of());
        return new Snapshot(account, limits);
      }
    };
  }

  public synchronized ProviderAvailability availability(String executable, boolean refresh) {
    Instant now = clock.instant();
    String key = executable + "\n" + authenticationFingerprint.get();
    Cached previous = cache.get(key);
    if (!refresh && previous != null && now.isBefore(previous.expiresAt())) return previous.value();
    ProviderAvailability value;
    Instant expiresAt = now.plus(CACHE_TTL);
    try {
      Snapshot snapshot = reader.read(executable);
      value = evaluate(snapshot.account(), snapshot.limits(), now);
      Instant nextReset = nextReset(snapshot.limits(), now);
      if (nextReset != null && nextReset.isBefore(expiresAt)) expiresAt = nextReset;
    } catch (CancellationException error) {
      throw error;
    } catch (Exception ignored) {
      CliMetadataSession.checkCancellation();
      // Do not retain a prior account's status when this check fails; never expose raw RPC errors.
      value = unknown("Current Codex usage could not be checked; retry is allowed.", now);
    }
    if (!value.canRun())
      expiresAt = now; // A later login must not inherit a signed-out cache entry.
    cache.put(key, new Cached(value, expiresAt));
    while (cache.size() > 8) cache.remove(cache.keySet().iterator().next());
    return value;
  }

  static ProviderAvailability evaluate(JsonNode account, JsonNode limits, Instant now) {
    if (signedOut(account))
      return new ProviderAvailability(
          "authentication-required", false, "Codex needs sign-in", "", SOURCE, now.toString());
    if (account == null
        || !account.path("account").isObject()
        || account.path("account").path("type").asText("").isBlank())
      return unknown("Codex account metadata is unavailable; retry is allowed.", now);
    List<JsonNode> buckets = buckets(limits);
    boolean limited = limits != null && limits.path("spendControlReached").asBoolean(false);
    if (buckets.isEmpty() && !limited)
      return unknown("Codex did not report usage limits; retry is allowed.", now);
    boolean availableEvidence = false, incomplete = false;
    for (JsonNode bucket : buckets) {
      boolean bucketEvidence = false;
      JsonNode credits = bucket.path("credits");
      boolean creditsAvailable =
          credits.path("unlimited").asBoolean(false) || credits.path("hasCredits").asBoolean(false);
      if (creditsAvailable) availableEvidence = bucketEvidence = true;
      String reached = bucket.path("rateLimitReachedType").asText("").trim();
      if (!reached.isEmpty() || bucket.path("spendControlReached").asBoolean(false)) limited = true;
      for (String field : List.of("primary", "secondary")) {
        JsonNode window = bucket.path(field);
        if (window.isMissingNode() || window.isNull()) continue;
        if (!window.isObject() || !window.path("usedPercent").isNumber()) {
          incomplete = true;
          continue;
        }
        double used = window.path("usedPercent").asDouble();
        Instant reset = resetAt(window);
        if (!Double.isFinite(used) || used < 0 || reset == null || !reset.isAfter(now)) {
          incomplete = true;
          continue;
        }
        bucketEvidence = true;
        if (used >= 100) {
          // Available credits may permit paid use; metadata alone does not establish routing.
          limited = true;
        } else availableEvidence = true;
      }
      // Zero credits alone does not imply exhaustion while included windows have room.
      if (!bucketEvidence) incomplete = true;
    }
    if (limited)
      return new ProviderAvailability(
          "limited",
          true,
          "A Codex usage bucket reports a limit; other models or credits may still be available. Retry is allowed.",
          "",
          SOURCE,
          now.toString());
    if (availableEvidence && !incomplete)
      return new ProviderAvailability(
          "available",
          true,
          "Current Codex account reports usage available",
          "",
          SOURCE,
          now.toString());
    return unknown("Codex usage metadata is incomplete or expired; retry is allowed.", now);
  }

  private static ProviderAvailability unknown(String message, Instant now) {
    return new ProviderAvailability("unknown", true, message, "", SOURCE, now.toString());
  }

  private static boolean signedOut(JsonNode response) {
    return response != null
        && response.has("account")
        && response.path("account").isNull()
        && response.path("requiresOpenaiAuth").asBoolean(false);
  }

  private static List<JsonNode> buckets(JsonNode response) {
    if (response == null || !response.isObject()) return List.of();
    var result = new ArrayList<JsonNode>();
    JsonNode multiple = response.path("rateLimitsByLimitId");
    if (multiple.isObject() && !multiple.isEmpty()) {
      // Multi-bucket metadata supersedes the potentially stale legacy single-bucket projection.
      multiple.forEach(result::add);
    } else if (response.path("rateLimits").isObject()) result.add(response.path("rateLimits"));
    return result;
  }

  private static Instant nextReset(JsonNode response, Instant now) {
    Instant result = null;
    for (JsonNode bucket : buckets(response))
      for (String field : List.of("primary", "secondary")) {
        Instant reset = resetAt(bucket.path(field));
        if (reset != null && reset.isAfter(now) && (result == null || reset.isBefore(result)))
          result = reset;
      }
    return result;
  }

  private static Instant resetAt(JsonNode window) {
    JsonNode value = window.path("resetsAt");
    if (!value.isIntegralNumber() || !value.canConvertToLong()) return null;
    try {
      return Instant.ofEpochSecond(value.asLong());
    } catch (RuntimeException ignored) {
      return null;
    }
  }

  static String authFingerprint(Map<String, String> environment) {
    try {
      String configured = environment.getOrDefault("CODEX_HOME", "").trim();
      Path home =
          configured.isEmpty()
              ? Path.of(System.getProperty("user.home"), ".codex")
              : Path.of(configured);
      Path file = home.toAbsolutePath().normalize().resolve("auth.json");
      // File metadata only: never read, hash, log, persist, or expose credential contents.
      BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class);
      return file
          + ":"
          + attributes.fileKey()
          + ":"
          + attributes.size()
          + ":"
          + attributes.lastModifiedTime();
    } catch (Exception ignored) {
      return "auth-file-unavailable";
    }
  }
}
