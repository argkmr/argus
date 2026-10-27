package com.argus.ide;

import java.io.IOException;
import java.io.StringReader;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Pattern;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import org.yaml.snakeyaml.nodes.MappingNode;
import org.yaml.snakeyaml.nodes.Node;
import org.yaml.snakeyaml.nodes.ScalarNode;
import org.yaml.snakeyaml.nodes.SequenceNode;

/**
 * Exact source locations, not a Spring environment evaluator. Never returns configuration values.
 */
final class IdeConfigurationNavigation {
  private static final Pattern PLACEHOLDER =
      Pattern.compile("\\$\\{([A-Za-z_][A-Za-z0-9_.\\-\\[\\]]{0,255})(?=[:}])");
  private static final Pattern PROPERTY_CALL =
      Pattern.compile(
          "\\b(?:getProperty|getRequiredProperty)\\s*\\(\\s*\"([A-Za-z_][A-Za-z0-9_.\\-\\[\\]]{0,255})\"(?=\\s*[,\\)])");
  private static final Pattern CONFIGURATION =
      Pattern.compile("application(?:-[^/\\\\]+)?\\.(?:ya?ml|properties)");
  private static final Set<String> SKIP =
      Set.of(
          ".git",
          ".argus-data",
          "node_modules",
          "target",
          "build",
          "dist",
          ".venv",
          "venv",
          ".gradle",
          ".next",
          "__pycache__");
  private static final int MAX_CONFIG_BYTES = 256 * 1024;
  private final IdeFiles files;

  IdeConfigurationNavigation(IdeFiles files) {
    this.files = files;
  }

