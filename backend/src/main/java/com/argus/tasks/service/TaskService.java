package com.argus.tasks.service;

import com.argus.agents.service.AgentQuestion;
import com.argus.agents.service.AgentQuestionCancellation;
import com.argus.agents.service.RepositoryScopeService;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskHistory;
import com.argus.tasks.domain.TaskMessage;
import com.argus.tasks.dto.CreateTaskRequest;
import com.argus.tasks.dto.TaskSummary;
import com.argus.tasks.repository.TaskRepository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

@Service
public class TaskService {
  private final TaskRepository tasks;
  private final TaskActivityService activity;
  private final ObjectMapper mapper;
  private final PromptQueueService queue;
  private final WorkspaceService workspace;
  private final RepositoryScopeService scopes;

  public TaskService(TaskRepository tasks) {
    this(tasks, new TaskActivityService(), new ObjectMapper());
  }

  public TaskService(TaskRepository tasks, TaskActivityService activity, ObjectMapper mapper) {
    this(tasks, activity, mapper, null);
  }

  public TaskService(
      TaskRepository tasks,
      TaskActivityService activity,
      ObjectMapper mapper,
      PromptQueueService queue) {
    this(tasks, activity, mapper, queue, null, new RepositoryScopeService());
  }

  @Autowired
  public TaskService(
      TaskRepository tasks,
      TaskActivityService activity,
      ObjectMapper mapper,
      PromptQueueService queue,
      WorkspaceService workspace,
      RepositoryScopeService scopes) {
    this.tasks = tasks;
    this.activity = activity;
    this.mapper = mapper;
    this.queue = queue;
    this.workspace = workspace;
    this.scopes = scopes;
  }

  public List<TaskSummary> list(String scope, String repositoryId) {
    return tasks.list().stream()
        .filter(item -> item.messageCount() > 0 || item.revisionOf() != null)
        .filter(item -> scope == null || scope.isBlank() || scope.equals(item.scope()))
        .filter(
            item ->
                repositoryId == null
                    || repositoryId.isBlank()
                    || repositoryId.equals(item.repositoryId()))
        .sorted(Comparator.comparing(TaskSummary::updatedAt).reversed())
        .toList();
  }

  public AiTask get(String id) {
    AiTask task = tasks.get(id);
    if (Boolean.TRUE.equals(map(task.additionalProperties().get("revisionOf")).get("pending")))
      return task;
    var question = AgentQuestion.latest(task, mapper);
    if (!question.isEmpty())
      task.messages.get(task.messages.size() - 1).additionalProperties().put("question", question);
    return task;
  }

  public AiTask create(CreateTaskRequest request) {
    return create(request, List.of());
  }

  private AiTask create(CreateTaskRequest request, List<Map<String, Object>> promptNotes) {
    String now = Instant.now().toString();
    AiTask task = new AiTask();
    task.id = UUID.randomUUID().toString();
    task.scope = value(request.scope(), "repository");
    task.repositoryId = "global".equals(task.scope) ? "global" : value(request.repositoryId(), "");
    task.repositoryIds =
        request.repositoryIds() == null
            ? new ArrayList<>()
            : new ArrayList<>(request.repositoryIds());
    task.title = truncate(value(request.title(), "New task").replaceAll("\\s+", " ").trim(), 20);
    task.provider = value(request.provider(), "codex");
    task.mode = value(request.mode(), "edit");
    task.model = value(request.model(), "");
    task.effort = value(request.effort(), "auto");
    task.speed = value(request.speed(), "standard");
    task.createdAt = now;
    task.updatedAt = now;
    task.promptNotes = promptNotes;
    task.additionalProperties().put("contextMode", "fresh");
    task.additionalProperties().put("cliSessions", new LinkedHashMap<>());
    return tasks.save(task);
  }

