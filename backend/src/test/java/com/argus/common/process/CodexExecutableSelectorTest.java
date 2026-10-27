package com.argus.common.process;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class CodexExecutableSelectorTest {
  private Path executable(Path file) throws Exception {
    Files.createDirectories(file.getParent());
    Files.writeString(file, "#!/bin/sh\nexit 0\n");
    assertThat(file.toFile().setExecutable(true)).isTrue();
    return file;
  }

  private boolean executableFile(String file) {
    return Files.isRegularFile(Path.of(file)) && Files.isExecutable(Path.of(file));
  }

  @Test
  void discoversNewerNestedChatGptCliInsteadOfOlderUserInstallation(@TempDir Path home)
      throws Exception {
    Path apps = home.resolve("Applications");
    Path older = executable(home.resolve(".local/bin/codex"));
    Path legacy = executable(apps.resolve("Codex.app/Contents/Resources/codex"));
    Path nested =
        executable(
            apps.resolve(
                "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
    var versions =
        Map.of(
            older.toString(), "codex-cli 0.147.0",
            legacy.toString(), "codex-cli 0.153.0",
            nested.toString(), "codex-cli 0.160.0");
    var probed = new ArrayList<String>();
    assertThat(
            CodexExecutableSelector.select(
                Map.of("PATH", older.getParent().toString()),
                List.of(apps),
                versions::containsKey,
                candidate -> {
                  probed.add(candidate);
                  return versions.get(candidate);
                },
                home))
        .isEqualTo(nested.toString());
    assertThat(probed).containsExactly(older.toString(), legacy.toString(), nested.toString());
  }

  @Test
  void supportsBothNestedAppNamesUnderSuppliedRootsWithSpaces(@TempDir Path home) throws Exception {
    Path apps = home.resolve("Custom applications with spaces");
    for (String name : List.of("Codex.app", "ChatGPT.app")) {
      Path cli =
          executable(
              apps.resolve(name)
                  .resolve("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
      assertThat(
              CodexExecutableSelector.select(
                  Map.of("PATH", ""),
                  List.of(apps),
                  candidate -> candidate.equals(cli.toString()) && executableFile(candidate),
                  candidate -> "codex-cli 0.160.0",
                  home))
          .isEqualTo(cli.toString());
    }
    assertThat(
            CodexExecutableSelector.select(
                Map.of("PATH", ""),
                List.of(home.resolve("Different applications")),
                candidate -> candidate.startsWith(apps + "/") && executableFile(candidate),
                candidate -> "codex-cli 0.160.0",
                home))
        .isEqualTo("codex");
  }

  @Test
  void preservesPathAndLegacyDesktopPrecedenceOnVersionTies(@TempDir Path home) throws Exception {
    Path apps = home.resolve("Applications");
    Path pathCli = executable(home.resolve("preferred/codex"));
    Path legacy = executable(apps.resolve("ChatGPT.app/Contents/Resources/codex"));
    Path nested =
        executable(
            apps.resolve(
                "Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
    var candidates = List.of(pathCli.toString(), legacy.toString(), nested.toString());
    assertThat(
            CodexExecutableSelector.select(
                Map.of("PATH", pathCli.getParent().toString()),
                List.of(apps),
                candidates::contains,
                candidate -> "codex-cli 0.160.0",
                home))
        .isEqualTo(pathCli.toString());
    assertThat(
            CodexExecutableSelector.select(
                Map.of("PATH", ""),
                List.of(apps),
                candidates::contains,
                candidate -> "codex-cli 0.160.0",
                home))
        .isEqualTo(legacy.toString());
  }

  @Test
  void newerPathVersionStillBeatsNestedAppAndExplicitOverrideStillWins(@TempDir Path home)
      throws Exception {
    Path apps = home.resolve("Applications");
    Path preferred = executable(home.resolve("preferred/codex"));
    Path nested =
        executable(
            apps.resolve(
                "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
    var versions =
        Map.of(preferred.toString(), "codex-cli 0.161.0", nested.toString(), "codex-cli 0.160.0");
    assertThat(
            CodexExecutableSelector.select(
                Map.of("PATH", preferred.getParent().toString()),
                List.of(apps),
                versions::containsKey,
                versions::get,
                home))
        .isEqualTo(preferred.toString());
    assertThat(
            CodexExecutableSelector.select(
                Map.of(
                    "PATH", preferred.getParent().toString(),
                    "ARGUS_CODEX_EXECUTABLE", nested.toString()),
                List.of(apps),
                versions::containsKey,
                candidate -> {
                  throw new AssertionError("Explicit override must not probe another version");
                },
                home))
        .isEqualTo(nested.toString());
  }

  @Test
  void skipsMissingNonExecutableAndBrokenNestedCandidates(@TempDir Path home) throws Exception {
    Path apps = home.resolve("Applications");
    Path fallback = executable(home.resolve("preferred/codex"));
    Path nested =
        executable(
            apps.resolve(
                "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
    assertThat(nested.toFile().setExecutable(false)).isTrue();
    var probed = new ArrayList<String>();
    assertThat(
            CodexExecutableSelector.select(
                Map.of("PATH", fallback.getParent().toString()),
                List.of(apps),
                candidate ->
                    List.of(fallback.toString(), nested.toString()).contains(candidate)
                        && executableFile(candidate),
                candidate -> {
                  probed.add(candidate);
                  return "codex-cli 0.159.0";
                },
                home))
        .isEqualTo(fallback.toString());
    assertThat(probed).containsExactly(fallback.toString());
    assertThat(nested.toFile().setExecutable(true)).isTrue();
    for (boolean throwsFailure : List.of(false, true)) {
      assertThat(
              CodexExecutableSelector.select(
                  Map.of("PATH", fallback.getParent().toString()),
                  List.of(apps),
                  candidate -> List.of(fallback.toString(), nested.toString()).contains(candidate),
                  candidate -> {
                    if (candidate.equals(fallback.toString())) return "codex-cli 0.159.0";
                    if (throwsFailure) throw new IllegalStateException("Fixture probe failed");
                    return "not a CLI version";
                  },
                  home))
          .isEqualTo(fallback.toString());
    }
  }

  @Test
  void discoversCodexWhenOnlyNvmOrVoltaIsInstalled(@TempDir Path home) throws Exception {
    Path node = home.resolve(".nvm/versions/node/v24.1.0/bin/node");
    Files.createDirectories(node.getParent());
    Files.createFile(node);
    assertThat(node.toFile().setExecutable(true)).isTrue();
    for (Path cli : List.of(node.resolveSibling("codex"), home.resolve(".volta/bin/codex"))) {
      assertThat(
              CodexExecutableSelector.select(
                  Map.of("PATH", "/usr/bin"),
                  List.of(),
                  value -> value.equals(cli.toString()),
                  value -> "codex-cli 1.2.3",
                  home))
          .isEqualTo(cli.toString());
    }
    String bundled = "/Applications/Codex.app/Contents/Resources/codex";
    String nvm = node.resolveSibling("codex").toString();
    assertThat(
            CodexExecutableSelector.select(
                Map.of("PATH", "/usr/bin"),
                List.of(Path.of("/Applications")),
                value -> List.of(nvm, bundled).contains(value),
                value -> "codex-cli 1.2.3",
                home))
        .isEqualTo(bundled);
  }

  @Test
  void picksTheNewestInstalledRuntimeAcrossPathAndDesktopApps() {
    var versions =
        Map.of(
            "/old/codex",
            "codex-cli 0.152.0",
            "/bin/codex",
            "codex-cli 0.153.0-alpha.4",
            "/Applications/Codex.app/Contents/Resources/codex",
            "codex-cli 0.153.0-alpha.10");
    assertThat(
            CodexExecutableSelector.select(
                Map.of("PATH", "/old:/bin:/old"),
                List.of(Path.of("/Applications")),
                versions::containsKey,
                versions::get))
        .isEqualTo("/Applications/Codex.app/Contents/Resources/codex");
  }

  @Test
  void respectsValidExplicitOverridesAndFallsBackWithoutInventingAPath() {
    assertThat(
            CodexExecutableSelector.select(
                Map.of("ARGUS_CODEX_EXECUTABLE", "/pinned", "PATH", "/new"),
                List.of(),
                path -> true,
                path -> {
                  throw new AssertionError("Override does not run discovery");
                }))
        .isEqualTo("/pinned");
    assertThat(
            CodexExecutableSelector.select(
                Map.of("PATH", "/missing"), List.of(), path -> false, path -> ""))
        .isEqualTo("codex");
  }

  @Test
  void comparesStablePrereleaseAndNumericVersions() {
    assertThat(CodexExecutableSelector.compareVersions("0.153.0", "0.153.0-alpha.99")).isPositive();
    assertThat(CodexExecutableSelector.compareVersions("0.154.0-alpha.1", "0.153.9")).isPositive();
    assertThat(CodexExecutableSelector.compareVersions("0.153.0-alpha.10", "0.153.0-alpha.9"))
        .isPositive();
    assertThat(CodexExecutableSelector.compareVersions("0.153.0", "0.153.0")).isZero();
  }
}
