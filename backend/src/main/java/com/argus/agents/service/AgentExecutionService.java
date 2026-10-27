package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import com.argus.agents.domain.CancellationRequest;
import com.argus.agents.domain.CliProviderAdapter;
import com.argus.agents.dto.ProviderAvailability;
import com.argus.agents.repository.CliProviderAdapterRepository;
import com.argus.agents.repository.ProviderHealthRepository;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.NotFoundException;
import com.argus.common.process.OwnedProcess;
import com.argus.tasks.service.AgentTaskOutput;
import com.argus.tasks.service.TaskService;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/** Native, shell-free coding CLI execution. Completion includes streams and persistence. */
@Service
public class AgentExecutionService implements AutoCloseable {
  private static final int MAX_OUTPUT = 500_000;
  private final CliProviderAdapterRepository adapters;
  private final AgentModelCatalogService catalog;
  private final CliInvocationService invocations;
  private final AgentPromptService prompts;
  private final ProviderHealthRepository health;
  private final TaskService tasks;
  private final ObjectMapper mapper;
  private final ArgusProperties properties;
  private final int port;
  private final Map<String, Job> jobs = new LinkedHashMap<>();
  private final Set<String> retiredRepositories = new HashSet<>();
  private final Map<String, Long> repositoryGenerations = new HashMap<>();
  private com.argus.workspace.service.WorkspaceService workspace;
  private CancellationAuditService cancellationAudit;
  private Path codexRolloutHome = CodexRolloutUsage.defaultHome();
  private boolean nativeCodexTransportEnabled = true;

  /** Legacy fixture/provider hosts may deliberately exercise only the exec adapter. */
  public void setNativeCodexTransportEnabled(boolean enabled) {
    nativeCodexTransportEnabled = enabled;
  }

  /** Override the read-only observer root for an embedded runtime or isolated tests. */
  public void setCodexRolloutHome(Path home) {
    codexRolloutHome = home;
  }

  @org.springframework.beans.factory.annotation.Autowired
  public void setCancellationAudit(CancellationAuditService cancellationAudit) {
    this.cancellationAudit = cancellationAudit;
  }

  @org.springframework.beans.factory.annotation.Autowired
  public void setWorkspace(com.argus.workspace.service.WorkspaceService workspace) {
    this.workspace = workspace;
  }

  private final List<Consumer<Map<String, Object>>> listeners = new CopyOnWriteArrayList<>();
  private final ExecutorService completions =
      Executors.newCachedThreadPool(
          r -> {
            var thread = new Thread(r, "argus-agent-completion");
            thread.setDaemon(true);
            return thread;
          });
  private boolean closing;

  private static final class Job {
    final Map<String, Object> data;
    final CompletableFuture<Map<String, Object>> completion = new CompletableFuture<>();
    OwnedProcess process;
    CodexAppServerSession nativeSession;
    AgentOutputStream outputStream;
    CodexRolloutUsage rolloutUsage;
    final ProviderTokenUsage tokenUsage;
    volatile boolean stopping, purged;
    String probe = "";
    final java.util.concurrent.atomic.AtomicBoolean finalized =
        new java.util.concurrent.atomic.AtomicBoolean();

    Job(Map<String, Object> data) {
      this.data = data;
      this.tokenUsage =
          new ProviderTokenUsage(
              text(data.get("provider")),
              text(data.get("model")),
              text(data.get("speed")),
              text(data.get("effort")));
    }
  }

  public AgentExecutionService(
      CliProviderAdapterRepository adapters,
      AgentModelCatalogService catalog,
      CliInvocationService invocations,
      AgentPromptService prompts,
      ProviderHealthRepository health,
      TaskService tasks,
      ObjectMapper mapper,
      ArgusProperties properties,
      @Value("${server.port:4173}") int port) {
    this.adapters = adapters;
    this.catalog = catalog;
    this.invocations = invocations;
    this.prompts = prompts;
    this.health = health;
    this.tasks = tasks;
    this.mapper = mapper;
    this.properties = properties;
    this.port = port;
    this.cancellationAudit =
        new CancellationAuditService(
            properties, new com.argus.common.storage.AtomicJsonStore(mapper));
  }

  public CliProviderAdapter adapter(String provider) {
    return adapters.list().stream()
        .filter(item -> item.id().equals(provider))
        .findFirst()
        .orElseThrow(
            () ->
                new IllegalArgumentException(
                    "Argus answers through authenticated coding-agent CLIs only"));
  }

  public Map<String, Object> modelSettings(String provider, Map<String, Object> input) {
    return invocations.settings(adapter(provider), catalog.discover(provider, false), input);
  }

  public Map<String, Object> prepareModelCatalog(String provider) {
    return catalog.discover(provider, false);
  }

  public AutoCloseable onComplete(Consumer<Map<String, Object>> listener) {
    listeners.add(listener);
    return () -> listeners.remove(listener);
  }

