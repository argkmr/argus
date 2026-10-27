package com.argus.git.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.process.CommandResult;
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
import tools.jackson.databind.ObjectMapper;

class GitFileActionServiceTest {
  @TempDir Path temporary;
  Path root, data;
  LocalCommandRunner commands;
  GitRecoveryRepository recovery;
  GitFileRevertService service;

  @BeforeEach
  void setup() throws Exception {
    root = Files.createDirectory(temporary.resolve("repo"));
    data = temporary.resolve("data");
    commands = new LocalCommandRunner();
    recovery =
        spy(
            new GitRecoveryRepository(
                new ArgusProperties(data, temporary, "fixture", ""),
                new AtomicJsonStore(new ObjectMapper())));
    service = new GitFileRevertService(commands, recovery);
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    write("tracked.txt", "HEAD\n");
    write("other.txt", "KEEP\n");
    git("add", ".");
    git("commit", "-qm", "fixture");
  }

  String git(String... args) {
    var all = new ArrayList<>(List.of("--literal-pathspecs", "-C", root.toString()));
    all.addAll(List.of(args));
    return commands.run("git", all, null, Duration.ofSeconds(15)).stdout();
  }

  void write(String path, String content) throws Exception {
    Files.writeString(root.resolve(path), content);
  }

  GitFileActionPreview preview(String file, String action) {
    return service.fileActionPreview(root, file, action);
  }

  GitFileActionResponse apply(GitFileActionPreview preview) {
    return service.fileAction(
        root,
        "fixture",
        preview.action(),
        new GitFileActionRequest(preview.file(), preview.revision()));
  }

  Path receipt(GitFileActionResponse result) {
    return Path.of(result.recoveryPaths().get(0));
  }

  @Test
  void deletesOnlyInspectedUntrackedFileAndKeepsDurableExactRecovery() throws Exception {
    write("new file.txt", "not committed\n");
    write("other.txt", "KEEP changed\n");
    byte[] index = Files.readAllBytes(root.resolve(".git/index"));
    var preview = preview("new file.txt", "delete");
    assertThat(preview.allowed()).isTrue();
    assertThat(preview.staged()).isFalse();
    assertThat(preview.recoveryDirectory()).isEqualTo(data.resolve("git-recovery").toString());
    var result = apply(preview);
    assertThat(result.ok()).isTrue();
    assertThat(result.refreshRequired()).isFalse();
    assertThat(root.resolve("new file.txt")).doesNotExist();
    assertThat(Files.readString(root.resolve("other.txt"))).isEqualTo("KEEP changed\n");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(index);
    assertThat(Files.readString(receipt(result).resolve("before-content.bin")))
        .isEqualTo("not committed\n");
    assertThat(Files.readString(receipt(result).resolve("receipt.json")))
        .contains("delete-new-file", "new file.txt", "\"deleted\"", "deletedAt");
    assertThat(root.resolve(".git/index.lock")).doesNotExist();
    try (var paths = Files.list(root)) {
      assertThat(paths.map(path -> path.getFileName().toString()).toList())
          .noneMatch(path -> path.startsWith(".argus-delete-"));
    }
  }

  @Test
  void stagedNewFileDeletionPreservesBothVersionsAndUnrelatedIndexEntries() throws Exception {
    write("new.txt", "INDEX addition\n");
    git("add", "new.txt");
    write("new.txt", "WORKING addition\n");
    write("other.txt", "OTHER staged\n");
    git("add", "other.txt");
    byte[] index = Files.readAllBytes(root.resolve(".git/index"));
    var preview = preview("new.txt", "delete");
    assertThat(preview.staged()).isTrue();
    var result = apply(preview);
    assertThat(root.resolve("new.txt")).doesNotExist();
    assertThat(git("ls-files", "--", "new.txt")).isEmpty();
    assertThat(git("show", ":other.txt")).isEqualTo("OTHER staged\n");
    assertThat(Files.readString(receipt(result).resolve("before-content.bin")))
        .isEqualTo("WORKING addition\n");
    assertThat(Files.readString(receipt(result).resolve("baseline-content.bin")))
        .isEqualTo("INDEX addition\n");
    assertThat(Files.readAllBytes(receipt(result).resolve("before-index.bin"))).isEqualTo(index);
  }

