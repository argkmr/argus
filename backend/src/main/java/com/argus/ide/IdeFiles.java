package com.argus.ide;

import com.argus.common.error.ConflictException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.stereotype.Component;

/** Repository-local, bounded filesystem access. Never follows repository symlinks. */
@Component
public class IdeFiles {
  static final int MAX_FILE_BYTES = 2 * 1024 * 1024;
  static final int MAX_RESULTS = 200;
  private static final Set<String> PRIVATE = Set.of(".git", ".argus-data");
  private static final Set<String> SKIP =
      Set.of(
          ".git",
          ".argus-data",
          "node_modules",
          "target",
          "build",
          "dist",
          ".venv",
          "venv",
          ".gradle",
          ".next",
          "__pycache__");

  public record Entry(String path, String name, boolean directory) {}

  public record Tree(List<Entry> entries, boolean truncated) {}

  public record FileContent(String path, String content, String contentHash, String language) {}

  public record Result(String path, int line, int column, String name, String preview) {}

  public record Search(List<Result> results, boolean truncated, String notice) {}

  public Path resolve(Path root, String requested, boolean directory) {
    if (requested == null || requested.indexOf('\0') >= 0)
      throw new IllegalArgumentException("A repository-relative path is required");
    Path relative = Path.of(requested.isBlank() ? "." : requested);
    if (relative.isAbsolute()) throw new IllegalArgumentException("Use a repository-relative path");
    for (Path part : relative)
      if ("..".equals(part.toString()) || PRIVATE.contains(part.toString()))
        throw new IllegalArgumentException("Path is outside the editable repository");
    try {
      Path realRoot = root.toRealPath();
      Path candidate = realRoot;
      for (Path part : relative) {
        candidate = candidate.resolve(part).normalize();
        if (Files.isSymbolicLink(candidate))
          throw new IllegalArgumentException("Repository symlinks are not followed by the IDE");
      }
      Path real = candidate.toRealPath();
      if (!real.startsWith(realRoot)) throw new IllegalArgumentException("Path escapes repository");
      if (directory ? !Files.isDirectory(real) : !Files.isRegularFile(real))
        throw new IllegalArgumentException(directory ? "Not a directory" : "Not a file");
      return real;
    } catch (IOException error) {
      throw new IllegalArgumentException("Repository path does not exist", error);
    }
  }

