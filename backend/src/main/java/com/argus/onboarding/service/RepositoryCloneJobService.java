package com.argus.onboarding.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.platform.NativeBackgroundOwner;
import jakarta.annotation.PreDestroy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** Clone ownership and durable receipts are independent of the renderer's HTTP connection. */
@Service
public class RepositoryCloneJobService implements NativeBackgroundOwner, AutoCloseable {
  private static final Set<String> ACTIVE = Set.of("queued", "running", "cancelling");
  private final RepositoryDiscoveryService discovery;
  private final AtomicJsonStore json;
  private final Path file;
  private final Map<String, Map<String, Object>> jobs = new LinkedHashMap<>();
  private final Map<String, Thread> running = new ConcurrentHashMap<>();
  private final ExecutorService worker =
      Executors.newFixedThreadPool(
          2,
          task -> {
            Thread thread = new Thread(task, "argus-repository-clone");
            thread.setDaemon(true);
            return thread;
          });
  private boolean closing;

  public RepositoryCloneJobService(
      RepositoryDiscoveryService discovery, AtomicJsonStore json, ArgusProperties properties) {
    this.discovery = discovery;
    this.json = json;
    file = properties.dataDirectory().resolve("repository-clone-jobs.json");
    if (Files.exists(file)) {
      boolean recovered = false;
      for (Object value : list(json.read(file, List.class))) {
        var job = copyMap(map(value));
        if (text(job, "id").isBlank()) continue;
        if (ACTIVE.contains(text(job, "status"))) {
          job.put("status", "interrupted");
          job.put(
              "error",
              "Argus stopped before cloning completed. The destination was preserved. If it contains a completed repository, choose it under On this Mac; otherwise inspect or remove the partial folder before retrying.");
          job.put("message", job.get("error"));
          job.put("updatedAt", Instant.now().toString());
          recovered = true;
        }
        jobs.put(text(job, "id"), job);
      }
      if (recovered) save();
    }
  }

  public synchronized Map<String, Object> start(Map<String, Object> input) {
    if (closing) throw new IllegalStateException("Argus is shutting down");
    String remote = RepositoryDiscoveryService.validateRemote(text(input, "remoteUrl"));
    Path parent;
    try {
      if (text(input, "destinationPath").isBlank()) throw new IllegalArgumentException();
      parent = Path.of(text(input, "destinationPath")).toRealPath();
      if (!Files.isDirectory(parent)) throw new IllegalArgumentException();
    } catch (Exception error) {
      throw new IllegalArgumentException("Choose an existing destination folder");
    }
    String requestId = text(input, "requestId").trim();
    if (requestId.isBlank()) requestId = UUID.randomUUID().toString();
    if (!requestId.matches("[A-Za-z0-9_-]{8,128}"))
      throw new IllegalArgumentException(
          "Clone requestId must contain 8–128 letters, digits, hyphens or underscores");
    for (var existing : jobs.values()) {
      if (requestId.equals(existing.get("requestId"))) {
        if (!remote.equals(existing.get("remoteUrl"))
            || !parent.toString().equals(existing.get("destinationPath")))
          throw new ResponseStatusException(
              HttpStatus.CONFLICT,
              "This clone requestId belongs to a different repository or destination");
        return copyMap(existing);
      }
    }
    if (jobs.values().stream().filter(job -> ACTIVE.contains(text(job, "status"))).count() >= 16)
      throw new ResponseStatusException(
          HttpStatus.CONFLICT,
          "There are already 16 active or queued clones. Wait for one to finish before starting another.");
    String target = parent.resolve(RepositoryDiscoveryService.remoteName(remote)).toString();
    for (var existing : jobs.values()) {
      if (ACTIVE.contains(text(existing, "status")) && target.equals(existing.get("targetPath")))
        throw new ResponseStatusException(
            HttpStatus.CONFLICT,
            "A clone into this destination is already running. Resume its status instead of starting another clone.");
    }
    String id = UUID.randomUUID().toString(), now = Instant.now().toString();
    var job =
        object(
            "id",
            id,
            "requestId",
            requestId,
            "remoteUrl",
            remote,
            "destinationPath",
            parent.toString(),
            "targetPath",
            target,
            "status",
            "queued",
            "message",
            "Repository cloning is queued.",
            "error",
            "",
            "createdAt",
            now,
            "updatedAt",
            now);
    jobs.put(id, job);
    try {
      save();
    } catch (RuntimeException error) {
      jobs.remove(id);
      throw error;
    }
    worker.execute(() -> run(id));
    return copyMap(job);
  }