  /** null means this position is not a supported configuration reference: use normal LSP. */
  IdeService.Navigation navigate(Path root, IdeFiles.FileContent source, int line, int column) {
    if (!source.path().matches(".*\\.(?:java|kt|kts|ya?ml|properties)$")) return null;
    String key = referenceAt(source.content(), line, column, source.path().matches(".*\\.kts?$"));
    if (key == null && source.path().matches(".*\\.(?:java|kt|kts)$"))
      key = propertyCallAt(source.content(), line, column);
    if (key == null) return null;
    final String selectedKey = key;
    Path realRoot = files.resolve(root, ".", true);
    var locations = new ArrayList<IdeService.Location>();
    int[] visited = {0}, configurations = {0};
    long[] bytes = {0};
    boolean[] limited = {false}, skipped = {false};
    long deadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
    try {
      Files.walkFileTree(
          realRoot,
          Set.of(),
          40,
          new SimpleFileVisitor<>() {
            private boolean exhausted() {
              if (visited[0] >= 10000
                  || configurations[0] >= 128
                  || bytes[0] >= 16L * 1024 * 1024
                  || locations.size() >= IdeFiles.MAX_RESULTS
                  || System.nanoTime() >= deadline) limited[0] = true;
              return limited[0];
            }

            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
              visited[0]++;
              if (exhausted()) return FileVisitResult.TERMINATE;
              return !dir.equals(realRoot) && SKIP.contains(dir.getFileName().toString())
                  ? FileVisitResult.SKIP_SUBTREE
                  : FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path path, BasicFileAttributes attrs) {
              visited[0]++;
              if (exhausted()) return FileVisitResult.TERMINATE;
              if (attrs.isDirectory()) limited[0] = true;
              if (!attrs.isRegularFile()
                  || attrs.isSymbolicLink()
                  || !CONFIGURATION.matcher(path.getFileName().toString()).matches())
                return FileVisitResult.CONTINUE;
              configurations[0]++;
              if (attrs.size() > MAX_CONFIG_BYTES) {
                skipped[0] = true;
                return FileVisitResult.CONTINUE;
              }
              bytes[0] += attrs.size();
              String relative = IdeFiles.relative(realRoot, path);
              try {
                var config = files.read(realRoot, relative);
                // The file may have grown between directory inspection and the bounded read.
                if (config.content().length() > MAX_CONFIG_BYTES) {
                  skipped[0] = true;
                  return FileVisitResult.CONTINUE;
                }
                var matches =
                    relative.endsWith(".properties")
                        ? properties(relative, config.content(), selectedKey)
                        : yaml(relative, config.content(), selectedKey);
                // Only publish coordinates belonging to the snapshot we actually parsed.
                if (files.read(realRoot, relative).contentHash().equals(config.contentHash())) {
                  for (var match : matches) {
                    if (locations.size() >= IdeFiles.MAX_RESULTS) break;
                    if (!locations.contains(match)) locations.add(match);
                  }
                } else skipped[0] = true;
              } catch (IllegalArgumentException | IllegalStateException error) {
                skipped[0] = true;
              }
              return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException error) {
              skipped[0] = true;
              return exhausted() ? FileVisitResult.TERMINATE : FileVisitResult.CONTINUE;
            }
          });
    } catch (IOException error) {
      skipped[0] = true;
    }
    locations.sort(
        Comparator.comparing(IdeService.Location::path)
            .thenComparingInt(IdeService.Location::line)
            .thenComparingInt(IdeService.Location::column));
    String notice =
        locations.isEmpty()
            ? "No exact key found in repository application*.yml, application*.yaml or application*.properties files."
            : locations.size() > 1
                ? "Multiple configuration declarations found; choose a file or profile."
                : "Configuration declaration found in a repository file.";
    notice +=
        " Active profiles, imports, environment overrides and runtime values are not resolved.";
    if (limited[0]) notice += " Search limit reached; more declarations may exist.";
    if (skipped[0])
      notice += " Some configuration files were unreadable, changed, oversized or unsupported.";
    return new IdeService.Navigation(List.copyOf(locations), notice, limited[0] || skipped[0]);
  }

  static String referenceAt(String content, int line, int column) {
    return referenceAt(content, line, column, false);
  }

  private static String referenceAt(String content, int line, int column, boolean kotlin) {
    String[] lines = content.split("\n", -1);
    if (line < 1 || line > lines.length) return null;
    String text = lines[line - 1];
    var match = PLACEHOLDER.matcher(text);
    while (match.find())
      if (column - 1 >= match.start(1)
          && column - 1 < match.end(1)
          && (!kotlin || escapedPlaceholder(text, match.start()))
          && text.indexOf('}', match.end(1)) >= 0) return match.group(1);
    return null;
  }

  private static boolean escapedPlaceholder(String text, int start) {
    int count = 0;
    while (start > 0 && text.charAt(--start) == '\\') count++;
    return count % 2 == 1;
  }

  private static String propertyCallAt(String content, int line, int column) {
    String[] lines = content.split("\n", -1);
    if (line < 1 || line > lines.length) return null;
    var match = PROPERTY_CALL.matcher(lines[line - 1]);
    while (match.find())
      if (column - 1 >= match.start(1) && column - 1 < match.end(1)) return match.group(1);
    return null;
  }

  private static List<IdeService.Location> yaml(String path, String content, String key) {
    var options = new LoaderOptions();
    options.setCodePointLimit(MAX_CONFIG_BYTES);
    options.setNestingDepthLimit(32);
    options.setMaxAliasesForCollections(32);
    var yaml = new Yaml(new SafeConstructor(options));
    var results = new ArrayList<IdeService.Location>();
    String[] lines = content.split("\n", -1);
    try {
      for (Node document : yaml.composeAll(new StringReader(content)))
        collectYaml(document, "", key, path, lines, results, new IdentityHashMap<>(), 0);
    } catch (org.yaml.snakeyaml.error.YAMLException error) {
      throw new IllegalArgumentException("Unsupported configuration YAML", error);
    }
    return results;
  }

  private static void collectYaml(
      Node node,
      String prefix,
      String key,
      String path,
      String[] lines,
      List<IdeService.Location> results,
      IdentityHashMap<Node, Boolean> visited,
      int depth) {
    if (node == null || depth > 32 || results.size() >= IdeFiles.MAX_RESULTS) return;
    if (visited.put(node, true) != null || node.getAnchor() != null)
      throw new IllegalArgumentException("Configuration aliases require explicit inspection");
    if (node instanceof MappingNode mapping) {
      for (var tuple : mapping.getValue()) {
        if (results.size() >= IdeFiles.MAX_RESULTS) break;
        if (!(tuple.getKeyNode() instanceof ScalarNode scalar) || "<<".equals(scalar.getValue()))
          throw new IllegalArgumentException("Unsupported configuration key");
        String full = prefix.isEmpty() ? scalar.getValue() : prefix + "." + scalar.getValue();
        if (full.equals(key)) {
          int row = scalar.getStartMark().getLine();
          int start = utf16Column(lines, row, scalar.getStartMark().getColumn());
          int endRow = scalar.getEndMark().getLine();
          int end = utf16Column(lines, endRow, scalar.getEndMark().getColumn());
          results.add(new IdeService.Location(path, row + 1, start + 1, endRow + 1, end + 1));
        }
        if (!(tuple.getValueNode() instanceof ScalarNode))
          collectYaml(tuple.getValueNode(), full, key, path, lines, results, visited, depth + 1);
      }
    } else if (node instanceof SequenceNode sequence) {
      for (int i = 0; i < sequence.getValue().size(); i++)
        collectYaml(
            sequence.getValue().get(i),
            prefix + "[" + i + "]",
            key,
            path,
            lines,
            results,
            visited,
            depth + 1);
    } else if (node instanceof ScalarNode scalar && prefix.equals(key)) {
      int row = scalar.getStartMark().getLine();
      int endRow = scalar.getEndMark().getLine();
      var location =
          new IdeService.Location(
              path,
              row + 1,
              utf16Column(lines, row, scalar.getStartMark().getColumn()) + 1,
              endRow + 1,
              utf16Column(lines, endRow, scalar.getEndMark().getColumn()) + 1);
      // Mapping keys already have a precise range. Scalars add only sequence-item declarations.
      if (key.endsWith("]")) results.add(location);
    }
  }

  private static int utf16Column(String[] lines, int row, int codePoints) {
    if (row < 0 || row >= lines.length) return 0;
    String line = lines[row];
    return line.offsetByCodePoints(0, Math.min(codePoints, line.codePointCount(0, line.length())));
  }

  private static List<IdeService.Location> properties(String path, String content, String key) {
    var results = new ArrayList<IdeService.Location>();
    String[] lines = content.split("\r\n|\n|\r", -1);
    boolean continuation = false;
    for (int row = 0; row < lines.length && results.size() < IdeFiles.MAX_RESULTS; row++) {
      String line = lines[row];
      boolean previousContinuation = continuation;
      int trailing = 0;
      for (int i = line.length() - 1; i >= 0 && line.charAt(i) == '\\'; i--) trailing++;
      continuation = trailing % 2 == 1;
      if (previousContinuation) continue;
      int start = 0;
      while (start < line.length() && propertyWhitespace(line.charAt(start))) start++;
      if (start == line.length() || line.charAt(start) == '#' || line.charAt(start) == '!') {
        continuation = false;
        continue;
      }
      int end = start;
      boolean escaped = false;
      while (end < line.length()) {
        char ch = line.charAt(end);
        if (!escaped && (ch == '=' || ch == ':' || propertyWhitespace(ch))) break;
        if (ch == '\\') escaped = !escaped;
        else escaped = false;
        end++;
      }
      // A continued value does not change the key's source location; a continued key does.
      if (continuation && end == line.length())
        throw new IllegalArgumentException(
            "Continued configuration key requires explicit inspection");
      var parsed = new Properties();
      try {
        // Parse only the key: never load configuration values or interpret their escapes.
        parsed.load(new StringReader(line.substring(start, end) + "="));
      } catch (IOException | IllegalArgumentException ignored) {
        throw new IllegalArgumentException("Unsupported configuration key");
      }
      if (parsed.containsKey(key))
        results.add(new IdeService.Location(path, row + 1, start + 1, row + 1, end + 1));
    }
    return results;
  }

  private static boolean propertyWhitespace(char ch) {
    return ch == ' ' || ch == '\t' || ch == '\f';
  }
}
