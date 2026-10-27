package com.argus.onboarding.service;

import static org.assertj.core.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RepositoryDiscoveryServiceTest {
  @TempDir Path root;

  @Test
  void cloneSupportsSpacesUnicodeAndEncodedNamesWithoutAllowingTraversal() throws Exception {
    var runner = new com.argus.common.process.LocalCommandRunner();
    Path source = root.resolve("équipe service.git");
    runner.run(
        "git",
        List.of("init", "--bare", source.toString()),
        null,
        java.time.Duration.ofSeconds(10));
    Path destination = Files.createDirectory(root.resolve("clones"));
    var service = new RepositoryDiscoveryService(runner);
    var result = service.cloneWithDetails(source.toString(), destination.toString());
    assertThat(
            java.text.Normalizer.normalize(
                Path.of(result.path()).getFileName().toString(), java.text.Normalizer.Form.NFC))
        .isEqualTo("équipe service");
    assertThat(Files.isDirectory(Path.of(result.path()).resolve(".git"))).isTrue();
    assertThat(
            java.text.Normalizer.normalize(
                RepositoryDiscoveryService.remoteName(source.toUri().toString()),
                java.text.Normalizer.Form.NFC))
        .isEqualTo("équipe service");
    assertThat(
            RepositoryDiscoveryService.remoteName("https://example.invalid/team/Project%20One.git"))
        .isEqualTo("Project One");
    assertThat(RepositoryDiscoveryService.remoteName("file:/tmp/Project%20One.git"))
        .isEqualTo("Project One");
    for (String remote :
        List.of(
            "https://host/team/%2e%2e",
            "https://host/team/%2fescape.git",
            "https://host/team/%5cescape.git",
            "https://host/team/%00.git",
            "https://host/"))
      assertThatThrownBy(() -> RepositoryDiscoveryService.remoteName(remote))
          .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void gitPrerequisitesDistinguishMissingOldAndSupportedVersions() {
    for (String version :
        List.of("git version 2.31.0", "git version 2.50.1 (Apple Git-155)", "git version 3.0.0")) {
      var service =
          new RepositoryDiscoveryService(
              (command, args, cwd, timeout) ->
                  new com.argus.common.process.CommandResult(version, "", 0));
      assertThat(service.prerequisites())
          .containsEntry("available", true)
          .containsEntry("compatible", true);
    }
    var old =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) ->
                new com.argus.common.process.CommandResult("git version 2.30.9", "", 0));
    assertThat(old.prerequisites())
        .containsEntry("available", true)
        .containsEntry("compatible", false)
        .containsEntry("minimumVersion", "2.31.0");
    var missing =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              throw new IllegalStateException("Cannot run git");
            });
    assertThat(missing.prerequisites())
        .containsEntry("available", false)
        .containsEntry("compatible", false);
    assertThat(String.valueOf(missing.prerequisites().get("message")))
        .contains("Install Git", "restart Argus");
  }

  @Test
  void realLocalGitCloneRemainsSupportedWithoutNetworkOrAuthentication() throws Exception {
    var runner = new com.argus.common.process.LocalCommandRunner();
    Path source = root.resolve("source.git");
    runner.run(
        "git",
        List.of("init", "--bare", source.toString()),
        null,
        java.time.Duration.ofSeconds(10));
    Path destination = Files.createDirectory(root.resolve("clones"));
    var result =
        new RepositoryDiscoveryService(runner)
            .cloneWithDetails(source.toString(), destination.toString());
    assertThat(result.transport()).isEqualTo("local");
    assertThat(result.fallbackUsed()).isFalse();
    assertThat(Files.isDirectory(Path.of(result.path()).resolve(".git"))).isTrue();
    assertThat(
            runner
                .run(
                    "git",
                    List.of("-C", result.path(), "remote", "get-url", "origin"),
                    null,
                    java.time.Duration.ofSeconds(10))
                .stdout()
                .trim())
        .isEqualTo(source.toString());
  }

  @Test
  void discoversGitDirectoriesAndWorktreeMarkersButNotIgnoredOrSymlinkChildren() throws Exception {
    Path normal = Files.createDirectories(root.resolve("normal/.git"));
    Files.writeString(normal.resolve("HEAD"), "ref: refs/heads/main\n");
    Path worktree = Files.createDirectories(root.resolve("worktree"));
    Files.writeString(worktree.resolve(".git"), "gitdir: ../normal/.git/worktrees/worktree\n");
    Path ignored = Files.createDirectories(root.resolve("node_modules/ignored/.git"));
    Files.writeString(ignored.resolve("HEAD"), "ref: refs/heads/main\n");
    Files.createSymbolicLink(root.resolve("alias"), root.resolve("normal"));
    var service =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              throw new AssertionError("Discovery must not execute repository code");
            });
    assertThat(service.discover(List.of(root.toString(), root.resolve("normal").toString())))
        .containsExactly(
            root.resolve("normal").toRealPath().toString(), worktree.toRealPath().toString());
  }

  @Test
  void cloneRollbackDeletesOnlyItsReservedDestination() throws Exception {
    Path parent = Files.createDirectories(root.resolve("clones"));
    Files.writeString(parent.resolve("keep.txt"), "user data");
    var calls = new AtomicInteger();
    var service =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              calls.incrementAndGet();
              Path destination = Path.of(args.get(args.size() - 1));
              assertThat(Files.isDirectory(destination)).isTrue();
              throw new IllegalStateException("fixture clone failure");
            });
    assertThatThrownBy(
            () -> service.cloneRepository("https://example.invalid/demo.git", parent.toString()))
        .hasMessageContaining("could not clone");
    assertThat(Files.exists(parent.resolve("demo"))).isFalse();
    assertThat(Files.readString(parent.resolve("keep.txt"))).isEqualTo("user data");
    Files.createDirectories(parent.resolve("demo"));
    Files.writeString(parent.resolve("demo/mine.txt"), "mine");
    assertThatThrownBy(
            () -> service.cloneRepository("https://example.invalid/demo.git", parent.toString()))
        .hasMessageContaining("already exists");
    assertThat(calls).hasValue(1);
    assertThat(Files.readString(parent.resolve("demo/mine.txt"))).isEqualTo("mine");
  }

  @Test
  void successfulHttpsDoesNotRetryOrChangeOrigin() throws Exception {
    var calls = new ArrayList<List<String>>();
    var service =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              calls.add(args);
              return new com.argus.common.process.CommandResult("", "", 0);
            });
    var result =
        service.cloneWithDetails("https://user@bitbucket.org/team/demo.git", root.toString());
    assertThat(result.transport()).isEqualTo("https");
    assertThat(result.fallbackUsed()).isFalse();
    assertThat(result.path()).isEqualTo(root.resolve("demo").toRealPath().toString());
    assertThat(calls).hasSize(1);
    assertThat(calls.get(0)).contains("https://user@bitbucket.org/team/demo.git");
  }

  @Test
  void bitbucketHttpsAuthFailureRetriesOnceThroughSshAndReturnsTransport() throws Exception {
    var remotes = new ArrayList<String>();
    Files.writeString(root.resolve("keep.txt"), "user data");
    var service =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              String remote = args.get(args.size() - 2);
              remotes.add(remote);
              Path target = Path.of(args.get(args.size() - 1));
              assertThat(Files.isDirectory(target)).isTrue();
              if (remotes.size() == 1) {
                try {
                  Files.writeString(target.resolve("partial"), "incomplete HTTPS attempt");
                } catch (java.io.IOException error) {
                  throw new IllegalStateException(error);
                }
                throw RepositoryCloneAuthTest.failed(
                    "fatal: could not read Password: Device not configured");
              }
              assertThat(Files.exists(target.resolve("partial"))).isFalse();
              return new com.argus.common.process.CommandResult("", "", 0);
            });
    var result =
        service.cloneWithDetails("https://user@bitbucket.org/team/demo.git", root.toString());
    assertThat(remotes)
        .containsExactly(
            "https://user@bitbucket.org/team/demo.git", "git@bitbucket.org:team/demo.git");
    assertThat(result.transport()).isEqualTo("ssh");
    assertThat(result.fallbackUsed()).isTrue();
    assertThat(Files.readString(root.resolve("keep.txt"))).isEqualTo("user data");
  }

  @Test
  void failedSshRetryCleansOnlyOwnedDestinationAndHasNoThirdAttempt() throws Exception {
    var calls = new AtomicInteger();
    var service =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              if (calls.incrementAndGet() == 1)
                throw RepositoryCloneAuthTest.failed("Authentication failed");
              throw RepositoryCloneAuthTest.failed("Permission denied (publickey)");
            });
    assertThatThrownBy(
            () -> service.cloneWithDetails("https://bitbucket.org/team/demo.git", root.toString()))
        .hasMessageContaining("SSH retry");
    assertThat(calls).hasValue(2);
    assertThat(Files.exists(root.resolve("demo"))).isFalse();
  }

  @Test
  void nonAuthenticationAndNonBitbucketErrorsDoNotRetry() throws Exception {
    for (String remote :
        List.of("https://bitbucket.org/team/demo.git", "https://example.org/team/demo.git")) {
      var calls = new AtomicInteger();
      var service =
          new RepositoryDiscoveryService(
              (command, args, cwd, timeout) -> {
                calls.incrementAndGet();
                throw RepositoryCloneAuthTest.failed(
                    remote.contains("example.org")
                        ? "Authentication failed"
                        : "Connection timed out");
              });
      assertThatThrownBy(() -> service.cloneWithDetails(remote, root.toString()))
          .isInstanceOf(IllegalArgumentException.class);
      assertThat(calls).hasValue(1);
      assertThat(Files.exists(root.resolve("demo"))).isFalse();
    }
  }

  @Test
  void cancellationDoesNotStartSshRetry() {
    var calls = new AtomicInteger();
    var service =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              calls.incrementAndGet();
              Thread.currentThread().interrupt();
              throw RepositoryCloneAuthTest.failed("Authentication failed");
            });
    try {
      assertThatThrownBy(
              () ->
                  service.cloneWithDetails("https://bitbucket.org/team/demo.git", root.toString()))
          .hasMessageContaining("interrupted");
      assertThat(calls).hasValue(1);
      assertThat(Thread.currentThread().isInterrupted()).isTrue();
    } finally {
      Thread.interrupted();
    }
  }

  @Test
  void replacementDestinationIsPreservedAndNeverRetried() throws Exception {
    var calls = new AtomicInteger();
    var service =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              calls.incrementAndGet();
              Path target = Path.of(args.get(args.size() - 1));
              try {
                Files.move(target, root.resolve("original-reservation"));
                Files.createDirectory(target);
                Files.writeString(target.resolve("mine.txt"), "user data");
              } catch (java.io.IOException error) {
                throw new IllegalStateException(error);
              }
              throw RepositoryCloneAuthTest.failed("Authentication failed");
            });
    assertThatThrownBy(
            () -> service.cloneWithDetails("https://bitbucket.org/team/demo.git", root.toString()))
        .hasMessageContaining("destination changed");
    assertThat(calls).hasValue(1);
    assertThat(Files.readString(root.resolve("demo/mine.txt"))).isEqualTo("user data");
  }

  @Test
  void embeddedSecretsAreRejectedBeforeReservingDirectoryOrExecutingGit() {
    var service =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              throw new AssertionError("No Git call is allowed");
            });
    assertThatThrownBy(
            () ->
                service.cloneWithDetails(
                    "https://user:secret@bitbucket.org/team/demo.git", root.toString()))
        .hasMessageContaining("Do not put")
        .hasMessageNotContaining("secret@");
    assertThat(Files.exists(root.resolve("demo"))).isFalse();
  }
}
