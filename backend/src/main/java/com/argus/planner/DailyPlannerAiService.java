package com.argus.planner;

import com.argus.background.service.BackgroundJobService;
import com.argus.background.service.BackgroundOperationService;
import com.argus.common.process.OwnedProcess;
import com.argus.platform.NativeBackgroundOwner;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** Proposals are ephemeral previews; only the ordinary task endpoint can save them. */
@Service
public class DailyPlannerAiService implements NativeBackgroundOwner {
  interface Runner {
    List<Map<String, Object>> run(String prompt, String date, String provider, Control control)
        throws Exception;
  }

  static final class Control {
    interface Child {
      void pause();

      void resume();

      void stop(Duration graceful, Duration forced);

      void close();
    }

    private Child process;
    private boolean cancelled, paused, finished;

    void attach(OwnedProcess child) {
      attach(
          new Child() {
            public void pause() {
              child.pause();
            }

            public void resume() {
              child.resume();
            }

            public void stop(Duration graceful, Duration forced) {
              child.stop(graceful, forced);
            }

            public void close() {
              child.close();
            }
          });
    }

    synchronized void attach(Child child) {
      process = child;
      if (cancelled) child.close();
      else if (paused) child.pause();
    }

    synchronized void pause() {
      if (finished)
        throw new ResponseStatusException(
            HttpStatus.CONFLICT, "Task suggestions have already finished");
      if (process != null) process.pause();
      paused = true;
    }

    synchronized void resume() {
      if (finished)
        throw new ResponseStatusException(
            HttpStatus.CONFLICT, "Task suggestions have already finished");
      if (process != null) process.resume();
      paused = false;
      notifyAll();
    }

    synchronized void markCancelled() {
      if (finished)
        throw new ResponseStatusException(
            HttpStatus.CONFLICT, "Task suggestions have already finished");
      cancelled = true;
      notifyAll();
    }

    synchronized boolean cancelled() {
      return cancelled;
    }

    synchronized void checkpoint() throws InterruptedException {
      while (paused && !cancelled) wait();
      if (cancelled) throw new CancellationException("Task suggestion cancelled");
    }

    synchronized void started(BackgroundJobService jobs, String id) throws InterruptedException {
      checkpoint();
      // The control lock makes a pause between the operation checkpoint and this
      // update wait instead of overwriting its paused card with "running".
      synchronized (jobs) {
        var status = jobs.get(id).get("status");
        if (Set.of("paused", "cancelled").contains(status)) return;
        jobs.update(id, Map.of("status", "running", "startedAt", Instant.now().toString()));
      }
    }

    void stop() {
      Child child;
      synchronized (this) {
        if (finished && process == null) return;
        cancelled = true;
        notifyAll();
        child = process;
      }
      if (child != null) child.stop(Duration.ofMillis(300), Duration.ofSeconds(2));
    }

    synchronized void cleanup() {
      if (process != null) {
        process.close();
        // Keep the owned handle on failure so cancellation/quiescence can retry.
        process = null;
      }
    }
  }

  private static final class Proposal {
    final String id, provider;
    final Control control = new Control();
    final CompletableFuture<Void> done = new CompletableFuture<>();
    String status = "running", error = "";
    boolean cleanupRequired;
    List<Map<String, Object>> tasks = List.of();
    BackgroundOperationService.Operation operation;

    Proposal(String id, String provider) {
      this.id = id;
      this.provider = provider;
    }

    Map<String, Object> snapshot() {
      synchronized (control) {
        return Map.of(
            "id",
            id,
            "provider",
            provider,
            "status",
            control.cancelled()
                ? "cancelled"
                : !control.finished && control.paused ? "paused" : status,
            "tasks",
            tasks,
            "error",
            error,
            "cleanupRequired",
            cleanupRequired);
      }
    }
  }

  private final Runner runner;
  private final BackgroundJobService jobs;
  private final BackgroundOperationService operations;
  private final LinkedHashMap<String, Proposal> proposals = new LinkedHashMap<>();
  private final ExecutorService executor =
      Executors.newSingleThreadExecutor(
          task -> {
            Thread thread = new Thread(task, "argus-planner-ai");
            thread.setDaemon(true);
            return thread;
          });
  private Proposal active;
  private boolean stopping;

  @Autowired
  public DailyPlannerAiService(
      DailyPlannerAiRunner runner,
      BackgroundJobService jobs,
      BackgroundOperationService operations) {
    this((Runner) runner, jobs, operations);
  }

  DailyPlannerAiService(
      Runner runner, BackgroundJobService jobs, BackgroundOperationService operations) {
    this.runner = runner;
    this.jobs = jobs;
    this.operations = operations;
  }

  public synchronized Map<String, Object> start(Map<String, Object> input) {
    if (stopping)
      throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Argus is shutting down");
    if (active != null)
      throw new ResponseStatusException(
          HttpStatus.CONFLICT, "A task suggestion is already running. Finish or cancel it first.");
    String prompt = text(input.get("prompt")),
        date = text(input.get("date")),
        provider = text(input.get("provider"));
    if (prompt.isBlank() || prompt.length() > 16000)
      throw new IllegalArgumentException("Describe your tasks in 1–16,000 characters");
    if (!Set.of("codex", "claude").contains(provider))
      throw new IllegalArgumentException("Choose Codex or Claude");
    try {
      LocalDate.parse(date);
    } catch (RuntimeException error) {
      throw new IllegalArgumentException("Choose a valid task date");
    }
    String id =
        jobs.create(
                Map.of(
                    "type",
                    "daily-planner-ai",
                    "title",
                    "Daily task suggestions",
                    "message",
                    "Preparing editable task suggestions",
                    "total",
                    1))
            .get("id")
            .toString();
    var proposal = new Proposal(id, provider);
    proposal.operation =
        operations.register(
            id,
            proposal.control::pause,
            proposal.control::resume,
            proposal.control::markCancelled,
            proposal.control::stop);
    proposals.put(id, proposal);
    active = proposal;
    while (proposals.size() > 20) proposals.remove(proposals.keySet().iterator().next());
    try {
      executor.submit(() -> execute(proposal, prompt, date));
    } catch (RuntimeException error) {
      active = null;
      proposal.operation.close();
      proposals.remove(id);
      jobs.update(id, Map.of("status", "failed", "error", "Could not start task suggestions"));
      throw error;
    }
    return proposal.snapshot();
  }

