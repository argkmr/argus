package com.argus.background.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class BackgroundOperationServiceTest {
  @TempDir Path root;

  BackgroundJobService jobs() {
    return new BackgroundJobService(
        new AtomicJsonStore(new ObjectMapper()), new ArgusProperties(root, root, "test", ""));
  }

  @Test
  void pauseAndResumeCallOwnedControlsAndReleaseCheckpoint() throws Exception {
    var jobs = jobs();
    String id =
        text(
            jobs.create(
                object("type", "ai-kit-generation", "items", List.of(object("repositoryId", "a")))),
            "id");
    var controls = new BackgroundOperationService(jobs);
    var pauses = new AtomicInteger();
    var resumes = new AtomicInteger();
    try (var operation =
        controls.register(id, pauses::incrementAndGet, resumes::incrementAndGet, () -> {})) {
      controls.pause(id);
      assertThat(pauses).hasValue(1);
      var waiting = CompletableFuture.runAsync(operation::checkpoint);
      assertThatThrownBy(() -> waiting.get(50, TimeUnit.MILLISECONDS))
          .isInstanceOf(TimeoutException.class);
      controls.resume(id);
      waiting.get(2, TimeUnit.SECONDS);
      assertThat(resumes).hasValue(1);
      assertThat(jobs.get(id)).containsEntry("status", "running");
    }
  }

  @Test
  void shutdownWakesPausedWorkWithoutCallingUserCancellation() throws Exception {
    var jobs = jobs();
    String id = text(jobs.create(object("type", "ai-kit-generation")), "id");
    var controls = new BackgroundOperationService(jobs);
    var cancelled = new AtomicInteger();
    try (var operation = controls.register(id, () -> {}, () -> {}, cancelled::incrementAndGet)) {
      controls.pause(id);
      var waiting = CompletableFuture.runAsync(operation::checkpoint);
      operation.shutdown();
      assertThatThrownBy(() -> waiting.get(2, TimeUnit.SECONDS))
          .isInstanceOf(ExecutionException.class)
          .hasCauseInstanceOf(CancellationException.class);
      assertThat(cancelled).hasValue(0);
      assertThat(jobs.get(id)).containsEntry("status", "paused");
    }
  }

  @Test
  void cancellationIsObservedByLateRegistrantsAndOffboardingCannotBePaused() {
    var jobs = jobs();
    var controls = new BackgroundOperationService(jobs);
    String id =
        text(
            jobs.create(
                object("type", "ai-kit-generation", "items", List.of(object("repositoryId", "a")))),
            "id");
    controls.cancel(id);
    try (var operation = controls.register(id, () -> {}, () -> {}, () -> {})) {
      assertThatThrownBy(operation::checkpoint).isInstanceOf(CancellationException.class);
      assertThat(map(list(jobs.get(id).get("items")).get(0))).containsEntry("status", "cancelled");
    }
    String offboard = text(jobs.create(object("type", "repository-offboarding")), "id");
    assertThatThrownBy(() -> controls.pause(offboard)).hasMessageContaining("cannot be paused");
    assertThatThrownBy(() -> controls.cancel(offboard)).hasMessageContaining("cannot be stopped");
  }

  @Test
  void durableCancellationPrecedesFlagAndFlagPrecedesChildStop() {
    var jobs = jobs();
    String id = text(jobs.create(object("type", "ai-kit-generation")), "id");
    var controls = new BackgroundOperationService(jobs);
    var events = new java.util.ArrayList<String>();
    var reference =
        new java.util.concurrent.atomic.AtomicReference<BackgroundOperationService.Operation>();
    try (var operation =
        controls.register(
            id,
            () -> {},
            () -> {},
            () -> {
              assertThat(reference.get().isCancelled()).isFalse();
              events.add("journal");
            },
            () -> {
              assertThat(reference.get().isCancelled()).isTrue();
              assertThat(jobs.get(id)).containsEntry("status", "cancelled");
              events.add("stop");
            })) {
      reference.set(operation);
      controls.cancel(id);
      assertThat(events).containsExactly("journal", "stop");
    }
  }
}
