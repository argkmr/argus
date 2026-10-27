package com.argus.repositorycontext.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/** Deterministic source navigation and bounded retrieval; no inference or JavaScript runtime. */
@Service
public class RepositoryBriefService {
  private static final Set<String> IGNORED =
      Set.of(
          ".git",
          ".idea",
          ".next",
          ".gradle",
          ".mvn",
          ".vscode",
          "build",
          "coverage",
          "dist",
          "node_modules",
          "out",
          "target",
          "vendor",
          "venv",
          ".venv",
          "__pycache__");
  private static final Set<String> REFERENCES =
      Set.of(
          "AGENTS.md",
          "README.md",
          "README",
          "package.json",
          "pom.xml",
          "settings.gradle",
          "settings.gradle.kts",
          "build.gradle",
          "build.gradle.kts",
          "pyproject.toml",
          "requirements.txt",
          "go.mod",
          "Cargo.toml",
          "docker-compose.yml",
          "docker-compose.yaml",
          "Makefile");
  private static final Set<String> STOP_WORDS =
      Set.of(
          "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it",
          "of", "on", "or", "that", "the", "this", "to", "what", "when", "where", "which", "with");
  private static final Pattern
      SOURCE =
          Pattern.compile(
              ".*\\.(java|kt|kts|js|mjs|cjs|jsx|ts|tsx|py|go|rs|rb|php|cs|scala)$",
              Pattern.CASE_INSENSITIVE),
      SENSITIVE =
          Pattern.compile(
              "(^|/)(\\.env(?:\\..*)?|.*(?:secret|credential|private[-_.]?key).*)$",
              Pattern.CASE_INSENSITIVE),
      SIGNAL =
          Pattern.compile(
              "@(Get|Post|Put|Patch|Delete|Request)Mapping\\b|\\b(?:router|app)\\.(?:get|post|put|patch|delete)\\s*\\(|\\b(?:GET|POST|PUT|PATCH|DELETE)\\s+[\"'`/]|\\b(?:class|interface|enum|record)\\s+[A-Z][A-Za-z0-9_]*");
  private final Path directory;
  private final ObjectMapper mapper;
  private final AtomicJsonStore json;
  private final Map<String, Map<String, Object>> cache = new LinkedHashMap<>();
  private Map<String, Object> maintenance =
      object(
          "status",
          "idle",
          "total",
          0,
          "completed",
          0,
          "failed",
          0,
          "startedAt",
          null,
          "completedAt",
          null);

  public RepositoryBriefService(
      ArgusProperties properties, ObjectMapper mapper, AtomicJsonStore json) {
    directory = properties.dataDirectory().resolve("repository-contexts");
    this.mapper = mapper;
    this.json = json;
  }

  private String key(Repository repository) {
    return RepositoryContextService.safeName(
        repository.id() == null ? repository.name() : repository.id());
  }

  private Path root(Repository repository) {
    String source = text(repository.additionalProperties(), "sourcePath");
    return Path.of(source.isEmpty() ? repository.path() : source);
  }

  private String readable(Path file, int limit) {
    try {
      String source = read(file);
      return source.indexOf('\0') < 0 ? source.substring(0, Math.min(limit, source.length())) : "";
    } catch (RuntimeException ignored) {
      return "";
    }
  }

  private String version(Repository repository, List<String> references) {
    Path root = root(repository);
    var targets =
        new ArrayList<Path>(List.of(root, root.resolve(".git/HEAD"), root.resolve(".git/index")));
    references.forEach(file -> targets.add(root.resolve(file)));
    var values = new ArrayList<String>();
    for (Path target : targets)
      try {
        values.add(
            target + ":" + Files.size(target) + ":" + Files.getLastModifiedTime(target).toMillis());
      } catch (java.io.IOException ignored) {
        values.add(target + ":missing");
      }
    return AiKitCoverageService.hash(String.join("\n", values));
  }

  private Map<String, Object> disk(Repository repository) {
    try {
      var data =
          map(
              mapper.readValue(
                  read(directory.resolve(key(repository) + ".json")), LinkedHashMap.class));
      if (number(data.get("schemaVersion")) != 2
          || !repository.path().equals(data.get("repositoryPath"))
          || !(data.get("result") instanceof Map)) return null;
      var result = copyMap(map(data.get("result")));
      result.put("context", read(directory.resolve(key(repository) + ".md")));
      result.put("path", directory.resolve(key(repository) + ".md").toString());
      return object(
          "version", data.get("version"), "references", data.get("references"), "result", result);
    } catch (RuntimeException ignored) {
      return null;
    }
  }

