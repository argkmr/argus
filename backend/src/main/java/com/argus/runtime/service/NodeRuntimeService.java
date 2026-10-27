package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.process.CommandRunner;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.semver4j.Semver;
import org.semver4j.range.RangeListFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/** Selects a repository-compatible installed Node runtime; never installs one. */
@Service
public class NodeRuntimeService {
  private final CommandRunner commands;
  private final ObjectMapper json;
  private final Path home;
  private final Map<String, String> environment;

  @Autowired
  public NodeRuntimeService(CommandRunner commands, ObjectMapper json) {
    this(commands, json, Path.of(System.getProperty("user.home")), System.getenv());
  }

  public NodeRuntimeService(
      CommandRunner commands, ObjectMapper json, Path home, Map<String, String> environment) {
    this.commands = commands;
    this.json = json;
    this.home = home;
    this.environment = Map.copyOf(environment);
  }

  private static final String PART = "(?:0|[1-9][0-9]*|[xX*])";
  private static final Pattern TOKEN =
      Pattern.compile(
          "(?:<=|>=|<|>|=|~|\\^)?v?"
              + PART
              + "(?:\\."
              + PART
              + "){0,2}(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?");

  public static boolean validRange(String requirement) {
    if (requirement.isBlank()) return true;
    try {
      for (String group : requirement.split("\\|\\|", -1)) {
        String[] tokens = group.trim().replaceAll("([<>=~^]+)\\s+", "$1").split("\\s+");
        for (int index = 0; index < tokens.length; index++) {
          String token = tokens[index];
          if (token.isBlank()) continue;
          if (token.equals("-")) {
            if (tokens.length != 3
                || index != 1
                || !TOKEN.matcher(tokens[0]).matches()
                || !TOKEN.matcher(tokens[2]).matches()) return false;
            continue;
          }
          if (!TOKEN.matcher(token).matches()) return false;
        }
      }
      RangeListFactory.create(requirement);
      return true;
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  public static boolean satisfies(String version, String requirement) {
    var parsed = Semver.parse(version.trim().replaceFirst("^v", ""));
    String range = requirement.trim().replaceFirst("(?i)^node\\s+", "");
    if (parsed == null) return false;
    if (range.isBlank() || range.matches("(?i)node|current|latest"))
      return !version.split("\\+", 2)[0].contains("-");
    try {
      return validRange(range) && parsed.satisfies(RangeListFactory.create(range));
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  public Map<String, Object> packageJson(Path root) {
    String value = read(root.resolve("package.json"));
    return value.isBlank() ? Map.of() : json.readValue(value, LinkedHashMap.class);
  }

  public String requirement(Path root, Map<String, Object> definition) {
    for (String name : List.of(".nvmrc", ".node-version")) {
      String value = versionFile(read(root.resolve(name)), name);
      if (!value.isBlank()) return value;
    }
    for (String[] pair :
        new String[][] {
          {".tool-versions", "(?m)^nodejs\\s+([^\\s#]+)"},
          {"mise.toml", "(?m)^node\\s*=\\s*[\"']([^\"']+)"}
        }) {
      var match = Pattern.compile(pair[1]).matcher(read(root.resolve(pair[0])));
      if (match.find()) return match.group(1);
    }
    return text(map(definition.get("engines")), "node").trim();
  }

  private String versionFile(String source, String name) {
    // nvm's documented grammar ignores comments, blank lines and reserved key/value
    // lines; it requires exactly one version. Never evaluate shell or manager scripts.
    // https://github.com/nvm-sh/nvm#nvmrc
    var versions = new ArrayList<String>();
    for (String line : source.split("\\R")) {
      String value = line.replaceFirst("#.*$", "").trim();
      if (value.isEmpty()
          || name.equals(".nvmrc") && value.matches("[A-Za-z_][A-Za-z0-9_.-]*\\s*=.*")) continue;
      versions.add(value);
    }
    if (versions.size() > 1)
      throw new RuntimeCompatibilityException(
          "The repository's "
              + name
              + " must declare exactly one Node version; no service was started.");
    return versions.isEmpty() ? "" : versions.get(0);
  }

  public String resolveAlias(String input) {
    return resolveAlias(input, new LinkedHashSet<>());
  }

  private String resolveAlias(String input, Set<String> seen) {
    String value = input.trim().replaceFirst("(?i)^node\\s+", "");
    if (value.isBlank() || value.matches("(?i)node|current|latest") || validRange(value))
      return value;
    if (seen.size() >= 8 || !seen.add(value))
      throw new RuntimeCompatibilityException("Circular Node version alias: " + value);
    if (value.matches("(?:lts/)?[a-zA-Z0-9_*.-]+") && !value.contains("..")) {
      String alias = read(home.resolve(".nvm/alias").resolve(value)).trim();
      if (!alias.isBlank()) return resolveAlias(alias, seen);
    }
    if (value.matches("(?i)lts(?:/(?:\\*|[a-z][a-z0-9-]*))?")) return value;
    throw new RuntimeCompatibilityException(
        "Argus cannot interpret the repository's Node declaration \""
            + value
            + "\". Use a valid Node semver range or configure that version-manager alias; no service was started.");
  }

  public List<Map<String, Object>> installed() {
    checkCancellation();
    var candidates = new LinkedHashSet<Path>();
    for (String[] manager :
        new String[][] {
          {".nvm/versions/node", "bin/node"},
          {".fnm/node-versions", "installation/bin/node"},
          {".asdf/installs/nodejs", "bin/node"},
          {".local/share/mise/installs/node", "bin/node"}
        }) {
      Path directory = home.resolve(manager[0]);
      if (Files.isDirectory(directory))
        try (var children = Files.list(directory)) {
          children
              .filter(Files::isDirectory)
              .forEach(child -> candidates.add(child.resolve(manager[1])));
        } catch (java.io.IOException ignored) {
        }
    }
    candidates.add(home.resolve(".volta/bin/node"));
    for (String entry :
        environment.getOrDefault("PATH", "").split(Pattern.quote(java.io.File.pathSeparator)))
      if (!entry.isBlank()) candidates.add(Path.of(entry).resolve("node"));
    candidates.add(Path.of("/opt/homebrew/bin/node"));
    candidates.add(Path.of("/usr/local/bin/node"));
    var found = new LinkedHashMap<Path, Map<String, Object>>();
    for (Path candidate : candidates)
      try {
        checkCancellation();
        if (!Files.isExecutable(candidate)) continue;
        Path resolved = candidate.toRealPath();
        if (found.containsKey(resolved)) continue;
        String version =
            commands
                .run(candidate.toString(), List.of("--version"), null, Duration.ofSeconds(5))
                .stdout()
                .trim()
                .replaceFirst("^v", "");
        if (Semver.parse(version) != null)
          found.put(
              resolved,
              object(
                  "executable",
                  candidate.toString(),
                  "bin",
                  candidate.getParent().toString(),
                  "version",
                  version,
                  "parts",
                  List.of(
                      new Semver(version).getMajor(),
                      new Semver(version).getMinor(),
                      new Semver(version).getPatch())));
      } catch (Exception ignored) {
        checkCancellation();
      }
    var sorted = new ArrayList<>(found.values());
    sorted.sort(
        Comparator.comparing((Map<String, Object> value) -> new Semver(text(value, "version")))
            .reversed());
    var versions = new LinkedHashSet<String>();
    return sorted.stream().filter(value -> versions.add(text(value, "version"))).toList();
  }

  public Map<String, Object> resolve(Path root) {
    return resolve(root, packageJson(root));
  }

  public Map<String, Object> resolve(Path root, Map<String, Object> definition) {
    checkCancellation();
    String requested = requirement(root, definition), resolved = resolveAlias(requested);
    String engine = text(map(definition.get("engines")), "node").trim();
    if (!engine.isEmpty() && !validRange(engine))
      throw new RuntimeCompatibilityException(
          "The repository's package.json engines.node is not a valid semver range; no service was started.");
    var installed = installed();
    if (installed.isEmpty())
      throw new RuntimeCompatibilityException(
          "No Node.js runtime is installed. Install the version requested by this repository and try again.");
    var compatible = new ArrayList<Map<String, Object>>();
    for (var candidate : installed) {
      checkCancellation();
      boolean accepted = matchesCandidate(candidate, resolved);
      if (accepted && (engine.isEmpty() || satisfies(text(candidate, "version"), engine)))
        compatible.add(candidate);
    }
    if (compatible.isEmpty())
      throw new RuntimeCompatibilityException(
          "This repository requires Node "
              + requested
              + (!engine.isEmpty() && !engine.equals(requested)
                  ? " and package.json engines.node " + engine
                  : "")
              + ", but Argus found "
              + installed.stream()
                  .map(item -> text(item, "version"))
                  .collect(java.util.stream.Collectors.joining(", "))
              + ". Install a compatible Node version and try again.");
    String localDefault = read(home.resolve(".nvm/alias/default")).trim();
    String resolvedDefault = "";
    if (!localDefault.isEmpty())
      try {
        resolvedDefault = resolveAlias(localDefault);
      } catch (RuntimeCompatibilityException ignored) {
      }
    final String defaultRange = resolvedDefault;
    Map<String, Object> preferred = null;
    boolean usedLocalDefault = false;
    if (!requested.isBlank())
      preferred =
          compatible.stream()
              .filter(item -> new Semver(text(item, "version")).getMajor() % 2 == 0)
              .findFirst()
              .orElse(null);
    if (preferred == null && !defaultRange.isBlank()) {
      preferred =
          compatible.stream()
              .filter(item -> matchesCandidate(item, defaultRange))
              .findFirst()
              .orElse(null);
      usedLocalDefault = preferred != null;
    }
    if (preferred == null)
      preferred =
          compatible.stream()
              .filter(item -> new Semver(text(item, "version")).getMajor() % 2 == 0)
              .findFirst()
              .orElse(compatible.get(0));
    return object(
        "requirement",
        requested,
        "version",
        preferred.get("version"),
        "executable",
        preferred.get("executable"),
        "environment",
        Map.of(
            "PATH",
            text(preferred, "bin")
                + java.io.File.pathSeparator
                + environment.getOrDefault("PATH", "")),
        "source",
        !requested.isBlank()
            ? "repository declaration"
            : usedLocalDefault ? "local default" : "latest installed stable release");
  }

  private void checkCancellation() {
    if (Thread.currentThread().isInterrupted())
      throw new java.util.concurrent.CancellationException("Node runtime discovery was cancelled");
  }

  private boolean matchesCandidate(Map<String, Object> candidate, String requirement) {
    checkCancellation();
    if (!requirement.matches("(?i)lts(?:/.*)?"))
      return satisfies(text(candidate, "version"), requirement);
    if (!satisfies(text(candidate, "version"), "")) return false;
    String codename = "";
    try {
      codename =
          commands
              .run(
                  text(candidate, "executable"),
                  List.of("-p", "process.release.lts || ''"),
                  null,
                  Duration.ofSeconds(5))
              .stdout()
              .trim();
    } catch (RuntimeException error) {
      if (error instanceof java.util.concurrent.CancellationException) throw error;
      checkCancellation();
    }
    String selected =
        requirement.contains("/") ? requirement.substring(requirement.indexOf('/') + 1) : "*";
    return codename.matches("(?i)[a-z][a-z0-9-]*")
        && (selected.equals("*") || codename.equalsIgnoreCase(selected));
  }
}
