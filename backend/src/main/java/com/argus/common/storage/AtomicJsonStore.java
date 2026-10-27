package com.argus.common.storage;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

@Component
public class AtomicJsonStore {
  private final ObjectMapper mapper;
  private final Object[] writeLocks = new Object[64];

  public AtomicJsonStore(ObjectMapper mapper) {
    this.mapper = mapper;
    java.util.Arrays.setAll(writeLocks, ignored -> new Object());
  }

  public <T> T read(Path path, Class<T> type) {
    try {
      return mapper.readValue(path.toFile(), type);
    } catch (RuntimeException error) {
      throw new IllegalStateException("Could not read " + path, error);
    }
  }

  public void write(Path path, Object value) {
    // fsync of one task must not stall unrelated settings/cache files. Stripes bound lock memory;
    // the same normalized target still serializes its complete durable replacement transaction.
    Path target = path.toAbsolutePath().normalize();
    Object lock = writeLocks[(target.hashCode() & Integer.MAX_VALUE) % writeLocks.length];
    synchronized (lock) {
      writeAtomically(target, value);
    }
  }

  private void writeAtomically(Path path, Object value) {
    Path temporary =
        path.resolveSibling(
            path.getFileName()
                + ".argus-"
                + ProcessHandle.current().pid()
                + "-"
                + Thread.currentThread().getId()
                + ".tmp");
    try {
      Files.createDirectories(path.getParent());
      mapper.writerWithDefaultPrettyPrinter().writeValue(temporary.toFile(), value);
      try {
        Files.setPosixFilePermissions(
            temporary, Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
      } catch (UnsupportedOperationException ignored) {
      }
      try (var channel =
          java.nio.channels.FileChannel.open(temporary, java.nio.file.StandardOpenOption.WRITE)) {
        channel.force(true);
      }
      try {
        Files.move(
            temporary, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
      } catch (java.nio.file.AtomicMoveNotSupportedException ignored) {
        Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
      }
      // Directory fsync is available on local Unix filesystems; other providers
      // may reject directory handles after the durable file has been renamed.
      try (var directory =
          java.nio.channels.FileChannel.open(
              path.getParent(), java.nio.file.StandardOpenOption.READ)) {
        directory.force(true);
      } catch (IOException | UnsupportedOperationException ignored) {
      }
    } catch (IOException error) {
      throw new IllegalStateException("Could not save " + path, error);
    } finally {
      try {
        Files.deleteIfExists(temporary);
      } catch (IOException ignored) {
      }
    }
  }
}
