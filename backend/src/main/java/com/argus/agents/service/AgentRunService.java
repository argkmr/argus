package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import com.argus.agents.domain.CancellationRequest;
import com.argus.common.error.ConflictException;
import com.argus.context.domain.ContextAttachment;
import com.argus.context.service.ContextService;
import com.argus.repositorycontext.service.RepositoryContextService;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.service.PromptQueueService;
import com.argus.tasks.service.TaskActivityService;
import com.argus.tasks.service.TaskService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.net.URI;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/** Preparation uses connected IDs only. No caller-selected filesystem paths or URL fetches. */
@Service
public class AgentRunService {
  private final TaskService tasks;
  private final TaskActivityService activity;
  private final PromptQueueService queue;
  private final WorkspaceService workspace;
  private final ContextService contexts;
  private final RepositoryContextService kits;
  private final AgentExecutionService agents;
  private final RepositoryScopeService scopes;
  private final CliCapabilityService capabilities;
  private final AgentEditorContextService editor;
  private final ObjectMapper mapper;
  private final Map<String, Preparation> preparations = new ConcurrentHashMap<>();
  private static final int MAX_LAUNCHED_PREPARATIONS = 500;
  private final Map<String, LaunchedPreparation> launchedPreparations = new LinkedHashMap<>();
  private final Map<String, QuestionReplyAttempt> questionReplies = new LinkedHashMap<>();
  private final Map<String, Map<String, Object>> questionStops = new LinkedHashMap<>();
  private volatile boolean closing;
  private final Set<String> retiredRepositories = ConcurrentHashMap.newKeySet();
  private final Map<String, Long> repositoryGenerations = new ConcurrentHashMap<>();
  private java.util.function.BiFunction<
          Map<String, Object>, Map<String, Object>, Map<String, Object>>
      codeDiscussionReplies;

  public void setCodeDiscussionReplies(
      java.util.function.BiFunction<Map<String, Object>, Map<String, Object>, Map<String, Object>>
          replies) {
    this.codeDiscussionReplies = replies;
  }

  private AgentSteeringService steering;

  @org.springframework.beans.factory.annotation.Autowired
  public void setSteering(AgentSteeringService steering) {
    this.steering = steering;
  }

  public Map<String, Object> steerQueuedPrompt(String id, Map<String, Object> request) {
    if (closing) throw new ConflictException("Argus is shutting down; the prompt remains saved");
    return steering.steer(id, request);
  }

  public Map<String, Object> reconcileSteeredPrompt(String id, Map<String, Object> request) {
    return steering.reconcile(id, request);
  }

  private static class Preparation {
    final Thread thread = Thread.currentThread();
    volatile boolean cancelled;
    volatile Map<String, Object> cancellation = Map.of();
    volatile boolean cancellationAuditPersisted;
    String launchedJobId = "";
    boolean finished;
    volatile String taskId = "";
    volatile List<String> repositoryIds = List.of();
    volatile boolean scopeResolved;
    boolean global;
    final Map<String, Long> generations;

    Preparation(Map<String, Long> generations) {
      this.generations = generations;
    }
  }

  public AgentRunService(
      TaskService tasks,
      TaskActivityService activity,
      PromptQueueService queue,
      WorkspaceService workspace,
      ContextService contexts,
      RepositoryContextService kits,
      AgentExecutionService agents,
      RepositoryScopeService scopes,
      CliCapabilityService capabilities,
      AgentEditorContextService editor,
      ObjectMapper mapper) {
    this.tasks = tasks;
    this.activity = activity;
    this.queue = queue;
    this.workspace = workspace;
    this.contexts = contexts;
    this.kits = kits;
    this.agents = agents;
    this.scopes = scopes;
    this.capabilities = capabilities;
    this.editor = editor;
    this.mapper = mapper;
  }

  private record LaunchedPreparation(String jobId, List<String> repositoryIds) {}

  private static final class QuestionReplyAttempt {
    final String fingerprint;
    String jobId;

    QuestionReplyAttempt(String fingerprint) {
      this.fingerprint = fingerprint;
    }
  }

