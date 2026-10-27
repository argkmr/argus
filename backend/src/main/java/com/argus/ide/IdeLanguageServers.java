package com.argus.ide;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.NotFoundException;
import com.argus.common.process.OwnedProcess;
import com.argus.workspace.service.WorkspaceService;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Component;

/** Commands are never read from repository files; Node's version probe is cached. */
@Component
public class IdeLanguageServers {
  static final List<String> LANGUAGES =
      List.of("java", "typescript", "python", "go", "rust", "cpp");
  private final WorkspaceService workspace;
  private final Path cacheRoot;
  private final Path bundledJavaHome;
  private static final Map<String, Boolean> NODE_COMPATIBILITY =
      new java.util.concurrent.ConcurrentHashMap<>();

  public record Command(
      String language, String label, String executable, List<String> args, String notice) {
    boolean available() {
      return !executable.isBlank();
    }

    List<String> argv() {
      var command = new ArrayList<String>();
      command.add(executable);
      command.addAll(args);
      return command;
    }
  }

  @org.springframework.beans.factory.annotation.Autowired
  public IdeLanguageServers(WorkspaceService workspace, ArgusProperties properties) {
    this(workspace, properties, jdtlsHome());
  }

  IdeLanguageServers(WorkspaceService workspace, ArgusProperties properties, Path bundledJavaHome) {
    this.workspace = workspace;
    this.cacheRoot = properties.dataDirectory().resolve("ide");
    this.bundledJavaHome = bundledJavaHome;
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> configured(String id, String language) {
    Object value = workspace.snapshot().preferences().get("ideLanguageServers");
    if (value instanceof Map<?, ?> all
        && all.get(id) instanceof Map<?, ?> repository
        && repository.get(language) instanceof Map<?, ?> command)
      return (Map<String, Object>) command;
    return Map.of();
  }

  /**
   * Trust is an explicit local choice, not a property of an executable or repository file. Bind it
   * to both the repository identity and its real root so reconnecting or relocating a repository
   * cannot silently reuse another project's permission to execute build configuration.
   */
  public synchronized boolean trustedProject(String id, String language) {
    return trustedProjectAtRoot(id, language, null);
  }

  /** The launch path was already resolved; never transfer a grant to a different snapshot. */
  public synchronized boolean trustedProject(String id, String language, Path launchRoot) {
    if (launchRoot == null) return false;
    return trustedProjectAtRoot(id, language, launchRoot);
  }

  private boolean trustedProjectAtRoot(String id, String language, Path launchRoot) {
    if (!"java".equals(canonical(language))) return false;
    var all = map(workspace.snapshot().preferences().get("ideProjectTrust"));
    var repository = map(all.get(id));
    var grant = map(repository.get("java"));
    if (!Boolean.TRUE.equals(grant.get("trusted"))) return false;
    try {
      Path real = canonicalRoot(id);
      return (launchRoot == null || real.equals(launchRoot))
          && real.toString().equals(grant.get("root"));
    } catch (IllegalArgumentException | NotFoundException | SecurityException error) {
      // Missing, invalid, or inaccessible repositories never inherit trust.
      return false;
    }
  }

  /** Called only for the user's explicit Java start/restart trust choice. */
  public synchronized void setTrustedProject(String id, String language, boolean trusted) {
    if (!"java".equals(canonical(language))) return;
    var all = map(workspace.snapshot().preferences().get("ideProjectTrust"));
    var repository = map(all.get(id));
    if (trusted) {
      repository.put("java", Map.of("root", canonicalRoot(id).toString(), "trusted", true));
    } else {
      repository.remove("java");
    }
    if (repository.isEmpty()) all.remove(id);
    else all.put(id, repository);
    workspace.preferences(Map.of("ideProjectTrust", all));
  }

  private Path canonicalRoot(String id) {
    try {
      Path root = Path.of(workspace.requireRepository(id).path());
      if (!root.isAbsolute())
        throw new IllegalArgumentException("Repository root must be absolute");
      Path real = root.toRealPath();
      if (!Files.isDirectory(real))
        throw new IllegalArgumentException("Repository is not a directory");
      return real;
    } catch (IOException error) {
      throw new IllegalArgumentException("Repository root is unavailable", error);
    }
  }

  public synchronized void configure(
      String id, String language, String executable, List<String> arguments) {
    language = canonical(language);
    if (executable == null || executable.isBlank())
      throw new IllegalArgumentException("Language server executable is required");
    if (executable.length() > 4096 || executable.indexOf('\0') >= 0)
      throw new IllegalArgumentException("Invalid executable");
    Path requested = Path.of(executable);
    if (!requested.isAbsolute() && (executable.contains("/") || executable.contains("\\")))
      throw new IllegalArgumentException("Use an absolute executable path or a command on PATH");
    String name = requested.getFileName().toString().toLowerCase(java.util.Locale.ROOT);
    if (Set.of(
            "sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh")
        .contains(name))
      throw new IllegalArgumentException("Configure a language server executable, not a shell");
    List<String> args = arguments == null ? List.of() : List.copyOf(arguments);
    if (args.size() > 32
        || args.stream()
            .anyMatch(arg -> arg == null || arg.length() > 4096 || arg.indexOf('\0') >= 0))
      throw new IllegalArgumentException("Invalid language server argument array");
    var all = map(workspace.snapshot().preferences().get("ideLanguageServers"));
    var repository = map(all.get(id));
    repository.put(language, Map.of("executable", executable, "args", args));
    all.put(id, repository);
    workspace.preferences(Map.of("ideLanguageServers", all));
  }

  public Command discover(String id, String requested) {
    String language = canonical(requested);
    var config = configured(id, language);
    if (!config.isEmpty()) {
      String supplied = String.valueOf(config.getOrDefault("executable", ""));
      List<String> args =
          config.get("args") instanceof List<?> list
              ? list.stream().map(String::valueOf).toList()
              : List.of();
      String executable = executable(supplied);
      return new Command(
          language,
          label(language),
          executable,
          args,
          executable.isBlank()
              ? "Configured executable is unavailable: " + supplied
              : "Uses your configured language server.");
    }
    if ("typescript".equals(language)) {
      String script = System.getenv("ARGUS_IDE_TYPESCRIPT_SERVER");
      String node = executable("node");
      if (script != null && Path.of(script).isAbsolute() && Files.isRegularFile(Path.of(script))) {
        if (node.isBlank() || !compatibleNode(node))
          return new Command(
              language,
              label(language),
              "",
              List.of(),
              "Bundled TypeScript language server requires Node 22.22.2+ (or a newer major release).");
        String sdk = System.getenv("ARGUS_IDE_TYPESCRIPT_SDK");
        if (sdk == null || !Path.of(sdk).isAbsolute() || !Files.isRegularFile(Path.of(sdk)))
          return new Command(
              language,
              label(language),
              "",
              List.of(),
              "Bundled TypeScript SDK is unavailable; repair the IDE tools installation.");
        return new Command(
            language,
            label(language),
            node,
            List.of(script, "--stdio"),
            "Bundled TypeScript language server; starts on demand.");
      }
    }
    if ("java".equals(language)) {
      Path home = bundledJavaHome;
      String java = javaRuntime();
      if (home != null && !java.isBlank()) {
        Path launcher = launcher(home);
        if (launcher != null)
          return new Command(
              language,
              label(language),
              java,
              List.of(
                  "-Declipse.application=org.eclipse.jdt.ls.core.id1",
                  "-Dosgi.bundles.defaultStartLevel=4",
                  "-Declipse.product=org.eclipse.jdt.ls.core.product",
                  "-Djava.import.generatesMetadataFilesAtProjectRoot=false",
                  "-Xmx768m",
                  "--add-modules=ALL-SYSTEM",
                  "--add-opens",
                  "java.base/java.util=ALL-UNNAMED",
                  "--add-opens",
                  "java.base/java.lang=ALL-UNNAMED",
                  "-jar",
                  launcher.toString(),
                  "-configuration",
                  javaCache(id).resolve("configuration").toString(),
                  "-data",
                  javaCache(id).resolve("workspace").toString()),
              "Bundled Eclipse JDT LS. Build import stays disabled until you trust this project.");
      }
    }
    String binary =
        switch (language) {
          case "java" -> "jdtls";
          case "typescript" -> "typescript-language-server";
          case "python" -> "pyright-langserver";
          case "go" -> "gopls";
          case "rust" -> "rust-analyzer";
          default -> "clangd";
        };
    String executable = executable(binary);
    List<String> args =
        switch (language) {
          case "typescript", "python" -> List.of("--stdio");
          case "java" ->
              List.of(
                  "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false",
                  "-data",
                  javaCache(id).resolve("workspace").toString());
          default -> List.of();
        };
    return new Command(
        language,
        label(language),
        executable,
        args,
        executable.isBlank()
            ? "Install "
                + binary
                + ("java".equals(language)
                    ? " and JDK 21+, or configure its executable."
                    : ", or configure its executable.")
            : "Local " + binary + "; starts only on demand.");
  }

  public void prepare(String id, Command command) {
    if (!"java".equals(command.language())) return;
    // Saving the prefilled bundled command must not disable preparation of its private
    // Eclipse configuration. Truly custom commands/configuration directories remain untouched.
    if (!configured(id, "java").isEmpty() && !usesBundledJavaCache(id, command)) return;
    try {
      requirePrivateCache(javaCache(id).resolve("workspace"));
      Files.createDirectories(javaCache(id).resolve("workspace"));
      if (!command.args().contains("-configuration")) return;
      Path home = bundledJavaHome;
      if (home == null)
        throw new IllegalStateException("Bundled Java language server is unavailable");
      String os = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);
      String arch = System.getProperty("os.arch", "");
      String suffix = os.contains("mac") ? "mac" : os.contains("win") ? "win" : "linux";
      if ("aarch64".equals(arch) || "arm64".equals(arch)) suffix += "_arm";
      Path source = home.resolve("config_" + suffix);
      if (!Files.isDirectory(source))
        throw new IllegalStateException(
            "Bundled JDT LS configuration is missing for this platform");
      Path target = javaCache(id).resolve("configuration");
      requirePrivateCache(target);
      try (var paths = Files.walk(source, 5)) {
        for (Path item : paths.limit(1000).toList()) {
          if (Files.isSymbolicLink(item)) continue;
          Path destination = target.resolve(source.relativize(item));
          requirePrivateCache(destination);
          if (Files.isDirectory(item)) Files.createDirectories(destination);
          else if (!Files.exists(destination) || item.getFileName().toString().equals("config.ini"))
            Files.copy(
                item,
                destination,
                StandardCopyOption.COPY_ATTRIBUTES,
                StandardCopyOption.REPLACE_EXISTING);
        }
      }
    } catch (IOException error) {
      throw new IllegalStateException(
          "Could not prepare private Java language-server workspace", error);
    }
  }

