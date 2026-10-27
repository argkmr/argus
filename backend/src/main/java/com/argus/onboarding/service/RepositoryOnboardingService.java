package com.argus.onboarding.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.background.service.*;
import com.argus.platform.NativeBackgroundOwner;
import com.argus.repositorycontext.service.RepositoryContextService;
import com.argus.runtime.service.RuntimeData;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import jakarta.annotation.PreDestroy;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class RepositoryOnboardingService implements NativeBackgroundOwner {
  private final WorkspaceService workspace;
  private final RepositoryDiscoveryService discovery;
  private final BackgroundJobService jobs;
  private final BackgroundOperationService operations;
  private final RepositoryContextService contexts;
  private final AiKitGenerationService kits;
  private final ExecutorService worker =
      Executors.newCachedThreadPool(
          task -> {
            Thread thread = new Thread(task, "argus-repository-onboarding");
            thread.setDaemon(true);
            return thread;
          });
  private final Map<String, BackgroundOperationService.Operation> active =
      new ConcurrentHashMap<>();
  private volatile boolean closing;
  private final Map<String, CompletableFuture<Void>> completions = new ConcurrentHashMap<>();
  private final java.util.Set<String> excludedPaths = ConcurrentHashMap.newKeySet();
  private org.springframework.beans.factory.ObjectProvider<RepositoryPurgeService> purges;
  private org.springframework.beans.factory.ObjectProvider<RepositoryDisconnectService> disconnects;

  @org.springframework.beans.factory.annotation.Autowired
  public void setDisconnectService(
      org.springframework.beans.factory.ObjectProvider<RepositoryDisconnectService> disconnects) {
    this.disconnects = disconnects;
  }

  @org.springframework.beans.factory.annotation.Autowired
  public void setPurgeService(
      org.springframework.beans.factory.ObjectProvider<RepositoryPurgeService> purges) {
    this.purges = purges;
  }

  public RepositoryOnboardingService(
      WorkspaceService workspace,
      RepositoryDiscoveryService discovery,
      BackgroundJobService jobs,
      BackgroundOperationService operations,
      RepositoryContextService contexts,
      AiKitGenerationService kits) {
    this.workspace = workspace;
    this.discovery = discovery;
    this.jobs = jobs;
    this.operations = operations;
    this.contexts = contexts;
    this.kits = kits;
  }

  public synchronized Map<String, Object> start(Map<String, Object> input) {
    if (closing) throw new IllegalStateException("Argus is shutting down");
    if (jobs.list().stream()
        .anyMatch(
            job ->
                "repository-offboarding".equals(job.get("type"))
                    && BackgroundJobService.active(job)))
      throw new ResponseStatusException(
          HttpStatus.CONFLICT, "Wait for repository disconnection to finish before reconnecting");
    var requested = new ArrayList<Map<String, Object>>();
    for (Object raw : list(input.get("repositories"))) {
      var item = map(raw);
      String path = text(item, "path").trim(), branch = text(item, "productionBranch").trim();
      if (!path.isEmpty())
        requested.add(
            object(
                "path",
                path,
                "name",
                Path.of(path).getFileName().toString(),
                "productionBranch",
                branch));
    }
    if (requested.isEmpty())
      throw new IllegalArgumentException("Discover and select at least one repository");
    if (requested.stream().anyMatch(item -> text(item, "productionBranch").isEmpty()))
      throw new IllegalArgumentException("Select a production branch for every repository");
    var unique = new LinkedHashSet<String>();
    for (var repository : requested) {
      var available = discovery.branchOptions(text(repository, "path"));
      if (!strings(available.get("branches")).contains(text(repository, "productionBranch")))
        throw new IllegalArgumentException(
            repository.get("productionBranch")
                + " is not an available branch for "
                + repository.get("name"));
      repository.put("path", available.get("path"));
      repository.put("name", available.get("name"));
      if (!unique.add(text(repository, "path")))
        throw new IllegalArgumentException("The same repository was selected more than once");
    }
    var conflicts = new LinkedHashSet<String>();
    for (var job : jobs.list())
      if ("repository-onboarding".equals(job.get("type")) && BackgroundJobService.active(job))
        for (Object raw : list(job.get("items")))
          if (unique.contains(text(map(raw), "path"))) conflicts.add(text(map(raw), "name"));
    if (!conflicts.isEmpty())
      throw new ResponseStatusException(
          HttpStatus.CONFLICT,
          String.join(", ", conflicts)
              + (conflicts.size() == 1 ? " is" : " are")
              + " already being onboarded");
    if (unique.stream().anyMatch(excludedPaths::contains))
      throw new ResponseStatusException(
          HttpStatus.CONFLICT, "Repository offboarding is still active");
    var job =
        jobs.create(
            object(
                "type",
                "repository-onboarding",
                "title",
                requested.size() > 1
                    ? "Onboarding selected repositories"
                    : "Onboarding " + requested.get(0).get("name"),
                "message",
                "Preparing fresh production-branch snapshots…",
                "total",
                requested.size(),
                "items",
                requested));
    String id = text(job, "id");
    var operation = operations.register(id, () -> {}, () -> {}, () -> {});
    active.put(id, operation);
    var completion = new CompletableFuture<Void>();
    completions.put(id, completion);
    worker.execute(
        () -> {
          try (operation) {
            run(id, requested, operation);
            completion.complete(null);
          } catch (Throwable error) {
            completion.completeExceptionally(error);
          } finally {
            active.remove(id);
            completions.remove(id, completion);
          }
        });
    return job;
  }

  private void run(
      String id,
      List<Map<String, Object>> requested,
      BackgroundOperationService.Operation operation) {
    try {
      operation.checkpoint();
      if (closing) return;
      jobs.update(
          id,
          object(
              "status",
              "running",
              "startedAt",
              Instant.now().toString(),
              "message",
              requested.size() > 1
                  ? "Bulk onboarding is running in the background. Keep using Argus while each repository is prepared."
                  : "The repository is being prepared in the background. You can keep using Argus."));
      jobs.appendLog(
          id,
          object(
              "stage",
              "discovery",
              "message",
              "Validated "
                  + requested.size()
                  + " selected "
                  + (requested.size() == 1 ? "repository" : "repositories")
                  + "."));
      var onboarded = new ArrayList<Repository>();
      for (int index = 0; index < requested.size(); index++) {
        operation.checkpoint();
        if (closing) return;
        var item = requested.get(index);
        String path = text(item, "path"), name = text(item, "name");
        boolean existed =
            workspace.snapshot().repositories().stream()
                .anyMatch(repository -> repository.path().equals(path));
        boolean retained = workspace.hasDisconnectedPath(path);
        Repository repository = null;
        long started = System.currentTimeMillis();
        jobs.update(id, object("currentItem", name));
        jobs.updateItem(
            id,
            index,
            object(
                "status",
                "running",
                "startedAt",
                Instant.now().toString(),
                "stage",
                "registering"));
        jobs.appendLog(
            id,
            object(
                "repository",
                name,
                "stage",
                "registering",
                "message",
                "Registering repository and production branch."));
        try {
          repository = workspace.onboardRepository(path, text(item, "productionBranch"));
          if (disconnects != null) disconnects.getObject().reconnectRepository(repository.id());
          kits.allowRepositories(List.of(repository.id()));
          if (!retained) contexts.removeLegacyProfile(repository);
          jobs.updateItem(
              id,
              index,
              object(
                  "status",
                  "completed",
                  "stage",
                  "ready",
                  "repositoryId",
                  repository.id(),
                  "durationMillis",
                  System.currentTimeMillis() - started,
                  "completedAt",
                  Instant.now().toString()));
          jobs.update(id, object("completed", number(jobs.get(id).get("completed")) + 1));
          onboarded.add(repository);
          jobs.appendLog(
              id,
              object(
                  "repository",
                  name,
                  "stage",
                  "ready",
                  "durationMillis",
                  System.currentTimeMillis() - started,
                  "message",
                  "Repository connected. Start private AI-kit generation from the repository view when ready."));
        } catch (RuntimeException error) {
          if (operation.isCancelled() || closing) return;
          if (repository != null && !existed) {
            if (purges == null)
              throw new IllegalStateException(
                  "Native repository purge service is unavailable", error);
            try {
              if (retained) {
                if (disconnects == null)
                  throw new IllegalStateException("Repository disconnect service is unavailable");
                disconnects.getObject().disconnectRepository(repository, true);
              } else purges.getObject().purgeRepository(repository, id, true);
            } catch (RuntimeException cleanup) {
              error.addSuppressed(cleanup);
              throw new IllegalStateException(
                  "Onboarding failed and its partial data could not be fully removed", error);
            }
          }
          jobs.updateItem(
              id,
              index,
              object(
                  "status",
                  "failed",
                  "stage",
                  "failed",
                  "error",
                  error.getMessage(),
                  "durationMillis",
                  System.currentTimeMillis() - started,
                  "completedAt",
                  Instant.now().toString()));
          jobs.update(
              id,
              object(
                  "failed",
                  number(jobs.get(id).get("failed")) + 1,
                  "message",
                  name + " could not be onboarded. Continuing with the remaining repositories…"));
          jobs.appendLog(
              id,
              object(
                  "level",
                  "error",
                  "repository",
                  name,
                  "stage",
                  "onboarding",
                  "durationMillis",
                  System.currentTimeMillis() - started,
                  "message",
                  error.getMessage()));
        }
      }
      operation.checkpoint();
      if (closing) return;
      var finished = jobs.get(id);
      boolean failed = number(finished.get("failed")) > 0,
          single = number(finished.get("total")) == 1 && number(finished.get("failed")) == 1;
      String failures =
          list(finished.get("items")).stream()
              .map(RuntimeData::map)
              .filter(item -> "failed".equals(item.get("status")))
              .map(
                  item ->
                      text(item, "name")
                          + ": "
                          + text(item, "error")
                              .substring(0, Math.min(240, text(item, "error").length())))
              .collect(java.util.stream.Collectors.joining(" • "));
      jobs.update(
          id,
          object(
              "status",
              single ? "failed" : failed ? "completed-with-errors" : "completed",
              "percent",
              100,
              "currentItem",
              "",
              "completedAt",
              Instant.now().toString(),
              "error",
              single ? map(list(finished.get("items")).get(0)).get("error") : "",
              "message",
              failed
                  ? finished.get("completed")
                      + " of "
                      + finished.get("total")
                      + " repositories onboarded; "
                      + finished.get("failed")
                      + " failed. "
                      + failures
                  : finished.get("completed")
                      + (number(finished.get("completed")) == 1 ? " repository" : " repositories")
                      + " ready."));
      jobs.appendLog(
          id,
          object(
              "level",
              failed ? "warning" : "info",
              "stage",
              "summary",
              "message",
              failed
                  ? finished.get("completed")
                      + " repositories onboarded; "
                      + finished.get("failed")
                      + " failed. Remaining repositories were still attempted."
                  : finished.get("completed") + " repositories onboarded successfully."));
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
                Instant.now().toString()));
    }
  }

  @Override
  public String ownerName() {
    return "repository onboarding";
  }

  public void cancelRepositories(List<String> ids) {
    var paths =
        workspace.snapshot().repositories().stream()
            .filter(repository -> ids.contains(repository.id()))
            .map(Repository::path)
            .toList();
    List<Map<String, Object>> targets;
    synchronized (this) {
      excludedPaths.addAll(paths);
      targets =
          jobs.list().stream()
              .filter(
                  job ->
                      "repository-onboarding".equals(job.get("type"))
                          && BackgroundJobService.active(job)
                          && list(job.get("items")).stream()
                              .anyMatch(
                                  item ->
                                      ids.contains(text(map(item), "repositoryId"))
                                          || paths.contains(text(map(item), "path"))))
              .toList();
    }
    for (var job : targets) {
      String id = text(job, "id");
      var completion = completions.get(id);
      operations.cancel(id);
      if (completion != null) completion.join();
    }
  }

  public void allowPaths(List<String> paths) {
    excludedPaths.removeAll(paths);
  }

  @Override
  public int shutdownOrder() {
    return 19;
  }

  @Override
  public void quiesce() {
    close();
  }

  @PreDestroy
  public void close() {
    closing = true;
    for (String id : List.copyOf(active.keySet())) operations.cancel(id);
    worker.shutdown();
    try {
      if (!worker.awaitTermination(30, TimeUnit.SECONDS))
        throw new IllegalStateException("Repository onboarding has not drained");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Repository onboarding shutdown interrupted", error);
    }
  }
}