  public Map<String, Object> answerQuestion(Map<String, Object> request) {
    var reply = AgentQuestionReply.request(request);
    String id = text(reply.get("requestId"));
    String fingerprint = AgentQuestionReply.fingerprint(reply, mapper);
    QuestionReplyAttempt attempt;
    synchronized (questionReplies) {
      var existing = questionReplies.get(id);
      if (existing != null) {
        if (!existing.fingerprint.equals(fingerprint))
          throw new ConflictException("This reply ID was already used for a different answer");
        if (existing.jobId != null) {
          tasks.get(text(reply.get("taskId")));
          return agents.get(existing.jobId);
        }
        throw new ConflictException(
            "This reply is being submitted. Wait and check the original chat.");
      }
      if (questionReplies.size() >= 500) {
        var completed =
            questionReplies.entrySet().stream()
                .filter(item -> item.getValue().jobId != null)
                .findFirst();
        if (completed.isEmpty())
          throw new ConflictException("Too many replies are being prepared; wait before retrying");
        questionReplies.remove(completed.get().getKey());
      }
      attempt = new QuestionReplyAttempt(fingerprint);
      questionReplies.put(id, attempt);
    }
    try {
      var task = tasks.get(text(reply.get("taskId")));
      var input = AgentQuestionReply.runInput(task, reply, mapper);
      var job =
          com.argus.codediscussions.service.CodeDiscussionData.owns(task)
                  && codeDiscussionReplies != null
              ? codeDiscussionReplies.apply(reply, input)
              : run(input, reply);
      synchronized (questionReplies) {
        attempt.jobId = text(job.get("id"));
      }
      return job;
    } catch (RuntimeException error) {
      // Persisted user reply IDs and the source-question check prevent duplicate
      // appends after an uncertain result or a restart. Validation failures may retry.
      synchronized (questionReplies) {
        questionReplies.remove(id, attempt);
      }
      throw error;
    }
  }

  public Map<String, Object> run(Map<String, Object> request) {
    return run(request, null);
  }

  public Map<String, Object> cancelQuestion(Map<String, Object> request) {
    var cancellation = AgentQuestionCancellation.request(request);
    String taskId = text(cancellation.get("taskId"));
    String questionId = text(cancellation.get("questionId"));
    String requestId = text(cancellation.get("requestId"));
    var task = tasks.get(taskId);
    if (!AgentQuestionCancellation.receipt(task, cancellation).isEmpty())
      return fields("ok", true, "task", task);
    try (var barrier = activity.preventNewActivity(taskId)) {
      task = tasks.get(taskId);
      if (!AgentQuestionCancellation.receipt(task, cancellation).isEmpty())
        return fields("ok", true, "task", task);
      var live =
          agents.list().stream()
              .filter(job -> taskId.equals(job.get("taskId")))
              .filter(job -> !truth(job.get("systemJob")))
              .filter(AgentRunService::responseInProgress)
              .toList();
      if (live.size() > 1)
        throw new ConflictException(
            "More than one response is active; refresh the original chat before cancelling");
      String expectedJobId = "";
      Map<String, Object> job = null;
      String attemptKey = taskId + "\n" + requestId;
      Map<String, Object> previous;
      synchronized (questionStops) {
        previous = questionStops.get(attemptKey);
      }
      if (previous != null && !questionId.equals(previous.get("questionId")))
        throw new ConflictException(
            "This cancellation request ID was already used for another question");
      if (!live.isEmpty()) {
        job = live.get(0);
        expectedJobId = text(job.get("id"));
        boolean sameAttempt = previous != null && expectedJobId.equals(previous.get("jobId"));
        if (!questionId.equals(obj(job.get("question")).get("id")) && !sameAttempt)
          throw new ConflictException(
              "That question is no longer current. The newer response was not stopped.");
      } else {
        if (barrier.responseBusy())
          throw new ConflictException(
              "A response is being prepared. Refresh the chat before cancelling its question.");
        task = tasks.get(taskId);
        if (!questionId.equals(AgentQuestion.latest(task, mapper).get("id"))) {
          // Only a server-validated stop attempt may finish its receipt after a transient failure.
          if (previous == null
              || task.messages.isEmpty()
              || !Objects.equals(
                  previous.get("jobId"),
                  obj(task.messages.get(task.messages.size() - 1).execution).get("jobId")))
            throw new ConflictException(
                "This question is no longer awaiting a reply. Refresh the original chat.");
          expectedJobId = text(previous.get("jobId"));
        }
      }
      if (!expectedJobId.isEmpty()) {
        synchronized (questionStops) {
          questionStops.put(attemptKey, fields("questionId", questionId, "jobId", expectedJobId));
          while (questionStops.size() > 500)
            questionStops.remove(questionStops.keySet().iterator().next());
        }
      }
      // Persist the hold before stopping. Even another window cannot auto-start the saved queue.
      queue.pauseTask(taskId, questionId);
      if (job != null) {
        agents.stop(
            expectedJobId,
            CancellationRequest.questionRequest(
                "global".equals(task.scope)
                    ? "global-question-cancel"
                    : "repository-question-cancel"));
        try {
          job = agents.completion(expectedJobId).get(30, TimeUnit.SECONDS);
          barrier.awaitResponseRelease(5000);
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw new ConflictException(
              "The stop is still completing. Your queue is paused; refresh and retry.");
        } catch (ExecutionException | TimeoutException failure) {
          throw new ConflictException(
              "The response is still stopping. Your queue is paused; refresh and retry.");
        }
        if (responseInProgress(job) || !text(job.get("completionError")).isEmpty())
          throw new ConflictException(
              "The response could not finish saving. Your queue is paused; refresh and retry.");
      }
      task = tasks.cancelQuestion(taskId, requestId, questionId, expectedJobId);
      var result = fields("ok", true, "task", task);
      if (job != null) result.put("job", job);
      return result;
    }
  }

