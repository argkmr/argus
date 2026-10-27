package com.argus.git.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandResult;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class GitRecentBranchesTest {
  private static final Path ROOT = Path.of("/disposable-repository");

  @Test
  void recentBranchesAreUniqueExistingLocalTargetsInCheckoutOrderNotCommitOrder() {
    var calls = new ArrayList<List<String>>();
    var service =
        new GitService(
            (executable, args, directory, timeout) -> {
              assertThat(executable).isEqualTo("git");
              assertThat(directory).isNull();
              assertThat(args).startsWith("-C", ROOT.toString());
              assertThat(timeout).isEqualTo(Duration.ofSeconds(5));
              calls.add(args);
              return output(
                  args.contains("for-each-ref")
                      ? refs("main", "one", "two", "three", "four", "five")
                          + "refs/heads/alias\0alias\0 \0\0refs/heads/one\n"
                          + "refs/remotes/origin/remote\0origin/remote\0 \0\0\n"
                          + "refs/heads/truncated\0truncated\n"
                      : """
                          checkout: moving from one to main
                          checkout: moving from truncated to one
                          commit: checkout: moving from five to four
                          checkout: moving from one to one
                          checkout: moving from gone to one
                          checkout: moving from origin/remote to gone
                          checkout: moving from alias to origin/remote
                          checkout: moving from 123abcdef to alias
                          checkout: moving from two to 123abcdef
                          checkout: moving from three to two
                          checkout: moving from four to three
                          checkout: moving from five to four
                          """);
            });

    assertThat(service.recentBranches(ROOT))
        .extracting("name")
        .containsExactly("one", "two", "three", "four");
    assertThat(calls).hasSize(2);
    assertThat(calls.get(0)).endsWith("refs/heads/");
    assertThat(calls.get(1))
        .containsExactly(
            "-C",
            ROOT.toString(),
            "reflog",
            "show",
            "--max-count=256",
            "--format=%gs",
            "HEAD",
            "--");
  }

  @Test
  void branchEnumerationFailuresAreNotHiddenAsAnEmptyRecentList() {
    var failure = new CommandFailedException("Not a repository", new CommandResult("", "", 128));
    var service =
        new GitService(
            (executable, args, directory, timeout) -> {
              assertThat(args).contains("for-each-ref");
              throw failure;
            });
    assertThatThrownBy(() -> service.recentBranches(ROOT)).isSameAs(failure);
  }

  @Test
  void missingHeadReflogIsOptionalButTimeoutsRemainVisible() {
    var missing = new CommandFailedException("Unknown HEAD", new CommandResult("", "", 128));
    var service =
        new GitService(
            (executable, args, directory, timeout) -> {
              if (args.contains("for-each-ref")) return output(refs("main", "one"));
              throw missing;
            });
    assertThat(service.recentBranches(ROOT)).isEmpty();

    var timeoutError = new IllegalStateException("Git timed out");
    var slow =
        new GitService(
            (executable, args, directory, timeout) -> {
              if (args.contains("for-each-ref")) return output(refs("main", "one"));
              throw timeoutError;
            });
    assertThatThrownBy(() -> slow.recentBranches(ROOT)).isSameAs(timeoutError);
  }

  @Test
  void noAlternativeLocalBranchesSkipsTheReflogLookup() {
    var calls = new ArrayList<List<String>>();
    var service =
        new GitService(
            (executable, args, directory, timeout) -> {
              calls.add(args);
              return output(refs("main"));
            });
    assertThat(service.recentBranches(ROOT)).isEmpty();
    assertThat(calls).hasSize(1);
  }

  @Test
  void fullBranchAndStatusReadsDoNotRunTheRecentLookup() {
    var calls = new ArrayList<List<String>>();
    var service =
        new GitService(
            (executable, args, directory, timeout) -> {
              calls.add(args);
              return output(args.contains("status") ? "## main\n" : "");
            });
    service.branches(ROOT);
    service.status(ROOT);
    assertThat(calls).hasSize(3);
    assertThat(calls).noneMatch(args -> args.contains("reflog") || args.contains("for-each-ref"));
  }

  private static String refs(String current, String... other) {
    var output = new StringBuilder("refs/heads/" + current + "\0" + current + "\0*\0\0\n");
    for (String name : other) {
      output.append("refs/heads/").append(name).append('\0').append(name).append("\0 \0\0\n");
    }
    return output.toString();
  }

  private static CommandResult output(String stdout) {
    return new CommandResult(stdout, "", 0);
  }
}
