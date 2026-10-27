package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.process.OwnedProcess;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProcessManagerStopServicesTest {
  @TempDir Path directory;

  private Repository repository(String id) {
    return new Repository(id, id, directory.toString(), "now", "main");
  }

  private Map<String, Object> configuration(String id) {
    return object(
        "id",
        id,
        "name",
        "Service " + id,
        "executable",
        "/bin/sh",
        "cwd",
        ".",
        "args",
        List.of(
            "-c",
            "while [ ! -f finish-"
                + id
                + " ]; do sleep 0.02; done; "
                + "read code < finish-"
                + id
                + "; exit \"$code\""));
  }

  /** Only isolated shell fixtures inside the temporary directory are ever launched or stopped. */
  private final class Fixture implements AutoCloseable {
    final ProcessManager manager;
    final List<OwnedProcess> children = new ArrayList<>();
    final List<String> ids = new ArrayList<>();
    final List<String> configurations = new ArrayList<>();

    Fixture() {
      this(spy(new ProcessManager()));
    }

    Fixture(ProcessManager manager) {
      this.manager = manager;
    }

    String start(String id) {
      return start(configuration(id));
    }

    String start(Map<String, Object> config) {
      return capture(manager.start(config, repository("services"), Map.of()), text(config, "id"));
    }

    String task(Map<String, Object> config, String repositoryId) {
      return capture(
          manager.runTask(config, repository(repositoryId), Map.of()), text(config, "id"));
    }

    String capture(Map<String, Object> process, String configurationId) {
      String id = text(process, "id");
      try {
        var records = ProcessManager.class.getDeclaredField("processes");
        records.setAccessible(true);
        Object record = ((Map<?, ?>) records.get(manager)).get(id);
        var child = record.getClass().getDeclaredField("child");
        child.setAccessible(true);
        children.add((OwnedProcess) child.get(record));
        ids.add(id);
        configurations.add(configurationId);
        return id;
      } catch (ReflectiveOperationException error) {
        throw new AssertionError(error);
      }
    }

    void finish(int index, int exitCode) {
      try {
        Path pending = directory.resolve("pending-" + configurations.get(index));
        Files.writeString(pending, String.valueOf(exitCode) + "\n");
        Files.move(
            pending,
            directory.resolve("finish-" + configurations.get(index)),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING);
        manager.completion(ids.get(index)).get(5, TimeUnit.SECONDS);
      } catch (Exception error) {
        throw new AssertionError(error);
      }
    }

    OwnedProcess child(int index) {
      return children.get(index);
    }

    @Override
    public void close() {
      manager.stopAll();
    }
  }

  @Test
  void emptySnapshotIsSuccessfulAndDoesNotCloseTheProcessManager() {
    try (var fixture = new Fixture()) {
      var result = fixture.manager.stopServices();
      for (String key : List.of("targeted", "stopped", "failures", "processes"))
        assertThat((List<?>) result.get(key)).isEmpty();
      assertThat(fixture.start("after-empty-stop")).isNotBlank();
    }
  }

  @Test
  void targetsOnlyActiveServiceOwnershipAndReturnsLightweightFinalSummaries() {
    try (var fixture = new Fixture()) {
      String active = fixture.start("active");
      String exited = fixture.start("already-exited");
      fixture.finish(1, 0);
      String failed = fixture.start("already-failed");
      fixture.finish(2, 7);
      for (String task : List.of("test", "sync", "missing-kind")) {
        var config = configuration(task);
        // Even a maintenance record with service-looking stage and missing task kind is not a
        // service.
        config.put("stage", "running");
        if (!task.equals("missing-kind")) config.put("task", task);
        fixture.task(config, task);
      }

      var result = fixture.manager.stopServices();
      assertThat((List<?>) result.get("targeted"))
          .isEqualTo(
              List.of(object("id", active, "configurationId", "active", "name", "Service active")));
      assertThat((List<?>) result.get("stopped")).isEqualTo(List.of(active));
      assertThat((List<?>) result.get("failures")).isEmpty();
      List<?> summaries = (List<?>) result.get("processes");
      assertThat(summaries).hasSize(6);
      for (Object summary : summaries) assertThat(map(summary)).doesNotContainKey("logs");
      assertThat(fixture.manager.logs(active, 0)).containsEntry("status", "stopped");
      assertThat(fixture.manager.logs(exited, 0)).containsEntry("status", "stopped");
      assertThat(fixture.manager.logs(failed, 0)).containsEntry("status", "failed");
      for (int index = 1; index < 6; index++)
        verify(fixture.manager, never()).stopChild(fixture.child(index));
      assertThat(fixture.start("active")).isNotEqualTo(active);
    }
  }

  @Test
  void stopsConcurrentlyWithABoundedPoolAndReservesQueuedInstallationsBeforeTheyExit()
      throws Exception {
    var entered = new CountDownLatch(8);
    var release = new CountDownLatch(1);
    var runningStops = new AtomicInteger();
    var maximumStops = new AtomicInteger();
    try (var fixture = new Fixture()) {
      try {
        for (int index = 0; index < 10; index++) {
          var config = configuration("service-" + index);
          if (index >= 8)
            config.putAll(
                object(
                    "runtimeType",
                    "ui",
                    "dependencyDirectory",
                    "missing-dependencies",
                    "installExecutable",
                    "/bin/sh",
                    "installArgs",
                    config.get("args")));
          if (index >= 8)
            config.put(
                "args",
                List.of("-c", "printf launched > unexpected-service-" + index + "; sleep 20"));
          fixture.start(config);
          doAnswer(
                  ignored -> {
                    int current = runningStops.incrementAndGet();
                    maximumStops.accumulateAndGet(current, Math::max);
                    entered.countDown();
                    try {
                      assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
                      return ignored.callRealMethod();
                    } finally {
                      runningStops.decrementAndGet();
                    }
                  })
              .when(fixture.manager)
              .stopChild(fixture.child(index));
        }
        var result = CompletableFuture.supplyAsync(fixture.manager::stopServices);
        assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(runningStops.get()).isEqualTo(8);
        assertThat(fixture.manager.summaries())
            .allSatisfy(item -> assertThat(item).containsEntry("status", "stopping"));
        // Both installers finish while their stop work is queued behind the first eight services.
        fixture.finish(8, 0);
        fixture.finish(9, 0);
        assertThat(directory.resolve("unexpected-service-8")).doesNotExist();
        assertThat(directory.resolve("unexpected-service-9")).doesNotExist();
        release.countDown();
        assertThat((List<?>) result.get(5, TimeUnit.SECONDS).get("stopped")).hasSize(10);
        assertThat(maximumStops.get()).isEqualTo(8);
      } finally {
        release.countDown();
      }
    }
  }

  @Test
  void overlappingBulkCallsShareOneSnapshotAndLeaveNewAndReplacementServicesAlone()
      throws Exception {
    var blocked = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    try (var fixture = new Fixture()) {
      try {
        String original = fixture.start("replaced");
        String slow = fixture.start("slow");
        doAnswer(
                ignored -> {
                  blocked.countDown();
                  assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
                  return ignored.callRealMethod();
                })
            .when(fixture.manager)
            .stopChild(fixture.child(1));
        var first = CompletableFuture.supplyAsync(fixture.manager::stopServices);
        assertThat(blocked.await(5, TimeUnit.SECONDS)).isTrue();
        fixture.manager.completion(original).get(5, TimeUnit.SECONDS);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!"stopped".equals(fixture.manager.logs(original, 0).get("status"))
            && System.nanoTime() < deadline) Thread.sleep(10);
        assertThat(fixture.manager.logs(original, 0)).containsEntry("status", "stopped");
        String replacement = fixture.start("replaced");
        String newService = fixture.start("new");
        var duplicate = CompletableFuture.supplyAsync(fixture.manager::stopServices);
        assertThatThrownBy(() -> duplicate.get(100, TimeUnit.MILLISECONDS))
            .isInstanceOf(java.util.concurrent.TimeoutException.class);
        release.countDown();
        var result = first.get(5, TimeUnit.SECONDS);
        assertThat(duplicate.get(5, TimeUnit.SECONDS)).isSameAs(result);
        assertThat((List<?>) result.get("stopped")).isEqualTo(List.of(original, slow));
        verify(fixture.manager, times(1)).stopChild(fixture.child(0));
        verify(fixture.manager, times(1)).stopChild(fixture.child(1));
        verify(fixture.manager, never()).stopChild(fixture.child(2));
        verify(fixture.manager, never()).stopChild(fixture.child(3));
        assertThat(fixture.manager.logs(replacement, 0)).containsEntry("status", "running");
        assertThat(fixture.manager.logs(newService, 0)).containsEntry("status", "running");
      } finally {
        release.countDown();
      }
    }
  }

  @Test
  void joinsAnExistingIndividualStopWithoutStoppingTheChildTwice() throws Exception {
    var blocked = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    try (var fixture = new Fixture()) {
      try {
        String id = fixture.start("already-stopping");
        doAnswer(
                ignored -> {
                  blocked.countDown();
                  assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
                  return ignored.callRealMethod();
                })
            .when(fixture.manager)
            .stopChild(fixture.child(0));
        var individual = CompletableFuture.runAsync(() -> fixture.manager.stop(id));
        assertThat(blocked.await(5, TimeUnit.SECONDS)).isTrue();
        var bulk = CompletableFuture.supplyAsync(fixture.manager::stopServices);
        assertThatThrownBy(() -> bulk.get(100, TimeUnit.MILLISECONDS))
            .isInstanceOf(java.util.concurrent.TimeoutException.class);
        release.countDown();
        individual.get(5, TimeUnit.SECONDS);
        assertThat((List<?>) bulk.get(5, TimeUnit.SECONDS).get("stopped")).isEqualTo(List.of(id));
        verify(fixture.manager, times(1)).stopChild(fixture.child(0));
      } finally {
        release.countDown();
      }
    }
  }

  @Test
  void partialFailuresRetainExactIdentityAndCanBeRetriedWithoutClosingTheManager() {
    try (var fixture = new Fixture()) {
      String failure = fixture.start("retry");
      String success = fixture.start("success");
      doAnswer(
              ignored -> {
                fixture.finish(0, 0);
                throw new IllegalStateException("Fixture child is still alive");
              })
          .when(fixture.manager)
          .stopChild(fixture.child(0));
      try {
        var result = fixture.manager.stopServices();
        assertThat((List<?>) result.get("stopped")).isEqualTo(List.of(success));
        assertThat((List<?>) result.get("failures"))
            .isEqualTo(
                List.of(
                    object(
                        "id",
                        failure,
                        "name",
                        "Service retry",
                        "message",
                        "Fixture child is still alive")));
        assertThat(fixture.manager.logs(failure, 0)).containsEntry("status", "stopping");
        assertThatThrownBy(() -> fixture.start("retry")).hasMessageContaining("already running");
      } finally {
        doCallRealMethod().when(fixture.manager).stopChild(fixture.child(0));
      }
      var retry = fixture.manager.stopServices();
      assertThat((List<?>) retry.get("stopped")).isEqualTo(List.of(failure));
      assertThat((List<?>) retry.get("failures")).isEmpty();
      verify(fixture.manager, times(2)).stopChild(fixture.child(0));
      verify(fixture.manager, times(1)).stopChild(fixture.child(1));
      assertThat(fixture.start("retry")).isNotBlank();
    }
  }

  @Test
  void rootExitAfterTreeStopFailureKeepsTheServiceRetryableAndPreventsReplacement() {
    try (var fixture = new Fixture()) {
      String id = fixture.start("late-exit");
      doThrow(new IllegalStateException("Fixture tree could not be drained"))
          .when(fixture.manager)
          .stopChild(fixture.child(0));
      try {
        assertThat((List<?>) fixture.manager.stopServices().get("failures")).hasSize(1);
        fixture.finish(0, 0);
        assertThat(fixture.manager.logs(id, 0)).containsEntry("status", "stopping");
        assertThatThrownBy(() -> fixture.start("late-exit"))
            .hasMessageContaining("already running");
      } finally {
        doCallRealMethod().when(fixture.manager).stopChild(fixture.child(0));
      }
      assertThat((List<?>) fixture.manager.stopServices().get("stopped")).isEqualTo(List.of(id));
      assertThat(fixture.manager.logs(id, 0)).containsEntry("status", "stopped");
    }
  }

  @Test
  void rootExitCallbackAfterConfirmedStopCannotRegressItsFinalStatus() throws Exception {
    try (var fixture = new Fixture()) {
      String id = fixture.start("confirmed");
      // Defer the root callback until after the stop delegate has reported success.
      doNothing().when(fixture.manager).stopChild(fixture.child(0));
      try {
        assertThat((List<?>) fixture.manager.stopServices().get("stopped")).isEqualTo(List.of(id));
        fixture.finish(0, 0);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!String.valueOf(fixture.manager.logs(id, 0).get("logs")).contains("Stopped by user")
            && System.nanoTime() < deadline) Thread.sleep(10);
        assertThat(String.valueOf(fixture.manager.logs(id, 0).get("logs")))
            .contains("Stopped by user");
        assertThat(fixture.manager.logs(id, 0)).containsEntry("status", "stopped");
      } finally {
        doCallRealMethod().when(fixture.manager).stopChild(fixture.child(0));
      }
    }
  }

  @Test
  void executorCreationFailureReleasesAllReservationsForAnImmediateRetry() throws Exception {
    var manager = spy(new ProcessManager());
    doThrow(new RejectedExecutionException("Fixture executor unavailable"))
        .doCallRealMethod()
        .when(manager)
        .serviceStopExecutor(anyInt());
    try (var fixture = new Fixture(manager)) {
      String id = fixture.start("creation-failure");
      var failed = manager.stopServices();
      assertThat((List<?>) failed.get("stopped")).isEmpty();
      assertThat((List<?>) failed.get("failures")).hasSize(1);
      var retry = CompletableFuture.supplyAsync(manager::stopServices).get(5, TimeUnit.SECONDS);
      assertThat((List<?>) retry.get("stopped")).isEqualTo(List.of(id));
      verify(fixture.manager, times(1)).stopChild(fixture.child(0));
    }
  }

  @Test
  void partialSubmissionFailureReleasesOnlyUnscheduledReservations() throws Exception {
    var manager = spy(new ProcessManager());
    var executor = mock(ExecutorService.class);
    doAnswer(
            call -> {
              ((Runnable) call.getArgument(0)).run();
              return null;
            })
        .doThrow(new RejectedExecutionException("Fixture submission unavailable"))
        .when(executor)
        .execute(any(Runnable.class));
    doReturn(executor).doCallRealMethod().when(manager).serviceStopExecutor(anyInt());
    try (var fixture = new Fixture(manager)) {
      String first = fixture.start("submitted");
      String second = fixture.start("not-submitted");
      String third = fixture.start("also-not-submitted");
      var result = manager.stopServices();
      assertThat((List<?>) result.get("stopped")).isEqualTo(List.of(first));
      assertThat((List<?>) result.get("failures")).hasSize(2);
      verify(executor).shutdown();
      CompletableFuture.runAsync(() -> manager.stop(second)).get(5, TimeUnit.SECONDS);
      var retry = CompletableFuture.supplyAsync(manager::stopServices).get(5, TimeUnit.SECONDS);
      assertThat((List<?>) retry.get("stopped")).isEqualTo(List.of(third));
      for (int index = 0; index < 3; index++)
        verify(fixture.manager, times(1)).stopChild(fixture.child(index));
    }
  }
}
