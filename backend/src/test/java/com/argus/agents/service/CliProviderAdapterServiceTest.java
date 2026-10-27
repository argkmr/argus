package com.argus.agents.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import com.argus.agents.dto.ProviderAvailability;
import com.argus.agents.repository.CliProviderAdapterRepository;
import com.argus.agents.repository.ProviderHealthRepository;
import com.argus.common.process.CodexExecutableSelector;
import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class CliProviderAdapterServiceTest {
  @TempDir Path directory;

  @Test
  void metadataReplacesStickyCodexFailureWithoutRunningReadinessInference() throws Exception {
    var fixture = fixture();
    var available =
        new ProviderAvailability(
            "available",
            true,
            "Current metadata",
            "",
            "account-rate-limits",
            "2026-10-14T08:00:00Z");
    when(fixture.accounts().availability(fixture.executable(), true)).thenReturn(available);
    var result = fixture.service().detectMetadata(fixture.adapters().list().get(0), true);
    assertThat(result.installed()).isTrue();
    assertThat(result.authenticated()).isTrue();
    assertThat(result.canRun()).isTrue();
    assertThat(result.availability()).isEqualTo(available);
    verify(fixture.accounts()).availability(fixture.executable(), true);
    verifyNoInteractions(fixture.health(), fixture.readiness());
  }

  @Test
  void unknownMetadataKeepsAuthenticatedProviderRetryableAndDoesNotInventAvailable()
      throws Exception {
    var fixture = fixture();
    var unknown =
        new ProviderAvailability(
            "unknown",
            true,
            "Current metadata unavailable",
            "",
            "account-rate-limits",
            "2026-10-14T08:00:00Z");
    when(fixture.accounts().availability(fixture.executable(), false)).thenReturn(unknown);
    var result = fixture.service().detect(fixture.adapters().list().get(0), false);
    assertThat(result.installed()).isTrue();
    assertThat(result.authenticated()).isTrue();
    assertThat(result.canRun()).isTrue();
    assertThat(result.availability().status()).isEqualTo("unknown");
    verifyNoInteractions(fixture.health(), fixture.readiness());
  }

  @Test
  void signedOutCliDoesNotQueryAccountMetadataOrRunInference() throws Exception {
    var fixture = fixture();
    when(fixture
            .commands()
            .run(fixture.executable(), List.of("login", "status"), null, Duration.ofSeconds(8)))
        .thenReturn(new CommandResult("Not logged in", "", 1));
    var result = fixture.service().detectMetadata(fixture.adapters().list().get(0), true);
    assertThat(result.installed()).isTrue();
    assertThat(result.authenticated()).isFalse();
    assertThat(result.canRun()).isFalse();
    verifyNoInteractions(fixture.accounts(), fixture.health(), fixture.readiness());
  }

  private Fixture fixture() throws Exception {
    Path cli = Files.createFile(directory.resolve("codex"));
    assertThat(cli.toFile().setExecutable(true)).isTrue();
    var selector = mock(CodexExecutableSelector.class);
    when(selector.executable()).thenReturn(cli.toString());
    var adapters = new CliProviderAdapterRepository(new ObjectMapper(), selector);
    var commands = mock(CommandRunner.class);
    var health = mock(ProviderHealthRepository.class);
    var readiness = mock(CliProviderReadinessService.class);
    var accounts = mock(CodexAccountAvailabilityService.class);
    when(commands.run(cli.toString(), List.of("--version"), null, Duration.ofSeconds(8)))
        .thenReturn(new CommandResult("codex-cli fixture", "", 0));
    when(commands.run(cli.toString(), List.of("login", "status"), null, Duration.ofSeconds(8)))
        .thenReturn(new CommandResult("Logged in using ChatGPT", "", 0));
    return new Fixture(
        cli.toString(),
        adapters,
        commands,
        health,
        readiness,
        accounts,
        new CliProviderAdapterService(adapters, commands, health, readiness, accounts));
  }

  private record Fixture(
      String executable,
      CliProviderAdapterRepository adapters,
      CommandRunner commands,
      ProviderHealthRepository health,
      CliProviderReadinessService readiness,
      CodexAccountAvailabilityService accounts,
      CliProviderAdapterService service) {}
}
