package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.process.CommandRunner;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/** Reads build metadata without executing build scripts and chooses a compatible installed SDK. */
@Service
public class JavaProjectService {
  private final CommandRunner commands;
  private final Map<String, String> environment;
  private static final List<String> BUILD_FILES =
      List.of(
          "settings.gradle",
          "settings.gradle.kts",
          "build.gradle",
          "build.gradle.kts",
          "pom.xml",
          "gradle/wrapper/gradle-wrapper.properties",
          ".mvn/wrapper/maven-wrapper.properties");

  @Autowired
  public JavaProjectService(CommandRunner commands) {
    this(commands, System.getenv());
  }

  public JavaProjectService(CommandRunner commands, Map<String, String> environment) {
    this.commands = commands;
    this.environment = Map.copyOf(environment);
  }

  private static String match(String expression, String source) {
    var matcher = Pattern.compile(expression).matcher(source);
    return matcher.find() ? matcher.group(1) : "";
  }

  public static int major(String value) {
    String raw = value.trim().replaceFirst("^1[._]", "");
    String result = match("^(\\d+)(?:[._+\\-].*)?$", raw);
    return result.isEmpty() ? 0 : Integer.parseInt(result);
  }

  public static Map<String, Object> gradleJavaCompatibility(String version) {
    // Runtime and compilation support differ:
    // https://docs.gradle.org/current/userguide/compatibility.html
    var match = Pattern.compile("^(\\d+)\\.(\\d+)(?:\\.\\d+)?$").matcher(version);
    if (!match.matches()) return null;
    int major = Integer.parseInt(match.group(1)), minor = Integer.parseInt(match.group(2));
    if (major < 2 || major > 9) return null;
    int runtime =
        bound(
            major,
            minor,
            new int[][] {
              {9, 4, 26}, {9, 1, 25}, {8, 14, 24}, {8, 10, 23}, {8, 8, 22}, {8, 5, 21}, {8, 3, 20},
              {7, 6, 19}, {7, 5, 18}, {7, 3, 17}, {7, 0, 16}, {6, 7, 15}, {6, 3, 14}, {6, 0, 13},
              {5, 4, 12}, {5, 0, 11}, {4, 7, 10}, {4, 3, 9}, {2, 0, 8}
            });
    int toolchain =
        bound(
            major,
            minor,
            new int[][] {
              {9, 4, 26},
              {9, 1, 25},
              {8, 14, 24},
              {8, 10, 23},
              {8, 7, 22},
              {8, 4, 21},
              {8, 1, 20},
              {7, 6, 19},
              {7, 5, 18},
              {7, 3, 17},
              {7, 0, 16},
              {6, 7, 15}
            });
    return object(
        "minimumRuntime",
        major >= 9 ? 17 : 8,
        "maximumRuntime",
        runtime,
        "maximumToolchain",
        toolchain);
  }

  private static int bound(int major, int minor, int[][] releases) {
    for (int[] release : releases)
      if (major > release[0] || major == release[0] && minor >= release[1]) return release[2];
    return 0;
  }

  public static String literalLevel(String expression) {
    // Declarations are inspected, never evaluated as Gradle/Groovy code.
    String withoutComment = expression.trim().replaceFirst("\\s*//.*$", "");
    long single = withoutComment.chars().filter(character -> character == '\'').count(),
        doubleQuoted = withoutComment.chars().filter(character -> character == '"').count();
    if (single % 2 != 0 || doubleQuoted % 2 != 0 || single > 0 && doubleQuoted > 0) return "";
    String value = expression.trim().replaceFirst("\\s*//.*$", "");
    String literal = match("^[\"']?((?:1[._])?\\d+)[\"']?\\s*\\)?$", value);
    if (literal.isEmpty()) literal = match("^JavaVersion\\.VERSION_((?:1_)?\\d+)\\s*\\)?$", value);
    if (literal.isEmpty())
      literal =
          match(
              "^(?:JavaLanguageVersion\\.of|JavaVersion\\.toVersion)\\(\\s*[\"']?((?:1[._])?\\d+)[\"']?\\s*\\)\\s*\\)?$",
              value);
    return literal.isEmpty() ? "" : String.valueOf(major(literal));
  }

  public static int compareVersionNumbers(String left, String right) {
    String[] a = left.split("[^0-9]+"), b = right.split("[^0-9]+");
    for (int index = 0; index < Math.max(a.length, b.length); index++) {
      java.math.BigInteger
          x =
              index < a.length && !a[index].isEmpty()
                  ? new java.math.BigInteger(a[index])
                  : java.math.BigInteger.ZERO,
          y =
              index < b.length && !b[index].isEmpty()
                  ? new java.math.BigInteger(b[index])
                  : java.math.BigInteger.ZERO;
      int comparison = x.compareTo(y);
      if (comparison != 0) return comparison;
    }
    return 0;
  }

