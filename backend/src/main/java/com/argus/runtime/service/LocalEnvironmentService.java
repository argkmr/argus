package com.argus.runtime.service;

import com.argus.apiclient.service.EnvironmentFormat;
import com.argus.common.config.ArgusProperties;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.Map;
import org.springframework.stereotype.Service;

/** Existing local-only environment files, retaining literal dotenv and Vault round trips. */
@Service
public class LocalEnvironmentService {
  private final Path directory;

  public LocalEnvironmentService(ArgusProperties properties) {
    directory = properties.dataDirectory().resolve("environments");
  }

  private Path file(String id) {
    if (id == null || !id.matches("[A-Za-z0-9_:-]{1,240}"))
      throw new IllegalArgumentException("Invalid run configuration ID");
    Path path = directory.resolve(id + ".env");
    if (Files.isSymbolicLink(directory) || Files.isSymbolicLink(path))
      throw new IllegalArgumentException("Environment storage must not use symbolic links");
    return path;
  }

  public synchronized Map<String, Object> write(String id, String input, String format) {
    var values = EnvironmentFormat.parse(input, format);
    Path target = file(id);
    atomicWrite(target, EnvironmentFormat.serialize(values) + "\n", true);
    return RuntimeData.object(
        "keys",
        values.keySet().stream().sorted().toList(),
        "format",
        format,
        "updatedAt",
        Instant.now().toString());
  }

  public synchronized Map<String, String> resolve(String id) {
    return EnvironmentFormat.parse(RuntimeData.read(file(id)));
  }

  public synchronized String editable(String id, String format) {
    String source = RuntimeData.read(file(id));
    return "vault".equals(format)
        ? source.isEmpty()
            ? ""
            : EnvironmentFormat.serialize(EnvironmentFormat.parse(source), format)
        : source.stripTrailing();
  }

  record PortSnapshot(String source, Map<String, String> values) {}

  synchronized PortSnapshot portSnapshot(String id) {
    String source = RuntimeData.read(file(id));
    return new PortSnapshot(source, EnvironmentFormat.parse(source));
  }

  synchronized String replacePortValues(
      String id, PortSnapshot expected, Map<String, String> values) {
    Path target = file(id);
    if (!RuntimeData.read(target).equals(expected.source()))
      throw new com.argus.common.error.ConflictException(
          "Local environment changed. Refresh before saving the port.");
    String updated = EnvironmentFormat.serialize(values) + "\n";
    atomicWrite(target, updated, true);
    return updated;
  }

  synchronized void restorePortValues(String id, String expected, PortSnapshot original) {
    Path target = file(id);
    if (!RuntimeData.read(target).equals(expected))
      throw new com.argus.common.error.ConflictException(
          "Local environment changed during rollback; it was preserved.");
    atomicWrite(target, original.source(), true);
  }

  public synchronized void remove(String id) {
    try {
      Files.deleteIfExists(file(id));
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not remove local run environment", error);
    }
  }

  public static void atomicWrite(Path target, String source, boolean privateFile) {
    Path temporary = null;
    try {
      Files.createDirectories(target.getParent());
      if (privateFile)
        try {
          Files.setPosixFilePermissions(
              target.getParent(), PosixFilePermissions.fromString("rwx------"));
        } catch (UnsupportedOperationException ignored) {
        }
      if (Files.isSymbolicLink(target))
        throw new IllegalArgumentException("Refusing to overwrite a symbolic link");
      temporary = Files.createTempFile(target.getParent(), ".argus-", ".tmp");
      if (Files.exists(target, LinkOption.NOFOLLOW_LINKS) && !privateFile)
        try {
          Files.setPosixFilePermissions(temporary, Files.getPosixFilePermissions(target));
        } catch (UnsupportedOperationException ignored) {
        }
      try (var channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
        ByteBuffer content = StandardCharsets.UTF_8.encode(source);
        while (content.hasRemaining()) channel.write(content);
        channel.force(true);
      }
      Files.move(
          temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      temporary = null;
      try (var directory = FileChannel.open(target.getParent(), StandardOpenOption.READ)) {
        directory.force(true);
      } catch (java.io.IOException | UnsupportedOperationException ignored) {
      }
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not save local configuration", error);
    } finally {
      if (temporary != null)
        try {
          Files.deleteIfExists(temporary);
        } catch (java.io.IOException ignored) {
        }
    }
  }
}
