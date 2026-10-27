package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.error.NotFoundException;
import com.argus.common.process.OwnedProcess;
import com.argus.workspace.domain.Repository;
import jakarta.annotation.PreDestroy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.springframework.stereotype.Service;

/** Owns only processes launched by Argus Services, including install-to-service transitions. */
@Service
public class ProcessManager {
  private static final int MAX_LOG_ENTRIES = 2000;
  private static final Set<String> ACTIVE =
      Set.of("installing", "starting", "running", "syncing", "testing", "stopping");
  private static final Set<String> ACTIVE_SERVICES =
      Set.of("installing", "starting", "running", "stopping");
  private static final int MAX_PARALLEL_SERVICE_STOPS = 8;

  private static final class Record {
    final Map<String, Object> data;
    final boolean service;
    OwnedProcess child;
    String gradleInitScriptText;
    Path gradleInitScript;
    final StringBuilder debugOutput = new StringBuilder();
    long logCursor;
    boolean stopRequested;
    boolean stopConfirmed;
    final CompletableFuture<Void> done = new CompletableFuture<>();

    Record(Map<String, Object> data, boolean service) {
      this.data = data;
      this.service = service;
    }
  }

  private final Map<String, Record> processes = new LinkedHashMap<>();
  private final Map<String, CompletableFuture<Void>> stopTasks = new LinkedHashMap<>();
  private final Set<String> retiredRepositories = new java.util.HashSet<>();
  private CompletableFuture<Map<String, Object>> serviceStopTask;
  private boolean closing;

  public synchronized List<Map<String, Object>> list() {
    return processes.values().stream().map(this::view).toList();
  }

  /** Status polling must not copy the retained output of every service on every read. */
  public synchronized List<Map<String, Object>> summaries() {
    return processes.values().stream().map(record -> view(record, false)).toList();
  }

  /** Read-only process identities; never infer ownership from command text or configured ports. */
  public record OwnedProcessRoot(
      String configurationId, String repositoryId, ProcessHandle handle, boolean running) {}

  public synchronized List<OwnedProcessRoot> ownedProcessRoots() {
    return processes.values().stream()
        .filter(record -> record.child != null && record.child.isAlive())
        .map(
            record ->
                new OwnedProcessRoot(
                    text(record.data, "configurationId"),
                    text(record.data, "repositoryId"),
                    record.child.process().toHandle(),
                    "running".equals(record.data.get("status"))))
        .toList();
  }

  private static List<?> list(Object value) {
    return RuntimeData.list(value);
  }

  private Map<String, Object> view(Record record) {
    return view(record, true);
  }

  private Map<String, Object> view(Record record, boolean includeLogs) {
    var result = new LinkedHashMap<String, Object>();
    record.data.forEach(
        (key, value) -> {
          if (includeLogs || !key.equals("logs")) result.put(key, copy(value));
        });
    result.put(
        "running",
        record.child != null
            && record.child.isAlive()
            && "running".equals(record.data.get("status")));
    return result;
  }

  private Record require(String id) {
    Record record = processes.get(id);
    if (record == null) throw new NotFoundException("Process not found");
    return record;
  }

  public synchronized Map<String, Object> getByConfiguration(String id) {
    return processes.values().stream()
        .filter(
            record ->
                id.equals(record.data.get("configurationId"))
                    && ACTIVE.contains(record.data.get("status")))
        .map(this::view)
        .findFirst()
        .orElse(null);
  }

  public synchronized CompletableFuture<Void> completion(String id) {
    return require(id).done;
  }

