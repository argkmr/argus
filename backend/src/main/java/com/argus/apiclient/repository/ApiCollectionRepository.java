package com.argus.apiclient.repository;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

@Component
public class ApiCollectionRepository {
  private final Path root;
  private final AtomicJsonStore json;

  @Autowired
  public ApiCollectionRepository(ArgusProperties properties, AtomicJsonStore json) {
    this(
        Path.of(
            System.getenv()
                .getOrDefault(
                    "ARGUS_API_COLLECTIONS_DIR",
                    Path.of(System.getProperty("user.home"), "Documents", "Argus API Requests")
                        .toString())),
        json);
  }

  public ApiCollectionRepository(Path root, AtomicJsonStore json) {
    this.root = root.toAbsolutePath().normalize();
    this.json = json;
  }

  public Path root() {
    return root;
  }

  public Path directory(Repository repository) {
    return root.resolve(safe(repository.name(), "unnamed") + "--" + prefix(repository.id()));
  }

  public Path collectionFile(Repository repository, Map<String, Object> configuration) {
    return directory(repository)
        .resolve(
            safe(
                    configuration == null
                        ? "Repository only"
                        : String.valueOf(configuration.get("name")),
                    "unnamed")
                + "--"
                + (configuration == null
                    ? "repository"
                    : prefix(String.valueOf(configuration.get("id")))))
        .resolve("collection.json");
  }

  public synchronized List<Path> files(Repository repository) {
    Path directory = directory(repository);
    safePath(directory);
    if (!Files.exists(directory)) return List.of();
    try (var entries = Files.list(directory)) {
      return entries
          .filter(path -> Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
          .map(path -> path.resolve("collection.json"))
          .filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
          .sorted()
          .toList();
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Could not read API collections", e);
    }
  }

  @SuppressWarnings("unchecked")
  public synchronized Map<String, Object> read(Path file) {
    safePath(file);
    if (!Files.exists(file)) return null;
    try {
      if (Files.size(file) > 50_000_000)
        throw new IllegalStateException("API collection exceeds the 50 MB local storage limit");
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Could not read API collection", e);
    }
    var value = json.read(file, LinkedHashMap.class);
    if (!"argus-api-collection".equals(value.get("format"))
        || !Integer.valueOf(1).equals(value.get("version"))
        || !(value.get("requests") instanceof List<?>))
      throw new IllegalStateException("Unsupported API collection: " + file);
    return value;
  }

  public synchronized void write(Path file, Map<String, Object> data) {
    safePath(file);
    json.write(file, data);
  }

  public synchronized void writeCurl(Path file, String value) {
    safePath(file);
    try {
      Files.createDirectories(file.getParent());
      try (var stream =
          Files.newByteChannel(
              file,
              java.util.Set.of(
                  StandardOpenOption.WRITE,
                  StandardOpenOption.CREATE,
                  StandardOpenOption.TRUNCATE_EXISTING,
                  LinkOption.NOFOLLOW_LINKS),
              PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))) {
        var bytes =
            java.nio.ByteBuffer.wrap(
                (value + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        while (bytes.hasRemaining()) stream.write(bytes);
      }
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Could not save request cURL", e);
    }
  }

  public synchronized void delete(Path file) {
    safePath(file);
    try {
      Files.deleteIfExists(file);
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Could not remove API collection file", e);
    }
  }

  public synchronized boolean purgeRepository(Repository repository) {
    Path target = directory(repository);
    safePath(target);
    if (target.equals(root) || !target.startsWith(root))
      throw new IllegalArgumentException("Invalid API repository storage target");
    if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) return false;
    try {
      Files.walkFileTree(
          target,
          new java.nio.file.SimpleFileVisitor<>() {
            @Override
            public java.nio.file.FileVisitResult visitFile(
                Path file, java.nio.file.attribute.BasicFileAttributes attributes)
                throws java.io.IOException {
              Files.delete(file);
              return java.nio.file.FileVisitResult.CONTINUE;
            }

            @Override
            public java.nio.file.FileVisitResult postVisitDirectory(
                Path directory, java.io.IOException error) throws java.io.IOException {
              if (error != null) throw error;
              Files.delete(directory);
              return java.nio.file.FileVisitResult.CONTINUE;
            }
          });
      return true;
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not purge repository API collections", error);
    }
  }

  public void safePath(Path path) {
    Path normalized = path.toAbsolutePath().normalize();
    if (!normalized.startsWith(root) || normalized.equals(root) && Files.isSymbolicLink(root))
      throw new IllegalArgumentException("API storage path is outside managed storage");
    Path cursor = root;
    if (Files.isSymbolicLink(cursor))
      throw new IllegalArgumentException("API storage cannot use symbolic links");
    for (Path part : root.relativize(normalized)) {
      cursor = cursor.resolve(part);
      if (Files.isSymbolicLink(cursor))
        throw new IllegalArgumentException("API storage cannot use symbolic links");
    }
  }

  public static String safe(String name, String fallback) {
    String result =
        name == null || name.isBlank()
            ? fallback
            : name.trim().replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^-+|-+$", "");
    if (result.equals(".") || result.equals("..") || result.isEmpty()) result = fallback;
    return result.substring(0, Math.min(90, result.length()));
  }

  private static String prefix(String id) {
    if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}"))
      throw new IllegalArgumentException("Invalid API storage identifier");
    return id.substring(0, Math.min(8, id.length()));
  }
}
