package com.argus.agents.dto;

public record ProviderAvailability(
    String status,
    boolean canRun,
    String message,
    String resetHint,
    String source,
    String checkedAt) {
  public static ProviderAvailability unknown() {
    return new ProviderAvailability(
        "unknown",
        true,
        "This CLI does not expose remaining quota before a run. Argus monitors every invocation.",
        "",
        "not-exposed",
        null);
  }

  public static ProviderAvailability authenticationRequired() {
    return new ProviderAvailability(
        "authentication-required",
        false,
        "Sign-in is required",
        "",
        "auth-command",
        java.time.Instant.now().toString());
  }

  public static ProviderAvailability verified(String checkedAt) {
    return new ProviderAvailability(
        "available", true, "Connection verified", "", "connection-test", checkedAt);
  }

  public static ProviderAvailability liveVerified(String provider, String checkedAt) {
    return new ProviderAvailability(
        "available",
        true,
        provider + " completed a minimal live capability check",
        "",
        "capability-probe",
        checkedAt);
  }
}
