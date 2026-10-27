package com.argus.git.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.process.LocalCommandRunner;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Disposable repositories only: no network, provider requests or user repository mutations. */
class GitRecentBranchesIntegrationTest {
  @TempDir Path temporary;
  private final LocalCommandRunner commands = new LocalCommandRunner();
  private final GitService service = new GitService(commands);
  private Path repository;

  @BeforeEach
  void setUp() throws Exception {
    repository = Files.createDirectory(temporary.resolve("repository"));
    run(repository, "init", "-q", "--initial-branch=main");
    run(repository, "config", "user.name", "Argus Fixture");
    run(repository, "config", "user.email", "fixture@argus.invalid");
    run(repository, "config", "commit.gpgsign", "false");
    run(repository, "config", "core.hooksPath", temporary.resolve("no-hooks").toString());
    run(repository, "config", "core.logAllRefUpdates", "true");
    run(repository, "commit", "--allow-empty", "-qm", "initial");
  }

  @Test
  void externalSwitchesAreNewestFirstDeduplicatedAndLimitedToFour() {
    for (String branch : List.of("one", "two", "three", "four", "five")) {
      run(repository, "switch", "-c", branch);
    }
    run(repository, "switch", "one");
    run(repository, "switch", "main");
    String before = run(repository, "rev-parse", "HEAD");

    assertThat(service.recentBranches(repository))
        .extracting("name")
        .containsExactly("one", "five", "four", "three");
    assertThat(run(repository, "rev-parse", "HEAD")).isEqualTo(before);
    assertThat(run(repository, "status", "--porcelain")).isEmpty();
  }

  @Test
  void firstSwitchOffersThePreviousBranchAndDeletedBranchesDisappear() {
    run(repository, "switch", "-c", "feature/first");
    assertThat(service.recentBranches(repository)).extracting("name").containsExactly("main");
    run(repository, "switch", "main");
    run(repository, "branch", "-d", "feature/first");
    assertThat(service.recentBranches(repository)).isEmpty();
  }

  @Test
  void detachedAndRemoteCheckoutsNeverBecomeShortcuts() {
    run(repository, "switch", "-c", "feature");
    run(repository, "switch", "main");
    run(repository, "update-ref", "refs/remotes/origin/remote-only", "HEAD");
    run(repository, "checkout", "--detach", "origin/remote-only");
    run(repository, "switch", "feature");
    assertThat(service.recentBranches(repository)).extracting("name").containsExactly("main");
    run(repository, "switch", "--detach");
    assertThat(service.recentBranches(repository))
        .extracting("name")
        .containsExactly("feature", "main");
  }

  @Test
  void symbolicAliasesAreNotOffered() {
    run(repository, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
    run(repository, "checkout", "alias");
    run(repository, "switch", "-c", "feature");
    assertThat(service.recentBranches(repository))
        .noneMatch(branch -> branch.name().equals("alias"));
  }

  @Test
  void unbornMissingAndDisabledReflogsAreEmpty() throws Exception {
    Path fresh = Files.createDirectory(temporary.resolve("fresh"));
    run(fresh, "init", "-q", "--initial-branch=main");
    assertThat(service.recentBranches(fresh)).isEmpty();

    run(repository, "branch", "unused");
    // Remove only the exact disposable fixture's HEAD reflog to simulate an older clone.
    Files.delete(repository.resolve(".git/logs/HEAD"));
    assertThat(service.recentBranches(repository)).isEmpty();
    run(repository, "config", "core.logAllRefUpdates", "false");
    run(repository, "switch", "unused");
    assertThat(service.recentBranches(repository)).isEmpty();
  }

  @Test
  void linkedWorktreeUsesItsOwnCheckoutHistory() throws Exception {
    run(repository, "switch", "-c", "primary-only");
    run(repository, "switch", "main");
    Path linked = temporary.resolve("linked");
    run(repository, "worktree", "add", "-b", "linked-first", linked.toString());
    run(linked, "switch", "-c", "linked-second");
    assertThat(service.recentBranches(linked)).extracting("name").containsExactly("linked-first");
    assertThat(service.recentBranches(repository))
        .extracting("name")
        .containsExactly("primary-only");
  }

  private String run(Path root, String... arguments) {
    var args = new ArrayList<>(List.of("-C", root.toString()));
    args.addAll(List.of(arguments));
    return commands.run("git", args, null, Duration.ofSeconds(15)).stdout().trim();
  }
}