  private static boolean responseInProgress(Map<String, Object> job) {
    return truth(job.get("completionPending"))
        || Set.of("starting", "running", "paused").contains(text(job.get("status")));
  }

  public List<Map<String, Object>> resumeQueuedPrompts(Map<String, Object> input) {
    String taskId = text(input.get("taskId"));
    try (var ignored = activity.reserve(taskId)) {
      var task = tasks.get(taskId);
      if ("structured".equals(AgentQuestion.latest(task, mapper).get("source")))
        throw new ConflictException("Answer or cancel Argus's question before resuming the queue");
      for (var pending : queue.list(taskId))
        if ("repository-disconnected".equals(pending.get("pauseReason"))) {
          if (!"global".equals(pending.get("scope")))
            workspace.requireRepository(text(pending.get("repositoryId")));
          for (Object id : list(pending.get("repositoryIds")))
            workspace.requireRepository(text(id));
        }
      return queue.resumeTask(taskId);
    }
  }

  private Map<String, Object> run(Map<String, Object> request, Map<String, Object> questionReply) {
    return run(request, questionReply, false);
  }

  /** Server-only admission for an already reserved, repository-local discussion receipt. */
  public Map<String, Object> runCodeDiscussion(Map<String, Object> request) {
    return runCodeDiscussion(request, null);
  }

  public Map<String, Object> runCodeDiscussion(
      Map<String, Object> request, Map<String, Object> questionReply) {
    var input = new LinkedHashMap<>(request);
    input.put("mode", "plan");
    input.put("scope", "repository");
    input.put("contextMode", "fresh");
    input.put("attachments", List.of());
    input.put("promptNotes", List.of());
    return run(input, questionReply, true);
  }

