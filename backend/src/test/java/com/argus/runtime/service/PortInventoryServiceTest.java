package com.argus.runtime.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

class PortInventoryServiceTest {
  private final WorkspaceService workspace = mock(WorkspaceService.class);
  private final ProcessManager processes = mock(ProcessManager.class);
  private final LocalEnvironmentService local = mock(LocalEnvironmentService.class);

  private void configurations(List<Map<String, Object>> values) {
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(1, "repo", Map.of(), List.of(), values, List.of(), Map.of()));
    when(processes.ownedProcessRoots()).thenReturn(List.of());
    when(local.resolve(anyString())).thenReturn(Map.of());
  }

  private PortInventoryService inventory(String output) {
    return new PortInventoryService(
        workspace, processes, local, () -> PortInventoryService.parse(output), () -> 1000);
  }

  @Test
  void parsesMachineOutputWithoutTruncatedNamesOrIpv6Ambiguity() {
    var parsed =
        PortInventoryService.parse(
            "p20\0cLong Process Name\0\nf10\0n*:8080\0\nf11\0n*:8080\0\np21\0cnode\0\nf7\0n[::1]:3000\0\nf8\0n127.0.0.1:3000\0\n");
    assertThat(parsed.available()).isTrue();
    assertThat(parsed.listeners()).hasSize(3);
    assertThat(parsed.listeners().get(0))
        .containsEntry("port", 3000)
        .containsEntry("host", "::1")
        .containsEntry("pid", 21L);
    assertThat(parsed.listeners().get(2))
        .containsEntry("command", "Long Process Name")
        .containsEntry("port", 8080);
  }

  @Test
  void rejectsMalformedOrNonListenerAddressesWithoutClaimingOtherPortsFree() {
    var parsed =
        PortInventoryService.parse(
            "p20\0cjava\0\nf5\0n127.0.0.1:8080\0\nf6\0n127.0.0.1:8080->127.0.0.1:9090\0\nf7\0n*:99999\0\n");
    assertThat(parsed.available()).isFalse();
    assertThat(parsed.listeners()).hasSize(1);
    assertThat(parsed.listeners().get(0)).containsEntry("port", 8080);
  }

  @Test
  void invalidPidCannotInheritPreviousProcessIdentity() {
    var parsed =
        PortInventoryService.parse("p20\0cjava\0\nf5\0n*:8080\0\npbad\0cnode\0\nf6\0n*:3000\0\n");
    assertThat(parsed.available()).isFalse();
    assertThat(parsed.listeners()).hasSize(1);
  }

  @Test
  void emptySuccessfulOutputIsAValidSnapshotNotConfiguredListeners() {
    assertThat(PortInventoryService.parse("").available()).isTrue();
    assertThat(PortInventoryService.parse("").listeners()).isEmpty();
  }

  @Test
  void removesControlCharactersFromUntrustedProcessNames() {
    var parsed = PortInventoryService.parse("p20\0cjava\nsecret\u001b[31m\0\nf5\0n*:8080\0\n");
    assertThat(parsed.listeners().get(0).get("command")).isEqualTo("javasecret[31m");
  }

  @Test
  void stoppedConfigurationsRemainVisibleAndExposeOnlySafeMetadata() {
    configurations(
        List.of(
            RuntimeData.object(
                "id",
                "config",
                "repositoryId",
                "repo",
                "name",
                "API",
                "port",
                8080,
                "managementPort",
                10100,
                "args",
                List.of("--password=private"),
                "env",
                Map.of("SECRET", "private"))));
    var result = inventory("").snapshot();
    var saved = RuntimeData.map(RuntimeData.list(result.get("configurations")).get(0));
    assertThat(saved)
        .containsEntry("port", 8080)
        .containsEntry("managementPort", 10100)
        .containsEntry("running", false);
    assertThat(result.toString()).doesNotContain("private", "--password", "SECRET");
    assertThat(RuntimeData.list(result.get("listeners"))).isEmpty();
  }

  @Test
  void effectiveLocalEnvironmentPortsOverrideInlineAndSavedValues() {
    configurations(
        List.of(
            RuntimeData.object(
                "id",
                "config",
                "repositoryId",
                "repo",
                "port",
                8080,
                "managementPort",
                10100,
                "env",
                Map.of("SERVER_PORT", "8081"))));
    when(local.resolve("config"))
        .thenReturn(
            Map.of("SERVER_PORT", "8082", "MANAGEMENT_SERVER_PORT", "10102", "SECRET", "hidden"));
    var result = inventory("").snapshot();
    assertThat(RuntimeData.map(RuntimeData.list(result.get("configurations")).get(0)))
        .containsEntry("port", 8082)
        .containsEntry("managementPort", 10102)
        .containsEntry("portSource", "local environment");
    assertThat(result.toString()).doesNotContain("hidden", "SECRET");
  }

  @Test
  void unreadableEnvironmentDoesNotHideSavedConfiguration() {
    configurations(
        List.of(RuntimeData.object("id", "config", "repositoryId", "repo", "port", 8080)));
    when(local.resolve("config")).thenThrow(new IllegalArgumentException("private/path"));
    var saved =
        RuntimeData.map(RuntimeData.list(inventory("").snapshot().get("configurations")).get(0));
    assertThat(saved).containsEntry("port", 8080).containsKey("notice");
    assertThat(saved.toString()).doesNotContain("private/path");
  }

  @Test
  void cacheIsShortLivedAndSaveRefreshAlwaysScans() {
    configurations(List.of());
    var calls = new AtomicInteger();
    var time = new AtomicLong(1000);
    var inventory =
        new PortInventoryService(
            workspace,
            processes,
            local,
            () -> {
              calls.incrementAndGet();
              return PortInventoryService.parse("p20\0cjava\0\nf5\0n*:8080\0\n");
            },
            time::get);
    var first = inventory.snapshot();
    RuntimeData.list(first.get("listeners")).clear();
    assertThat(RuntimeData.list(inventory.snapshot().get("listeners"))).hasSize(1);
    assertThat(calls).hasValue(1);
    inventory.snapshot(true);
    assertThat(calls).hasValue(2);
    time.set(2500);
    inventory.snapshot();
    assertThat(calls).hasValue(3);
  }

  @Test
  void failedScanIsExplicitlyUnknownAndNeverReusesOldListeners() {
    configurations(List.of());
    var calls = new AtomicInteger();
    var inventory =
        new PortInventoryService(
            workspace,
            processes,
            local,
            () -> {
              if (calls.getAndIncrement() > 0) throw new IllegalStateException("private detail");
              return PortInventoryService.parse("p20\0cjava\0\nf5\0n*:8080\0\n");
            },
            () -> 1000);
    assertThat(inventory.snapshot()).containsEntry("available", true);
    var failed = inventory.snapshot(true);
    assertThat(failed).containsEntry("available", false);
    assertThat(RuntimeData.list(failed.get("listeners"))).isEmpty();
    assertThat(failed.toString()).contains("unknown").doesNotContain("private detail");
  }

  @Test
  void cacheLockIsNeverHeldWhileConsultingWorkspaceOrEnvironment() {
    var values = List.of(RuntimeData.object("id", "config", "repositoryId", "repo", "port", 8080));
    configurations(values);
    var inventory = inventory("");
    when(workspace.snapshot())
        .thenAnswer(
            ignored -> {
              assertThat(Thread.holdsLock(inventory)).isFalse();
              return new WorkspaceResponse(
                  1, "repo", Map.of(), List.of(), values, List.of(), Map.of());
            });
    when(local.resolve("config"))
        .thenAnswer(
            ignored -> {
              assertThat(Thread.holdsLock(inventory)).isFalse();
              return Map.of();
            });
    when(processes.ownedProcessRoots())
        .thenAnswer(
            ignored -> {
              assertThat(Thread.holdsLock(inventory)).isFalse();
              return List.of();
            });
    inventory.snapshot(true);
    inventory.snapshot();
  }

  private ProcessHandle handle(long pid, Instant start) {
    var handle = mock(ProcessHandle.class);
    var info = mock(ProcessHandle.Info.class);
    when(handle.pid()).thenReturn(pid);
    when(handle.isAlive()).thenReturn(true);
    when(handle.info()).thenReturn(info);
    when(info.startInstant()).thenReturn(Optional.of(start));
    when(handle.descendants()).thenAnswer(ignored -> Stream.empty());
    return handle;
  }

  @Test
  void ownershipRequiresLiveOwnedRootOrDescendantNotMatchingConfiguredPort() {
    configurations(
        List.of(RuntimeData.object("id", "config", "repositoryId", "repo", "port", 8080)));
    var root = handle(20, Instant.EPOCH);
    var descendant = handle(21, Instant.EPOCH);
    when(root.descendants()).thenAnswer(ignored -> Stream.of(descendant));
    when(processes.ownedProcessRoots())
        .thenReturn(List.of(new ProcessManager.OwnedProcessRoot("config", "repo", root, true)));
    var result = inventory("p21\0cjava\0\nf5\0n*:8081\0\np22\0cjava\0\nf6\0n*:8080\0\n").snapshot();
    var listeners = RuntimeData.list(result.get("listeners"));
    assertThat(RuntimeData.map(listeners.get(0)))
        .doesNotContainKeys("configurationId", "repositoryId");
    assertThat(RuntimeData.map(listeners.get(1)))
        .containsEntry("configurationId", "config")
        .containsEntry("repositoryId", "repo");
    assertThat(RuntimeData.map(RuntimeData.list(result.get("configurations")).get(0)))
        .containsEntry("running", true);
  }

  @Test
  void pidReuseOrExitedRootCannotEstablishOwnership() {
    configurations(List.of());
    var root = handle(20, Instant.EPOCH);
    when(processes.ownedProcessRoots())
        .thenReturn(List.of(new ProcessManager.OwnedProcessRoot("config", "repo", root, true)));
    var inventory =
        new PortInventoryService(
            workspace,
            processes,
            local,
            () -> {
              when(root.info().startInstant())
                  .thenReturn(Optional.of(Instant.EPOCH.plusSeconds(10)));
              return PortInventoryService.parse("p20\0cjava\0\nf5\0n*:8080\0\n");
            },
            () -> 1000);
    assertThat(RuntimeData.map(RuntimeData.list(inventory.snapshot().get("listeners")).get(0)))
        .doesNotContainKey("configurationId");
    when(root.isAlive()).thenReturn(false);
    assertThat(RuntimeData.map(RuntimeData.list(inventory.snapshot(true).get("listeners")).get(0)))
        .doesNotContainKey("configurationId");
  }
}
