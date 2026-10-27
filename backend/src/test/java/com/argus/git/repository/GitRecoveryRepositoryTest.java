package com.argus.git.repository;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class GitRecoveryRepositoryTest {
  @TempDir Path temporary;

  @Test
  void retentionKeepsNewestFiftyAndPurgeDoesNotCrossRepositoryBoundary() throws Exception {
    var repository =
        new GitRecoveryRepository(
            new ArgusProperties(temporary, temporary, "fixture", ""),
            new AtomicJsonStore(new ObjectMapper()));
    String other =
        repository.save(Map.of("repositoryId", "other"), new byte[] {0, 1, 2}, new byte[0], null);
    String first = "", last = "";
    for (int index = 0; index < 51; index++) {
      last =
          repository.save(
              Map.of("repositoryId", "selected"), new byte[] {(byte) index}, new byte[0], null);
      if (index == 0) first = last;
    }
    Path root = temporary.resolve("git-recovery");
    try (var entries = Files.list(root)) {
      assertThat(entries.count()).isEqualTo(51);
    }
    assertThat(Files.exists(root.resolve(first))).isFalse();
    assertThat(Files.exists(root.resolve(last))).isTrue();
    assertThat(Files.readAllBytes(root.resolve(other).resolve("before-content.bin")))
        .isEqualTo(new byte[] {0, 1, 2});
    assertThat(repository.purgeRepositories(List.of("selected"))).isEqualTo(50);
    assertThat(Files.exists(root.resolve(other))).isTrue();
    assertThat(repository.purgeRepositories(List.of("selected"))).isZero();
  }

  @Test
  void refusesSymlinkRecoveryRootAndDoesNotWriteOutsideAppData() throws Exception {
    Path outside = Files.createDirectory(temporary.resolve("outside")),
        data = Files.createDirectory(temporary.resolve("data"));
    Files.createSymbolicLink(data.resolve("git-recovery"), outside);
    var repository =
        new GitRecoveryRepository(
            new ArgusProperties(data, temporary, "fixture", ""),
            new AtomicJsonStore(new ObjectMapper()));
    assertThatThrownBy(
            () ->
                repository.save(Map.of("repositoryId", "selected"), new byte[0], new byte[0], null))
        .hasMessageContaining("nothing was reverted");
    assertThatThrownBy(
            () ->
                repository.saveBatch(
                    Map.of("repositoryId", "selected"),
                    List.of(
                        new GitRecoveryRepository.Backup(
                            Map.of("file", "fixture"), new byte[0], new byte[0])),
                    new byte[0]))
        .hasMessageContaining("nothing was reverted");
    try (var files = Files.list(outside)) {
      assertThat(files.count()).isZero();
    }
  }

  @Test
  @SuppressWarnings("unchecked")
  void bulkBackupIsOneRetentionUnitWithEveryFileAndOriginalIndexRecoverable() throws Exception {
    var json = new AtomicJsonStore(new ObjectMapper());
    var repository =
        new GitRecoveryRepository(new ArgusProperties(temporary, temporary, "fixture", ""), json);
    for (int index = 0; index < 50; index++)
      repository.save(
          Map.of("repositoryId", "selected"), new byte[] {(byte) index}, new byte[0], null);
    var files =
        List.of(
            new GitRecoveryRepository.Backup(
                Map.of("file", "nested/file.txt", "staged", false),
                new byte[] {1, 2},
                new byte[] {3}),
            new GitRecoveryRepository.Backup(
                Map.of("file", "another.txt", "staged", true), new byte[] {4, 5}, new byte[] {6}));
    String id =
        repository.saveBatch(Map.of("repositoryId", "selected"), files, new byte[] {7, 8, 9});
    Path saved = Path.of(repository.location(id));
    assertThat(Files.readAllBytes(saved.resolve("file-0-before-content.bin")))
        .containsExactly(1, 2);
    assertThat(Files.readAllBytes(saved.resolve("file-1-before-content.bin")))
        .containsExactly(4, 5);
    assertThat(Files.readAllBytes(saved.resolve("file-0-baseline-content.bin"))).containsExactly(3);
    assertThat(Files.readAllBytes(saved.resolve("file-1-baseline-content.bin"))).containsExactly(6);
    assertThat(Files.readAllBytes(saved.resolve("before-index.bin"))).containsExactly(7, 8, 9);
    Map<String, Object> receipt = json.read(saved.resolve("receipt.json"), Map.class);
    assertThat(receipt).containsEntry("status", "prepared");
    var manifestFiles = (List<Map<String, Object>>) receipt.get("files");
    assertThat(manifestFiles).hasSize(2);
    assertThat(manifestFiles.get(0))
        .containsEntry("file", "nested/file.txt")
        .containsEntry("beforeContent", "file-0-before-content.bin");
    try (var entries = Files.list(Path.of(repository.directory()))) {
      assertThat(entries.count()).isEqualTo(50);
    }
    repository.markBatchResult(
        id, false, List.of(Map.of("file", "nested/file.txt", "status", "reverted")));
    assertThat((Map<String, Object>) json.read(saved.resolve("receipt.json"), Map.class))
        .containsEntry("status", "incomplete");
    assertThat(Files.readAllBytes(saved.resolve("file-1-before-content.bin")))
        .containsExactly(4, 5);
  }

  @Test
  void rejectsOversizedBulkRecoveryBeforeCreatingAnyArtifact() throws Exception {
    var repository =
        new GitRecoveryRepository(
            new ArgusProperties(temporary, temporary, "fixture", ""),
            new AtomicJsonStore(new ObjectMapper()));
    var file =
        new GitRecoveryRepository.Backup(Map.of("file", "fixture"), new byte[0], new byte[0]);
    assertThatThrownBy(
            () -> repository.saveBatch(Map.of(), Collections.nCopies(26, file), new byte[0]))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> repository.saveBatch(Map.of(), List.of(), new byte[0]))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> repository.saveBatch(Map.of(), List.of(file), null))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(Files.exists(Path.of(repository.directory()))).isFalse();
  }
}
