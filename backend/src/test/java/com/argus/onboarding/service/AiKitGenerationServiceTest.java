package com.argus.onboarding.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.agents.dto.AgentProvider;
import com.argus.agents.service.AgentExecutionService;
import com.argus.agents.service.AgentProviderService;
import com.argus.background.service.*;
import com.argus.common.config.ArgusProperties;
import com.argus.common.process.CommandResult;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.repositorycontext.service.*;
import com.argus.repositorycontext.service.ProductionRepositorySnapshotService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class AiKitGenerationServiceTest {
  @TempDir Path root;

  @Test
  void startupAndAutomaticRequestsNeverInvokeAProvider() throws Exception {
    var mapper = new ObjectMapper();
    var properties = new ArgusProperties(root.resolve("manual-data"), root, "test", "");
    var json = new AtomicJsonStore(mapper);
    var workspace = mock(WorkspaceService.class);
    var providers = mock(AgentProviderService.class);
    var agents = mock(AgentExecutionService.class);
    var jobs = new BackgroundJobService(json, properties);
    var queue = new AiKitRefreshQueue(json, properties);
    var repository = new Repository("manual", "fixture", root.toString(), "now", "main");
    try (var service =
        new AiKitGenerationService(
            workspace,
            jobs,
            new BackgroundOperationService(jobs),
            queue,
            providers,
            agents,
            null,
            null,
            null,
            null,
            json,
            mapper,
            true)) {
      service.ready();
      assertThat(service.request(List.of(repository), "automatic", true, Map.of())).isNull();
      assertThat(jobs.list()).isEmpty();
      verifyNoInteractions(providers, agents, workspace);
    }
  }

  @Test
  void queuedRepositoryCanBePausedWithoutPausingAnotherRepository() throws Exception {
    var mapper = new ObjectMapper();
    var properties = new ArgusProperties(root.resolve("queued-data"), root, "test", "");
    var json = new AtomicJsonStore(mapper);
    var repository = new Repository("pending", "fixture", root.toString(), "now", "main");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository(repository.id())).thenReturn(repository);
    var jobs = new BackgroundJobService(json, properties);
    var queue = new AiKitRefreshQueue(json, properties);
    queue.load();
    var other =
        jobs.create(
            object("type", "ai-kit-generation", "items", List.of(object("repositoryId", "other"))));
    queue.request(List.of("other"), false, Map.of());
    queue.claim(text(other, "id"), List.of("other"));
    var providers = mock(AgentProviderService.class);
    var contexts = mock(RepositoryContextService.class);
    when(contexts.artifactRoot(repository)).thenReturn(root.resolve("empty-kit"));
    try (var service =
        new AiKitGenerationService(
            workspace,
            jobs,
            new BackgroundOperationService(jobs),
            queue,
            providers,
            mock(AgentExecutionService.class),
            null,
            contexts,
            null,
            null,
            json,
            mapper,
            false)) {
      service.control(repository.id(), "start");
      assertThat(map(service.repositoryStatus(repository.id()).get("job")))
          .containsEntry("status", "queued");
      assertThat(map(service.control(repository.id(), "pause").get("job")))
          .containsEntry("status", "paused");
      assertThat(jobs.get(text(other, "id"))).containsEntry("status", "queued");
      assertThat(map(service.control(repository.id(), "resume").get("job")))
          .containsEntry("status", "queued");
      verifyNoInteractions(providers);
    }
  }

  @Test
  void brokenTerminalCardDoesNotStrandDurableRefreshClaim() throws Exception {
    var mapper = new ObjectMapper();
    var properties = new ArgusProperties(root.resolve("data"), root, "test", "");
    var json = new AtomicJsonStore(mapper);
    var repository = new Repository("repo-a", "fixture", root.toString(), "now", "main");
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, repository.id(), Map.of(), List.of(repository), List.of(), List.of(), Map.of()));
    var providers = mock(AgentProviderService.class);
    when(providers.providers(true)).thenReturn(List.of());
    var jobs = spy(new BackgroundJobService(json, properties));
    doAnswer(
            call -> {
              var job = map(call.callRealMethod());
              if ("failed".equals(job.get("status")))
                throw new IllegalStateException("card unavailable");
              return job;
            })
        .when(jobs)
        .get(anyString());
    var queue = spy(new AiKitRefreshQueue(json, properties));
    var finished = new CountDownLatch(1);
    doAnswer(
            call -> {
              Object result = call.callRealMethod();
              finished.countDown();
              return result;
            })
        .when(queue)
        .finish(anyString(), anyList());
    var service =
        new AiKitGenerationService(
            workspace,
            jobs,
            new BackgroundOperationService(jobs),
            queue,
            providers,
            mock(AgentExecutionService.class),
            null,
            null,
            null,
            null,
            json,
            mapper,
            false);
    try {
      service.request(List.of(repository), null, false, Map.of());
      assertThat(finished.await(3, TimeUnit.SECONDS)).isTrue();
      assertThat(queue.snapshot())
          .containsEntry("active", null)
          .containsEntry("pendingRepositoryIds", List.of());
    } finally {
      service.close();
    }
  }

  @Test
  void validatesThenRepairsExactlyOnceBeforePublishing() throws Exception {
    Path source = Files.createDirectories(root.resolve("source"));
    Files.writeString(
        source.resolve("Controller.java"), "@GetMapping(\"/orders\")\nvoid orders(){}\n");
    var mapper = new ObjectMapper();
    var properties = new ArgusProperties(root.resolve("data"), root, "test", "");
    var json = new AtomicJsonStore(mapper);
    var repository = new Repository("repo-a", "orders", source.toString(), "now", "main");
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, repository.id(), Map.of(), List.of(repository), List.of(), List.of(), Map.of()));
    var providers = mock(AgentProviderService.class);
    when(providers.providers(true))
        .thenReturn(
            List.of(
                new AgentProvider(
                    "codex",
                    "Codex",
                    true,
                    "fixture",
                    "/fixture/codex",
                    true,
                    "fixture",
                    null,
                    true,
                    false,
                    false,
                    "cli",
                    List.of(),
                    "fixture",
                    false,
                    true,
                    false,
                    false,
                    List.of(),
                    List.of(),
                    "fixture")));
    var calls = new java.util.concurrent.atomic.AtomicInteger();
    var agents = mock(AgentExecutionService.class);
    when(agents.completion(anyString()))
        .thenReturn(CompletableFuture.completedFuture(object("status", "completed")));
    when(agents.start(anyMap()))
        .thenAnswer(
            invocation -> {
              var input = map(invocation.getArgument(0));
              int call = calls.incrementAndGet();
              Path staging = Path.of(strings(input.get("skillDirectories")).get(0));
              var inventory =
                  mapper.readValue(
                      Files.readString(staging.resolve("entry-point-inventory.json")),
                      java.util.LinkedHashMap.class);
              Path skill = Files.createDirectories(staging.resolve("skills/order-query"));
              Files.writeString(
                  skill.resolve("SKILL.md"),
                  "---\nname: order-query\ndescription: Query orders safely.\n---\n# Purpose\nRead orders.\n## Entry points\nController.java\n## Flow\nQuery.\n## Validations\nValidate.\n## Dependencies\nStore.\n## Failure behavior\nPropagate.\n## Observability\nLogs.\n## Source files and tests\nController.java\n");
              var entries =
                  call == 1
                      ? List.of()
                      : list(inventory.get("entryPoints")).stream()
                          .map(
                              RuntimeData ->
                                  object(
                                      "entryPointId",
                                      map(RuntimeData).get("id"),
                                      "businessFlow",
                                      "Order query",
                                      "skill",
                                      "order-query",
                                      "evidence",
                                      List.of(map(RuntimeData).get("source"))))
                          .toList();
              Files.writeString(
                  staging.resolve("skill-coverage.json"),
                  mapper.writeValueAsString(
                      object(
                          "schemaVersion",
                          1,
                          "inventoryFingerprint",
                          inventory.get("fingerprint"),
                          "entries",
                          entries)));
              if (call == 2)
                assertThat(text(input, "rawPrompt"))
                    .contains("deterministic validator rejected", "incomplete");
              return object("id", "fixture-" + call);
            });
    var snapshots =
        new ProductionRepositorySnapshotService(
            (command, args, cwd, timeout) -> {
              try {
                if (args.contains("add")) {
                  Path path = Path.of(args.get(args.indexOf("--detach") + 1));
                  Files.createDirectories(path);
                  Files.copy(source.resolve("Controller.java"), path.resolve("Controller.java"));
                }
                if (args.contains("remove"))
                  RepositoryContextService.deleteTree(Path.of(args.get(args.size() - 1)));
              } catch (Exception error) {
                throw new IllegalStateException(error);
              }
              return new CommandResult("abcdef0123456789\n", "", 0);
            },
            properties);
    var jobs = new BackgroundJobService(json, properties);
    var queue = new AiKitRefreshQueue(json, properties);
    var coverage = new AiKitCoverageService(mapper);
    var contexts = new RepositoryContextService(properties, json, mapper, coverage);
    var service =
        new AiKitGenerationService(
            workspace,
            jobs,
            new BackgroundOperationService(jobs),
            queue,
            providers,
            agents,
            snapshots,
            contexts,
            coverage,
            (command, args, cwd, timeout) -> new CommandResult("abcdef0123456789\n", "", 0),
            json,
            mapper,
            false);
    try {
      var queued = service.request(List.of(repository), null, false, Map.of());
      String id = text(queued, "id");
      assertThat(list(queued.get("items"))).hasSize(1);
      assertThat(map(list(queued.get("items")).get(0)))
          .containsEntry("repositoryId", repository.id())
          .containsEntry("name", repository.name())
          .containsEntry("status", "queued");
      service.completion(id).get(5, TimeUnit.SECONDS);
      assertThat(calls).hasValue(2);
      assertThat(jobs.get(id)).containsEntry("status", "completed");
      assertThat(map(list(jobs.get(id).get("items")).get(0)))
          .containsEntry("repositoryId", repository.id())
          .containsEntry("name", repository.name())
          .containsEntry("status", "completed")
          .containsEntry("skillCount", 1);
      assertThat(contexts.artifactStatus(List.of(repository)).get(0))
          .containsEntry("privateReady", true)
          .containsEntry("coveredEntryPoints", 1L);
      assertThat(Files.readString(source.resolve("Controller.java"))).contains("@GetMapping");
    } finally {
      service.close();
    }
  }

  @Test
  void pausedShutdownDrainsAgentBeforeClosingSnapshotAndRetainsDurableClaim() throws Exception {
    Path source = Files.createDirectories(root.resolve("source"));
    Files.writeString(
        source.resolve("Controller.java"), "@GetMapping(\"/orders\")\nvoid orders(){}\n");
    var mapper = new ObjectMapper();
    var properties = new ArgusProperties(root.resolve("data"), root, "test", "");
    var json = new AtomicJsonStore(mapper);
    var repository = new Repository("repo-a", "orders", source.toString(), "now", "main");
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, repository.id(), Map.of(), List.of(repository), List.of(), List.of(), Map.of()));
    var providers = mock(AgentProviderService.class);
    var provider =
        new AgentProvider(
            "codex",
            "Codex",
            true,
            "fixture",
            "/fixture/codex",
            true,
            "fixture",
            null,
            true,
            false,
            false,
            "cli",
            List.of(),
            "fixture",
            false,
            true,
            false,
            false,
            List.of(),
            List.of(),
            "fixture");
    when(providers.providers(true)).thenReturn(List.of(provider));
    var agents = mock(AgentExecutionService.class);
    var agentDone = new CompletableFuture<Map<String, Object>>();
    var started = new CountDownLatch(1);
    when(agents.start(anyMap()))
        .thenAnswer(
            invocation -> {
              assertThat(map(invocation.getArgument(0))).containsEntry("systemJob", true);
              started.countDown();
              return object("id", "agent-fixture");
            });
    when(agents.completion("agent-fixture")).thenReturn(agentDone);
    when(agents.stop(eq("agent-fixture"), any(com.argus.agents.domain.CancellationRequest.class)))
        .thenAnswer(
            invocation -> {
              agentDone.complete(object("status", "cancelled"));
              return object("status", "cancelled");
            });
    var closed = new CountDownLatch(1);
    var snapshots =
        new ProductionRepositorySnapshotService(
            (command, args, cwd, timeout) -> {
              if (args.contains("add"))
                try {
                  Path path = Path.of(args.get(args.indexOf("--detach") + 1));
                  Files.createDirectories(path);
                  Files.copy(source.resolve("Controller.java"), path.resolve("Controller.java"));
                } catch (Exception error) {
                  throw new IllegalStateException(error);
                }
              if (args.contains("remove")) {
                assertThat(agentDone).isCompleted();
                try {
                  RepositoryContextService.deleteTree(Path.of(args.get(args.size() - 1)));
                  closed.countDown();
                } catch (Exception error) {
                  throw new IllegalStateException(error);
                }
              }
              return new CommandResult("abcdef0123456789\\n", "", 0);
            },
            properties);
    var jobs = new BackgroundJobService(json, properties);
    var operations = new BackgroundOperationService(jobs);
    var queue = new AiKitRefreshQueue(json, properties);
    var coverage = new AiKitCoverageService(mapper);
    var contexts = new RepositoryContextService(properties, json, mapper, coverage);
    var service =
        new AiKitGenerationService(
            workspace,
            jobs,
            operations,
            queue,
            providers,
            agents,
            snapshots,
            contexts,
            coverage,
            (command, args, cwd, timeout) -> new CommandResult("abcdef0123456789\n", "", 0),
            json,
            mapper,
            false);
    try {
      var job = service.request(List.of(repository), null, false, Map.of());
      String id = text(job, "id");
      assertThat(started.await(2, TimeUnit.SECONDS)).isTrue();
      operations.pause(id);
      service.close();
      verify(agents, atLeastOnce())
          .stop(eq("agent-fixture"), any(com.argus.agents.domain.CancellationRequest.class));
      assertThat(closed.getCount()).isZero();
      assertThat(queue.snapshot().get("activeRepositoryIds")).isEqualTo(List.of(repository.id()));
      assertThat(Files.exists(contexts.artifactRoot(repository))).isFalse();
    } finally {
      agentDone.complete(object("status", "cancelled"));
      service.close();
    }
  }
}