  public void assertContextSupported(String provider, List<Map<String, Object>> attachments) {
    var adapter = adapter(provider);
    var capabilities = new HashSet<>(adapter.contextCapabilities());
    for (var item : attachments) {
      String kind = text(item.get("kind"));
      if (!capabilities.contains(kind.equals("paste") ? "file" : kind))
        throw new org.springframework.web.server.ResponseStatusException(
            org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY,
            adapter.name()
                + " cannot use "
                + (kind.equals("browser")
                    ? "browser context"
                    : kind.equals("image") ? "images" : "file attachments")
                + ". Switch to a compatible coding-agent CLI.");
    }
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> copy(Map<String, Object> value) {
    return mapper.convertValue(value, Map.class);
  }

  private synchronized Job require(String id) {
    Job job = jobs.get(id);
    if (job == null || job.purged) throw new NotFoundException("AI task not found");
    return job;
  }

  public synchronized List<Map<String, Object>> list() {
    return list(null);
  }

  public synchronized List<Map<String, Object>> list(String repositoryId) {
    var result = new ArrayList<Map<String, Object>>();
    for (var job : jobs.values())
      if (!job.purged
          && (repositoryId == null
              || repositoryId.isBlank()
              || repositoryId.equals(job.data.get("repositoryId")))) result.add(snapshot(job));
    Collections.reverse(result);
    return result;
  }

  public Map<String, Object> get(String id) {
    return snapshot(require(id));
  }

  public Map<String, Object> get(String id, Long afterOutput, Long afterError) {
    var result = get(id);
    if (afterOutput != null && afterError != null) {
      delta(result, "output", afterOutput);
      delta(result, "error", afterError);
    }
    return result;
  }

  private void delta(Map<String, Object> result, String field, long after) {
    String value = text(result.get(field));
    long cursor = ((Number) result.get(field + "Cursor")).longValue();
    long start = cursor - value.length();
    boolean reset = after < start || after > cursor;
    result.put(field, reset ? value : value.substring((int) (after - start)));
    result.put(field + "Reset", reset);
  }

  private Map<String, Object> snapshot(Job job) {
    synchronized (job) {
      var result = copy(job.data);
      result.put("tokenUsage", job.tokenUsage.snapshot());
      boolean nativeSupported = job.nativeSession != null && job.nativeSession.supported();
      boolean available =
          nativeSupported
              && job.nativeSession.available()
              && !job.stopping
              && !job.finalized.get()
              && "running".equals(job.data.get("status"));
      result.put(
          "steering",
          fields(
              "supported",
              nativeSupported,
              "available",
              available,
              "reason",
              available
                  ? ""
                  : job.nativeSession != null
                      ? job.nativeSession.unavailableReason()
                      : "Live steering requires an active native Codex turn"));
      if (job.outputStream != null) {
        result.put("readableOutput", job.outputStream.readable());
        result.put("displayOutput", job.outputStream.display());
        if (!Set.of("failed", "cancelled").contains(text(result.get("status"))))
          result.put(
              "question",
              AgentQuestion.scoped(text(result.get("id")), job.outputStream.question()));
      }
      result.put("apiRequestSuggestions", suggestions(text(result.get("output"))));
      return result;
    }
  }

  public CompletableFuture<Map<String, Object>> completion(String id) {
    return require(id).completion;
  }

  /** Deliver additional input to the same native turn, without interrupting or restarting it. */
  public Map<String, Object> steer(String id, String expectedNativeTurnId, String prompt) {
    Job job = require(id);
    CodexAppServerSession session;
    synchronized (job) {
      session = job.nativeSession;
      if (session == null
          || job.stopping
          || job.finalized.get()
          || !"running".equals(job.data.get("status")))
        throw new SteerDeliveryException(
            "This running request does not support live steering", false);
    }
    Map<String, Object> accepted = session.steer(expectedNativeTurnId, prompt);
    synchronized (job) {
      var delivered = new ArrayList<Map<String, Object>>(list(job.data.get("steeringInputs")));
      delivered.add(
          fields(
              "prompt",
              prompt,
              "threadId",
              accepted.get("threadId"),
              "turnId",
              accepted.get("turnId"),
              "acceptedAt",
              accepted.get("acceptedAt")));
      job.data.put("steeringInputs", delivered);
    }
    return accepted;
  }

  public Map<String, Object> start(Map<String, Object> request) {
    Map<String, Long> generations;
    synchronized (this) {
      generations = Map.copyOf(repositoryGenerations);
    }
    var input = new LinkedHashMap<>(request);
    String prompt = text(input.get("prompt"));
    if (prompt.isBlank())
      throw new IllegalArgumentException("Describe the change or investigation first");
    String provider = text(input.get("provider"));
    var adapter = adapter(provider);
    input.putAll(modelSettings(provider, input));
    String mode =
        "plan".equals(input.get("mode")) || truth(input.get("conversationOnly")) ? "plan" : "edit";
    input.put("mode", mode);
    boolean global = "global".equals(input.get("scope"));
    List<Map<String, Object>> repositories =
        global
            ? AgentExecutionService.<Map<String, Object>>list(input.get("repositories"))
            : new ArrayList<>(List.of(obj(input.get("repository"))));
    if (repositories.isEmpty() || text(repositories.get(0).get("path")).isBlank())
      throw new IllegalArgumentException("Connect at least one repository before starting Nexus");
    var primary = repositories.get(0);
    var directories = new LinkedHashSet<String>();
    if (!truth(input.get("conversationOnly"))) {
      for (var repository : repositories.subList(1, repositories.size()))
        directories.add(text(repository.get("path")));
      for (Object directory : AgentExecutionService.list(input.get("skillDirectories")))
        directories.add(text(directory));
      for (String key : List.of("conversationAttachments", "attachments"))
        for (var item : AgentExecutionService.<Map<String, Object>>list(input.get(key)))
          if (!text(item.get("path")).isEmpty())
            directories.add(Path.of(text(item.get("path"))).getParent().toString());
    }
    var promptNotes =
        com.argus.tasks.service.PromptNotes.normalize(input.getOrDefault("promptNotes", List.of()));
    String
        scoped =
            com.argus.tasks.service.PromptNotes.append(
                prompts.build(input, repositories), promptNotes),
        session = text(input.get("cliSessionId"));
    boolean resuming = !session.isEmpty() && !adapter.resumeArguments().isEmpty();
    String submitted =
        resuming
            ? com.argus.tasks.service.PromptNotes.append(prompts.continuation(input), promptNotes)
            : scoped;
    var invocationOptions = new LinkedHashMap<>(input);
    invocationOptions.putAll(
        fields(
            "workingDirectory",
            primary.get("path"),
            "additionalDirectories",
            new ArrayList<>(directories)));
    String id = UUID.randomUUID().toString();
    var data =
        fields(
            "id",
            id,
            "taskId",
            text(input.get("taskId")),
            "repositoryId",
            global ? "global" : primary.get("id"),
            "repositoryName",
            global ? "Nexus" : primary.get("name"),
            "scope",
            global ? "global" : "repository",
            "repositoryIds",
            repositories.stream().map(repository -> text(repository.get("id"))).toList(),
            "provider",
            provider,
            "providerName",
            adapter.name(),
            "systemJob",
            truth(input.get("systemJob")),
            "mode",
            mode,
            "model",
            input.get("model"),
            "effort",
            input.get("effort"),
            "speed",
            input.get("speed"),
            "prompt",
            prompt,
            "contextMode",
            input.getOrDefault("contextMode", "fresh"),
            "attachments",
            AgentExecutionService.<Map<String, Object>>list(input.get("attachments")).stream()
                .map(
                    item ->
                        fields(
                            "id",
                            item.get("id"),
                            "kind",
                            item.get("kind"),
                            "title",
                            item.get("title"),
                            "url",
                            item.get("url"),
                            "path",
                            item.get("path"),
                            "size",
                            item.get("size")))
                .toList(),
            "cliSessionId",
            resuming ? session : "",
            "cliSessionResumed",
            resuming,
            "cliSessionFallback",
            false,
            "status",
            "starting",
            "output",
            "",
            "error",
            "",
            "outputCursor",
            0L,
            "errorCursor",
            0L,
            "startedAt",
            now(),
            "completedAt",
            null,
            "exitCode",
            null);
    data.put("promptNotes", promptNotes);
    if (!text(input.get("codeDiscussionId")).isEmpty()) {
      data.put("codeDiscussionId", input.get("codeDiscussionId"));
      data.put("requestId", input.get("requestId"));
    }
    Job job = new Job(data);
    synchronized (this) {
      if (closing) throw new IllegalStateException("Argus coding agents are shutting down");
      if (repositories.stream()
          .anyMatch(
              repository ->
                  retiredRepositories.contains(text(repository.get("id")))
                      || !Objects.equals(
                          generations.getOrDefault(text(repository.get("id")), 0L),
                          repositoryGenerations.getOrDefault(text(repository.get("id")), 0L))))
        throw new IllegalStateException("A selected repository is being removed");
      validateConnected(repositories);
      jobs.put(id, job);
      launch(job, adapter, invocationOptions, submitted, scoped, resuming ? session : "");
    }
    return snapshot(job);
  }

  private static <T> List<T> list(Object value) {
    return com.argus.agents.domain.AgentValues.list(value);
  }

  private void launch(
      Job job,
      CliProviderAdapter adapter,
      Map<String, Object> options,
      String prompt,
      String scoped,
      String session) {
    if (nativeCodexTransportEnabled
        && adapter.builtin()
        && "codex".equals(adapter.id())
        && !truth(options.get("conversationOnly"))) {
      synchronized (job) {
        job.data.put("transport", "codex-app-server");
      }
      completions.execute(() -> launchNative(job, adapter, options, prompt, scoped, session));
      return;
    }
    launchExec(job, adapter, options, prompt, scoped, session);
  }

  private void launchNative(
      Job job,
      CliProviderAdapter adapter,
      Map<String, Object> options,
      String prompt,
      String scoped,
      String resumeId) {
    CodexAppServerSession nativeSession = null;
    boolean initialized = false;
    try {
      synchronized (job) {
        if (job.stopping || job.purged) {
          finish(job, 130, null);
          return;
        }
      }
      var input = new LinkedHashMap<>(options);
      input.putAll(fields("prompt", prompt, "sessionId", resumeId));
      var invocation = invocations.codexAppServer(adapter, input, port);
      var command = new ArrayList<String>();
      command.add(invocation.executable());
      command.addAll(invocation.arguments());
      var builder =
          new ProcessBuilder(command)
              .directory(Path.of(text(options.get("workingDirectory"))).toFile());
      com.argus.common.process.ExecutableDiscovery.prepareProvider(builder);
      if (properties.mcpToken() != null && !properties.mcpToken().isBlank())
        builder.environment().put("ARGUS_MCP_TOKEN", properties.mcpToken());
      var events =
          new CodexAppServerEvents(
              event -> {
                synchronized (job) {
                  if ("turn.started".equals(event.get("type")))
                    job.data.put("nativeTurnId", event.get("turn_id"));
                  if ("thread.started".equals(event.get("type")))
                    job.data.put("nativeThreadId", event.get("thread_id"));
                }
                append(job, "output", mapper.writeValueAsString(event) + "\n");
              });
      nativeSession =
          new CodexAppServerSession(
              builder,
              mapper,
              event -> {
                synchronized (job) {
                  job.tokenUsage.acceptCodexNative(event);
                }
                events.accept(event);
              },
              (stream, value) -> append(job, "error", value),
              Duration.ofSeconds(30));
      synchronized (job) {
        job.nativeSession = nativeSession;
        job.process = nativeSession.process();
        if (job.stopping || job.purged)
          throw new CancellationException("Request stopped before native initialization");
      }
      nativeSession.initialize();
      initialized = true;
      synchronized (job) {
        if (job.stopping || job.purged)
          throw new CancellationException("Request stopped before native turn start");
        job.tokenUsage.beginAttempt();
        job.rolloutUsage = new CodexRolloutUsage(codexRolloutHome, resumeId, mapper);
        job.outputStream =
            new AgentOutputStream(
                mapper,
                true,
                event -> {
                  job.tokenUsage.accept(event);
                  if (job.rolloutUsage != null && "thread.started".equals(event.get("type")))
                    job.rolloutUsage.observeThread(text(event.get("thread_id")));
                });
        job.data.put("outputFormat", "ndjson");
      }
      String submitted = prompt;
      String thread;
      try {
        thread = nativeSession.openThread(invocations.codexThreadParameters(options), resumeId);
      } catch (CodexAppServerSession.RpcFailure failure) {
        if (resumeId.isBlank()
            || failure.outcomeUnknown
            || !missingSession("", failure.getMessage())) throw failure;
        synchronized (job) {
          if (job.stopping || job.purged)
            throw new CancellationException("Request stopped before missing-session fallback");
          job.data.putAll(
              fields("cliSessionId", "", "cliSessionResumed", false, "cliSessionFallback", true));
          job.rolloutUsage = new CodexRolloutUsage(codexRolloutHome, "", mapper);
        }
        submitted = scoped;
        thread = nativeSession.openThread(invocations.codexThreadParameters(options), "");
      }
      synchronized (job) {
        job.data.putAll(fields("cliSessionId", thread, "nativeThreadId", thread));
        if (job.rolloutUsage != null) job.rolloutUsage.observeThread(thread);
        job.tokenUsage.bindCodexThread(
            thread, job.rolloutUsage == null ? null : job.rolloutUsage.counterBaseline());
        if (job.stopping || job.purged)
          throw new CancellationException("Request stopped before native turn start");
      }
      String turn = nativeSession.startTurn(invocations.codexTurnParameters(options), submitted);
      synchronized (job) {
        job.data.put("nativeTurnId", turn);
        if (!job.stopping) job.data.put("status", "running");
      }
      var running = nativeSession;
      running
          .completion()
          .whenCompleteAsync(
              (code, error) -> {
                if (error != null)
                  append(
                      job,
                      "error",
                      Objects.toString(error.getMessage(), "Native Codex turn failed"));
                try {
                  running.close();
                } catch (RuntimeException cleanup) {
                  if (error == null) error = cleanup;
                }
                finish(job, error == null ? code : null, error);
              },
              completions);
    } catch (Exception failure) {
      if (nativeSession != null)
        try {
          nativeSession.close();
        } catch (RuntimeException cleanup) {
          failure.addSuppressed(cleanup);
        }
      boolean fallback =
          !initialized
              && !job.stopping
              && !job.purged
              && !closing
              && (!(failure instanceof CodexAppServerSession.RpcFailure rpc)
                  || rpc.code == null
                  || rpc.code == -32601);
      if (fallback) {
        synchronized (job) {
          job.nativeSession = null;
          job.process = null;
          job.data.put("nativeTransportFallback", true);
          job.data.putAll(fields("output", "", "error", "", "outputCursor", 0L, "errorCursor", 0L));
        }
        launchExec(job, adapter, options, prompt, scoped, resumeId);
      } else {
        append(
            job, "error", Objects.toString(failure.getMessage(), "Could not start native Codex"));
        finish(job, null, failure);
      }
    }
  }

  private void launchExec(
      Job job,
      CliProviderAdapter adapter,
      Map<String, Object> options,
      String prompt,
      String scoped,
      String session) {
    synchronized (job) {
      job.data.put("transport", "cli-exec");
    }
    var input = new LinkedHashMap<>(options);
    input.putAll(fields("prompt", prompt, "sessionId", session));
    var invocation = invocations.invocation(adapter, input, port);
    org.slf4j.LoggerFactory.getLogger(AgentExecutionService.class)
        .debug("Launching exec CLI {} at {}", adapter.id(), invocation.executable());
    var command = new ArrayList<String>();
    command.add(invocation.executable());
    command.addAll(invocation.arguments());
    var builder =
        new ProcessBuilder(command)
            .directory(Path.of(text(options.get("workingDirectory"))).toFile());
    com.argus.common.process.ExecutableDiscovery.prepareProvider(builder);
    org.slf4j.LoggerFactory.getLogger(AgentExecutionService.class)
        .debug("Launching coding CLI {} at {}", adapter.id(), builder.command().get(0));
    if (properties.mcpToken() != null && !properties.mcpToken().isBlank())
      builder.environment().put("ARGUS_MCP_TOKEN", properties.mcpToken());
    try {
      IOException inputError = null;
      boolean inputDelivered = false;
      synchronized (job) {
        // Frame messages before the bounded diagnostic tail can cut through a tool event.
        // Every launch (including a missing-session retry) gets independent framing state.
        boolean structured = invocation.structuredOutput();
        job.tokenUsage.beginAttempt();
        job.rolloutUsage =
            "codex".equals(job.data.get("provider"))
                    && !invocation.arguments().contains("--ephemeral")
                ? new CodexRolloutUsage(codexRolloutHome, session, mapper)
                : null;
        job.outputStream =
            new AgentOutputStream(
                mapper,
                structured,
                event -> {
                  job.tokenUsage.accept(event);
                  if (job.rolloutUsage != null && "thread.started".equals(event.get("type")))
                    job.rolloutUsage.observeThread(text(event.get("thread_id")));
                });
        job.data.put("outputFormat", structured ? "ndjson" : "text");
        job.process =
            new OwnedProcess(
                builder,
                (stream, value) -> append(job, stream.equals("stdout") ? "output" : "error", value),
                MAX_OUTPUT);
        job.data.put("status", "running");
        try {
          if (!invocation.stdin().isEmpty()) job.process.write(invocation.stdin());
          inputDelivered = true;
          closeCliInput(job.process);
        } catch (IOException error) {
          // A rejected resume can exit before reading stdin. Still drain its diagnostic
          // output and run the same missing-session fallback as a normal process exit.
          inputError = error;
        }
      }
      var process = job.process;
      var inputFailure = inputError;
      var writeFailure = inputDelivered ? null : inputFailure;
      if (writeFailure != null)
        append(
            job,
            "error",
            "Could not write CLI input: "
                + Objects.toString(writeFailure.getMessage(), "stdin unavailable")
                + "\n");
      // A close-only error after delivery does not mean the CLI has stopped working.
      // Only a failed write needs bounded cleanup of a potentially stranded child.
      var completion =
          writeFailure == null ? process.completion() : drainAfterInputFailure(process);
      completion.whenCompleteAsync(
          (code, error) -> {
            if (inputFailure != null && writeFailure == null && (code == null || code != 0))
              append(
                  job,
                  "error",
                  "Could not close CLI input: "
                      + Objects.toString(inputFailure.getMessage(), "stdin unavailable")
                      + "\n");
            if (error != null)
              append(
                  job, "error", Objects.toString(error.getMessage(), "Could not read CLI output"));
            boolean fallback;
            synchronized (this) {
              synchronized (job) {
                fallback =
                    !closing
                        && !job.stopping
                        && !job.purged
                        && !job.finalized.get()
                        && !session.isEmpty()
                        && !process.isAlive()
                        && (code == null || code != 0)
                        && missingSession(
                            text(job.data.get("output")), text(job.data.get("error")));
                if (fallback) {
                  if (job.outputStream != null) job.outputStream.finish();
                  captureRolloutUsage(job);
                  job.data.putAll(
                      fields(
                          "cliSessionId",
                          "",
                          "cliSessionResumed",
                          false,
                          "cliSessionFallback",
                          true,
                          "output",
                          "",
                          "error",
                          "",
                          "outputCursor",
                          0L,
                          "errorCursor",
                          0L,
                          "status",
                          "starting"));
                  job.probe = "";
                  launch(job, adapter, options, scoped, scoped, "");
                }
              }
            }
            // A failed write did not deliver the prompt. By contrast, a close-only
            // error after a successful flush/argv delivery must not turn exit 0 into failure.
            if (!fallback)
              finish(
                  job,
                  writeFailure == null ? code : null,
                  inputFailure == null ? error : inputFailure);
          },
          completions);
    } catch (Exception error) {
      append(job, "error", Objects.toString(error.getMessage(), "Could not start CLI"));
      completions.execute(
          () -> {
            if (job.process != null)
              try {
                job.process.stop(Duration.ofMillis(500), Duration.ofMillis(700));
              } catch (RuntimeException stopError) {
                error.addSuppressed(stopError);
              }
            finish(job, null, error);
          });
    }
  }

  void closeCliInput(OwnedProcess process) throws IOException {
    process.closeInput();
  }

  private CompletableFuture<Integer> drainAfterInputFailure(OwnedProcess process) {
    return CompletableFuture.supplyAsync(
        () -> {
          try {
            try {
              // Wait outside the job monitor: stdout/stderr callbacks acquire it.
              return process.completion().get(500, TimeUnit.MILLISECONDS);
            } catch (TimeoutException ignored) {
              // A CLI that closes stdin but stays alive must not strand the job.
              process.stop(Duration.ofMillis(500), Duration.ofMillis(700));
              return process.completion().get(700, TimeUnit.MILLISECONDS);
            }
          } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new CompletionException(error);
          } catch (Exception error) {
            throw new CompletionException(error);
          }
        },
        completions);
  }

