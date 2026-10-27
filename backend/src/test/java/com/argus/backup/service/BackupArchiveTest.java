package com.argus.backup.service;

import static org.assertj.core.api.Assertions.*;

import java.nio.file.*;
import java.util.*;
import org.apache.commons.compress.archivers.tar.*;
import org.apache.commons.compress.compressors.gzip.GzipCompressorOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BackupArchiveTest {
  @TempDir Path temporary;

  @Test
  void traversalSymlinksDuplicatesAndExpandedLimitsNeverEscapeStaging() throws Exception {
    Path root = temporary.toRealPath();
    for (String type : List.of("traversal", "symlink", "duplicate", "oversized")) {
      Path archive = root.resolve(type + ".tar.gz"), extracted = root.resolve(type);
      try (var output = Files.newOutputStream(archive);
          var gzip = new GzipCompressorOutputStream(output);
          var tar = new TarArchiveOutputStream(gzip)) {
        if (type.equals("symlink")) {
          var entry = new TarArchiveEntry("link", TarConstants.LF_SYMLINK);
          entry.setLinkName(root.resolve("outside").toString());
          tar.putArchiveEntry(entry);
          tar.closeArchiveEntry();
        } else {
          int entries = type.equals("duplicate") ? 2 : 1;
          for (int i = 0; i < entries; i++) {
            var entry = new TarArchiveEntry(type.equals("traversal") ? "../outside" : "file");
            entry.setSize(10);
            tar.putArchiveEntry(entry);
            tar.write(new byte[10]);
            tar.closeArchiveEntry();
          }
        }
      }
      assertThatThrownBy(
              () ->
                  BackupArchive.extract(
                      archive, extracted, type.equals("oversized") ? 1 : 1000, 20))
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessageContaining("Cannot safely restore");
      assertThat(root.resolve("outside")).doesNotExist();
    }
  }

  @Test
  void preservesEmptyDirectoriesAndOriginalBinaryBytes() throws Exception {
    Path root = temporary.toRealPath(), source = root.resolve("source");
    Files.createDirectories(source.resolve("argus-data/empty"));
    Files.write(source.resolve("argus-data/file.bin"), new byte[] {0, 3, (byte) 255});
    Path archive = root.resolve("payload.tar.gz"), output = root.resolve("output");
    BackupArchive.create(source, archive);
    BackupArchive.extract(archive, output);
    assertThat(output.resolve("argus-data/empty")).isDirectory();
    assertThat(Files.readAllBytes(output.resolve("argus-data/file.bin")))
        .containsExactly((byte) 0, (byte) 3, (byte) 255);
  }

  @Test
  void rejectsOversizedPaxMetadataBeforeAllocatingOrReadingItsBody() throws Exception {
    Path root = temporary.toRealPath(), archive = root.resolve("oversized-metadata.tar.gz");
    var entry = new TarArchiveEntry("PaxHeaders/entry", TarConstants.LF_PAX_EXTENDED_HEADER_LC);
    entry.setSize(1024 * 1024 + 1);
    byte[] header = new byte[512];
    entry.writeEntryHeader(header);
    try (var output = new GzipCompressorOutputStream(Files.newOutputStream(archive))) {
      output.write(header);
    }
    assertThatThrownBy(() -> BackupArchive.extract(archive, root.resolve("pax-extracted")))
        .hasMessageContaining("metadata exceeds its safety limit");
  }
}
