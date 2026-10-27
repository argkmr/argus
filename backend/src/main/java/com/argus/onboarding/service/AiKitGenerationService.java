package com.argus.onboarding.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.agents.dto.AgentProvider;
import com.argus.agents.service.AgentExecutionService;
import com.argus.agents.service.AgentProviderService;
import com.argus.background.service.*;
import com.argus.common.process.CommandRunner;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.repositorycontext.service.*;
import com.argus.repositorycontext.service.ProductionRepositorySnapshotService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import jakarta.annotation.PreDestroy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/** Durable coalesced production-snapshot generation; publishes only fully validated kits. */
@Service
public class AiKitGenerationService
    implements com.argus.platform.NativeBackgroundOwner, AutoCloseable {
  private final WorkspaceService workspace;
  private final BackgroundJobService jobs;
  private final BackgroundOperationService operations;
  private final AiKitRefreshQueue queue;
  private final AgentProviderService providers;
  private final AgentExecutionService agents;
  private final ProductionRepositorySnapshotService snapshots;
  private final RepositoryContextService contexts;
  private final AiKitCoverageService coverage;
  private final CommandRunner commands;
  private final AtomicJsonStore json;
  private final ObjectMapper mapper;
  private final boolean enabled;
  private final ScheduledExecutorService scheduler =
      Executors.newSingleThreadScheduledExecutor(
          task -> {
            Thread thread = new Thread(task, "argus-ai-kit-schedule");
            thread.setDaemon(true);
            return thread;
          });
  private final ExecutorService worker =
      Executors.newSingleThreadExecutor(
          task -> {
            Thread thread = new Thread(task, "argus-ai-kit-generation");
            thread.setDaemon(true);
            return thread;
          });
  private final Map<String, Set<String>> running = new ConcurrentHashMap<>();
  private volatile boolean closing;
  private ScheduledFuture<?> scheduled;
  private boolean revisionsChecking;
  private final Map<String, BackgroundOperationService.Operation> activeOperations =
      new ConcurrentHashMap<>();
  private final Map<String, CompletableFuture<Void>> completions = new ConcurrentHashMap<>();
  private final Set<String> excluded = ConcurrentHashMap.newKeySet();
  private final Set<String> explicitlyRequested = ConcurrentHashMap.newKeySet();
  private final Set<String> pausedRequests = ConcurrentHashMap.newKeySet();
  private final Object controlLock = new Object();

  public AiKitGenerationService(
      WorkspaceService workspace,
      BackgroundJobService jobs,
      BackgroundOperationService operations,
      AiKitRefreshQueue queue,
      AgentProviderService providers,
      AgentExecutionService agents,
      ProductionRepositorySnapshotService snapshots,
      RepositoryContextService contexts,
      AiKitCoverageService coverage,
      CommandRunner commands,
      AtomicJsonStore json,
      ObjectMapper mapper,
      @Value("${argus.ai-kit.auto-refresh-enabled:true}") boolean enabled) {
    this.workspace = workspace;
    this.jobs = jobs;
    this.operations = operations;
    this.queue = queue;
    this.providers = providers;
    this.agents = agents;
    this.snapshots = snapshots;
    this.contexts = contexts;
    this.coverage = coverage;
    this.commands = commands;
    this.json = json;
    this.mapper = mapper;
    this.enabled = enabled;
  }

  @EventListener(ApplicationReadyEvent.class)
  public void ready() {
    // Connecting a repository or starting Argus must never spend an AI request.
    // Saved interrupted work is resumed only through an explicit user action.
  }

  private void periodicCheck() {
    if (closing) return;
    try {
      pump("Generating repository business-flow Skills");
      checkRevisions();
    } catch (RuntimeException error) {
      org.slf4j.LoggerFactory.getLogger(AiKitGenerationService.class)
          .warn(
              "AI-kit background maintenance could not complete ({}); the next scheduled check remains enabled",
              error.getClass().getSimpleName());
    }
  }

  public synchronized Map<String, Object> request(
      List<Repository> repositories,
      String title,
      boolean automatic,
      Map<String, String> revisions) {
    if (closing) throw new IllegalStateException("Argus is shutting down");
    if (automatic) return null;
    if (repositories.isEmpty()) return null;
    if (repositories.stream().anyMatch(repository -> excluded.contains(repository.id())))
      throw new org.springframework.web.server.ResponseStatusException(
          org.springframework.http.HttpStatus.CONFLICT,
          "A selected repository is being offboarded; finish cleanup before refreshing its AI kit");
    queue.load();
    explicitlyRequested.addAll(repositories.stream().map(Repository::id).toList());
    pausedRequests.removeAll(repositories.stream().map(Repository::id).toList());
    queue.request(repositories.stream().map(Repository::id).toList(), automatic, revisions);
    return pump(title == null ? "Generating repository business-flow Skills" : title);
  }

  private synchronized void schedule() {
    if (scheduled != null) scheduled.cancel(false);
    if (closing) return;
    var state = queue.snapshot();
    if (state.get("active") != null) return;
    var connected = workspace.snapshot().repositories().stream().map(Repository::id).toList();
    var next =
        list(state.get("pending")).stream()
            .map(item -> map(item))
            .filter(item -> connected.contains(text(item, "repositoryId")))
            .filter(item -> !excluded.contains(text(item, "repositoryId")))
            .filter(item -> explicitlyRequested.contains(text(item, "repositoryId")))
            .mapToLong(item -> number(item.get("notBefore")))
            .min();
    if (next.isEmpty()) return;
    scheduled =
        scheduler.schedule(
            () -> pump("Generating repository business-flow Skills"),
            Math.max(100, next.getAsLong() - System.currentTimeMillis()),
            TimeUnit.MILLISECONDS);
  }

  private synchronized Map<String, Object> pump(String title) {
    if (closing) return null;
    var state = queue.load();
    if (state.get("active") != null) return jobs.get(text(map(state.get("active")), "jobId"));
    var connected = workspace.snapshot().repositories();
    // A disconnected repository may still own a saved request. Do not delete it.
    var selected =
        strings(state.get("readyRepositoryIds")).stream()
            .filter(explicitlyRequested::contains)
            .filter(id -> !excluded.contains(id))
            .map(
                id ->
                    connected.stream()
                        .filter(repository -> repository.id().equals(id))
                        .findFirst()
                        .orElse(null))
            .filter(java.util.Objects::nonNull)
            .toList();
    if (selected.isEmpty()) {
      schedule();
      return null;
    }
    var job =
        jobs.create(
            object(
                "type",
                "ai-kit-generation",
                "title",
                title,
                "message",
                "A connected coding-agent CLI is creating private Skills from production-branch source.",
                "total",
                selected.size(),
                "items",
                selected.stream()
                    .map(
                        repository ->
                            object("name", repository.name(), "repositoryId", repository.id()))
                    .toList()));
    String jobId = text(job, "id");
    var claimed = queue.claim(jobId, selected.stream().map(Repository::id).toList());
    if (!Boolean.TRUE.equals(claimed.get("claimed"))) {
      jobs.update(
          jobId,
          object(
              "status", "cancelled", "message", "Refresh was coalesced with an existing request."));
      return claimed.get("active") == null
          ? null
          : jobs.get(text(map(claimed.get("active")), "jobId"));
    }
    var tracked = ConcurrentHashMap.<String>newKeySet();
    running.put(jobId, tracked);
    var operation =
        operations.register(
            jobId,
            () -> tracked.forEach(agents::pause),
            () -> tracked.forEach(agents::resume),
            () -> queue.cancel(jobId),
            () -> tracked.forEach(agents::stop));
    activeOperations.put(jobId, operation);
    if (operation.isCancelled()) queue.cancel(jobId);
    var completion = new CompletableFuture<Void>();
    completions.put(jobId, completion);
    worker.execute(
        () -> {
          try {
            run(jobId, selected, operation);
          } finally {
            try {
              try {
                running.remove(jobId);
                activeOperations.remove(jobId);
                if (!closing) {
                  var failures = selected.stream().map(Repository::id).toList();
                  try {
                    var finished = jobs.get(jobId);
                    failures =
                        "cancelled".equals(finished.get("status"))
                            ? List.<String>of()
                            : selected.stream()
                                .filter(
                                    repository ->
                                        list(finished.get("items")).stream()
                                            .noneMatch(
                                                item ->
                                                    repository
                                                            .id()
                                                            .equals(map(item).get("repositoryId"))
                                                        && "completed"
                                                            .equals(map(item).get("status"))))
                                .map(Repository::id)
                                .toList();
                  } finally {
                    // A missing/broken presentation card must not strand durable refresh work.
                    // A failed request stays failed until the user chooses Start/Restart.
                    queue.finish(jobId, List.of());
                    explicitlyRequested.removeAll(selected.stream().map(Repository::id).toList());
                    schedule();
                  }
                }
              } finally {
                operation.close();
              }
              completion.complete(null);
            } catch (Throwable failure) {
              completion.completeExceptionally(failure);
            } finally {
              completions.remove(jobId, completion);
            }
          }
        });
    return job;
  }

  private AgentProvider provider() {
    var detected = providers.providers(true);
    return detected.stream()
        .filter(
            item -> item.installed() && item.authenticated() && item.canRun() && item.toolCapable())
        .sorted(java.util.Comparator.comparing(item -> !item.id().equals("codex")))
        .findFirst()
        .orElseThrow(
            () ->
                new IllegalArgumentException(
                    "Connect and verify a coding-agent CLI before generating repository Skills"));
  }

  public Map<String, Object> repositoryStatus(String repositoryId) {
    var repository = workspace.requireRepository(repositoryId);
    var job =
        jobs.list().stream()
            .filter(item -> "ai-kit-generation".equals(item.get("type")))
            .filter(
                item ->
                    list(item.get("items")).stream()
                        .anyMatch(row -> repositoryId.equals(text(map(row), "repositoryId"))))
            .findFirst()
            .orElse(null);
    if (strings(queue.load().get("pendingRepositoryIds")).contains(repositoryId)
        && (explicitlyRequested.contains(repositoryId) || pausedRequests.contains(repositoryId))) {
      job =
          object(
              "id",
              "",
              "status",
              pausedRequests.contains(repositoryId) ? "paused" : "queued",
              "message",
              pausedRequests.contains(repositoryId)
                  ? "AI-kit request paused."
                  : "Waiting for the current AI-kit request to finish.");
    }
    return object(
        "repositoryId",
        repositoryId,
        "job",
        job,
        "ready",
        Files.isRegularFile(contexts.artifactRoot(repository).resolve("manifest.json")),
        "automatic",
        false);
  }

  public Map<String, Object> control(String repositoryId, String action) {
    synchronized (controlLock) {
      var repository = workspace.requireRepository(repositoryId);
      var current = map(repositoryStatus(repositoryId).get("job"));
      String jobId = text(current, "id");
      switch (action) {
        case "pause", "resume" -> {
          if (jobId.isBlank()
              && strings(queue.load().get("pendingRepositoryIds")).contains(repositoryId)) {
            if ("pause".equals(action)) {
              explicitlyRequested.remove(repositoryId);
              pausedRequests.add(repositoryId);
            } else {
              pausedRequests.remove(repositoryId);
              explicitlyRequested.add(repositoryId);
              pump("Preparing AI kit for " + repository.name());
            }
            return repositoryStatus(repositoryId);
          }
          if (jobId.isBlank() || !BackgroundJobService.active(current))
            throw new IllegalArgumentException(
                "No active AI-kit job. Choose Start to continue interrupted work.");
          if ("pause".equals(action)) operations.pause(jobId);
          else operations.resume(jobId);
        }
        case "start", "restart" -> {
          if ("start".equals(action) && !jobId.isBlank() && BackgroundJobService.active(current))
            return repositoryStatus(repositoryId);
          if ("restart".equals(action)) {
            cancelRepositories(List.of(repositoryId));
            contexts.resetGeneratedKit(repository);
          }
          allowRepositories(List.of(repositoryId));
          request(
              List.of(repository), "Preparing AI kit for " + repository.name(), false, Map.of());
        }
        default -> throw new IllegalArgumentException("Choose start, pause, resume or restart");
      }
      return repositoryStatus(repositoryId);
    }
  }

  private void run(
      String id, List<Repository> repositories, BackgroundOperationService.Operation operation) {
    try {
      operation.checkpoint();
      jobs.update(id, object("status", "running", "startedAt", Instant.now().toString()));
      AgentProvider provider = provider();
      for (int index = 0; index < repositories.size(); index++) {
        operation.checkpoint();
        if (closing) return;
        var repository = repositories.get(index);
        long started = System.currentTimeMillis();
        jobs.update(
            id,
            object(
                "currentItem",
                repository.name(),
                "percent",
                Math.max(1, index * 100 / repositories.size()),
                "message",
                provider.name()
                    + " is mapping "
                    + repository.name()
                    + " business flows ("
                    + (index + 1)
                    + " of "
                    + repositories.size()
                    + ")…"));
        jobs.updateItem(
            id,
            index,
            object(
                "status",
                "running",
                "startedAt",
                Instant.now().toString(),
                "stage",
                "business-flow discovery"));
        Path staging = contexts.createGeneratedKitStaging(repository);
        try (var lease = snapshots.open(repository)) {
          operation.checkpoint();
          var snapshot = lease.repository();
          String warning = text(snapshot.additionalProperties(), "snapshotRefreshWarning");
          if (!warning.isEmpty())
            jobs.appendLog(
                id,
                object(
                    "level",
                    "warning",
                    "repository",
                    repository.name(),
                    "stage",
                    "production snapshot",
                    "message",
                    "Origin could not be refreshed; using the existing local "
                        + text(snapshot.additionalProperties(), "snapshotRef")
                        + " snapshot. "
                        + warning));
          String revision =
              commands
                  .run(
                      "git",
                      List.of("-C", snapshot.path(), "rev-parse", "HEAD"),
                      null,
                      Duration.ofSeconds(10))
                  .stdout()
                  .trim();
          var inventory = coverage.inventory(snapshot);
          json.write(staging.resolve("entry-point-inventory.json"), inventory);
          operation.checkpoint();
          runAgent(
              id,
              provider,
              snapshot,
              staging,
              "Generate private AI kit for " + repository.name(),
              prompt(snapshot, staging, inventory),
              operation);
          Map<String, Object> committed;
          try {
            operation.checkpoint();
            committed =
                contexts.commitGeneratedKit(
                    repository, staging, provider.id(), revision, inventory);
          } catch (RuntimeException validation) {
            if (!Files.exists(staging)) throw validation;
            operation.checkpoint();
            jobs.appendLog(
                id,
                object(
                    "level",
                    "warning",
                    "repository",
                    repository.name(),
                    "stage",
                    "AI-kit validation repair",
                    "message",
                    "The first generated kit needed one repair pass: " + validation.getMessage()));
            runAgent(
                id,
                provider,
                snapshot,
                staging,
                "Repair private AI kit for " + repository.name(),
                "Repair the existing Argus AI-kit files in "
                    + staging
                    + ". Do not regenerate unrelated content and do not modify repository source. The deterministic validator rejected the kit for this exact reason:\n\n"
                    + validation.getMessage()
                    + "\n\nUse "
                    + staging.resolve("entry-point-inventory.json")
                    + " as authoritative. Ensure skill-coverage.json maps every inventory ID exactly once with exact source evidence, every referenced skills/<name>/SKILL.md exists with the required sections, and every Skill has valid YAML frontmatter. Return only a concise summary after fixing and checking the files.",
                operation);
            operation.checkpoint();
            committed =
                contexts.commitGeneratedKit(
                    repository, staging, provider.id(), revision, inventory);
          }
          contexts.removeLegacyProfile(repository);
          jobs.updateItem(
              id,
              index,
              object(
                  "status",
                  "completed",
                  "completedAt",
                  Instant.now().toString(),
                  "durationMillis",
                  System.currentTimeMillis() - started,
                  "skillCount",
                  list(committed.get("skills")).size()));
          jobs.update(id, object("completed", number(jobs.get(id).get("completed")) + 1));
          jobs.appendLog(
              id,
              object(
                  "repository",
                  repository.name(),
                  "stage",
                  "AI kit",
                  "durationMillis",
                  System.currentTimeMillis() - started,
                  "message",
                  list(committed.get("skills")).size()
                      + " business-flow Skills committed with "
                      + map(committed.get("validation")).get("coveredEntryPoints")
                      + "/"
                      + map(committed.get("validation")).get("totalEntryPoints")
                      + " production entry points verified at revision "
                      + revision.substring(0, Math.min(12, revision.length()))
                      + "."));
        } catch (Exception error) {
          try {
            RepositoryContextService.deleteTree(staging);
          } catch (Exception cleanup) {
            error.addSuppressed(cleanup);
          }
          if (operation.isCancelled() || closing) return;
          jobs.updateItem(
              id,
              index,
              object(
                  "status",
                  "failed",
                  "error",
                  error.getMessage(),
                  "durationMillis",
                  System.currentTimeMillis() - started,
                  "completedAt",
                  Instant.now().toString()));
          jobs.update(id, object("failed", number(jobs.get(id).get("failed")) + 1));
          jobs.appendLog(
              id,
              object(
                  "level",
                  "error",
                  "repository",
                  repository.name(),
                  "stage",
                  "AI kit",
                  "durationMillis",
                  System.currentTimeMillis() - started,
                  "message",
                  error.getMessage()));
        }
      }
      operation.checkpoint();
      var finished = jobs.get(id);
      boolean failed = number(finished.get("failed")) > 0;
      jobs.update(
          id,
          object(
              "status",
              failed ? "completed-with-errors" : "completed",
              "percent",
              100,
              "currentItem",
              "",
              "completedAt",
              Instant.now().toString(),
              "message",
              failed
                  ? finished.get("completed")
                      + " AI kits updated; "
                      + finished.get("failed")
                      + " need attention."
                  : finished.get("completed") + " production-branch AI kits are ready."));
    } catch (Exception error) {
      if (!closing && !operation.isCancelled())
        jobs.update(
            id,
            object(
                "status",
                "failed",
                "error",
                error.getMessage(),
                "currentItem",
                "",
                "completedAt",
                Instant.now().toString(),
                "message",
                error.getMessage()));
    }
  }

  private void runAgent(
      String id,
      AgentProvider provider,
      Repository snapshot,
      Path staging,
      String title,
      String prompt,
      BackgroundOperationService.Operation operation) {
    operation.checkpoint();
    Map<String, Object> repo = mapper.convertValue(snapshot, Map.class);
    var job =
        agents.start(
            object(
                "provider",
                provider.id(),
                "mode",
                "edit",
                "prompt",
                title,
                "repository",
                repo,
                "scope",
                "repository",
                "skillDirectories",
                List.of(staging.toString()),
                "rawPrompt",
                prompt,
                "systemJob",
                true));
    String jobId = text(job, "id");
    var tracked = running.get(id);
    tracked.add(jobId);
    boolean cancelled = false, interrupted = false;
    RuntimeException stopFailure = null;
    try {
      if ("paused".equals(jobs.get(id).get("status"))) agents.pause(jobId);
      Map<String, Object> completed;
      for (; ; ) {
        if (operation.isCancelled() || closing || interrupted) {
          cancelled = true;
          try {
            agents.stop(
                jobId,
                com.argus.agents.domain.CancellationRequest.internal(
                    closing
                        ? com.argus.agents.domain.CancellationRequest.Cause.BACKGROUND_SHUTDOWN
                        : com.argus.agents.domain.CancellationRequest.Cause.BACKGROUND_CANCEL));
          } catch (RuntimeException failure) {
            stopFailure = failure;
          }
        }
        try {
          completed = agents.completion(jobId).get(200, TimeUnit.MILLISECONDS);
          break;
        } catch (TimeoutException timeout) {
          /* Keep the snapshot lease until owned children and streams drain. */
        } catch (InterruptedException error) {
          interrupted = true;
          Thread.interrupted();
        } catch (ExecutionException error) {
          throw new IllegalStateException("Coding-agent completion failed", error.getCause());
        }
      }
      if (cancelled) {
        var failure = new CancellationException("Background generation cancelled");
        if (stopFailure != null) failure.addSuppressed(stopFailure);
        throw failure;
      }
      operation.checkpoint();
      if (!"completed".equals(completed.get("status")))
        throw new IllegalArgumentException(
            text(map(completed.get("failure")), "message").isEmpty()
                ? text(completed, "error").isBlank()
                    ? provider.name() + " did not complete AI-kit generation"
                    : text(completed, "error")
                : text(map(completed.get("failure")), "message"));
    } finally {
      tracked.remove(jobId);
      if (interrupted) Thread.currentThread().interrupt();
    }
  }

  public static String prompt(Repository repository, Path staging, Map<String, Object> inventory) {
    return "Create Argus's private AI kit for "
        + repository.name()
        + " from the repository currently open at "
        + repository.path()
        + ".\n\nThe checked-out source is a temporary snapshot of production branch "
        + repository.productionBranch()
        + " and is the source of truth. Do not modify any repository source file. Write output only inside this exact directory: "
        + staging
        + "\n\nRequired output:\n1. "
        + staging.resolve("AGENTS.md")
        + " — a short router explaining when and how to use the generated Skills, and requiring live source verification before changes.\n2. "
        + staging.resolve("skill-coverage.json")
        + " — valid JSON mapping every entry in "
        + staging.resolve("entry-point-inventory.json")
        + " exactly once. Use this shape: {\"schemaVersion\":1,\"inventoryFingerprint\":\""
        + text(inventory, "fingerprint")
        + "\",\"entries\":[{\"entryPointId\":\"<inventory id>\",\"businessFlow\":\"<specific flow>\",\"skill\":\"<lowercase-skill-directory>\",\"evidence\":[{\"path\":\"<exact inventory source path>\",\"line\":123}]}]}. Unknown, duplicate, or uncovered IDs are forbidden.\n3. skills/<business-flow>/SKILL.md — one Skill per major business capability, grouping related APIs by business requirement rather than one Skill per endpoint.\n\nEvery SKILL.md must have YAML frontmatter with a unique lowercase name and precise description. Required Markdown sections: Purpose, Entry points, Flow, Validations and policy rules, Data mutations, Dependencies, Failure and rollback behavior, Observability, and Source files and tests. Cite repository-relative source paths. Do not copy large code blocks, invent behavior, include secrets, or produce generic boilerplate.\n\nThe deterministic inventory contains "
        + list(inventory.get("entryPoints")).size()
        + " production entry points. Inspect source around every item, discover supporting internal flows, group related entry points, generate Skills, and cross-check skill-coverage.json. Do not claim completion while an inventory ID is absent. Existing staging output may be replaced. Return only a concise completion summary after writing files.";
  }

  private synchronized void checkRevisions() {
    if (closing || revisionsChecking) return;
    revisionsChecking = true;
    try {
      if (providers.providers(false).stream()
          .noneMatch(
              item ->
                  item.installed() && item.authenticated() && item.canRun() && item.toolCapable()))
        return;
      var repositories =
          workspace.snapshot().repositories().stream()
              .filter(repository -> !excluded.contains(repository.id()))
              .toList();
      var statuses = contexts.artifactStatus(repositories);
      var changed = new ArrayList<Repository>();
      var revisions = new java.util.LinkedHashMap<String, String>();
      for (var repository : repositories)
        try {
          String revision = text(snapshots.remoteRevision(repository), "revision");
          revisions.put(repository.id(), revision);
          var current =
              statuses.stream()
                  .filter(item -> repository.id().equals(item.get("repositoryId")))
                  .findFirst()
                  .orElse(Map.of());
          if (!Boolean.TRUE.equals(current.get("privateReady"))
              || !revision.equals(current.get("sourceRevision"))) changed.add(repository);
        } catch (RuntimeException ignored) {
        }
      if (!changed.isEmpty())
        request(changed, "Updating AI kits from production changes", true, revisions);
    } finally {
      revisionsChecking = false;
    }
  }

  /** Excludes targets before draining overlapping workers; unrelated requests remain eligible. */
  public void cancelRepositories(List<String> ids) {
    cancelRepositories(ids, false);
  }

  public void disconnectRepositories(List<String> ids) {
    queue.preserveRepositoryRequests(ids);
    cancelRepositories(ids, true);
  }

  private void cancelRepositories(List<String> ids, boolean preserveData) {
    List<Map<String, Object>> targets;
    synchronized (this) {
      excluded.addAll(ids);
      explicitlyRequested.removeAll(ids);
      pausedRequests.removeAll(ids);
      targets = jobs.list();
    }
    var retry = new ArrayList<Repository>();
    for (var job : targets)
      if ("ai-kit-generation".equals(job.get("type"))
          && BackgroundJobService.active(job)
          && list(job.get("items")).stream()
              .anyMatch(item -> ids.contains(text(map(item), "repositoryId")))) {
        String jobId = text(job, "id");
        var completion = completions.get(jobId);
        var untouched =
            list(job.get("items")).stream()
                .map(item -> text(map(item), "repositoryId"))
                .filter(id -> !ids.contains(id))
                .toList();
        operations.cancel(jobId);
        if (completion != null) completion.join();
        var finished = jobs.get(jobId);
        workspace.snapshot().repositories().stream()
            .filter(repository -> untouched.contains(repository.id()))
            .filter(
                repository ->
                    list(finished.get("items")).stream()
                        .noneMatch(
                            item ->
                                repository.id().equals(map(item).get("repositoryId"))
                                    && "completed".equals(map(item).get("status"))))
            .forEach(retry::add);
      }
    queue.load();
    if (!preserveData) queue.purgeRepositories(ids);
    if (!retry.isEmpty() && !closing)
      request(retry, "Generating repository business-flow Skills", false, Map.of());
  }

  /** Explicit re-onboarding makes a formerly removed repository eligible again. */
  public void allowRepositories(List<String> ids) {
    excluded.removeAll(ids);
  }

  public CompletableFuture<Void> completion(String jobId) {
    return completions.getOrDefault(jobId, CompletableFuture.completedFuture(null));
  }

  @PreDestroy
  public void close() {
    closing = true;
    scheduler.shutdownNow();
    activeOperations.values().forEach(BackgroundOperationService.Operation::shutdown);
    RuntimeException stopFailure = null;
    for (var ids : running.values())
      for (String id : List.copyOf(ids))
        try {
          agents.stop(
              id,
              com.argus.agents.domain.CancellationRequest.internal(
                  com.argus.agents.domain.CancellationRequest.Cause.BACKGROUND_SHUTDOWN));
        } catch (RuntimeException error) {
          if (stopFailure == null) stopFailure = error;
          else stopFailure.addSuppressed(error);
        }
    worker.shutdown();
    try {
      if (!worker.awaitTermination(30, TimeUnit.SECONDS)) {
        var failure =
            new IllegalStateException(
                "AI-kit generation has not drained; production snapshots are retained");
        if (stopFailure != null) failure.addSuppressed(stopFailure);
        throw failure;
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("AI-kit shutdown interrupted", error);
    }
  }

  @Override
  public String ownerName() {
    return "production AI-kit generation";
  }

  @Override
  public int shutdownOrder() {
    return 20;
  }

  @Override
  public void quiesce() {
    close();
  }
}
