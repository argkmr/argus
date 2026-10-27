package com.argus.repositorycontext.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/** Native reader/publisher for the existing private repository artifact schema. */
@Service
public class RepositoryContextService {
  private final Path artifacts;
  private final Path contexts;
  private final AtomicJsonStore json;
  private final ObjectMapper mapper;
  private final AiKitCoverageService coverage;

  public RepositoryContextService(
      ArgusProperties properties,
      AtomicJsonStore json,
      ObjectMapper mapper,
      AiKitCoverageService coverage) {
    artifacts = properties.dataDirectory().resolve("repository-artifacts");
    contexts = properties.dataDirectory().resolve("repository-contexts");
    this.json = json;
    this.mapper = mapper;
    this.coverage = coverage;
  }

  public static String safeName(String input) {
    String name = input.replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^-+|-+$", "");
    return name.isEmpty() || name.equals(".") || name.equals("..")
        ? "repository"
        : name.substring(0, Math.min(80, name.length()));
  }

  public Path artifactRoot(Repository repository) {
    Path root =
        artifacts.resolve(safeName(repository.id() == null ? repository.name() : repository.id()));
    if (Files.isSymbolicLink(artifacts) || Files.isSymbolicLink(root))
      throw new IllegalArgumentException("Private AI-kit storage must not be a symbolic link");
    return root;
  }

  /** Reset only this repository's private generated kit; never its source tree or chats. */
  public synchronized void resetGeneratedKit(Repository repository) {
    Path live = artifactRoot(repository);
    if (!Files.isDirectory(artifacts, LinkOption.NOFOLLOW_LINKS)) return;
    String key = live.getFileName().toString();
    try (var entries = Files.list(artifacts)) {
      for (Path entry :
          entries
              .filter(
                  path -> {
                    String name = path.getFileName().toString();
                    return name.equals(key)
                        || name.matches(
                            Pattern.quote(key)
                                + "\\.(?:generation|previous|refresh)-[0-9a-fA-F-]{36}");
                  })
              .toList()) deleteTree(entry);
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not reset private AI-kit artifacts", error);
    }
  }

  private List<Path> skillFiles(Repository repository) {
    Path directory = artifactRoot(repository).resolve("skills");
    if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) return List.of();
    try (var stream = Files.list(directory)) {
      return stream
          .filter(path -> Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
          .sorted()
          .limit(80)
          .map(path -> path.resolve("SKILL.md"))
          .filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
          .toList();
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not read private repository Skills", error);
    }
  }

  private String bounded(Path file, int limit) {
    try {
      if (Files.isSymbolicLink(file)) return "";
      String value = read(file);
      return value.indexOf('\0') >= 0 ? "" : value.substring(0, Math.min(limit, value.length()));
    } catch (RuntimeException ignored) {
      return "";
    }
  }

  private String description(String contents) {
    var match = Pattern.compile("(?m)^description:\\s*(.+)$").matcher(contents);
    return match.find() ? match.group(1).trim() : "Repository business-flow guidance";
  }

  public List<Map<String, Object>> aiKitContexts(List<Repository> repositories) {
    var result = new ArrayList<Map<String, Object>>();
    for (Repository repository : repositories) {
      Path root = artifactRoot(repository);
      String agents = bounded(root.resolve("AGENTS.md"), 8000);
      var skills = new ArrayList<String>();
      for (Path skill : skillFiles(repository)) {
        String text = bounded(skill, 4000);
        if (!text.isBlank())
          skills.add(
              "- "
                  + skill.getParent().getFileName()
                  + ": "
                  + description(text)
                  + " ("
                  + skill
                  + ")");
      }
      result.add(
          object(
              "repositoryId",
              repository.id(),
              "repositoryName",
              repository.name(),
              "privateRoot",
              root.toString(),
              "context",
              (agents.isBlank() ? "" : "Repository instructions:\n" + agents + "\n\n")
                  + "Available private Skills (open the smallest relevant SKILL.md before investigating):\n"
                  + (skills.isEmpty()
                      ? "- AI-kit generation is still pending; inspect live source directly."
                      : String.join("\n", skills))));
    }
    return result;
  }

  public List<String> skillDirectories(List<Repository> repositories) {
    return repositories.stream()
        .map(this::artifactRoot)
        .filter(Files::isDirectory)
        .map(Path::toString)
        .toList();
  }

