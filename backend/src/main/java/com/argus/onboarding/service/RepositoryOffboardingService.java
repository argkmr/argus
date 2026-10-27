package com.argus.onboarding.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.background.service.BackgroundJobService;
import com.argus.backup.service.BackupCoordinator;
import com.argus.common.error.ConflictException;
import com.argus.platform.NativeBackgroundOwner;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Service;

@Service
public class RepositoryOffboardingService implements NativeBackgroundOwner {
  private final WorkspaceService workspace;
  private final RepositoryDisconnectService disconnect;
  private final BackupCoordinator backup;
  private final BackgroundJobService jobs;
  private final RepositoryOnboardingService onboarding;
  private final ExecutorService executor =
      Executors.newSingleThreadExecutor(
          task -> {
            var thread = new Thread(task, "argus-offboarding");
            thread.setDaemon(true);
            return thread;
          });
  private boolean closing;

  public RepositoryOffboardingService(
      WorkspaceService workspace,
      RepositoryDisconnectService disconnect,
      BackupCoordinator backup,
      BackgroundJobService jobs,
      RepositoryOnboardingService onboarding) {
    this.workspace = workspace;
    this.disconnect = disconnect;
    this.backup = backup;
    this.jobs = jobs;
    this.onboarding = onboarding;
  }

  public synchronized Map<String, Object> start(Map<String, Object> input) {
    if (!"offboard".equalsIgnoreCase(text(input, "confirmation").trim()))
      throw new IllegalArgumentException(
          "Type \"offboard\" to confirm disconnecting the repositories");
    var ids = strings(input.get("repositoryIds")).stream().distinct().toList();
    if (ids.isEmpty())
      throw new IllegalArgumentException("Select at least one repository to offboard");
    if (closing
        || jobs.list().stream()
            .anyMatch(
                job ->
                    "repository-offboarding".equals(job.get("type"))
                        && BackgroundJobService.active(job)))
      throw new ConflictException(
          "Wait for the current repository offboarding operation to finish");
    var repositories = ids.stream().map(workspace::requireRepository).toList();
    var reservation = backup.beginOffboarding();
    try {
      var items = new ArrayList<Map<String, Object>>();
      repositories.forEach(
          repo -> items.add(object("name", repo.name(), "repositoryId", repo.id())));
      var job =
          jobs.create(
              object(
                  "type",
                  "repository-offboarding",
                  "title",
                  repositories.size() == 1
                      ? "Offboarding " + repositories.get(0).name()
                      : "Offboarding repositories",
                  "message",
                  "Disconnection is queued. All chats, settings and repository data will be retained.",
                  "total",
                  repositories.size(),
                  "items",
                  items));
      executor.execute(() -> run(text(job, "id"), repositories, reservation));
      return job;
    } catch (RuntimeException error) {
      try {
        reservation.close();
      } catch (Exception cleanup) {
        error.addSuppressed(cleanup);
      }
      throw error;
    }
  }

  private void run(String id, List<Repository> repositories, AutoCloseable reservation) {
    var results = new ArrayList<Map<String, Object>>();
    try (reservation) {
      jobs.update(
          id,
          object(
              "status",
              "running",
              "startedAt",
              now(),
              "message",
              "Disconnecting selected repositories from Argus…"));
      jobs.appendLog(
          id,
          object(
              "stage",
              "Disconnect",
              "message",
              "Stopping repository work and disconnecting services. All chats, attachments, AI context, settings and source files are retained."));
      for (int i = 0; i < repositories.size(); i++) {
        var repo = repositories.get(i);
        long started = System.nanoTime();
        jobs.update(id, object("currentItem", repo.name()));
        jobs.updateItem(id, i, object("status", "running", "startedAt", now()));
        try {
          results.add(disconnect.disconnectRepository(repo));
          jobs.updateItem(id, i, object("status", "completed", "completedAt", now()));
          jobs.update(id, object("completed", number(jobs.get(id).get("completed")) + 1));
          jobs.appendLog(
              id,
              object(
                  "repository",
                  repo.name(),
                  "stage",
                  "Disconnect",
                  "durationMillis",
                  elapsed(started),
                  "message",
                  "Repository disconnected. All data and chats were retained."));
        } catch (RuntimeException error) {
          jobs.updateItem(
              id, i, object("status", "failed", "error", reason(error), "completedAt", now()));
          jobs.update(id, object("failed", number(jobs.get(id).get("failed")) + 1));
          jobs.appendLog(
              id,
              object(
                  "repository",
                  repo.name(),
                  "stage",
                  "Disconnect",
                  "level",
                  "error",
                  "durationMillis",
                  elapsed(started),
                  "message",
                  reason(error)));
        }
      }
      // Disconnecting is not deletion. Never invalidate or replace the last backup here.
      var job = jobs.get(id);
      long failures = number(job.get("failed"));
      String message =
          failures > 0
              ? (repositories.size() - failures)
                  + " repositories disconnected; "
                  + failures
                  + " could not be disconnected. All data was retained."
              : repositories.size()
                  + " repositories disconnected. All data and chats were retained.";
      jobs.update(
          id,
          object(
              "status",
              failures > 0 ? "completed-with-errors" : "completed",
              "percent",
              100,
              "currentItem",
              "",
              "completedAt",
              now(),
              "message",
              message,
              "result",
              object("repositories", results)));
    } catch (Exception error) {
      jobs.update(
          id,
          object(
              "status", "failed", "error", reason(error), "currentItem", "", "completedAt", now()));
    } finally {
      // Only fully disconnected repositories may be explicitly reconnected again.
      var removed = results.stream().map(result -> text(result, "repositoryId")).toList();
      onboarding.allowPaths(
          repositories.stream()
              .filter(repo -> removed.contains(repo.id()))
              .map(Repository::path)
              .toList());
    }
  }

  private static String now() {
    return Instant.now().toString();
  }

  private static long elapsed(long started) {
    return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
  }

  private static String reason(Exception error) {
    return error.getMessage() == null ? "Repository cleanup failed" : error.getMessage();
  }

  @Override
  public String ownerName() {
    return "Repository offboarding";
  }

  @Override
  public int shutdownOrder() {
    return 10;
  }

  @Override
  public void quiesce() {
    synchronized (this) {
      closing = true;
      executor.shutdown();
    }
    try {
      if (!executor.awaitTermination(60, TimeUnit.SECONDS))
        throw new IllegalStateException(
            "Repository offboarding is still finishing; source data has not been deleted");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Offboarding shutdown interrupted", error);
    }
  }
}
