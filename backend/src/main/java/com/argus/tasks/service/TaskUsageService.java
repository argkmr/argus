package com.argus.tasks.service;

import static com.argus.agents.domain.AgentValues.*;

import com.argus.agents.service.CodexRolloutUsage;
import com.argus.agents.service.ProviderCostEstimate;
import com.argus.agents.service.ProviderTokenUsage;
import com.argus.common.error.NotFoundException;
import com.argus.platform.NativeBackgroundOwner;
import com.argus.platform.RestoreMaintenanceGate;
import com.argus.tasks.repository.TaskRepository;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/** On-demand, read-only historical accounting repair. No model request or transcript rewrite. */
@Service
public final class TaskUsageService implements AutoCloseable, NativeBackgroundOwner {
  private final TaskRepository tasks;
  private final ObjectMapper mapper;
  private final Path codexHome;
  private final RestoreMaintenanceGate maintenance;
  private final Set<CompletableFuture<Map<String, Object>>> pending = ConcurrentHashMap.newKeySet();
  private final Set<Thread> running = ConcurrentHashMap.newKeySet();
  private volatile boolean closed;
  private final ExecutorService reads =
      new ThreadPoolExecutor(
          1,
          2,
          30,
          TimeUnit.SECONDS,
          new ArrayBlockingQueue<>(16),
          runnable -> {
            var thread = new Thread(runnable, "argus-usage-recovery");
            thread.setDaemon(true);
            return thread;
          },
          new ThreadPoolExecutor.AbortPolicy());
  private final Map<String, Cached> cache = new LinkedHashMap<>(64, .75f, true);

  private record Cached(Instant expires, Map<String, Object> value) {}

  @Autowired
  public TaskUsageService(
      TaskRepository tasks, ObjectMapper mapper, RestoreMaintenanceGate maintenance) {
    this(tasks, mapper, CodexRolloutUsage.defaultHome(), maintenance);
  }

  TaskUsageService(TaskRepository tasks, ObjectMapper mapper, Path codexHome) {
    this(tasks, mapper, codexHome, new RestoreMaintenanceGate());
  }

  TaskUsageService(
      TaskRepository tasks,
      ObjectMapper mapper,
      Path codexHome,
      RestoreMaintenanceGate maintenance) {
    this.tasks = tasks;
    this.mapper = mapper;
    this.codexHome = codexHome;
    this.maintenance = maintenance;
  }

  public CompletableFuture<Map<String, Object>> usage(String taskId, String messageId) {
    // A servlet's initial dispatch ends before this asynchronous read. Hold a separate read lease
    // until the worker exits so a restore cannot replace task metadata underneath its snapshot.
    var admission = maintenance.beginRequest("GET", "/api/ai-tasks/usage-recovery");
    if (closed || admission == RestoreMaintenanceGate.Admission.MAINTENANCE) {
      maintenance.endRequest(admission);
      throw new ResponseStatusException(
          HttpStatus.SERVICE_UNAVAILABLE,
          "Usage recovery is unavailable during shutdown or restore");
    }
    var result = new CompletableFuture<Map<String, Object>>();
    pending.add(result);
    try {
      reads.execute(
          () -> {
            Thread worker = Thread.currentThread();
            running.add(worker);
            Map<String, Object> value = null;
            Throwable failure = null;
            try {
              if (closed) throw new CancellationException("Usage recovery stopped");
              if (!result.isDone()) value = recover(taskId, messageId);
            } catch (Throwable error) {
              failure = error;
            } finally {
              running.remove(worker);
              pending.remove(result);
              maintenance.endRequest(admission);
            }
            if (failure != null) result.completeExceptionally(failure);
            else if (value != null) result.complete(value);
          });
      return result;
    } catch (RejectedExecutionException error) {
      pending.remove(result);
      maintenance.endRequest(admission);
      throw new ResponseStatusException(
          HttpStatus.SERVICE_UNAVAILABLE, "Usage recovery is busy; try again shortly");
    }
  }

