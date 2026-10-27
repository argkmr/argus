package com.argus.agents.service;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.agents.dto.ProviderAvailability;
import com.argus.agents.repository.ProviderHealthRepository;
import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandRunner;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class CliProviderReadinessService {
  private final CommandRunner commands;
  private final ProviderHealthRepository health;

  public CliProviderReadinessService(CommandRunner commands, ProviderHealthRepository health) {
    this.commands = commands;
    this.health = health;
  }

  public ProviderAvailability probe(CliProviderAdapter adapter) {
    String checkedAt = Instant.now().toString();
    try {
      if (adapter.capabilityArguments() == null || adapter.capabilityArguments().isEmpty())
        return health.availability(adapter.id());
      var result =
          commands.run(
              adapter.executable(), adapter.capabilityArguments(), null, Duration.ofSeconds(30));
      String output = (result.stdout() + "\n" + result.stderr()).trim();
      String successPattern =
          adapter.capabilitySuccessPattern() == null
              ? ""
              : adapter.capabilitySuccessPattern().trim();
      if (successPattern.isBlank() || !Pattern.compile(successPattern).matcher(output).find()) {
        return record(adapter.id(), classifyOutput(output, adapter.name(), checkedAt));
      }
      ProviderAvailability available = ProviderAvailability.liveVerified(adapter.name(), checkedAt);
      health.record(adapter.id(), available);
      return available;
    } catch (RuntimeException error) {
      return record(adapter.id(), classify(error, adapter.name(), checkedAt));
    }
  }

  private ProviderAvailability record(String providerId, ProviderAvailability candidate) {
    ProviderAvailability selected =
        preferRecordedSuccess(health.availability(providerId), candidate);
    health.record(providerId, selected);
    return selected;
  }

  static ProviderAvailability preferRecordedSuccess(
      ProviderAvailability recorded, ProviderAvailability candidate) {
    boolean inconclusive = "unknown".equals(candidate.status());
    boolean recordedSuccess =
        recorded != null && "available".equals(recorded.status()) && recorded.canRun();
    return inconclusive && recordedSuccess ? recorded : candidate;
  }

  static ProviderAvailability classify(
      RuntimeException error, String displayName, String checkedAt) {
    String details = details(error);
    if (!(error instanceof CommandFailedException)
        && details.toLowerCase(Locale.ROOT).contains("timed out"))
      return new ProviderAvailability(
          "unknown",
          true,
          displayName + " live verification timed out; usage remains unverified",
          "",
          "capability-probe",
          checkedAt);
    if (error instanceof CommandFailedException failed)
      return availability(
          ProviderFailureClassifier.classify(failed.result().stdout(), failed.result().stderr()),
          displayName,
          checkedAt);
    return classifyOutput(details, displayName, checkedAt);
  }

  static ProviderAvailability classifyOutput(String details, String displayName, String checkedAt) {
    return availability(ProviderFailureClassifier.classify(details, ""), displayName, checkedAt);
  }

  private static ProviderAvailability availability(
      Map<String, Object> failure, String displayName, String checkedAt) {
    if (!failure.isEmpty()) {
      String status = failure.get("status").toString();
      String message =
          switch (status) {
            case "exhausted" ->
                "Subscription access is disabled".equals(failure.get("message"))
                    ? displayName
                        + " subscription access is disabled for this account or organization"
                    : displayName + " usage quota has been reached";
            case "rate-limited" -> displayName + " is temporarily rate limited";
            case "authentication-required" -> displayName + " needs sign-in";
            default -> displayName + " provider connection is unavailable";
          };
      String resetHint = failure.get("resetHint").toString();
      return new ProviderAvailability(
          status,
          false,
          message,
          resetHint.isEmpty() ? "" : "Try again after " + resetHint,
          "capability-probe",
          checkedAt);
    }
    return new ProviderAvailability(
        "unknown",
        true,
        displayName + " live capability check was inconclusive; usage remains unverified",
        "",
        "capability-probe",
        checkedAt);
  }

  private static String details(RuntimeException error) {
    if (error instanceof CommandFailedException failed)
      return (failed.result().stdout() + "\n" + failed.result().stderr()).trim();
    return error.getMessage() == null ? "Unknown provider error" : error.getMessage();
  }
}
