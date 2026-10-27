package com.argus.workspace.service;

import com.argus.common.error.NotFoundException;
import com.argus.common.process.CommandRunner;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.domain.Workspace;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.repository.WorkspaceRepository;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class WorkspaceService {
  private final WorkspaceRepository repository;
  private final CommandRunner commands;

  public WorkspaceService(WorkspaceRepository repository, CommandRunner commands) {
    this.repository = repository;
    this.commands = commands;
  }

  public synchronized WorkspaceResponse snapshot() {
    Workspace state = repository.get();
    var connected = state.repositories.stream().map(Repository::id).toList();
    var extras = new LinkedHashMap<>(state.additionalProperties());
    extras.put("disconnectedRepositories", ListCopy.of(state.disconnectedRepositories));
    return new WorkspaceResponse(
        state.version,
        state.activeRepositoryId,
        java.util.Collections.unmodifiableMap(new LinkedHashMap<>(state.preferences)),
        ListCopy.of(state.repositories),
        ListCopy.maps(
            state.runConfigurations.stream()
                .filter(item -> connected.contains(item.get("repositoryId")))
                .toList()),
        ListCopy.maps(
            state.apiRequests.stream()
                .filter(item -> connected.contains(item.get("repositoryId")))
                .toList()),
        state.javaProjectSettings.entrySet().stream()
            .filter(entry -> connected.contains(entry.getKey()))
            .collect(
                java.util.stream.Collectors.toUnmodifiableMap(
                    Map.Entry::getKey, Map.Entry::getValue)),
        extras);
  }

  /** Lightweight authoritative state for repository headers, IDE launches and Services. */
  public synchronized Map<String, Object> runtimeState() {
    var state = repository.get();
    var connected = state.repositories.stream().map(Repository::id).toList();
    return Map.of(
        "repositories",
        ListCopy.of(state.repositories),
        "runConfigurations",
        ListCopy.maps(
            state.runConfigurations.stream()
                .filter(item -> connected.contains(item.get("repositoryId")))
                .toList()));
  }

  public synchronized Repository addRepository(String inputPath) {
    if (inputPath == null || inputPath.isBlank())
      throw new IllegalArgumentException("Repository path is required");
    Path requested = Path.of(inputPath).toAbsolutePath().normalize();
    String root =
        commands
            .run(
                "git",
                java.util.List.of("-C", requested.toString(), "rev-parse", "--show-toplevel"),
                null,
                Duration.ofSeconds(30))
            .stdout()
            .trim();
    Path resolved = Path.of(root).toAbsolutePath().normalize();
    Workspace state = repository.get();
    for (Repository existing : state.repositories) {
      if (Path.of(existing.path()).equals(resolved)) {
        state.activeRepositoryId = existing.id();
        repository.save();
        return existing;
      }
    }
    // Only this explicit registration path reconnects saved identities. Reading the
    // workspace or starting Argus never moves an archived repository back here.
    for (Repository saved : ListCopy.of(state.disconnectedRepositories))
      if (Path.of(saved.path()).equals(resolved)) {
        state.disconnectedRepositories.remove(saved);
        state.repositories.add(saved);
        state.activeRepositoryId = saved.id();
        repository.save();
        return saved;
      }
    Repository added =
        new Repository(
            UUID.randomUUID().toString(),
            resolved.getFileName().toString(),
            resolved.toString(),
            Instant.now().toString(),
            productionBranch(resolved));
    state.repositories.add(added);
    state.activeRepositoryId = added.id();
    repository.save();
    return added;
  }

  public synchronized void activate(String id) {
    requireRepository(id);
    repository.get().activeRepositoryId = id;
    repository.save();
  }

  /** Onboarding placement differs from the compatibility registration endpoint. */
  public synchronized Repository onboardRepository(String inputPath, String branch) {
    var existingIds = repository.get().repositories.stream().map(Repository::id).toList();
    var retainedIds =
        repository.get().disconnectedRepositories.stream().map(Repository::id).toList();
    Repository added = addRepository(inputPath);
    boolean existing = existingIds.contains(added.id()) || retainedIds.contains(added.id());
    if ((!existing || added.productionBranch().isBlank()) && branch != null && !branch.isBlank())
      added.productionBranch = branch.trim();
    if (!existing) {
      detachRepositoryGroups(java.util.List.of(added.id()));
    }
    repository.save();
    return added;
  }

  public synchronized Map<String, Object> createRepositoryTabGroup(
      String name, java.util.List<String> selected) {
    var ids =
        selected.stream()
            .distinct()
            .filter(
                id -> repository.get().repositories.stream().anyMatch(item -> id.equals(item.id())))
            .toList();
    if (ids.size() < 2) return null;
    detachRepositoryGroups(ids);
    var groups = groups();
    var group = new LinkedHashMap<String, Object>();
    group.put("id", UUID.randomUUID().toString());
    String label = name == null || name.isBlank() ? "Repository group" : name.trim();
    group.put("name", label.substring(0, Math.min(40, label.length())));
    group.put(
        "color",
        java.util.List.of("blue", "violet", "magenta", "orange", "rose", "cyan")
            .get(groups.size() % 6));
    group.put("collapsed", false);
    group.put("repositoryIds", ids);
    groups.add(group);
    repository.get().preferences.put("repositoryTabGroups", groups);
    repository.save();
    return group;
  }

  @SuppressWarnings("unchecked")
  private java.util.List<Map<String, Object>> groups() {
    Object value = repository.get().preferences.get("repositoryTabGroups");
    return value instanceof java.util.List<?> list
        ? list.stream()
            .filter(Map.class::isInstance)
            .map(item -> new LinkedHashMap<>((Map<String, Object>) item))
            .collect(java.util.stream.Collectors.toCollection(java.util.ArrayList::new))
        : new java.util.ArrayList<>();
  }

  public synchronized int detachRepositoryGroups(java.util.List<String> ids) {
    int deleted = 0;
    var groups = groups();
    for (var group : groups) {
      Object value = group.get("repositoryIds");
      var before = value instanceof java.util.List<?> list ? list : java.util.List.of();
      var after = before.stream().filter(id -> !ids.contains(String.valueOf(id))).toList();
      deleted += before.size() - after.size();
      group.put("repositoryIds", after);
    }
    groups.removeIf(group -> ((java.util.List<?>) group.get("repositoryIds")).isEmpty());
    repository.get().preferences.put("repositoryTabGroups", groups);
    return deleted;
  }

  public synchronized Map<String, Object> javaSettings(String id) {
    requireRepository(id);
    return new LinkedHashMap<>(repository.get().javaProjectSettings.getOrDefault(id, Map.of()));
  }

  public synchronized Map<String, Object> saveJavaSettings(String id, Map<String, Object> input) {
    requireRepository(id);
    var settings = new LinkedHashMap<>(input);
    settings.put("updatedAt", Instant.now().toString());
    repository.get().javaProjectSettings.put(id, settings);
    repository.save();
    return settings;
  }

  public synchronized Map<String, Object> runConfiguration(String id) {
    return repository.get().runConfigurations.stream()
        .filter(item -> id.equals(item.get("id")))
        .findFirst()
        .orElseThrow(() -> new NotFoundException("Run configuration not found"));
  }

  public synchronized Map<String, Object> saveRunConfiguration(Map<String, Object> input) {
    String repositoryId = text(input, "repositoryId", "");
    requireRepository(repositoryId);
    String id = text(input, "id", UUID.randomUUID().toString());
    repository.get().runConfigurations.stream()
        .filter(item -> id.equals(item.get("id")))
        .findFirst()
        .ifPresent(
            existing -> {
              if (!repositoryId.equals(existing.get("repositoryId")))
                throw new IllegalArgumentException(
                    "Run configuration does not belong to this repository");
            });
    var config = new LinkedHashMap<String, Object>();
    config.put("id", id);
    config.put("repositoryId", repositoryId);
    for (String key :
        java.util.List.of(
            "name",
            "executable",
            "packageManager",
            "installExecutable",
            "dependencyDirectory",
            "environmentFile",
            "launchSource",
            "configFile",
            "healthUrl"))
      config.put(key, text(input, key, key.equals("name") ? "Unnamed service" : ""));
    if (text(config, "executable", "").isBlank())
      throw new IllegalArgumentException("Executable is required");
    config.put("cwd", text(input, "cwd", "."));
    for (String key : java.util.List.of("args", "installArgs", "secretKeys", "environmentKeys"))
      config.put(
          key,
          input.get(key) instanceof java.util.List<?> list
              ? list.stream().map(String::valueOf).toList()
              : java.util.List.of());
    config.put(
        "env", input.get("env") instanceof Map<?, ?> map ? new LinkedHashMap<>(map) : Map.of());
    boolean ui = "ui".equals(input.get("runtimeType"));
    config.put("runtimeType", ui ? "ui" : "service");
    if (ui) config.put("configFile", "");
    config.put(
        "environmentFormat", "vault".equals(input.get("environmentFormat")) ? "vault" : "dotenv");
    config.put("environmentUpdatedAt", input.get("environmentUpdatedAt"));
    Object appPort =
        input.get("applicationPort") == null ? input.get("port") : input.get("applicationPort");
    config.put(
        "port",
        com.argus.runtime.service.RuntimeData.number(appPort) == 0
            ? null
            : com.argus.runtime.service.RuntimeData.number(appPort));
    config.put(
        "managementPort",
        com.argus.runtime.service.RuntimeData.number(input.get("managementPort")) == 0
            ? null
            : com.argus.runtime.service.RuntimeData.number(input.get("managementPort")));
    config.put("updatedAt", Instant.now().toString());
    var configs = repository.get().runConfigurations;
    int index = -1;
    for (int i = 0; i < configs.size(); i++) if (id.equals(configs.get(i).get("id"))) index = i;
    if (index < 0) configs.add(config);
    else configs.set(index, config);
    repository.save();
    return new LinkedHashMap<>(config);
  }

  public synchronized void removeRunConfiguration(String id) {
    runConfiguration(id);
    repository.get().runConfigurations.removeIf(item -> id.equals(item.get("id")));
    repository.save();
  }

  public synchronized Map<String, Object> updateRunConfiguration(
      String id, Map<String, Object> changes) {
    var config = runConfiguration(id);
    config.putAll(changes);
    config.put("updatedAt", Instant.now().toString());
    repository.save();
    return new LinkedHashMap<>(config);
  }

  private static String text(Map<String, Object> input, String key, String fallback) {
    Object value = input.get(key);
    return value == null || String.valueOf(value).isBlank()
        ? fallback
        : String.valueOf(value).trim();
  }

  public synchronized Map<String, Object> preferences(Map<String, Object> updates) {
    repository.get().preferences.putAll(updates == null ? Map.of() : updates);
    repository.save();
    return java.util.Collections.unmodifiableMap(new LinkedHashMap<>(repository.get().preferences));
  }

  public synchronized Map<String, Object> remove(String id) {
    requireRepository(id);
    Workspace state = repository.get();
    state.repositories.removeIf(item -> item.id().equals(id));
    state.runConfigurations.removeIf(item -> id.equals(item.get("repositoryId")));
    state.apiRequests.removeIf(item -> id.equals(item.get("repositoryId")));
    state.javaProjectSettings.remove(id);
    detachRepositoryGroups(java.util.List.of(id));
    if (id.equals(state.activeRepositoryId))
      state.activeRepositoryId =
          state.repositories.isEmpty() ? null : state.repositories.get(0).id();
    repository.save();
    return Map.of("ok", true, "stoppedProcesses", 0);
  }

  /** Disconnect only; every owned document, setting and history remains persisted. */
  public synchronized Map<String, Object> disconnect(String id) {
    Repository selected = requireRepository(id);
    Workspace state = repository.get();
    state.disconnectedRepositories.removeIf(item -> id.equals(item.id()));
    state.disconnectedRepositories.add(selected);
    state.repositories.removeIf(item -> id.equals(item.id()));
    if (id.equals(state.activeRepositoryId))
      state.activeRepositoryId =
          state.repositories.isEmpty() ? null : state.repositories.get(0).id();
    repository.save();
    return Map.of("ok", true, "repositoryId", id, "dataPreserved", true);
  }

  public synchronized boolean hasDisconnectedPath(String path) {
    Path normalized = Path.of(path).toAbsolutePath().normalize();
    return repository.get().disconnectedRepositories.stream()
        .anyMatch(item -> Path.of(item.path()).toAbsolutePath().normalize().equals(normalized));
  }

  public Repository requireRepository(String id) {
    return repository.get().repositories.stream()
        .filter(item -> item.id().equals(id))
        .findFirst()
        .orElseThrow(() -> new NotFoundException("Repository not found"));
  }

  private String productionBranch(Path root) {
    String refs =
        commands
            .run(
                "git",
                java.util.List.of(
                    "-C",
                    root.toString(),
                    "for-each-ref",
                    "--format=%(refname:short)",
                    "refs/heads",
                    "refs/remotes/origin"),
                null,
                Duration.ofSeconds(30))
            .stdout();
    java.util.List<String> branches =
        refs.lines().map(value -> value.replaceFirst("^origin/", "")).toList();
    if (branches.contains("main")) return "main";
    if (branches.contains("master")) return "master";
    return "";
  }

  private static final class ListCopy {
    static <T> java.util.List<T> of(java.util.List<T> source) {
      return java.util.List.copyOf(source);
    }

    static java.util.List<Map<String, Object>> maps(java.util.List<Map<String, Object>> source) {
      return source.stream()
          .map(LinkedHashMap::new)
          .map(item -> java.util.Collections.unmodifiableMap(item))
          .toList();
    }
  }
}