  /**
   * Finalize a question cancellation while the caller owns the task activity barrier. A nonempty
   * expectedJobId is server-selected only after validating and draining that exact live question.
   */
  public AiTask cancelQuestion(
      String taskId, String requestId, String questionId, String expectedJobId) {
    var request =
        AgentQuestionCancellation.request(
            Map.of("taskId", taskId, "requestId", requestId, "questionId", questionId));
    var current = tasks.get(taskId);
    if (!AgentQuestionCancellation.receipt(current, request).isEmpty()) return current;
    return tasks.mutate(
        taskId,
        task -> {
          if (!AgentQuestionCancellation.receipt(task, request).isEmpty()) return;
          if (task.messages.isEmpty())
            throw new ConflictException("This question is no longer awaiting a reply");
          var message = task.messages.get(task.messages.size() - 1);
          var question = AgentQuestion.forMessage(message, mapper);
          String actualJobId = Objects.toString(map(message.execution).get("jobId"), "");
          boolean drainedQuestion =
              expectedJobId != null
                  && !expectedJobId.isBlank()
                  && expectedJobId.equals(actualJobId)
                  && questionId.startsWith(expectedJobId + ":question-")
                  && Set.of("completed", "cancelled", "failed")
                      .contains(Objects.toString(message.status, ""));
          if (!"assistant".equals(message.role)
              || (!Objects.equals(questionId, question.get("id")) && !drainedQuestion))
            throw new ConflictException(
                "This question is no longer awaiting a reply. Refresh the original chat.");
          var cancellation = new LinkedHashMap<String, Object>(request);
          cancellation.put("status", "cancelled");
          cancellation.put("cancelledAt", Instant.now().toString());
          if (!actualJobId.isBlank()) cancellation.put("jobId", actualJobId);
          message.additionalProperties().put("questionCancellation", cancellation);
          task.additionalProperties()
              .put("questionCancellation", new LinkedHashMap<>(cancellation));
        });
  }

  public AiTask create(Map<String, Object> input) {
    var notes =
        PromptNotes.normalize(
            input.getOrDefault("taskPromptNotes", input.getOrDefault("promptNotes", List.of())));
    var creation = new LinkedHashMap<String, Object>();
    for (String key :
        List.of(
            "scope",
            "repositoryId",
            "repositoryIds",
            "title",
            "provider",
            "mode",
            "model",
            "effort",
            "speed")) if (input.containsKey(key)) creation.put(key, input.get(key));
    AiTask task = create(mapper.convertValue(creation, CreateTaskRequest.class), notes);
    if ("history".equals(input.get("contextMode")))
      task =
          tasks.mutate(task.id, item -> item.additionalProperties().put("contextMode", "history"));
    return task;
  }

  public AiTask rename(String id, String title) {
    String value = title == null ? "" : title.replaceAll("\\s+", " ").trim();
    if (value.isBlank()) throw new IllegalArgumentException("Task name is required");
    return tasks.mutate(id, task -> task.title = truncate(value, 20));
  }

  public AiTask updatePromptNotes(String id, Map<String, Object> input) {
    var notes = PromptNotes.normalize(input.get("promptNotes"));
    return tasks.mutate(
        id,
        task -> {
          if ((input.containsKey("scope") && !Objects.equals(task.scope, input.get("scope")))
              || (input.containsKey("repositoryId")
                  && !Objects.equals(task.repositoryId, input.get("repositoryId"))))
            throw new IllegalArgumentException("Prompt notes belong to a different chat");
          task.promptNotes = notes;
        });
  }

  public void remove(String id) {
    try (var reservation = activity.reserve(id)) {
      tasks.delete(tasks.get(id));
    }
  }