  @Test
  void deletedWorkingCopyOfStagedAdditionCanBeRemovedFromIndex() throws Exception {
    write("new.txt", "staged only\n");
    git("add", "new.txt");
    Files.delete(root.resolve("new.txt"));
    var preview = preview("new.txt", "delete");
    assertThat(preview.allowed()).isTrue();
    assertThat(preview.workingFileExists()).isFalse();
    var result = apply(preview);
    assertThat(git("ls-files", "--", "new.txt")).isEmpty();
    assertThat(Files.readString(receipt(result).resolve("baseline-content.bin")))
        .isEqualTo("staged only\n");
  }

  @Test
  void binaryNewFileIsCopiedExactlyAndLiteralPathspecNeverMatchesOtherFiles() throws Exception {
    byte[] bytes = new byte[] {0, 1, 2, (byte) 0xff, 13, 10};
    Files.write(root.resolve(":(glob)*"), bytes);
    write("also-new.txt", "KEEP");
    var result = apply(preview(":(glob)*", "delete"));
    assertThat(root.resolve(":(glob)*")).doesNotExist();
    assertThat(root.resolve("also-new.txt")).exists();
    assertThat(Files.readAllBytes(receipt(result).resolve("before-content.bin"))).isEqualTo(bytes);
  }

  @Test
  void unbornRepositoryWithNoIndexSupportsSafeUntrackedDeletion() throws Exception {
    root = Files.createDirectory(temporary.resolve("unborn"));
    git("init", "-q");
    write("new.txt", "new");
    assertThat(root.resolve(".git/index")).doesNotExist();
    apply(preview("new.txt", "delete"));
    assertThat(root.resolve("new.txt")).doesNotExist();
    assertThat(root.resolve(".git/index")).doesNotExist();
    assertThat(root.resolve(".git/index.lock")).doesNotExist();
  }

  @Test
  void unbornStagedAdditionCanBeDeletedWithoutHead() throws Exception {
    root = Files.createDirectory(temporary.resolve("unborn"));
    git("init", "-q");
    write("new.txt", "new");
    git("add", "new.txt");
    apply(preview("new.txt", "delete"));
    assertThat(git("ls-files")).isEmpty();
    assertThat(root.resolve("new.txt")).doesNotExist();
  }

