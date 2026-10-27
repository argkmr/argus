package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import com.argus.common.error.ConflictException;
import com.argus.context.service.ContextService;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.service.PromptQueueService;
import com.argus.tasks.service.TaskActivityService;
import com.argus.tasks.service.TaskService;
import com.argus.workspace.service.WorkspaceService;
import jakarta.annotation.PreDestroy;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/** One durable queue claim, one native steer, then idempotent conversation persistence. */
@Service
public class AgentSteeringService {
  private final PromptQueueService queue;
  private final TaskService tasks;
  private final TaskActivityService activity;
  private final WorkspaceService workspace;
  private final ContextService contexts;
  private final AgentExecutionService agents;
  private final AgentPromptService prompts;
  private final ObjectMapper mapper;
  private final AtomicBoolean recoveryStarted = new AtomicBoolean();
  private final ScheduledExecutorService recovery =
      Executors.newSingleThreadScheduledExecutor(
          task -> {
            var thread = new Thread(task, "argus-steering-history-recovery");
            thread.setDaemon(true);
            return thread;
          });

  public AgentSteeringService(
      PromptQueueService queue,
      TaskService tasks,
      TaskActivityService activity,
      WorkspaceService workspace,
      ContextService contexts,
      AgentExecutionService agents,
      AgentPromptService prompts,
      ObjectMapper mapper) {
    this.queue = queue;
    this.tasks = tasks;
    this.activity = activity;
    this.workspace = workspace;
    this.contexts = contexts;
    this.agents = agents;
    this.prompts = prompts;
    this.mapper = mapper;
  }

  public Map<String, Object> steer(String id, Map<String, Object> input) {
    if (input == null) throw new IllegalArgumentException("The saved steering request is required");
    for (String key : List.of("taskId", "jobId", "expectedTurnId", "expectedPrompt"))
      if (!(input.get(key) instanceof String value) || value.isBlank())
        throw new IllegalArgumentException("Missing steering field: " + key);
    if (!input.containsKey("expectedPromptNotes"))
      throw new IllegalArgumentException("The saved prompt notes are required");

    String taskId = text(input.get("taskId"));
    var task = tasks.get(taskId);
    var saved = queue.get(id);
    if (!taskId.equals(saved.get("taskId")) || !queue.matchesSteeringContent(saved, input))
      throw new ConflictException("The queued prompt changed; reload it before steering");

    // An acknowledged receipt remains valid after the turn finishes or Argus restarts.
    if ("started".equals(saved.get("status")) && "steer".equals(saved.get("delivery"))) {
      if (!Objects.equals(saved.get("jobId"), input.get("jobId"))
          || !Objects.equals(saved.get("turnId"), input.get("expectedTurnId")))
        throw new ConflictException("This prompt was already steered into a different turn");
      return finish(saved);
    }
    long epoch = activity.queueEpoch(taskId);
    var job = agents.get(text(input.get("jobId")));
    requireCompatible(saved, job, input);
    if (!Objects.equals(task.scope, saved.get("scope"))
        || !Objects.equals(task.repositoryId, saved.get("repositoryId")))
      throw new ConflictException("The saved prompt belongs to a different repository scope");

    var connected =
        workspace.snapshot().repositories().stream().map(repository -> repository.id()).toList();
    var repositories = ids(job.get("repositoryIds"));
    if (repositories.isEmpty() || !connected.containsAll(repositories))
      throw new ConflictException(
          "An original repository is disconnected; the prompt remains queued");
    var attachmentIds = ids(saved.get("attachmentIds"));
    if (attachmentIds.size() > 10) throw new IllegalArgumentException("Too many saved attachments");
    List<Map<String, Object>> attachments = new ArrayList<>();
    for (String attachmentId : attachmentIds)
      attachments.add(mapper.convertValue(contexts.get(attachmentId), Map.class));
    String prompt = prompts.steering(saved, attachments);
    var claimed =
        activity.acceptQueuedPrompt(
            taskId, epoch, () -> queue.claimSteer(id, queue.fingerprint(saved), input));
    Object token = claimed.get("dispatchToken");
    Map<String, Object> ack;
    try {
      ack = agents.steer(text(input.get("jobId")), text(input.get("expectedTurnId")), prompt);
    } catch (SteerDeliveryException failure) {
      if (failure.outcomeUnknown()) {
        uncertain(id, token, failure);
        throw new ConflictException(
            "Steering delivery could not be confirmed. It may already be in the running turn; the saved prompt is paused to prevent duplicate delivery. Check the response before resending.");
      }
      queue.releaseSteer(id, token);
      throw new ConflictException(failure.getMessage());
    } catch (RuntimeException failure) {
      uncertain(id, token, failure);
      throw new ConflictException(
          "Steering delivery could not be confirmed. Check the current response; this prompt will not be sent automatically.");
    }

    Map<String, Object> receipt;
    try {
      if (!Boolean.TRUE.equals(ack.get("accepted")))
        throw new IllegalStateException("The provider did not acknowledge steering");
      receipt = queue.acceptSteer(id, token, ack);
    } catch (RuntimeException failure) {
      uncertain(id, token, failure);
      throw new ConflictException(
          "The running turn may have received this prompt, but its receipt could not be saved. It will not be resent automatically. Check the response before retrying.");
    }
    // If history persistence fails, leave the accepted receipt intact. A retry repairs history
    // only.
    return finish(receipt);
  }

