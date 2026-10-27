package com.argus.git.repository;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Repository;

/** Private, durable recovery receipts; never writes recovery data into developer source. */
@Repository
public class GitRecoveryRepository {
  private final Path root;
  private final AtomicJsonStore json;

  public GitRecoveryRepository(ArgusProperties properties, AtomicJsonStore json) {
    root = properties.dataDirectory().resolve("git-recovery").toAbsolutePath().normalize();
    this.json = json;
  }

  public String directory() {
    return root.toString();
  }

  public String location(String id) {
    if (id == null || !id.matches("[a-f0-9-]{36}"))
      throw new IllegalArgumentException("Invalid recovery identifier");
    return root.resolve(id).toString();
  }

  public synchronized String save(
      Map<String, Object> metadata, byte[] before, byte[] baseline, byte[] index) {
    String id = UUID.randomUUID().toString();
    Path directory = root.resolve(id);
    try {
      Files.createDirectories(root);
      if (Files.isSymbolicLink(root) || !Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS))
        throw new IOException("Invalid Git recovery directory");
      Files.createDirectory(directory);
      Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
      write(directory.resolve("before-content.bin"), before);
      write(directory.resolve("baseline-content.bin"), baseline);
      if (index != null) write(directory.resolve("before-index.bin"), index);
      var manifest = new LinkedHashMap<>(metadata);
      manifest.put("id", id);
      manifest.put("createdAt", Instant.now().toString());
      manifest.put("status", "prepared");
      json.write(directory.resolve("receipt.json"), manifest);
      forceDirectory(directory);
      forceDirectory(root);
      forceDirectory(root.getParent());
      trim(Objects.toString(metadata.get("repositoryId"), ""), id);
      return id;
    } catch (IOException error) {
      throw new IllegalStateException(
          "Could not preserve a Git recovery snapshot; nothing was reverted", error);
    }
  }

  /**
   * One retention unit for a bulk operation. Every selected file and the original index are durable
   * before this method returns; trimming can never remove an earlier file in the active batch.
   */
  public synchronized String saveBatch(
      Map<String, Object> metadata, List<Backup> files, byte[] index) {
    long contentBytes =
        files == null
            ? 0
            : files.stream()
                .mapToLong(file -> (long) file.before.length + file.baseline.length)
                .sum();
    if (files == null
        || files.isEmpty()
        || files.size() > 25
        || contentBytes > 32L * 1024 * 1024
        || index == null
        || index.length > 64 * 1024 * 1024)
      throw new IllegalArgumentException("Unsupported bulk recovery snapshot size");
    String id = UUID.randomUUID().toString();
    Path directory = root.resolve(id);
    try {
      Files.createDirectories(root);
      if (Files.isSymbolicLink(root) || !Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS))
        throw new IOException("Invalid Git recovery directory");
      Files.createDirectory(directory);
      Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
      var entries = new ArrayList<Map<String, Object>>();
      for (int item = 0; item < files.size(); item++) {
        Backup backup = files.get(item);
        // Numeric filenames, never repository paths, prevent recovery-directory traversal.
        String beforeFile = "file-" + item + "-before-content.bin";
        String baselineFile = "file-" + item + "-baseline-content.bin";
        write(directory.resolve(beforeFile), backup.before);
        write(directory.resolve(baselineFile), backup.baseline);
        var entry = new LinkedHashMap<>(backup.metadata);
        entry.put("beforeContent", beforeFile);
        entry.put("baselineContent", baselineFile);
        entries.add(entry);
      }
      write(directory.resolve("before-index.bin"), index);
      var manifest = new LinkedHashMap<>(metadata);
      manifest.put("id", id);
      manifest.put("createdAt", Instant.now().toString());
      manifest.put("status", "prepared");
      manifest.put("operation", "bulk-revert");
      manifest.put("files", entries);
      json.write(directory.resolve("receipt.json"), manifest);
      forceDirectory(directory);
      forceDirectory(root);
      forceDirectory(root.getParent());
      trim(Objects.toString(metadata.get("repositoryId"), ""), id);
      return id;
    } catch (IOException error) {
      throw new IllegalStateException(
          "Could not preserve the bulk Git recovery snapshot; nothing was reverted", error);
    }
  }

  public record Backup(Map<String, Object> metadata, byte[] before, byte[] baseline) {}

  @SuppressWarnings("unchecked")
  public synchronized void markBatchResult(String id, boolean complete, List<?> results) {
    Path file = Path.of(location(id)).resolve("receipt.json");
    var manifest = new LinkedHashMap<String, Object>(json.read(file, Map.class));
    manifest.put("status", complete ? "restored" : "incomplete");
    manifest.put("completedAt", Instant.now().toString());
    manifest.put("results", results);
    json.write(file, manifest);
  }

  private void write(Path file, byte[] value) throws IOException {
    Files.write(file, value, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
    Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
    try (var channel = java.nio.channels.FileChannel.open(file, StandardOpenOption.WRITE)) {
      channel.force(true);
    }
  }

  private void forceDirectory(Path directory) throws IOException {
    try (var channel = java.nio.channels.FileChannel.open(directory, StandardOpenOption.READ)) {
      channel.force(true);
    }
  }

  @SuppressWarnings("unchecked")
  public synchronized void markRestored(String id, String revision) {
    markApplied(id, "restored", revision);
  }

  public synchronized void markDeleted(String id) {
    markApplied(id, "deleted", "");
  }

  @SuppressWarnings("unchecked")
  private void markApplied(String id, String status, String revision) {
    if (!id.matches("[a-f0-9-]{36}"))
      throw new IllegalArgumentException("Invalid recovery identifier");
    Path file = root.resolve(id).resolve("receipt.json");
    var value = new LinkedHashMap<String, Object>(json.read(file, Map.class));
    value.put("status", status);
    value.put(status + "At", Instant.now().toString());
    value.put("resultRevision", revision);
    json.write(file, value);
  }

  /**
   * Keep the newest 50 receipts and at most 128 MiB per repository, after the new copy is durable.
   */
  private void trim(String repositoryId, String retainedId) {
    var entries = entries(List.of(repositoryId));
    entries.sort(Comparator.comparing((Saved saved) -> Instant.parse(saved.createdAt)).reversed());
    long bytes = 0;
    int count = 0;
    for (Saved saved : entries) {
      bytes += saved.bytes;
      count++;
      if (!saved.path.getFileName().toString().equals(retainedId)
          && (count > 50 || bytes > 128L * 1024 * 1024)) delete(saved.path);
    }
  }

  public synchronized int purgeRepositories(List<String> ids) {
    var entries = entries(ids);
    for (Saved saved : entries) delete(saved.path);
    return entries.size();
  }

  @SuppressWarnings("unchecked")
  private List<Saved> entries(List<String> ids) {
    var entries = new ArrayList<Saved>();
    if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(root))
      return entries;
    try (var directories = Files.list(root)) {
      for (Path directory :
          directories
              .filter(
                  path ->
                      path.getFileName().toString().matches("[a-f0-9-]{36}")
                          && !Files.isSymbolicLink(path)
                          && Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
              .toList()) {
        Path receipt = directory.resolve("receipt.json");
        if (Files.isSymbolicLink(receipt)
            || !Files.isRegularFile(receipt, LinkOption.NOFOLLOW_LINKS)) continue;
        var metadata = json.read(receipt, Map.class);
        if (!ids.contains(metadata.get("repositoryId"))) continue;
        long bytes = 0;
        try (var files = Files.walk(directory)) {
          for (Path file :
              files.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)).toList())
            bytes += Files.size(file);
        }
        entries.add(new Saved(directory, Objects.toString(metadata.get("createdAt"), ""), bytes));
      }
      return entries;
    } catch (IOException error) {
      throw new IllegalStateException("Could not inspect Git recovery snapshots", error);
    }
  }

  private void delete(Path directory) {
    try (var files = Files.walk(directory)) {
      for (Path file : files.sorted(Comparator.reverseOrder()).toList()) Files.delete(file);
    } catch (IOException error) {
      throw new IllegalStateException("Could not remove the selected Git recovery snapshot", error);
    }
  }

  private record Saved(Path path, String createdAt, long bytes) {}
}