  public Map<String, Object> revise(String id, Map<String, Object> input) {
    if (com.argus.codediscussions.service.CodeDiscussionData.owns(tasks.get(id)))
      throw new ConflictException(
          "Code discussions keep their anchored history. Select code → Ask AI to ask a follow-up instead.");
    requirePrompt(input.get("prompt"));
    if (!(input.get("messageId") instanceof String messageId)
        || messageId.isEmpty()
        || messageId.length() > 200)
      throw new IllegalArgumentException("A stable message ID is required");
    if (!(input.get("expectedContent") instanceof String))
      throw new IllegalArgumentException("The original prompt content is required");
    if (!(input.get("requestId") instanceof String requestId)
        || !requestId.matches("[A-Za-z0-9_-]{1,200}"))
      throw new IllegalArgumentException("A stable edit request ID is required");
    if (!(input.get("expectedRevisionCount") instanceof Number count)
        || count.longValue() < 0
        || count.doubleValue() != count.longValue())
      throw new IllegalArgumentException("The current task revision count is required");
    String fingerprint = revisionFingerprint(input);
    // A network retry must not stop or reserve an already accepted edited response.
    var replay = tasks.replayRevision(id, requestId, fingerprint);
    if (replay != null) return revisionResponse(replay, messageId);
    try (var boundary = activity.preventNewActivity(id)) {
      if (boundary.responseBusy())
        throw new ConflictException(
            "Wait for the task's response to finish before changing or sending a prompt");
      if (queue != null && !queue.list(id).isEmpty())
        throw new ConflictException(
            "Send or discard saved queued prompts before editing this chat");
      var result =
          tasks.revise(
              id,
              requestId,
              fingerprint,
              count.longValue(),
              messageId,
              base -> {
                AiTask task = base.task();
                int selected = -1;
                for (int i = 0; i < task.messages.size(); i++)
                  if (messageId.equals(task.messages.get(i).id)) {
                    if (selected >= 0)
                      throw new ConflictException(
                          "The message ID is ambiguous; reload the original task");
                    selected = i;
                  }
                if (selected < 0)
                  throw new NotFoundException("The selected message no longer exists");
                var message = task.messages.get(selected);
                if (!"user".equals(message.role))
                  throw new IllegalArgumentException("Only sent user prompts can be edited");
                if (!Objects.equals(message.content, input.get("expectedContent")))
                  throw new ConflictException(
                      "The original prompt changed; reload it before editing");
                var originalRepositoryIds = new ArrayList<>(task.repositoryIds);
                var selectedRepositoryIds = revisionRepositoryIds(task, input);
                task.messages = new ArrayList<>(task.messages.subList(0, selected));
                var retainedIds =
                    task.messages.stream()
                        .map(item -> item.id)
                        .collect(java.util.stream.Collectors.toSet());
                task.checkpoints =
                    new ArrayList<>(
                        task.checkpoints.stream()
                            .filter(checkpoint -> retainedIds.contains(checkpoint.messageId()))
                            .toList());
                task.checkpointRevision++;
                // Legacy role-based compaction can mix messages before and after the selected
                // prompt.
                // Preserve only compaction explicitly proven to precede every retained message.
                if (!Boolean.TRUE.equals(
                    task.additionalProperties().get("rollingContextIsPrefix"))) {
                  task.rollingContext = "";
                  task.archivedMessageCount = 0;
                }
                var attachments = cloneList(message.attachments);
                task.additionalProperties().remove("questionCancellation");
                task.additionalProperties().put("contextMode", "fresh");
                task.additionalProperties().put("cliSessions", new LinkedHashMap<>());
                task.additionalProperties().put("revisionCount", count.longValue() + 1);
                task.additionalProperties().put("revisionCutoffAt", base.createdAt());
                task.additionalProperties()
                    .put(
                        "revisionOf",
                        new LinkedHashMap<>(
                            Map.of(
                                "taskId",
                                id,
                                "messageId",
                                messageId,
                                "createdAt",
                                base.createdAt(),
                                "revisionId",
                                base.revisionId(),
                                "requestId",
                                requestId,
                                "pending",
                                true,
                                "attachments",
                                attachments)));
                if ("global".equals(task.scope)) {
                  map(task.additionalProperties().get("revisionOf"))
                      .put("originalRepositoryIds", originalRepositoryIds);
                  task.repositoryIds = new ArrayList<>(selectedRepositoryIds);
                }
                task.additionalProperties()
                    .put(
                        "revisionDraft",
                        new LinkedHashMap<>(
                            Map.of(
                                "prompt",
                                input.get("prompt"),
                                "requestId",
                                requestId,
                                "runRequestId",
                                UUID.randomUUID().toString(),
                                "attachments",
                                cloneList(attachments),
                                "promptNotes",
                                PromptNotes.resolve(
                                    input,
                                    message
                                        .additionalProperties()
                                        .getOrDefault("promptNotes", List.of())))));
                return task;
              });
      return revisionResponse(result, messageId);
    }
  }

  public List<Map<String, Object>> revisions(String id) {
    return tasks.revisions(id);
  }

  public Map<String, Object> revision(String id, String revisionId) {
    return tasks.revision(id, revisionId);
  }

