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
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

class GitBulkRevertServiceTest {
  @TempDir Path temporary;
  private Path root;
  private LocalCommandRunner commands;
  private GitRecoveryRepository recovery;
  private GitFileRevertService service;
  private AtomicJsonStore json;

  @BeforeEach
  void setup() throws Exception {
    root = Files.createDirectory(temporary.resolve("repo"));
    commands = new LocalCommandRunner();
    json = new AtomicJsonStore(new ObjectMapper());
    recovery =
        spy(
            new GitRecoveryRepository(
                new ArgusProperties(temporary.resolve("data"), temporary, "fixture", ""), json));
    service = new GitFileRevertService(commands, recovery);
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Argus Fixture");
    git("config", "user.email", "fixture@example.invalid");
    for (String file : List.of("one.txt", "two.txt", "other.txt")) write(file, file + " HEAD\n");
    git("add", "--", "one.txt", "two.txt", "other.txt");
    git("commit", "-q", "-m", "fixture");
  }

  @Test
  @SuppressWarnings("unchecked")
  void mixedViewsPreserveTheOtherViewAndUnrelatedFilesWithOneCompleteRecoveryReceipt()
      throws Exception {
    mixedChanges();
    byte[] originalIndex = Files.readAllBytes(root.resolve(".git/index"));
    var preview = preview(file("one.txt", false), file("two.txt", true));
    assertThat(preview.allowed()).isTrue();
    assertThat(preview.maxFiles()).isEqualTo(25);
    assertThat(preview.files())
        .extracting(GitBulkRevertPreview.File::baseline)
        .containsExactly("index", "HEAD");
    var result = service.bulkRevert(root, "repo", applyRequest(preview));
    assertThat(result.ok()).isTrue();
    assertThat(result.partial()).isFalse();
    assertThat(result.refreshRequired()).isTrue();
    assertThat(result.results())
        .extracting(GitBulkRevertResponse.Result::status)
        .containsOnly("reverted");
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("one INDEX\n");
    assertThat(git("show", ":one.txt")).isEqualTo("one INDEX\n");
    assertThat(Files.readString(root.resolve("two.txt"))).isEqualTo("two WORKING\n");
    assertThat(git("show", ":two.txt")).isEqualTo("two.txt HEAD\n");
    assertThat(Files.readString(root.resolve("other.txt"))).isEqualTo("other WORKING\n");
    assertThat(git("show", ":other.txt")).isEqualTo("other INDEX\n");
    assertThat(result.recoveryPaths()).hasSize(1);
    Path saved = Path.of(result.recoveryPaths().get(0));
    assertThat(Files.readAllBytes(saved.resolve("before-index.bin"))).isEqualTo(originalIndex);
    assertThat(Files.readString(saved.resolve("file-0-before-content.bin")))
        .isEqualTo("one WORKING\n");
    assertThat(Files.readString(saved.resolve("file-0-baseline-content.bin")))
        .isEqualTo("one INDEX\n");
    assertThat(Files.readString(saved.resolve("file-1-before-content.bin")))
        .isEqualTo("two INDEX\n");
    assertThat(Files.readString(saved.resolve("file-1-baseline-content.bin")))
        .isEqualTo("two.txt HEAD\n");
    assertThat(Files.getPosixFilePermissions(saved))
        .isEqualTo(PosixFilePermissions.fromString("rwx------"));
    assertThat(Files.getPosixFilePermissions(saved.resolve("before-index.bin")))
        .isEqualTo(PosixFilePermissions.fromString("rw-------"));
    Map<String, Object> receipt = json.read(saved.resolve("receipt.json"), Map.class);
    assertThat(receipt)
        .containsEntry("status", "restored")
        .containsEntry("operation", "bulk-revert");
    assertThat((List<?>) receipt.get("files")).hasSize(2);
    assertThat(Files.exists(root.resolve(".git/index.lock"))).isFalse();
    try (var entries = Files.list(root.resolve(".git"))) {
      assertThat(entries.map(path -> path.getFileName().toString()))
          .noneMatch(name -> name.startsWith("argus-bulk-revert"));
    }
  }