  public synchronized List<Map<String, Object>> listJobs() {
    var result = new ArrayList<>(jobs.values());
    java.util.Collections.reverse(result);
    // Never hide owned work behind a terminal-history limit. Old receipts remain addressable by
    // id/requestId; only completed history in this response is bounded.
    return java.util.stream.Stream.concat(
            result.stream().filter(item -> ACTIVE.contains(text(item, "status"))),
            result.stream().filter(item -> !ACTIVE.contains(text(item, "status"))).limit(100))
        .map(item -> copyMap(item))
        .toList();
  }

  public synchronized Map<String, Object> get(String id) {
    return copyMap(require(id));
  }

  public synchronized Map<String, Object> cancel(String id) {
    var job = require(id);
    if (!ACTIVE.contains(text(job, "status"))) return copyMap(job);
    if ("queued".equals(job.get("status"))) {
      update(job, "cancelled", "Repository cloning was cancelled before it started.", "");
      return copyMap(job);
    }
    update(job, "cancelling", "Stopping repository cloning…", "");
    Thread thread = running.get(id);
    if (thread != null) thread.interrupt();
    return copyMap(job);
  }

  private void run(String id) {
    String remote, destination;
    synchronized (this) {
      var job = require(id);
      if (closing || Set.of("cancelling", "cancelled").contains(text(job, "status"))) {
        update(job, "cancelled", "Repository cloning was cancelled.", "");
        return;
      }
      running.put(id, Thread.currentThread());
      remote = text(job, "remoteUrl");
      destination = text(job, "destinationPath");
      update(
          job,
          "running",
          "Cloning with your saved Git credentials. You can close this panel and return later.",
          "");
    }
    try {
      var result = discovery.cloneWithDetails(remote, destination);
      // Persist successful Git completion before optional branch inspection. A late cancel cannot
      // erase a completed checkout, and a restart can recover this receipt without cloning again.
      synchronized (this) {
        running.remove(id);
        Thread.interrupted();
        var job = require(id);
        job.put(
            "result",
            object(
                "path",
                result.path(),
                "transport",
                result.transport(),
                "fallbackUsed",
                result.fallbackUsed()));
        update(
            job, "completed", "Repository cloned. Choose its production branch to connect it.", "");
      }
      var repository = discovery.inspect(result.path());
      synchronized (this) {
        map(require(id).get("result")).put("repository", repository);
        save();
      }
    } catch (RuntimeException error) {
      synchronized (this) {
        running.remove(id);
        boolean interrupted = Thread.interrupted();
        var job = require(id);
        if (!"completed".equals(job.get("status"))) {
          boolean cancelled = interrupted || closing || "cancelling".equals(job.get("status"));
          String reason =
              error.getMessage() == null
                  ? "Repository cloning failed. Retry after checking the destination."
                  : error.getMessage();
          update(
              job,
              cancelled ? "cancelled" : "failed",
              cancelled ? "Repository cloning was cancelled." : reason,
              cancelled ? "" : reason);
        }
      }
    } finally {
      running.remove(id);
      Thread.interrupted();
    }
  }

  /** Complete receipts written before branch inspection are enriched on the next status request. */
  public Map<String, Object> status(String id) {
    var job = get(id);
    var result = map(job.get("result"));
    if ("completed".equals(job.get("status")) && !result.containsKey("repository")) {
      var repository = discovery.inspect(text(result, "path"));
      synchronized (this) {
        map(require(id).get("result")).putIfAbsent("repository", repository);
        save();
        return get(id);
      }
    }
    return job;
  }

  private Map<String, Object> require(String id) {
    var job = jobs.get(id);
    if (job == null) throw new NotFoundException("Repository clone job not found");
    return job;
  }

  private void update(Map<String, Object> job, String status, String message, String error) {
    job.put("status", status);
    job.put("message", message);
    job.put("error", error);
    job.put("updatedAt", Instant.now().toString());
    save();
  }

  private void save() {
    json.write(file, new ArrayList<>(jobs.values()));
  }

  @Override
  public String ownerName() {
    return "repository cloning";
  }

  @Override
  public int shutdownOrder() {
    return 18;
  }

  @Override
  public void quiesce() {
    close();
  }

  @Override
  @PreDestroy
  public void close() {
    synchronized (this) {
      closing = true;
      running.values().forEach(Thread::interrupt);
      worker.shutdown();
    }
    try {
      if (!worker.awaitTermination(30, TimeUnit.SECONDS))
        throw new IllegalStateException("Repository cloning has not drained");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Repository clone shutdown interrupted", error);
    }
  }
}