  public Tree tree(Path root, String path) {
    Path directory = resolve(root, path, true);
    var entries = new ArrayList<Entry>();
    boolean truncated = false;
    try (var stream = Files.newDirectoryStream(directory)) {
      Path realRoot = root.toRealPath();
      int inspected = 0;
      for (Path child : stream) {
        if (++inspected > 4000 || entries.size() >= 1000) {
          truncated = true;
          break;
        }
        if (PRIVATE.contains(child.getFileName().toString()) || Files.isSymbolicLink(child))
          continue;
        boolean folder = Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS);
        if (!folder && !Files.isRegularFile(child, LinkOption.NOFOLLOW_LINKS)) continue;
        entries.add(new Entry(relative(realRoot, child), child.getFileName().toString(), folder));
      }
    } catch (IOException error) {
      throw new IllegalStateException("Could not list directory", error);
    }
    entries.sort(
        Comparator.comparing(Entry::directory)
            .reversed()
            .thenComparing(Entry::name, String.CASE_INSENSITIVE_ORDER));
    return new Tree(List.copyOf(entries), truncated);
  }

  public FileContent read(Path root, String path) {
    Path file = resolve(root, path, false);
    try {
      String content = readText(file);
      return new FileContent(
          relative(root.toRealPath(), file), content, hash(content), language(file.toString()));
    } catch (IOException error) {
      throw new IllegalStateException("Could not read text file", error);
    }
  }

  public synchronized FileContent write(
      Path root, String path, String content, String expectedHash) {
    if (expectedHash == null || expectedHash.isBlank())
      throw new IllegalArgumentException("expectedHash is required; open the file before saving");
    if (content == null
        || content.indexOf('\0') >= 0
        || content.getBytes(StandardCharsets.UTF_8).length > MAX_FILE_BYTES)
      throw new IllegalArgumentException("Only UTF-8 text files up to 2 MB can be edited");
    Path file = resolve(root, path, false);
    Path temporary = null;
    try {
      if (!hash(readText(file)).equals(expectedHash))
        throw new ConflictException("This file changed on disk. Reload before saving.");
      temporary = Files.createTempFile(file.getParent(), ".argus-ide-", ".tmp");
      Files.writeString(temporary, content, StandardCharsets.UTF_8);
      try {
        Files.setPosixFilePermissions(temporary, Files.getPosixFilePermissions(file));
      } catch (UnsupportedOperationException ignored) {
      }
      // Recheck immediately before replacement, including path confinement.
      if (!resolve(root, path, false).equals(file) || !hash(readText(file)).equals(expectedHash))
        throw new ConflictException("This file changed on disk. Reload before saving.");
      Files.move(
          temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      return new FileContent(
          relative(root.toRealPath(), file), content, hash(content), language(file.toString()));
    } catch (IOException error) {
      throw new IllegalStateException("Could not save text file", error);
    } finally {
      if (temporary != null)
        try {
          Files.deleteIfExists(temporary);
        } catch (IOException ignored) {
        }
    }
  }

  public Search search(Path root, String query, String kind) {
    if (!Set.of("files", "text").contains(kind))
      throw new IllegalArgumentException("Unsupported search kind");
    if (query == null || query.isBlank()) return new Search(List.of(), false, "");
    if (query.length() > 300) throw new IllegalArgumentException("Search query is too long");
    Path realRoot = resolve(root, ".", true);
    var results = new ArrayList<Result>();
    String needle = query.toLowerCase(Locale.ROOT);
    long deadline = System.nanoTime() + Duration.ofSeconds(3).toNanos();
    int[] visited = {0};
    long[] bytes = {0};
    boolean[] truncated = {false};
    try {
      Files.walkFileTree(
          realRoot,
          Set.of(),
          40,
          new SimpleFileVisitor<>() {
            private boolean exhausted() {
              if (results.size() >= MAX_RESULTS
                  || visited[0] >= 10000
                  || bytes[0] >= 32L * 1024 * 1024
                  || System.nanoTime() >= deadline) truncated[0] = true;
              return truncated[0];
            }

            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
              visited[0]++;
              if (exhausted()) return FileVisitResult.TERMINATE;
              return !dir.equals(realRoot) && SKIP.contains(dir.getFileName().toString())
                  ? FileVisitResult.SKIP_SUBTREE
                  : FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
              visited[0]++;
              if (exhausted()) return FileVisitResult.TERMINATE;
              if (!attrs.isRegularFile() || attrs.isSymbolicLink()) return FileVisitResult.CONTINUE;
              String path = relative(realRoot, file);
              if ("files".equals(kind)) {
                if (path.toLowerCase(Locale.ROOT).contains(needle))
                  results.add(new Result(path, 1, 1, file.getFileName().toString(), path));
              } else if (attrs.size() <= MAX_FILE_BYTES) {
                bytes[0] += attrs.size();
                try {
                  String[] lines = readText(resolve(realRoot, path, false)).split("\\n", -1);
                  for (int i = 0; i < lines.length && !exhausted(); i++) {
                    int column = lines[i].toLowerCase(Locale.ROOT).indexOf(needle);
                    if (column >= 0)
                      results.add(
                          new Result(
                              path,
                              i + 1,
                              column + 1,
                              file.getFileName().toString(),
                              preview(lines[i], column)));
                  }
                } catch (IOException | IllegalArgumentException ignored) {
                  /* binary, unreadable, or changed */
                }
              }
              return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException error) {
              return exhausted() ? FileVisitResult.TERMINATE : FileVisitResult.CONTINUE;
            }
          });
    } catch (IOException error) {
      throw new IllegalStateException("Could not search repository", error);
    }
    return new Search(
        List.copyOf(results),
        truncated[0],
        "Bounded local search; skips dependency/build folders and symlinks.");
  }

  private static String preview(String line, int column) {
    int start = Math.max(0, column - 80);
    return (start == 0 ? "" : "…") + line.substring(start, Math.min(line.length(), start + 350));
  }

  static String readText(Path file) throws IOException {
    byte[] bytes;
    try (var input = Files.newInputStream(file)) {
      bytes = input.readNBytes(MAX_FILE_BYTES + 1);
    }
    if (bytes.length > MAX_FILE_BYTES)
      throw new IllegalArgumentException("File is larger than 2 MB");
    for (byte value : bytes)
      if (value == 0) throw new IllegalArgumentException("Binary files cannot be edited");
    try {
      return StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes))
          .toString();
    } catch (CharacterCodingException error) {
      throw new IllegalArgumentException("Only UTF-8 text files can be edited", error);
    }
  }

  static String relative(Path root, Path file) {
    return root.relativize(file).toString().replace('\\', '/');
  }

  static String hash(String content) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(content.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  public static String language(String path) {
    String value = path.toLowerCase(Locale.ROOT);
    if (value.endsWith(".java")) return "java";
    if (value.endsWith(".tsx")) return "typescriptreact";
    if (value.endsWith(".ts") || value.endsWith(".mts") || value.endsWith(".cts"))
      return "typescript";
    if (value.endsWith(".jsx")) return "javascriptreact";
    if (value.endsWith(".js") || value.endsWith(".mjs") || value.endsWith(".cjs"))
      return "javascript";
    if (value.endsWith(".py")) return "python";
    if (value.endsWith(".go")) return "go";
    if (value.endsWith(".rs")) return "rust";
    if (value.matches(".*\\.(c|h|cc|cpp|hpp|cxx)$")) return "cpp";
    if (value.endsWith(".json")) return "json";
    if (value.endsWith(".md")) return "markdown";
    if (value.endsWith(".yml") || value.endsWith(".yaml")) return "yaml";
    if (value.endsWith(".xml")) return "xml";
    if (value.endsWith(".html")) return "html";
    if (value.endsWith(".css")) return "css";
    return "plaintext";
  }
}