  private void append(Job job, String field, String value) {
    synchronized (job) {
      if (field.equals("output") && job.outputStream != null) job.outputStream.append(value);
      job.data.put(
          field + "Cursor", ((Number) job.data.get(field + "Cursor")).longValue() + value.length());
      job.data.put(field, tail(text(job.data.get(field)) + value, MAX_OUTPUT));
      if (field.equals("output") && text(job.data.get("cliSessionId")).isEmpty()) {
        job.probe = tail(job.probe + value, 40000);
        job.data.put("cliSessionId", extractSession(text(job.data.get("provider")), job.probe));
      }
    }
  }

  private void captureRolloutUsage(Job job) {
    CodexRolloutUsage observer;
    synchronized (job) {
      observer = job.rolloutUsage;
      job.rolloutUsage = null;
    }
    if (observer == null) return;
    try {
      // Finalization calls this without the job monitor so polling can read the final projection
      // during a large accounting scan. A missing-session retry retains its outer attempt lock.
      var usage = observer.finish();
      synchronized (job) {
        job.tokenUsage.recordCodexRollout(usage);
      }
    } catch (RuntimeException ignored) {
      // Optional numeric accounting must never prevent response persistence or cancellation.
    }
  }

  private void finish(Job job, Integer exitCode, Throwable error) {
    if (!job.finalized.compareAndSet(false, true)) return;
    synchronized (job) {
      if (job.outputStream != null) job.outputStream.finish();
      job.data.putAll(
          fields("exitCode", exitCode, "completedAt", now(), "completionPending", true));
      if (job.stopping) job.data.put("status", "cancelled");
      else {
        job.data.put("status", exitCode != null && exitCode == 0 ? "completed" : "failed");
        var failure =
            exitCode != null && exitCode == 0
                ? Map.<String, Object>of()
                : classifyFailure(text(job.data.get("output")), text(job.data.get("error")));
        if (!failure.isEmpty()) {
          job.data.put("providerAvailability", failure);
          job.data.put(
              "failure",
              fields(
                  "code",
                  failure.get("code"),
                  "message",
                  failure.get("message"),
                  "resetHint",
                  failure.get("resetHint")));
        } else if (exitCode != null && exitCode == 0) {
          job.data.put(
              "providerAvailability",
              fields(
                  "status",
                  "available",
                  "canRun",
                  true,
                  "message",
                  "Last request succeeded",
                  "resetHint",
                  "",
                  "source",
                  "last-run",
                  "checkedAt",
                  now()));
          job.data.put("failure", null);
        }
      }
    }
    try {
      captureRolloutUsage(job);
      synchronized (job) {
        job.tokenUsage.finish(job.stopping);
      }
      Map<String, Object> snapshot = snapshot(job);
      if (!job.purged && snapshot.get("providerAvailability") != null) {
        var availability = obj(snapshot.get("providerAvailability"));
        health.record(
            text(snapshot.get("provider")),
            new ProviderAvailability(
                text(availability.get("status")),
                truth(availability.get("canRun")),
                text(availability.get("message")),
                text(availability.get("resetHint")),
                text(availability.get("source")),
                text(availability.get("checkedAt"))));
      }
      if (!job.purged && !truth(snapshot.get("systemJob"))) {
        String response = AgentTaskOutput.response(snapshot, mapper, true);
        if (!job.purged) tasks.completeAgentJob(snapshot);
      }
    } catch (RuntimeException failure) {
      synchronized (job) {
        job.data.put(
            "completionError", Objects.toString(failure.getMessage(), "Could not finalize task"));
      }
    } finally {
      synchronized (job) {
        job.data.put("completionPending", false);
      }
      Map<String, Object> completed = snapshot(job);
      if (!job.purged)
        for (var listener : listeners)
          try {
            listener.accept(completed);
          } catch (RuntimeException failure) {
            synchronized (job) {
              job.data.put(
                  "listenerError",
                  Objects.toString(failure.getMessage(), "Completion listener failed"));
            }
          }
      job.completion.complete(snapshot(job));
    }
  }

