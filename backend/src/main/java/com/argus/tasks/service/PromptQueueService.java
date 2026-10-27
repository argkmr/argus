package com.argus.tasks.service;

import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.repository.PromptQueueRepository;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

@Service
public class PromptQueueService {
  private static final List<String> FIELDS =
      List.of(
          "taskId",
          "scope",
          "repositoryId",
          "repositoryIds",
          "providerId",
          "mode",
          "modelSettings",
          "contextMode",
          "prompt",
          "attachmentIds",
          "promptNotes");
  private final PromptQueueRepository queue;
  private final ObjectMapper mapper;

  public PromptQueueService(PromptQueueRepository queue, ObjectMapper mapper) {
    this.queue = queue;
    this.mapper = mapper;
  }

  public List<Map<String, Object>> list(String taskId) {
    return queue.list().stream()
        .filter(
            item ->
                (taskId == null || taskId.isEmpty() || taskId.equals(item.get("taskId")))
                    && !"started".equals(item.get("status")))
        .toList();
  }

  public Map<String, Object> enqueue(
      AiTask task, Map<String, Object> request, List<Map<String, Object>> attachments) {
    var input = new LinkedHashMap<>(request);
    input.put("scope", task.scope);
    input.putIfAbsent("repositoryIds", List.of());
    input.put("promptNotes", PromptNotes.resolve(input, task.promptNotes));
    return queue.mutate(
        items -> {
          if (!(input.get("requestId") instanceof String id) || !id.matches("[A-Za-z0-9_-]{1,100}"))
            throw new IllegalArgumentException("Invalid queued request ID");
          TaskService.requirePrompt(input.get("prompt"));
          if (!task.id.equals(input.get("taskId"))
              || !task.repositoryId.equals(input.get("repositoryId")))
            throw new IllegalArgumentException("Queued request belongs to a different chat");
          for (var prior : items)
            if (id.equals(prior.get("requestId"))) {
              if (!request.containsKey("promptNotes")) {
                if (prior.containsKey("promptNotes"))
                  input.put(
                      "promptNotes",
                      prior.getOrDefault("enqueuePromptNotes", prior.get("promptNotes")));
                else input.remove("promptNotes");
              } else if (!prior.containsKey("promptNotes")
                  && PromptNotes.normalize(input.get("promptNotes")).isEmpty())
                input.remove("promptNotes");
              if (!enqueueFingerprint(prior).equals(fingerprint(input)))
                throw new ConflictException("Queued request ID already used for different content");
              if (prior.containsKey("receiptFingerprint")) {
                var receipt = new LinkedHashMap<>(input);
                receipt.putAll(prior);
                receipt.put("attachments", attachments);
                return receipt;
              }
              return prior;
            }
          if (items.stream().filter(item -> !"started".equals(item.get("status"))).count() >= 100)
            throw new ConflictException(
                "The saved prompt queue is full. Complete or discard queued requests first.");
          var item = new LinkedHashMap<String, Object>();
          for (String key : FIELDS) item.put(key, input.get(key));
          item.put("requestId", id);
          item.put("scope", task.scope);
          item.put(
              "providerName",
              input.getOrDefault("providerName", input.getOrDefault("providerId", "AI provider")));
          item.put("createdAt", Instant.now().toString());
          item.put("attachments", attachments);
          item.put("status", "queued");
          items.add(item);
          return item;
        });
  }

