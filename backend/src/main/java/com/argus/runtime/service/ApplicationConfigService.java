package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.error.ConflictException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import org.yaml.snakeyaml.nodes.*;

/** Local YAML port edits preserve unrelated content, comments and environment placeholders. */
@Service
public class ApplicationConfigService {
  /** Internal snapshot only: never serialize the source or scalar values to an API response. */
  record PortDocument(
      Path root,
      Path realRoot,
      Path file,
      String source,
      String hash,
      Map<String, ScalarNode> values,
      boolean configurationOverrides) {
    String value(String key) {
      var node = values.get(key);
      return node == null ? "" : node.getValue();
    }

    String placeholder(String key) {
      var match =
          Pattern.compile("^\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::\\d+)?}$").matcher(value(key).trim());
      return match.matches() ? match.group(1) : "";
    }
  }

  static String contentHash(String source) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8)));
    } catch (java.security.NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  PortDocument inspectPorts(Path root, String requested) {
    return inspectPorts(root, requested, false);
  }

  /**
   * Profile/import selectors are safe to preserve only when the caller also installs a higher
   * precedence local port environment override. They do not make this base YAML authoritative.
   */
  PortDocument inspectPorts(Path root, String requested, boolean localPortOverride) {
    if (requested == null || !requested.matches("(?i)(?:.*/)?application\\.ya?ml"))
      throw new IllegalArgumentException(
          "Direct port editing requires a base application.yml or application.yaml; configure other formats or profiles in Services.");
    Path target = inside(root, requested);
    for (Path component = target;
        component != null && !component.equals(root.toAbsolutePath().normalize());
        component = component.getParent())
      if (Files.isSymbolicLink(component))
        throw new IllegalArgumentException("Port configuration must not use symbolic links.");
    if (!Files.isRegularFile(target))
      throw new IllegalArgumentException("The saved application configuration does not exist.");
    String source;
    Path realRoot;
    try {
      realRoot = root.toRealPath();
      if (Files.isSymbolicLink(root))
        throw new IllegalArgumentException(
            "Port configuration must not use a symbolic-link repository root.");
      if (Files.size(target) > 1024 * 1024)
        throw new IllegalArgumentException(
            "Application configuration exceeds the 1 MB port-editing limit.");
      source = Files.readString(target);
    } catch (java.io.IOException error) {
      throw new IllegalArgumentException("Application configuration could not be read.");
    }
    var options = new LoaderOptions();
    options.setAllowDuplicateKeys(false);
    options.setMaxAliasesForCollections(0);
    options.setCodePointLimit(1024 * 1024);
    var yaml = new Yaml(new SafeConstructor(options));
    var values = new LinkedHashMap<String, ScalarNode>();
    try {
      // Safe construction validates duplicate keys; compose retains scalar source positions.
      yaml.load(source);
      var documents = yaml.composeAll(new StringReader(source)).iterator();
      if (!documents.hasNext())
        throw new IllegalArgumentException("Application configuration is empty.");
      Node document = documents.next();
      if (documents.hasNext()
          || !(document instanceof MappingNode mapping)
          || mapping.getFlowStyle() == org.yaml.snakeyaml.DumperOptions.FlowStyle.FLOW
          || Pattern.compile("(?m)^\\.\\.\\.(?:[ \\t]*#.*)?[ \\t]*$").matcher(source).find())
        throw new IllegalArgumentException("Port editing requires one YAML mapping document.");
      portNodes(document, "", values, new IdentityHashMap<>());
    } catch (RuntimeException error) {
      // YAML parser diagnostics can contain configuration values; never expose them.
      throw new IllegalArgumentException(
          "Application YAML is ambiguous or unsupported (multiple documents, duplicate keys, aliases or non-mapping keys). Edit it in the code editor.");
    }
    for (String key : List.of("server.port", "management.server.port")) {
      String value = values.containsKey(key) ? values.get(key).getValue() : "";
      if (values.containsKey(key)
          && source
              .substring(source.offsetByCodePoints(0, values.get(key).getStartMark().getIndex()))
              .startsWith("!"))
        throw new IllegalArgumentException(
            "Explicitly tagged port values must be edited in the code editor.");
      if (values.containsKey(key)
          && (values.get(key).getScalarStyle()
                  == org.yaml.snakeyaml.DumperOptions.ScalarStyle.LITERAL
              || values.get(key).getScalarStyle()
                  == org.yaml.snakeyaml.DumperOptions.ScalarStyle.FOLDED))
        throw new IllegalArgumentException(
            "Block-style port values must be edited in the code editor.");
      if (!value.isEmpty()
          && RuntimeDetector.validPort(value) == null
          && !List.of("0", "-1").contains(value)
          && !value.matches("\\$\\{[A-Za-z_][A-Za-z0-9_]*}"))
        throw new IllegalArgumentException(
            "The configured port is not a numeric scalar or a simple environment placeholder.");
    }
    boolean configurationOverrides =
        values.keySet().stream()
            .anyMatch(
                key -> key.startsWith("spring.config.") || key.startsWith("spring.profiles."));
    if (configurationOverrides && !localPortOverride)
      throw new IllegalArgumentException(
          "This application selects profiles or imports configuration. Edit its effective port in Services or the active configuration file.");
    if (values.containsKey("server") || values.containsKey("management.server"))
      throw new IllegalArgumentException("Port configuration has an unsupported scalar parent.");
    // A properties sibling takes precedence over YAML. Profile variants may override it later.
    try (var siblings = Files.list(target.getParent())) {
      boolean relatedConfiguration =
          siblings.anyMatch(
              path ->
                  !path.equals(target)
                      && path.getFileName()
                          .toString()
                          .matches("application(?:-[^.]+)?\\.(?:ya?ml|properties)"));
      configurationOverrides |= relatedConfiguration;
      if (relatedConfiguration && !localPortOverride)
        throw new IllegalArgumentException(
            "Multiple application or profile configuration files exist here. Edit the effective port in Services to avoid changing the wrong source.");
    } catch (java.io.IOException error) {
      throw new IllegalArgumentException(
          "Related application configuration files could not be checked.");
    }
    return new PortDocument(
        root.toAbsolutePath().normalize(),
        realRoot,
        target,
        source,
        contentHash(source),
        values,
        configurationOverrides);
  }

  private static void portNodes(
      Node node,
      String prefix,
      Map<String, ScalarNode> values,
      IdentityHashMap<Node, Boolean> seen) {
    if (seen.put(node, Boolean.TRUE) != null || node.getAnchor() != null)
      throw new IllegalArgumentException("Aliases are unsupported");
    if (node instanceof MappingNode mapping) {
      for (var tuple : mapping.getValue()) {
        if (!(tuple.getKeyNode() instanceof ScalarNode key) || key.getValue().equals("<<"))
          throw new IllegalArgumentException("Unsupported key");
        String path = prefix.isEmpty() ? key.getValue() : prefix + "." + key.getValue();
        portNodes(tuple.getValueNode(), path, values, seen);
      }
    } else if (node instanceof ScalarNode scalar) {
      if (values.putIfAbsent(prefix, scalar) != null)
        throw new IllegalArgumentException("Duplicate path");
    } else if (node instanceof SequenceNode sequence) {
      for (int i = 0; i < sequence.getValue().size(); i++)
        portNodes(sequence.getValue().get(i), prefix + "[" + i + "]", values, seen);
    }
  }

  String updatedPorts(PortDocument document, int applicationPort, Integer managementPort) {
    String source = document.source();
    var replacements = new ArrayList<Map.Entry<ScalarNode, String>>();
    String additions = "";
    for (var pair :
        Map.of(
                "server.port",
                applicationPort,
                "management.server.port",
                managementPort == null ? 0 : managementPort)
            .entrySet()) {
      if (pair.getValue() == 0) continue;
      var scalar = document.values().get(pair.getKey());
      if (scalar == null) {
        additions +=
            pair.getKey() + ": " + pair.getValue() + (source.contains("\r\n") ? "\r\n" : "\n");
        continue;
      }
      String value =
          document.placeholder(pair.getKey()).isEmpty()
              ? pair.getValue().toString()
              : "${" + document.placeholder(pair.getKey()) + ":" + pair.getValue() + "}";
      // Scalar span includes quote delimiters; retain the original quote style.
      String quote =
          scalar.getScalarStyle() == org.yaml.snakeyaml.DumperOptions.ScalarStyle.DOUBLE_QUOTED
              ? "\""
              : scalar.getScalarStyle()
                      == org.yaml.snakeyaml.DumperOptions.ScalarStyle.SINGLE_QUOTED
                  ? "'"
                  : "";
      replacements.add(Map.entry(scalar, quote + value + quote));
    }
    replacements.sort(
        (a, b) ->
            Integer.compare(
                b.getKey().getStartMark().getIndex(), a.getKey().getStartMark().getIndex()));
    for (var replacement : replacements) {
      int start = source.offsetByCodePoints(0, replacement.getKey().getStartMark().getIndex());
      int end = source.offsetByCodePoints(0, replacement.getKey().getEndMark().getIndex());
      source = source.substring(0, start) + replacement.getValue() + source.substring(end);
    }
    if (!additions.isEmpty())
      source += (source.endsWith("\n") ? "" : source.contains("\r\n") ? "\r\n" : "\n") + additions;
    return source;
  }

  void writePorts(PortDocument document, String expectedHash, String updated) {
    validatePortTarget(document);
    if (expectedHash == null || !expectedHash.matches("[a-f0-9]{64}"))
      throw new IllegalArgumentException("Refresh the port details before editing.");
    if (!document.hash().equals(expectedHash)
        || !contentHash(RuntimeData.read(document.file())).equals(expectedHash))
      throw new ConflictException(
          "Application configuration changed. Refresh the port details before saving.");
    validatePortTarget(document);
    LocalEnvironmentService.atomicWrite(document.file(), updated, false);
  }

  void restorePorts(PortDocument document, String expectedSource) {
    validatePortTarget(document);
    if (!contentHash(RuntimeData.read(document.file())).equals(contentHash(expectedSource)))
      throw new ConflictException("Application YAML changed during rollback; it was preserved.");
    validatePortTarget(document);
    LocalEnvironmentService.atomicWrite(document.file(), document.source(), false);
  }

  private static void validatePortTarget(PortDocument document) {
    try {
      if (Files.isSymbolicLink(document.root())
          || !document.root().toRealPath().equals(document.realRoot()))
        throw new ConflictException("Repository path changed. Refresh before saving.");
    } catch (java.io.IOException error) {
      throw new ConflictException("Repository path could not be verified. Refresh before saving.");
    }
    Path target = inside(document.root(), document.root().relativize(document.file()).toString());
    for (Path component = target;
        component != null && !component.equals(document.root());
        component = component.getParent())
      if (Files.isSymbolicLink(component))
        throw new ConflictException(
            "Application configuration path changed. Refresh before saving.");
    if (!Files.isRegularFile(target))
      throw new ConflictException("Application configuration was removed. Refresh before saving.");
  }

  private record Key(
      int indent, String prefix, String key, String value, int index, List<String> path) {}

  private static Key parse(String line, int index, List<String> parent) {
    if (line.trim().isEmpty()
        || line.stripLeading().startsWith("#")
        || line.stripLeading().startsWith("-")) return null;
    var match = Pattern.compile("^(\\s*)([A-Za-z0-9_.-]+)\\s*:\\s*(.*)$").matcher(line);
    if (!match.matches()) return null;
    var path = new ArrayList<>(parent);
    path.add(match.group(2));
    return new Key(
        match.group(1).length(), match.group(1), match.group(2), match.group(3), index, path);
  }

  private static String replace(String value, int port) {
    int commentIndex = value.indexOf(" #");
    String comment = commentIndex >= 0 ? value.substring(commentIndex) : "",
        raw = (commentIndex >= 0 ? value.substring(0, commentIndex) : value).trim();
    var match = Pattern.compile("^\\$\\{([^:}]+):[^}]*}$").matcher(raw);
    return (match.matches() ? "${" + match.group(1) + ":" + port + "}" : String.valueOf(port))
        + comment;
  }

  public static String setYamlPath(String source, List<String> keys, int port) {
    String newline = source.contains("\r\n") ? "\r\n" : "\n", flattened = String.join(".", keys);
    var lines = new ArrayList<>(Arrays.asList(source.replace("\r\n", "\n").split("\n", -1)));
    for (int index = 0; index < lines.size(); index++) {
      var parsed = parse(lines.get(index), index, List.of());
      if (parsed != null && parsed.key.equals(flattened)) {
        lines.set(index, parsed.prefix + parsed.key + ": " + replace(parsed.value, port));
        return String.join(newline, lines);
      }
    }
    var stack = new ArrayList<Key>();
    var nodes = new ArrayList<Key>();
    for (int index = 0; index < lines.size(); index++) {
      var parsed = parse(lines.get(index), index, List.of());
      if (parsed == null) continue;
      while (!stack.isEmpty() && stack.get(stack.size() - 1).indent >= parsed.indent)
        stack.remove(stack.size() - 1);
      parsed = parse(lines.get(index), index, stack.stream().map(Key::key).toList());
      nodes.add(parsed);
      if (parsed.value.isEmpty() || parsed.value.startsWith("#")) stack.add(parsed);
      if (String.join(".", parsed.path).equals(flattened)) {
        lines.set(index, parsed.prefix + parsed.key + ": " + replace(parsed.value, port));
        return String.join(newline, lines);
      }
    }
    Key parent = null;
    int prefixLength = keys.size() - 1;
    while (prefixLength > 0 && parent == null) {
      var wanted = keys.subList(0, prefixLength);
      parent =
          nodes.stream()
              .filter(
                  node ->
                      node.path.equals(wanted)
                          && (node.value.isEmpty() || node.value.startsWith("#")))
              .findFirst()
              .orElse(null);
      if (parent == null) prefixLength--;
    }
    if (parent != null) {
      int insertion = lines.size();
      for (int index = parent.index + 1; index < lines.size(); index++) {
        var parsed = parse(lines.get(index), index, List.of());
        if (parsed != null && parsed.indent <= parent.indent) {
          insertion = index;
          break;
        }
      }
      var additions = new ArrayList<String>();
      for (int index = prefixLength; index < keys.size() - 1; index++)
        additions.add("  ".repeat(index) + keys.get(index) + ":");
      additions.add("  ".repeat(keys.size() - 1) + keys.get(keys.size() - 1) + ": " + port);
      lines.addAll(insertion, additions);
    } else {
      if (!lines.get(lines.size() - 1).trim().isEmpty()) lines.add("");
      lines.add("# Ports managed by Argus");
      for (int index = 0; index < keys.size(); index++)
        lines.add(
            "  ".repeat(index)
                + keys.get(index)
                + ":"
                + (index == keys.size() - 1 ? " " + port : ""));
    }
    return String.join(newline, lines);
  }

  private Path resolve(Path root, String requested) {
    return inside(
        root,
        requested == null || requested.isBlank()
            ? "src/main/resources/application.yml"
            : requested);
  }

  public Map<String, Object> read(Path root, String requested) {
    if (requested == null || requested.isBlank())
      return object("file", "", "content", "", "exists", false);
    Path target = resolve(root, requested);
    return object(
        "file",
        root.toAbsolutePath().normalize().relativize(target).toString(),
        "content",
        RuntimeData.read(target),
        "exists",
        Files.exists(target));
  }

  public Map<String, Object> saveContents(Path root, String requested, String content) {
    Path target = resolve(root, requested);
    String original = RuntimeData.read(target), updated = content == null ? "" : content;
    LocalEnvironmentService.atomicWrite(target, updated, false);
    return object(
        "file",
        root.toAbsolutePath().normalize().relativize(target).toString(),
        "changed",
        !original.equals(updated));
  }

  public Map<String, Object> configure(Path root, Map<String, Object> input) {
    Integer app = RuntimeDetector.validPort(input.get("applicationPort")),
        management = RuntimeDetector.validPort(input.get("managementPort"));
    if (app == null)
      throw new IllegalArgumentException("Application port must be between 1 and 65535");
    if (management == null)
      throw new IllegalArgumentException("Management port must be between 1 and 65535");
    if (app.equals(management))
      throw new IllegalArgumentException("Application and management ports must be different");
    Path target = resolve(root, text(input, "configFile"));
    if (!Files.exists(target))
      throw new IllegalArgumentException(
          "Application configuration not found: "
              + root.toAbsolutePath().normalize().relativize(target));
    String original = RuntimeData.read(target),
        updated =
            setYamlPath(
                setYamlPath(original, List.of("server", "port"), app),
                List.of("management", "server", "port"),
                management);
    LocalEnvironmentService.atomicWrite(target, updated, false);
    return object(
        "file",
        root.toAbsolutePath().normalize().relativize(target).toString(),
        "applicationPort",
        app,
        "managementPort",
        management,
        "changed",
        !original.equals(updated));
  }
}