  public Map<String, Object> stop(String id) {
    return stop(id, CancellationRequest.internal(CancellationRequest.Cause.INTERNAL_STOP));
  }

  public Map<String, Object> stop(String id, CancellationRequest request) {
    Job job = require(id);
    OwnedProcess process;
    Map<String, Object> cancellation;
    synchronized (job) {
      process = job.process;
      if (job.finalized.get()
          || !Set.of("starting", "running", "paused").contains(text(job.data.get("status"))))
        return snapshot(job);
      cancellation = acceptCancellation(job, request);
      job.data.put("cancellationAuditPersisted", auditCancellation(cancellation));
    }
    if (process != null)
      completions.execute(
          () -> {
            try {
              process.stop(Duration.ofMillis(1500), Duration.ofMillis(700));
            } catch (RuntimeException error) {
              synchronized (job) {
                job.data.put(
                    "stopError", Objects.toString(error.getMessage(), "Could not stop CLI"));
              }
            }
          });
    return snapshot(job);
  }

  /** Called with the job lock held; the first accepted stop owns its provenance. */
  private Map<String, Object> acceptCancellation(Job job, CancellationRequest request) {
    if (job.stopping) return obj(job.data.get("cancellation"));
    var cancellation = request.provenance(text(job.data.get("id")), "");
    job.stopping = true;
    job.data.putAll(
        fields(
            "stopRequested",
            true,
            "completionPending",
            true,
            "status",
            "cancelled",
            "completedAt",
            now(),
            "cancellation",
            cancellation));
    return cancellation;
  }

