package com.argus.git.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.argus.common.process.LocalCommandRunner;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Real Git tracking behavior against disposable local remotes; no network or user repositories. */
class GitTrackingStateTest {
  @TempDir Path temporary;
  private final LocalCommandRunner commands = new LocalCommandRunner();
  private final GitService service = new GitService(commands);
  private Path producer;
  private Path checkout;

  @BeforeEach
  void createLocalTrackingFixture() throws Exception {
    producer = temporary.resolve("producer");
    checkout = temporary.resolve("checkout");
    Path remote = temporary.resolve("team.git");
    run(temporary, "init", "--bare", remote.toString());
    run(temporary, "init", "-b", "integration", producer.toString());
    run(producer, "config", "user.name", "Argus Fixture");
    run(producer, "config", "user.email", "fixture@argus.invalid");
    run(producer, "config", "commit.gpgsign", "false");
    commit("initial");
    run(producer, "remote", "add", "team", remote.toString());
    run(producer, "push", "--set-upstream", "team", "integration");
    run(
        temporary,
        "clone",
        "--origin",
        "team",
        "--branch",
        "integration",
        remote.toString(),
        checkout.toString());
    run(checkout, "branch", "-m", "work");
  }

  @Test
  void fetchUpdatesConfiguredUpstreamCountsWithoutMovingTheCheckedOutBranch() throws Exception {
    String originalHead = run(checkout, "rev-parse", "HEAD");
    advanceRemoteTwice();

    // A status read uses local tracking refs and never fetches implicitly.
    assertThat(service.status(checkout).behind()).isZero();
    assertThat(run(checkout, "rev-parse", "HEAD")).isEqualTo(originalHead);
    service.fetch(checkout);

    var fetched = service.status(checkout);
    assertThat(fetched.branch()).isEqualTo("work");
    assertThat(fetched.ahead()).isZero();
    assertThat(fetched.behind()).isEqualTo(2);
    assertThat(run(checkout, "rev-parse", "HEAD")).isEqualTo(originalHead);
    assertThat(service.branches(checkout))
        .anySatisfy(
            branch -> {
              assertThat(branch.current()).isTrue();
              assertThat(branch.name()).isEqualTo("work");
              assertThat(branch.upstream()).isEqualTo("team/integration");
            });
  }

  @Test
  void fastForwardPullUpdatesHeadAndRefreshesCountsWhileKeepingUnrelatedLocalFiles()
      throws Exception {
    advanceRemoteTwice();
    service.fetch(checkout);
    assertThat(service.status(checkout).behind()).isEqualTo(2);
    Path local = checkout.resolve("unsaved-local.txt");
    Files.writeString(local, "keep this local file\n");

    service.pull(checkout);

    var pulled = service.status(checkout);
    assertThat(pulled.ahead()).isZero();
    assertThat(pulled.behind()).isZero();
    assertThat(run(checkout, "rev-parse", "HEAD"))
        .isEqualTo(run(checkout, "rev-parse", "@{upstream}"));
    assertThat(Files.readString(checkout.resolve("tracked.txt"))).isEqualTo("second update\n");
    assertThat(Files.readString(local)).isEqualTo("keep this local file\n");
    assertThat(pulled.files())
        .anySatisfy(
            file -> {
              assertThat(file.file()).isEqualTo("unsaved-local.txt");
              assertThat(file.untracked()).isTrue();
            });
  }

  @Test
  void statusImmediatelyReflectsAPullPerformedOutsideArgus() throws Exception {
    advanceRemoteTwice();
    service.fetch(checkout);
    assertThat(service.status(checkout).behind()).isEqualTo(2);

    run(checkout, "pull", "--ff-only");

    assertThat(service.status(checkout).behind()).isZero();
    assertThat(service.status(checkout).ahead()).isZero();
  }

  private void advanceRemoteTwice() throws Exception {
    commit("first update");
    commit("second update");
    run(producer, "push", "team", "integration");
  }

  private void commit(String text) throws Exception {
    Files.writeString(producer.resolve("tracked.txt"), text + "\n");
    run(producer, "add", "tracked.txt");
    run(producer, "commit", "-m", text);
  }

  private String run(Path directory, String... arguments) {
    var args = new ArrayList<>(List.of("-C", directory.toString()));
    args.addAll(List.of(arguments));
    return commands.run("git", args, null, Duration.ofSeconds(15)).stdout().trim();
  }
}
