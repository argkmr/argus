package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.apiclient.service.EnvironmentFormat;
import com.argus.common.security.KeychainSecretStore;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import jakarta.annotation.PreDestroy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

@Service
public class RuntimeConfigurationService {
  private final WorkspaceService workspace;
  private final RuntimeDetector detector;
  private final JavaProjectService javaProjects;
  private final LocalEnvironmentService local;
  private final ApplicationConfigService application;
  private final KeychainSecretStore secrets;
  private final ProcessManager processes;
  private final ObjectMapper json;
  private static final int DISCOVERY_PARALLELISM = 4;
  private final AtomicInteger discoveryThreadIds = new AtomicInteger();
  private final ThreadPoolExecutor discoveryWorkers =
      new ThreadPoolExecutor(
          DISCOVERY_PARALLELISM,
          DISCOVERY_PARALLELISM,
          0,
          TimeUnit.MILLISECONDS,
          new ArrayBlockingQueue<>(16),
          task -> {
            var thread =
                new Thread(task, "argus-runtime-discovery-" + discoveryThreadIds.incrementAndGet());
            thread.setDaemon(true);
            return thread;
          });

  public RuntimeConfigurationService(
      WorkspaceService workspace,
      RuntimeDetector detector,
      JavaProjectService javaProjects,
      LocalEnvironmentService local,
      ApplicationConfigService application,
      KeychainSecretStore secrets,
      ProcessManager processes,
      ObjectMapper json) {
    this.workspace = workspace;
    this.detector = detector;
    this.javaProjects = javaProjects;
    this.local = local;
    this.application = application;
    this.secrets = secrets;
    this.processes = processes;
    this.json = json;
  }

  public static boolean conventional(Map<String, Object> config) {
    String executable = text(config, "executable");
    var args = strings(config.get("args"));
    return executable.matches("(?:\\./)?gradlew")
            && args.size() == 1
            && args.get(0).matches("(?::[\\w-]+)*:?bootRun")
        || executable.matches("(?:\\./)?mvnw|mvn") && args.equals(List.of("spring-boot:run"));
  }

  private boolean managedCommand(Repository repository, Map<String, Object> config) {
    if ("detected".equals(config.get("launchSource"))
        && (text(config, "cwd").isBlank() || List.of(".", "./").contains(text(config, "cwd")))
        && Path.of(text(config, "executable"))
            .getFileName()
            .toString()
            .matches("python3?|uv|poetry|pipenv")
        && !PythonProjectRuntime.entry(Path.of(repository.path())).isBlank()) return true;
    if (!conventional(config)
        || !(text(config, "cwd").isBlank() || List.of(".", "./").contains(text(config, "cwd"))))
      return false;
    if ("custom".equals(config.get("launchSource"))) return false;
    if ("detected".equals(config.get("launchSource"))) return true;
    // Before provenance was persisted, simple setup stored this exact local-environment
    // path and selected bootRun solely from application YAML. Do not reinterpret arbitrary
    // saved commands, project directories, aliases, or inline/secret command configurations.
    if (!text(config, "launchSource").isBlank()
        || !text(config, "environmentFile")
            .equals(".argus-data/environments/" + text(config, "id") + ".env")
        || !map(config.get("env")).isEmpty()
        || !strings(config.get("secretKeys")).isEmpty()
        || JvmEntryPoints.customGradleLayout(Path.of(repository.path()))) return false;
    var yaml =
        java.util.regex.Pattern.compile(
                "^(?:(.*)/)?src/main/resources/(?:.*/)?application(?:-[^.]+)?\\.ya?ml$")
            .matcher(text(config, "configFile"));
    if (!yaml.matches() || !text(config, "executable").matches("(?:\\./)?gradlew")) return false;
    String module = yaml.group(1) == null ? "" : yaml.group(1).replace('/', ':');
    String expected = module.isEmpty() ? ":bootRun" : ":" + module + ":bootRun";
    String task = strings(config.get("args")).get(0);
    return expected.equals(task.startsWith(":") ? task : ":" + task);
  }

