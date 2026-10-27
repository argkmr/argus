package com.argus.git.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.process.LocalCommandRunner;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.git.dto.*;
import com.argus.git.repository.GitRecoveryRepository;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

class GitFileRevertServiceTest {
  @TempDir Path temporary;
  private Path root;
  private Path data;
  private LocalCommandRunner commands;
  private GitRecoveryRepository recovery;
  private GitFileRevertService service;
  private AtomicJsonStore json;

  @BeforeEach
  void setup() throws Exception {
    root = Files.createDirectory(temporary.resolve("repo"));
    data = temporary.resolve("data");
    commands = new LocalCommandRunner();
    json = new AtomicJsonStore(new ObjectMapper());
    recovery =
        spy(new GitRecoveryRepository(new ArgusProperties(data, temporary, "fixture", ""), json));
    service = new GitFileRevertService(commands, recovery);
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Argus Fixture");
    git("config", "user.email", "fixture@example.invalid");
    write("tracked.txt", "HEAD\n");
    write("other.txt", "other HEAD\n");
    git("add", "--", "tracked.txt", "other.txt");
    git("commit", "-q", "-m", "fixture");
  }

  @Test
  void diffCombinesIndexReadsButRechecksAllMutableAndBlobState() throws Exception {
    stagedAndWorking();
    var calls = new ArrayList<List<String>>();
    service =
        new GitFileRevertService(
            (executable, arguments, directory, timeout) -> {
              calls.add(List.copyOf(arguments));
              return commands.run(executable, arguments, directory, timeout);
            },
            recovery);
    for (boolean staged : List.of(false, true)) {
      var elapsed = new ArrayList<Long>();
      for (int sample = 0; sample < 3; sample++) {
        calls.clear();
        long started = System.nanoTime();
        var result = service.diff(root, "tracked.txt", staged);
        elapsed.add((System.nanoTime() - started) / 1_000_000);
        assertThat(result.beforeContent()).isEqualTo(staged ? "HEAD\n" : "INDEX\n");
        assertThat(result.afterContent()).isEqualTo(staged ? "INDEX\n" : "WORKING\n");
        assertThat(result.revert().allowed()).isTrue();
      }
      elapsed.sort(Long::compareTo);
      long blobs = calls.stream().filter(call -> call.contains("cat-file")).count();
      assertThat(calls.stream().filter(call -> call.contains("ls-files")).toList())
          .hasSize(2)
          .allSatisfy(call -> assertThat(call).contains("--stage", "-v", "-z"));
      assertThat(calls.stream().filter(call -> call.contains("HEAD^{commit}")).count())
          .isEqualTo(2);
      assertThat(calls.stream().filter(call -> call.contains("--git-path")).count()).isEqualTo(2);
      assertThat(calls.stream().filter(call -> call.contains("--find-renames")).count())
          .isEqualTo(2);
      assertThat(blobs).isEqualTo(staged ? 4 : 2);
      // Each successful size probe is followed by one owned raw-blob process.
      assertThat(calls.size() + blobs).isEqualTo(staged ? 19 : 15);
      System.out.printf(
          "DIFF_SYNTHETIC staged=%s processes=%d blobReads=%d medianMs=%d%n",
          staged, calls.size() + blobs, blobs, elapsed.get(1));
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"working", "index", "flags", "head", "rename", "replacement"})
  void aChangeBetweenDiffCapturesStillRejectsTheSnapshot(String changed) throws Exception {
    stagedAndWorking();
    String original = git("rev-parse", ":tracked.txt").trim();
    write("replacement.txt", "Replacement object\n");
    String replacement = git("hash-object", "-w", "--", "replacement.txt").trim();
    service =
        new GitFileRevertService(
            (executable, arguments, directory, timeout) -> {
              var result = commands.run(executable, arguments, directory, timeout);
              if (arguments.contains("--diff-algorithm=myers")) {
                try {
                  switch (changed) {
                    case "working" -> write("tracked.txt", "Newer working bytes\n");
                    case "index" -> {
                      write("tracked.txt", "Newer staged bytes\n");
                      git("add", "--", "tracked.txt");
                    }
                    case "flags" -> git("update-index", "--assume-unchanged", "--", "tracked.txt");
                    case "head" -> git("commit", "--allow-empty", "-q", "-m", "HEAD moved");
                    case "rename" -> git("mv", "--", "tracked.txt", "renamed.txt");
                    case "replacement" -> git("replace", original, replacement);
                    default -> throw new AssertionError(changed);
                  }
                } catch (Exception error) {
                  throw new AssertionError("Fixture mutation failed", error);
                }
              }
              return result;
            },
            recovery);
    assertThatThrownBy(() -> service.diff(root, "tracked.txt", false))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.exists(data.resolve("git-recovery"))).isFalse();
  }

  @ParameterizedTest
  @ValueSource(strings = {"H", "h", "S", "s"})
  void combinedIndexRecordPreservesEveryUserFlagDuringInlineUnstage(String flag) throws Exception {
    seed("one\nkeep\nthree\nend\n", "ONE\nkeep\nTHREE\nend\n", "Working draft\n");
    if (flag.equals("h") || flag.equals("s"))
      git("update-index", "--assume-unchanged", "--", "tracked.txt");
    if (flag.equals("S") || flag.equals("s"))
      git("update-index", "--skip-worktree", "--", "tracked.txt");
    var diff = service.diff(root, "tracked.txt", true);
    assertThat(diff.changes()).hasSize(2);
    inline(diff, true, 0);
    assertThat(git("show", ":tracked.txt")).isEqualTo("one\nkeep\nTHREE\nend\n");
    assertThat(git("ls-files", "-v", "--", "tracked.txt")).startsWith(flag + " ");
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("Working draft\n");
  }

  @Test
  void unstagedRestoreUsesIndexAndPreservesOtherChangesWithDurableRecovery() throws Exception {
    stagedAndWorking();
    write("other.txt", "unrelated edit\n");
    var diff = service.diff(root, "tracked.txt", false);
    assertThat(diff.beforeContent()).isEqualTo("INDEX\n");
    assertThat(diff.afterContent()).isEqualTo("WORKING\n");
    assertThat(diff.revert().allowed()).isTrue();
    assertThat(diff.revert().baseline()).isEqualTo("index");
    var result = revert("tracked.txt", false, diff);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("INDEX\n");
    assertThat(git("show", ":tracked.txt")).isEqualTo("INDEX\n");
    assertThat(git("show", "HEAD:tracked.txt")).isEqualTo("HEAD\n");
    assertThat(Files.readString(root.resolve("other.txt"))).isEqualTo("unrelated edit\n");
    Path receipt = data.resolve("git-recovery").resolve(result.recoveryId());
    assertThat(Files.readString(receipt.resolve("before-content.bin"))).isEqualTo("WORKING\n");
    assertThat(Files.readString(receipt.resolve("baseline-content.bin"))).isEqualTo("INDEX\n");
    assertThat(json.read(receipt.resolve("receipt.json"), Map.class))
        .containsEntry("repositoryId", "fixture")
        .containsEntry("status", "restored");
    assertThat(Files.getPosixFilePermissions(receipt.resolve("before-content.bin"))).hasSize(2);
    assertThat(result.revision()).hasSize(64).isNotEqualTo(diff.revert().revision());
    assertThat(Files.exists(root.resolve(".git/index.lock"))).isFalse();
  }

  @Test
  void stagedRestoreChangesOnlySelectedIndexEntryAndKeepsWorkingTree() throws Exception {
    stagedAndWorking();
    write("other.txt", "other INDEX\n");
    git("add", "--", "other.txt");
    byte[] beforeIndex = Files.readAllBytes(root.resolve(".git/index"));
    var diff = service.diff(root, "tracked.txt", true);
    assertThat(diff.beforeContent()).isEqualTo("HEAD\n");
    assertThat(diff.afterContent()).isEqualTo("INDEX\n");
    var result = revert("tracked.txt", true, diff);
    assertThat(result.target()).isEqualTo("index");
    assertThat(result.restoredFrom()).isEqualTo("HEAD");
    assertThat(git("show", ":tracked.txt")).isEqualTo("HEAD\n");
    assertThat(git("show", ":other.txt")).isEqualTo("other INDEX\n");
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("WORKING\n");
    assertThat(
            Files.readAllBytes(
                data.resolve("git-recovery")
                    .resolve(result.recoveryId())
                    .resolve("before-index.bin")))
        .isEqualTo(beforeIndex);
    assertThat(Files.exists(root.resolve(".git/index.lock"))).isFalse();
  }

  @Test
  void restoresUnstagedDeletionButStagedDeletionLeavesWorkingFileDeleted() throws Exception {
    Files.delete(root.resolve("tracked.txt"));
    revert("tracked.txt", false, service.diff(root, "tracked.txt", false));
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("HEAD\n");
    git("rm", "--", "tracked.txt");
    revert("tracked.txt", true, service.diff(root, "tracked.txt", true));
    assertThat(git("show", ":tracked.txt")).isEqualTo("HEAD\n");
    assertThat(Files.exists(root.resolve("tracked.txt"))).isFalse();
  }

  @Test
  void staleWorktreeIndexAndHeadEachConflictWithoutOverwriting() throws Exception {
    stagedAndWorking();
    var working = service.diff(root, "tracked.txt", false);
    write("tracked.txt", "newer working\n");
    assertThatThrownBy(() -> revert("tracked.txt", false, working))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("newer working\n");
    var index = service.diff(root, "tracked.txt", false);
    git("add", "--", "tracked.txt");
    assertThatThrownBy(() -> revert("tracked.txt", false, index))
        .isInstanceOf(ConflictException.class);
    write("tracked.txt", "another edit\n");
    var head = service.diff(root, "tracked.txt", false);
    git("commit", "--allow-empty", "-q", "-m", "HEAD moved");
    assertThatThrownBy(() -> revert("tracked.txt", false, head))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("another edit\n");
    assertThat(Files.exists(data.resolve("git-recovery"))).isFalse();
  }

  @Test
  void redirectedGitMetadataInvalidatesAnOtherwiseIdenticalViewedRevision() throws Exception {
    stagedAndWorking();
    var diff = service.diff(root, "tracked.txt", false);
    Path redirected = temporary.resolve("redirected-metadata");
    Files.move(root.resolve(".git"), redirected);
    Files.writeString(root.resolve(".git"), "gitdir: " + redirected + "\n");
    assertThatThrownBy(() -> revert("tracked.txt", false, diff))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("WORKING\n");
    assertThat(git("show", ":tracked.txt")).isEqualTo("INDEX\n");
    assertThat(Files.exists(data.resolve("git-recovery"))).isFalse();
  }

  @Test
  void unbornRepositoryWithoutAnIndexStillReturnsAnUntrackedPreview() throws Exception {
    Path empty = Files.createDirectory(temporary.resolve("empty"));
    commands.run(
        "git", List.of("-C", empty.toString(), "init", "-q"), null, Duration.ofSeconds(15));
    Files.writeString(empty.resolve("new.txt"), "not yet tracked\n");
    var diff = service.diff(empty, "new.txt", false);
    assertThat(diff.afterContent()).isEqualTo("not yet tracked\n");
    assertThat(diff.revert().allowed()).isFalse();
    assertThat(diff.revert().reason()).contains("Untracked");
    assertThat(Files.exists(empty.resolve(".git/index"))).isFalse();
  }

  @Test
  void untrackedAndStagedAdditionsAreExplicitlyUnsupportedAndNeverDeleted() throws Exception {
    write("new.txt", "new\n");
    assertUnsupported("new.txt", false, "Untracked");
    git("add", "--", "new.txt");
    assertUnsupported("new.txt", true, "no HEAD");
    assertThat(Files.readString(root.resolve("new.txt"))).isEqualTo("new\n");
    assertThat(git("show", ":new.txt")).isEqualTo("new\n");
  }

  @Test
  void binaryInvalidUtf8AndOversizedFilesKeepPreviewButDisableRevert() throws Exception {
    Files.write(root.resolve("tracked.txt"), new byte[] {1, 0, 2});
    assertUnsupported("tracked.txt", false, "Binary");
    Files.write(root.resolve("tracked.txt"), new byte[] {(byte) 0xc3, 0x28});
    assertUnsupported("tracked.txt", false, "non-UTF-8");
    Files.write(root.resolve("tracked.txt"), new byte[2 * 1024 * 1024 + 1]);
    assertUnsupported("tracked.txt", false, "2 MiB");
  }

  @Test
  void stagedRenamePairsAreNotSplitBySingleFileRevert() throws Exception {
    git("mv", "--", "tracked.txt", "renamed.txt");
    assertUnsupported("tracked.txt", true, "Renamed");
    assertUnsupported("renamed.txt", true, "Renamed");
    assertThat(Files.exists(root.resolve("tracked.txt"))).isFalse();
    assertThat(Files.readString(root.resolve("renamed.txt"))).isEqualTo("HEAD\n");
  }

  @Test
  void conflictEntriesCannotBeReverted() throws Exception {
    git("checkout", "-q", "-b", "side");
    write("tracked.txt", "side\n");
    git("commit", "-qam", "side");
    git("checkout", "-q", "main");
    write("tracked.txt", "main\n");
    git("commit", "-qam", "main");
    assertThatThrownBy(() -> git("merge", "--no-edit", "side"))
        .isInstanceOf(RuntimeException.class);
    assertUnsupported("tracked.txt", false, "merge conflict");
    assertThat(Files.readString(root.resolve("tracked.txt"))).contains("<<<<<<<");
  }

  @Test
  void pathspecMagicIsLiteralAndCannotAffectAnotherFile() throws Exception {
    String name = ":(glob)*.txt";
    write(name, "literal HEAD\n");
    git("add", "--", name);
    git("commit", "-qm", "literal path");
    write(name, "literal edit\n");
    write("other.txt", "keep me\n");
    revert(name, false, service.diff(root, name, false));
    assertThat(Files.readString(root.resolve(name))).isEqualTo("literal HEAD\n");
    assertThat(Files.readString(root.resolve("other.txt"))).isEqualTo("keep me\n");
  }

  @Test
  void traversalMetadataAndSymlinkParentsAreRejectedWithoutTouchingOutside() throws Exception {
    Path outside = Files.createDirectory(temporary.resolve("outside"));
    Files.writeString(outside.resolve("secret.txt"), "keep\n");
    Files.createSymbolicLink(root.resolve("linked"), outside);
    for (String path : List.of("../outside/secret.txt", ".git/config", "linked/secret.txt"))
      assertThatThrownBy(() -> service.diff(root, path, false))
          .isInstanceOf(IllegalArgumentException.class);
    Files.delete(root.resolve("tracked.txt"));
    Files.createSymbolicLink(root.resolve("tracked.txt"), outside.resolve("secret.txt"));
    assertUnsupported("tracked.txt", false, "Symlinks");
    assertThat(Files.readString(outside.resolve("secret.txt"))).isEqualTo("keep\n");
  }

  @Test
  void aForeignIndexLockIsNeverOverwrittenOrDeleted() throws Exception {
    stagedAndWorking();
    var diff = service.diff(root, "tracked.txt", false);
    Path lock = root.resolve(".git/index.lock");
    Files.writeString(lock, "owned by another Git\n");
    assertThatThrownBy(() -> revert("tracked.txt", false, diff))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("busy");
    assertThat(Files.readString(lock)).isEqualTo("owned by another Git\n");
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("WORKING\n");
  }

  @Test
  void rechecksWorktreeAfterDurableRecoveryAndKeepsNewerEdit() throws Exception {
    stagedAndWorking();
    var diff = service.diff(root, "tracked.txt", false);
    doAnswer(
            invocation -> {
              Object result = invocation.callRealMethod();
              write("tracked.txt", "arrived during recovery\n");
              return result;
            })
        .when(recovery)
        .save(anyMap(), any(byte[].class), any(byte[].class), isNull());
    assertThatThrownBy(() -> revert("tracked.txt", false, diff))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("tracked.txt")))
        .isEqualTo("arrived during recovery\n");
    assertThat(Files.exists(root.resolve(".git/index.lock"))).isFalse();
    try (var entries = Files.list(data.resolve("git-recovery"))) {
      assertThat(entries.count()).isEqualTo(1);
    }
  }

  @Test
  void failureToSaveRecoveryNeverChangesIndexOrWorkingFile() throws Exception {
    stagedAndWorking();
    var diff = service.diff(root, "tracked.txt", true);
    byte[] index = Files.readAllBytes(root.resolve(".git/index"));
    doThrow(new IllegalStateException("fixture disk full"))
        .when(recovery)
        .save(anyMap(), any(byte[].class), any(byte[].class), any(byte[].class));
    assertThatThrownBy(() -> revert("tracked.txt", true, diff)).hasMessageContaining("disk full");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(index);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("WORKING\n");
    assertThat(Files.exists(root.resolve(".git/index.lock"))).isFalse();
  }

  @Test
  void failedPostCommitRefreshReportsSuccessfulMutationWithRecoveryAndReloadRequired()
      throws Exception {
    stagedAndWorking();
    var runner = spy(commands);
    service = new GitFileRevertService(runner, recovery);
    var diff = service.diff(root, "tracked.txt", false);
    var saved = new java.util.concurrent.atomic.AtomicBoolean();
    doAnswer(
            invocation -> {
              Object result = invocation.callRealMethod();
              saved.set(true);
              return result;
            })
        .when(recovery)
        .save(anyMap(), any(byte[].class), any(byte[].class), isNull());
    doAnswer(
            invocation -> {
              if (saved.get() && Files.readString(root.resolve("tracked.txt")).equals("INDEX\n"))
                throw new IllegalStateException("post-commit read failed");
              return invocation.callRealMethod();
            })
        .when(runner)
        .run(eq("git"), anyList(), isNull(), any());
    var result = revert("tracked.txt", false, diff);
    assertThat(result.ok()).isTrue();
    assertThat(result.refreshRequired()).isTrue();
    assertThat(result.revision()).isEmpty();
    assertThat(result.recoveryId()).isNotBlank();
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("INDEX\n");
  }

  @Test
  void cancellationAndRepositoryRetirementBlockMutationAndPurgeOnlyOwnedReceipts()
      throws Exception {
    stagedAndWorking();
    var diff = service.diff(root, "tracked.txt", false);
    Thread.currentThread().interrupt();
    try {
      assertThatThrownBy(() -> revert("tracked.txt", false, diff))
          .isInstanceOf(ConflictException.class);
    } finally {
      Thread.interrupted();
    }
    var result = revert("tracked.txt", false, diff);
    String other = recovery.save(Map.of("repositoryId", "another"), new byte[0], new byte[0], null);
    assertThat(service.purgeRepositories(List.of("fixture")))
        .containsEntry("gitRecoverySnapshotsDeleted", 1);
    assertThat(Files.exists(data.resolve("git-recovery").resolve(result.recoveryId()))).isFalse();
    assertThat(Files.exists(data.resolve("git-recovery").resolve(other))).isTrue();
    write("tracked.txt", "edit again\n");
    var next = service.diff(root, "tracked.txt", false);
    assertThatThrownBy(() -> revert("tracked.txt", false, next))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("removed");
    service.releaseRetiredRepositories(List.of("fixture"));
    revert("tracked.txt", false, next);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("INDEX\n");
  }

  private void assertUnsupported(String file, boolean staged, String reason) {
    var diff = service.diff(root, file, staged);
    assertThat(diff.revert().allowed()).isFalse();
    assertThat(diff.revert().reason()).contains(reason);
    assertThatThrownBy(() -> revert(file, staged, diff))
        .isInstanceOfSatisfying(
            ResponseStatusException.class,
            error -> assertThat(error.getStatusCode().value()).isEqualTo(422));
  }

  @Test
  void inlineBlocksSplitInsideOneContextHunkAndRevertOnlyTheSelectedChange() throws Exception {
    String baseline = "one\nmiddle\nthree\nend\n";
    seed(baseline, baseline, "ONE\nmiddle\nTHREE\nend\n");
    byte[] index = Files.readAllBytes(root.resolve(".git/index"));
    var diff = service.diff(root, "tracked.txt", false);
    assertThat(diff.diff().lines().filter(line -> line.startsWith("@@")).count()).isEqualTo(1);
    assertThat(diff.changes()).hasSize(2);
    assertThat(diff.changes()).extracting(GitDiffChange::beforeStart).containsExactly(1, 3);
    assertThat(diff.changes()).extracting(GitDiffChange::beforeCount).containsExactly(1, 1);
    var result = inline(diff, false, 0);
    assertThat(Files.readString(root.resolve("tracked.txt")))
        .isEqualTo("one\nmiddle\nTHREE\nend\n");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(index);
    var receipt =
        json.read(
            data.resolve("git-recovery").resolve(result.recoveryId()).resolve("receipt.json"),
            Map.class);
    assertThat(receipt)
        .containsEntry("changeId", diff.changes().get(0).id())
        .containsEntry("operation", "inline-revert");
    assertThatThrownBy(() -> inline(diff, false, 1)).isInstanceOf(ConflictException.class);
    var remaining = service.diff(root, "tracked.txt", false);
    assertThat(remaining.changes()).hasSize(1);
    assertThatThrownBy(
            () ->
                service.revert(
                    root,
                    "fixture",
                    new GitRevertRequest(
                        "tracked.txt",
                        false,
                        remaining.revert().revision(),
                        diff.changes().get(1).id())))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("change block");
    inline(remaining, false, 0);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo(baseline);
  }

  @Test
  void stagedInlinePreservesOtherBlocksWorkingBytesIndexModeAndUserFlags() throws Exception {
    String baseline = "one\nkeep\nthree\nend\n";
    seed(baseline, "ONE\nkeep\nTHREE\nend\n", "Working bytes stay exactly here\r\n");
    write("other.txt", "other staged change\n");
    git("add", "--", "other.txt");
    // --chmod also refreshes from the working file; set only this cached entry's mode.
    String stagedObject = git("rev-parse", ":tracked.txt").trim();
    git("update-index", "--cacheinfo", "100755," + stagedObject + ",tracked.txt");
    git("update-index", "--assume-unchanged", "--", "tracked.txt");
    git("update-index", "--skip-worktree", "--", "tracked.txt");
    byte[] working = Files.readAllBytes(root.resolve("tracked.txt"));
    var permissions = Files.getPosixFilePermissions(root.resolve("tracked.txt"));
    var diff = service.diff(root, "tracked.txt", true);
    assertThat(diff.changes()).hasSize(2);
    inline(diff, true, 0);
    assertThat(git("show", ":tracked.txt")).isEqualTo("one\nkeep\nTHREE\nend\n");
    assertThat(git("show", ":other.txt")).isEqualTo("other staged change\n");
    assertThat(git("ls-files", "--stage", "--", "tracked.txt")).startsWith("100755 ");
    assertThat(git("ls-files", "-v", "--", "tracked.txt")).startsWith("s ");
    assertThat(Files.readAllBytes(root.resolve("tracked.txt"))).isEqualTo(working);
    assertThat(Files.getPosixFilePermissions(root.resolve("tracked.txt"))).isEqualTo(permissions);
  }

  @Test
  void inlinePreservesCrlfMissingFinalNewlineAndUnrelatedExecutableMode() throws Exception {
    String baseline = "α\r\nkeep\r\nω";
    seed(baseline, baseline, "Α\r\nkeep\r\nΩ");
    assertThat(root.resolve("tracked.txt").toFile().setExecutable(true)).isTrue();
    var permissions = Files.getPosixFilePermissions(root.resolve("tracked.txt"));
    var diff = service.diff(root, "tracked.txt", false);
    assertThat(diff.changes()).hasSize(2);
    inline(diff, false, 0);
    assertThat(Files.readAllBytes(root.resolve("tracked.txt")))
        .isEqualTo("α\r\nkeep\r\nΩ".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    assertThat(Files.getPosixFilePermissions(root.resolve("tracked.txt"))).isEqualTo(permissions);
    inline(service.diff(root, "tracked.txt", false), false, 0);
    assertThat(Files.readAllBytes(root.resolve("tracked.txt")))
        .isEqualTo(baseline.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    var modeOnly = service.diff(root, "tracked.txt", false);
    assertThat(modeOnly.changes()).isEmpty();
    assertThat(modeOnly.revert().allowed()).isTrue();
  }

  @Test
  void newlineOnlyChangeCanBeRevertedWithoutChangingEarlierContent() throws Exception {
    seed("one\nlast", "one\nlast", "one\nlast\n");
    var diff = service.diff(root, "tracked.txt", false);
    assertThat(diff.changes()).hasSize(1);
    inline(diff, false, 0);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("one\nlast");
  }

  @Test
  void deletionBlockHasGapRangeAndDoesNotRemoveSeparateInsertions() throws Exception {
    String baseline = "start\nremove\nkeep\nend\n";
    seed(baseline, baseline, "new\nstart\nkeep\nend\nextra");
    var diff = service.diff(root, "tracked.txt", false);
    assertThat(diff.changes()).hasSize(3);
    var deletion = diff.changes().get(1);
    assertThat(deletion.beforeStart()).isEqualTo(2);
    assertThat(deletion.beforeCount()).isEqualTo(1);
    assertThat(deletion.afterStart()).isEqualTo(3);
    assertThat(deletion.afterCount()).isZero();
    inline(diff, false, 1);
    assertThat(Files.readString(root.resolve("tracked.txt")))
        .isEqualTo("new\nstart\nremove\nkeep\nend\nextra");
  }

  @Test
  void trackedFileDeletionSupportsOneInlineRestoreInEachView() throws Exception {
    Files.delete(root.resolve("tracked.txt"));
    var deleted = service.diff(root, "tracked.txt", false);
    assertThat(deleted.changes()).hasSize(1);
    assertThat(deleted.changes().get(0).afterCount()).isZero();
    inline(deleted, false, 0);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("HEAD\n");
    git("rm", "--", "tracked.txt");
    var staged = service.diff(root, "tracked.txt", true);
    assertThat(staged.changes()).hasSize(1);
    inline(staged, true, 0);
    assertThat(git("show", ":tracked.txt")).isEqualTo("HEAD\n");
    assertThat(Files.exists(root.resolve("tracked.txt"))).isFalse();
  }

  @Test
  void malformedAndUnknownBlockIdsNeverBecomeWholeFileReverts() throws Exception {
    stagedAndWorking();
    var diff = service.diff(root, "tracked.txt", false);
    for (String id : List.of("", "not-an-id", "a".repeat(65), "a".repeat(100000)))
      assertThatThrownBy(
              () ->
                  service.revert(
                      root,
                      "fixture",
                      new GitRevertRequest("tracked.txt", false, diff.revert().revision(), id)))
          .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                service.revert(
                    root,
                    "fixture",
                    new GitRevertRequest(
                        "tracked.txt", false, diff.revert().revision(), "0".repeat(64))))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("WORKING\n");
    assertThat(Files.exists(data.resolve("git-recovery"))).isFalse();
  }

  private void seed(String committed, String indexed, String working) throws Exception {
    write("tracked.txt", committed);
    git("add", "--", "tracked.txt");
    git("commit", "-qm", "inline fixture baseline");
    write("tracked.txt", indexed);
    git("add", "--", "tracked.txt");
    write("tracked.txt", working);
  }

  private GitRevertResponse inline(GitDiffResponse diff, boolean staged, int index) {
    return service.revert(
        root,
        "fixture",
        new GitRevertRequest(
            "tracked.txt", staged, diff.revert().revision(), diff.changes().get(index).id()));
  }

  private GitRevertResponse revert(String file, boolean staged, GitDiffResponse diff) {
    return service.revert(
        root, "fixture", new GitRevertRequest(file, staged, diff.revert().revision()));
  }

  private void stagedAndWorking() throws Exception {
    write("tracked.txt", "INDEX\n");
    git("add", "--", "tracked.txt");
    write("tracked.txt", "WORKING\n");
  }

  private void write(String file, String value) throws Exception {
    Files.writeString(root.resolve(file), value);
  }

  private String git(String... args) {
    var values =
        new ArrayList<>(
            List.of(
                "--literal-pathspecs",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgSign=false",
                "-C",
                root.toString()));
    values.addAll(List.of(args));
    return commands.run("git", values, null, Duration.ofSeconds(15)).stdout();
  }
}
