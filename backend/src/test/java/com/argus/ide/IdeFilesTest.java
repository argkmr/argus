package com.argus.ide;

import static org.junit.jupiter.api.Assertions.*;

import com.argus.common.error.ConflictException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class IdeFilesTest {
  @TempDir Path temporary;
  private final IdeFiles files = new IdeFiles();

  @Test
  void confinesPathsAndNeverFollowsSymlinks() throws Exception {
    Path root = Files.createDirectory(temporary.resolve("repository"));
    Files.writeString(temporary.resolve("outside.txt"), "secret");
    Files.createSymbolicLink(root.resolve("outside"), temporary);
    Files.createDirectories(root.resolve(".git"));
    Files.writeString(root.resolve(".git/config"), "private");
    assertThrows(IllegalArgumentException.class, () -> files.read(root, "../outside.txt"));
    assertThrows(
        IllegalArgumentException.class,
        () -> files.read(root, temporary.resolve("outside.txt").toString()));
    assertThrows(IllegalArgumentException.class, () -> files.read(root, "outside/outside.txt"));
    assertThrows(IllegalArgumentException.class, () -> files.read(root, ".git/config"));
    assertTrue(files.tree(root, ".").entries().isEmpty());
  }

  @Test
  void saveRequiresHashAndDetectsConflictsWithoutOverwrite() throws Exception {
    Path file = temporary.resolve("app.ts");
    Files.writeString(file, "export const name = 'old';\n");
    var original = files.read(temporary, "app.ts");
    assertThrows(
        IllegalArgumentException.class, () -> files.write(temporary, "app.ts", "next", null));
    Files.writeString(file, "external change");
    assertThrows(
        ConflictException.class,
        () -> files.write(temporary, "app.ts", "next", original.contentHash()));
    assertEquals("external change", Files.readString(file));
    var saved =
        files.write(
            temporary,
            "app.ts",
            "export const name = 'new';\n",
            files.read(temporary, "app.ts").contentHash());
    assertEquals("typescript", saved.language());
    assertEquals(saved.contentHash(), files.read(temporary, "app.ts").contentHash());
    assertEquals(saved.content(), Files.readString(file));
    try (var siblings = Files.list(temporary)) {
      assertEquals(1, siblings.count());
    }
  }

  @Test
  void treeIsLazyAndSearchIsLiteralBoundedAndSkipsDependencies() throws Exception {
    Files.createDirectories(temporary.resolve("src/deep"));
    Files.createDirectories(temporary.resolve("node_modules/pkg"));
    Files.writeString(temporary.resolve("src/App.ts"), "// a.b needle\nconst x = 'needle';\n");
    Files.writeString(temporary.resolve("src/deep/Else.java"), "class Else {}\n");
    Files.writeString(temporary.resolve("node_modules/pkg/ignored.txt"), "needle");
    assertEquals(2, files.tree(temporary, ".").entries().size());
    var result = files.search(temporary, "needle", "text");
    assertEquals(2, result.results().size());
    assertEquals("src/App.ts", result.results().get(0).path());
    assertEquals(8, result.results().get(0).column());
    assertTrue(files.search(temporary, "a.*b", "text").results().isEmpty());
    assertEquals("src/App.ts", files.search(temporary, "app.TS", "files").results().get(0).path());
    Files.writeString(temporary.resolve("many.txt"), "needle\n".repeat(1000));
    var bounded = files.search(temporary, "needle", "text");
    assertEquals(200, bounded.results().size());
    assertTrue(bounded.truncated());
  }

  @Test
  void refusesBinaryNonUtf8AndOversizedFiles() throws Exception {
    Files.write(temporary.resolve("binary"), new byte[] {1, 0, 2});
    Files.write(temporary.resolve("invalid"), new byte[] {(byte) 0xff});
    Files.writeString(temporary.resolve("large"), "x".repeat(IdeFiles.MAX_FILE_BYTES + 1));
    for (String path : java.util.List.of("binary", "invalid", "large"))
      assertThrows(IllegalArgumentException.class, () -> files.read(temporary, path));
  }
}