  private Map<String, Object> run(
      Map<String, Object> request, Map<String, Object> questionReply, boolean codeDiscussion) {
    if (closing) throw new ConflictException("Argus coding agents are shutting down");
    TaskService.requirePrompt(request.get("prompt"));
    var input = new LinkedHashMap<>(request);
    if (input.containsKey("promptNotes"))
      input.put(
          "promptNotes", com.argus.tasks.service.PromptNotes.normalize(input.get("promptNotes")));
    if (input.containsKey("taskPromptNotes"))
      input.put(
          "taskPromptNotes",
          com.argus.tasks.service.PromptNotes.normalize(input.get("taskPromptNotes")));
    for (String internal : List.of("rawPrompt", "systemJob", "conversationOnly", "questionReply"))
      input.remove(internal);
    if (!codeDiscussion) input.remove("codeDiscussionId");
    String requestId = value(input, "requestId", UUID.randomUUID().toString());
    var preparation = new Preparation(Map.copyOf(repositoryGenerations));
    preparation.taskId = text(input.get("taskId"));
    preparation.global = "global".equals(input.get("scope"));
    preparation.repositoryIds =
        preparation.global
            ? list(input.get("repositoryIds"))
            : List.of(text(input.get("repositoryId")));
    synchronized (launchedPreparations) {
      if (launchedPreparations.containsKey(requestId)
          || preparations.putIfAbsent(requestId, preparation) != null)
        throw new ConflictException("This response request has already been submitted");
    }

    Map<String, Object> queued = null;
    AiTask task = null;
    TaskActivityService.Lease reservation = null;
    boolean recorded = false, transferred = false;
    List<Repository> repositories = List.of();
    try {
      if (!preparation.taskId.isEmpty()) {
        reservation = activity.reserve(preparation.taskId);
        task = tasks.get(preparation.taskId);
        if (codeDiscussion)
          com.argus.codediscussions.service.CodeDiscussionData.validateRun(task, input);
        else if (com.argus.codediscussions.service.CodeDiscussionData.owns(task))
          throw new ConflictException(
              "Select code → Ask AI, or open Code discussions in editor actions to continue this chat.");
        var previousRevision = obj(task.additionalProperties().get("revisionOf"));
        if (!truth(previousRevision.get("pending"))
            && requestId.equals(previousRevision.get("runRequestId")))
          throw new ConflictException("This response request has already been submitted");
        if (input.containsKey("expectedRevisionCount")) {
          Object expected = input.get("expectedRevisionCount");
          long actual =
              ((Number) task.additionalProperties().getOrDefault("revisionCount", 0)).longValue();
          if (!(expected instanceof Number version)
              || version.longValue() < 0
              || version.doubleValue() != version.longValue())
            throw new IllegalArgumentException("The current task revision count is required");
          if (version.longValue() != actual)
            throw new ConflictException(
                "This task has already been revised; reload it before sending");
        }
      }
      if (input.get("queueRequestId") != null)
        queued =
            queue.begin(text(input.get("queueRequestId")), input.get("queueDispatchToken"), input);
      if (questionReply != null) {
        if (task == null) throw new ConflictException("Open the original chat before replying");
        // Revalidate after the lease: a queued request, another window, or a
        // just-finished run must not redirect a stale answer to a newer question.
        input.putAll(AgentQuestionReply.runInput(task, questionReply, mapper));
        input.put("questionReply", questionReply);
      } else if (queued != null
          && task != null
          && "structured".equals(AgentQuestion.latest(task, mapper).get("source"))) {
        throw new ConflictException("Answer Argus's question first; your queued messages are kept");
      }
      boolean global = "global".equals(input.get("scope")),
          revision =
              task != null
                  && truth(obj(task.additionalProperties().get("revisionOf")).get("pending"));
      if (task != null
          && task.additionalProperties().containsKey("revisionDraft")
          && !Objects.equals(
              obj(task.additionalProperties().get("revisionDraft")).get("prompt"),
              input.get("prompt")))
        throw new ConflictException("Save the revised draft before sending it");
      if (revision) {
        String draftRequestId =
            text(obj(task.additionalProperties().get("revisionDraft")).get("runRequestId"));
        if (!draftRequestId.isEmpty() && !draftRequestId.equals(requestId))
          throw new ConflictException("This revised draft changed; reload it before sending");
      }
      if (revision
          && (!task.scope.equals(global ? "global" : "repository")
              || !global && !task.repositoryId.equals(input.get("repositoryId"))))
        throw new ConflictException("A revision must use its original task scope");
      if (revision) input.put("contextMode", "fresh");
      String contextMode = "history".equals(input.get("contextMode")) ? "history" : "fresh";
      input.put("contextMode", contextMode);
      var snapshot = workspace.snapshot();
      RepositoryScopeService.Scope scope = null;
      if (global) {
        scope =
            questionReply == null
                ? null
                : scopes.questionReply(snapshot.repositories(), input.get("repositoryIds"));
        if (scope == null)
          scope = scopes.queued(queued, snapshot.repositories(), input.get("repositoryIds"));
        if (scope == null)
          scope = scopes.revision(task, snapshot.repositories(), input.get("repositoryIds"));
        if (scope == null)
          scope = scopes.resolve(snapshot.repositories(), input.get("repositoryIds"));
        repositories = scope.repositories();
      } else repositories = List.of(workspace.requireRepository(text(input.get("repositoryId"))));
      if (repositories.isEmpty())
        throw new IllegalArgumentException("Connect at least one repository before starting Nexus");
      var selectedIds = repositories.stream().map(Repository::id).toList();
      preparation.repositoryIds = selectedIds;
      preparation.scopeResolved = true;
      check(preparation);
      var attachments = new ArrayList<Map<String, Object>>();
      List<Object> ids = list(input.get("attachmentIds"));
      for (Object id : ids.stream().limit(10).toList()) {
        ContextAttachment attachment;
        if (queued != null)
          attachment =
              contexts.getForRevision(text(id), true, attachmentRecords(queued.get("attachments")));
        else if (revision)
          attachment =
              contexts.getForRevision(
                  text(id),
                  true,
                  attachmentRecords(
                      obj(task.additionalProperties().get("revisionOf")).get("attachments")));
        else attachment = contexts.get(text(id));
        attachments.add(toMap(attachment));
      }
      check(preparation);
      var kitContexts = kits.aiKitContexts(repositories);
      String provider = value(input, "provider", task == null ? "codex" : task.provider);
      input.put("provider", provider);
      boolean sameProvider = task == null || provider.equals(task.provider);
      var settings = new LinkedHashMap<>(input);
      if (!settings.containsKey("model"))
        settings.put("model", task != null && sameProvider ? task.model : "");
      if (!settings.containsKey("effort"))
        settings.put("effort", task != null && sameProvider ? task.effort : "auto");
      if (!settings.containsKey("speed"))
        settings.put("speed", task != null && sameProvider ? task.speed : "standard");
      input.putAll(agents.modelSettings(provider, settings));
      agents.assertContextSupported(provider, attachments);
      check(preparation);
      if (task == null) {
        var creation = new LinkedHashMap<>(input);
        creation.put("scope", global ? "global" : "repository");
        creation.put("repositoryId", global ? "global" : repositories.get(0).id());
        creation.put("repositoryIds", selectedIds);
        task = tasks.create(creation);
        preparation.taskId = task.id;
        reservation = activity.reserve(task.id);
      }
      if (!task.repositoryId.equals(global ? "global" : input.get("repositoryId")))
        throw new IllegalArgumentException("AI task does not belong to this repository");
      Object defaultNotes =
          revision
              ? obj(task.additionalProperties().get("revisionDraft"))
                  .getOrDefault("promptNotes", List.of())
              : task.promptNotes;
      input.put("promptNotes", com.argus.tasks.service.PromptNotes.resolve(input, defaultNotes));

      var memory =
          codeDiscussion
              ? fields(
                  "context",
                  com.argus.codediscussions.service.CodeDiscussionData.validateRun(task, input)
                      .get("context"),
                  "metrics",
                  fields("source", "isolated-code-discussion", "cliSessionResumed", false))
              : tasks.workingContextWithMetrics(task.id, text(input.get("prompt")));
      var conversationAttachments =
          codeDiscussion ? List.<Map<String, Object>>of() : tasks.conversationAttachments(task.id);
      var session =
          codeDiscussion
              ? Map.<String, Object>of()
              : tasks.cliSession(task.id, provider, selectedIds);

      var allAttachments = new ArrayList<>(conversationAttachments);
      allAttachments.addAll(attachments);
      var integrations =
          linkCapabilities(
              provider,
              text(input.get("prompt")),
              text(memory.get("context")),
              allAttachments,
              Path.of(repositories.get(0).path()),
              preparation);
      check(preparation);
      input.put("preserveSavedModelSettings", true);
      tasks.appendUser(task.id, input, attachments);
      recorded = true;
      check(preparation);

      check(preparation);
      var contextList = new ArrayList<>(kitContexts);
      String active =
          global && selectedIds.contains(snapshot.activeRepositoryId())
              ? snapshot.activeRepositoryId()
              : repositories.get(0).id();
      input.putAll(
          fields(
              "taskId",
              task.id,
              "taskContext",
              memory.get("context"),
              "cliSessionId",
              session.getOrDefault("id", ""),
              "attachments",
              attachments,
              "conversationAttachments",
              conversationAttachments,
              "editorContext",
              editor.build(
                  repositories,
                  snapshot.runConfigurations().stream()
                      .filter(config -> selectedIds.contains(text(config.get("repositoryId"))))
                      .toList(),
                  active),
              "repositoryContexts",
              contextList,
              "skillDirectories",
              kits.skillDirectories(repositories),
              "toolCapabilities",
              integrations,
              "scope",
              global ? "global" : "repository",
              "repository",
              toMap(repositories.get(0)),
              "repositories",
              repositories.stream().map(this::toMap).toList()));
      Map<String, Object> job;
      synchronized (preparation) {
        check(preparation);
        job = agents.start(input);
        preparation.launchedJobId = text(job.get("id"));
        synchronized (launchedPreparations) {
          launchedPreparations.put(
              requestId,
              new LaunchedPreparation(
                  preparation.launchedJobId, List.copyOf(preparation.repositoryIds)));
          while (launchedPreparations.size() > MAX_LAUNCHED_PREPARATIONS)
            launchedPreparations.remove(launchedPreparations.keySet().iterator().next());
        }
      }
      var held = reservation;
      agents.completion(text(job.get("id"))).whenComplete((value, error) -> held.close());
      transferred = true;
      if (queued != null) queue.started(text(queued.get("requestId")), text(job.get("id")));
      return job;
    } catch (RuntimeException error) {
      if (queued != null)
        try {
          queue.interrupted(text(queued.get("requestId")), error, queued.get("dispatchToken"));
        } catch (RuntimeException ignored) {
        }
      if (preparation.cancelled && task != null && recorded && !transferred) {
        tasks.completeAgentJob(
            fields(
                "id",
                "preparation-" + requestId,
                "taskId",
                task.id,
                "requestId",
                requestId,
                "codeDiscussionId",
                input.get("codeDiscussionId"),
                "scope",
                task.scope,
                "repositoryId",
                task.repositoryId,
                "repositoryIds",
                task.repositoryIds,
                "provider",
                input.get("provider"),
                "providerName",
                input.get("provider"),
                "mode",
                input.get("mode"),
                "model",
                input.getOrDefault("model", ""),
                "effort",
                input.getOrDefault("effort", "auto"),
                "speed",
                input.getOrDefault("speed", "standard"),
                "prompt",
                input.get("prompt"),
                "status",
                "cancelled",
                "cancellation",
                preparation.cancellation,
                "cancellationAuditPersisted",
                preparation.cancellationAuditPersisted,
                "output",
                "",
                "error",
                "",
                "startedAt",
                now(),
                "completedAt",
                now()));
      }
      if (preparation.cancelled) throw new ConflictException("Response preparation was cancelled");
      throw error;
    } finally {
      if (reservation != null && !transferred) reservation.close();
      synchronized (preparation) {
        preparation.finished = true;
        preparations.remove(requestId, preparation);
        if (preparation.cancelled) Thread.interrupted();
      }
    }
  }

