package com.argus.agents.repository;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.agents.dto.ProviderAvailability;
import com.argus.agents.service.CliProviderAdapterService;
import com.argus.agents.service.CliProviderReadinessService;
import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class CliProviderAdapterRepositoryTest {
  @Test
  void selectedClaudeExecutableIsSharedByAllProviderOperations(@TempDir Path directory)
      throws Exception {
    Path cli = Files.createFile(directory.resolve("claude"));
    assertThat(cli.toFile().setExecutable(true)).isTrue();
    var repository =
        new CliProviderAdapterRepository(
            new ObjectMapper(), "codex", Map.of("PATH", directory.toString()), directory);
    assertThat(
            repository.list().stream()
                .filter(adapter -> adapter.id().equals("claude"))
                .findFirst()
                .orElseThrow()
                .executable())
        .isEqualTo(cli.toString());
  }

  @Test
  void exposesOnlyBundledAutomaticallyDetectedAdapters(@TempDir Path directory) {
    ObjectMapper mapper = new ObjectMapper();
    var repository = new CliProviderAdapterRepository(mapper);

    assertThat(repository.list())
        .extracting(CliProviderAdapter::id)
        .containsExactly("codex", "claude");
  }

  @Test
  void usesTheSelectedCodexRuntimeForVersionAndAuthentication(@TempDir Path directory)
      throws Exception {
    Path executable = Files.createFile(directory.resolve("desktop-codex"));
    assertThat(executable.toFile().setExecutable(true)).isTrue();
    var repository = new CliProviderAdapterRepository(new ObjectMapper(), executable.toString());
    var adapter =
        repository.list().stream()
            .filter(item -> item.id().equals("codex"))
            .findFirst()
            .orElseThrow();
    assertThat(adapter.executable()).isEqualTo(executable.toString());
    assertThat(
            repository.list().stream()
                .filter(item -> item.id().equals("claude"))
                .findFirst()
                .orElseThrow()
                .executable())
        .isEqualTo("claude");
    CommandRunner commands = mock(CommandRunner.class);
    ProviderHealthRepository health = mock(ProviderHealthRepository.class);
    when(commands.run(executable.toString(), List.of("--version"), null, Duration.ofSeconds(8)))
        .thenReturn(new CommandResult("codex-cli 0.153.0", "", 0));
    when(commands.run(
            executable.toString(), List.of("login", "status"), null, Duration.ofSeconds(8)))
        .thenReturn(new CommandResult("Logged in using ChatGPT", "", 0));
    when(health.availability("codex")).thenReturn(ProviderAvailability.unknown());
    var detection =
        new CliProviderAdapterService(
            repository, commands, health, mock(CliProviderReadinessService.class));

    var result = detection.detect(adapter, false);

    assertThat(result.installed()).isTrue();
    assertThat(result.authenticated()).isTrue();
    assertThat(result.executablePath()).isEqualTo(executable.toString());
    verify(commands).run(executable.toString(), List.of("--version"), null, Duration.ofSeconds(8));
    verify(commands)
        .run(executable.toString(), List.of("login", "status"), null, Duration.ofSeconds(8));
    verifyNoMoreInteractions(commands);
  }

  @Test
  void ignoresMissingRelativeAndNonExecutableOverrides(@TempDir Path directory) throws Exception {
    Path nonExecutable = Files.createFile(directory.resolve("not-executable"));
    assertThat(nonExecutable.toFile().setExecutable(false)).isTrue();
    for (String override :
        List.of(
            directory.resolve("missing").toString(),
            nonExecutable.toString(),
            directory.toString(),
            "codex",
            "bad\u0000path")) {
      var repository = new CliProviderAdapterRepository(new ObjectMapper(), override);
      assertThat(repository.list().get(0).executable()).as(override).isEqualTo("codex");
    }
  }
}