  public List<Map<String, Object>> artifactStatus(List<Repository> repositories) {
    var result = new ArrayList<Map<String, Object>>();
    for (var repository : repositories) {
      Path root = artifactRoot(repository), export = Path.of(repository.path()).resolve("argus-ai");
      String privateManifest = bounded(root.resolve("manifest.json"), 8000);
      var metadata = readMap(root.resolve("manifest.json"));
      result.add(
          object(
              "repositoryId",
              repository.id(),
              "repositoryName",
              repository.name(),
              "privateReady",
              !privateManifest.isEmpty(),
              "kitVersion",
              number(metadata.get("version")),
              "sourceRevision",
              text(metadata, "sourceRevision"),
              "coveredEntryPoints",
              number(metadata.get("coveredEntryPoints")),
              "totalEntryPoints",
              number(metadata.get("totalEntryPoints")),
              "privateRoot",
              root.toString(),
              "exported",
              !bounded(export.resolve(".argus-generated.json"), 8000).isEmpty(),
              "exportRoot",
              export.toString()));
    }
    return result;
  }

  private Map<String, Object> readMap(Path file) {
    try {
      if (Files.isSymbolicLink(file)) return Map.of();
      String value = read(file);
      return value.isBlank() ? Map.of() : mapper.readValue(value, LinkedHashMap.class);
    } catch (RuntimeException ignored) {
      return Map.of();
    }
  }

  public Path createGeneratedKitStaging(Repository repository) {
    artifactRoot(repository);
    try {
      Files.createDirectories(artifacts);
      return Files.createDirectory(
          artifacts.resolve(safeName(repository.id()) + ".generation-" + UUID.randomUUID()));
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not create private AI-kit staging directory", error);
    }
  }

  public synchronized Map<String, Object> commitGeneratedKit(
      Repository repository,
      Path staging,
      String provider,
      String revision,
      Map<String, Object> inventory) {
    if (!staging
            .toAbsolutePath()
            .normalize()
            .getParent()
            .equals(artifacts.toAbsolutePath().normalize())
        || !staging.getFileName().toString().startsWith(safeName(repository.id()) + ".generation-")
        || Files.isSymbolicLink(staging))
      throw new IllegalArgumentException("AI-kit staging must be owned by this repository");
    var skills = new ArrayList<String>();
    var descriptions = new LinkedHashMap<String, String>();
    Path skillRoot = inside(staging, "skills");
    try (var entries = Files.list(skillRoot)) {
      for (Path skill :
          entries
              .filter(path -> Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
              .sorted()
              .toList()) {
        String name = skill.getFileName().toString(),
            contents = read(inside(staging, "skills/" + name + "/SKILL.md"));
        if (!contents.isBlank()) {
          skills.add(name);
          descriptions.put(name, description(contents));
        }
      }
    } catch (java.io.IOException error) {
      throw new IllegalArgumentException(
          "The coding agent did not create any business-flow Skills", error);
    }
    if (skills.isEmpty())
      throw new IllegalArgumentException(
          "The coding agent did not create any business-flow Skills");
    String router =
        "# "
            + repository.name()
            + " repository AI kit\n\nThis private AI kit was generated from the configured production branch. Current production source remains authoritative; verify relevant files before proposing or applying a change.\n\n## Skill routing\n\nOpen the smallest relevant Skill before investigating. Use more than one only when the request crosses business flows.\n\n"
            + skills.stream()
                .map(
                    skill ->
                        "- ["
                            + skill
                            + "](skills/"
                            + skill
                            + "/SKILL.md) — "
                            + descriptions.get(skill))
                .collect(java.util.stream.Collectors.joining("\n"))
            + "\n\n## Operating rules\n\n1. Match the request to the Skill descriptions above.\n2. Read the selected SKILL.md and only the source files needed for the task.\n3. Treat Skill content as navigation context, not a substitute for live source.\n4. For cross-repository work, verify every boundary in the applicable repository.\n";
    writeText(staging.resolve("AGENTS.md"), router);
    var validation = coverage.validate(staging, inventory);
    json.write(staging.resolve("entry-point-inventory.json"), inventory);
    var manifest =
        object(
            "version",
            2,
            "generatedBy",
            "Argus coding-agent CLI",
            "repositoryId",
            repository.id(),
            "repositoryName",
            repository.name(),
            "productionBranch",
            repository.productionBranch(),
            "sourceRevision",
            revision,
            "provider",
            provider,
            "generatedAt",
            Instant.now().toString(),
            "skills",
            skills,
            "coveredEntryPoints",
            validation.get("coveredEntryPoints"),
            "totalEntryPoints",
            validation.get("totalEntryPoints"),
            "inventoryFingerprint",
            inventory.get("fingerprint"),
            "coverageFile",
            "skill-coverage.json",
            "exportDirectory",
            "argus-ai");
    json.write(staging.resolve("manifest.json"), manifest);
    Path live = artifactRoot(repository),
        previous = live.resolveSibling(live.getFileName() + ".previous-" + UUID.randomUUID());
    boolean existed = Files.exists(live);
    try {
      if (existed) Files.move(live, previous, StandardCopyOption.ATOMIC_MOVE);
      try {
        Files.move(staging, live, StandardCopyOption.ATOMIC_MOVE);
      } catch (Exception error) {
        if (existed) Files.move(previous, live, StandardCopyOption.ATOMIC_MOVE);
        throw error;
      }
      if (existed) deleteTree(previous);
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not publish the validated private AI kit", error);
    }
    if (Files.exists(Path.of(repository.path()).resolve("argus-ai/.argus-generated.json")))
      exportArtifacts(repository);
    return object(
        "root",
        live.toString(),
        "skills",
        skills,
        "coverage",
        validation.get("coverage"),
        "manifest",
        manifest,
        "validation",
        validation);
  }

  public synchronized Map<String, Object> exportArtifacts(Repository repository) {
    Path source = artifactRoot(repository),
        target = inside(Path.of(repository.path()), "argus-ai"),
        marker = target.resolve(".argus-generated.json");
    if (Files.exists(target)) {
      try (var entries = Files.list(target)) {
        if (entries.findAny().isPresent() && !"Argus".equals(readMap(marker).get("generatedBy")))
          throw new IllegalArgumentException("argus-ai already exists and is not managed by Argus");
      } catch (java.io.IOException error) {
        throw new IllegalStateException(error);
      }
    }
    try {
      copyTree(source, target);
      json.write(
          marker,
          object(
              "generatedBy",
              "Argus",
              "repositoryId",
              repository.id(),
              "exportedAt",
              Instant.now().toString()));
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not export repository AI kit", error);
    }
    return object(
        "repositoryId",
        repository.id(),
        "repositoryName",
        repository.name(),
        "exportRoot",
        target.toString(),
        "exported",
        true);
  }

  public static void writeText(Path file, String text) {
    com.argus.runtime.service.LocalEnvironmentService.atomicWrite(file, text, true);
  }

  private static void copyTree(Path source, Path target) throws java.io.IOException {
    if (Files.isSymbolicLink(source) || Files.isSymbolicLink(target))
      throw new IllegalArgumentException("AI-kit artifacts must not contain symbolic links");
    if (Files.isDirectory(source, LinkOption.NOFOLLOW_LINKS)) {
      Files.createDirectories(target);
      try (var items = Files.list(source)) {
        for (Path item : items.toList()) copyTree(item, target.resolve(item.getFileName()));
      }
    } else Files.copy(source, target, StandardCopyOption.REPLACE_EXISTING);
  }

  public static void deleteTree(Path root) throws java.io.IOException {
    if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return;
    try (var paths = Files.walk(root)) {
      for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList())
        Files.deleteIfExists(path);
    }
  }