  public String logDirectory(String id, Command command) {
    return "java".equals(command.language()) && usesBundledJavaCache(id, command)
        ? javaCache(id).resolve("configuration").toString()
        : "";
  }

  private boolean usesBundledJavaCache(String id, Command command) {
    if (bundledJavaHome == null) return false;
    String jar = operand(command.args(), "-jar"),
        config = operand(command.args(), "-configuration"),
        data = operand(command.args(), "-data");
    if (jar.isBlank() || config.isBlank() || data.isBlank()) return false;
    try {
      Path launcher = Path.of(jar);
      return launcher
              .getFileName()
              .toString()
              .matches("org\\.eclipse\\.equinox\\.launcher_[^/]+\\.jar")
          && sameLocation(launcher.getParent(), bundledJavaHome.resolve("plugins"))
          && sameLocation(Path.of(config), javaCache(id).resolve("configuration"))
          && sameLocation(Path.of(data), javaCache(id).resolve("workspace"));
    } catch (RuntimeException error) {
      return false;
    }
  }

  private static String operand(List<String> args, String flag) {
    int index = args.indexOf(flag);
    return index >= 0 && index == args.lastIndexOf(flag) && index + 1 < args.size()
        ? args.get(index + 1)
        : "";
  }

  private static boolean sameLocation(Path left, Path right) {
    if (left == null || !left.isAbsolute()) return false;
    if (left.normalize().equals(right.toAbsolutePath().normalize())) return true;
    try {
      return Files.isSameFile(left, right);
    } catch (IOException error) {
      return false;
    }
  }