  public synchronized Map<String, Object> build(Repository repository) {
    var cached = cache.get(key(repository));
    if (cached == null) cached = disk(repository);
    if (cached != null
        && text(cached, "version").equals(version(repository, strings(cached.get("references"))))) {
      cache.put(key(repository), cached);
      return copyMap(map(cached.get("result")));
    }
    return fresh(repository);
  }

  private Map<String, Object> fresh(Repository repository) {
    Path root = root(repository);
    var files = new ArrayList<String>();
    var directories = new LinkedHashSet<String>();
    var queue = new ArrayDeque<Path>();
    queue.add(root);
    while (!queue.isEmpty() && files.size() < 4000) {
      Path current = queue.remove();
      try (var entries = Files.list(current)) {
        for (Path child : entries.sorted().toList()) {
          if (Files.isSymbolicLink(child)) continue;
          String name = child.getFileName().toString(),
              relative = root.relativize(child).toString().replace('\\', '/');
          if (Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS)) {
            if (IGNORED.contains(name) || name.startsWith(".")) continue;
            directories.add(relative);
            queue.add(child);
          } else if (Files.isRegularFile(child, LinkOption.NOFOLLOW_LINKS)
              && !SENSITIVE.matcher(relative).find()) files.add(relative);
          if (files.size() >= 4000) break;
        }
      } catch (java.io.IOException ignored) {
      }
    }
    var signals =
        files.stream()
            .filter(
                file ->
                    SOURCE.matcher(file).matches()
                        && Pattern.compile(
                                "controller|route|endpoint|handler|resource|service|usecase|workflow|flow|api",
                                Pattern.CASE_INSENSITIVE)
                            .matcher(file)
                            .find())
            .limit(90)
            .toList();
    var references =
        new LinkedHashSet<>(
            files.stream()
                .filter(
                    file ->
                        REFERENCES.contains(Path.of(file).getFileName().toString())
                            || file.matches("(?i)(?:.*/)?AGENTS\\.md"))
                .limit(18)
                .toList());
    references.addAll(signals);
    var sections = new ArrayList<String>();
    int bytes = 0;
    for (String relative : references) {
      if (bytes >= 18000) break;
      String content = readable(root.resolve(relative), Math.min(6000, 18000 - bytes));
      if (!content.isBlank()) {
        bytes += content.length();
        sections.add("### " + relative + "\n\n" + content.trim());
      }
    }
    var sourceFiles =
        files.stream().filter(file -> SOURCE.matcher(file).matches()).limit(900).toList();
    var groups = new LinkedHashMap<String, List<List<String>>>();
    for (String file : sourceFiles) {
      String name = file.split("/")[0];
      var batches =
          groups.computeIfAbsent(name, ignored -> new ArrayList<>(List.of(new ArrayList<>())));
      if (batches.get(batches.size() - 1).size() >= 55) batches.add(new ArrayList<>());
      batches.get(batches.size() - 1).add(file);
    }
    var navigation = new ArrayList<String>();
    groups.forEach(
        (name, batches) -> {
          for (int index = 0; index < batches.size(); index++)
            navigation.add(
                "### Source paths · "
                    + name
                    + (batches.size() > 1 ? " · " + (index + 1) : "")
                    + "\n\n"
                    + batches.get(index).stream()
                        .map(file -> "- " + file)
                        .collect(java.util.stream.Collectors.joining("\n")));
        });
    var signalSections = new ArrayList<String>();
    for (String relative : signals) {
      var matching =
          readable(root.resolve(relative), 12000)
              .lines()
              .map(String::trim)
              .filter(line -> SIGNAL.matcher(line).find())
              .limit(8)
              .map(line -> "- " + line.substring(0, Math.min(300, line.length())))
              .toList();
      if (!matching.isEmpty())
        signalSections.add("### Code signals · " + relative + "\n\n" + String.join("\n", matching));
    }
    var extensions = new LinkedHashMap<String, Integer>();
    for (String file : files) {
      String name = Path.of(file).getFileName().toString();
      int dot = name.lastIndexOf('.');
      String extension = dot > 0 ? name.substring(dot).toLowerCase() : "[no extension]";
      extensions.merge(extension, 1, Integer::sum);
    }
    String extensionSummary =
        extensions.entrySet().stream()
            .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
            .limit(12)
            .map(item -> item.getKey() + ": " + item.getValue())
            .collect(java.util.stream.Collectors.joining(", "));
    var top = files.stream().map(file -> file.split("/")[0]).distinct().limit(80).toList();
    var roots =
        directories.stream()
            .filter(
                path ->
                    path.matches(
                        "(?i)(?:.*/)?(?:src|app|lib|server|services|packages|modules|test|tests)"))
            .limit(60)
            .toList();
    String signature =
        AiKitCoverageService.hash(
            mapper.writeValueAsString(
                object(
                    "files",
                    files,
                    "references",
                    references,
                    "sections",
                    sections,
                    "navigationSections",
                    navigation,
                    "signalSections",
                    signalSections)));
    String generated = Instant.now().toString();
    String context =
        "# Argus repository brief: "
            + repository.name()
            + "\n\nGenerated automatically from the connected repository at "
            + generated
            + ". This is a navigation map, not a substitute for reading live source before making claims or changes.\n\n- Repository path: "
            + repository.path()
            + "\n- Production source branch: "
            + (repository.productionBranch().isEmpty()
                ? "main/master auto-detected"
                : repository.productionBranch())
            + "\n- Snapshot policy: fresh remote production branch in an isolated worktree; the developer working tree is never indexed\n- Indexed files: "
            + files.size()
            + (queue.isEmpty() ? "" : "+ (scan capped)")
            + "\n- Dominant file types: "
            + fallback(extensionSummary, "none detected")
            + "\n- Top-level entries: "
            + fallback(String.join(", ", top), "none detected")
            + "\n- Detected source roots: "
            + fallback(String.join(", ", roots), "none detected")
            + "\n- Indexed source paths: "
            + sourceFiles.size()
            + "\n- Source navigation sections: "
            + navigation.size()
            + "\n- Route and code-signal sections: "
            + signalSections.size()
            + "\n- Context fingerprint: "
            + signature
            + "\n\n## Operating rule\n\nWork only inside this repository for repository-scoped tasks. Treat this brief as orientation, then inspect the current implementation, tests, Git state, and repository instructions relevant to the request. Never infer behavior solely from filenames.\n\n## Repository references\n\n"
            + fallback(
                String.join("\n\n", sections),
                "No README, AGENTS.md, or supported project manifest was found. Inspect live source before acting.")
            + "\n\n## Source navigation index\n\nThis deterministic index is generated without an AI call. Retrieve matching paths first, then inspect only the live files needed for the request.\n\n"
            + fallback(String.join("\n\n", navigation), "No supported source files were detected.")
            + "\n\n## Route and architecture signals\n\nThese are navigation hints extracted from likely controllers, routes, handlers, services, and workflows. They are not proof of runtime behavior.\n\n"
            + fallback(
                String.join("\n\n", signalSections),
                "No route or architecture declarations were detected.");
    context = context.substring(0, Math.min(48000, context.length()));
    Path output = directory.resolve(key(repository) + ".md");
    RepositoryContextService.writeText(output, context + "\n");
    var result =
        object(
            "repositoryId",
            repository.id(),
            "repositoryName",
            repository.name(),
            "path",
            output.toString(),
            "fingerprint",
            signature,
            "context",
            context,
            "indexedFiles",
            files.size(),
            "indexedSourcePaths",
            sourceFiles.size(),
            "sourceSections",
            navigation.size(),
            "signalSections",
            signalSections.size());
    var persisted = copyMap(result);
    persisted.remove("context");
    String version = version(repository, new ArrayList<>(references));
    json.write(
        directory.resolve(key(repository) + ".json"),
        object(
            "schemaVersion",
            2,
            "repositoryPath",
            repository.path(),
            "version",
            version,
            "references",
            new ArrayList<>(references),
            "result",
            persisted));
    cache.put(
        key(repository),
        object("version", version, "references", new ArrayList<>(references), "result", result));
    return copyMap(result);
  }

  private static String fallback(String value, String fallback) {
    return value.isEmpty() ? fallback : value;
  }

  private static List<String> terms(String query) {
    var terms = new LinkedHashSet<String>();
    var matcher = Pattern.compile("[a-z0-9][a-z0-9_.-]+").matcher(query.toLowerCase());
    while (matcher.find()) if (!STOP_WORDS.contains(matcher.group())) terms.add(matcher.group());
    return new ArrayList<>(terms);
  }

  private static double relevance(String content, List<String> terms) {
    if (terms.isEmpty()) return 0;
    String lower = content.toLowerCase();
    double score = 0;
    for (String term : terms) {
      int occurrences = 0, index = 0;
      while ((index = lower.indexOf(term, index)) >= 0) {
        occurrences++;
        index += term.length();
      }
      if (occurrences > 0) score += 1 + Math.min(occurrences, 5) * .35;
    }
    if (Pattern.compile(
            "^#{2,3}\\s+(?:operating rule|.*agents\\.md)",
            Pattern.CASE_INSENSITIVE | Pattern.MULTILINE)
        .matcher(content)
        .find()) score += 1.5;
    return score;
  }

  private static List<String> sections(String context) {
    var result = new ArrayList<String>();
    for (String piece : context.split("\\n(?=#{2,3}\\s)")) {
      piece = piece.trim();
      if (piece.isEmpty()) continue;
      if (piece.length() <= 6000) result.add(piece);
      else {
        String chunk = "";
        for (String paragraph : piece.split("\\n\\n+")) {
          if (chunk.isEmpty()) chunk = paragraph;
          else if (chunk.length() + paragraph.length() > 5500) {
            result.add(chunk);
            chunk = paragraph;
          } else chunk += "\n\n" + paragraph;
        }
        if (!chunk.isEmpty()) result.add(chunk);
      }
    }
    return result;
  }

  public synchronized Map<String, Object> retrieve(
      List<Repository> repositories, String query, String scope, boolean explicitSelection) {
    int hits = (int) repositories.stream().filter(repo -> cache.containsKey(key(repo))).count(),
        available = 0;
    var terms = terms(query);
    var ranked = new ArrayList<Map<String, Object>>();
    for (Repository repository : repositories) {
      var brief = build(repository);
      available += text(brief, "context").length();
      String identity = (repository.name() + " " + repository.path()).toLowerCase();
      boolean explicit = terms.stream().anyMatch(identity::contains);
      ranked.add(
          object(
              "repository",
              repository,
              "brief",
              brief,
              "explicit",
              explicit,
              "score",
              relevance(identity + "\n" + text(brief, "context"), terms) + (explicit ? 12 : 0)));
    }
    if (!explicitSelection)
      ranked.sort(
          Comparator.comparingDouble(
                  (Map<String, Object> item) -> ((Number) item.get("score")).doubleValue())
              .reversed());
    int
        maximum =
            explicitSelection
                ? Math.min(6, ranked.size())
                : "global".equals(scope) ? Math.min(4, ranked.size()) : Math.min(1, ranked.size()),
        budget = "global".equals(scope) ? 24000 : 18000,
        remaining = budget,
        chunks = 0;
    var selected = new ArrayList<Map<String, Object>>();
    for (var entry : ranked.subList(0, maximum)) {
      if (remaining < 600) break;
      int repoRemaining = Math.max(1200, budget / maximum);
      var candidates = new ArrayList<>(sections(text(map(entry.get("brief")), "context")));
      candidates.sort(
          Comparator.comparingDouble((String item) -> relevance(item, terms)).reversed());
      var chosen = new ArrayList<String>();
      for (String section : candidates) {
        if (chosen.size() >= 4 || remaining < 600 || repoRemaining < 300) break;
        String content =
            section.substring(
                0, Math.min(section.length(), Math.min(6000, Math.min(remaining, repoRemaining))));
        if (content.isBlank()) continue;
        chosen.add(content);
        remaining -= content.length();
        repoRemaining -= content.length();
      }
      if (chosen.isEmpty()) continue;
      chunks += chosen.size();
      var value = copyMap(map(entry.get("brief")));
      value.put(
          "context",
          "# Repository context: "
              + ((Repository) entry.get("repository")).name()
              + "\n\n"
              + String.join("\n\n", chosen));
      value.put("score", Math.round(((Number) entry.get("score")).doubleValue() * 100) / 100d);
      value.put("chunks", chosen.size());
      selected.add(value);
    }
    int selectedCharacters =
        selected.stream().mapToInt(item -> text(item, "context").length()).sum();
    return object(
        "contexts",
        selected,
        "metrics",
        object(
            "strategy",
            explicitSelection ? "explicit-repository-selection" : "local-ranked-retrieval",
            "scannedRepositories",
            repositories.size(),
            "selectedRepositories",
            selected.size(),
            "selectedRepositoryNames",
            selected.stream().map(item -> item.get("repositoryName")).toList(),
            "selectedChunks",
            chunks,
            "availableCharacters",
            available,
            "selectedCharacters",
            selectedCharacters,
            "estimatedInputTokens",
            (int) Math.ceil(selectedCharacters / 4d),
            "estimatedTokensAvoided",
            (int) Math.ceil(Math.max(0, available - selectedCharacters) / 4d),
            "budgetCharacters",
            budget,
            "profileCacheHits",
            hits,
            "profileRefreshes",
            Math.max(0, repositories.size() - hits),
            "indexingModelCalls",
            0,
            "rankingModelCalls",
            0));
  }

  public synchronized Map<String, Object> ensureAll(List<Repository> repositories, boolean force) {
    maintenance =
        object(
            "status",
            repositories.isEmpty() ? "complete" : "running",
            "total",
            repositories.size(),
            "completed",
            0,
            "failed",
            0,
            "startedAt",
            Instant.now().toString(),
            "completedAt",
            null);
    for (Repository repository : repositories)
      try {
        if (force) {
          cache.remove(key(repository));
          Files.deleteIfExists(directory.resolve(key(repository) + ".json"));
        }
        build(repository);
      } catch (Exception error) {
        maintenance.put("failed", number(maintenance.get("failed")) + 1);
      } finally {
        maintenance.put("completed", number(maintenance.get("completed")) + 1);
      }
    maintenance.put(
        "status", number(maintenance.get("failed")) > 0 ? "complete-with-errors" : "complete");
    maintenance.put("completedAt", Instant.now().toString());
    return copyMap(maintenance);
  }

  private static String capture(String context, String pattern) {
    var matcher = Pattern.compile(pattern, Pattern.MULTILINE).matcher(context);
    return matcher.find() ? matcher.group(1).trim() : "";
  }

  public synchronized Map<String, Object> status() {
    var result =
        object(
            "cachedRepositories",
            0,
            "cachedCharacters",
            0,
            "indexedFiles",
            0,
            "indexedSourcePaths",
            0,
            "sourceSections",
            0,
            "signalSections",
            0,
            "fingerprints",
            new ArrayList<>(),
            "maintenance",
            copyMap(maintenance));
    var entries = new LinkedHashMap<String, Map<String, Object>>();
    if (Files.isDirectory(directory))
      try (var files = Files.list(directory)) {
        for (Path file :
            files
                .filter(
                    path ->
                        path.toString().endsWith(".md")
                            && Files.isRegularFile(path, java.nio.file.LinkOption.NOFOLLOW_LINKS))
                .toList()) {
          String context = readable(file, 48000),
              key = file.getFileName().toString().replaceFirst("\\.md$", "");
          String name = capture(context, "^# Argus repository brief:\\s*(.+)$");
          var value =
              object(
                  "repositoryId",
                  key,
                  "repositoryName",
                  name.isEmpty() ? key : name,
                  "context",
                  context,
                  "fingerprint",
                  capture(context, "^- Context fingerprint:\\s*(\\S+)"));
          String[][] fields = {
            {"indexedFiles", "Indexed files"},
            {"indexedSourcePaths", "Indexed source paths"},
            {"sourceSections", "Source navigation sections"},
            {"signalSections", "Route and code-signal sections"}
          };
          for (var field : fields)
            value.put(field[0], number(capture(context, "^- " + field[1] + ":\\s*(\\d+)")));
          entries.put(text(value, "repositoryName"), value);
        }
      } catch (java.io.IOException error) {
        throw new IllegalStateException("Could not inspect repository briefs", error);
      }
    cache
        .values()
        .forEach(
            item -> {
              var value = map(item.get("result"));
              entries.put(text(value, "repositoryName"), value);
            });
    result.put("cachedRepositories", entries.size());
    result.put(
        "cachedCharacters",
        entries.values().stream().mapToInt(item -> text(item, "context").length()).sum());
    for (String field :
        List.of("indexedFiles", "indexedSourcePaths", "sourceSections", "signalSections"))
      result.put(field, entries.values().stream().mapToLong(item -> number(item.get(field))).sum());
    result.put(
        "fingerprints",
        entries.values().stream()
            .map(
                item ->
                    object(
                        "repositoryId",
                        item.get("repositoryId"),
                        "repositoryName",
                        item.get("repositoryName"),
                        "fingerprint",
                        item.get("fingerprint")))
            .toList());
    return result;
  }

  public synchronized int purge(Repository repository) {
    cache.remove(key(repository));
    if (!Files.isDirectory(directory)) return 0;
    try (var entries = Files.list(directory)) {
      var selected =
          entries
              .filter(
                  file -> {
                    String name = file.getFileName().toString(), key = key(repository);
                    return name.equals(key + ".md")
                        || name.equals(key + ".json")
                        || name.startsWith(key + ".refresh-")
                        || name.startsWith(key + ".previous-");
                  })
              .toList();
      for (Path file : selected) Files.deleteIfExists(file);
      return selected.size();
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not remove repository briefs", error);
    }
  }
}