  public Map<String, Object> edit(String id, Map<String, Object> input) {
    if (input == null || !(input.get("taskId") instanceof String taskId) || taskId.isBlank())
      throw new IllegalArgumentException("The queued request chat is required");
    if (!(input.get("expectedPrompt") instanceof String))
      throw new IllegalArgumentException("The original queued prompt is required");
    TaskService.requirePrompt(input.get("prompt"));
    var notes =
        input.containsKey("promptNotes") ? PromptNotes.normalize(input.get("promptNotes")) : null;
    if (notes != null && !input.containsKey("expectedPromptNotes"))
      throw new IllegalArgumentException("The original queued prompt notes are required");
    return queue.mutate(
        items -> {
          var item = require(items, id);
          if (!taskId.equals(item.get("taskId")))
            throw new ConflictException("The queued request belongs to a different chat");
          if (!"queued".equals(item.get("status")))
            throw new ConflictException(
                "This request is no longer waiting in the queue; refresh the chat before editing");
          if (!Objects.equals(item.get("prompt"), input.get("expectedPrompt")))
            throw new ConflictException("The queued prompt changed; reload it before editing");
          if (notes != null
              && !PromptNotes.normalize(item.getOrDefault("promptNotes", List.of()))
                  .equals(PromptNotes.normalize(input.get("expectedPromptNotes"))))
            throw new ConflictException(
                "The queued prompt notes changed; reload them before editing");
          // Retries of the original enqueue remain idempotent after text edits.
          // Dispatch still fingerprints the current prompt and frozen settings.
          item.putIfAbsent("enqueueFingerprint", enqueueFingerprint(item));
          if (notes != null)
            item.putIfAbsent("enqueuePromptNotes", item.getOrDefault("promptNotes", List.of()));
          item.put("prompt", input.get("prompt"));
          if (notes != null) item.put("promptNotes", notes);
          item.put("updatedAt", Instant.now().toString());
          return item;
        });
  }

  public Map<String, Object> claim(String id) {
    return queue.mutate(
        items -> {
          var item = require(items, id);
          requireUnpaused(item);
          if (!"queued".equals(item.get("status")))
            throw new ConflictException(
                "This request was already claimed. Check its chat before resending.");
          var first =
              items.stream()
                  .filter(
                      entry ->
                          Objects.equals(entry.get("taskId"), item.get("taskId"))
                              && !"started".equals(entry.get("status")))
                  .findFirst();
          if (first.isEmpty() || !id.equals(first.get().get("requestId")))
            throw new ConflictException(
                "An earlier saved request must be completed or removed before this one can start");
          item.put("status", "dispatching");
          item.put("dispatchToken", UUID.randomUUID().toString());
          item.put("attempted", false);
          return item;
        });
  }

  public Map<String, Object> begin(String id, Object token, Map<String, Object> input) {
    return queue.mutate(
        items -> {
          var item = require(items, id);
          requireUnpaused(item);
          if (!"dispatching".equals(item.get("status"))
              || Boolean.TRUE.equals(item.get("attempted"))
              || !(token instanceof String)
              || !token.equals(item.get("dispatchToken")))
            throw new ConflictException(
                "This queued request cannot be dispatched again. Check the existing chat.");
          if (!id.equals(input.get("requestId")))
            throw new IllegalArgumentException("The queued request ID changed");
          var normalized = new LinkedHashMap<>(input);
          boolean global = "global".equals(input.get("scope"));
          normalized.put("scope", global ? "global" : "repository");
          normalized.put("providerId", input.get("provider"));
          normalized.put("repositoryId", global ? "global" : input.get("repositoryId"));
          normalized.put("repositoryIds", input.getOrDefault("repositoryIds", List.of()));
          var settings = new LinkedHashMap<String, Object>();
          for (String key : List.of("model", "effort", "speed")) settings.put(key, input.get(key));
          normalized.put("modelSettings", settings);
          // Older queues had no notes. Never attach today's task defaults to already queued work.
          if (item.containsKey("promptNotes"))
            normalized.put("promptNotes", PromptNotes.resolve(input, item.get("promptNotes")));
          else {
            if (input.containsKey("promptNotes")
                && !PromptNotes.normalize(input.get("promptNotes")).isEmpty())
              throw new IllegalArgumentException(
                  "The queued prompt notes changed; it was not started");
            normalized.remove("promptNotes");
          }
          if (!fingerprint(item).equals(fingerprint(normalized)))
            throw new IllegalArgumentException(
                "The queued request settings changed; it was not started");
          item.put("attempted", true);
          input.put(
              "promptNotes", PromptNotes.normalize(item.getOrDefault("promptNotes", List.of())));
          return item;
        });
  }

  public Map<String, Object> started(String id, String jobId) {
    return queue.mutate(
        items -> {
          var item = require(items, id);
          item.put("status", "started");
          item.put("jobId", jobId);
          return item;
        });
  }

  /** Includes delivery receipts, so a lost HTTP reply can be recovered without resending. */
  public Map<String, Object> get(String id) {
    return require(queue.list(), id);
  }