  /** Recovery only: this method cannot send anything to a provider. */
  public Map<String, Object> reconcile(String id, Map<String, Object> input) {
    if (input == null || text(input.get("taskId")).isBlank())
      throw new IllegalArgumentException("The saved steering request is required");
    String taskId = text(input.get("taskId"));
    var task = tasks.get(taskId);
    var saved = queue.get(id);
    if (!taskId.equals(saved.get("taskId"))
        || !input.containsKey("expectedPromptNotes")
        || !queue.matchesSteeringContent(saved, input))
      throw new ConflictException("The saved steering request changed; refresh this chat");
    if ("started".equals(saved.get("status")) && "steer".equals(saved.get("delivery"))) {
      if (!Objects.equals(saved.get("jobId"), input.get("jobId"))
          || !Objects.equals(saved.get("turnId"), input.get("expectedTurnId")))
        throw new ConflictException("This receipt belongs to a different running turn");
      return finish(saved);
    }
    return fields("accepted", false, "task", task, "queue", queue.list(taskId));
  }

  private Map<String, Object> finish(Map<String, Object> receipt) {
    String taskId = text(receipt.get("taskId"));
    var updated = recordHistory(receipt);
    return fields(
        "accepted",
        true,
        "requestId",
        receipt.get("requestId"),
        "jobId",
        receipt.get("jobId"),
        "turnId",
        receipt.get("turnId"),
        "task",
        updated,
        "queue",
        queue.list(taskId));
  }

  private AiTask recordHistory(Map<String, Object> receipt) {
    if (Boolean.TRUE.equals(receipt.get("historyRecorded")))
      return tasks.get(text(receipt.get("taskId")));
    var updated = tasks.appendSteeredUser(text(receipt.get("taskId")), receipt, receipt);
    if (!Boolean.TRUE.equals(receipt.get("historyRecorded")))
      queue.steeringHistoryRecorded(text(receipt.get("requestId")));
    return updated;
  }

  @EventListener(ApplicationReadyEvent.class)
  public void startRecovery() {
    if (recoveryStarted.compareAndSet(false, true))
      recovery.scheduleWithFixedDelay(this::recoverAccepted, 0, 10, TimeUnit.SECONDS);
  }

  /** Complete the durable ack-to-history transaction after a crash; never re-send native input. */
  public void recoverAccepted() {
    List<Map<String, Object>> receipts;
    try {
      receipts = queue.pendingSteeringReceipts();
    } catch (RuntimeException unavailable) {
      return;
    }
    for (var receipt : receipts) {
      if (Thread.currentThread().isInterrupted()) return;
      try {
        recordHistory(receipt);
      } catch (RuntimeException unavailable) {
        /* Keep the receipt intact for the next repair. */
      }
    }
  }

  @PreDestroy
  public void close() {
    recovery.shutdownNow();
  }

  private void uncertain(String id, Object token, RuntimeException failure) {
    try {
      queue.interrupted(
          id, "Steering delivery is uncertain; check the running response before resending", token);
    } catch (RuntimeException journalFailure) {
      failure.addSuppressed(journalFailure);
      // The pre-send dispatching record is already durable and is interrupted on restart.
    }
  }

  private static void requireCompatible(
      Map<String, Object> saved, Map<String, Object> job, Map<String, Object> input) {
    if (!Objects.equals(saved.get("taskId"), job.get("taskId"))
        || !Objects.equals(input.get("jobId"), job.get("id"))
        || !Objects.equals(input.get("expectedTurnId"), job.get("nativeTurnId")))
      throw new ConflictException("The running turn changed; refresh the chat before steering");
    if (!Boolean.TRUE.equals(obj(job.get("steering")).get("available")))
      throw new ConflictException(
          "This running provider cannot accept steering now; the prompt remains queued");
    if (!Objects.equals(saved.get("scope"), job.get("scope"))
        || !Objects.equals(saved.get("repositoryId"), job.get("repositoryId"))
        || !Objects.equals(saved.get("providerId"), job.get("provider"))
        || !Objects.equals(saved.get("mode"), job.get("mode")))
      throw new ConflictException(
          "Steering must use the running turn's provider, mode and repository scope");
    if ("global".equals(saved.get("scope"))
        && !new HashSet<>(ids(saved.get("repositoryIds")))
            .equals(new HashSet<>(ids(job.get("repositoryIds")))))
      throw new ConflictException("Steering cannot change the running turn's repository selection");
    var settings = obj(saved.get("modelSettings"));
    for (String key : List.of("model", "effort", "speed"))
      if (!text(settings.get(key)).isBlank() && !Objects.equals(settings.get(key), job.get(key)))
        throw new ConflictException(
            "Steering cannot change the running turn's "
                + key
                + "; keep this prompt queued or use matching settings");
  }

  private static List<String> ids(Object value) {
    if (!(value instanceof List<?> list)
        || list.stream().anyMatch(id -> !(id instanceof String) || ((String) id).isBlank()))
      throw new IllegalArgumentException("Invalid saved repository or attachment IDs");
    return list.stream().map(Object::toString).toList();
  }
}