  /** Logging is best effort and must never prevent an accepted cancellation. */
  public boolean auditCancellation(Map<String, Object> cancellation) {
    try {
      cancellationAudit.record(cancellation);
      return true;
    } catch (RuntimeException error) {
      return false;
    }
  }

  public List<Map<String, Object>> cancellations(int limit) {
    return cancellationAudit.list(limit);
  }

  public Map<String, Object> pause(String id) {
    Job job = require(id);
    synchronized (job) {
      if (job.process != null
          && Set.of("starting", "running").contains(text(job.data.get("status")))) {
        job.process.pause();
        job.data.put("status", "paused");
      }
      return snapshot(job);
    }
  }

  public Map<String, Object> resume(String id) {
    Job job = require(id);
    synchronized (job) {
      if (job.process != null && "paused".equals(job.data.get("status"))) {
        job.process.resume();
        job.data.put("status", "running");
      }
      return snapshot(job);
    }
  }

  public void stopAll() {
    List<Job> selected;
    synchronized (this) {
      closing = true;
      selected = new ArrayList<>(jobs.values());
    }
    stopAndDrain(
        selected, CancellationRequest.internal(CancellationRequest.Cause.APPLICATION_SHUTDOWN));
  }

  private void stopAndDrain(List<Job> selected, CancellationRequest request) {
    var errors = new ArrayList<RuntimeException>();
    for (var job : selected) {
      Map<String, Object> cancellation;
      synchronized (job) {
        if (job.finalized.get()
            || !Set.of("starting", "running", "paused", "cancelled")
                .contains(text(job.data.get("status")))) continue;
        boolean firstStop = !job.stopping;
        cancellation = acceptCancellation(job, request);
        if (firstStop) job.data.put("cancellationAuditPersisted", auditCancellation(cancellation));
      }
      if (job.process != null)
        try {
          job.process.stop(Duration.ofMillis(1500), Duration.ofMillis(700));
        } catch (RuntimeException error) {
          errors.add(error);
        }
    }
    for (var job : selected)
      try {
        job.completion.get(5, TimeUnit.SECONDS);
      } catch (Exception error) {
        errors.add(
            new IllegalStateException(
                "Argus agent completion did not finish before shutdown", error));
      }
    if (!errors.isEmpty()) {
      var error = errors.remove(0);
      errors.forEach(error::addSuppressed);
      throw error;
    }
  }

