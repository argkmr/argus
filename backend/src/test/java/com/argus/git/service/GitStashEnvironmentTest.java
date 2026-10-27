package com.argus.git.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.process.LocalCommandRunner;
import com.argus.common.process.OwnedProcess;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.git.dto.GitStashPopRequest;
import com.argus.git.dto.GitStashRequest;
import com.argus.git.repository.GitRecoveryRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class GitStashEnvironmentTest {
  @TempDir Path temporary;

  @Test
  void inheritedGitOverridesCannotRedirectStashOrPopToAnotherRepository() throws Exception {
    Path selected = fixture("selected"), foreign = fixture("foreign");
    Files.writeString(selected.resolve("file.txt"), "selected INDEX\n");
    git(selected, "add", "--", "file.txt");
    Files.writeString(selected.resolve("file.txt"), "selected WORKING\n");
    Files.writeString(selected.resolve("untracked.txt"), "selected untracked\n");
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
                "GIT_DIR", foreign.resolve(".git").toString(),
                "GIT_COMMON_DIR", foreign.resolve(".git").toString(),
                "GIT_WORK_TREE", foreign.toString(),
                "GIT_INDEX_FILE", foreign.resolve(".git/index").toString(),
                "GIT_OBJECT_DIRECTORY", foreign.resolve(".git/objects").toString(),
                "GIT_CONFIG_COUNT", "1",
                "GIT_CONFIG_KEY_0", "core.worktree",
                "GIT_CONFIG_VALUE_0", foreign.toString(),
                "GIT_TRACE", trace.toString()));
    builder
        .environment()
        .putAll(
            Map.of(
                "GIT_LITERAL_PATHSPECS",
                "1",
                "GIT_GLOB_PATHSPECS",
                "1",
                "GIT_NOGLOB_PATHSPECS",
                "1",
                "GIT_ICASE_PATHSPECS",
                "1"));
    try (var child = new OwnedProcess(builder, null, 32768)) {
      child.closeInput();
      var result = child.await(Duration.ofSeconds(30));
      assertThat(result.exitCode()).describedAs(result.stderr() + result.stdout()).isZero();
      assertThat(result.stdout()).contains("STASH_FIXTURE_OK");
    }
    assertThat(Files.readString(selected.resolve("file.txt"))).isEqualTo("selected WORKING\n");
    assertThat(git(selected, "show", ":file.txt")).isEqualTo("selected INDEX\n");
    assertThat(Files.readString(selected.resolve("untracked.txt")))
        .isEqualTo("selected untracked\n");
    assertThat(Files.readString(foreign.resolve("file.txt"))).isEqualTo("foreign WORKING\n");
    assertThat(Files.readAllBytes(foreign.resolve(".git/index"))).isEqualTo(foreignIndex);
    assertThat(git(foreign, "stash", "list")).isEmpty();
    assertThat(git(selected, "stash", "list")).isEmpty();
    assertThat(Files.exists(trace)).isFalse();
  }

  public static class Probe {
    public static void main(String[] args) {
      Path root = Path.of(args[0]), data = Path.of(args[1]);
      var commands = new LocalCommandRunner();
      var reverts =
          new GitFileRevertService(
              commands,
              new GitRecoveryRepository(
                  new ArgusProperties(data, root, "fixture", ""),
                  new AtomicJsonStore(new ObjectMapper())));
      var service = new GitStashService(commands, reverts);
      var saved = service.create(root, new GitStashRequest("environment fixture", true));
      if (!saved.ok() || saved.stash() == null) throw new IllegalStateException("Stash failed");
      var popped =
          service.pop(root, new GitStashPopRequest(saved.stash().id(), saved.stash().ref()));
      if (!popped.ok() || !popped.dropped()) throw new IllegalStateException("Pop failed");
      System.out.println("STASH_FIXTURE_OK");
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

  private String git(Path root, String... arguments) {
    var args =
        new ArrayList<>(
            List.of(
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgSign=false",
                "-C",
                root.toString()));
    args.addAll(List.of(arguments));
    return new LocalCommandRunner().run("git", args, root, Duration.ofSeconds(15)).stdout();
  }
}