  public Map<String, Object> cancelPreparation(String id) {
    return cancelPreparation(
        id, CancellationRequest.internal(CancellationRequest.Cause.INTERNAL_STOP));
  }

  public Map<String, Object> cancelPreparation(String id, CancellationRequest request) {
    var preparation = preparations.get(id);
    if (preparation != null) {
      synchronized (preparation) {
        if (preparation.cancelled) return preparation.cancellation;
        if (!preparation.finished) {
          preparation.cancelled = true;
          var scopedRequest = request.withPreparationId(id);
          if (!preparation.launchedJobId.isEmpty()) {
            var stopped = agents.stop(preparation.launchedJobId, scopedRequest);
            preparation.cancellation = obj(stopped.get("cancellation"));
            preparation.cancellationAuditPersisted =
                truth(stopped.get("cancellationAuditPersisted"));
          } else {
            preparation.cancellation = scopedRequest.provenance("", "");
            preparation.cancellationAuditPersisted =
                agents.auditCancellation(preparation.cancellation);
            preparation.cancellation.put("auditPersisted", preparation.cancellationAuditPersisted);
            // Hold the lifecycle lock until interruption; never interrupt a reused HTTP thread.
            preparation.thread.interrupt();
          }
          return preparation.cancellation;
        }
      }
    }
    LaunchedPreparation launched;
    synchronized (launchedPreparations) {
      launched = launchedPreparations.get(id);
    }
    if (launched != null)
      return obj(agents.stop(launched.jobId(), request.withPreparationId(id)).get("cancellation"));
    return Map.of();
  }

