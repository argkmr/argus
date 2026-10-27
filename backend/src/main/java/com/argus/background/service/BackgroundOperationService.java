package com.argus.background.service;

import static com.argus.runtime.service.RuntimeData.*;

import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** Cooperative checkpoints and real owned-child controls, not cosmetic card state changes. */
@Service
public class BackgroundOperationService {
  public final class Operation implements AutoCloseable {
    private final String id;
    private final Runnable pause, resume, beforeCancel, cancel;
    private volatile boolean cancelled;

    private Operation(
        String id, Runnable pause, Runnable resume, Runnable beforeCancel, Runnable cancel) {
      this.id = id;
      this.pause = pause;
      this.resume = resume;
      this.beforeCancel = beforeCancel;
      this.cancel = cancel;
    }

    public boolean isCancelled() {
      return cancelled || "cancelled".equals(jobs.get(id).get("status"));
    }

    /**
     * Wake a paused producer during application shutdown without recording a user-cancellation
     * tombstone.
     */
    public void shutdown() {
      cancelled = true;
      synchronized (this) {
        notifyAll();
      }
    }

    public void checkpoint() {
      synchronized (this) {
        while ("paused".equals(jobs.get(id).get("status")) && !isCancelled())
          try {
            wait(200);
          } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new CancellationException("Background operation interrupted");
          }
        if (isCancelled()) throw new CancellationException("Background operation cancelled");
      }
    }

    @Override
    public void close() {
      if (operations.remove(id, this)) jobs.release(id);
    }
  }

  private final BackgroundJobService jobs;
  private final Map<String, Operation> operations = new ConcurrentHashMap<>();

  public BackgroundOperationService(BackgroundJobService jobs) {
    this.jobs = jobs;
  }

  public Operation register(String id, Runnable pause, Runnable resume, Runnable cancel) {
    return register(id, pause, resume, () -> {}, cancel);
  }

  public Operation register(
      String id, Runnable pause, Runnable resume, Runnable beforeCancel, Runnable cancel) {
    var operation = new Operation(id, pause, resume, beforeCancel, cancel);
    jobs.retain(id);
    if (operations.putIfAbsent(id, operation) != null) {
      jobs.release(id);
      throw new IllegalStateException("Background operation already registered");
    }
    try {
      if ("cancelled".equals(jobs.get(id).get("status"))) operation.cancelled = true;
    } catch (RuntimeException error) {
      try {
        operation.close();
      } catch (RuntimeException cleanup) {
        error.addSuppressed(cleanup);
      }
      throw error;
    }
    return operation;
  }

  public Map<String, Object> pause(String id) {
    var job = jobs.get(id);
    if ("repository-offboarding".equals(job.get("type")))
      throw new ResponseStatusException(
          HttpStatus.CONFLICT,
          "Repository offboarding cannot be paused after permanent deletion begins");
    if (Set.of("queued", "running").contains(job.get("status"))) {
      var operation = operations.get(id);
      if (operation != null) operation.pause.run();
      jobs.update(
          id,
          object(
              "status",
              "paused",
              "message",
              text(job, "message").isEmpty() ? "Paused by user." : job.get("message"),
              "pausedAt",
              Instant.now().toString()));
      jobs.appendLog(
          id,
          object(
              "stage",
              "Paused",
              "message",
              "Background activity paused by the user. The active coding CLI process was suspended."));
    }
    return jobs.get(id);
  }

  public Map<String, Object> resume(String id) {
    var job = jobs.get(id);
    if ("repository-offboarding".equals(job.get("type")))
      throw new ResponseStatusException(
          HttpStatus.CONFLICT,
          "Repository offboarding cannot be paused after permanent deletion begins");
    if ("paused".equals(job.get("status"))) {
      var operation = operations.get(id);
      if (operation != null) operation.resume.run();
      jobs.update(id, object("status", "running", "pausedAt", null));
      if (operation != null)
        synchronized (operation) {
          operation.notifyAll();
        }
      jobs.appendLog(
          id,
          object(
              "stage", "Resumed", "message", "Background activity resumed from the same point."));
    }
    return jobs.get(id);
  }

  public Map<String, Object> cancel(String id) {
    var job = jobs.get(id);
    if ("repository-offboarding".equals(job.get("type")) && BackgroundJobService.active(job))
      throw new ResponseStatusException(
          HttpStatus.CONFLICT,
          "Repository offboarding cannot be stopped after permanent deletion begins");
    if (BackgroundJobService.active(job)) {
      var operation = operations.get(id);
      if (operation != null) {
        operation.beforeCancel.run();
        operation.cancelled = true;
        synchronized (operation) {
          operation.notifyAll();
        }
      }
      var items = copy(list(jobs.get(id).get("items")));
      for (Object item : list(items))
        if (Set.of("queued", "running", "paused").contains(map(item).get("status")))
          map(item).put("status", "cancelled");
      jobs.update(
          id,
          object(
              "status",
              "cancelled",
              "message",
              "Stopped by user.",
              "currentItem",
              "",
              "completedAt",
              Instant.now().toString(),
              "items",
              items));
      if (operation != null) operation.cancel.run();
    }
    return jobs.get(id);
  }
}
