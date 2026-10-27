package com.argus.agents.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class CliProviderReadinessServiceTest {
  @Test
  void classifiesDisabledSubscriptionAsUnavailable() {
    RuntimeException error =
        new CommandFailedException(
            "disabled",
            new CommandResult(
                "",
                "Your organization has disabled Claude subscription access for Claude Code",
                1));

    var availability =
        CliProviderReadinessService.classify(error, "Claude Code", "2026-08-31T12:00:00Z");

    assertThat(availability.status()).isEqualTo("exhausted");
    assertThat(availability.canRun()).isFalse();
    assertThat(availability.message()).contains("subscription access is disabled");
  }

  @Test
  void preservesRateLimitReasonWithoutMarkingProviderReady() {
    RuntimeException error =
        new CommandFailedException(
            "rate limited",
            new CommandResult("", "Rate limit reached. Try again in 3 minutes.", 1));

    var availability = CliProviderReadinessService.classify(error, "Codex", "2026-08-31T12:00:00Z");

    assertThat(availability.status()).isEqualTo("rate-limited");
    assertThat(availability.canRun()).isFalse();
    assertThat(availability.resetHint()).containsIgnoringCase("try again");
  }

  @Test
  void detectsQuotaRejectionEvenWhenCliReturnsJsonWithExitZero() {
    var availability =
        CliProviderReadinessService.classifyOutput(
            "{\"result\":\"Your organization has disabled Claude subscription access for Claude Code\",\"is_error\":true}",
            "Claude Code",
            "2026-08-31T12:00:00Z");

    assertThat(availability.status()).isEqualTo("exhausted");
    assertThat(availability.canRun()).isFalse();
  }

  @Test
  void aTimedOutProbeStaysUnverifiedInsteadOfBecomingAFalseHardFailure() {
    var availability =
        CliProviderReadinessService.classify(
            new IllegalStateException("Command timed out: codex"), "Codex", "2026-08-31T12:00:00Z");

    assertThat(availability.status()).isEqualTo("unknown");
    assertThat(availability.canRun()).isTrue();
  }

  @Test
  void anInconclusiveProbeCannotEraseARecordedSuccessfulRun() {
    var recorded =
        new com.argus.agents.dto.ProviderAvailability(
            "available", true, "Last request succeeded", "", "last-run", "2026-08-31T12:00:00Z");
    var timeout =
        new com.argus.agents.dto.ProviderAvailability(
            "unknown",
            true,
            "Codex live verification timed out; usage remains unverified",
            "",
            "capability-probe",
            "2026-08-31T12:01:00Z");

    assertThat(CliProviderReadinessService.preferRecordedSuccess(recorded, timeout))
        .isEqualTo(recorded);
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "Quota remaining: 50",
        "Billing limit information is available in settings",
        "Authentication method: OAuth",
        "402 files scanned",
        "Rate limit information: 100 requests left",
        "{\"quota\":0,\"limit\":402}",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"aggregated_output\":\"out of tokens\"}}",
        "{\"type\":\"result\",\"is_error\":false,\"result\":\"The fixture reports quota exceeded\"}"
      })
  void mentionsAndToolResultsRemainUnverifiedRatherThanBlockingTheAccount(String details) {
    var availability = CliProviderReadinessService.classifyOutput(details, "Codex", "now");
    assertThat(availability.status()).isEqualTo("unknown");
    assertThat(availability.canRun()).isTrue();
    assertThat(availability.resetHint()).isEmpty();
  }

  @Test
  void actualStructuredAuthenticationAndNetworkFailuresStillClassify() {
    var authentication =
        CliProviderReadinessService.classifyOutput(
            "{\"type\":\"error\",\"error\":{\"message\":\"invalid api key\"}}",
            "Claude Code",
            "now");
    assertThat(authentication.status()).isEqualTo("authentication-required");
    assertThat(authentication.canRun()).isFalse();
    var network =
        CliProviderReadinessService.classifyOutput(
            "Error: connection refused", "Claude Code", "now");
    assertThat(network.status()).isEqualTo("unavailable");
    assertThat(network.canRun()).isFalse();
  }

  @Test
  void genuineStderrFailureIsNotLostBehindJsonStdoutOrQuotedToolTimeout() {
    var failure =
        new CommandFailedException(
            "failed",
            new CommandResult(
                "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"aggregated_output\":\"The application timed out; its subscription is disabled\"}}",
                "Error: insufficient_quota",
                1));
    var availability = CliProviderReadinessService.classify(failure, "Codex", "now");
    assertThat(availability.status()).isEqualTo("exhausted");
    assertThat(availability.message()).isEqualTo("Codex usage quota has been reached");
  }
}
