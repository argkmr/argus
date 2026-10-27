package com.argus.git.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import com.argus.common.process.LocalCommandRunner;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.git.dto.GitStashEntry;
import com.argus.git.dto.GitStashPopRequest;
import com.argus.git.dto.GitStashRequest;
import com.argus.git.repository.GitRecoveryRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class GitStashServiceTest {
  @TempDir Path temporary;
  private Path root;
  private LocalCommandRunner commands;
  private GitFileRevertService reverts;
  private GitStashService service;
  private final List<List<String>> calls = new ArrayList<>();

  @BeforeEach
  void setup() throws Exception {
    root = Files.createDirectory(temporary.resolve("repo")).toRealPath();
    commands = new LocalCommandRunner();
    reverts =
        new GitFileRevertService(
            commands,
            new GitRecoveryRepository(
                new ArgusProperties(temporary.resolve("data"), temporary, "fixture", ""),
                new AtomicJsonStore(new ObjectMapper())));
    service =
        new GitStashService(
            (executable, args, cwd, timeout) -> {
              assertThat(Thread.holdsLock(reverts.lock(root))).isTrue();
              assertThat(executable).isEqualTo("git");
              assertThat(args)
                  .contains(
                      "-C", root.toString(), "core.fsmonitor=false", "core.hooksPath=/dev/null");
              assertThat(args)
                  .doesNotContain("fetch", "pull", "reset", "clean", "--literal-pathspecs");
              if (args.contains("push")) assertThat(args).containsSubsequence("stash", "push");
              calls.add(List.copyOf(args));
              return commands.run(executable, args, cwd, timeout);
            },
            reverts);
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Argus Fixture");
    git("config", "user.email", "fixture@example.invalid");
    write("tracked.txt", "HEAD\n");
    write("other.txt", "other HEAD\n");
    write(".gitignore", "ignored.txt\n");
    git("add", "--", "tracked.txt", "other.txt", ".gitignore");
    git("commit", "-q", "-m", "fixture");
  }

  @Test
  void trackedDefaultLeavesUntrackedAndIgnoredAndPopRestoresIndexSeparately() throws Exception {
    write("tracked.txt", "INDEX\n");
    git("add", "--", "tracked.txt");
    write("tracked.txt", "WORKING\n");
    write("new.txt", "untracked\n");
    write("ignored.txt", "ignored\n");
    var result = service.create(root, new GitStashRequest("separate index", false));
    assertThat(result.ok()).isTrue();
    assertThat(result.status()).isEqualTo("created");
    assertThat(result.stashRetained()).isTrue();
    assertThat(result.stash().id()).matches("[a-f0-9]{40}");
    assertThat(result.stash().ref()).isEqualTo("stash@{0}");
    assertThat(result.stash().subject()).contains("separate index");
    assertThat(Instant.parse(result.stash().createdAt())).isBeforeOrEqualTo(Instant.now());
    assertThat(read("tracked.txt")).isEqualTo("HEAD\n");
    assertThat(git("show", ":tracked.txt")).isEqualTo("HEAD\n");
    assertThat(read("new.txt")).isEqualTo("untracked\n");
    assertThat(read("ignored.txt")).isEqualTo("ignored\n");
    assertThat(service.list(root)).containsExactly(result.stash());
    var popped = service.pop(root, selection(result.stash()));
    assertThat(popped.ok()).isTrue();
    assertThat(popped.status()).isEqualTo("popped");
    assertThat(popped.applied()).isTrue();
    assertThat(popped.dropped()).isTrue();
    assertThat(popped.stashRetained()).isFalse();
    assertThat(read("tracked.txt")).isEqualTo("WORKING\n");
    assertThat(git("show", ":tracked.txt")).isEqualTo("INDEX\n");
    assertThat(git("show", "HEAD:tracked.txt")).isEqualTo("HEAD\n");
    assertThat(service.list(root)).isEmpty();
    assertThat(calls)
        .anySatisfy(
            args ->
                assertThat(args)
                    .containsSubsequence("stash", "apply", "--index", result.stash().id()));
    assertThat(calls).noneSatisfy(args -> assertThat(args).containsSubsequence("stash", "pop"));
  }

  @Test
  void optionalUntrackedFilesAreStashedButIgnoredFilesNeverAre() throws Exception {
    write("untracked.txt", "new content\n");
    write("ignored.txt", "private local\n");
    var result = service.create(root, new GitStashRequest("with untracked", true));
    assertThat(result.status()).isEqualTo("created");
    assertThat(Files.exists(root.resolve("untracked.txt"))).isFalse();
    assertThat(read("ignored.txt")).isEqualTo("private local\n");
    assertThat(git("ls-tree", "-r", "--name-only", result.stash().id() + "^3"))
        .contains("untracked.txt")
        .doesNotContain("ignored.txt");
    assertThat(service.pop(root, selection(result.stash())).ok()).isTrue();
    assertThat(read("untracked.txt")).isEqualTo("new content\n");
    assertThat(read("ignored.txt")).isEqualTo("private local\n");
    assertThat(git("ls-files", "--", "untracked.txt")).isEmpty();
  }

  @Test
  void emptyAndOnlyUntrackedDefaultNeverCreateOrRemoveAStash() throws Exception {
    write("new.txt", "new\n");
    write("ignored.txt", "ignored\n");
    var result = service.create(root, null);
    assertThat(result.status()).isEqualTo("empty");
    assertThat(result.ok()).isTrue();
    assertThat(result.stash()).isNull();
    assertNoMutationCommands();
    assertThat(service.list(root)).isEmpty();
    assertThat(read("new.txt")).isEqualTo("new\n");
  }

  @Test
  void exactOlderSelectionDoesNotPopTheNewestStash() throws Exception {
    write("tracked.txt", "first\n");
    var first = service.create(root, new GitStashRequest("first", false)).stash();
    write("other.txt", "second\n");
    var second = service.create(root, new GitStashRequest("second", false)).stash();
    var entries = service.list(root);
    assertThat(entries).extracting(GitStashEntry::id).containsExactly(second.id(), first.id());
    var result = service.pop(root, selection(entries.get(1)));
    assertThat(result.status()).isEqualTo("popped");
    assertThat(read("tracked.txt")).isEqualTo("first\n");
    assertThat(read("other.txt")).isEqualTo("other HEAD\n");
    assertThat(service.list(root)).extracting(GitStashEntry::id).containsExactly(second.id());
  }

  @Test
  void shiftedOrMissingSelectionFailsBeforeApplyingAnything() throws Exception {
    write("tracked.txt", "first\n");
    var first = service.create(root, null).stash();
    write("other.txt", "second\n");
    var second = service.create(root, null).stash();
    calls.clear();
    assertThatThrownBy(() -> service.pop(root, selection(first)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("changed or disappeared");
    assertThatThrownBy(() -> service.pop(root, new GitStashPopRequest("a".repeat(40), "stash@{0}")))
        .isInstanceOf(ConflictException.class);
    assertNoMutationCommands();
    assertThat(read("tracked.txt")).isEqualTo("HEAD\n");
    assertThat(service.list(root))
        .extracting(GitStashEntry::id)
        .containsExactly(second.id(), first.id());
  }

  @Test
  void unstagedAndStagedLocalChangesBlockPopWithoutDropping() throws Exception {
    write("tracked.txt", "stash\n");
    var stash = service.create(root, null).stash();
    write("other.txt", "preserve\n");
    calls.clear();
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("tracked and staged");
    git("add", "--", "other.txt");
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class);
    assertNoMutationCommands();
    assertThat(git("show", ":other.txt")).isEqualTo("preserve\n");
    assertThat(service.list(root)).containsExactly(stash);
  }

  @Test
  void mergeConflictKeepsStashAndReportsConflictRatherThanSuccess() throws Exception {
    write("tracked.txt", "stash version\n");
    var stash = service.create(root, null).stash();
    write("tracked.txt", "new committed version\n");
    git("commit", "-qam", "intervening change");
    calls.clear();
    var result = service.pop(root, selection(stash));
    assertThat(result.ok()).isFalse();
    assertThat(result.status()).isEqualTo("conflicts");
    assertThat(result.dropped()).isFalse();
    assertThat(result.stashRetained()).isTrue();
    assertThat(read("tracked.txt")).contains("<<<<<<<", "stash version", "new committed version");
    assertThat(service.list(root)).containsExactly(stash);
    assertThat(calls).noneSatisfy(args -> assertThat(args).containsSubsequence("stash", "drop"));
    assertThatThrownBy(() -> service.create(root, null)).isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void stagedPatchFailureAlsoKeepsStash() throws Exception {
    write("tracked.txt", "staged stash version\n");
    git("add", "--", "tracked.txt");
    var stash = service.create(root, null).stash();
    write("tracked.txt", "new committed version\n");
    git("commit", "-qam", "intervening change");
    var result = service.pop(root, selection(stash));
    assertThat(result.ok()).isFalse();
    assertThat(result.status()).isEqualTo("apply_failed");
    assertThat(result.stashRetained()).isTrue();
    assertThat(service.list(root)).containsExactly(stash);
  }

  @Test
  void collidingUntrackedAndIgnoredFilesAreNotOverwritten() throws Exception {
    write("new.txt", "stashed new\n");
    var stash = service.create(root, new GitStashRequest("new file", true)).stash();
    write("new.txt", "keep local\n");
    calls.clear();
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("would be overwritten");
    Files.writeString(root.resolve(".git/info/exclude"), "new.txt\n");
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("would be overwritten");
    assertNoMutationCommands();
    assertThat(read("new.txt")).isEqualTo("keep local\n");
    assertThat(service.list(root)).containsExactly(stash);
  }

  @Test
  void ignoredCollisionWithStagedAdditionIsProtected() throws Exception {
    write("new.txt", "staged new\n");
    git("add", "--", "new.txt");
    var stash = service.create(root, null).stash();
    Files.writeString(root.resolve(".git/info/exclude"), "new.txt\n");
    write("new.txt", "do not replace ignored\n");
    calls.clear();
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class);
    assertNoMutationCommands();
    assertThat(read("new.txt")).isEqualTo("do not replace ignored\n");
  }

  @Test
  void stashedModificationCannotOverwriteAnIgnoredFileDeletedOnTheCurrentBranch() throws Exception {
    write("tracked.txt", "stashed modification\n");
    var stash = service.create(root, null).stash();
    git("rm", "--", "tracked.txt");
    git("commit", "-qm", "delete on current branch");
    Files.writeString(root.resolve(".git/info/exclude"), "tracked.txt\n");
    write("tracked.txt", "precious ignored local content\n");
    calls.clear();
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("would be overwritten");
    assertNoMutationCommands();
    assertThat(read("tracked.txt")).isEqualTo("precious ignored local content\n");
    assertThat(git("ls-files", "--unmerged", "-z")).isEmpty();
    assertThat(service.list(root)).containsExactly(stash);
  }

  @Test
  void indexOnlyRestorationAlsoProtectsCurrentUntrackedPaths() throws Exception {
    write("tracked.txt", "staged modification\n");
    git("add", "--", "tracked.txt");
    write("tracked.txt", "HEAD\n");
    var stash = service.create(root, null).stash();
    assertThat(git("diff", "--name-only", stash.id() + "^1", stash.id(), "--")).isEmpty();
    git("rm", "--", "tracked.txt");
    git("commit", "-qm", "delete on current branch");
    write("tracked.txt", "precious untracked local content\n");
    calls.clear();
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("would be overwritten");
    assertNoMutationCommands();
    assertThat(read("tracked.txt")).isEqualTo("precious untracked local content\n");
    assertThat(service.list(root)).containsExactly(stash);
  }

  @Test
  void modifiedPathCannotReplaceALocalDirectoryOrTraverseASymlink() throws Exception {
    Files.createDirectory(root.resolve("nested"));
    write("nested/file.txt", "base\n");
    git("add", "--", "nested/file.txt");
    git("commit", "-qm", "nested fixture");
    write("nested/file.txt", "stashed modification\n");
    var stash = service.create(root, null).stash();
    git("rm", "--", "nested/file.txt");
    git("commit", "-qm", "delete nested file");
    Files.createDirectories(root.resolve("nested/file.txt"));
    write("nested/file.txt/precious.txt", "keep directory contents\n");
    calls.clear();
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("would be overwritten");
    assertNoMutationCommands();
    assertThat(read("nested/file.txt/precious.txt")).isEqualTo("keep directory contents\n");
    Path savedDirectory = temporary.resolve("saved-local-directory");
    Files.move(root.resolve("nested"), savedDirectory);
    Files.createSymbolicLink(root.resolve("nested"), savedDirectory);
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("blocks this stash");
    assertNoMutationCommands();
    assertThat(Files.readString(savedDirectory.resolve("file.txt/precious.txt")))
        .isEqualTo("keep directory contents\n");
    assertThat(service.list(root)).containsExactly(stash);
  }

  @Test
  void directoryRenameInferenceCannotRedirectAStashIntoAnIgnoredLocalFile() throws Exception {
    Files.createDirectory(root.resolve("old"));
    write("old/existing.txt", "base\n");
    git("add", "--", "old/existing.txt");
    git("commit", "-qm", "directory fixture");
    write("old/new.txt", "stashed addition\n");
    git("add", "--", "old/new.txt");
    var stash = service.create(root, null).stash();
    git("mv", "old", "renamed");
    git("commit", "-qm", "rename directory on current branch");
    Files.writeString(root.resolve(".git/info/exclude"), "renamed/new.txt\n");
    write("renamed/new.txt", "precious ignored destination\n");
    calls.clear();
    var result = service.pop(root, selection(stash));
    assertThat(result.ok()).isTrue();
    assertThat(result.status()).isEqualTo("popped");
    assertThat(read("renamed/new.txt")).isEqualTo("precious ignored destination\n");
    assertThat(read("old/new.txt")).isEqualTo("stashed addition\n");
    assertThat(read("renamed/existing.txt")).isEqualTo("base\n");
    assertThat(git("show", ":old/new.txt")).isEqualTo("stashed addition\n");
    assertThat(git("ls-files", "--unmerged", "-z")).isEmpty();
    assertThat(service.list(root)).isEmpty();
    assertThat(calls)
        .anySatisfy(
            args ->
                assertThat(args)
                    .containsSubsequence(
                        "-c",
                        "merge.directoryRenames=false",
                        "stash",
                        "apply",
                        "--index",
                        stash.id()));
  }

  @Test
  void symlinkParentCannotRedirectAnUntrackedRestore() throws Exception {
    Files.createDirectory(root.resolve("nested"));
    write("nested/new.txt", "stash\n");
    var stash = service.create(root, new GitStashRequest("nested", true)).stash();
    Path outside = Files.createDirectory(temporary.resolve("outside"));
    Files.createSymbolicLink(root.resolve("nested"), outside);
    assertThatThrownBy(() -> service.pop(root, selection(stash)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("blocks this stash");
    assertThat(Files.exists(outside.resolve("new.txt"))).isFalse();
    assertThat(service.list(root)).containsExactly(stash);
  }

  @Test
  void unfinishedGitOperationsBlockBothMutations() throws Exception {
    write("tracked.txt", "stash\n");
    var stash = service.create(root, null).stash();
    for (String marker :
        List.of(
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "REBASE_HEAD",
            "BISECT_LOG",
            "rebase-merge",
            "rebase-apply",
            "sequencer",
            "index.lock")) {
      Path file = root.resolve(".git").resolve(marker);
      Files.writeString(file, "fixture\n");
      calls.clear();
      assertThatThrownBy(() -> service.create(root, null))
          .isInstanceOf(ConflictException.class)
          .hasMessageContaining(marker);
      assertThatThrownBy(() -> service.pop(root, selection(stash)))
          .isInstanceOf(ConflictException.class)
          .hasMessageContaining(marker);
      assertNoMutationCommands();
      Files.delete(file);
    }
    assertThat(service.list(root)).containsExactly(stash);
  }

  @Test
  void initialCommitRequiredAndSubdirectoriesAreNotTreatedAsTheConnectedRoot() throws Exception {
    Path empty = Files.createDirectory(temporary.resolve("empty"));
    commands.run(
        "git", List.of("-C", empty.toString(), "init", "-q"), empty, Duration.ofSeconds(15));
    var direct = new GitStashService(commands, reverts);
    assertThat(direct.list(empty)).isEmpty();
    assertThatThrownBy(() -> direct.create(empty, null))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("initial commit");
    Path nested = Files.createDirectory(root.resolve("nested"));
    assertThatThrownBy(() -> direct.list(nested))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("working-tree root");
  }

  @Test
  void malformedSelectionOrMessageDoesNotEvenRunAGitCommand() {
    var runner = mock(CommandRunner.class);
    var guarded = new GitStashService(runner, reverts);
    for (String message :
        List.of("x".repeat(241), "\n", "note\n", "one\rtwo", "bad\u0000text", "\t"))
      assertThatThrownBy(() -> guarded.create(root, new GitStashRequest(message, false)))
          .isInstanceOf(IllegalArgumentException.class);
    for (GitStashPopRequest request :
        List.of(
            new GitStashPopRequest(null, "stash@{0}"),
            new GitStashPopRequest("--all", "stash@{0}"),
            new GitStashPopRequest("a".repeat(40), "--all"),
            new GitStashPopRequest("a".repeat(40), "stash@{01}"),
            new GitStashPopRequest("a".repeat(40), "stash@{-1}"),
            new GitStashPopRequest("a".repeat(40), "stash@{0};touch pwn")))
      assertThatThrownBy(() -> guarded.pop(root, request))
          .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> guarded.pop(root, null)).isInstanceOf(IllegalArgumentException.class);
    verifyNoInteractions(runner);
  }

  @Test
  void shellLikeMessageIsOnlyALiteralArgument() throws Exception {
    write("tracked.txt", "change\n");
    String message = "--all ; $(touch should-not-exist) `echo no`";
    var result = service.create(root, new GitStashRequest(message, false));
    assertThat(result.status()).isEqualTo("created");
    assertThat(result.stash().subject()).contains(message);
    assertThat(Files.exists(root.resolve("should-not-exist"))).isFalse();
  }

  @Test
  void changedReflogDuringApplyRetainsTheCapturedStash() throws Exception {
    write("other.txt", "older stash\n");
    var older = service.create(root, new GitStashRequest("older", false)).stash();
    write("tracked.txt", "stash\n");
    var stash = service.create(root, null).stash();
    AtomicBoolean dropped = new AtomicBoolean();
    var raced =
        new GitStashService(
            (executable, args, cwd, timeout) -> {
              if (args.contains("drop")) dropped.set(true);
              var result = commands.run(executable, args, cwd, timeout);
              if (args.contains("apply"))
                // Storing the current tip again is a Git no-op; use a different saved object.
                git("stash", "store", "-m", "external older entry", older.id());
              return result;
            },
            reverts);
    var result = raced.pop(root, selection(stash));
    assertThat(result.status()).isEqualTo("applied_retained");
    assertThat(result.applied()).isTrue();
    assertThat(result.stashRetained()).isTrue();
    assertThat(result.message()).contains("list changed");
    assertThat(dropped).isFalse();
    assertThat(read("tracked.txt")).isEqualTo("stash\n");
    assertThat(service.list(root))
        .extracting(GitStashEntry::id)
        .containsExactly(older.id(), stash.id(), older.id());
  }

  @Test
  void failedDropReportsAppliedRetainedWithoutFallbackOrSecondApply() throws Exception {
    write("tracked.txt", "stash\n");
    var stash = service.create(root, null).stash();
    var captured = new ArrayList<List<String>>();
    var failure =
        new GitStashService(
            (executable, args, cwd, timeout) -> {
              captured.add(List.copyOf(args));
              if (args.contains("drop"))
                throw new CommandFailedException(
                    "fixture drop failure", new CommandResult("", "fixture failure", 1));
              return commands.run(executable, args, cwd, timeout);
            },
            reverts);
    var result = failure.pop(root, selection(stash));
    assertThat(result.status()).isEqualTo("applied_retained");
    assertThat(result.applied()).isTrue();
    assertThat(result.dropped()).isFalse();
    assertThat(result.message()).contains("not confirmed removed");
    assertThat(captured.stream().filter(args -> args.contains("apply")).count()).isEqualTo(1);
    assertThat(captured.stream().filter(args -> args.contains("drop")).count()).isEqualTo(1);
    assertThat(service.list(root)).containsExactly(stash);
    assertThat(read("tracked.txt")).isEqualTo("stash\n");
  }

  @Test
  void interruptedApplyNeverDropsAndDoesNotInviteAutomaticRetry() throws Exception {
    write("tracked.txt", "stash\n");
    var stash = service.create(root, null).stash();
    var failure =
        new GitStashService(
            (executable, args, cwd, timeout) -> {
              if (args.contains("drop"))
                throw new AssertionError("Must not drop after uncertain apply");
              if (args.contains("apply"))
                throw new IllegalStateException("fixture process timeout");
              return commands.run(executable, args, cwd, timeout);
            },
            reverts);
    var result = failure.pop(root, selection(stash));
    assertThat(result.status()).isEqualTo("apply_failed");
    assertThat(result.message()).contains("partially applied", "before retrying");
    assertThat(service.list(root)).containsExactly(stash);
  }

  @Test
  void postPushFailureReportsTheSavedStashRatherThanRepeatingPush() throws Exception {
    write("tracked.txt", "stash\n");
    var failure =
        new GitStashService(
            (executable, args, cwd, timeout) -> {
              var result = commands.run(executable, args, cwd, timeout);
              if (args.contains("push"))
                throw new IllegalStateException("fixture completion timeout");
              return result;
            },
            reverts);
    var result = failure.create(root, null);
    assertThat(result.status()).isEqualTo("created_retained");
    assertThat(result.ok()).isFalse();
    assertThat(result.stashRetained()).isTrue();
    assertThat(service.list(root)).containsExactly(result.stash());
  }

  @Test
  void successfulPushWithIncompleteCleanupIsReportedWithoutRetrying() throws Exception {
    write("untracked.txt", "save me\n");
    var incomplete =
        new GitStashService(
            (executable, args, cwd, timeout) -> {
              var result = commands.run(executable, args, cwd, timeout);
              if (args.contains("push")) {
                try {
                  Files.writeString(root.resolve("untracked.txt"), "still here\n");
                } catch (java.io.IOException error) {
                  throw new java.io.UncheckedIOException(error);
                }
              }
              return result;
            },
            reverts);
    var result = incomplete.create(root, new GitStashRequest("cleanup fixture", true));
    assertThat(result.status()).isEqualTo("created_retained");
    assertThat(result.ok()).isFalse();
    assertThat(result.stashRetained()).isTrue();
    assertThat(result.message()).contains("changes remain", "no retry");
    assertThat(service.list(root)).containsExactly(result.stash());
    assertThat(read("untracked.txt")).isEqualTo("still here\n");
  }

  private GitStashPopRequest selection(GitStashEntry stash) {
    return new GitStashPopRequest(stash.id(), stash.ref());
  }

  private void assertNoMutationCommands() {
    assertThat(calls).noneSatisfy(args -> assertThat(args).containsSubsequence("stash", "push"));
    assertThat(calls).noneSatisfy(args -> assertThat(args).containsSubsequence("stash", "apply"));
    assertThat(calls).noneSatisfy(args -> assertThat(args).containsSubsequence("stash", "drop"));
  }

  private void write(String file, String content) throws Exception {
    Files.writeString(root.resolve(file), content);
  }

  private String read(String file) throws Exception {
    return Files.readString(root.resolve(file));
  }

  private String git(String... args) {
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
    return commands.run("git", command, root, Duration.ofSeconds(15)).stdout();
  }
}