  private Record create(Map<String, Object> config, Repository repository, boolean task) {
    if (closing) throw new IllegalStateException("Argus services are shutting down");
    if (retiredRepositories.contains(repository.id()))
      throw new IllegalStateException(
          "This repository was offboarded; reconnect it before starting services");
    if (getByConfiguration(text(config, "id")) != null)
      throw new IllegalArgumentException(
          text(config, "name") + (task ? " already has work in progress" : " is already running"));
    boolean syncing = task && "sync".equals(config.get("task"));
    if (processes.values().stream()
        .anyMatch(
            record ->
                repository.id().equals(record.data.get("repositoryId"))
                    && ACTIVE.contains(record.data.get("status"))
                    && (syncing || "sync".equals(record.data.get("task")))))
      throw new IllegalArgumentException(
          "Dependency sync requires exclusive access to this repository. Stop its active work or wait for sync to finish.");
    String id = UUID.randomUUID().toString();
    Path cwd =
        inside(
            Path.of(repository.path()), text(config, "cwd").isBlank() ? "." : text(config, "cwd"));
    if (!Files.isDirectory(cwd))
      throw new IllegalArgumentException("Working directory does not exist");
    var data =
        object(
            "id",
            id,
            "configurationId",
            config.get("id"),
            "repositoryId",
            repository.id(),
            "name",
            config.get("name"),
            "command",
            String.join(" ", command(text(config, "executable"), strings(config.get("args")))),
            "runtime",
            text(config, "runtimeLabel"),
            "cwd",
            cwd.toString(),
            "status",
            task ? config.get("stage") : "starting",
            "startedAt",
            Instant.now().toString(),
            "exitedAt",
            null,
            "exitCode",
            null,
            "logs",
            new ArrayList<>());
    if (task) data.put("task", config.get("task"));
    if (!task && config.get("debug") instanceof Map<?, ?>)
      data.put("debug", copy(config.get("debug")));
    var record = new Record(data, !task);
    record.done.whenComplete(
        (ignored, error) -> {
          if (record.gradleInitScript != null) {
            try {
              Files.deleteIfExists(record.gradleInitScript);
            } catch (java.io.IOException cleanup) {
              synchronized (ProcessManager.this) {
                append(
                    record,
                    "system",
                    "Could not remove temporary Gradle configuration: " + record.gradleInitScript);
              }
            }
          }
        });
    processes.put(id, record);
    return record;
  }