  private void requirePrivateCache(Path requested) {
    Path base = cacheRoot.toAbsolutePath().normalize(),
        target = requested.toAbsolutePath().normalize();
    if (!target.startsWith(base))
      throw new IllegalStateException("Invalid Java language-server cache path");
    Path current = base;
    if (Files.isSymbolicLink(current))
      throw new IllegalStateException("Java language-server cache is a symlink");
    for (Path segment : base.relativize(target)) {
      current = current.resolve(segment);
      if (Files.isSymbolicLink(current))
        throw new IllegalStateException("Java language-server cache contains a symlink");
    }
  }

  /** Remove only the hashed Argus-owned cache after its language workers have joined. */
  public synchronized void purgeRepository(String id) {
    var all = map(workspace.snapshot().preferences().get("ideLanguageServers"));
    var trust = map(workspace.snapshot().preferences().get("ideProjectTrust"));
    var updates = new LinkedHashMap<String, Object>();
    if (all.remove(id) != null) updates.put("ideLanguageServers", all);
    if (trust.remove(id) != null) updates.put("ideProjectTrust", trust);
    if (!updates.isEmpty()) workspace.preferences(updates);
    Path directory = javaCache(id).getParent().toAbsolutePath().normalize();
    Path parent = cacheRoot.toAbsolutePath().normalize();
    if (!directory.getParent().equals(parent)
        || !directory.getFileName().toString().matches("[a-f0-9]{32}"))
      throw new IllegalStateException("Invalid IDE cache deletion target");
    // A substituted root must never redirect cleanup into a source repository.
    if (Files.isSymbolicLink(parent))
      throw new IllegalStateException("IDE cache root is a symlink");
    if (!Files.exists(directory, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return;
    try {
      Files.walkFileTree(
          directory,
          new java.nio.file.SimpleFileVisitor<>() {
            @Override
            public java.nio.file.FileVisitResult visitFile(
                Path file, java.nio.file.attribute.BasicFileAttributes attrs) throws IOException {
              Files.delete(file);
              return java.nio.file.FileVisitResult.CONTINUE;
            }

            @Override
            public java.nio.file.FileVisitResult postVisitDirectory(Path folder, IOException error)
                throws IOException {
              if (error != null) throw error;
              Files.delete(folder);
              return java.nio.file.FileVisitResult.CONTINUE;
            }
          });
    } catch (IOException error) {
      throw new IllegalStateException("Could not remove repository IDE cache", error);
    }
  }

  private Path javaCache(String id) {
    // Repository ids are opaque; never use them directly as directory paths.
    return cacheRoot.resolve(IdeFiles.hash(id).substring(0, 32)).resolve("java");
  }

  private static Path jdtlsHome() {
    String value = System.getenv("ARGUS_IDE_JDTLS_HOME");
    if (value == null || value.isBlank()) return null;
    Path home = Path.of(value);
    return home.isAbsolute() && Files.isDirectory(home) ? home : null;
  }

  private static Path launcher(Path home) {
    try (var files =
        Files.newDirectoryStream(home.resolve("plugins"), "org.eclipse.equinox.launcher_*.jar")) {
      for (Path file : files) if (Files.isRegularFile(file)) return file;
    } catch (IOException ignored) {
    }
    return null;
  }

  private static String javaRuntime() {
    var homes = new LinkedHashSet<Path>();
    for (String value :
        List.of(
            System.getenv().getOrDefault("ARGUS_IDE_JAVA_HOME", ""),
            System.getenv().getOrDefault("JAVA_HOME", ""),
            System.getProperty("java.home", ""))) if (!value.isBlank()) homes.add(Path.of(value));
    for (Path directory :
        List.of(
            Path.of("/Library/Java/JavaVirtualMachines"),
            Path.of(System.getProperty("user.home"), "Library/Java/JavaVirtualMachines"))) {
      if (!Files.isDirectory(directory)) continue;
      try (var entries = Files.list(directory)) {
        entries.limit(30).forEach(item -> homes.add(item.resolve("Contents/Home")));
      } catch (IOException ignored) {
      }
    }
    for (Path home : homes) {
      try {
        Path release = home.resolve("release");
        if (!Files.isRegularFile(release) || Files.size(release) > 64000) continue;
        var match =
            java.util.regex.Pattern.compile("JAVA_VERSION=\"(\\d+)")
                .matcher(Files.readString(release));
        if (match.find()
            && Integer.parseInt(match.group(1)) >= 21
            && Files.isExecutable(home.resolve("bin/java")))
          return home.resolve("bin/java").toString();
      } catch (IOException | NumberFormatException ignored) {
      }
    }
    return "";
  }

  static String executable(String command) {
    return com.argus.common.process.ExecutableDiscovery.resolve(
        command, System.getenv(), Path.of(System.getProperty("user.home")));
  }

  private static boolean compatibleNode(String executable) {
    String cacheKey;
    try {
      cacheKey = executable + ":" + Files.getLastModifiedTime(Path.of(executable)).toMillis();
    } catch (IOException error) {
      return false;
    }
    return NODE_COMPATIBILITY.computeIfAbsent(
        cacheKey,
        ignored -> {
          var builder = new ProcessBuilder(executable, "--version");
          builder.environment().remove("NODE_OPTIONS");
          try (var process = new OwnedProcess(builder, null, 4096)) {
            var result = process.await(java.time.Duration.ofSeconds(2));
            var match =
                java.util.regex.Pattern.compile("v(\\d+)\\.(\\d+)\\.(\\d+)")
                    .matcher(result.stdout().trim());
            if (result.exitCode() != 0 || !match.matches()) return false;
            int major = Integer.parseInt(match.group(1)),
                minor = Integer.parseInt(match.group(2)),
                patch = Integer.parseInt(match.group(3));
            return major > 22 || major == 22 && (minor > 22 || minor == 22 && patch >= 2);
          } catch (IOException | RuntimeException error) {
            return false;
          }
        });
  }

  static String canonical(String language) {
    if (List.of("javascript", "javascriptreact", "typescriptreact").contains(language))
      return "typescript";
    if (language == null || !LANGUAGES.contains(language))
      throw new IllegalArgumentException("No language server is configured for this file type");
    return language;
  }

  static String label(String language) {
    return switch (language) {
      case "java" -> "Java";
      case "typescript" -> "JavaScript / TypeScript";
      case "python" -> "Python";
      case "go" -> "Go";
      case "rust" -> "Rust";
      default -> "C / C++";
    };
  }

  private static Map<String, Object> map(Object input) {
    var result = new LinkedHashMap<String, Object>();
    if (input instanceof Map<?, ?> values)
      values.forEach((key, value) -> result.put(String.valueOf(key), value));
    return result;
  }
}