  private Map<String, Object> revisionResponse(
      TaskRepository.RevisionResult result, String messageId) {
    return Map.of(
        "task",
        result.task(),
        "attachments",
        map(result.task().additionalProperties().get("revisionDraft"))
            .getOrDefault("attachments", List.of()),
        "originalTaskId",
        result.task().id,
        "messageId",
        messageId,
        "revisionId",
        result.revisionId(),
        "replayed",
        result.replayed());
  }

  private String revisionFingerprint(Map<String, Object> input) {
    var identity =
        new ArrayList<Object>(
            Arrays.asList(
                input.get("messageId"),
                input.get("expectedContent"),
                input.get("prompt"),
                ((Number) input.get("expectedRevisionCount")).longValue(),
                input.containsKey("promptNotes")
                    ? PromptNotes.normalize(input.get("promptNotes"))
                    : null));
    // Preserve durable fingerprints for requests made before scope editing was supported.
    if (input.containsKey("repositoryIds") || input.containsKey("expectedRepositoryIds"))
      identity.add(Arrays.asList(input.get("repositoryIds"), input.get("expectedRepositoryIds")));
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(mapper.writeValueAsString(identity).getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  public Map<String, Object> updateRevisionDraft(String id, Map<String, Object> input) {
    requirePrompt(input.get("prompt"));
    var notes =
        input.containsKey("promptNotes") ? PromptNotes.normalize(input.get("promptNotes")) : null;
    if (!(input.get("expectedPrompt") instanceof String))
      throw new IllegalArgumentException("The saved revision prompt is required");
    String updateFingerprint = revisionDraftFingerprint(input);
    try (var boundary = activity.preventNewActivity(id)) {
      if (boundary.responseBusy())
        throw new ConflictException(
            "Wait for the task's response to finish before changing or sending a prompt");
      if (queue != null && !queue.list(id).isEmpty())
        throw new ConflictException(
            "Send or discard saved queued prompts before editing this chat");
      AiTask task =
          tasks.mutate(
              id,
              draft -> {
                if (input.containsKey("expectedRevisionCount")) {
                  Object expected = input.get("expectedRevisionCount");
                  long actual =
                      ((Number) draft.additionalProperties().getOrDefault("revisionCount", 0))
                          .longValue();
                  if (!(expected instanceof Number version)
                      || version.longValue() < 0
                      || version.doubleValue() != version.longValue())
                    throw new IllegalArgumentException(
                        "The current task revision count is required");
                  if (version.longValue() != actual)
                    throw new ConflictException(
                        "This task has already been revised; reload the draft");
                }
                var revision = map(draft.additionalProperties().get("revisionOf"));
                var saved = map(draft.additionalProperties().get("revisionDraft"));
                if (!Boolean.TRUE.equals(revision.get("pending")) || saved.isEmpty())
                  throw new ConflictException("This task has no unsent revision draft");
                // Replay only the latest complete draft update. This receipt survives a lost HTTP
                // response but cannot restore an older prompt, selection or consumed draft.
                var receipt = map(saved.get("updateReceipt"));
                if (Objects.equals(receipt.get("fingerprint"), updateFingerprint)
                    && Objects.equals(receipt.get("runRequestId"), saved.get("runRequestId")))
                  return;
                if (!Objects.equals(saved.get("prompt"), input.get("expectedPrompt")))
                  throw new ConflictException(
                      "The revision draft changed; reload it before editing");
                if (input.containsKey("expectedRunRequestId")
                    && !Objects.equals(
                        saved.get("runRequestId"), input.get("expectedRunRequestId")))
                  throw new ConflictException(
                      "The revision draft changed; reload it before saving");
                var selectedRepositoryIds = revisionRepositoryIds(draft, input);
                boolean scopeChanged = !Objects.equals(draft.repositoryIds, selectedRepositoryIds);
                if (!Objects.equals(saved.get("prompt"), input.get("prompt"))
                    || (notes != null && !Objects.equals(saved.get("promptNotes"), notes))
                    || scopeChanged
                    || !(saved.get("runRequestId") instanceof String runId)
                    || runId.isBlank()) saved.put("runRequestId", UUID.randomUUID().toString());
                if (scopeChanged) {
                  revision.putIfAbsent(
                      "originalRepositoryIds", new ArrayList<>(draft.repositoryIds));
                  draft.repositoryIds = new ArrayList<>(selectedRepositoryIds);
                  draft.additionalProperties().put("cliSessions", new LinkedHashMap<>());
                }
                saved.put("prompt", input.get("prompt"));
                if (notes != null) saved.put("promptNotes", notes);
                saved.put(
                    "updateReceipt",
                    Map.of(
                        "fingerprint",
                        updateFingerprint,
                        "runRequestId",
                        saved.get("runRequestId")));
              });
      return Map.of(
          "task",
          task,
          "attachments",
          map(task.additionalProperties().get("revisionDraft"))
              .getOrDefault("attachments", List.of()));
    }
  }

  private String revisionDraftFingerprint(Map<String, Object> input) {
    var identity =
        Arrays.asList(
            input.get("expectedPrompt"),
            input.get("expectedRevisionCount"),
            input.get("expectedRunRequestId"),
            input.get("prompt"),
            input.containsKey("promptNotes")
                ? PromptNotes.normalize(input.get("promptNotes"))
                : null,
            input.containsKey("repositoryIds"),
            input.get("repositoryIds"),
            input.get("expectedRepositoryIds"));
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(mapper.writeValueAsString(identity).getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  private List<String> revisionRepositoryIds(AiTask task, Map<String, Object> input) {
    if (!"global".equals(task.scope)) {
      if (input.containsKey("repositoryIds") || input.containsKey("expectedRepositoryIds"))
        throw new IllegalArgumentException("Only Nexus revisions can change repository selection");
      if (workspace != null) workspace.requireRepository(task.repositoryId);
      return task.repositoryIds;
    }
    if (workspace == null) {
      if (input.containsKey("repositoryIds"))
        throw new IllegalStateException(
            "Connected repositories are unavailable; reload before saving");
      return task.repositoryIds;
    }
    return scopes.revisionSelection(task.repositoryIds, workspace.snapshot().repositories(), input);
  }

  public AiTask updateModelSettings(String id, Map<String, Object> settings) {
    return tasks.mutate(
        id,
        task -> {
          task.provider = Objects.toString(settings.get("provider"), task.provider);
          task.model = Objects.toString(settings.get("model"), task.model);
          task.effort = Objects.toString(settings.get("effort"), task.effort);
          task.speed = Objects.toString(settings.get("speed"), task.speed);
          task.modelSettingsSavedAt = Instant.now().toString();
        });
  }

  public AiTask appendUser(
      String id, Map<String, Object> input, List<Map<String, Object>> attachments) {
    requirePrompt(input.get("prompt"));
    String prompt = (String) input.get("prompt");
    return tasks.mutate(
        id,
        task -> {
          if ("New task".equals(task.title)) task.title = title(prompt);
          if (input.get("mode") != null) task.mode = input.get("mode").toString();
          if (!Boolean.TRUE.equals(input.get("preserveSavedModelSettings"))
              || task.modelSettingsSavedAt == null
              || task.modelSettingsSavedAt.isBlank()) {
            task.provider = Objects.toString(input.get("provider"), task.provider);
            task.model = Objects.toString(input.get("model"), task.model);
            task.effort = Objects.toString(input.get("effort"), task.effort);
            task.speed = Objects.toString(input.get("speed"), task.speed);
          }
          String contextMode = "history".equals(input.get("contextMode")) ? "history" : "fresh";
          task.additionalProperties().put("contextMode", contextMode);
          TaskMessage message = new TaskMessage();
          message.id = UUID.randomUUID().toString();
          message.role = "user";
          message.content = prompt;
          message.attachments = cloneList(attachments);
          message.createdAt = Instant.now().toString();
          message.additionalProperties().put("contextMode", contextMode);
          message
              .additionalProperties()
              .put("promptNotes", PromptNotes.resolve(input, task.promptNotes));
          if (input.get("questionReply") instanceof Map<?, ?> reply)
            message
                .additionalProperties()
                .put("questionReply", mapper.convertValue(reply, Map.class));
          task.messages.add(message);
          com.argus.codediscussions.service.CodeDiscussionData.recordMessage(
              task, input, message, mapper);
          if (Objects.equals(
              map(task.additionalProperties().get("revisionDraft")).get("prompt"), prompt)) {
            var savedDraft = map(task.additionalProperties().get("revisionDraft"));
            var revision = map(task.additionalProperties().get("revisionOf"));
            if (savedDraft.get("runRequestId") instanceof String runRequestId)
              revision.put("runRequestId", runRequestId);
            task.additionalProperties().remove("revisionDraft");
            revision.put("pending", false);
          }
        });
  }

  /**
   * Record input only after the native running turn acknowledged it. Steering does not start a new
   * turn or replace the chat's saved provider, mode, model, scope, or context preferences. The
   * task-owned receipt survives the rolling message window so a delivery retry cannot append the
   * same user input twice.
   */
  public AiTask appendSteeredUser(
      String taskId, Map<String, Object> queuedItem, Map<String, Object> receipt) {
    if (queuedItem == null || receipt == null)
      throw new IllegalArgumentException(
          "The accepted queued input and steering receipt are required");
    requirePrompt(queuedItem.get("prompt"));
    if (!(queuedItem.get("requestId") instanceof String requestId)
        || !requestId.matches("[A-Za-z0-9_-]{1,100}"))
      throw new IllegalArgumentException("A stable queued request ID is required");
    if (!Objects.equals(taskId, queuedItem.get("taskId"))
        || (receipt.containsKey("taskId") && !Objects.equals(taskId, receipt.get("taskId")))
        || (receipt.containsKey("requestId")
            && !Objects.equals(requestId, receipt.get("requestId"))))
      throw new IllegalArgumentException(
          "The steering receipt belongs to a different queued input");
    var steering = new LinkedHashMap<String, Object>();
    steering.put("requestId", requestId);
    for (String key : List.of("jobId", "turnId", "acceptedAt")) {
      if (!(receipt.get(key) instanceof String value)
          || value.isBlank()
          || value.length() > 200
          || value.indexOf('\0') >= 0)
        throw new IllegalArgumentException("The accepted steering receipt requires " + key);
      steering.put(key, value);
    }
    try {
      Instant.parse((String) steering.get("acceptedAt"));
    } catch (RuntimeException invalid) {
      throw new IllegalArgumentException("The steering acceptance time is invalid");
    }
    var notes = PromptNotes.normalize(queuedItem.getOrDefault("promptNotes", List.of()));
    Object rawAttachments = queuedItem.getOrDefault("attachments", List.of());
    if (!(rawAttachments instanceof List<?> rows)
        || rows.stream().anyMatch(row -> !(row instanceof Map<?, ?>)))
      throw new IllegalArgumentException(
          "Queued attachments must be a list of attachment metadata");
    List<Map<String, Object>> attachments =
        cloneList(mapper.convertValue(rawAttachments, List.class));
    String fingerprint = steeringFingerprint(queuedItem.get("prompt"), notes, attachments);
    var current = tasks.get(taskId);
    if (hasSteeringReceipt(current, steering, fingerprint)) return current;
    return tasks.mutate(
        taskId,
        task -> {
          if (hasSteeringReceipt(task, steering, fingerprint)) return;
          TaskMessage message = new TaskMessage();
          message.id = UUID.randomUUID().toString();
          message.role = "user";
          message.content = (String) queuedItem.get("prompt");
          message.status = "steered";
          message.createdAt = (String) steering.get("acceptedAt");
          message.attachments = attachments;
          message.additionalProperties().put("steering", new LinkedHashMap<>(steering));
          message.additionalProperties().put("promptNotes", notes);
          message
              .additionalProperties()
              .put("contextMode", task.additionalProperties().getOrDefault("contextMode", "fresh"));
          // Acked inputs can reach persistence out of order. Keep the native acceptance order,
          // and keep every addition before the answer it influenced if completion wins the race.
          int insertion = task.messages.size();
          for (int index = 0; index < task.messages.size(); index++) {
            var candidate = task.messages.get(index);
            if ("assistant".equals(candidate.role)
                && Objects.equals(steering.get("jobId"), map(candidate.execution).get("jobId"))) {
              insertion = Math.min(insertion, index);
            } else if ("user".equals(candidate.role) && "steered".equals(candidate.status)) {
              var accepted = map(candidate.additionalProperties().get("steering"));
              if (Objects.equals(steering.get("jobId"), accepted.get("jobId"))
                  && steeringTime(steering).isBefore(steeringTime(accepted)))
                insertion = Math.min(insertion, index);
            }
          }
          task.messages.add(insertion, message);
          var saved = new LinkedHashMap<>(steering);
          saved.put("messageId", message.id);
          saved.put("fingerprint", fingerprint);
          var receipts =
              new LinkedHashMap<>(map(task.additionalProperties().get("steeringReceipts")));
          receipts.put(requestId, saved);
          task.additionalProperties().put("steeringReceipts", receipts);
          for (var candidate : task.messages)
            if ("assistant".equals(candidate.role)
                && Objects.equals(steering.get("jobId"), map(candidate.execution).get("jobId")))
              addSteeringAudit(task, candidate.execution, (String) steering.get("jobId"));
        });
  }

  private boolean hasSteeringReceipt(
      AiTask task, Map<String, Object> steering, String fingerprint) {
    var saved =
        map(
            map(task.additionalProperties().get("steeringReceipts"))
                .get(steering.get("requestId")));
    if (saved.isEmpty()) return false;
    if (!Objects.equals(saved.get("fingerprint"), fingerprint)
        || !Objects.equals(saved.get("jobId"), steering.get("jobId"))
        || !Objects.equals(saved.get("turnId"), steering.get("turnId")))
      throw new ConflictException(
          "This queued request was already steered with different content or into another turn");
    return true;
  }

  private String steeringFingerprint(Object prompt, Object notes, Object attachments) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(
                      mapper
                          .writeValueAsString(steeringIdentity(List.of(prompt, notes, attachments)))
                          .getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  private Object steeringIdentity(Object value) {
    if (value instanceof Map<?, ?> entries) {
      var sorted = new TreeMap<String, Object>();
      entries.forEach((key, item) -> sorted.put(key.toString(), steeringIdentity(item)));
      return sorted;
    }
    if (value instanceof List<?> entries)
      return entries.stream().map(this::steeringIdentity).toList();
    return value;
  }

  private static Instant steeringTime(Map<String, Object> receipt) {
    try {
      return Instant.parse(Objects.toString(receipt.get("acceptedAt"), ""));
    } catch (RuntimeException invalidLegacyReceipt) {
      return Instant.MAX;
    }
  }

  private void addSteeringAudit(AiTask task, Map<String, Object> execution, String jobId) {
    if (execution == null) return;
    var receipts = new ArrayList<Map<String, Object>>();
    for (Object value : map(task.additionalProperties().get("steeringReceipts")).values()) {
      var receipt = map(value);
      if (!Objects.equals(jobId, receipt.get("jobId"))) continue;
      var safe = new LinkedHashMap<String, Object>();
      for (String key : List.of("requestId", "jobId", "turnId", "acceptedAt"))
        safe.put(key, receipt.get(key));
      receipts.add(safe);
    }
    if (receipts.isEmpty()) return;
    receipts.sort(Comparator.comparing(TaskService::steeringTime));
    execution.put("steeringReceipts", receipts);
    int count = execution.get("steeredInputCount") instanceof Number number ? number.intValue() : 0;
    execution.put("steeredInputCount", Math.max(count, receipts.size()));
  }

  public Map<String, Object> workingContextWithMetrics(String id, String query) {
    return TaskHistory.workingContext(tasks.get(id), query);
  }

  public List<Map<String, Object>> conversationAttachments(String id) {
    var result = new LinkedHashMap<String, Map<String, Object>>();
    for (var message : tasks.get(id).messages)
      for (var attachment : message.attachments)
        if (attachment.get("id") != null)
          result.putIfAbsent(attachment.get("id").toString(), attachment);
    return new ArrayList<>(result.values());
  }

  public Map<String, Object> cliSession(String id, String provider, List<String> repositoryIds) {
    var session = map(map(tasks.get(id).additionalProperties().get("cliSessions")).get(provider));
    if (session.get("repositoryIds") instanceof List<?> saved
        && new java.util.TreeSet<>(saved.stream().map(Object::toString).toList())
            .equals(new java.util.TreeSet<>(repositoryIds))) return session;
    return Map.of();
  }

  public void completeAgentJob(Map<String, Object> job) {
    String taskId = Objects.toString(job.get("taskId"), "");
    if (taskId.isBlank()) return;
    tasks.mutate(
        taskId,
        task -> {
          String id = Objects.toString(job.get("id"), "");
          if (task.completedJobIds.contains(id)) return;
          TaskMessage message = new TaskMessage();
          message.id = UUID.randomUUID().toString();
          message.role = "assistant";
          message.provider = Objects.toString(job.get("provider"), "");
          message.status = Objects.toString(job.get("status"), "");
          message.content = AgentTaskOutput.display(job, mapper);
          message.execution = new java.util.LinkedHashMap<>(Map.of("jobId", id));
          addSteeringAudit(task, message.execution, id);
          message.createdAt = Objects.toString(job.get("completedAt"), Instant.now().toString());
          if (!Set.of("failed", "cancelled").contains(message.status)) {
            var question =
                AgentQuestion.scoped(
                    id, AgentQuestion.parse(AgentTaskOutput.response(job, mapper, true), mapper));
            if (!question.isEmpty()) {
              message.additionalProperties().put("question", question);
              var questionContext = new LinkedHashMap<String, Object>();
              for (String key :
                  List.of(
                      "scope",
                      "repositoryId",
                      "repositoryIds",
                      "provider",
                      "mode",
                      "model",
                      "effort",
                      "speed")) if (job.containsKey(key)) questionContext.put(key, job.get(key));
              questionContext.put(
                  "promptNotes", PromptNotes.normalize(job.getOrDefault("promptNotes", List.of())));
              questionContext.put("contextMode", job.getOrDefault("contextMode", "fresh"));
              message.additionalProperties().put("questionContext", questionContext);
            }
          }
          com.argus.codediscussions.service.CodeDiscussionData.recordMessage(
              task, job, message, mapper);
          task.messages.add(message);
          if (!Objects.toString(job.get("cliSessionId"), "").isEmpty()) {
            var sessions =
                map(
                    task.additionalProperties()
                        .computeIfAbsent("cliSessions", key -> new LinkedHashMap<>()));
            sessions.put(
                message.provider,
                new LinkedHashMap<>(
                    Map.of(
                        "id",
                        job.get("cliSessionId"),
                        "repositoryIds",
                        job.getOrDefault("repositoryIds", List.of()),
                        "updatedAt",
                        message.createdAt)));
          }
          task.completedJobIds.add(id);
        });
  }

  public Map<String, Object> purgeRepositories(List<String> ids) {
    Set<String> selected = new LinkedHashSet<>(ids);
    var attachmentIds = new LinkedHashSet<String>();
    int count = 0;
    for (var summary : tasks.list())
      if (selected.contains(summary.repositoryId())
          || (summary.repositoryIds() != null
              && summary.repositoryIds().stream().anyMatch(selected::contains))) {
        AiTask task = tasks.get(summary.id());
        for (var attachment : conversationAttachments(task.id))
          attachmentIds.add(Objects.toString(attachment.get("id"), ""));
        tasks.delete(task);
        count++;
      }
    return Map.of("tasksDeleted", count, "attachmentIds", new ArrayList<>(attachmentIds));
  }

  public static void requirePrompt(Object prompt) {
    if (!(prompt instanceof String text) || text.isBlank() || text.length() > 100_000)
      throw new IllegalArgumentException("The edited prompt must contain 1 to 100,000 characters");
  }

  private String title(String value) {
    return truncate(value.replaceAll("\\s+", " ").trim(), 20);
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> map(Object value) {
    return value instanceof Map<?, ?> ? (Map<String, Object>) value : new LinkedHashMap<>();
  }

  @SuppressWarnings("unchecked")
  private List<Map<String, Object>> cloneList(List<Map<String, Object>> value) {
    return value == null ? new ArrayList<>() : mapper.convertValue(value, List.class);
  }

  private static String value(String value, String fallback) {
    return value == null || value.isBlank() ? fallback : value;
  }

  private static String truncate(String value, int length) {
    return value.substring(0, Math.min(length, value.length()));
  }
}