  public Map<String, Object> purgeRepositories(List<String> ids) {
    return disconnectRepositories(ids);
  }

  /** Drain preparation without touching persisted questions, replies or CLI sessions. */
  public Map<String, Object> disconnectRepositories(List<String> ids) {
    retiredRepositories.addAll(ids);
    ids.forEach(id -> repositoryGenerations.merge(id, 1L, Long::sum));
    var selected = new LinkedHashMap<String, Preparation>();
    preparations.forEach(
        (id, preparation) -> {
          if (preparation.repositoryIds.stream().anyMatch(ids::contains)
              || preparation.global
                  && !preparation.scopeResolved
                  && preparation.repositoryIds.isEmpty()) selected.put(id, preparation);
        });
    selected
        .keySet()
        .forEach(
            id ->
                cancelPreparation(
                    id,
                    CancellationRequest.internal(CancellationRequest.Cause.REPOSITORY_REMOVED)));
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    while (selected.entrySet().stream()
            .anyMatch(entry -> preparations.get(entry.getKey()) == entry.getValue())
        && System.nanoTime() < deadline)
      try {
        Thread.sleep(10);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Repository preparation drain interrupted", error);
      }
    if (selected.entrySet().stream()
        .anyMatch(entry -> preparations.get(entry.getKey()) == entry.getValue()))
      throw new IllegalStateException("Repository agent preparations have not stopped");
    synchronized (launchedPreparations) {
      launchedPreparations
          .values()
          .removeIf(item -> item.repositoryIds().stream().anyMatch(ids::contains));
    }
    return Map.of("agentPreparationsCancelled", selected.size());
  }

