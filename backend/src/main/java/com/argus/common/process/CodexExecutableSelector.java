package com.argus.common.process;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/** Selects the newest installed CLI without relying on the first executable in PATH. */
@Component
public class CodexExecutableSelector {
  private static final Pattern VERSION = Pattern.compile("(\\d+)\\.(\\d+)\\.(\\d+)(?:-([^\\s]+))?");
  private static final List<String> DESKTOP_EXECUTABLE_PATHS =
      List.of(
          "Contents/Resources/codex",
          "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  private String selected;
  private long checkedAt;

  public synchronized String executable() {
    if (selected == null || System.nanoTime() - checkedAt > Duration.ofSeconds(60).toNanos()) {
      selected =
          select(
              System.getenv(),
              List.of(
                  Path.of("/Applications"),
                  Path.of(System.getProperty("user.home"), "Applications")),
              CodexExecutableSelector::executableFile,
              this::versionOf);
      checkedAt = System.nanoTime();
    }
    return selected;
  }

  static String select(
      Map<String, String> environment,
      List<Path> applicationDirectories,
      Predicate<String> executable,
      Function<String, String> versionOf) {
    return select(
        environment,
        applicationDirectories,
        executable,
        versionOf,
        Path.of(System.getProperty("user.home")));
  }

  static String select(
      Map<String, String> environment,
      List<Path> applicationDirectories,
      Predicate<String> executable,
      Function<String, String> versionOf,
      Path home) {
    String override = environment.getOrDefault("ARGUS_CODEX_EXECUTABLE", "");
    if (!override.isBlank() && executable.test(override)) return override;
    LinkedHashSet<String> candidates = new LinkedHashSet<>();
    for (String directory :
        environment.getOrDefault("PATH", "").split(Pattern.quote(java.io.File.pathSeparator))) {
      if (directory.isBlank()) continue;
      try {
        candidates.add(Path.of(directory, "codex").toString());
      } catch (RuntimeException ignored) {
      }
    }
    // Newer desktop apps ship a nested CodexCLI bundle. Keep all legacy paths
    // first so adding the new layout does not change existing equal-version ties.
    for (String relativeExecutable : DESKTOP_EXECUTABLE_PATHS)
      for (Path directory : applicationDirectories)
        for (String app : List.of("Codex.app", "ChatGPT.app"))
          candidates.add(directory.resolve(app).resolve(relativeExecutable).toString());
    // Existing PATH and desktop-app candidates keep precedence when versions tie.
    for (String directory : ExecutableDiscovery.pathDirectories(environment, home)) {
      try {
        if (Path.of(directory).isAbsolute()) candidates.add(Path.of(directory, "codex").toString());
      } catch (RuntimeException ignored) {
      }
    }
    String selected = "codex";
    String selectedVersion = "";
    for (String candidate : candidates) {
      if (!executable.test(candidate)) continue;
      String version;
      try {
        version = versionOf.apply(candidate);
      } catch (RuntimeException ignored) {
        continue;
      }
      if (version == null || !VERSION.matcher(version).find()) continue;
      if (selectedVersion.isBlank() || compareVersions(version, selectedVersion) > 0) {
        selected = candidate;
        selectedVersion = version;
      }
    }
    return selected;
  }

  static int compareVersions(String left, String right) {
    Matcher a = VERSION.matcher(left);
    Matcher b = VERSION.matcher(right);
    boolean foundA = a.find();
    boolean foundB = b.find();
    if (!foundA || !foundB) return Boolean.compare(foundA, foundB);
    for (int i = 1; i <= 3; i++) {
      int result =
          new java.math.BigInteger(a.group(i)).compareTo(new java.math.BigInteger(b.group(i)));
      if (result != 0) return result;
    }
    String prereleaseA = a.group(4);
    String prereleaseB = b.group(4);
    if ((prereleaseA == null) != (prereleaseB == null)) return prereleaseA == null ? 1 : -1;
    if (prereleaseA == null) return 0;
    String[] partsA = prereleaseA.split("(?<=\\D)(?=\\d)|(?<=\\d)(?=\\D)");
    String[] partsB = prereleaseB.split("(?<=\\D)(?=\\d)|(?<=\\d)(?=\\D)");
    for (int i = 0; i < Math.min(partsA.length, partsB.length); i++) {
      int result =
          partsA[i].matches("\\d+") && partsB[i].matches("\\d+")
              ? new java.math.BigInteger(partsA[i]).compareTo(new java.math.BigInteger(partsB[i]))
              : partsA[i].compareToIgnoreCase(partsB[i]);
      if (result != 0) return result;
    }
    return Integer.compare(partsA.length, partsB.length);
  }

  private static boolean executableFile(String input) {
    try {
      Path path = Path.of(input);
      return Files.isRegularFile(path) && Files.isExecutable(path);
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private String versionOf(String file) {
    var builder = new ProcessBuilder(file, "--version");
    ExecutableDiscovery.prepareProvider(builder);
    try (OwnedProcess process = new OwnedProcess(builder, null, 8192)) {
      process.closeInput();
      CommandResult result = process.await(Duration.ofSeconds(2));
      return result.exitCode() == 0 ? result.stdout().trim() : "";
    } catch (Exception ignored) {
      return "";
    }
  }
}
