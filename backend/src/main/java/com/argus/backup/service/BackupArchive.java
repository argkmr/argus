package com.argus.backup.service;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.HashSet;
import org.apache.commons.compress.archivers.tar.*;
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream;
import org.apache.commons.compress.compressors.gzip.GzipCompressorOutputStream;

/** Streaming tar.gz compatible with prior Argus backups; only bounded regular files/directories. */
public final class BackupArchive {
  private static final long MAX_BYTES = 8L * 1024 * 1024 * 1024;
  private static final long MAX_FILE_BYTES = 1024L * 1024 * 1024;
  private static final int MAX_ENTRIES = 100_000;

  private BackupArchive() {}

  public static void create(Path root, Path destination) {
    try {
      BackupFiles.safeAncestors(root);
      BackupFiles.safeAncestors(destination);
      try (var output = Files.newOutputStream(destination, StandardOpenOption.CREATE_NEW);
          var gzip = new GzipCompressorOutputStream(output);
          var tar = new TarArchiveOutputStream(gzip)) {
        tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX);
        tar.setBigNumberMode(TarArchiveOutputStream.BIGNUMBER_POSIX);
        long total = 0, deadline = System.nanoTime() + Duration.ofMinutes(5).toNanos();
        int entries = 0;
        try (var directories = Files.walk(root, 128)) {
          for (Path directory :
              directories
                  .filter(
                      path ->
                          !path.equals(root) && Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
                  .limit(MAX_ENTRIES + 1L)
                  .toList()) {
            if (++entries > MAX_ENTRIES) throw new IOException("Backup exceeds the entry limit");
            check(total, 0, deadline);
            var entry =
                new TarArchiveEntry(
                    root.relativize(directory).toString().replace(File.separatorChar, '/') + "/");
            entry.setMode(0700);
            entry.setModTime(
                Files.getLastModifiedTime(directory, LinkOption.NOFOLLOW_LINKS).toMillis());
            tar.putArchiveEntry(entry);
            tar.closeArchiveEntry();
          }
        }
        for (Path file : BackupFiles.files(root)) {
          if (++entries > MAX_ENTRIES) throw new IOException("Backup exceeds the entry limit");
          long size = Files.size(file);
          total += size;
          check(total, size, deadline);
          String name = root.relativize(file).toString().replace(File.separatorChar, '/');
          var entry = new TarArchiveEntry(name);
          entry.setSize(size);
          entry.setMode(0600);
          entry.setModTime(Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS).toMillis());
          tar.putArchiveEntry(entry);
          try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            byte[] buffer = new byte[65536];
            long copied = 0;
            int count;
            while ((count = input.read(buffer)) >= 0) {
              copied += count;
              check(total - size + copied, copied, deadline);
              if (copied > size)
                throw new IOException("A backup source changed while being archived");
              tar.write(buffer, 0, count);
            }
            if (copied != size)
              throw new IOException("A backup source changed while being archived");
          }
          tar.closeArchiveEntry();
        }
        tar.finish();
      }
      Files.setPosixFilePermissions(destination, PosixFilePermissions.fromString("rw-------"));
    } catch (IOException error) {
      throw new IllegalStateException(
          "Could not create private backup archive: " + error.getMessage(), error);
    }
  }

  public static void extract(Path archive, Path destination) {
    extract(archive, destination, MAX_BYTES, MAX_ENTRIES);
  }

  static void extract(Path archive, Path destination, long maxBytes, int maxEntries) {
    try {
      BackupFiles.safeAncestors(archive);
      BackupFiles.safeAncestors(destination);
      if (Files.size(archive) > MAX_BYTES)
        throw new IOException("Backup archive exceeds the supported size limit");
      BackupFiles.privateDirectory(destination);
      try (var children = Files.list(destination)) {
        if (children.findAny().isPresent())
          throw new IOException("Backup extraction requires an empty private staging directory");
      }
      long deadline = System.nanoTime() + Duration.ofMinutes(5).toNanos();
      var seen = new HashSet<Path>();
      long total = 0;
      int entries = 0;
      try (var input = Files.newInputStream(archive, LinkOption.NOFOLLOW_LINKS);
          var gzip = new GzipCompressorInputStream(input);
          var bounded = new LimitedInput(gzip, maxBytes + 128L * 1024 * 1024, deadline);
          var framed = new TarSafetyInput(bounded);
          var tar = new TarArchiveInputStream(framed)) {
        TarArchiveEntry entry;
        while ((entry = tar.getNextEntry()) != null) {
          if (++entries > maxEntries || System.nanoTime() > deadline)
            throw new IOException("Backup archive exceeds entry or processing limits");
          String raw = entry.getName();
          while (raw.startsWith("./")) raw = raw.substring(2);
          if (raw.isEmpty() || raw.equals(".")) {
            if (entry.isDirectory()) continue;
            throw new IOException("Invalid backup entry");
          }
          if (raw.length() > 4096
              || raw.startsWith("/")
              || raw.contains("\\")
              || raw.indexOf('\0') >= 0
              || raw.matches("^[A-Za-z]:.*")) throw new IOException("Unsafe backup archive path");
          Path relative = Path.of(raw);
          for (Path part : relative)
            if (part.toString().equals(".."))
              throw new IOException("Backup archive path escapes staging");
          Path target = destination.resolve(relative).normalize();
          if (target.equals(destination)
              || !target.startsWith(destination)
              || relative.getNameCount() > 128
              || !seen.add(target))
            throw new IOException("Duplicate or unsafe backup archive entry");
          if (!entry.isCheckSumOK()
              || entry.isSymbolicLink()
              || entry.isLink()
              || entry.isSparse()
              || (!entry.isFile() && !entry.isDirectory()))
            throw new IOException("Backup archives may contain only regular files and directories");
          long size = entry.getSize();
          if (size < 0 || size > MAX_FILE_BYTES || total + size > maxBytes)
            throw new IOException("Backup archive exceeds expanded size limits");
          BackupFiles.safeAncestors(target);
          if (entry.isDirectory()) {
            BackupFiles.privateDirectory(target);
            continue;
          }
          total += size;
          BackupFiles.privateDirectory(target.getParent());
          try (var output =
              Files.newOutputStream(
                  target, StandardOpenOption.CREATE_NEW, LinkOption.NOFOLLOW_LINKS)) {
            Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rw-------"));
            byte[] buffer = new byte[65536];
            int count;
            long copied = 0;
            while ((count = tar.read(buffer)) >= 0) {
              copied += count;
              if (copied > size || System.nanoTime() > deadline)
                throw new IOException("Invalid or oversized backup file");
              output.write(buffer, 0, count);
            }
            if (copied != size) throw new IOException("Truncated backup archive");
          }
        }
      }
    } catch (IOException error) {
      throw new IllegalArgumentException(
          "Cannot safely restore this backup: " + error.getMessage(), error);
    }
  }

  private static void check(long total, long size, long deadline) throws IOException {
    if (size > MAX_FILE_BYTES
        || total > MAX_BYTES
        || System.nanoTime() > deadline
        || Thread.currentThread().isInterrupted())
      throw new IOException("Backup exceeds size or processing limits");
  }

  /** Reject oversized PAX/GNU metadata before the tar library allocates metadata strings. */
  private static final class TarSafetyInput extends InputStream {
    private final InputStream source;
    private byte[] header;
    private int headerOffset, headers;
    private long payload, metadataBytes;

    TarSafetyInput(InputStream source) {
      this.source = source;
    }

    @Override
    public int read() throws IOException {
      byte[] one = new byte[1];
      return read(one, 0, 1) < 0 ? -1 : one[0] & 255;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      if (length == 0) return 0;
      if (header == null && payload == 0) {
        header = source.readNBytes(512);
        headerOffset = 0;
        if (header.length == 0) {
          header = null;
          return -1;
        }
        if (header.length != 512) throw new IOException("Truncated tar header");
        long size;
        try {
          size = TarUtils.parseOctalOrBinary(header, 124, 12);
        } catch (RuntimeException error) {
          throw new IOException("Invalid tar entry size", error);
        }
        int type = header[156] & 255;
        if (++headers > MAX_ENTRIES * 3)
          throw new IOException("Tar archive contains too many headers");
        if (size < 0 || size > MAX_FILE_BYTES)
          throw new IOException("Tar entry exceeds the supported limit");
        if (type == 'x' || type == 'g' || type == 'L' || type == 'K') {
          metadataBytes += size;
          if (size > 1024 * 1024 || metadataBytes > 64L * 1024 * 1024)
            throw new IOException("Tar metadata exceeds its safety limit");
        }
        if (type == 'S') throw new IOException("Sparse tar entries cannot be restored safely");
        payload = ((size + 511) / 512) * 512;
      }
      if (header != null) {
        int count = Math.min(length, 512 - headerOffset);
        System.arraycopy(header, headerOffset, buffer, offset, count);
        headerOffset += count;
        if (headerOffset == 512) header = null;
        return count;
      }
      int count = source.read(buffer, offset, (int) Math.min(length, payload));
      if (count < 0) throw new IOException("Truncated tar payload");
      payload -= count;
      return count;
    }

    @Override
    public void close() throws IOException {
      source.close();
    }
  }

  private static final class LimitedInput extends FilterInputStream {
    private final long max, deadline;
    private long count;

    LimitedInput(InputStream input, long max, long deadline) {
      super(input);
      this.max = max;
      this.deadline = deadline;
    }

    private void count(long bytes) throws IOException {
      count += Math.max(0, bytes);
      if (count > max || System.nanoTime() > deadline)
        throw new IOException("Backup decompression exceeds safety limits");
    }

    @Override
    public int read() throws IOException {
      int result = super.read();
      count(result < 0 ? 0 : 1);
      return result;
    }

    @Override
    public int read(byte[] bytes, int offset, int length) throws IOException {
      int result = in.read(bytes, offset, length);
      count(result);
      return result;
    }

    @Override
    public long skip(long length) throws IOException {
      byte[] buffer = new byte[(int) Math.min(65536, length)];
      long skipped = 0;
      while (skipped < length) {
        int read = read(buffer, 0, (int) Math.min(buffer.length, length - skipped));
        if (read < 0) break;
        skipped += read;
      }
      return skipped;
    }
  }
}
