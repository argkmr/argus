package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.repository.TaskRepository;
import com.argus.tasks.service.TaskActivityService;
import com.argus.tasks.service.TaskService;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

class NativeModelSelectionParityTest {
  @TempDir Path root;
  final ObjectMapper json = new ObjectMapper();

  @Test
  void explicitUltraSurvivesValidatedResumeArgvWithoutUsingBundledDefault() throws Exception {
    CliProviderAdapter adapter;
    try (var source = getClass().getResourceAsStream("/default-cli-provider-adapters.json")) {
      adapter =
          Arrays.stream(json.readValue(source, CliProviderAdapter[].class))
              .filter(item -> item.id().equals("codex"))
              .findFirst()
              .orElseThrow();
    }
    var metadata =
        fields(
            "id",
            "gpt-6-astra",
            "displayName",
            "GPT-6 Astra",
            "isDefault",
            true,
            "defaultReasoningEffort",
            "low",
            "supportedReasoningEfforts",
            List.of(fields("effort", "low"), fields("effort", "ultra")));
    var catalog = fields("source", "codex-app-server", "models", List.of(metadata));
    var invocations = new CliInvocationService();
    var selected =
        invocations.settings(adapter, catalog, fields("model", "gpt-6-astra", "effort", "ultra"));
    assertThat(selected)
        .isEqualTo(fields("model", "gpt-6-astra", "effort", "ultra", "speed", "standard"));
    var defaults = invocations.settings(adapter, catalog, Map.of());
    assertThat(defaults).containsEntry("model", "gpt-6-astra").containsEntry("effort", "low");
    var input = new LinkedHashMap<>(selected);
    input.putAll(
        fields("sessionId", "chat-1", "prompt", "continue", "workingDirectory", root.toString()));
    var invocation = invocations.invocation(adapter, input, 4173);
    assertThat(invocation.arguments())
        .containsSubsequence(
            "--model",
            "gpt-6-astra",
            "--config",
            "model_reasoning_effort=\"ultra\"",
            "resume",
            "--skip-git-repo-check",
            "chat-1",
            "continue");
    assertThat(invocation.arguments())
        .doesNotContain(adapter.defaultModel(), "model_reasoning_effort=\"low\"");
    for (var unsupported :
        List.of(
            fields("model", "missing"),
            fields("model", "gpt-6-astra", "effort", "max"),
            fields("speed", "fast"))) {
      assertThatThrownBy(() -> invocations.settings(adapter, catalog, unsupported))
          .isInstanceOfSatisfying(
              ResponseStatusException.class,
              error ->
                  assertThat(error.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY));
    }
  }

  @Test
  void repositoryAndNexusPreferencesSurviveConcurrentCompletionRenameAndQueuedSnapshot()
      throws Exception {
    var properties = new ArgusProperties(root, null, "test", "");
    var tasks =
        new TaskService(
            new TaskRepository(properties, new AtomicJsonStore(json), json),
            new TaskActivityService(),
            json);
    var executor = Executors.newFixedThreadPool(3);
    try {
      for (String scope : List.of("repository", "global")) {
        var selected = scope.equals("global") ? List.of("repo-a", "repo-b") : List.of("repo-a");
        var task =
            tasks.create(
                fields(
                    "scope",
                    scope,
                    "repositoryId",
                    scope.equals("global") ? "global" : "repo-a",
                    "repositoryIds",
                    selected,
                    "provider",
                    "codex",
                    "model",
                    "old",
                    "effort",
                    "high"));
        tasks.appendUser(task.id, fields("prompt", "first"), List.of());
        assertThat(tasks.get(task.id).model).isEqualTo("old");
        var barrier = new CyclicBarrier(3);
        Callable<Void> completion =
            () -> {
              barrier.await();
              tasks.completeAgentJob(
                  fields(
                      "id",
                      "job-" + scope,
                      "taskId",
                      task.id,
                      "provider",
                      "codex",
                      "model",
                      "old",
                      "effort",
                      "high",
                      "cliSessionId",
                      "session-" + scope,
                      "repositoryIds",
                      selected,
                      "output",
                      "done",
                      "status",
                      "completed",
                      "startedAt",
                      "2026-09-06T08:00:00.000Z"));
              return null;
            };
        Callable<Void> preferences =
            () -> {
              barrier.await();
              tasks.updateModelSettings(
                  task.id,
                  fields(
                      "provider",
                      "codex",
                      "model",
                      "gpt-6-astra",
                      "effort",
                      "ultra",
                      "speed",
                      "standard"));
              return null;
            };
        Callable<Void> rename =
            () -> {
              barrier.await();
              tasks.rename(task.id, "Renamed chat");
              return null;
            };
        var futures =
            List.of(
                executor.submit(completion), executor.submit(preferences), executor.submit(rename));
        for (var future : futures) future.get(5, TimeUnit.SECONDS);
        tasks.appendUser(
            task.id,
            fields(
                "prompt",
                "queued with older snapshot",
                "provider",
                "codex",
                "model",
                "old",
                "effort",
                "high",
                "preserveSavedModelSettings",
                true),
            List.of());
        var restarted =
            new TaskService(
                new TaskRepository(properties, new AtomicJsonStore(json), json),
                new TaskActivityService(),
                json);
        var restored = restarted.get(task.id);
        assertThat(restored.model).isEqualTo("gpt-6-astra");
        assertThat(restored.effort).isEqualTo("ultra");
        assertThat(restored.speed).isEqualTo("standard");
        assertThat(restored.title).isEqualTo("Renamed chat");
        assertThat(restored.messages).hasSize(3);
        assertThat(restored.repositoryIds).isEqualTo(selected);
        assertThat(restored.completedJobIds).containsExactly("job-" + scope);
        assertThat(restarted.cliSession(task.id, "codex", selected))
            .containsEntry("id", "session-" + scope);
      }
    } finally {
      executor.shutdownNow();
      assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
    }
  }
}
