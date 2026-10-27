package com.argus.git.service;

import static org.assertj.core.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class GitDiffBlocksTest {
  @Test
  void byteMismatchesAndUnreportedChangesCannotReceiveBlockIds() {
    String patch = "@@ -1,3 +1,3 @@\n-a\n+A\n keep\n z\n";
    assertThat(
            GitDiffBlocks.changes("revision", patch, bytes("a\nkeep\nz\n"), bytes("A\nkeep\nz\n")))
        .hasSize(1);
    assertThat(
            GitDiffBlocks.changes(
                "revision", patch, bytes("a\nkeep\nz\n"), bytes("OTHER\nkeep\nz\n")))
        .isEmpty();
    assertThat(
            GitDiffBlocks.changes(
                "revision", patch, bytes("a\nkeep\nz\n"), bytes("A\nkeep\nUNREPORTED\n")))
        .isEmpty();
    assertThat(
            GitDiffBlocks.changes(
                "revision", patch, bytes("a\nkeep\nz\n"), bytes("A\r\nkeep\r\nz\r\n")))
        .isEmpty();
  }

  @Test
  void emptySidesUseOneBasedGapsAndPreserveExactByteTerminators() {
    var inserted =
        GitDiffBlocks.changes(
            "rev",
            "@@ -0,0 +1,2 @@\n+one\r\n+last\n\\ No newline at end of file\n",
            bytes(""),
            bytes("one\r\nlast"));
    assertThat(inserted).hasSize(1);
    assertThat(inserted.get(0).beforeStart()).isEqualTo(1);
    assertThat(inserted.get(0).beforeCount()).isZero();
    assertThat(GitDiffBlocks.restore(bytes(""), bytes("one\r\nlast"), inserted.get(0))).isEmpty();
    var deleted =
        GitDiffBlocks.changes(
            "rev",
            "@@ -1,2 +0,0 @@\n-one\r\n-last\n\\ No newline at end of file\n",
            bytes("one\r\nlast"),
            bytes(""));
    assertThat(deleted).hasSize(1);
    assertThat(deleted.get(0).afterStart()).isEqualTo(1);
    assertThat(deleted.get(0).afterCount()).isZero();
    assertThat(GitDiffBlocks.restore(bytes("one\r\nlast"), bytes(""), deleted.get(0)))
        .isEqualTo(bytes("one\r\nlast"));
  }

  private byte[] bytes(String value) {
    return value.getBytes(StandardCharsets.UTF_8);
  }
}
