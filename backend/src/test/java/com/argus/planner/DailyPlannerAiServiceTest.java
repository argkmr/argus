package com.argus.planner;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.background.service.BackgroundJobService;
import com.argus.background.service.BackgroundOperationService;
import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

class DailyPlannerAiServiceTest {
  @TempDir Path directory;
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void proposalDoesNotPersistAnyTasksOrRequireARepository() throws Exception {
    var jobs = jobs();
    var service =
        new DailyPlannerAiService(
            (prompt, date, provider, control) ->
                List.of(Map.of("title", "Check release", "date", date)),
            jobs,
            new BackgroundOperationService(jobs));
    try {
      var started = service.start(input());
      var result = finished(service, started.get("id").toString());
      assertThat(result).containsEntry("status", "completed");
      assertThat((List<?>) result.get("tasks")).hasSize(1);
      assertThat(directory.resolve("daily-planner.json")).doesNotExist();
      assertThat(directory.resolve("workspace.json")).doesNotExist();
      assertThat(jobs.list())
          .singleElement()
          .satisfies(
              job ->
                  assertThat(job)
                      .containsEntry("status", "completed")
                      .containsEntry("type", "daily-planner-ai"));
    } finally {
      service.quiesce();
    }
  }

  @Test
  void cancellationStopsAdmissionUntilWorkerExitsAndNeverReturnsItsTasks() throws Exception {
    var entered = new CountDownLatch(1);
    var exit = new CountDownLatch(1);
    var jobs = jobs();
    var service =
        new DailyPlannerAiService(
            (prompt, date, provider, control) -> {
              entered.countDown();
              exit.await(3, TimeUnit.SECONDS);
              return List.of(Map.of("title", "Late result"));
            },
            jobs,
            new BackgroundOperationService(jobs));
    try {
      String id = service.start(input()).get("id").toString();
      assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
      assertThatThrownBy(() -> service.start(input())).isInstanceOf(ResponseStatusException.class);
      assertThat(service.cancel(id)).containsEntry("status", "cancelled");
      exit.countDown();
      assertThat(finished(service, id)).containsEntry("status", "cancelled");
      assertThat((List<?>) service.get(id).get("tasks")).isEmpty();
    } finally {
      exit.countDown();
      service.quiesce();
    }
  }

  @Test
  void validatesRequestsBeforeStartingAnAiJob() {
    var jobs = jobs();
    var service =
        new DailyPlannerAiService(
            (prompt, date, provider, control) -> {
              throw new AssertionError("must not execute");
            },
            jobs,
            new BackgroundOperationService(jobs));
    try {
      assertThatThrownBy(
              () -> service.start(Map.of("prompt", "", "date", "2026-09-22", "provider", "codex")))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(
              () -> service.start(Map.of("prompt", "x", "date", "bad", "provider", "codex")))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(
              () -> service.start(Map.of("prompt", "x", "date", "2026-09-22", "provider", "shell")))
          .isInstanceOf(IllegalArgumentException.class);
      assertThat(jobs.list()).isEmpty();
      service.quiesce();
      assertThatThrownBy(() -> service.start(input())).isInstanceOf(ResponseStatusException.class);
    } finally {
      service.quiesce();
    }
  }

