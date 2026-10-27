package com.argus.backup.service;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;

/** Exact owned roots only. Never follows links while copying, inventorying, or deleting. */
final class BackupFiles {
  private BackupFiles() {}

  static void privateDirectory(Path directory) throws IOException {
    safeAncestors(directory);
    Files.createDirectories(directory);
    try {
      Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
    } catch (UnsupportedOperationException ignored) {
    }
  }

  static void safeAncestors(Path path) throws IOException {
    Path absolute = path.toAbsolutePath().normalize(), current = absolute.getRoot();
    for (Path part : absolute) {
      current = current.resolve(part);
      if (Files.isSymbolicLink(current))
        throw new IOException("Backup storage must not traverse symbolic links");
    }
  }

  static Path privateFile(Path directory, String prefix) throws IOException {
    privateDirectory(directory);
    return Files.createTempFile(
        directory,
        prefix,
        ".tmp",
        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
  }

  static List<Path> files(Path root) throws IOException {
    var result = new ArrayList<Path>();
    if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return result;
    safeAncestors(root);
    Files.walkFileTree(
        root,
        new SimpleFileVisitor<>() {
          @Override
          public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs)
              throws IOException {
            if (root.relativize(dir).getNameCount() > 128)
              throw new IOException("Backup directory nesting exceeds the supported limit");
            return FileVisitResult.CONTINUE;
          }

          @Override
          public FileVisitResult visitFile(Path file, BasicFileAttributes attrs)
              throws IOException {
            if (attrs.isRegularFile()) result.add(file);
            if (result.size() > 100_000)
              throw new IOException("Backup exceeds the 100,000 file limit");
            return FileVisitResult.CONTINUE;
          }
        });
    return result.stream().sorted().toList();
  }

  static void copyTree(Path source, Path destination) throws IOException {
    if (!Files.exists(source, LinkOption.NOFOLLOW_LINKS)) return;
    safeAncestors(source);
    safeAncestors(destination);
    if (Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) {
      privateDirectory(destination.getParent());
      Files.copy(
          source, destination, StandardCopyOption.REPLACE_EXISTING, LinkOption.NOFOLLOW_LINKS);
      return;
    }
    privateDirectory(destination);
    Files.walkFileTree(
        source,
        new SimpleFileVisitor<>() {
          private int count;

          @Override
          public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs)
              throws IOException {
            if (source.relativize(dir).getNameCount() > 128)
              throw new IOException("Backup directory nesting exceeds the supported limit");
            privateDirectory(destination.resolve(source.relativize(dir)));
            return FileVisitResult.CONTINUE;
          }

          @Override
          public FileVisitResult visitFile(Path file, BasicFileAttributes attrs)
              throws IOException {
            if (++count > 100_000) throw new IOException("Backup exceeds the 100,000 file limit");
            if (attrs.isRegularFile()) {
              Path target = destination.resolve(source.relativize(file));
              Files.copy(
                  file, target, StandardCopyOption.REPLACE_EXISTING, LinkOption.NOFOLLOW_LINKS);
              try {
                Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rw-------"));
              } catch (UnsupportedOperationException ignored) {
              }
            }
            return FileVisitResult.CONTINUE;
          }
        });
  }

  static void deleteTree(Path exact) throws IOException {
    if (!Files.exists(exact, LinkOption.NOFOLLOW_LINKS)) return;
    if (exact.toAbsolutePath().normalize().getNameCount() < 3)
      throw new IOException("Refusing to remove a broad filesystem root");
    safeAncestors(exact.getParent());
    Files.walkFileTree(
        exact,
        new SimpleFileVisitor<>() {
          @Override
          public FileVisitResult visitFile(Path file, BasicFileAttributes attributes)
              throws IOException {
            Files.delete(file);
            return FileVisitResult.CONTINUE;
          }

          @Override
          public FileVisitResult postVisitDirectory(Path directory, IOException error)
              throws IOException {
            if (error != null) throw error;
            Files.delete(directory);
            return FileVisitResult.CONTINUE;
          }
        });
  }

  static void replace(Path staged, Path destination) throws IOException {
    safeAncestors(destination);
    Files.move(
        staged, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    try (var channel =
        java.nio.channels.FileChannel.open(destination.getParent(), StandardOpenOption.READ)) {
      channel.force(true);
    } catch (UnsupportedOperationException ignored) {
    }
  }
}