  private Map<String, Object> recover(String taskId, String messageId) {
    var task = tasks.get(taskId);
    var message =
        task.messages.stream()
            .filter(item -> messageId.equals(item.id))
            .findFirst()
            .orElseThrow(() -> new NotFoundException("Task message not found"));
    var execution = obj(message.execution);
    var saved = obj(execution.get("tokenUsage"));
    String provider = text(execution.getOrDefault("provider", message.provider));
    if (truth(saved.get("reported"))
        && "codex".equals(provider)
        && "assistant".equals(message.role)
        && "completed".equals(message.status)) {
      // Prices are a view over recorded usage, not immutable evidence of a charge. Reprice
      // historical telemetry without changing its counters, scope, transcript or saved audit.
      // Never use the task's current model/speed for an older execution.
      var previousCost = obj(saved.get("costEstimate"));
      var refreshed = new LinkedHashMap<String, Object>(saved);
      var estimate =
          ProviderCostEstimate.calculate(
              provider,
              recordedSetting(execution, previousCost, "model"),
              recordedSetting(execution, previousCost, "speed"),
              recordedSetting(execution, previousCost, "effort"),
              saved,
              Map.of());
      estimate.put("valuation", "current-rate-equivalent");
      refreshed.put("costEstimate", estimate);
      return fields("tokenUsage", refreshed, "recovered", false, "recalculated", true);
    }
    if (truth(saved.get("reported"))
        || !"codex".equals(provider)
        || !"assistant".equals(message.role)
        || !"completed".equals(message.status))
      return fields(
          "tokenUsage",
          saved.isEmpty() ? ProviderTokenUsage.unavailable(provider) : saved,
          "recovered",
          false);

    String thread = text(execution.get("cliSessionId"));
    if (thread.isBlank())
      thread =
          text(obj(obj(task.additionalProperties().get("cliSessions")).get("codex")).get("id"));
    String start = text(execution.get("startedAt")), end = text(execution.get("completedAt"));
    String key = taskId + "/" + messageId + "/" + thread + "/" + start + "/" + end;
    synchronized (cache) {
      Cached prior = cache.get(key);
      if (prior != null && prior.expires.isAfter(Instant.now())) return prior.value;
    }
    var tracker =
        new ProviderTokenUsage(
            provider,
            text(execution.get("model")),
            text(execution.get("speed")),
            text(execution.get("effort")));
    tracker.beginAttempt();
    if (truth(execution.get("cliSessionFallback")) || number(saved.get("attemptCount")) > 1)
      tracker.recordCodexRollout(
          fields(
              "reported",
              false,
              "detail",
              "This request retried across CLI attempts; historical usage cannot be safely attributed to one turn."));
    else
      tracker.recordCodexRollout(CodexRolloutUsage.recover(codexHome, thread, start, end, mapper));
    tracker.finish(false);
    var recovered = tracker.snapshot();
    boolean reported = truth(recovered.get("reported"));
    recovered.put("recoveredFromLocalRollout", reported);
    var result = fields("tokenUsage", recovered, "recovered", reported);
    synchronized (cache) {
      cache.put(key, new Cached(Instant.now().plusSeconds(reported ? 3600 : 15), result));
      while (cache.size() > 64) cache.remove(cache.keySet().iterator().next());
    }
    return result;
  }

  private static String recordedSetting(
      Map<String, Object> execution, Map<String, Object> previousCost, String key) {
    String value = text(execution.get(key));
    return value.isBlank() ? text(previousCost.get(key)) : value;
  }

  @Override
  public String ownerName() {
    return "prompt usage recovery";
  }

  @Override
  public int shutdownOrder() {
    return 95;
  }

  @Override
  public void quiesce() {
    close();
  }

  @Override
  public void close() {
    closed = true;
    // Drain queued reads (they become no-ops) so every maintenance lease is released in finally.
    pending.forEach(
        future ->
            future.completeExceptionally(new CancellationException("Usage recovery stopped")));
    // Keep queued no-ops so their leases are released; interrupt only active readers, whose
    // bounded filesystem discovery and streaming reads cooperate with cancellation.
    running.forEach(Thread::interrupt);
    reads.shutdown();
    try {
      if (!reads.awaitTermination(5, TimeUnit.SECONDS))
        throw new IllegalStateException("Usage recovery has not drained yet");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Interrupted while draining usage recovery", error);
    }
    synchronized (cache) {
      cache.clear();
    }
  }
}