  public Map<String, Object> claimSteer(
      String id, String expectedFingerprint, Map<String, Object> request) {
    return queue.mutate(
        items -> {
          var item = require(items, id);
          requireUnpaused(item);
          if (!"queued".equals(item.get("status")))
            throw new ConflictException(
                "This prompt has already been dispatched; refresh the chat");
          if (!Objects.equals(item.get("taskId"), request.get("taskId"))
              || !Objects.equals(item.get("prompt"), request.get("expectedPrompt"))
              || !PromptNotes.normalize(item.getOrDefault("promptNotes", List.of()))
                  .equals(PromptNotes.normalize(request.get("expectedPromptNotes")))
              || !fingerprint(item).equals(expectedFingerprint))
            throw new ConflictException("The queued prompt changed; reload it before steering");
          item.put("status", "dispatching");
          item.put("delivery", "steer");
          item.put("jobId", request.get("jobId"));
          item.put("turnId", request.get("expectedTurnId"));
          item.put("dispatchToken", UUID.randomUUID().toString());
          // Persist BEFORE the RPC. A crash here must never cause automatic replay.
          item.put("attempted", true);
          return item;
        });
  }

  public Map<String, Object> acceptSteer(String id, Object token, Map<String, Object> ack) {
    return queue.mutate(
        items -> {
          var item = require(items, id);
          requireSteerClaim(item, token);
          if (!Objects.equals(item.get("turnId"), ack.get("turnId")))
            throw new ConflictException("The provider acknowledged a different running turn");
          item.put("status", "started");
          String acceptedAt = Objects.toString(ack.get("acceptedAt"), Instant.now().toString());
          Instant.parse(acceptedAt);
          item.put("acceptedAt", acceptedAt);
          item.put("threadId", ack.get("threadId"));
          item.put("historyRecorded", false);
          return item;
        });
  }

  public List<Map<String, Object>> pendingSteeringReceipts() {
    return queue.list().stream()
        .filter(
            item ->
                "started".equals(item.get("status"))
                    && "steer".equals(item.get("delivery"))
                    && !Boolean.TRUE.equals(item.get("historyRecorded")))
        .toList();
  }

  public void steeringHistoryRecorded(String id) {
    queue.mutate(
        items -> {
          var item = require(items, id);
          if (!"started".equals(item.get("status")) || !"steer".equals(item.get("delivery")))
            throw new ConflictException("There is no accepted steering receipt for this prompt");
          if (Boolean.TRUE.equals(item.get("historyRecorded"))) return true;
          item.put(
              "steeringPayloadFingerprint",
              steeringPayloadFingerprint(
                  item.get("prompt"), item.getOrDefault("promptNotes", List.of())));
          item.put("receiptFingerprint", enqueueFingerprint(item));
          item.put("historyRecorded", true);
          // The canonical task now owns the content. Keep a bounded anti-replay receipt,
          // not a second permanent copy of every large prompt and attachment manifest.
          for (String key : List.of("prompt", "attachments", "attachmentIds", "dispatchToken"))
            item.remove(key);
          var receipts =
              items.stream()
                  .filter(
                      entry ->
                          "started".equals(entry.get("status"))
                              && entry.containsKey("receiptFingerprint")
                              && (!"steer".equals(entry.get("delivery"))
                                  || Boolean.TRUE.equals(entry.get("historyRecorded"))))
                  .toList();
          if (receipts.size() > 1000) items.removeAll(receipts.subList(0, receipts.size() - 1000));
          return true;
        });
  }

  public boolean matchesSteeringContent(Map<String, Object> saved, Map<String, Object> input) {
    if (saved.containsKey("steeringPayloadFingerprint"))
      return Objects.equals(
          saved.get("steeringPayloadFingerprint"),
          steeringPayloadFingerprint(
              input.get("expectedPrompt"), input.get("expectedPromptNotes")));
    return Objects.equals(saved.get("prompt"), input.get("expectedPrompt"))
        && PromptNotes.normalize(saved.getOrDefault("promptNotes", List.of()))
            .equals(PromptNotes.normalize(input.get("expectedPromptNotes")));
  }