  private void execute(Proposal proposal, String prompt, String date) {
    List<Map<String, Object>> tasks = List.of();
    Throwable failure = null;
    try {
      proposal.operation.checkpoint();
      proposal.control.started(jobs, proposal.id);
      tasks = runner.run(prompt, date, proposal.provider, proposal.control);
      proposal.operation.checkpoint();
    } catch (Throwable error) {
      failure = error;
      if (error instanceof InterruptedException) Thread.currentThread().interrupt();
    }
    try {
      proposal.control.cleanup();
      synchronized (proposal.control) {
        if (failure == null) {
          try {
            proposal.control.checkpoint();
          } catch (Exception error) {
            failure = error;
          }
        }
        if (proposal.control.cancelled() || proposal.operation.isCancelled()) {
          proposal.status = "cancelled";
          jobs.update(
              proposal.id, Map.of("status", "cancelled", "completedAt", Instant.now().toString()));
        } else if (failure == null) {
          proposal.tasks = List.copyOf(tasks);
          proposal.status = "completed";
          jobs.update(
              proposal.id,
              Map.of(
                  "status",
                  "completed",
                  "completed",
                  1,
                  "completedAt",
                  Instant.now().toString(),
                  "message",
                  "Task suggestions ready to review; no tasks added yet"));
        } else {
          proposal.status = "failed";
          proposal.error =
              failure instanceof IllegalArgumentException
                  ? failure.getMessage()
                  : "Could not create task suggestions. Check the selected AI connection and try again. You can still add tasks manually.";
          jobs.update(
              proposal.id,
              Map.of(
                  "status",
                  "failed",
                  "failed",
                  1,
                  "error",
                  proposal.error,
                  "completedAt",
                  Instant.now().toString()));
        }
        proposal.control.finished = true;
      }
      proposal.operation.close();
      synchronized (this) {
        if (active == proposal) active = null;
      }
      proposal.done.complete(null);
    } catch (Exception cleanupFailure) {
      synchronized (proposal.control) {
        proposal.status = "failed";
        proposal.cleanupRequired = true;
        proposal.tasks = List.of();
        proposal.error =
            "Task suggestions could not stop safely. Cancel this preview or quit Argus to retry cleanup before starting another.";
        proposal.done.completeExceptionally(cleanupFailure);
      }
      // Never release admission or the operation lease while a child might be alive.
    }
  }

  public synchronized Map<String, Object> get(String id) {
    return require(id).snapshot();
  }

  public Map<String, Object> cancel(String id) {
    Proposal proposal;
    synchronized (this) {
      proposal = require(id);
    }
    if (!proposal.done.isDone()) operations.cancel(id);
    else {
      synchronized (this) {
        if (active != proposal) return proposal.snapshot();
      }
      proposal.control.stop();
      proposal.control.cleanup();
      synchronized (proposal.control) {
        proposal.status = "cancelled";
        proposal.tasks = List.of();
        proposal.error = "";
        proposal.cleanupRequired = false;
        proposal.control.finished = true;
      }
      jobs.update(id, Map.of("status", "cancelled", "completedAt", Instant.now().toString()));
      proposal.operation.close();
      synchronized (this) {
        if (active == proposal) active = null;
      }
    }
    return proposal.snapshot();
  }

  private Proposal require(String id) {
    var proposal = proposals.get(id);
    if (proposal == null)
      throw new ResponseStatusException(
          HttpStatus.NOT_FOUND, "Task suggestion not found; create a new preview");
    return proposal;
  }

  private static String text(Object value) {
    return value instanceof String string ? string.trim() : "";
  }

  @Override
  public String ownerName() {
    return "daily-planner-ai";
  }

  @Override
  public int shutdownOrder() {
    return 30;
  }

  @Override
  public void quiesce() {
    Proposal proposal;
    synchronized (this) {
      stopping = true;
      proposal = active;
    }
    if (proposal != null) {
      proposal.operation.shutdown();
      proposal.control.stop();
      try {
        proposal.done.get(8, TimeUnit.SECONDS);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Interrupted while stopping task suggestions", error);
      } catch (ExecutionException error) {
        // The producer has exited, but its previous cleanup may have failed.
        // Retry against the still-owned handle before acknowledging quiescence.
        proposal.control.cleanup();
        synchronized (proposal.control) {
          proposal.status = "cancelled";
          proposal.tasks = List.of();
          proposal.cleanupRequired = false;
          proposal.control.finished = true;
        }
        jobs.update(
            proposal.id, Map.of("status", "cancelled", "completedAt", Instant.now().toString()));
        proposal.operation.close();
        synchronized (this) {
          if (active == proposal) active = null;
        }
      } catch (Exception error) {
        throw new IllegalStateException("Task suggestion did not stop safely", error);
      }
    }
    executor.shutdownNow();
  }
}