  @Test
  void multipleStagedSelectionsAreRestoredTogetherWithoutTouchingWorkingFiles() throws Exception {
    mixedChanges();
    var result =
        service.bulkRevert(
            root, "repo", applyRequest(preview(file("one.txt", true), file("two.txt", true))));
    assertThat(result.ok()).isTrue();
    for (String name : List.of("one", "two")) {
      assertThat(git("show", ":" + name + ".txt")).isEqualTo(name + ".txt HEAD\n");
      assertThat(Files.readString(root.resolve(name + ".txt"))).isEqualTo(name + " WORKING\n");
    }
    assertThat(git("show", ":other.txt")).isEqualTo("other INDEX\n");
  }

  @Test
  void oneStaleItemRejectsEveryItemBeforeBackupOrMutation() throws Exception {
    mixedChanges();
    var request = applyRequest(preview(file("one.txt", false), file("two.txt", false)));
    byte[] originalIndex = Files.readAllBytes(root.resolve(".git/index"));
    write("two.txt", "new external edit\n");
    assertThatThrownBy(() -> service.bulkRevert(root, "repo", request))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("one WORKING\n");
    assertThat(Files.readString(root.resolve("two.txt"))).isEqualTo("new external edit\n");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(originalIndex);
    verify(recovery, never()).saveBatch(anyMap(), anyList(), any());
  }

  @Test
  void allItemsAreCheckedAgainAfterEveryBackupIsDurable() throws Exception {
    mixedChanges();
    var request = applyRequest(preview(file("one.txt", false), file("two.txt", false)));
    var saved = new ArrayList<String>();
    doAnswer(
            invocation -> {
              String id = (String) invocation.callRealMethod();
              saved.add(id);
              write("two.txt", "edited during backup\n");
              return id;
            })
        .when(recovery)
        .saveBatch(anyMap(), anyList(), any());
    assertThatThrownBy(() -> service.bulkRevert(root, "repo", request))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("one WORKING\n");
    assertThat(Files.readString(root.resolve("two.txt"))).isEqualTo("edited during backup\n");
    assertThat(
            Files.readString(
                Path.of(recovery.location(saved.get(0))).resolve("file-1-before-content.bin")))
        .isEqualTo("two WORKING\n");
    assertThat(Files.exists(root.resolve(".git/index.lock"))).isFalse();
  }

  @Test
  void backupFailureAndIndexLockContentionNeverMutateAnyFile() throws Exception {
    mixedChanges();
    var request = applyRequest(preview(file("one.txt", false), file("two.txt", true)));
    byte[] originalIndex = Files.readAllBytes(root.resolve(".git/index"));
    Path lock = root.resolve(".git/index.lock");
    Files.writeString(lock, "owned by another process");
    assertThatThrownBy(() -> service.bulkRevert(root, "repo", request))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("busy");
    assertThat(Files.readString(lock)).isEqualTo("owned by another process");
    verify(recovery, never()).saveBatch(anyMap(), anyList(), any());
    Files.delete(lock);
    doThrow(new IllegalStateException("synthetic recovery failure"))
        .when(recovery)
        .saveBatch(anyMap(), anyList(), any());
    assertThatThrownBy(() -> service.bulkRevert(root, "repo", request))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("recovery failure");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(originalIndex);
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("one WORKING\n");
    assertThat(Files.readString(root.resolve("two.txt"))).isEqualTo("two WORKING\n");
    assertThat(Files.exists(lock)).isFalse();
  }

