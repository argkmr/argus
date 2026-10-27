package com.argus.git.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.argus.common.process.LocalCommandRunner;
import com.argus.git.dto.GitStatusResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class GitServiceTest {
  private Path repository;
  private GitService git;

  @BeforeEach
  void setUp() throws Exception {
    repository =
        Files.createDirectories(
            Path.of("target", "test-sandboxes", java.util.UUID.randomUUID().toString()));
    git = new GitService(new LocalCommandRunner());
    command("git", "init", "-q");
    command("git", "config", "user.email", "argus@test.local");
    command("git", "config", "user.name", "Argus Test");
    Files.writeString(repository.resolve("tracked.txt"), "before\n");
    command("git", "add", "tracked.txt");
    command("git", "commit", "-q", "-m", "initial");
  }

  @Test
  void reportsStagesAndReturnsEditableDiffContent() throws Exception {
    Files.writeString(repository.resolve("tracked.txt"), "after\n");
    Files.writeString(repository.resolve("new.txt"), "new\n");
    assertThat(git.status(repository).files())
        .extracting("file")
        .containsExactlyInAnyOrder("tracked.txt", "new.txt");
    var diff = git.diff(repository, "tracked.txt", false);
    assertThat(diff.beforeContent()).isEqualTo("before\n");
    assertThat(diff.afterContent()).isEqualTo("after\n");
    git.stage(repository, java.util.List.of("tracked.txt"));
    assertThat(
            git.status(repository).files().stream()
                .filter(item -> item.file().equals("tracked.txt"))
                .findFirst()
                .orElseThrow()
                .staged())
        .isTrue();
  }

  @Test
  void branchSnapshotPreservesDotsAndHandlesDetachedAndUnbornHeads() throws Exception {
    command("git", "checkout", "-qb", "feature/review.v2");
    assertThat(git.status(repository).branch()).isEqualTo("feature/review.v2");
    assertThat(git.status(repository).detached()).isFalse();
    command("git", "checkout", "--detach", "-q");
    assertThat(git.status(repository).branch()).isEqualTo("detached");
    assertThat(git.status(repository).detached()).isTrue();
    command("git", "checkout", "--orphan", "brand.new");
    assertThat(git.status(repository).branch()).isEqualTo("brand.new");
    assertThat(git.status(repository).detached()).isFalse();
    assertThat(GitService.statusBranch("## main...origin/main [ahead 2, behind 3]"))
        .isEqualTo("main");
    assertThat(GitService.statusBranch("## Initial commit on old.format")).isEqualTo("old.format");
  }

  @Test
  void detachedFlagComesFromPorcelainHeaderNotDisplayName() {
    for (var entry :
        Map.of(
                "", true,
                "##", true,
                "## HEAD (no branch)", true,
                "## detached", false,
                "## detached...origin/detached", false,
                "## No commits yet on detached", false,
                "## Initial commit on detached", false)
            .entrySet()) {
      var service =
          new GitService(
              (executable, args, root, timeout) ->
                  new com.argus.common.process.CommandResult(
                      args.contains("status") ? entry.getKey() + "\n" : "", "", 0));
      var status = service.status(repository);
      assertThat(status.branch()).as(entry.getKey()).isEqualTo("detached");
      assertThat(status.detached()).as(entry.getKey()).isEqualTo(entry.getValue());
    }
  }

  @Test
  void branchActuallyNamedDetachedIsNotDetachedHead() throws Exception {
    command("git", "checkout", "-qb", "detached");
    var status = git.status(repository);
    assertThat(status.branch()).isEqualTo("detached");
    assertThat(status.detached()).isFalse();
  }

  @Test
  void legacyStatusConstructorDoesNotInferDetachedFromBranchName() {
    var status = new GitStatusResponse("detached", "", 0, 0, List.of());
    assertThat(status.branch()).isEqualTo("detached");
    assertThat(status.detached()).isFalse();
  }

  @Test
  void statusNeedsOnlyStatusAndRemoteSubprocesses() {
    var commands = new java.util.ArrayList<java.util.List<String>>();
    var service =
        new GitService(
            (executable, args, root, timeout) -> {
              commands.add(args);
              return new com.argus.common.process.CommandResult(
                  args.contains("status")
                      ? "## feature/name...origin/feature/name [ahead 2]\n M file.txt\n"
                      : "ssh://example/repo.git\n",
                  "",
                  0);
            });
    var status = service.status(repository);
    assertThat(status.branch()).isEqualTo("feature/name");
    assertThat(status.ahead()).isEqualTo(2);
    assertThat(commands).hasSize(2);
    assertThat(commands).noneMatch(args -> args.contains("--show-current"));
  }

  private void command(String... command) throws Exception {
    Process process = new ProcessBuilder(command).directory(repository.toFile()).start();
    if (process.waitFor() != 0)
      throw new IllegalStateException(new String(process.getErrorStream().readAllBytes()));
  }
}