  public Map<String, Object> purgeRepositories(List<String> ids) {
    return stopRepositories(ids, true);
  }

  /** Stop work normally so completion persists partial output and session metadata. */
  public Map<String, Object> disconnectRepositories(List<String> ids) {
    return stopRepositories(ids, false);
  }

  private Map<String, Object> stopRepositories(List<String> ids, boolean purge) {
    List<Job> selected;
    synchronized (this) {
      retiredRepositories.addAll(ids);
      ids.forEach(id -> repositoryGenerations.merge(id, 1L, Long::sum));
      selected =
          jobs.values().stream()
              .filter(
                  job ->
                      AgentExecutionService.<String>list(job.data.get("repositoryIds")).stream()
                          .anyMatch(ids::contains))
              .toList();
      if (purge) for (var job : selected) job.purged = true;
    }
    stopAndDrain(
        selected, CancellationRequest.internal(CancellationRequest.Cause.REPOSITORY_REMOVED));
    synchronized (this) {
      if (purge) selected.forEach(job -> jobs.remove(text(job.data.get("id"))));
    }
    return Map.of(purge ? "agentJobsPurged" : "agentJobsRetained", selected.size());
  }

  private void validateConnected(List<Map<String, Object>> repositories) {
    if (workspace == null) return;
    for (var repository : repositories) {
      var current = workspace.requireRepository(text(repository.get("id")));
      String generation = text(repository.get("addedAt"));
      if (!generation.isEmpty() && !generation.equals(current.addedAt()))
        throw new IllegalStateException("A selected repository connection has changed");
    }
  }