  public Map<String, Object> resolve(Repository repository, Map<String, Object> existing) {
    if (existing != null && !repository.id().equals(existing.get("repositoryId")))
      throw new IllegalArgumentException("Run configuration does not belong to this repository");
    Map<String, Object> detected;
    try {
      detected = detector.detect(Path.of(repository.path()), repository.name());
    } catch (IllegalArgumentException error) {
      // An explicit Services command is authoritative for projects with multiple applications
      // or custom builds. Discovery failures must not replace it with a guessed entry point.
      if (existing == null || text(existing, "executable").isBlank()) throw error;
      var configured = copyMap(existing);
      configured.put("detectionWarning", error.getMessage());
      return configured;
    }
    if (existing == null) return detected;
    var merged = copyMap(detected);
    merged.putAll(copyMap(existing));
    boolean managed = managedCommand(repository, existing);
    if (managed && !text(detected, "entryPointFile").isBlank())
      for (String field : List.of("executable", "args", "cwd"))
        merged.put(field, detected.get(field));
    if (managed) merged.put("launchSource", "detected");
    else if (List.of("executable", "args", "cwd").stream()
        .anyMatch(field -> !java.util.Objects.equals(existing.get(field), detected.get(field)))) {
      merged.put(
          "detectionWarning",
          "The detected entry point differs from this saved command. The saved command and working directory were preserved.");
      if (detected.containsKey("entryPointFile"))
        merged.put(
            "detectedEntryPoint",
            object(
                "mainClass",
                detected.get("mainClass"),
                "modulePath",
                detected.get("modulePath"),
                "file",
                detected.get("entryPointFile")));
      for (String field : List.of("mainClass", "modulePath", "entryPointFile", "entryPoints"))
        merged.remove(field);
    }
    if (number(existing.get("port")) == 0) merged.put("port", detected.get("port"));
    if (number(existing.get("managementPort")) == 0)
      merged.put("managementPort", detected.get("managementPort"));
    merged.put(
        "portSource",
        number(existing.get("port")) > 0 ? "Argus configuration" : detected.get("portSource"));
    merged = RuntimeDetector.applyEnvironmentPorts(merged, local.resolve(text(existing, "id")));
    if (managed && "python".equals(detected.get("projectType"))) {
      Integer port = RuntimeDetector.validPort(merged.get("port"));
      merged.putAll(
          PythonProjectRuntime.run(Path.of(repository.path()), port == null ? 8000 : port));
    }
    if ("ui".equals(detected.get("runtimeType")) || text(detected, "configFile").isEmpty())
      return merged;
    var oldYaml = application.read(Path.of(repository.path()), text(existing, "configFile"));
    var detectedYaml = application.read(Path.of(repository.path()), text(detected, "configFile"));
    boolean replace =
        text(existing, "configFile").isEmpty()
            || !Boolean.TRUE.equals(oldYaml.get("exists"))
            || text(oldYaml, "content").isBlank() && !text(detectedYaml, "content").isBlank()
            || managed
                && !text(existing, "configFile").equals(text(detected, "configFile"))
                && !text(detectedYaml, "content").isBlank();
    if (replace) {
      merged.put("configFile", detected.get("configFile"));
      if (managed)
        for (String field : List.of("executable", "args", "cwd"))
          merged.put(field, detected.get(field));
    }
    return merged;
  }

  public Map<String, Object> projectRuntime(Repository repository, Map<String, Object> config) {
    Path root = Path.of(repository.path());
    String command = text(config, "executable");
    if (!command.isBlank() && Path.of(command).getFileName().toString().matches("python3?")) {
      String virtual = PythonProjectRuntime.virtualEnvironment(root);
      if (!virtual.isBlank()) {
        Path bin = root.toAbsolutePath().resolve(virtual).resolve("bin");
        if (command.matches("python3?")
            || Path.of(command).isAbsolute()
                && bin.normalize().equals(Path.of(command).normalize().getParent())) {
          var modified = copyMap(config);
          if (!Path.of(command).isAbsolute()) {
            modified.put("executable", PythonProjectRuntime.interpreter(root));
          }
          return object(
              "configuration",
              modified,
              "environment",
              Map.of(
                  "VIRTUAL_ENV",
                  bin.getParent().toString(),
                  "PATH",
                  bin + java.io.File.pathSeparator + System.getenv().getOrDefault("PATH", "")));
        }
      }
    }
    if (text(config, "executable").matches("(?:\\./)?(?:gradlew|mvnw)|gradle|mvn")) {
      var runtime =
          javaProjects.resolveRuntimeEnvironment(
              repository, workspace.javaSettings(repository.id()));
      var modified = copyMap(config);
      modified.put("runtimeLabel", runtime.get("label"));
      return object("configuration", modified, "environment", runtime.get("environment"));
    }
    if (text(config, "executable").matches("node|npm|npx|pnpm|yarn|bun")
        && Files.exists(Path.of(repository.path(), "package.json"))) {
      // runtimeBin is cached detection metadata, not an override of today's repository
      // declaration. Re-resolve before every start, restart and dependency operation.
      var runtime = detector.nodeRuntime(Path.of(repository.path()));
      var modified = copyMap(config);
      modified.put("runtimeLabel", "Node " + text(runtime, "version"));
      modified.put(
          "runtimeBin",
          Path.of(text(runtime, "executable")).getParent() == null
              ? ""
              : Path.of(text(runtime, "executable")).getParent().toString());
      modified.put("nodeVersion", runtime.get("version"));
      modified.put("requiredNode", runtime.get("requirement"));
      return object("configuration", modified, "environment", runtime.get("environment"));
    }
    if (!text(config, "runtimeBin").isEmpty())
      return object(
          "configuration",
          config,
          "environment",
          Map.of(
              "PATH",
              text(config, "runtimeBin")
                  + java.io.File.pathSeparator
                  + System.getenv().getOrDefault("PATH", "")));
    return object("configuration", config, "environment", Map.of());
  }