  public void releaseRetiredRepositories(List<String> ids) {
    retiredRepositories.removeAll(ids);
  }

  public void stopAll() {
    closing = true;
    for (String id : preparations.keySet())
      cancelPreparation(
          id, CancellationRequest.internal(CancellationRequest.Cause.APPLICATION_SHUTDOWN));
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    while (!preparations.isEmpty() && System.nanoTime() < deadline)
      try {
        Thread.sleep(10);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Agent preparation drain interrupted", error);
      }
    if (!preparations.isEmpty())
      throw new IllegalStateException("Agent preparations did not finish before shutdown");
    agents.stopAll();
    synchronized (launchedPreparations) {
      launchedPreparations.clear();
    }
  }

  public Map<String, Object> enqueue(Map<String, Object> request) {
    String taskId = text(request.get("taskId"));
    long epoch = activity.queueEpoch(taskId);
    var task = tasks.get(taskId);
    var input = scopes.freeze(task, request, workspace.snapshot().repositories());
    if (!(input.get("attachmentIds") instanceof List<?> ids)
        || ids.size() > 10
        || ids.stream().anyMatch(id -> !(id instanceof String)))
      throw new IllegalArgumentException("Queued requests support up to 10 attachment IDs");
    var attachments = ids.stream().map(id -> toMap(contexts.get(id.toString()))).toList();
    return activity.acceptQueuedPrompt(
        taskId, epoch, () -> queue.enqueue(task, input, attachments));
  }