  private String steeringPayloadFingerprint(Object prompt, Object notes) {
    TaskService.requirePrompt(prompt);
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(
                      mapper
                          .writeValueAsString(List.of(prompt, PromptNotes.normalize(notes)))
                          .getBytes(StandardCharsets.UTF_8)));
    } catch (java.security.NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  /** Only a definitive provider rejection permits this prompt to return to the queue. */
  public void releaseSteer(String id, Object token) {
    queue.mutate(
        items -> {
          var item = require(items, id);
          requireSteerClaim(item, token);
          item.put("status", "queued");
          for (String key : List.of("delivery", "jobId", "turnId", "dispatchToken", "attempted"))
            item.remove(key);
          return true;
        });
  }

  private static void requireSteerClaim(Map<String, Object> item, Object token) {
    if (!"dispatching".equals(item.get("status"))
        || !"steer".equals(item.get("delivery"))
        || token == null
        || !token.equals(item.get("dispatchToken")))
      throw new ConflictException("This steering attempt no longer owns the saved prompt");
  }

  /** Persist the cancellation hold before the owning chat's running response is stopped. */
  public List<Map<String, Object>> pauseTask(String taskId, String questionId) {
    requireTaskId(taskId);
    if (questionId == null || questionId.isBlank())
      throw new IllegalArgumentException("The cancelled question is required");
    return queue.mutate(
        items -> {
          String pausedAt = Instant.now().toString();
          for (var item : items) {
            if (!taskId.equals(item.get("taskId")) || "started".equals(item.get("status")))
              continue;
            // A claim is not an execution attempt. The caller holds the task admission barrier,
            // and begin also requires that task's lease, so this token can safely be retired.
            // Never reset attempted or interrupted work: its provider may already have started.
            if ("dispatching".equals(item.get("status"))
                && Boolean.FALSE.equals(item.get("attempted"))) {
              item.put("status", "queued");
              item.remove("dispatchToken");
            }
            if (!"question-cancelled".equals(item.get("pauseReason"))
                || !questionId.equals(item.get("pausedQuestionId"))) item.put("pausedAt", pausedAt);
            item.put("pauseReason", "question-cancelled");
            item.put("pausedQuestionId", questionId);
          }
          return pendingForTask(items, taskId);
        });
  }

  /** Only a deliberate user resume may release queued, not-yet-attempted cancelled requests. */
  public List<Map<String, Object>> resumeTask(String taskId) {
    requireTaskId(taskId);
    return queue.mutate(
        items -> {
          for (var item : items) {
            if (!taskId.equals(item.get("taskId"))
                || !("queued".equals(item.get("status"))
                    || "dispatching".equals(item.get("status"))
                        && Boolean.FALSE.equals(item.get("attempted")))
                || Boolean.TRUE.equals(item.get("attempted"))
                || !("question-cancelled".equals(item.get("pauseReason"))
                    || "repository-disconnected".equals(item.get("pauseReason")))) continue;
            if ("dispatching".equals(item.get("status"))) {
              item.put("status", "queued");
              item.remove("dispatchToken");
            }
            item.remove("pauseReason");
            item.remove("pausedQuestionId");
            item.remove("pausedAt");
          }
          return pendingForTask(items, taskId);
        });
  }

  public Map<String, Object> interrupted(String id, Object error, Object token) {
    return queue.mutate(
        items -> {
          var item = require(items, id);
          if ("started".equals(item.get("status"))) return item;
          if (!(token instanceof String)
              || !token.equals(item.get("dispatchToken"))
              || !Set.of("dispatching", "interrupted").contains(item.get("status")))
            throw new ConflictException(
                "Only the client that claimed this queued request can report an interruption");
          item.put("status", "interrupted");
          String message =
              error instanceof Throwable failure
                  ? Objects.toString(failure.getMessage(), "Dispatch interrupted")
                  : Objects.toString(error, "Dispatch interrupted");
          item.put("error", message.substring(0, Math.min(message.length(), 1000)));
          return item;
        });
  }

  public Map<String, Object> remove(String id) {
    return queue.mutate(
        items -> {
          var item =
              items.stream()
                  .filter(entry -> id.equals(entry.get("requestId")))
                  .findFirst()
                  .orElse(null);
          if (item != null && "dispatching".equals(item.get("status")))
            throw new ConflictException(
                "The queued request is being dispatched; wait for its result first");
          if (item != null && "started".equals(item.get("status"))) {
            // Keep the accepted payload for idempotent history recovery after a lost reply.
            if ("steer".equals(item.get("delivery"))) return Map.of("ok", (Object) true);
            var receipt = new LinkedHashMap<String, Object>();
            for (String key :
                List.of(
                    "requestId",
                    "taskId",
                    "scope",
                    "repositoryId",
                    "repositoryIds",
                    "status",
                    "jobId")) receipt.put(key, item.get(key));
            receipt.put("receiptFingerprint", enqueueFingerprint(item));
            if (item.containsKey("promptNotes"))
              receipt.put("promptNotes", item.get("promptNotes"));
            if (item.containsKey("enqueuePromptNotes"))
              receipt.put("enqueuePromptNotes", item.get("enqueuePromptNotes"));
            items.set(items.indexOf(item), receipt);
            var receipts =
                items.stream()
                    .filter(
                        entry ->
                            "started".equals(entry.get("status"))
                                && entry.containsKey("receiptFingerprint"))
                    .toList();
            if (receipts.size() > 1000)
              items.removeAll(receipts.subList(0, receipts.size() - 1000));
          } else items.removeIf(entry -> id.equals(entry.get("requestId")));
          return Map.of("ok", (Object) true);
        });
  }

  public void purgeTasks(List<String> ids) {
    queue.mutate(
        items -> {
          items.removeIf(item -> ids.contains(item.get("taskId")));
          return true;
        });
  }

  public void purgeRepositories(List<String> ids) {
    queue.mutate(
        items -> {
          items.removeIf(
              item ->
                  ids.contains(item.get("repositoryId"))
                      || item.get("repositoryIds") instanceof List<?> selected
                          && selected.stream().anyMatch(ids::contains));
          return true;
        });
  }

  /** Retain unsent prompts and their attachments, but require an explicit resume. */
  public void pauseRepositories(List<String> ids) {
    queue.mutate(
        items -> {
          for (var item : items)
            if (!"started".equals(item.get("status"))
                && (ids.contains(item.get("repositoryId"))
                    || item.get("repositoryIds") instanceof List<?> selected
                        && selected.stream().anyMatch(ids::contains))
                && !item.containsKey("pauseReason")) {
              item.put("pauseReason", "repository-disconnected");
              item.put("pausedAt", Instant.now().toString());
            }
          return true;
        });
  }

  private static Map<String, Object> require(List<Map<String, Object>> items, String id) {
    return items.stream()
        .filter(item -> id.equals(item.get("requestId")))
        .findFirst()
        .orElseThrow(() -> new NotFoundException("Queued request not found"));
  }

  private static List<Map<String, Object>> pendingForTask(
      List<Map<String, Object>> items, String taskId) {
    return items.stream()
        .filter(item -> taskId.equals(item.get("taskId")) && !"started".equals(item.get("status")))
        .toList();
  }

  private static void requireTaskId(String taskId) {
    if (taskId == null || taskId.isBlank())
      throw new IllegalArgumentException("The queued request chat is required");
  }

  private static void requireUnpaused(Map<String, Object> item) {
    if (item.get("pauseReason") instanceof String reason && !reason.isBlank())
      throw new ConflictException(
          "This saved queue is paused. Resume it explicitly before starting another queued request.");
  }

  private String enqueueFingerprint(Map<String, Object> item) {
    return Objects.toString(
        item.getOrDefault(
            "receiptFingerprint", item.getOrDefault("enqueueFingerprint", fingerprint(item))));
  }

  public String fingerprint(Map<String, Object> request) {
    try {
      var values = new ArrayList<Object>();
      for (String key : FIELDS)
        // No notes is identical to legacy requests that predate this field. Preserve their
        // receipt identity instead of making an empty snapshot a different execution request.
        if ("promptNotes".equals(key)
            && (!request.containsKey(key) || PromptNotes.normalize(request.get(key)).isEmpty()))
          continue;
        else if ("modelSettings".equals(key)) {
          var settings = TaskService.map(request.get(key));
          values.add(
              Arrays.asList(settings.get("model"), settings.get("effort"), settings.get("speed")));
        } else values.add(request.get(key));
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(mapper.writeValueAsString(values).getBytes(StandardCharsets.UTF_8)));
    } catch (java.security.NoSuchAlgorithmException error) {
      throw new IllegalStateException(error);
    }
  }
}
