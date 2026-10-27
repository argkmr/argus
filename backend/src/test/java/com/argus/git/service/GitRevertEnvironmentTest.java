package com.argus.git.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.process.*;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.git.dto.GitRevertRequest;
import com.argus.git.repository.GitRecoveryRepository;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class GitRevertEnvironmentTest {
  @TempDir Path temporary;

  @Test
  void repositoryOverridesAreRemovedButAuthenticationAndFixtureIsolationRemain() {
    var environment = new HashMap<String, String>();
    for (String name :
        List.of(
            "GIT_DIR",
            "GIT_COMMON_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG",
            "GIT_NAMESPACE",
            "GIT_PREFIX",
            "GIT_CEILING_DIRECTORIES",
            "GIT_TRACE",
            "GIT_TRACE2_EVENT")) environment.put(name, "hostile");
    for (String name :
        List.of(
            "GIT_SSH_COMMAND",
            "GIT_AUTHOR_NAME",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_ALLOW_PROTOCOL",
            "PATH")) environment.put(name, "preserved");
    GitEnvironment.sanitize(environment);
    assertThat(environment).doesNotContainValue("hostile");
    assertThat(environment).containsEntry("GIT_TERMINAL_PROMPT", "0");
    for (String name :
        List.of(
            "GIT_SSH_COMMAND",
            "GIT_AUTHOR_NAME",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_ALLOW_PROTOCOL",
            "PATH")) assertThat(environment).containsEntry(name, "preserved");
  }

  @Test
  void hostileInheritedGitEnvironmentCannotRedirectEitherRevertTarget() throws Exception {
    Path selected = fixture("selected"), foreign = fixture("foreign");
    Files.writeString(selected.resolve("file.txt"), "selected INDEX\n");
    git(selected, "add", "--", "file.txt");
    Files.writeString(selected.resolve("file.txt"), "selected WORKING\n");
    Files.writeString(foreign.resolve("file.txt"), "foreign INDEX\n");
    git(foreign, "add", "--", "file.txt");
    Files.writeString(foreign.resolve("file.txt"), "foreign WORKING\n");
    byte[] foreignIndex = Files.readAllBytes(foreign.resolve(".git/index"));
    Path trace = temporary.resolve("must-not-be-created.trace");
    var builder =
        new ProcessBuilder(
            Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-Djava.io.tmpdir=" + temporary,
            "-cp",
            System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
            Probe.class.getName(),
            selected.toString(),
            temporary.resolve("data").toString());
    builder
        .environment()
        .putAll(
            Map.of(
                "GIT_DIR",
                foreign.resolve(".git").toString(),
                "GIT_COMMON_DIR",
                foreign.resolve(".git").toString(),
                "GIT_WORK_TREE",
                foreign.toString(),
                "GIT_INDEX_FILE",
                foreign.resolve(".git/index").toString(),
                "GIT_OBJECT_DIRECTORY",
                foreign.resolve(".git/objects").toString(),
                "GIT_CONFIG_COUNT",
                "1",
                "GIT_CONFIG_KEY_0",
                "core.worktree",
                "GIT_CONFIG_VALUE_0",
                foreign.toString(),
                "GIT_TRACE",
                trace.toString()));
    try (var child = new OwnedProcess(builder, null, 32768)) {
      child.closeInput();
      var result = child.await(Duration.ofSeconds(30));
      assertThat(result.exitCode()).describedAs(result.stderr() + result.stdout()).isZero();
      assertThat(result.stdout()).contains("REVERT_FIXTURE_OK");
    }
    assertThat(Files.readString(selected.resolve("file.txt"))).isEqualTo("selected INDEX\n");
    assertThat(git(selected, "show", ":file.txt")).isEqualTo("selected HEAD\n");
    assertThat(Files.readString(foreign.resolve("file.txt"))).isEqualTo("foreign WORKING\n");
    assertThat(Files.readAllBytes(foreign.resolve(".git/index"))).isEqualTo(foreignIndex);
    assertThat(Files.exists(trace)).isFalse();
  }

  public static class Probe {
    public static void main(String[] args) {
      Path root = Path.of(args[0]), data = Path.of(args[1]);
      var service =
          new GitFileRevertService(
              new LocalCommandRunner(),
              new GitRecoveryRepository(
                  new ArgusProperties(data, root, "fixture", ""),
                  new AtomicJsonStore(new ObjectMapper())));
      for (boolean staged : List.of(false, true)) {
        var diff = service.diff(root, "file.txt", staged);
        var result =
            service.revert(
                root,
                "selected",
                new GitRevertRequest("file.txt", staged, diff.revert().revision()));
        if (!result.ok()) throw new IllegalStateException("Revert did not complete");
      }
      System.out.println("REVERT_FIXTURE_OK");
    }
  }

  private Path fixture(String name) throws Exception {
    Path root = Files.createDirectory(temporary.resolve(name));
    git(root, "init", "-q", "--initial-branch=main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    Files.writeString(root.resolve("file.txt"), name + " HEAD\n");
    git(root, "add", "--", "file.txt");
    git(root, "commit", "-qm", "fixture");
    return root;
  }

  private String git(Path root, String... args) {
    var command =
        new ArrayList<>(
            List.of(
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgSign=false",
                "-C",
                root.toString()));
    command.addAll(List.of(args));
    return new LocalCommandRunner().run("git", command, null, Duration.ofSeconds(15)).stdout();
  }
}
