package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.argus.common.security.KeychainSecretStore;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.ObjectMapper;

class RuntimeDiscoveryConcurrencyTest {
  private final WorkspaceService workspace = mock(WorkspaceService.class);
  private final RuntimeDetector detector = mock(RuntimeDetector.class);
  private final LocalEnvironmentService local = mock(LocalEnvironmentService.class);

  private RuntimeConfigurationService service() {
    return new RuntimeConfigurationService(
        workspace, detector, null, local, null, null, null, null);
  }

  private List<Repository> repositories(int count) {
    return IntStream.range(0, count)
        .mapToObj(
            index ->
                new Repository("repo" + index, "Repo " + index, "/fixture/repo" + index, "now"))
        .toList();
  }

  private WorkspaceResponse snapshot(
      List<Repository> repositories, List<Map<String, Object>> configurations) {
    return new WorkspaceResponse(
        1, "repo0", Map.of(), repositories, configurations, List.of(), Map.of());
  }

  @Test
  void scansConcurrentlyButKeepsRepositoryOrderAndPerRepositoryFailures() throws Exception {
    var repositories = repositories(8);
    when(workspace.snapshot()).thenReturn(snapshot(repositories, List.of()));
    var entered = new CountDownLatch(4);
    var release = new CountDownLatch(1);
    var active = new AtomicInteger();
    var maximum = new AtomicInteger();
    when(detector.detect(any(Path.class), anyString()))
        .thenAnswer(
            call -> {
              maximum.accumulateAndGet(active.incrementAndGet(), Math::max);
              entered.countDown();
              try {
                assertThat(release.await(3, TimeUnit.SECONDS)).isTrue();
                String name = call.getArgument(1);
                if (name.equals("Repo 2"))
                  throw new IllegalArgumentException("No supported runtime");
                return object("name", name, "port", 8080);
              } finally {
                active.decrementAndGet();
              }
            });
    var service = service();
    ExecutorService caller = Executors.newSingleThreadExecutor();
    try {
      var result = caller.submit(service::detections);
      assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
      assertThat(maximum.get()).isEqualTo(4);
      release.countDown();
      var rows = result.get(3, TimeUnit.SECONDS);
      assertThat(rows)
          .extracting(row -> row.get("repositoryId"))
          .containsExactlyElementsOf(repositories.stream().map(Repository::id).toList());
      assertThat(rows.get(2))
          .containsEntry("detected", false)
          .containsEntry("error", "No supported runtime");
      assertThat(rows.get(0)).containsEntry("detected", true);
      verify(detector, times(8)).detect(any(Path.class), anyString());
    } finally {
      release.countDown();
      service.close();
      caller.shutdownNow();
    }
  }

  @Test
  void eachRequestReadsCurrentDetectionConfigurationAndLocalPortWithoutCaching() {
    var repositories = repositories(1);
    var saved =
        object(
            "id",
            "cfg",
            "repositoryId",
            "repo0",
            "name",
            "Saved",
            "executable",
            "npm",
            "args",
            List.of("run", "dev"),
            "cwd",
            ".",
            "port",
            3000);
    when(workspace.snapshot()).thenAnswer(call -> snapshot(repositories, List.of(copyMap(saved))));
    when(detector.detect(any(Path.class), anyString()))
        .thenReturn(
            object(
                "runtimeType",
                "ui",
                "executable",
                "npm",
                "args",
                List.of("run", "dev"),
                "cwd",
                ".",
                "port",
                3000))
        .thenReturn(
            object(
                "runtimeType",
                "ui",
                "executable",
                "npm",
                "args",
                List.of("run", "serve"),
                "cwd",
                ".",
                "port",
                4000));
    when(local.resolve("cfg")).thenReturn(Map.of("PORT", "3100"), Map.of("PORT", "4100"));
    var service = service();
    try {
      assertThat(service.detections().get(0))
          .containsEntry("port", 3100)
          .containsEntry("name", "Saved");
      saved.put("name", "Renamed");
      saved.put("args", List.of("run", "serve"));
      assertThat(service.detections().get(0))
          .containsEntry("port", 4100)
          .containsEntry("name", "Renamed")
          .containsEntry("args", List.of("run", "serve"));
      verify(detector, times(2)).detect(any(Path.class), anyString());
    } finally {
      service.close();
    }
  }