  @Test
  @SuppressWarnings("unchecked")
  void midBatchExternalEditStopsRemainingWritesAndReportsExactPartialProgress() throws Exception {
    mixedChanges();
    var request =
        applyRequest(
            preview(file("one.txt", false), file("two.txt", false), file("other.txt", true)));
    byte[] originalIndex = Files.readAllBytes(root.resolve(".git/index"));
    var injected = new AtomicBoolean();
    service =
        new GitFileRevertService(
            (executable, arguments, directory, timeout) -> {
              try {
                if (arguments.contains("ls-files")
                    && arguments.contains("two.txt")
                    && Files.readString(root.resolve("one.txt")).equals("one INDEX\n")
                    && injected.compareAndSet(false, true))
                  write("two.txt", "concurrent edit must survive\n");
              } catch (Exception error) {
                throw new IllegalStateException(error);
              }
              return commands.run(executable, arguments, directory, timeout);
            },
            recovery);
    var result = service.bulkRevert(root, "repo", request);
    assertThat(injected).isTrue();
    assertThat(result.ok()).isFalse();
    assertThat(result.partial()).isTrue();
    assertThat(result.results())
        .extracting(GitBulkRevertResponse.Result::status)
        .containsExactly("reverted", "failed", "not-applied");
    assertThat(result.message()).contains("some files").doesNotContain("nothing");
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("one INDEX\n");
    assertThat(Files.readString(root.resolve("two.txt")))
        .isEqualTo("concurrent edit must survive\n");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(originalIndex);
    Path saved = Path.of(result.recoveryPaths().get(0));
    assertThat(Files.readString(saved.resolve("file-0-before-content.bin")))
        .isEqualTo("one WORKING\n");
    assertThat(Files.readString(saved.resolve("file-1-before-content.bin")))
        .isEqualTo("two WORKING\n");
    assertThat(Files.readAllBytes(saved.resolve("before-index.bin"))).isEqualTo(originalIndex);
    Map<String, Object> receipt = json.read(saved.resolve("receipt.json"), Map.class);
    assertThat(receipt).containsEntry("status", "incomplete");
    assertThat((List<?>) receipt.get("results")).hasSize(3);
  }

  @Test
  void receiptRefreshFailureDoesNotMisreportCommittedChangesAsFailed() throws Exception {
    mixedChanges();
    var request = applyRequest(preview(file("one.txt", false), file("two.txt", true)));
    doThrow(new IllegalStateException("synthetic receipt update failure"))
        .when(recovery)
        .markBatchResult(anyString(), anyBoolean(), anyList());
    var result = service.bulkRevert(root, "repo", request);
    assertThat(result.ok()).isTrue();
    assertThat(result.results())
        .extracting(GitBulkRevertResponse.Result::status)
        .containsOnly("reverted");
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("one INDEX\n");
    assertThat(git("show", ":two.txt")).isEqualTo("two.txt HEAD\n");
    assertThat(Files.exists(Path.of(result.recoveryPaths().get(0)).resolve("before-index.bin")))
        .isTrue();
  }

  @Test
  void deletedTrackedFilesAreRestoredOnlyInTheSelectedView() throws Exception {
    Files.delete(root.resolve("one.txt"));
    git("rm", "--", "two.txt");
    var result =
        service.bulkRevert(
            root, "repo", applyRequest(preview(file("one.txt", false), file("two.txt", true))));
    assertThat(result.ok()).isTrue();
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("one.txt HEAD\n");
    assertThat(Files.exists(root.resolve("two.txt"))).isFalse();
    assertThat(git("show", ":two.txt")).isEqualTo("two.txt HEAD\n");
  }