  public synchronized List<String> removeLegacyProfile(Repository repository) {
    String live = safeName(repository.id() == null ? repository.name() : repository.id()),
        legacy = safeName(repository.name());
    if (live.equals(legacy)) return List.of();
    var removed = new ArrayList<String>();
    for (String extension : List.of(".md", ".json")) {
      Path target = contexts.resolve(legacy + extension);
      try {
        if (Files.deleteIfExists(target)) removed.add(target.toString());
      } catch (java.io.IOException error) {
        throw new IllegalStateException("Could not remove legacy repository profile", error);
      }
    }
    return removed;
  }

  public synchronized Map<String, Object> purgeRepository(Repository repository) {
    String key = safeName(repository.id() == null ? repository.name() : repository.id());
    int contextFiles = 0, artifactDirectories = 0;
    for (Path directory : List.of(contexts, artifacts)) {
      if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) continue;
      try (var entries = Files.list(directory)) {
        var selected =
            entries
                .filter(
                    path -> {
                      String name = path.getFileName().toString();
                      return directory.equals(contexts)
                          ? name.equals(key + ".md")
                              || name.equals(key + ".json")
                              || name.startsWith(key + ".refresh-")
                              || name.startsWith(key + ".previous-")
                          : name.equals(key)
                              || name.startsWith(key + ".refresh-")
                              || name.startsWith(key + ".previous-")
                              || name.startsWith(key + ".generation-");
                    })
                .toList();
        for (Path target : selected) deleteTree(target);
        if (directory.equals(contexts)) contextFiles = selected.size();
        else artifactDirectories = selected.size();
      } catch (java.io.IOException error) {
        throw new IllegalStateException("Could not remove owned repository artifacts", error);
      }
    }
    Path export = Path.of(repository.path()).resolve("argus-ai");
    var marker =
        Files.isDirectory(Path.of(repository.path())) && !Files.isSymbolicLink(export)
            ? readMap(inside(Path.of(repository.path()), "argus-ai/.argus-generated.json"))
            : Map.<String, Object>of();
    boolean exported =
        "Argus".equals(marker.get("generatedBy"))
            && repository.id().equals(marker.get("repositoryId"));
    if (exported)
      try {
        deleteTree(export);
      } catch (java.io.IOException error) {
        throw new IllegalStateException("Could not remove generated repository export", error);
      }
    return object(
        "contextFilesDeleted",
        contextFiles,
        "artifactDirectoriesDeleted",
        artifactDirectories,
        "exportedKitDeleted",
        exported);
  }
}