  @Test
  void staleWorkingIndexOrHeadChangesCannotDelete() throws Exception {
    write("new.txt", "first");
    var first = preview("new.txt", "delete");
    write("new.txt", "newer");
    assertThatThrownBy(() -> apply(first)).isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("new.txt"))).isEqualTo("newer");
    var second = preview("new.txt", "delete");
    git("add", "new.txt");
    assertThatThrownBy(() -> apply(second)).isInstanceOf(ConflictException.class);
    var third = preview("new.txt", "delete");
    git("commit", "--allow-empty", "-qm", "moved HEAD");
    assertThatThrownBy(() -> apply(third)).isInstanceOf(ConflictException.class);
    assertThat(root.resolve("new.txt")).exists();
    assertThat(data.resolve("git-recovery")).doesNotExist();
  }

  @Test
  void concurrentModificationAfterBackupAbortsAndKeepsTheNewestFile() throws Exception {
    write("new.txt", "old");
    git("add", "new.txt");
    var preview = preview("new.txt", "delete");
    byte[] index = Files.readAllBytes(root.resolve(".git/index"));
    doAnswer(
            invocation -> {
              var id = invocation.callRealMethod();
              write("new.txt", "new external change");
              return id;
            })
        .when(recovery)
        .save(anyMap(), any(), any(), any());
    assertThatThrownBy(() -> apply(preview)).isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("new.txt"))).isEqualTo("new external change");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(index);
    assertThat(root.resolve(".git/index.lock")).doesNotExist();
  }

  @Test
  void finalHeadConflictRestoresQuarantinedFileWithoutChangingIndex() throws Exception {
    write("new.txt", "confirmed original");
    git("add", "new.txt");
    byte[] index = Files.readAllBytes(root.resolve(".git/index"));
    var preview = preview("new.txt", "delete");
    service = finalDeletionCheck(() -> {}, true);
    assertThatThrownBy(() -> apply(preview)).isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("new.txt"))).isEqualTo("confirmed original");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(index);
    assertThat(root.resolve(".git/index.lock")).doesNotExist();
    try (var paths = Files.list(root)) {
      assertThat(paths.map(path -> path.getFileName().toString()).toList())
          .noneMatch(path -> path.startsWith(".argus-delete-"));
    }
  }

  @Test
  void finalHeadConflictNeverOverwritesNewFileCreatedAtQuarantinedPath() throws Exception {
    write("new.txt", "confirmed original");
    git("add", "new.txt");
    byte[] index = Files.readAllBytes(root.resolve(".git/index"));
    var preview = preview("new.txt", "delete");
    service = finalDeletionCheck(() -> write("new.txt", "newly created external content"), true);
    assertThatThrownBy(() -> apply(preview))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("current path was not overwritten")
        .hasMessageContaining("original is preserved at")
        .hasMessageContaining("Recovery:");
    assertThat(Files.readString(root.resolve("new.txt")))
        .isEqualTo("newly created external content");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(index);
    assertThat(root.resolve(".git/index.lock")).doesNotExist();
    try (var paths = Files.list(root)) {
      Path retained =
          paths
              .filter(path -> path.getFileName().toString().startsWith(".argus-delete-"))
              .findFirst()
              .orElseThrow();
      assertThat(Files.readString(retained.resolve("original"))).isEqualTo("confirmed original");
    }
  }

  @Test
  void successfulDeletionRetainsConcurrentReplacementAndReportsItExplicitly() throws Exception {
    write("new.txt", "confirmed original");
    git("add", "new.txt");
    var preview = preview("new.txt", "delete");
    service = finalDeletionCheck(() -> write("new.txt", "newly created external content"), false);
    var result = apply(preview);
    assertThat(result.ok()).isTrue();
    assertThat(result.refreshRequired()).isTrue();
    assertThat(result.message()).contains("newer file", "kept");
    assertThat(git("ls-files", "--", "new.txt")).isEmpty();
    assertThat(Files.readString(root.resolve("new.txt")))
        .isEqualTo("newly created external content");
    assertThat(Files.readString(receipt(result).resolve("before-content.bin")))
        .isEqualTo("confirmed original");
  }

  private GitFileRevertService finalDeletionCheck(AfterMove action, boolean changedHead) {
    return new GitFileRevertService(
        (executable, arguments, cwd, timeout) -> {
          if (arguments.contains("HEAD^{commit}")) {
            try (var paths = Files.list(root)) {
              if (paths.anyMatch(
                  path -> path.getFileName().toString().startsWith(".argus-delete-"))) {
                action.run();
                if (changedHead) return new CommandResult("0".repeat(40), "", 0);
              }
            } catch (Exception error) {
              throw new IllegalStateException(error);
            }
          }
          return commands.run(executable, arguments, cwd, timeout);
        },
        recovery);
  }

  @FunctionalInterface
  private interface AfterMove {
    void run() throws Exception;
  }

  @Test
  void trackedIgnoredFoldersSymlinksRenamesAndMetadataAreNeverDeleted() throws Exception {
    assertThat(preview("tracked.txt", "delete").allowed()).isFalse();
    write(".gitignore", "ignored.txt\n");
    write("ignored.txt", "secret");
    assertThat(preview("ignored.txt", "delete").allowed()).isFalse();
    Files.createDirectory(root.resolve("folder"));
    assertThat(preview("folder", "delete").allowed()).isFalse();
    Files.createSymbolicLink(root.resolve("link.txt"), Path.of("tracked.txt"));
    assertThat(preview("link.txt", "delete").allowed()).isFalse();
    Files.createSymbolicLink(root.resolve("linked"), temporary);
    assertThatThrownBy(() -> preview("linked/outside.txt", "delete"))
        .isInstanceOf(IllegalArgumentException.class);
    git("mv", "tracked.txt", "renamed.txt");
    assertThat(preview("renamed.txt", "delete").allowed()).isFalse();
    for (String path :
        List.of("../outside", ".git/config", ".GIT/config", root.resolve("other.txt").toString()))
      assertThatThrownBy(() -> preview(path, "delete"))
          .isInstanceOf(IllegalArgumentException.class);
    assertThat(root.resolve("ignored.txt")).exists();
    assertThat(root.resolve("renamed.txt")).exists();
  }

  @Test
  void recoveryFailureOrBusyIndexCannotDeleteAnything() throws Exception {
    write("new.txt", "keep");
    var preview = preview("new.txt", "delete");
    Files.writeString(root.resolve(".git/index.lock"), "another process");
    assertThatThrownBy(() -> apply(preview)).isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve(".git/index.lock"))).isEqualTo("another process");
    Files.delete(root.resolve(".git/index.lock"));
    doThrow(new IllegalStateException("No recovery space"))
        .when(recovery)
        .save(anyMap(), any(), any(), any());
    assertThatThrownBy(() -> apply(preview)).hasMessageContaining("No recovery space");
    assertThat(Files.readString(root.resolve("new.txt"))).isEqualTo("keep");
    assertThat(root.resolve(".git/index.lock")).doesNotExist();
  }

  @Test
  void fullRevertRestoresOnlyOneFilesStagedAndWorkingChangesToHead() throws Exception {
    write("tracked.txt", "INDEX\n");
    git("add", "tracked.txt");
    write("tracked.txt", "WORK\n");
    write("other.txt", "OTHER INDEX\n");
    git("add", "other.txt");
    write("other.txt", "OTHER WORK\n");
    var preview = preview("tracked.txt", "revert");
    assertThat(preview.allowed()).isTrue();
    assertThat(preview.staged()).isTrue();
    var result = apply(preview);
    assertThat(result.recoveryIds()).hasSize(2);
    assertThat(result.refreshRequired()).isFalse();
    assertThat(git("show", ":tracked.txt")).isEqualTo("HEAD\n");
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("HEAD\n");
    assertThat(git("show", ":other.txt")).isEqualTo("OTHER INDEX\n");
    assertThat(Files.readString(root.resolve("other.txt"))).isEqualTo("OTHER WORK\n");
  }

  @Test
  void fullRevertRestoresStagedDeletionAndRefusesCleanOrNewFiles() throws Exception {
    assertThat(preview("tracked.txt", "revert").allowed()).isFalse();
    write("new.txt", "new");
    assertThat(preview("new.txt", "revert").allowed()).isFalse();
    git("rm", "tracked.txt");
    var result = apply(preview("tracked.txt", "revert"));
    assertThat(result.ok()).isTrue();
    assertThat(git("show", ":tracked.txt")).isEqualTo("HEAD\n");
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("HEAD\n");
  }

  @Test
  void fullRevertRejectsStaleConfirmationAndPreservesConcurrentWorkBetweenPhases()
      throws Exception {
    write("tracked.txt", "INDEX\n");
    git("add", "tracked.txt");
    write("tracked.txt", "WORK\n");
    var stale = preview("tracked.txt", "revert");
    write("tracked.txt", "newer\n");
    assertThatThrownBy(() -> apply(stale)).isInstanceOf(ConflictException.class);
    var preview = preview("tracked.txt", "revert");
    doAnswer(
            invocation -> {
              var id = invocation.callRealMethod();
              write("tracked.txt", "EXTERNAL NEW WORK\n");
              return id;
            })
        .when(recovery)
        .save(anyMap(), any(), any(), any());
    var result = apply(preview);
    assertThat(result.refreshRequired()).isTrue();
    assertThat(result.recoveryIds()).hasSize(1);
    assertThat(result.message()).contains("staged part", "working file was kept");
    assertThat(Files.readString(root.resolve("tracked.txt"))).isEqualTo("EXTERNAL NEW WORK\n");
    assertThat(git("show", ":tracked.txt")).isEqualTo("HEAD\n");
  }

  @Test
  void retirementAndInvalidOrReplayedTokensCannotMutateNewFiles() throws Exception {
    write("new.txt", "new");
    var preview = preview("new.txt", "delete");
    assertThatThrownBy(
            () ->
                service.fileAction(
                    root, "fixture", "delete", new GitFileActionRequest("new.txt", "forged")))
        .isInstanceOf(IllegalArgumentException.class);
    service.purgeRepositories(List.of("fixture"));
    assertThatThrownBy(() -> apply(preview)).isInstanceOf(ConflictException.class);
    service.releaseRetiredRepositories(List.of("fixture"));
    apply(preview);
    assertThatThrownBy(() -> apply(preview)).isInstanceOf(ConflictException.class);
  }
}