  @Test
  void boundsAndSanitizesStructuredProposalsAndPinsTheirSelectedDate() {
    var result =
        DailyPlannerAiRunner.parseTasks(
            "```json\n{\"tasks\":[{\"title\":\" Ship fix \",\"notes\":\"Run tests\",\"date\":\"1900-01-01\",\"command\":\"rm -rf x\"}]}\n```",
            "2026-09-22",
            mapper);
    assertThat(result)
        .containsExactly(Map.of("title", "Ship fix", "notes", "Run tests", "date", "2026-09-22"));
    for (String invalid :
        List.of("hello", "{}", "{\"tasks\":[]}", "{\"tasks\":[{\"title\":\" \"}]}"))
      assertThatThrownBy(() -> DailyPlannerAiRunner.parseTasks(invalid, "2026-09-22", mapper))
          .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void providerFailureIsBoundedAndDoesNotExposeSecrets() throws Exception {
    var jobs = jobs();
    var service =
        new DailyPlannerAiService(
            (prompt, date, provider, control) -> {
              throw new IllegalStateException("secret-token");
            },
            jobs,
            new BackgroundOperationService(jobs));
    try {
      var result = finished(service, service.start(input()).get("id").toString());
      assertThat(result).containsEntry("status", "failed");
      assertThat(result.get("error").toString()).doesNotContain("secret-token");
    } finally {
      service.quiesce();
    }
  }

  @Test
  void completedPreviewIsNotPublishedUntilTheOwnedChildIsCleanedUp() throws Exception {
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    var run = new CountDownLatch(1);
    var child = mock(DailyPlannerAiService.Control.Child.class);
    doAnswer(
            call -> {
              entered.countDown();
              assertThat(release.await(3, TimeUnit.SECONDS)).isTrue();
              return null;
            })
        .when(child)
        .close();
    var jobs = jobs();
    var service =
        new DailyPlannerAiService(
            (prompt, date, provider, control) -> {
              run.await(3, TimeUnit.SECONDS);
              control.attach(child);
              return List.of(Map.of("title", "Draft only"));
            },
            jobs,
            new BackgroundOperationService(jobs));
    String id = service.start(input()).get("id").toString();
    try {
      run.countDown();
      assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
      // cleanup holds the control lock: snapshots wait until cleanup is known safe.
      var snapshot = CompletableFuture.supplyAsync(() -> service.get(id));
      assertThat(snapshot.isDone()).isFalse();
      assertThat(jobs.get(id)).containsEntry("status", "running");
      release.countDown();
      assertThat(finished(service, id)).containsEntry("status", "completed");
      snapshot.get(2, TimeUnit.SECONDS);
    } finally {
      release.countDown();
      service.quiesce();
    }
  }

  @Test
  void failedCleanupRetainsTheChildAndAdmissionUntilExplicitCancellationRetriesIt()
      throws Exception {
    var child = mock(DailyPlannerAiService.Control.Child.class);
    doThrow(new IllegalStateException("still alive")).doNothing().when(child).close();
    var jobs = jobs();
    var service =
        new DailyPlannerAiService(
            (prompt, date, provider, control) -> {
              control.attach(child);
              return List.of(Map.of("title", "Must not leak"));
            },
            jobs,
            new BackgroundOperationService(jobs));
    try {
      String id = service.start(input()).get("id").toString();
      assertThat(finished(service, id)).containsEntry("status", "failed");
      assertThat(service.get(id)).containsEntry("cleanupRequired", true);
      assertThat((List<?>) service.get(id).get("tasks")).isEmpty();
      assertThatThrownBy(() -> service.start(input())).isInstanceOf(ResponseStatusException.class);
      assertThat(service.cancel(id)).containsEntry("status", "cancelled");
      assertThat(service.get(id)).containsEntry("cleanupRequired", false);
      verify(child, atLeastOnce()).stop(any(), any());
      verify(child, times(2)).close();
      assertThat(finished(service, service.start(input()).get("id").toString()))
          .containsEntry("status", "completed");
    } finally {
      service.quiesce();
    }
  }

  @Test
  void quiescenceRetriesFailedCleanupRatherThanReportingAnOrphanedChildAsStopped()
      throws Exception {
    var child = mock(DailyPlannerAiService.Control.Child.class);
    doThrow(new IllegalStateException("first close failed")).doNothing().when(child).close();
    var jobs = jobs();
    var service =
        new DailyPlannerAiService(
            (prompt, date, provider, control) -> {
              control.attach(child);
              return List.of();
            },
            jobs,
            new BackgroundOperationService(jobs));
    String id = service.start(input()).get("id").toString();
    assertThat(finished(service, id)).containsEntry("status", "failed");
    service.quiesce();
    verify(child, times(2)).close();
    verify(child).stop(any(), any());
  }

  @Test
  void pauseBeforeChildAttachmentIsHonouredAndCancelledAttachmentCannotEscapeOwnership() {
    var paused = new DailyPlannerAiService.Control();
    var child = mock(DailyPlannerAiService.Control.Child.class);
    paused.pause();
    paused.attach(child);
    verify(child).pause();
    paused.resume();
    verify(child).resume();
    paused.cleanup();
    verify(child).close();
    var cancelled = new DailyPlannerAiService.Control();
    var late = mock(DailyPlannerAiService.Control.Child.class);
    cancelled.markCancelled();
    cancelled.attach(late);
    verify(late).close();
    assertThat(cancelled.cancelled()).isTrue();
  }

  @Test
  void failedNativePauseDoesNotLeaveAnInvisiblePausedWorker() throws Exception {
    var control = new DailyPlannerAiService.Control();
    var child = mock(DailyPlannerAiService.Control.Child.class);
    control.attach(child);
    doThrow(new IllegalStateException("signal failed")).when(child).pause();
    assertThatThrownBy(control::pause).isInstanceOf(IllegalStateException.class);
    var checkpoint =
        CompletableFuture.runAsync(
            () -> {
              try {
                control.checkpoint();
              } catch (InterruptedException error) {
                throw new RuntimeException(error);
              }
            });
    checkpoint.get(2, TimeUnit.SECONDS);
    control.cleanup();
  }

  @Test
  void startingPausedCannotOverwriteThePausedCardAndResumeContinuesTheSameProposal()
      throws Exception {
    var jobs = jobs();
    String id = jobs.create(Map.of("type", "test")).get("id").toString();
    var control = new DailyPlannerAiService.Control();
    control.pause();
    jobs.update(id, Map.of("status", "paused"));
    var started = new CountDownLatch(1);
    var worker =
        CompletableFuture.runAsync(
            () -> {
              started.countDown();
              try {
                control.started(jobs, id);
              } catch (InterruptedException error) {
                throw new RuntimeException(error);
              }
            });
    assertThat(started.await(2, TimeUnit.SECONDS)).isTrue();
    assertThat(worker.isDone()).isFalse();
    assertThat(jobs.get(id)).containsEntry("status", "paused");
    jobs.update(id, Map.of("status", "running"));
    control.resume();
    worker.get(2, TimeUnit.SECONDS);
    assertThat(jobs.get(id)).containsEntry("status", "running");
  }

  @Test
  void previewReportsPausedAndDoesNotFinishUntilResumed() throws Exception {
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    var jobs = jobs();
    var operations = new BackgroundOperationService(jobs);
    var service =
        new DailyPlannerAiService(
            (prompt, date, provider, control) -> {
              entered.countDown();
              release.await(3, TimeUnit.SECONDS);
              return List.of(Map.of("title", "Review"));
            },
            jobs,
            operations);
    try {
      String id = service.start(input()).get("id").toString();
      assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
      operations.pause(id);
      release.countDown();
      assertThat(service.get(id)).containsEntry("status", "paused");
      assertThat((List<?>) service.get(id).get("tasks")).isEmpty();
      operations.resume(id);
      assertThat(finished(service, id)).containsEntry("status", "completed");
      service.cancel(id);
      assertThat(service.get(id)).containsEntry("status", "completed");
    } finally {
      release.countDown();
      service.quiesce();
    }
  }

  @Test
  void pausedTimeDoesNotConsumeTheAiGenerationDeadline() throws Exception {
    var control = new DailyPlannerAiService.Control();
    control.pause();
    var completion = new CompletableFuture<Integer>();
    var waiting =
        CompletableFuture.runAsync(
            () -> {
              try {
                DailyPlannerAiRunner.awaitCompletion(completion, control, Duration.ofMillis(20));
              } catch (Exception error) {
                throw new RuntimeException(error);
              }
            });
    Thread.sleep(50);
    assertThat(waiting.isDone()).isFalse();
    completion.complete(0);
    control.resume();
    waiting.get(2, TimeUnit.SECONDS);
  }

  @Test
  void plannerOnlyArgumentsDisableProviderToolsAndRetainTheOriginalPromptExactly() {
    String prompt = "Make tasks; --tools Read is data, not an option";
    var codex =
        DailyPlannerAiRunner.planningArguments(
            "codex", List.of("exec", "--ephemeral", "--sandbox", "read-only", prompt));
    assertThat(codex.get(0)).isEqualTo("exec");
    assertThat(codex.get(codex.size() - 1)).isEqualTo(prompt);
    for (String feature :
        List.of(
            "shell_tool",
            "unified_exec",
            "apps",
            "plugins",
            "computer_use",
            "browser_use",
            "multi_agent",
            "code_mode_host",
            "view_image")) {
      int index = codex.indexOf(feature);
      assertThat(index).isGreaterThan(0);
      assertThat(codex.get(index - 1)).isEqualTo("--disable");
    }
    assertThat(codex)
        .contains("web_search=\"disabled\"", "project_doc_max_bytes=0", "--ephemeral", "read-only");
    var claude =
        DailyPlannerAiRunner.planningArguments("claude", List.of("--print", "--safe-mode", prompt));
    assertThat(claude)
        .containsSubsequence(
            "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}");
    assertThat(claude.get(claude.size() - 1)).isEqualTo(prompt);
    assertThatThrownBy(() -> DailyPlannerAiRunner.planningArguments("shell", List.of()))
        .isInstanceOf(IllegalArgumentException.class);
  }

  private BackgroundJobService jobs() {
    return new BackgroundJobService(
        new AtomicJsonStore(mapper), new ArgusProperties(directory, directory, "test", ""));
  }

  private Map<String, Object> input() {
    return Map.of(
        "prompt", "Review release and run tests", "date", "2026-09-22", "provider", "codex");
  }

  private Map<String, Object> finished(DailyPlannerAiService service, String id) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
    Map<String, Object> result;
    do {
      result = service.get(id);
      if (!"running".equals(result.get("status"))) return result;
      Thread.sleep(10);
    } while (System.nanoTime() < deadline);
    throw new AssertionError("AI proposal did not finish");
  }
}
