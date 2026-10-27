package com.argus.common.process;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ExecutableDiscoveryTest {
  @TempDir Path home;

  private Path executable(Path path) throws Exception {
    Files.createDirectories(path.getParent());
    Files.writeString(path, "#!/bin/sh\nexit 0\n");
    assertThat(path.toFile().setExecutable(true)).isTrue();
    return path;
  }

  private Path nvm(String version) throws Exception {
    return executable(home.resolve(".nvm/versions/node/" + version + "/bin/node")).getParent();
  }

  @Test
  void discoversSoleNvmAndVoltaInstallationsWithoutShellProfiles() throws Exception {
    Files.writeString(home.resolve(".zshrc"), "must not execute this");
    Path bin = nvm("v24.1.0");
    Path cli = executable(bin.resolve("argus-nvm-fixture"));
    assertThat(ExecutableDiscovery.resolve("argus-nvm-fixture", Map.of("PATH", "/usr/bin"), home))
        .isEqualTo(cli.toString());
    Path volta = executable(home.resolve(".volta/bin/argus-volta-fixture"));
    assertThat(ExecutableDiscovery.resolve("argus-volta-fixture", Map.of(), home))
        .isEqualTo(volta.toString());
  }

  @Test
  void retainsPathPriorityAndNumericallyOrdersOnlyCompleteNvmVersions() throws Exception {
    Path older = nvm("v22.9.0"), newer = nvm("v22.10.0"), newest = nvm("v24.1.0");
    nvm("v9999999.0.0");
    nvm("not-a-version");
    Path invalid = nvm("v99.1.0");
    assertThat(invalid.resolve("node").toFile().setExecutable(false)).isTrue();
    Path preferred = executable(home.resolve("preferred/argus-fixture"));
    executable(newest.resolve("argus-fixture"));
    var env = Map.of("PATH", preferred.getParent() + ":/usr/bin:" + preferred.getParent());
    assertThat(ExecutableDiscovery.resolve("argus-fixture", env, home))
        .isEqualTo(preferred.toString());
    var directories = ExecutableDiscovery.pathDirectories(env, home);
    assertThat(directories.get(0)).isEqualTo(preferred.getParent().toString());
    assertThat(directories.stream().filter(value -> value.contains(".nvm")))
        .containsExactly(newest.toString(), newer.toString(), older.toString());
  }

  @Test
  void honorsValidExplicitProvidersAndAbsoluteManagerRoots() throws Exception {
    Path override = executable(home.resolve("pinned/custom-claude"));
    assertThat(
            ExecutableDiscovery.providerExecutable(
                "claude", Map.of("ARGUS_CLAUDE_EXECUTABLE", override.toString()), home))
        .isEqualTo(override.toString());
    Path volta = executable(home.resolve("custom-volta/bin/argus-fixture"));
    assertThat(
            ExecutableDiscovery.resolve(
                "argus-fixture",
                Map.of("VOLTA_HOME", home.resolve("custom-volta").toString()),
                home))
        .isEqualTo(volta.toString());
    Path node = executable(home.resolve("custom-nvm/versions/node/v24.1.0/bin/node"));
    assertThat(
            ExecutableDiscovery.pathDirectories(
                Map.of("NVM_DIR", home.resolve("custom-nvm").toString()), home))
        .contains(node.getParent().toString());
    assertThat(
            ExecutableDiscovery.pathDirectories(
                Map.of("NVM_DIR", "relative", "VOLTA_HOME", "relative"), home))
        .contains(home.resolve(".volta/bin").toString())
        .noneMatch(value -> value.startsWith("relative"));
  }

  @Test
  void providerShebangUsesCompanionNodeInsteadOfUnrelatedPathVersion() throws Exception {
    Path bin = nvm("v24.1.0");
    Files.writeString(bin.resolve("node"), "#!/bin/sh\nprintf 'companion-node'\n");
    Path cli = executable(bin.resolve("codex"));
    Files.writeString(cli, "#!/usr/bin/env node\n");
    Path unrelated = executable(home.resolve("preferred/node"));
    Files.writeString(unrelated, "#!/bin/sh\nprintf 'wrong-node'\n");
    var builder = new ProcessBuilder(cli.toString(), "--version");
    builder.environment().put("PATH", unrelated.getParent() + ":/usr/bin:/bin");
    ExecutableDiscovery.prepareProvider(builder, home);
    assertThat(builder.command()).containsExactly(cli.toString(), "--version");
    assertThat(builder.environment().get("PATH")).startsWith(bin + ":");
    Process fixture = builder.start();
    assertThat(fixture.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
    assertThat(new String(fixture.getInputStream().readAllBytes())).isEqualTo("companion-node");
    assertThat(fixture.exitValue()).isZero();
  }

  @Test
  void rejectsMissingRelativeAndNonExecutableCandidatesWithoutChangingExplicitCommands()
      throws Exception {
    assertThat(ExecutableDiscovery.resolve("../tool", Map.of(), home)).isEmpty();
    assertThat(ExecutableDiscovery.resolve("bad\u0000path", Map.of(), home)).isEmpty();
    Path notExecutable = executable(home.resolve(".volta/bin/argus-fixture"));
    assertThat(notExecutable.toFile().setExecutable(false)).isTrue();
    assertThat(
            ExecutableDiscovery.resolve("argus-fixture", Map.of("PATH", ".:bad\u0000path"), home))
        .isEmpty();
    var builder = new ProcessBuilder(home.resolve("missing-pinned").toString());
    ExecutableDiscovery.prepareProvider(builder, home);
    assertThat(builder.command()).containsExactly(home.resolve("missing-pinned").toString());
  }

  @Test
  void boundsVersionDiscoveryAndRefusesOversizedTrees() throws Exception {
    for (int i = 0; i < 66; i++) nvm("v22." + i + ".0");
    assertThat(
            ExecutableDiscovery.pathDirectories(Map.of(), home).stream()
                .filter(value -> value.contains(".nvm")))
        .hasSize(64)
        .first()
        .asString()
        .contains("v22.65.0");
    for (int i = 0; i < 447; i++)
      Files.createFile(home.resolve(".nvm/versions/node/unrelated-" + i));
    assertThat(ExecutableDiscovery.pathDirectories(Map.of(), home))
        .noneMatch(value -> value.contains(".nvm"));
  }
}