  public synchronized void releaseRetiredRepositories(List<String> ids) {
    retiredRepositories.removeAll(ids);
  }

  @Override
  public void close() {
    stopAll();
    completions.shutdown();
  }

  public static boolean missingSession(String output, String error) {
    return Pattern.compile(
            "no (?:saved )?(?:session|conversation|rollout)(?: was)? found|no rollout found for"
                + " thread|(?:session|thread|conversation).{0,80}(?:not found|does not exist|no"
                + " longer exists|invalid|expired|failed to (?:load|resume)|cannot"
                + " (?:load|resume))",
            Pattern.CASE_INSENSITIVE)
        .matcher(output + "\n" + error)
        .find();
  }

  public String extractSession(String provider, String output) {
    List<String> keys =
        provider.equals("codex")
            ? List.of("thread_id", "session_id")
            : List.of("session_id", "thread_id");
    for (var event : AgentTaskOutput.events(output, mapper)) {
      String found = findSession(event, keys);
      if (!found.isEmpty()) return found;
    }
    for (String key : keys) {
      var matcher =
          Pattern.compile("\"" + key + "\"\\s*:\\s*\"([0-9a-f-]{36,})\"", Pattern.CASE_INSENSITIVE)
              .matcher(output);
      if (matcher.find()) return matcher.group(1);
    }
    return "";
  }