  /** Saved local values used by the same configuration's explicit sync/test actions. */
  public Map<String, String> maintenanceEnvironment(String configurationId) {
    var environment = secretEnvironment(workspace.runConfiguration(configurationId));
    environment.putAll(local.resolve(configurationId));
    return environment;
  }

  public List<Map<String, Object>> detections() {
    var snapshot = workspace.snapshot();
    int count = snapshot.repositories().size();
    var result = new ArrayList<Map<String, Object>>(java.util.Collections.nCopies(count, null));
    var next = new AtomicInteger();
    var tasks = new ArrayList<Future<Void>>();
    boolean completed = false;
    try {
      // Submit at most four partition workers per request, not one future per repository. The
      // shared pool and queue cap concurrent scans even when multiple clients refresh together.
      for (int worker = 0; worker < Math.min(count, DISCOVERY_PARALLELISM); worker++)
        tasks.add(
            submitDiscovery(
                () -> {
                  while (true) {
                    if (Thread.currentThread().isInterrupted())
                      throw new CancellationException("Runtime discovery was cancelled");
                    int index = next.getAndIncrement();
                    if (index >= count) return;
                    var repository = snapshot.repositories().get(index);
                    var entry =
                        object(
                            "repositoryId", repository.id(), "repositoryName", repository.name());
                    try {
                      entry.put("detected", true);
                      entry.putAll(
                          resolve(
                              repository,
                              snapshot.runConfigurations().stream()
                                  .filter(
                                      config -> repository.id().equals(config.get("repositoryId")))
                                  .findFirst()
                                  .orElse(null)));
                    } catch (CancellationException cancelled) {
                      throw cancelled;
                    } catch (RuntimeException error) {
                      entry.put("detected", false);
                      entry.put("error", error.getMessage());
                    }
                    result.set(index, entry);
                  }
                }));
      for (var task : tasks) task.get();
      completed = true;
      return result;
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw new CancellationException("Runtime discovery was cancelled");
    } catch (ExecutionException error) {
      if (error.getCause() instanceof RuntimeException failure) throw failure;
      throw new IllegalStateException("Runtime discovery could not complete", error.getCause());
    } finally {
      if (!completed) for (var task : tasks) task.cancel(true);
    }
  }

  private Future<Void> submitDiscovery(Runnable action) {
    var task = new FutureTask<Void>(action, null);
    try {
      discoveryWorkers.execute(task);
    } catch (RejectedExecutionException busy) {
      // Apply backpressure without growing the queue or running scans on request threads.
      // Timed offers let shutdown and request interruption release waiting callers promptly.
      while (true) {
        if (discoveryWorkers.isShutdown())
          throw new CancellationException("Runtime discovery is shutting down");
        try {
          if (discoveryWorkers.getQueue().offer(task, 100, TimeUnit.MILLISECONDS)) {
            if (discoveryWorkers.isShutdown()) {
              discoveryWorkers.remove(task);
              task.cancel(true);
            }
            break;
          }
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw new CancellationException("Runtime discovery was cancelled");
        }
      }
    }
    return task;
  }

  @PreDestroy
  public void close() {
    for (var pending : discoveryWorkers.shutdownNow())
      if (pending instanceof Future<?> future) future.cancel(true);
  }