  @ParameterizedTest
  @ValueSource(strings = {"untracked", "new-staged", "symlink", "binary", "conflict", "rename"})
  void unsupportedSelectionMakesWholePreviewUnavailableAndApplyCannotMutate(String kind)
      throws Exception {
    write("one.txt", "one changed\n");
    String selected = "two.txt";
    boolean staged = false;
    switch (kind) {
      case "untracked" -> {
        selected = "new.txt";
        write(selected, "untracked\n");
      }
      case "new-staged" -> {
        selected = "new.txt";
        staged = true;
        write(selected, "new\n");
        git("add", "--", selected);
      }
      case "symlink" -> {
        Files.delete(root.resolve(selected));
        Files.createSymbolicLink(root.resolve(selected), Path.of("one.txt"));
      }
      case "binary" -> Files.write(root.resolve(selected), new byte[] {0, 1, 2});
      case "conflict" -> {
        git("switch", "-q", "-c", "other");
        write(selected, "other branch\n");
        git("commit", "-am", "other");
        git("switch", "-q", "main");
        write(selected, "main branch\n");
        git("commit", "-am", "main");
        try {
          git("merge", "other");
        } catch (RuntimeException expected) {
          /* intentional fixture conflict */
        }
        write("one.txt", "one changed\n");
      }
      case "rename" -> {
        git("mv", "--", selected, "renamed.txt");
        selected = "renamed.txt";
        staged = true;
      }
      default -> throw new AssertionError(kind);
    }
    byte[] index = Files.readAllBytes(root.resolve(".git/index"));
    var preview = preview(file("one.txt", false), file(selected, staged));
    assertThat(preview.allowed()).isFalse();
    assertThat(preview.files().get(1).allowed()).isFalse();
    assertThatThrownBy(() -> service.bulkRevert(root, "repo", applyRequest(preview)))
        .isInstanceOf(ResponseStatusException.class);
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("one changed\n");
    assertThat(Files.readAllBytes(root.resolve(".git/index"))).isEqualTo(index);
    verify(recovery, never()).saveBatch(anyMap(), anyList(), any());
  }

  @Test
  void rejectsEmptyOversizedDuplicateAndIncompleteRequestsBeforeMutation() throws Exception {
    write("one.txt", "changed\n");
    assertThatThrownBy(() -> service.bulkRevertPreview(root, new GitBulkRevertRequest(List.of())))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                service.bulkRevertPreview(
                    root,
                    new GitBulkRevertRequest(Collections.nCopies(26, file("one.txt", false)))))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> preview(file("one.txt", false), file("./one.txt", true)))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("once");
    assertThatThrownBy(() -> preview(new GitBulkRevertRequest.File("one.txt", null, null)))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                service.bulkRevert(
                    root, "repo", new GitBulkRevertRequest(List.of(file("one.txt", false)))))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("revision");
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("changed\n");
    verifyNoInteractions(recovery);
  }

  @ParameterizedTest
  @ValueSource(
      strings = {"../outside.txt", ".git/config", ".", "/tmp/outside.txt", "linked/one.txt"})
  void rejectsEscapesMetadataAndSymlinkParents(String path) throws Exception {
    Files.createSymbolicLink(root.resolve("linked"), temporary);
    assertThatThrownBy(() -> preview(file(path, false)))
        .isInstanceOf(IllegalArgumentException.class);
    verifyNoInteractions(recovery);
  }

  @Test
  void retiredRepositoryCannotBeginBulkMutation() throws Exception {
    write("one.txt", "changed\n");
    var request = applyRequest(preview(file("one.txt", false)));
    service.disconnectRepositories(List.of("repo"));
    assertThatThrownBy(() -> service.bulkRevert(root, "repo", request))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("one.txt"))).isEqualTo("changed\n");
    verify(recovery, never()).saveBatch(anyMap(), anyList(), any());
  }

  private GitBulkRevertRequest.File file(String path, boolean staged) {
    return new GitBulkRevertRequest.File(path, staged);
  }

  private GitBulkRevertPreview preview(GitBulkRevertRequest.File... files) {
    return service.bulkRevertPreview(root, new GitBulkRevertRequest(List.of(files)));
  }

  private GitBulkRevertRequest applyRequest(GitBulkRevertPreview preview) {
    return new GitBulkRevertRequest(
        preview.files().stream()
            .map(file -> new GitBulkRevertRequest.File(file.file(), file.staged(), file.revision()))
            .toList());
  }

  private void mixedChanges() throws Exception {
    for (String name : List.of("one", "two", "other")) write(name + ".txt", name + " INDEX\n");
    git("add", "--", "one.txt", "two.txt", "other.txt");
    for (String name : List.of("one", "two", "other")) write(name + ".txt", name + " WORKING\n");
  }

  private void write(String file, String value) throws Exception {
    Files.writeString(root.resolve(file), value);
  }

  private String git(String... args) {
    var command = new ArrayList<>(List.of("-C", root.toString()));
    command.addAll(List.of(args));
    return commands.run("git", command, null, Duration.ofSeconds(20)).stdout();
  }
}
