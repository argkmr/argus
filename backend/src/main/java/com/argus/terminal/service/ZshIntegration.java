package com.argus.terminal.service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.Map;

/** Private startup shims; the user's dotfiles are sourced, never edited. */
final class ZshIntegration implements AutoCloseable {
  private static final List<String> FILES =
      List.of(".zshenv", ".zprofile", ".zshrc", ".zlogin", "cwd");
  final Path directory;

  private ZshIntegration(Path directory) {
    this.directory = directory;
  }

  static ZshIntegration create(Map<String, String> environment) throws IOException {
    Path directory =
        Files.createTempDirectory(
            "argus-zsh-",
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    var integration = new ZshIntegration(directory);
    try {
      for (String name : FILES) {
        if (name.equals("cwd")) continue;
        try (InputStream resource =
            ZshIntegration.class.getResourceAsStream("/terminal/zsh/" + name)) {
          if (resource == null) throw new IOException("Missing zsh integration resource " + name);
          Files.copy(resource, directory.resolve(name));
        }
        Files.setPosixFilePermissions(
            directory.resolve(name), PosixFilePermissions.fromString("rw-------"));
      }
      environment.put("ARGUS_ORIGINAL_ZDOTDIR_SET", environment.containsKey("ZDOTDIR") ? "1" : "0");
      environment.put(
          "ARGUS_ORIGINAL_ZDOTDIR",
          environment.getOrDefault(
              "ZDOTDIR", environment.getOrDefault("HOME", System.getProperty("user.home"))));
      environment.put("ARGUS_ZSH_INTEGRATION", directory.toString());
      environment.put("ZDOTDIR", directory.toString());
      return integration;
    } catch (IOException error) {
      integration.close();
      throw error;
    }
  }

  String cwd(String fallback) {
    Path file = directory.resolve("cwd");
    try {
      if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) && Files.size(file) <= 32768) {
        String value = Files.readString(file, StandardCharsets.UTF_8);
        if (!value.isEmpty() && value.startsWith("/")) return value;
      }
    } catch (IOException ignored) {
      // A prompt may be publishing its next cwd while status is polled.
    }
    return fallback;
  }

  @Override
  public void close() {
    // Delete only files we created, not arbitrary paths or recursive contents.
    for (String name : FILES) {
      try {
        Files.deleteIfExists(directory.resolve(name));
      } catch (IOException ignored) {
      }
    }
    try {
      Files.deleteIfExists(directory);
    } catch (IOException ignored) {
    }
  }
}