  public Map<String, Object> template(String repositoryId, String configurationId) {
    var repository = workspace.requireRepository(repositoryId);
    var existing =
        configurationId == null || configurationId.isBlank()
            ? null
            : workspace.runConfiguration(configurationId);
    if (existing != null && !repository.id().equals(existing.get("repositoryId")))
      throw new IllegalArgumentException("Run configuration does not belong to this repository");
    Map<String, Object> result;
    try {
      result = resolve(repository, existing);
      result.put("detected", !result.containsKey("detectionWarning"));
    } catch (IllegalArgumentException error) {
      result =
          existing == null
              ? object(
                  "name",
                  repository.name(),
                  "executable",
                  "",
                  "args",
                  List.of(),
                  "cwd",
                  ".",
                  "runtimeType",
                  "service")
              : copyMap(existing);
      result.put("detected", false);
      result.put("detectionWarning", error.getMessage());
    }
    String configFile = "ui".equals(result.get("runtimeType")) ? "" : text(result, "configFile");
    var yaml = application.read(Path.of(repository.path()), configFile);
    result.putAll(
        object(
            "configFile",
            configFile,
            "repositoryId",
            repository.id(),
            "applicationYaml",
            yaml.get("content"),
            "applicationYamlExists",
            yaml.get("exists"),
            "environment",
            existing == null
                ? object("count", 0, "format", "dotenv", "updatedAt", null, "content", "")
                : object(
                    "count",
                    list(existing.get("environmentKeys")).size(),
                    "format",
                    existing.getOrDefault("environmentFormat", "dotenv"),
                    "updatedAt",
                    existing.get("environmentUpdatedAt"),
                    "content",
                    local.editable(configurationId, text(existing, "environmentFormat")))));
    return result;
  }

  private void sameRepository(String id, String repositoryId) {
    try {
      var existing = workspace.runConfiguration(id);
      if (!repositoryId.equals(existing.get("repositoryId")))
        throw new IllegalArgumentException("Run configuration does not belong to this repository");
    } catch (com.argus.common.error.NotFoundException ignored) {
    }
  }

