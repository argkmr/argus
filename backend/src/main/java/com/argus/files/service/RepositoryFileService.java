package com.argus.files.service;

import com.argus.common.error.ConflictException;
import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandRunner;
import com.argus.files.dto.RepositoryFileResponse;
import com.argus.files.dto.SearchResult;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class RepositoryFileService {
  private static final long MAX_FILE_SIZE = 2L * 1024 * 1024;
  private final CommandRunner commands;

  public RepositoryFileService(CommandRunner commands) {
    this.commands = commands;
  }

  public List<String> list(Path root, int limit) {
    String output =
        commands
            .run(
                "rg",
                List.of("--files", "--hidden", "--glob", "!.git/**", "--glob", "!.argus-data/**"),
                root,
                Duration.ofSeconds(30))
            .stdout();
    return Arrays.stream(output.split("\\R")).filter(line -> !line.isBlank()).limit(limit).toList();
  }

  public List<SearchResult> search(Path root, String query, int limit) {
    if (query == null || query.isBlank()) return List.of();
    String output;
    try {
      output =
          commands
              .run(
                  "rg",
                  List.of(
                      "--line-number",
                      "--column",
                      "--no-heading",
                      "--color",
                      "never",
                      "--smart-case",
                      "--glob",
                      "!.git/**",
                      "--glob",
                      "!.argus-data/**",
                      "--",
                      query,
                      "."),
                  root,
                  Duration.ofSeconds(30))
              .stdout();
    } catch (CommandFailedException error) {
      if (error.result().exitCode() == 1) return List.of();
      throw error;
    }
    return Arrays.stream(output.split("\\R"))
        .filter(line -> !line.isBlank())
        .limit(limit)
        .map(this::searchResult)
        .toList();
  }

  public RepositoryFileResponse read(Path root, String requested) {
    Path file = safeFile(root, requested);
    try {
      long size = Files.size(file);
      if (size > MAX_FILE_SIZE) throw new IllegalArgumentException("File is larger than 2 MB");
      String content = Files.readString(file);
      return new RepositoryFileResponse(
          root.toRealPath().relativize(file).toString(), content, hash(content), size);
    } catch (IOException error) {
      throw new IllegalStateException("Could not read file", error);
    }
  }

  public RepositoryFileResponse write(
      Path root, String requested, String content, String expectedHash) {
    Path file = safeFile(root, requested);
    String next = content == null ? "" : content;
    if (next.indexOf('\0') >= 0)
      throw new IllegalArgumentException("Binary files cannot be edited in the diff viewer");
    if (next.getBytes(StandardCharsets.UTF_8).length > MAX_FILE_SIZE)
      throw new IllegalArgumentException("File is larger than 2 MB");
    try {
      String current = Files.readString(file);
      if (expectedHash != null && !expectedHash.isBlank() && !hash(current).equals(expectedHash))
        throw new ConflictException(
            "This file changed after the diff was opened. Reload the diff before saving.");
      Path temporary =
          file.resolveSibling("." + file.getFileName() + ".argus-" + UUID.randomUUID() + ".tmp");
      Files.writeString(temporary, next);
      try {
        Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(file);
        Files.setPosixFilePermissions(temporary, permissions);
      } catch (UnsupportedOperationException ignored) {
      }
      Files.move(
          temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
      return new RepositoryFileResponse(
          root.toRealPath().relativize(file).toString(),
          null,
          hash(next),
          next.getBytes(StandardCharsets.UTF_8).length);
    } catch (IOException error) {
      throw new IllegalStateException("Could not save file", error);
    }
  }

  private Path safeFile(Path root, String requested) {
    if (requested == null || requested.isBlank() || requested.indexOf('\0') >= 0)
      throw new IllegalArgumentException("A file path is required");
    try {
      Path realRoot = root.toRealPath();
      Path file = realRoot.resolve(requested).normalize().toRealPath();
      if (!file.startsWith(realRoot))
        throw new IllegalArgumentException("File must be inside the repository");
      if (!Files.isRegularFile(file)) throw new IllegalArgumentException("Not a file");
      return file;
    } catch (IOException error) {
      throw new IllegalArgumentException("File does not exist", error);
    }
  }

  private SearchResult searchResult(String value) {
    java.util.regex.Matcher match =
        java.util.regex.Pattern.compile("^\\./(.*?):(\\d+):(\\d+):(.*)$").matcher(value);
    return match.matches()
        ? new SearchResult(
            match.group(1),
            Integer.valueOf(match.group(2)),
            Integer.valueOf(match.group(3)),
            match.group(4).trim())
        : new SearchResult(null, null, null, value);
  }

  private String hash(String content) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(content.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