  private String findSession(Object value, List<String> keys) {
    if (value instanceof Map<?, ?> map) {
      for (String key : keys) {
        String candidate = text(map.get(key));
        if (candidate.matches("(?i)[0-9a-f]{8}-[0-9a-f-]{27,}")) return candidate;
      }
      for (Object nested : map.values()) {
        String result = findSession(nested, keys);
        if (!result.isEmpty()) return result;
      }
    } else if (value instanceof List<?> list)
      for (Object nested : list) {
        String result = findSession(nested, keys);
        if (!result.isEmpty()) return result;
      }
    return "";
  }

  public List<Map<String, Object>> suggestions(String output) {
    var candidates = new ArrayList<String>();
    candidates.add(output);
    for (var event : AgentTaskOutput.events(output, mapper)) strings(event, candidates);
    var seen = new LinkedHashMap<String, Map<String, Object>>();
    var pattern = Pattern.compile("```argus-api-request\\s*([\\s\\S]*?)```");
    for (String candidate : candidates) {
      var matcher = pattern.matcher(candidate);
      while (matcher.find())
        try {
          Object parsed = mapper.readValue(matcher.group(1).trim(), Object.class);
          for (Object request : parsed instanceof List<?> list ? list : List.of(parsed))
            if (request instanceof Map)
              seen.putIfAbsent(mapper.writeValueAsString(request), obj(request));
        } catch (RuntimeException ignored) {
        }
    }
    return new ArrayList<>(seen.values());
  }

  private void strings(Object value, List<String> result) {
    if (value instanceof String text) result.add(text);
    else if (value instanceof Map<?, ?> map) map.values().forEach(item -> strings(item, result));
    else if (value instanceof List<?> list) list.forEach(item -> strings(item, result));
  }

  public static Map<String, Object> classifyFailure(String output, String error) {
    return ProviderFailureClassifier.classify(output, error);
  }
}