  public synchronized Map<String, Object> save(Map<String, Object> input) {
    String id = text(input, "id");
    if (id.isEmpty()) id = UUID.randomUUID().toString();
    String repositoryId = text(input, "repositoryId");
    var repository = workspace.requireRepository(repositoryId);
    sameRepository(id, repositoryId);
    if (Boolean.TRUE.equals(input.get("simpleSetup"))) {
      var existing = text(input, "id").isEmpty() ? null : workspace.runConfiguration(id);
      boolean redetect = "detected".equals(input.get("launchSource"));
      var detected = resolve(repository, redetect ? null : existing);
      if (redetect && existing != null)
        for (String field :
            List.of(
                "name",
                "port",
                "managementPort",
                "env",
                "secretKeys",
                "environmentKeys",
                "environmentFormat",
                "environmentUpdatedAt",
                "environmentFile",
                "healthUrl"))
          if (existing.containsKey(field)) detected.put(field, copy(existing.get(field)));
      detected.put(
          "launchSource",
          redetect || existing == null || managedCommand(repository, existing)
              ? "detected"
              : "custom");
      for (String field : List.of("port", "managementPort", "applicationPort"))
        if (input.containsKey(field)) detected.put(field, input.get(field));
      validateConfiguration(repository, detected);
      if (input.containsKey("environmentInput")) {
        String format = "vault".equals(input.get("environmentFormat")) ? "vault" : "dotenv";
        var saved = local.write(id, text(input, "environmentInput"), format);
        detected.putAll(
            object(
                "environmentKeys",
                saved.get("keys"),
                "environmentFormat",
                saved.get("format"),
                "environmentUpdatedAt",
                saved.get("updatedAt"),
                "environmentFile",
                ".argus-data/environments/" + id + ".env"));
      }
      if (!text(input, "configFile").isEmpty()
          && input.get("applicationYaml") instanceof String content)
        application.saveContents(Path.of(repository.path()), text(input, "configFile"), content);
      detected.putAll(
          object(
              "id",
              id,
              "repositoryId",
              repositoryId,
              "configFile",
              "ui".equals(detected.get("runtimeType"))
                  ? ""
                  : text(input, "configFile").isEmpty()
                      ? text(detected, "configFile")
                      : text(input, "configFile")));
      return workspace.saveRunConfiguration(detected);
    }
    Map<String, Object> previous = Map.of();
    if (!text(input, "id").isEmpty()) previous = workspace.runConfiguration(id);
    var saved = copyMap(previous);
    saved.putAll(copyMap(input));
    saved.putIfAbsent("name", repository.name());
    saved.putIfAbsent("cwd", ".");
    saved.putIfAbsent("args", List.of());
    validateConfiguration(repository, saved);
    var env = new LinkedHashMap<String, String>();
    if (!input.containsKey("variables"))
      map(previous.get("env")).forEach((key, value) -> env.put(key, text(value)));
    var secretKeys =
        new ArrayList<String>(
            input.containsKey("variables") ? List.of() : strings(previous.get("secretKeys")));
    for (Object item : list(input.get("variables"))) {
      var variable = map(item);
      String key = text(variable, "key").trim();
      if (key.isEmpty()) continue;
      if (!key.matches("[A-Za-z_][A-Za-z0-9_]*"))
        throw new IllegalArgumentException("Invalid environment variable: " + key);
      if (Boolean.TRUE.equals(variable.get("secret"))) {
        secretKeys.add(key);
        if (!text(variable, "value").isEmpty()) secrets.setLocal(id, key, text(variable, "value"));
      } else env.put(key, text(variable, "value"));
    }
    var environmentKeys = new ArrayList<String>(strings(previous.get("environmentKeys")));
    if (!text(input, "environmentText").isBlank()) {
      var environment = EnvironmentFormat.parse(text(input, "environmentText"));
      secrets.setLocal(id, "__environment_bundle__", json.writeValueAsString(environment));
      environmentKeys.addAll(environment.keySet());
    }
    if (Boolean.TRUE.equals(input.get("syncApplicationYaml"))
        && number(input.get("applicationPort")) > 0
        && number(input.get("managementPort")) > 0) {
      ensurePorts(input, id);
      application.configure(Path.of(repository.path()), input);
    }
    if (input.containsKey("environmentInput")) {
      String format = "vault".equals(input.get("environmentFormat")) ? "vault" : "dotenv";
      var environment = local.write(id, text(input, "environmentInput"), format);
      environmentKeys = new ArrayList<>(strings(environment.get("keys")));
      saved.putAll(
          object(
              "environmentFormat",
              environment.get("format"),
              "environmentUpdatedAt",
              environment.get("updatedAt"),
              "environmentFile",
              ".argus-data/environments/" + id + ".env"));
    }
    if (!text(input, "configFile").isEmpty()
        && input.get("applicationYaml") instanceof String content)
      application.saveContents(Path.of(repository.path()), text(input, "configFile"), content);
    saved.put("launchSource", "custom");
    saved.putAll(
        object("id", id, "env", env, "secretKeys", secretKeys, "environmentKeys", environmentKeys));
    return workspace.saveRunConfiguration(saved);
  }

  private void validateConfiguration(Repository repository, Map<String, Object> configuration) {
    Object executable = configuration.get("executable");
    if (!(executable instanceof String command)
        || command.isBlank()
        || command.length() > 4096
        || command.indexOf('\0') >= 0)
      throw new IllegalArgumentException("A valid executable is required");
    Object arguments = configuration.getOrDefault("args", List.of());
    if (!(arguments instanceof List<?> values)
        || values.size() > 256
        || values.stream()
            .anyMatch(
                value ->
                    !(value instanceof String text)
                        || text.length() > 65536
                        || text.indexOf('\0') >= 0))
      throw new IllegalArgumentException("Arguments must be an array of strings");
    String cwd = text(configuration, "cwd");
    if (!Files.isDirectory(inside(Path.of(repository.path()), cwd.isBlank() ? "." : cwd)))
      throw new IllegalArgumentException("Working directory does not exist inside the repository");
    for (String field : List.of("port", "managementPort", "applicationPort")) {
      Object value = configuration.get(field);
      if (value != null
          && !text(value).isBlank()
          && (!text(value).matches("[0-9]{1,5}") || RuntimeDetector.validPort(value) == null))
        throw new IllegalArgumentException("Ports must be whole numbers between 1 and 65535");
    }
  }

  public synchronized void remove(String id) {
    workspace.runConfiguration(id);
    local.remove(id);
    workspace.removeRunConfiguration(id);
  }