  public static Map<String, Object> parseGradleJavaDeclarations(String build) {
    String source = build.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)^\\s*//[^\\n]*", "");
    var result =
        object("sourceLevel", "", "toolchainLevel", "", "unresolved", new ArrayList<String>());
    collect(
        source,
        "\\b(?:sourceCompatibility|targetCompatibility)\\s*(?:=|\\(|\\s)\\s*([^\\n;{}]+)",
        "sourceLevel",
        result);
    collect(
        source, "\\boptions\\.release\\s*(?:=|\\.set\\()\\s*([^\\n;{}]+)", "sourceLevel", result);
    if (Pattern.compile("\\btoolchain\\b").matcher(source).find())
      collect(
          source,
          "\\blanguageVersion\\s*(?:=|\\.set\\()\\s*([^\\n;{}]+)",
          "toolchainLevel",
          result);
    return result;
  }

  @SuppressWarnings("unchecked")
  private static void collect(String source, String regex, String key, Map<String, Object> result) {
    var matcher = Pattern.compile(regex).matcher(source);
    while (matcher.find()) {
      String value = matcher.group(1).trim(), level = literalLevel(value);
      if (!level.isEmpty())
        result.put(key, String.valueOf(Math.max(number(result.get(key)), Integer.parseInt(level))));
      else
        ((List<String>) result.get("unresolved"))
            .add(value.substring(0, Math.min(160, value.length())));
    }
  }

  public static Map<String, Object> parseMavenJavaDeclarations(String pom) {
    String uncommented = pom.replaceAll("(?s)<!--.*?-->", "");
    String profiles = match("(?s)<profiles>(.*?)</profiles>", uncommented);
    String source = uncommented.replaceAll("(?s)<profiles>.*?</profiles>", ""),
        properties = match("(?s)<properties>(.*?)</properties>", source),
        expression = "";
    // A plugin <release> overrides its user property. Do not treat an unrelated
    // plugin's <source> (e.g. a source directory) as a Java language version.
    // https://maven.apache.org/plugins/maven-compiler-plugin/examples/set-compiler-release.html
    String compiler = "";
    var plugins = Pattern.compile("(?s)<plugin(?:\\s[^>]*)?>(.*?)</plugin>").matcher(source);
    while (plugins.find())
      if (tagValue(plugins.group(1), "artifactId").equals("maven-compiler-plugin")) {
        compiler = match("(?s)<configuration>(.*?)</configuration>", plugins.group(1));
        break;
      }
    for (String value :
        List.of(
            tagValue(compiler, "release"),
            tagValue(properties, "maven.compiler.release"),
            tagValue(compiler, "source"),
            tagValue(properties, "maven.compiler.source"),
            tagValue(properties, "java.version"))) {
      expression = value;
      if (!expression.isEmpty()) break;
    }
    String value = expression;
    var visited = new LinkedHashSet<String>();
    while (value.matches("\\$\\{[A-Za-z0-9_.-]+}")) {
      String property = value.substring(2, value.length() - 1);
      if (visited.size() >= 4 || !visited.add(property)) {
        value = "";
        break;
      }
      value = tagValue(properties, property);
    }
    String level = literalLevel(value);
    var unresolved = new ArrayList<String>();
    if (!expression.isEmpty() && level.isEmpty())
      unresolved.add(expression.substring(0, Math.min(160, expression.length())));
    if (Pattern.compile(
            "<(?:maven\\.compiler\\.(?:release|source|target)|java\\.version)>|<artifactId>\\s*maven-compiler-plugin\\s*</artifactId>")
        .matcher(profiles)
        .find())
      unresolved.add(
          "Maven profiles can override Java compiler settings; select a project SDK explicitly for the active profiles");
    return object("sourceLevel", level, "toolchainLevel", "", "unresolved", unresolved);
  }

  private static String tagValue(String source, String tag) {
    return match("<" + Pattern.quote(tag) + ">\\s*([^<]+)", source).trim();
  }

  public List<Map<String, Object>> installedJdks() {
    checkCancellation();
    var candidates = new ArrayList<Map<String, Object>>();
    if (System.getProperty("os.name").toLowerCase().contains("mac"))
      try {
        String output =
            commands
                .run("/usr/libexec/java_home", List.of("-V"), null, Duration.ofSeconds(10))
                .stderr();
        var matcher =
            Pattern.compile(
                    "(?m)^\\s*([\\d._+\\-]+)\\s+\\(([^)]+)\\)\\s+\"([^\"]+)\"\\s+-\\s+\"([^\"]+)\"\\s+(.+/Contents/Home)\\s*$")
                .matcher(output);
        while (matcher.find())
          candidates.add(
              object(
                  "version",
                  matcher.group(1),
                  "architecture",
                  matcher.group(2),
                  "vendor",
                  matcher.group(3),
                  "name",
                  matcher.group(4),
                  "path",
                  matcher.group(5).trim()));
      } catch (RuntimeException ignored) {
        checkCancellation();
      }
    if (environment.containsKey("JAVA_HOME"))
      candidates.add(
          object(
              "version",
              "",
              "architecture",
              System.getProperty("os.arch"),
              "vendor",
              "Environment",
              "name",
              "JAVA_HOME",
              "path",
              environment.get("JAVA_HOME")));
    var unique = new LinkedHashMap<String, Map<String, Object>>();
    for (var candidate : candidates) {
      checkCancellation();
      Path home = Path.of(text(candidate, "path")).toAbsolutePath().normalize();
      if (Files.isRegularFile(home.resolve("bin/java"))) {
        if (text(candidate, "version").isEmpty())
          candidate.put(
              "version", match("(?m)^JAVA_VERSION=\"([^\"]+)\"", read(home.resolve("release"))));
        candidate.put("path", home.toString());
        if (!unique.containsKey(home.toString()) || !text(candidate, "version").isEmpty())
          unique.put(home.toString(), candidate);
      }
    }
    var result = new ArrayList<>(unique.values());
    result.sort(
        (left, right) -> compareVersionNumbers(text(right, "version"), text(left, "version")));
    return result;
  }

  public Map<String, Object> inspect(Repository repository) {
    return inspect(repository, Map.of());
  }

  public Map<String, Object> inspect(Repository repository, Map<String, Object> settings) {
    Path root = Path.of(repository.path());
    var contents = new LinkedHashMap<String, String>();
    for (String file : BUILD_FILES) contents.put(file, read(inside(root, file)));
    String tool = "None detected",
        version = "",
        build =
            contents.get("build.gradle").isEmpty()
                ? contents.get("build.gradle.kts")
                : contents.get("build.gradle"),
        gradleSettings =
            contents.get("settings.gradle").isEmpty()
                ? contents.get("settings.gradle.kts")
                : contents.get("settings.gradle");
    var modules = new LinkedHashSet<String>();
    modules.add(".");
    Map<String, Object> declarations =
        object("sourceLevel", "", "toolchainLevel", "", "unresolved", List.of());
    if (!build.isEmpty() || !gradleSettings.isEmpty() || Files.exists(root.resolve("gradlew"))) {
      tool = "Gradle";
      declarations = parseGradleJavaDeclarations(build);
      version =
          match(
              "gradle-([^/\\s]+)-(?:bin|all)\\.zip",
              contents.get("gradle/wrapper/gradle-wrapper.properties"));
      var includes =
          Pattern.compile("(?:include|includeFlat)\\s*\\(?\\s*([^\\n)]+)").matcher(gradleSettings);
      while (includes.find()) {
        var names = Pattern.compile("[\"'](:?[^\"']+)[\"']").matcher(includes.group(1));
        while (names.find()) modules.add(names.group(1).replaceFirst("^:", "").replace(':', '/'));
      }
    } else if (!contents.get("pom.xml").isEmpty() || Files.exists(root.resolve("mvnw"))) {
      tool = "Maven";
      declarations = parseMavenJavaDeclarations(contents.get("pom.xml"));
      version =
          match(
              "apache-maven-([0-9][^/\\s]*?)-bin\\.(?:zip|tar\\.gz)",
              contents.get(".mvn/wrapper/maven-wrapper.properties"));
      var matcher =
          Pattern.compile("<module>\\s*([^<]+)\\s*</module>").matcher(contents.get("pom.xml"));
      while (matcher.find()) modules.add(matcher.group(1).trim());
    }
    var details = new ArrayList<Map<String, Object>>();
    for (String relative : modules) {
      Path module;
      try {
        module = inside(root, relative);
      } catch (IllegalArgumentException error) {
        continue;
      }
      var roots = new ArrayList<Map<String, Object>>();
      for (String[] pair :
          new String[][] {
            {"Sources", "src/main/java"},
            {"Tests", "src/test/java"},
            {"Resources", "src/main/resources"},
            {"Test resources", "src/test/resources"}
          })
        if (Files.isDirectory(module.resolve(pair[1])))
          roots.add(
              object(
                  "type",
                  pair[0],
                  "path",
                  relative.equals(".") ? pair[1] : relative + "/" + pair[1]));
      var files = new ArrayList<String>();
      for (String name : List.of("build.gradle", "build.gradle.kts", "pom.xml"))
        if (Files.exists(module.resolve(name)))
          files.add(relative.equals(".") ? name : relative + "/" + name);
      details.add(
          object(
              "name",
              module.getFileName().toString(),
              "path",
              relative,
              "roots",
              roots,
              "buildFiles",
              files,
              "compilerOutput",
              (relative.equals(".") ? "" : relative + "/")
                  + (files.stream().anyMatch(file -> file.endsWith("pom.xml"))
                      ? "target/classes"
                      : "build/classes")));
    }
    var jdks = installedJdks();
    String chosen = text(settings, "javaHome");
    var selected =
        jdks.stream().filter(jdk -> chosen.equals(jdk.get("path"))).findFirst().orElse(null);
    String language =
        text(declarations, "sourceLevel").isEmpty()
            ? text(declarations, "toolchainLevel")
            : text(declarations, "sourceLevel");
    boolean unresolved = !list(declarations.get("unresolved")).isEmpty();
    return object(
        "repository",
        object("id", repository.id(), "name", repository.name(), "path", repository.path()),
        "isJavaProject",
        !tool.equals("None detected")
            || details.stream()
                .anyMatch(
                    module ->
                        list(module.get("roots")).stream()
                            .anyMatch(item -> text(map(item), "path").endsWith("/java"))),
        "build",
        object(
            "tool",
            tool,
            "version",
            version,
            "files",
            BUILD_FILES.stream()
                .filter(file -> !contents.get(file).isEmpty() && !file.contains("wrapper"))
                .toList()),
        "languageLevel",
        unresolved ? "Unresolved declaration" : language.isEmpty() ? "Project default" : language,
        "javaDeclarations",
        declarations,
        "warnings",
        unresolved
            ? List.of(
                "A Java declaration uses an unresolved property or expression; Argus does not execute build scripts to guess its value.")
            : List.of(),
        "compilerOutput",
        tool.equals("Maven") ? "target/classes" : "build/classes",
        "modules",
        details,
        "jdks",
        jdks,
        "settings",
        object(
            "javaHome",
            selected == null ? "" : chosen,
            "languageLevel",
            settings.getOrDefault("languageLevel", "project")),
        "selectedJdk",
        selected);
  }

  public Map<String, Object> validateSettings(Repository repository, Map<String, Object> input) {
    String home = text(input, "javaHome").trim();
    String normalized = home.isEmpty() ? "" : Path.of(home).toAbsolutePath().normalize().toString();
    if (!normalized.isEmpty()
        && list(inspect(repository).get("jdks")).stream()
            .noneMatch(jdk -> normalized.equals(map(jdk).get("path"))))
      throw new IllegalArgumentException("Choose a JDK detected on this Mac");
    return object(
        "javaHome", normalized, "languageLevel", input.getOrDefault("languageLevel", "project"));
  }

  public Map<String, Object> resolveRuntimeEnvironment(
      Repository repository, Map<String, Object> settings) {
    var project = inspect(repository, settings);
    if (!Boolean.TRUE.equals(project.get("isJavaProject")))
      return object("environment", Map.of(), "label", "");
    var build = map(project.get("build"));
    var declarations = map(project.get("javaDeclarations"));
    String required = text(declarations, "sourceLevel"),
        toolchain = text(declarations, "toolchainLevel");
    boolean unresolved = !list(declarations.get("unresolved")).isEmpty();
    var compatibility =
        "Gradle".equals(build.get("tool"))
            ? gradleJavaCompatibility(text(build, "version"))
            : object(
                "minimumRuntime",
                "Maven".equals(build.get("tool")) ? mavenMinimumRuntime(text(build, "version")) : 0,
                "maximumRuntime",
                Integer.MAX_VALUE,
                "maximumToolchain",
                Integer.MAX_VALUE);
    Map<String, Object> selected = map(project.get("selectedJdk"));
    var warnings = new ArrayList<>(strings(project.get("warnings")));
    if (!text(settings, "javaHome").isEmpty() && selected.isEmpty())
      throw new IllegalArgumentException(
          "The selected project SDK is no longer detected. Choose an installed JDK explicitly.");
    if ((compatibility == null || unresolved) && selected.isEmpty())
      throw new IllegalArgumentException(
          compatibility == null
              ? "Gradle "
                  + text(build, "version")
                  + " has no verified runtime bounds in Argus. Choose an explicit project SDK; compatibility must be checked."
              : "The declared Java version uses an unresolved property or expression. Choose an explicit project SDK; Argus will not guess a language level.");
    if (compatibility == null) warnings.add("Gradle runtime compatibility is unverified");
    if (unresolved) warnings.add("Declared Java language/toolchain level is unresolved");
    if (compatibility != null
        && !toolchain.isEmpty()
        && number(toolchain) > number(compatibility.get("maximumToolchain")))
      throw new IllegalArgumentException(
          "Java "
              + toolchain
              + " toolchains are not supported by Gradle "
              + text(build, "version")
              + ". This is separate from the JDK running Gradle.");
    if (!toolchain.isEmpty() && !required.isEmpty() && number(toolchain) < number(required))
      throw new IllegalArgumentException(
          "Java "
              + toolchain
              + " toolchain cannot compile the declared Java "
              + required
              + " source level.");
    long
        minimum =
            Math.max(
                compatibility == null ? 0 : number(compatibility.get("minimumRuntime")),
                toolchain.isEmpty() ? number(required) : 0),
        maximum =
            compatibility == null ? Integer.MAX_VALUE : number(compatibility.get("maximumRuntime"));
    var candidates = new ArrayList<Map<String, Object>>();
    for (Object raw : list(project.get("jdks"))) {
      var candidate = copyMap(map(raw));
      int major = major(text(candidate, "version"));
      if (major > 0 && major >= minimum && major <= maximum) {
        candidate.put("major", major);
        candidates.add(candidate);
      }
    }
    candidates.sort(Comparator.comparingLong(item -> number(item.get("major"))));
    if (!selected.isEmpty()) {
      int major = major(text(selected, "version"));
      if (major == 0 || major < minimum || major > maximum)
        throw new IllegalArgumentException(
            "The selected JDK cannot satisfy this repository's build runtime bounds and declared source level. Choose a compatible project SDK.");
    } else {
      long preferred = number(required.isEmpty() ? toolchain : required);
      selected =
          candidates.stream()
              .filter(item -> preferred > 0 && number(item.get("major")) == preferred)
              .findFirst()
              .orElse(null);
      if (selected == null && preferred == 0)
        for (int major : List.of(17, 11, 8, 21, 25)) {
          selected =
              candidates.stream()
                  .filter(item -> number(item.get("major")) == major)
                  .findFirst()
                  .orElse(null);
          if (selected != null) break;
        }
      if (selected == null && !candidates.isEmpty()) selected = candidates.get(0);
    }
    if (selected == null)
      throw new IllegalArgumentException(
          "This repository requires "
              + (required.isEmpty() ? "a compatible JDK" : "Java " + required)
              + ", but no compatible installed JDK can run "
              + text(build, "tool")
              + " "
              + text(build, "version")
              + ".");
    String label =
        "Java "
            + text(selected, "version")
            + " · "
            + (project.get("selectedJdk") != null
                ? "project SDK"
                : !required.isEmpty() || !toolchain.isEmpty()
                    ? "repository declaration"
                    : "compatible installed JDK")
            + (toolchain.isEmpty()
                ? ""
                : " · Java " + toolchain + " compilation toolchain (Gradle-managed)")
            + (warnings.isEmpty()
                ? ""
                : " · compatibility warning: " + String.join("; ", warnings));
    String home = text(selected, "path");
    return object(
        "environment",
        object(
            "JAVA_HOME",
            home,
            "PATH",
            Path.of(home, "bin")
                + java.io.File.pathSeparator
                + environment.getOrDefault("PATH", "")),
        "label",
        label,
        "warnings",
        warnings);
  }

  static int mavenMinimumRuntime(String version) {
    // Maven 4 alpha-13+ raised its build JVM to 17, independent of source target.
    // https://maven.apache.org/docs/history.html
    if (version.startsWith("4.")) {
      String alpha = match("^4\\.0\\.0-alpha-(\\d+)$", version);
      return !alpha.isEmpty() && Integer.parseInt(alpha) <= 12 ? 8 : 17;
    }
    return version.matches("^3\\.(?:9|10)(?:[.-].*)?$") ? 8 : 0;
  }

  private void checkCancellation() {
    if (Thread.currentThread().isInterrupted())
      throw new java.util.concurrent.CancellationException("Java runtime discovery was cancelled");
  }
}