  @Test
  void queueAndWorkersStayBoundedAcrossCallersAndShutdownReleasesAllWaiters() throws Exception {
    when(workspace.snapshot()).thenReturn(snapshot(repositories(1), List.of()));
    var active = new AtomicInteger();
    var maximum = new AtomicInteger();
    var release = new CountDownLatch(1);
    when(detector.detect(any(Path.class), anyString()))
        .thenAnswer(
            call -> {
              assertThat(Thread.currentThread().getName()).startsWith("argus-runtime-discovery-");
              maximum.accumulateAndGet(active.incrementAndGet(), Math::max);
              try {
                release.await();
                return object("port", 8080);
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new CancellationException("Fixture discovery interrupted");
              } finally {
                active.decrementAndGet();
              }
            });
    var service = service();
    var workers = (ThreadPoolExecutor) ReflectionTestUtils.getField(service, "discoveryWorkers");
    ExecutorService callers = Executors.newFixedThreadPool(25);
    var results = new ArrayList<Future<List<Map<String, Object>>>>();
    try {
      for (int index = 0; index < 25; index++) results.add(callers.submit(service::detections));
      await().atMost(Duration.ofSeconds(5)).until(() -> workers.getQueue().size() == 16);
      assertThat(maximum.get()).isEqualTo(4);
      assertThat(workers.getMaximumPoolSize()).isEqualTo(4);
      assertThat(workers.getQueue().remainingCapacity()).isZero();
      service.close();
      for (var result : results)
        assertThatThrownBy(() -> result.get(3, TimeUnit.SECONDS))
            .isInstanceOf(ExecutionException.class)
            .hasCauseInstanceOf(CancellationException.class);
      assertThat(workers.getQueue()).isEmpty();
      assertThatThrownBy(service::detections).isInstanceOf(CancellationException.class);
    } finally {
      release.countDown();
      service.close();
      callers.shutdownNow();
    }
  }

  @Test
  void emptyWorkspaceNeedsNoDiscoveryWork() {
    when(workspace.snapshot()).thenReturn(snapshot(List.of(), List.of()));
    var service = service();
    try {
      assertThat(service.detections()).isEmpty();
      verifyNoInteractions(detector);
    } finally {
      service.close();
    }
  }

  @Test
  void springContextConstructsTheServiceAndClosesItsDiscoveryExecutor() {
    when(workspace.snapshot()).thenReturn(snapshot(List.of(), List.of()));
    ThreadPoolExecutor workers;
    try (var context = new AnnotationConfigApplicationContext()) {
      context.registerBean(WorkspaceService.class, () -> workspace);
      context.registerBean(RuntimeDetector.class, () -> detector);
      context.registerBean(JavaProjectService.class, () -> mock(JavaProjectService.class));
      context.registerBean(LocalEnvironmentService.class, () -> local);
      context.registerBean(
          ApplicationConfigService.class, () -> mock(ApplicationConfigService.class));
      context.registerBean(KeychainSecretStore.class, () -> mock(KeychainSecretStore.class));
      context.registerBean(ProcessManager.class, () -> mock(ProcessManager.class));
      context.registerBean(ObjectMapper.class, () -> new ObjectMapper());
      context.registerBean(RuntimeConfigurationService.class);
      context.refresh();
      var service = context.getBean(RuntimeConfigurationService.class);
      assertThat(service.detections()).isEmpty();
      workers = (ThreadPoolExecutor) ReflectionTestUtils.getField(service, "discoveryWorkers");
      assertThat(workers.isShutdown()).isFalse();
    }
    assertThat(workers.isShutdown()).isTrue();
  }
}
