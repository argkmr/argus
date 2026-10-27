package com.argus.onboarding.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class RepositoryCloneJobServiceTest {
  @TempDir Path root;

  private AtomicJsonStore json() {
    return new AtomicJsonStore(new ObjectMapper());
  }

  private ArgusProperties properties() {
    return new ArgusProperties(root.resolve("data"), root, "test", "token");
  }

  private Map<String, Object> input(String requestId) {
    return object(
        "remoteUrl",
        "https://example.invalid/team/repo.git",
        "destinationPath",
        root.toString(),
        "requestId",
        requestId);
  }

  private RepositoryCloneJobService service(RepositoryDiscoveryService discovery) {
    return new RepositoryCloneJobService(discovery, json(), properties());
  }

  private void finished(RepositoryCloneJobService service, String id, String status) {
    await()
        .atMost(Duration.ofSeconds(5))
        .untilAsserted(() -> assertThat(service.get(id)).containsEntry("status", status));
  }

  @Test
  void successfulReceiptAndIdempotencySurviveRestartWithoutCloningAgain() throws Exception {
    var discovery = mock(RepositoryDiscoveryService.class);
    String target = root.resolve("repo").toString();
    when(discovery.cloneWithDetails(anyString(), anyString()))
        .thenReturn(new RepositoryDiscoveryService.CloneResult(target, "https", false));
    when(discovery.inspect(target))
        .thenReturn(
            object(
                "path",
                target,
                "name",
                "repo",
                "branches",
                List.of("main"),
                "productionBranch",
                "main",
                "eligible",
                true,
                "error",
                ""));
    String id;
    try (var service = service(discovery)) {
      id = text(service.start(input("request-fixture-1")), "id");
      assertThat(service.start(input("request-fixture-1"))).containsEntry("id", id);
      finished(service, id, "completed");
      assertThat(map(service.status(id).get("result"))).containsKey("repository");
    }
    try (var restarted = service(discovery)) {
      assertThat(restarted.status(id)).containsEntry("status", "completed");
      assertThat(restarted.start(input("request-fixture-1"))).containsEntry("id", id);
      assertThat(restarted.listJobs()).hasSize(1);
      assertThatThrownBy(
              () ->
                  restarted.start(
                      object(
                          "requestId",
                          "request-fixture-1",
                          "remoteUrl",
                          "https://example.invalid/other.git",
                          "destinationPath",
                          root.toString())))
          .hasMessageContaining("different repository");
    }
    verify(discovery, times(1)).cloneWithDetails(anyString(), anyString());
  }

  @Test
  void cancellationDrainsCloneAndRemovesOnlyItsOwnedPartialDirectory() throws Exception {
    var entered = new CountDownLatch(1);
    Files.writeString(root.resolve("keep.txt"), "user file");
    var discovery =
        new RepositoryDiscoveryService(
            (command, args, cwd, timeout) -> {
              try {
                Path target = Path.of(args.get(args.size() - 1));
                Files.writeString(target.resolve("partial"), "partial clone");
                entered.countDown();
                new CountDownLatch(1).await();
                throw new AssertionError("Clone must be interrupted");
              } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Repository cloning was interrupted", error);
              } catch (java.io.IOException error) {
                throw new IllegalStateException(error);
              }
            });
    try (var service = service(discovery)) {
      String id = text(service.start(input("request-cancel-1")), "id");
      assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
      assertThatThrownBy(() -> service.start(input("request-cancel-2")))
          .hasMessageContaining("already running");
      assertThat(service.cancel(id)).containsEntry("status", "cancelling");
      finished(service, id, "cancelled");
      assertThat(Files.exists(root.resolve("repo"))).isFalse();
      assertThat(Files.readString(root.resolve("keep.txt"))).isEqualTo("user file");
    }
  }

  @Test
  void restartPreservesAnInterruptedDestinationAndNeverBlindlyReplaysIt() throws Exception {
    Path target = Files.createDirectory(root.resolve("repo"));
    Files.writeString(target.resolve("keep.txt"), "checkout or partial data");
    var receipt =
        object(
            "id",
            "job",
            "requestId",
            "request-restart",
            "status",
            "running",
            "targetPath",
            target.toString(),
            "remoteUrl",
            input("request-restart").get("remoteUrl"),
            "destinationPath",
            root.toRealPath().toString());
    json()
        .write(
            properties().dataDirectory().resolve("repository-clone-jobs.json"), List.of(receipt));
    var discovery = mock(RepositoryDiscoveryService.class);
    try (var service = service(discovery)) {
      assertThat(service.get("job")).containsEntry("status", "interrupted");
      assertThat(text(service.get("job"), "error")).contains("preserved", "On this Mac");
      assertThat(service.start(input("request-restart"))).containsEntry("id", "job");
      assertThat(Files.readString(target.resolve("keep.txt")))
          .isEqualTo("checkout or partial data");
    }
    verifyNoInteractions(discovery);
  }

  @Test
  void completionPersistedBeforeBranchInspectionCanRecoverAfterRestart() {
    String target = root.resolve("repo").toString();
    json()
        .write(
            properties().dataDirectory().resolve("repository-clone-jobs.json"),
            List.of(
                object(
                    "id",
                    "job",
                    "status",
                    "completed",
                    "result",
                    object("path", target, "transport", "ssh", "fallbackUsed", true))));
    var discovery = mock(RepositoryDiscoveryService.class);
    when(discovery.inspect(target))
        .thenReturn(
            object(
                "path",
                target,
                "eligible",
                false,
                "branches",
                List.of(),
                "error",
                "Create the first commit"));
    try (var service = service(discovery)) {
      var job = service.status("job");
      assertThat(job).containsEntry("status", "completed");
      assertThat(map(map(job.get("result")).get("repository"))).containsEntry("eligible", false);
      assertThat(service.cancel("job")).containsEntry("status", "completed");
    }
    verify(discovery, never()).cloneWithDetails(anyString(), anyString());
  }

  @Test
  void embeddedCredentialsAreRejectedBeforePersistingOrLaunchingAJob() {
    var discovery = mock(RepositoryDiscoveryService.class);
    try (var service = service(discovery)) {
      assertThatThrownBy(
              () ->
                  service.start(
                      object(
                          "remoteUrl",
                          "https://user:secret@example.invalid/repo.git",
                          "destinationPath",
                          root.toString())))
          .hasMessageContaining("Do not put")
          .hasMessageNotContaining("secret@");
      assertThat(service.listJobs()).isEmpty();
      assertThat(Files.exists(properties().dataDirectory().resolve("repository-clone-jobs.json")))
          .isFalse();
    }
    verifyNoInteractions(discovery);
  }

  @Test
  void failedJobsAreDurableAndAnExplicitNewRequestCanRetry() {
    var discovery = mock(RepositoryDiscoveryService.class);
    when(discovery.cloneWithDetails(anyString(), anyString()))
        .thenThrow(new IllegalArgumentException("Git needs saved HTTPS credentials"));
    String first;
    try (var service = service(discovery)) {
      first = text(service.start(input("request-failure-1")), "id");
      finished(service, first, "failed");
      assertThat(text(service.get(first), "error")).contains("saved HTTPS credentials");
      String second = text(service.start(input("request-failure-2")), "id");
      assertThat(second).isNotEqualTo(first);
      finished(service, second, "failed");
    }
    try (var restarted = service(discovery)) {
      assertThat(restarted.start(input("request-failure-1")))
          .containsEntry("id", first)
          .containsEntry("status", "failed");
    }
    verify(discovery, times(2)).cloneWithDetails(anyString(), anyString());
  }

  @Test
  void twoWorkersBoundConcurrencyAndQueuedCancellationNeverStartsGit() throws Exception {
    var entered = new CountDownLatch(2);
    var discovery = mock(RepositoryDiscoveryService.class);
    when(discovery.cloneWithDetails(anyString(), anyString()))
        .thenAnswer(
            invocation -> {
              entered.countDown();
              try {
                new CountDownLatch(1).await();
              } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Clone interrupted", error);
              }
              throw new AssertionError("Clone must stop");
            });
    try (var service = service(discovery)) {
      for (int i = 0; i < 2; i++) {
        var request = input("request-worker-" + i);
        request.put("remoteUrl", "https://example.invalid/worker-" + i + ".git");
        service.start(request);
      }
      assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
      String queued = text(service.start(input("request-queued-1")), "id");
      assertThat(service.get(queued)).containsEntry("status", "queued");
      assertThat(service.cancel(queued)).containsEntry("status", "cancelled");
    }
    verify(discovery, times(2)).cloneWithDetails(anyString(), anyString());
  }

  @Test
  void recentHistoryNeverHidesAnOlderActiveClone() throws Exception {
    var entered = new CountDownLatch(1);
    var discovery = mock(RepositoryDiscoveryService.class);
    when(discovery.cloneWithDetails(anyString(), anyString()))
        .thenAnswer(
            invocation -> {
              String remote = invocation.getArgument(0);
              if (remote.contains("held")) {
                entered.countDown();
                try {
                  new CountDownLatch(1).await();
                } catch (InterruptedException error) {
                  Thread.currentThread().interrupt();
                  throw new IllegalStateException("Clone interrupted", error);
                }
              }
              return new RepositoryDiscoveryService.CloneResult(
                  root.resolve("completed").toString(), "https", false);
            });
    when(discovery.inspect(anyString()))
        .thenReturn(object("eligible", true, "branches", List.of("main")));
    try (var service = service(discovery)) {
      var heldInput = input("request-history-held");
      heldInput.put("remoteUrl", "https://example.invalid/held.git");
      String held = text(service.start(heldInput), "id");
      assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
      for (int index = 0; index < 102; index++) {
        var request = input("request-history-" + index);
        request.put("remoteUrl", "https://example.invalid/history-" + index + ".git");
        String id = text(service.start(request), "id");
        await()
            .pollDelay(Duration.ZERO)
            .pollInterval(Duration.ofMillis(5))
            .atMost(Duration.ofSeconds(5))
            .untilAsserted(() -> assertThat(service.get(id)).containsEntry("status", "completed"));
      }
      assertThat(service.listJobs()).hasSize(101);
      assertThat(service.listJobs().get(0))
          .containsEntry("id", held)
          .containsEntry("status", "running");
    }
  }
}