  public synchronized Map<String, Object> start(
      Map<String, Object> config, Repository repository, Map<String, String> environment) {
    if (config.containsKey("debug"))
      for (String key :
          List.of("JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "NODE_OPTIONS")) {
        String value = environment.getOrDefault(key, System.getenv().getOrDefault(key, ""));
        if (value.contains("jdwp") || value.contains("--inspect"))
          throw new IllegalArgumentException(
              "Remove debugger flags from " + key + " before Debug service");
      }
    var record = create(config, repository, false);
    boolean install =
        "ui".equals(config.get("runtimeType"))
            && !text(config, "installExecutable").isBlank()
            && !text(config, "dependencyDirectory").isBlank()
            && !Files.exists(
                inside(Path.of(text(record.data, "cwd")), text(config, "dependencyDirectory")));
    if (install)
      launch(
          record,
          config,
          environment,
          text(config, "installExecutable"),
          config.containsKey("installArgs")
              ? strings(config.get("installArgs"))
              : List.of("install"),
          "installing",
          true,
          false);
    else
      launch(
          record,
          config,
          environment,
          text(config, "executable"),
          strings(config.get("args")),
          "running",
          false,
          false);
    return view(record);
  }

  public synchronized Map<String, Object> runTask(
      Map<String, Object> config, Repository repository, Map<String, String> environment) {
    return runTask(config, repository, environment, null);
  }

  /** Runs a product-owned Gradle maintenance script without modifying the user's repository. */
  public synchronized Map<String, Object> runGradleTask(
      Map<String, Object> config,
      Repository repository,
      Map<String, String> environment,
      String initScript) {
    String executable = Path.of(text(config, "executable")).getFileName().toString();
    if (!Set.of("gradle", "gradlew").contains(executable)
        || initScript == null
        || initScript.isBlank())
      throw new IllegalArgumentException("A Gradle executable and maintenance script are required");
    return runTask(config, repository, environment, initScript);
  }

  private Map<String, Object> runTask(
      Map<String, Object> config,
      Repository repository,
      Map<String, String> environment,
      String initScript) {
    var record = create(config, repository, true);
    record.gradleInitScriptText = initScript;
    launch(
        record,
        config,
        environment,
        text(config, "executable"),
        strings(config.get("args")),
        text(config, "stage"),
        false,
        true);
    return view(record);
  }

  private static List<String> command(String executable, List<String> args) {
    if (executable.isBlank()
        || executable.indexOf('\0') >= 0
        || args.stream().anyMatch(value -> value.indexOf('\0') >= 0))
      throw new IllegalArgumentException("Invalid service command");
    var command = new ArrayList<String>();
    command.add(executable);
    command.addAll(args);
    return command;
  }

  private void launch(
      Record record,
      Map<String, Object> config,
      Map<String, String> environment,
      String executable,
      List<String> args,
      String stage,
      boolean next,
      boolean task) {
    if (closing || record.stopRequested) {
      record.data.put("status", "stopped");
      record.done.complete(null);
      return;
    }
    record.data.put("status", stage);
    try {
      String initScript = record.gradleInitScriptText;
      if (!task && !next && !text(config, "gradleDebugTask").isBlank())
        initScript =
            com.argus.ide.debug.DebugLaunch.gradleScript(
                text(config, "gradleDebugTask"),
                (int) number(map(config.get("debug")).get("port")));
      if (initScript != null) {
        record.gradleInitScript = Files.createTempFile("argus-gradle-", ".gradle");
        Files.writeString(record.gradleInitScript, initScript);
        var launchedArgs = new ArrayList<>(args);
        launchedArgs.add("--no-daemon");
        launchedArgs.add("--init-script");
        launchedArgs.add(record.gradleInitScript.toString());
        args = launchedArgs;
        record.data.put("command", String.join(" ", command(executable, args)));
      }
      var builder =
          new ProcessBuilder(command(executable, args))
              .directory(Path.of(text(record.data, "cwd")).toFile());
      builder.environment().putAll(environment);
      var child = new OwnedProcess(builder, (stream, value) -> append(record, stream, value));
      record.child = child;
      child.closeInput();
      if (!text(config, "runtimeLabel").isEmpty())
        append(record, "system", "Runtime · " + text(config, "runtimeLabel"));
      append(
          record,
          "system",
          (task ? text(config, "label") : next ? "Installing dependencies" : "Started service")
              + " · PID "
              + child.pid());
      child
          .completion()
          .whenComplete(
              (code, error) -> {
                synchronized (ProcessManager.this) {
                  if (record.child != child) return;
                  if (record.stopRequested || closing) {
                    // Root exit is not proof that every retained descendant was drained.
                    record.data.put(
                        "status",
                        record.stopRequested && !record.stopConfirmed ? "stopping" : "stopped");
                    append(record, "system", "Stopped by user");
                  } else if (error == null && code == 0 && next) {
                    launch(
                        record,
                        config,
                        environment,
                        text(config, "executable"),
                        strings(config.get("args")),
                        "running",
                        false,
                        false);
                    return;
                  } else {
                    record.data.put(
                        "status",
                        error == null && code == 0 ? (task ? "completed" : "stopped") : "failed");
                    append(
                        record,
                        "system",
                        task
                            ? text(config, "label")
                                + " "
                                + record.data.get("status")
                                + (code == null ? "" : " · exit " + code)
                            : "Exited" + (code == null ? "" : " with code " + code));
                    if (error != null)
                      append(
                          record, "system", "Could not read service output: " + error.getMessage());
                  }
                  record.data.put("exitCode", code);
                  record.data.put("exitedAt", Instant.now().toString());
                  record.done.complete(null);
                }
              });
    } catch (Exception error) {
      record.data.put("status", "failed");
      record.data.put("exitedAt", Instant.now().toString());
      append(record, "system", error.getMessage());
      if (record.child == null) record.done.complete(null);
      else {
        var failedChild = record.child;
        CompletableFuture.runAsync(
                () -> failedChild.stop(Duration.ofMillis(1500), Duration.ofMillis(700)))
            .whenComplete(
                (ignored, cleanup) -> {
                  synchronized (ProcessManager.this) {
                    if (cleanup != null) {
                      append(
                          record,
                          "system",
                          "Failed service could not be drained: " + cleanup.getMessage());
                      record.done.completeExceptionally(cleanup);
                    } else record.done.complete(null);
                  }
                });
      }
    }
  }

  @SuppressWarnings("unchecked")
  private synchronized void append(Record record, String stream, String value) {
    var debug = map(record.data.get("debug"));
    if (!debug.isEmpty()) {
      record.debugOutput.append(value);
      if (record.debugOutput.length() > 8192)
        record.debugOutput.delete(0, record.debugOutput.length() - 8192);
      String output = record.debugOutput.toString();
      String port = text(debug, "port");
      if (output.contains("Listening for transport dt_socket at address: " + port)
          || output.contains("Debugger listening on ws://127.0.0.1:" + port + "/"))
        debug.put("state", "listening");
    }
    var logs = (List<Object>) record.data.get("logs");
    String timestamp = Instant.now().toString();
    for (String line : value.split("\\r?\\n"))
      if (!line.isEmpty()) {
        logs.add(object("timestamp", timestamp, "stream", stream, "line", line));
        record.logCursor++;
      }
    if (logs.size() > MAX_LOG_ENTRIES) logs.subList(0, logs.size() - MAX_LOG_ENTRIES).clear();
  }

  private record StopRequest(
      String id, Record record, CompletableFuture<Void> completion, boolean owner) {}

  /** Reserve under the manager lock so a queued installation cannot launch its service. */
  private StopRequest requestStop(String id, Record record) {
    var stopping = stopTasks.get(id);
    boolean owner = stopping == null;
    if (owner) {
      stopping = new CompletableFuture<>();
      stopTasks.put(id, stopping);
      record.stopRequested = true;
      record.stopConfirmed = false;
      if (ACTIVE.contains(record.data.get("status"))) record.data.put("status", "stopping");
    }
    return new StopRequest(id, record, stopping, owner);
  }

  public void stop(String id) {
    StopRequest request;
    synchronized (this) {
      request = requestStop(id, require(id));
    }
    stop(request);
  }

  private void stop(StopRequest request) {
    if (!request.owner()) {
      request.completion().join();
      return;
    }
    var record = request.record();
    try {
      OwnedProcess child;
      synchronized (this) {
        child = record.child;
      }
      if (child != null) stopChild(child);
      synchronized (this) {
        record.stopConfirmed = true;
        if (ACTIVE.contains(record.data.get("status"))) {
          record.data.put("status", "stopped");
          record.data.put("exitedAt", Instant.now().toString());
        }
        record.done.complete(null);
      }
      request.completion().complete(null);
    } catch (RuntimeException | Error error) {
      request.completion().completeExceptionally(error);
      throw error;
    } finally {
      synchronized (this) {
        stopTasks.remove(request.id(), request.completion());
      }
    }
  }

  void stopChild(OwnedProcess child) {
    child.stop(Duration.ofMillis(1500), Duration.ofMillis(700));
  }

  ExecutorService serviceStopExecutor(int size) {
    return Executors.newFixedThreadPool(
        Math.min(MAX_PARALLEL_SERVICE_STOPS, size),
        task -> {
          var thread = new Thread(task, "argus-stop-services");
          thread.setDaemon(true);
          return thread;
        });
  }

  private Map<String, Object> stopFailure(StopRequest request, Throwable error) {
    Throwable cause = error;
    while (cause instanceof java.util.concurrent.CompletionException && cause.getCause() != null)
      cause = cause.getCause();
    return object(
        "id", request.id(),
        "name", request.record().data.get("name"),
        "message", cause.getMessage() == null ? "Could not stop service" : cause.getMessage());
  }

  private synchronized void abandonUnscheduledStop(StopRequest request, Throwable error) {
    if (request.owner()) {
      request.completion().completeExceptionally(error);
      stopTasks.remove(request.id(), request.completion());
    }
  }

  /** Stop one snapshot of managed services, not maintenance work or later replacements. */
  public Map<String, Object> stopServices() {
    CompletableFuture<Map<String, Object>> operation;
    List<Map<String, Object>> targeted = new ArrayList<>();
    List<StopRequest> requests = new ArrayList<>();
    boolean owner;
    synchronized (this) {
      owner = serviceStopTask == null;
      if (owner) {
        serviceStopTask = new CompletableFuture<>();
        for (var entry : processes.entrySet()) {
          var record = entry.getValue();
          if (!record.service || !ACTIVE_SERVICES.contains(record.data.get("status"))) continue;
          targeted.add(
              object(
                  "id", entry.getKey(),
                  "configurationId", record.data.get("configurationId"),
                  "name", record.data.get("name")));
          requests.add(requestStop(entry.getKey(), record));
        }
      }
      operation = serviceStopTask;
    }
    if (!owner) return operation.join();
    try {
      var stopped = new ArrayList<String>();
      var failures = new ArrayList<Map<String, Object>>();
      if (!requests.isEmpty()) {
        ExecutorService workers = null;
        var results = new ArrayList<CompletableFuture<Map<String, Object>>>();
        try {
          workers = serviceStopExecutor(requests.size());
          for (var request : requests)
            results.add(
                CompletableFuture.supplyAsync(
                    () -> {
                      try {
                        stop(request);
                        return null;
                      } catch (RuntimeException error) {
                        return stopFailure(request, error);
                      }
                    },
                    workers));
        } catch (RuntimeException | Error error) {
          // A pool/submit failure must not leave an owner reservation with no worker:
          // individual stops and subsequent bulk retries would otherwise wait forever.
          for (int index = results.size(); index < requests.size(); index++) {
            var request = requests.get(index);
            abandonUnscheduledStop(request, error);
            results.add(CompletableFuture.completedFuture(stopFailure(request, error)));
          }
          if (error instanceof Error fatal) throw fatal;
        } finally {
          if (workers != null) workers.shutdown();
        }
        for (int index = 0; index < results.size(); index++) {
          var failure = results.get(index).join();
          if (failure == null) stopped.add(requests.get(index).id());
          else failures.add(failure);
        }
      }
      var result =
          object(
              "targeted", targeted,
              "stopped", stopped,
              "failures", failures,
              "processes", summaries());
      operation.complete(result);
      return result;
    } catch (RuntimeException | Error error) {
      operation.completeExceptionally(error);
      throw error;
    } finally {
      synchronized (this) {
        if (serviceStopTask == operation) serviceStopTask = null;
      }
    }
  }

  public synchronized Map<String, Object> logs(String id, long after) {
    var record = require(id);
    var logs = list(record.data.get("logs"));
    // Cursors count emitted entries, including entries evicted from the bounded buffer.
    long oldestCursor = record.logCursor - logs.size();
    int start =
        after < 0
            ? (int) Math.max(0, logs.size() + after)
            : (int) Math.min(logs.size(), Math.max(0, after - oldestCursor));
    return object(
        "cursor",
        record.logCursor,
        "oldestCursor",
        oldestCursor,
        "dropped",
        after < 0 ? 0L : Math.max(0, oldestCursor - after),
        "logs",
        copy(logs.subList(start, logs.size())),
        "status",
        record.data.get("status"));
  }

  @PreDestroy
  public void stopAll() {
    List<String> ids;
    synchronized (this) {
      closing = true;
      ids = List.copyOf(processes.keySet());
    }
    RuntimeException first = null;
    for (String id : ids)
      try {
        stop(id);
      } catch (RuntimeException error) {
        if (first == null) first = error;
        else first.addSuppressed(error);
      }
    if (first != null) throw first;
  }

  public Map<String, Object> purgeRepositories(List<String> ids) {
    return stopRepositories(ids, true);
  }

  /** Stop processes without discarding their retained output. */
  public Map<String, Object> disconnectRepositories(List<String> ids) {
    return stopRepositories(ids, false);
  }

  public synchronized void releaseRetiredRepositories(List<String> ids) {
    retiredRepositories.removeAll(ids);
  }

  private Map<String, Object> stopRepositories(List<String> ids, boolean purge) {
    List<String> selected;
    synchronized (this) {
      // Retire before taking the drain snapshot. A request still resolving a runtime
      // must not start after offboarding has drained the earlier process records.
      retiredRepositories.addAll(ids);
      selected =
          processes.entrySet().stream()
              .filter(entry -> ids.contains(text(entry.getValue().data, "repositoryId")))
              .map(Map.Entry::getKey)
              .toList();
    }
    for (String id : selected) stop(id);
    synchronized (this) {
      if (purge) selected.forEach(processes::remove);
    }
    return object(purge ? "processesDeleted" : "processesRetained", selected.size());
  }
}