  public Map<String, Object> claimQueuedPrompt(String id) {
    var saved =
        queue.list(null).stream()
            .filter(item -> id.equals(item.get("requestId")))
            .findFirst()
            .orElseThrow(
                () -> new com.argus.common.error.NotFoundException("Queued request not found"));
    String taskId = text(saved.get("taskId"));
    try (var reservation = activity.reserve(taskId)) {
      if ("structured".equals(AgentQuestion.latest(tasks.get(taskId), mapper).get("source")))
        throw new ConflictException("Answer Argus's question first; your queued messages are kept");
      return queue.claim(id);
    }
  }

  private void check(Preparation preparation) {
    if (preparation.cancelled
        || closing
        || Thread.currentThread().isInterrupted()
        || preparation.repositoryIds.stream()
            .anyMatch(
                id ->
                    retiredRepositories.contains(id)
                        || !Objects.equals(
                            preparation.generations.getOrDefault(id, 0L),
                            repositoryGenerations.getOrDefault(id, 0L))))
      throw new ConflictException("Response stopped by user");
  }

  static Map<String, Object> linkRequest(
      String prompt, String previous, List<Map<String, Object>> attachments) {
    var hosts = new LinkedHashSet<String>();
    var matcher =
        Pattern.compile("https?://[^\\s<>\\\"'`]+", Pattern.CASE_INSENSITIVE)
            .matcher(
                prompt
                    + "\n"
                    + previous
                    + "\n"
                    + String.join(
                        "\n", attachments.stream().map(item -> text(item.get("url"))).toList()));
    while (matcher.find() && hosts.size() < 12)
      try {
        String host = URI.create(matcher.group()).getHost();
        if (host != null) hosts.add(host.toLowerCase(Locale.ROOT));
      } catch (RuntimeException ignored) {
      }
    boolean requested =
        !hosts.isEmpty()
            || Pattern.compile(
                    "\\b(?:browser|chrome|google\\s+(?:doc|drive|sheet|slide)|web\\s?page|website)\\b",
                    Pattern.CASE_INSENSITIVE)
                .matcher(prompt)
                .find();
    return fields("requested", requested, "hosts", new ArrayList<>(hosts));
  }

  private Map<String, Object> linkCapabilities(
      String provider,
      String prompt,
      String previous,
      List<Map<String, Object>> attachments,
      Path working,
      Preparation preparation) {
    long started = System.nanoTime();
    var request = linkRequest(prompt, previous, attachments);
    if (!truth(request.get("requested")))
      return fields(
          "requested", false, "hosts", List.of(), "status", "not-requested", "durationMs", 0);

    Map<String, Object> report;
    try {
      report = new LinkedHashMap<>(capabilities.discover(provider, working, false));
    } catch (RuntimeException error) {
      check(preparation);
      report =
          fields(
              "provider",
              provider,
              "source",
              "unavailable",
              "status",
              "unavailable",
              "integrations",
              List.of(),
              "limitations",
              List.of(
                  "CLI tool discovery did not complete. The CLI must check its own tools before reporting access."));
    }
    report.putAll(
        fields(
            "requested",
            true,
            "hosts",
            request.get("hosts"),
            "durationMs",
            Math.round(elapsed(started))));
    return report;
  }

  private List<ContextAttachment> attachmentRecords(Object value) {
    return AgentRunService.<Map<String, Object>>list(value).stream()
        .map(item -> mapper.convertValue(item, ContextAttachment.class))
        .toList();
  }

  @SuppressWarnings("unchecked")
  public Map<String, Object> toMap(Object value) {
    return mapper.convertValue(value, Map.class);
  }

  private static <T> List<T> list(Object value) {
    return com.argus.agents.domain.AgentValues.list(value);
  }

  private double elapsed(long start) {
    return Math.round((System.nanoTime() - start) / 100_000d) / 10d;
  }
}
