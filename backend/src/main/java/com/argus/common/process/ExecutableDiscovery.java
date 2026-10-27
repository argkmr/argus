package com.argus.common.process;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** Bounded user-tool discovery for GUI/provider tooling, not project runtime selection. */
public final class ExecutableDiscovery {
  private static final Pattern NODE_VERSION =
      Pattern.compile("v(\\d{1,6})\\.(\\d{1,6})\\.(\\d{1,6})");
  private static final int MAX_VERSION_ENTRIES = 512;
  private static final int MAX_VERSIONS = 64;

  private ExecutableDiscovery() {}

  public static List<String> pathDirectories(Map<String, String> environment, Path home) {
    var directories = new LinkedHashSet<String>();
    for (String entry :
        environment.getOrDefault("PATH", "").split(Pattern.quote(File.pathSeparator)))
      if (!entry.isBlank()) directories.add(entry);
    // Preserve inherited/explicit PATH precedence. These are discovery fallbacks only.
    directories.addAll(List.of("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"));
    directories.add(home.resolve(".local/bin").toString());
    directories.add(home.resolve(".npm-global/bin").toString());
    directories.add(
        managerHome(environment.get("VOLTA_HOME"), home.resolve(".volta"))
            .resolve("bin")
            .toString());
    directories.addAll(nvmBins(managerHome(environment.get("NVM_DIR"), home.resolve(".nvm"))));
    return List.copyOf(directories);
  }

  private static Path managerHome(String configured, Path fallback) {
    try {
      if (configured != null && !configured.isBlank() && Path.of(configured).isAbsolute())
        return Path.of(configured);
    } catch (RuntimeException ignored) {
    }
    return fallback;
  }

  private static List<String> nvmBins(Path root) {
    var versions = new ArrayList<Path>();
    try (var entries = Files.newDirectoryStream(root.resolve("versions/node"))) {
      int count = 0;
      for (Path entry : entries) {
        if (++count > MAX_VERSION_ENTRIES) return List.of();
        if (NODE_VERSION.matcher(entry.getFileName().toString()).matches()) versions.add(entry);
      }
    } catch (IOException | RuntimeException ignored) {
      return List.of();
    }
    versions.sort(
        (left, right) -> {
          String a = left.getFileName().toString(), b = right.getFileName().toString();
          int comparison = CodexExecutableSelector.compareVersions(b, a);
          return comparison == 0 ? a.compareTo(b) : comparison;
        });
    return versions.stream()
        .limit(MAX_VERSIONS)
        .map(version -> version.resolve("bin"))
        .filter(bin -> executableFile(bin.resolve("node").toString()))
        .map(Path::toString)
        .toList();
  }

  public static String resolve(String command, Map<String, String> environment, Path home) {
    if (command == null || command.isBlank()) return "";
    try {
      Path explicit = Path.of(command);
      if (explicit.isAbsolute()) return executableFile(command) ? command : "";
      if (command.contains("/") || command.contains("\\")) return "";
      for (String directory : pathDirectories(environment, home)) {
        Path root;
        try {
          root = Path.of(directory);
        } catch (RuntimeException ignored) {
          continue;
        }
        // Never promote a repository-relative PATH entry to trusted GUI tooling.
        if (!root.isAbsolute()) continue;
        String candidate = root.resolve(command).toString();
        if (executableFile(candidate)) return candidate;
      }
    } catch (RuntimeException ignored) {
    }
    return "";
  }

  public static String providerExecutable(
      String provider, Map<String, String> environment, Path home) {
    String override =
        environment.getOrDefault(
            "ARGUS_" + provider.toUpperCase(java.util.Locale.ROOT) + "_EXECUTABLE", "");
    if (!override.isBlank()) {
      try {
        if (Path.of(override).isAbsolute() && executableFile(override)) return override;
      } catch (RuntimeException ignored) {
      }
    }
    String resolved = resolve(provider, environment, home);
    return resolved.isBlank() ? provider : resolved;
  }

  public static boolean executableFile(String input) {
    try {
      return Files.isRegularFile(Path.of(input)) && Files.isExecutable(Path.of(input));
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  public static void prepareProvider(ProcessBuilder builder) {
    prepareProvider(builder, Path.of(System.getProperty("user.home")));
  }

  static void prepareProvider(ProcessBuilder builder, Path home) {
    var environment = builder.environment();
    var directories = new LinkedHashSet<>(pathDirectories(environment, home));
    String executable = builder.command().get(0);
    String resolved = resolve(executable, environment, home);
    if (!resolved.isBlank()) {
      var command = new ArrayList<>(builder.command());
      command.set(0, resolved);
      builder.command(command);
      // npm-installed CLIs use /usr/bin/env node. Selecting an nvm CLI without
      // its sibling Node can fail or silently run it under an unrelated version.
      Path bin = Path.of(resolved).getParent();
      if (bin != null && executableFile(bin.resolve("node").toString())) {
        var companionFirst = new LinkedHashSet<String>();
        companionFirst.add(bin.toString());
        companionFirst.addAll(directories);
        directories = companionFirst;
      }
    }
    environment.put("PATH", String.join(File.pathSeparator, directories));
  }
}