  private void ensurePorts(Map<String, Object> input, String except) {
    for (var configuration : workspace.snapshot().runConfigurations()) {
      if (except.equals(configuration.get("id"))) continue;
      for (String field : List.of("port", "managementPort")) {
        long occupied = number(configuration.get(field));
        if (occupied > 0
            && (occupied == number(input.get("applicationPort"))
                || occupied == number(input.get("managementPort"))))
          throw new IllegalArgumentException(
              "Port " + occupied + " is already assigned to " + text(configuration, "name"));
      }
    }
  }

  public synchronized Map<String, Object> ports(String id, Map<String, Object> input) {
    var config = workspace.runConfiguration(id);
    var repository = workspace.requireRepository(text(config, "repositoryId"));
    ensurePorts(input, id);
    var result = application.configure(Path.of(repository.path()), input);
    workspace.updateRunConfiguration(
        id,
        object(
            "port",
            result.get("applicationPort"),
            "managementPort",
            result.get("managementPort"),
            "configFile",
            text(input, "configFile").isEmpty()
                ? config.getOrDefault("configFile", "")
                : input.get("configFile")));
    return result;
  }

  public Map<String, String> secretEnvironment(Map<String, Object> config) {
    var environment = new LinkedHashMap<String, String>();
    map(config.get("env")).forEach((key, value) -> environment.put(key, text(value)));
    String bundle = secrets.getLocal(text(config, "id"), "__environment_bundle__");
    if (!bundle.isBlank())
      try {
        map(json.readValue(bundle, LinkedHashMap.class))
            .forEach((key, value) -> environment.put(key, text(value)));
      } catch (RuntimeException ignored) {
      }
    for (String key : strings(config.get("secretKeys")))
      environment.put(key, secrets.getLocal(text(config, "id"), key));
    return environment;
  }

  /** Key names only, for refusing edits that would be shadowed by protected values. */
  java.util.Set<String> protectedEnvironmentKeys(Map<String, Object> config) {
    var keys = new java.util.LinkedHashSet<>(strings(config.get("secretKeys")));
    String bundle = secrets.getLocal(text(config, "id"), "__environment_bundle__");
    if (bundle != null && !bundle.isBlank())
      keys.addAll(map(json.readValue(bundle, LinkedHashMap.class)).keySet());
    return keys;
  }

  public Map<String, Object> action(String id, String action, Map<String, Object> input) {
    var config = workspace.runConfiguration(id);
    var repository = workspace.requireRepository(text(config, "repositoryId"));
    var running = processes.getByConfiguration(id);
    if ((action.equals("stop") || action.equals("restart")) && running != null)
      processes.stop(text(running, "id"));
    if (action.equals("stop")) return object("ok", true);
    if (!text(input, "environmentText").isBlank()) {
      var env = EnvironmentFormat.parse(text(input, "environmentText"));
      secrets.setLocal(id, "__environment_bundle__", json.writeValueAsString(env));
      workspace.updateRunConfiguration(
          id, object("environmentKeys", env.keySet().stream().sorted().toList()));
    }
    if (number(input.get("applicationPort")) > 0 && number(input.get("managementPort")) > 0)
      ports(id, input);
    Map<String, Object> runnable;
    try {
      runnable = resolve(repository, config);
    } catch (RuntimeException error) {
      if (error instanceof RuntimeCompatibilityException) throw error;
      runnable = config;
    }
    var runtime = projectRuntime(repository, runnable);
    var environment = secretEnvironment(config);
    environment.putAll(local.resolve(id));
    map(runtime.get("environment")).forEach((key, value) -> environment.put(key, text(value)));
    var configuration = copyMap(map(runtime.get("configuration")));
    // Debug endpoints describe only this launch; persisted configuration metadata is not authority.
    configuration.remove("debug");
    configuration.remove("gradleDebugTask");
    if (Boolean.TRUE.equals(input.get("debug")))
      configuration =
          com.argus.ide.debug.DebugLaunch.prepare(configuration, input.get("debugPort"));
    return processes.start(configuration, repository, environment);
  }

  public Map<String, Object> purgeRepositories(List<String> ids) {
    var selected =
        workspace.snapshot().runConfigurations().stream()
            .filter(config -> ids.contains(text(config, "repositoryId")))
            .toList();
    for (var config : selected) {
      String id = text(config, "id");
      local.remove(id);
      secrets.deleteLocalNamespace(id);
    }
    return object("runEnvironmentsDeleted", selected.size());
  }
}
