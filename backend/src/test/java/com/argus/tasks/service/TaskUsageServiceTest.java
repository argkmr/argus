package com.argus.tasks.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.agents.service.ProviderCostEstimate;
import com.argus.platform.RestoreMaintenanceGate;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskMessage;
import com.argus.tasks.repository.TaskRepository;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class TaskUsageServiceTest {
  @TempDir Path home;
  final ObjectMapper mapper = new ObjectMapper();
  final TaskRepository tasks = mock(TaskRepository.class);
  final RestoreMaintenanceGate gate = new RestoreMaintenanceGate();
  final String thread = "12345678-1234-1234-1234-123456789abc";
  AiTask task;
  TaskMessage message;
  TaskUsageService service;

  @BeforeEach
  void setup() {
    task = new AiTask();
    task.id = "task";
    message = new TaskMessage();
    message.id = "message";
    message.role = "assistant";
    message.status = "completed";
    message.execution =
        fields(
            "provider",
            "codex",
            "model",
            "gpt-5.6-sol",
            "speed",
            "standard",
            "startedAt",
            "2026-09-18T10:00:00Z",
            "completedAt",
            "2026-09-18T10:00:10Z");
    task.messages.add(message);
    task.additionalProperties().put("cliSessions", fields("codex", fields("id", thread)));
    when(tasks.get("task")).thenReturn(task);
    service = new TaskUsageService(tasks, mapper, home, gate);
  }

  @AfterEach
  void close() {
    service.close();
  }

  Path rollout() throws Exception {
    Path file = home.resolve("sessions/2026/09/18/rollout-fixture-" + thread + ".jsonl");
    Files.createDirectories(file.getParent());
    var events =
        List.of(
            fields("type", "session_meta", "payload", fields("id", thread)),
            fields(
                "timestamp",
                "2026-09-18T10:00:01Z",
                "type",
                "event_msg",
                "payload",
                fields("type", "task_started", "turn_id", "turn")),
            fields(
                "type",
                "token_usage_record",
                "payload",
                fields(
                    "thread_id",
                    thread,
                    "turn_id",
                    "turn",
                    "response_id",
                    "response",
                    "usage",
                    fields(
                        "input_tokens",
                        1000,
                        "cached_input_tokens",
                        900,
                        "cache_write_input_tokens",
                        0,
                        "output_tokens",
                        100,
                        "total_tokens",
                        1100))),
            fields(
                "timestamp",
                "2026-09-18T10:00:09Z",
                "type",
                "event_msg",
                "payload",
                fields("type", "task_complete", "turn_id", "turn")));
    var content = new StringBuilder();
    for (var event : events) content.append(mapper.writeValueAsString(event)).append('\n');
    Files.writeString(file, content);
    return file;
  }

  @Test
  void recoversCreditsReadOnlyAndReusesBoundedCache() throws Exception {
    message.execution.put("effort", "ultra");
    Path file = rollout();
    String original = Files.readString(file);
    var response = service.usage("task", "message").get(5, TimeUnit.SECONDS);
    var usage = obj(response.get("tokenUsage"));
    assertThat(response).containsEntry("recovered", true);
    assertThat(usage)
        .containsEntry("reported", true)
        .containsEntry("totalTokens", 1100L)
        .containsEntry("status", "partial")
        .containsEntry("exact", false);
    assertThat(obj(usage.get("costEstimate")))
        .containsEntry("amount", "0.069")
        .containsEntry("effort", "ultra")
        .containsEntry("actualCharge", false)
        .containsEntry("status", "partial");
    assertThat(service.usage("task", "message").get(5, TimeUnit.SECONDS)).isSameAs(response);
    assertThat(Files.readString(file)).isEqualTo(original);
    assertThat(message.execution).doesNotContainKey("tokenUsage");
    verify(tasks, never()).save(any());
    assertThat(gate.activeRequests()).isZero();
  }

  @Test
  void historicalEffortIsUnknownInsteadOfUsingTheTasksCurrentPreference() throws Exception {
    task.effort = "ultra";
    rollout();
    var response = service.usage("task", "message").get(5, TimeUnit.SECONDS);
    assertThat(obj(obj(response.get("tokenUsage")).get("costEstimate")))
        .containsEntry("effort", "")
        .containsEntry("amount", "0.069");
  }

  @Test
  void leavesExistingMeasuredUsageUntouched() throws Exception {
    var saved = fields("reported", true, "totalTokens", 42, "status", "partial");
    message.execution.put("tokenUsage", saved);
    var response = service.usage("task", "message").get(5, TimeUnit.SECONDS);
    assertThat(response).containsEntry("recovered", false).containsEntry("recalculated", true);
    var refreshed = obj(response.get("tokenUsage"));
    assertThat(refreshed).containsAllEntriesOf(saved);
    assertThat(obj(refreshed.get("costEstimate"))).containsEntry("status", "unavailable");
    assertThat(message.execution.get("tokenUsage")).isSameAs(saved);
    assertThat(saved).doesNotContainKey("costEstimate");
    verify(tasks, never()).save(any());
  }

  @Test
  void refreshesScreenshotCreditsWithoutChangingStoredTokensOrReadingRollouts() throws Exception {
    message.execution.put("model", "gpt-6-sol");
    message.execution.put("speed", "fast");
    message.execution.put("effort", "xhigh");
    var oldCost = fields("status", "unavailable", "amount", null, "rateCardDate", "2026-09-19");
    var saved =
        fields(
            "reported",
            true,
            "status",
            "partial",
            "exact",
            false,
            "source",
            "codex.rollout.token_usage_record",
            "coverage",
            "recorded-responses-only",
            "inputTokens",
            1048840L,
            "uncachedInputTokens",
            16392L,
            "cachedInputTokens",
            1032448L,
            "cacheCreationInputTokens",
            0L,
            "outputTokens",
            5007L,
            "reasoningOutputTokens",
            2857L,
            "totalTokens",
            1053847L,
            "costEstimate",
            oldCost);
    message.execution.put("tokenUsage", saved);
    String original = mapper.writeValueAsString(message);
    var response = service.usage("task", "message").get(5, TimeUnit.SECONDS);
    var refreshed = obj(response.get("tokenUsage"));
    var cost = obj(refreshed.get("costEstimate"));
    assertThat(cost)
        .containsEntry("amount", "14.46718")
        .containsEntry("rateCardDate", ProviderCostEstimate.RATE_CARD_DATE)
        .containsEntry("status", "partial")
        .containsEntry("actualCharge", false)
        .containsEntry("model", "gpt-6-sol")
        .containsEntry("speed", "fast")
        .containsEntry("valuation", "current-rate-equivalent");
    var unchanged = new LinkedHashMap<String, Object>(refreshed);
    unchanged.put("costEstimate", oldCost);
    assertThat(unchanged).isEqualTo(saved);
    assertThat(mapper.writeValueAsString(message)).isEqualTo(original);
    try (var files = Files.list(home)) {
      assertThat(files.count()).isZero();
    }
    verify(tasks, never()).save(any());
  }

  @Test
  void repricingUsesOnlyHistoricalSettingsNeverCurrentTaskPreferences() throws Exception {
    task.model = "gpt-6-astra";
    task.speed = "fast";
    task.effort = "ultra";
    message.execution.remove("model");
    message.execution.remove("speed");
    var saved =
        fields(
            "reported",
            true,
            "totalTokens",
            42L,
            "status",
            "partial",
            "costEstimate",
            fields("model", "gpt-6-sol", "speed", "standard", "effort", "low"));
    message.execution.put("tokenUsage", saved);
    var result =
        obj(
            obj(service.usage("task", "message").get(5, TimeUnit.SECONDS).get("tokenUsage"))
                .get("costEstimate"));
    assertThat(result)
        .containsEntry("model", "gpt-6-sol")
        .containsEntry("speed", "standard")
        .containsEntry("effort", "low");
    saved.remove("costEstimate");
    result =
        obj(
            obj(service.usage("task", "message").get(5, TimeUnit.SECONDS).get("tokenUsage"))
                .get("costEstimate"));
    assertThat(result)
        .containsEntry("model", "")
        .containsEntry("speed", "")
        .containsEntry("status", "unavailable");
  }

  @Test
  void doesNotGuessCancelledLiveRetryOrWrongThreadUsage() throws Exception {
    rollout();
    for (String status : List.of("running", "cancelled", "failed")) {
      message.status = status;
      assertThat(service.usage("task", "message").get(5, TimeUnit.SECONDS))
          .containsEntry("recovered", false);
    }
    message.status = "completed";
    message.execution.put("cliSessionFallback", true);
    var retried = service.usage("task", "message").get(5, TimeUnit.SECONDS);
    assertThat(retried).containsEntry("recovered", false);
    assertThat(obj(retried.get("tokenUsage")).get("detail").toString()).contains("retried");
    message.execution.remove("cliSessionFallback");
    message.execution.put("cliSessionId", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    assertThat(service.usage("task", "message").get(5, TimeUnit.SECONDS))
        .containsEntry("recovered", false);
  }

  @Test
  void closeInterruptsActiveReadAndDrainsQueuedReadLeases() throws Exception {
    var started = new CountDownLatch(1);
    var interrupted = new AtomicBoolean();
    when(tasks.get("task"))
        .thenAnswer(
            call -> {
              started.countDown();
              try {
                new CountDownLatch(1).await();
                throw new AssertionError("Read should be cancelled by shutdown");
              } catch (InterruptedException expected) {
                interrupted.set(true);
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Read cancelled", expected);
              }
            });
    var active = service.usage("task", "message");
    assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
    var queued = service.usage("task", "message");
    service.close();
    assertThat(active).isCompletedExceptionally();
    assertThat(queued).isCompletedExceptionally();
    assertThat(interrupted).isTrue();
    assertThat(gate.activeRequests()).isZero();
    verify(tasks, times(1)).get("task");
  }

  @Test
  void restoreRejectsNewReadsAndCloseReleasesLeases() throws Exception {
    rollout();
    gate.beginRestore();
    assertThatThrownBy(() -> service.usage("task", "message")).hasMessageContaining("restore");
    assertThat(gate.activeRequests()).isZero();
    verifyNoInteractions(tasks);
  }
}
