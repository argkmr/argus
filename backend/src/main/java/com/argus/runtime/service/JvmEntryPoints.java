package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.regex.Pattern;

/** Bounded, read-only source inspection. Gradle/Maven still own classpaths and compilation. */
final class JvmEntryPoints {
  private static final Set<String> IGNORED =
      Set.of(
          ".git",
          "node_modules",
          "build",
          "bin",
          "target",
          ".gradle",
          ".idea",
          "out",
          "test",
          "tests");
  private static final Pattern SOURCE_PATH =
      Pattern.compile("^(?:(.*)/)?src/main/(java|kotlin)/(.+)\\.(java|kt)$");
  private static final Pattern STRINGS =
      Pattern.compile("(?s)\"\"\".*?\"\"\"|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'");
  private static final Pattern SPRING_ANNOTATION =
      Pattern.compile("@(?:[\\w.]+\\.)?(?:SpringBootApplication|SpringBootConfiguration)\\b");
  private static final Pattern SPRING_RUN =
      Pattern.compile("\\bSpringApplication\\s*\\.\\s*run\\s*\\(|\\brunApplication\\s*<");
  private static final Pattern JAVA_MAIN =
      Pattern.compile(
          "\\b(?:public\\s+static|static\\s+public)\\s+(?:final\\s+)?void\\s+main\\s*\\(\\s*(?:java\\.lang\\.)?String\\s*(?:\\[\\s*]|\\.\\.\\.)");
  private static final Pattern KOTLIN_MAIN = Pattern.compile("\\bfun\\s+main\\s*\\(");
  private static final Pattern PACKAGE = Pattern.compile("(?m)^\\s*package\\s+([\\w.]+)");
  private static final Pattern MAIN_DECLARATION =
      Pattern.compile("\\bmainClass(?:Name)?\\s*(?:=|\\.set\\()\\s*['\"]([\\w.$]+)['\"]");
  private static final Pattern COMMENTS =
      Pattern.compile(
          "(?s)\"\"\".*?\"\"\"|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|/\\*.*?\\*/|//[^\\r\\n]*");

  private JvmEntryPoints() {}

  static boolean customGradleLayout(Path root) {
    String settings =
        commentsRemoved(
            read(root.resolve("settings.gradle"))
                + "\n"
                + read(root.resolve("settings.gradle.kts")));
    return Pattern.compile("\\b(?:projectDir|includeBuild)\\b").matcher(settings).find();
  }

  static List<Map<String, Object>> inspect(Path root) {
    var entries = new ArrayList<Map<String, Object>>();
    try {
      Files.walkFileTree(
          root,
          Set.of(),
          24,
          new SimpleFileVisitor<>() {
            int visited;

            private void checkLimit() {
              if (Thread.currentThread().isInterrupted())
                throw new java.util.concurrent.CancellationException();
              if (++visited > 30_000)
                throw new IllegalArgumentException(
                    "Application entry-point scan reached its file/directory limit. Select an explicit saved run configuration.");
            }

            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
              checkLimit();
              return !dir.equals(root) && IGNORED.contains(dir.getFileName().toString())
                  ? FileVisitResult.SKIP_SUBTREE
                  : FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs)
                throws IOException {
              checkLimit();
              String relative = root.relativize(file).toString().replace('\\', '/');
              var path = SOURCE_PATH.matcher(relative);
              if (!attrs.isRegularFile()
                  || attrs.isSymbolicLink()
                  || attrs.size() > 1_000_000
                  || !path.matches()) return FileVisitResult.CONTINUE;
              String source =
                  STRINGS.matcher(commentsRemoved(Files.readString(file))).replaceAll(" ");
              boolean spring =
                  SPRING_ANNOTATION.matcher(source).find() && SPRING_RUN.matcher(source).find();
              boolean main =
                  JAVA_MAIN.matcher(source).find()
                      || path.group(4).equals("kt") && KOTLIN_MAIN.matcher(source).find();
              if (!spring && !main) return FileVisitResult.CONTINUE;
              String module = path.group(1) == null ? "" : path.group(1);
              var packageMatch = PACKAGE.matcher(source);
              String pkg = packageMatch.find() ? packageMatch.group(1) + "." : "";
              String type = file.getFileName().toString().replaceFirst("\\.(java|kt)$", "");
              if (path.group(4).equals("kt")
                  && !Pattern.compile("\\b(?:class|object)\\s+" + Pattern.quote(type) + "\\b")
                      .matcher(source)
                      .find()) type += "Kt";
              entries.add(
                  object(
                      "modulePath",
                      module,
                      "mainClass",
                      pkg + type,
                      "file",
                      relative,
                      "springBoot",
                      spring));
              return FileVisitResult.CONTINUE;
            }
          });
    } catch (IOException error) {
      throw new IllegalArgumentException("Could not inspect application entry points", error);
    }
    entries.sort(Comparator.comparing(item -> text(item, "file")));
    return List.copyOf(entries);
  }

  static Map<String, Object> select(Path root, List<Map<String, Object>> entries) {
    if (entries.isEmpty()) return Map.of();
    if (entries.size() == 1) return entries.get(0);
    // A literal build declaration may disambiguate multiple main classes. Do not evaluate
    // dynamic Gradle expressions or assume that a module named web-service is executable.
    var declared =
        entries.stream()
            .filter(
                entry -> {
                  Path module = root.resolve(text(entry, "modulePath"));
                  String build =
                      commentsRemoved(
                          read(module.resolve("build.gradle"))
                              + "\n"
                              + read(module.resolve("build.gradle.kts")));
                  var matcher = MAIN_DECLARATION.matcher(build);
                  while (matcher.find())
                    if (matcher.group(1).equals(entry.get("mainClass"))) return true;
                  return false;
                })
            .toList();
    if (declared.size() == 1) return declared.get(0);
    throw new IllegalArgumentException(
        "Multiple application entry points were found: "
            + entries.stream()
                .map(
                    entry ->
                        text(entry, "mainClass")
                            + " ("
                            + (text(entry, "modulePath").isEmpty()
                                ? "root"
                                : text(entry, "modulePath"))
                            + ")")
                .reduce((a, b) -> a + ", " + b)
                .orElse("")
            + ". Choose the application's module/main class in a saved Services run configuration; Argus will not guess.");
  }

  static String commentsRemoved(String source) {
    // Keep quoted strings intact so URLs do not accidentally consume the rest of a source line.
    var matcher = COMMENTS.matcher(source);
    var result = new StringBuilder();
    while (matcher.find())
      matcher.appendReplacement(
          result,
          java.util.regex.Matcher.quoteReplacement(
              matcher.group().startsWith("/") ? " " : matcher.group()));
    matcher.appendTail(result);
    return result.toString();
  }
}
