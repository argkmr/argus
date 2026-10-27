package com.argus.runtime.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import com.argus.runtime.controller.NativeRuntimeController;
import com.argus.workspace.domain.Repository;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProcessSummaryTest {
  @TempDir Path directory;

  @Test
  void statusEndpointUsesTheLogFreeSnapshotWithoutRuntimeDiscovery() {
    var processes = mock(ProcessManager.class);
    var runtime = mock(RuntimeConfigurationService.class);
    List<Map<String, Object>> summary =
        List.of(Map.of("id", "agent-started", "status", "running", "running", true));
    when(processes.summaries()).thenReturn(summary);
    var controller = new NativeRuntimeController(runtime, processes, null, null, null);
    assertThat(controller.processes()).isSameAs(summary);
    verify(processes).summaries();
    verifyNoMoreInteractions(processes);
    verifyNoInteractions(runtime);
  }

  @Test
  void summariesExcludeLogsButRetainDetachedLifecycleAndDebugState() {
    var processes = new ProcessManager();
    var configuration =
        RuntimeData.object(
            "id",
            "fixture",
            "name",
            "Fixture",
            "cwd",
            ".",
            "executable",
            directory.resolve("missing-fixture-command").toString(),
            "args",
            List.of(),
            "debug",
            Map.of("runtime", "node", "state", "starting"));
    var repository = new Repository("fixture", "Fixture", directory.toString(), "now", "main");
    // A missing executable creates a failed launch record without starting a service.
    var failed = processes.start(configuration, repository, Map.of());
    assertThat(failed).containsEntry("status", "failed");
    var full = new LinkedHashMap<>(processes.list().get(0));
    assertThat((List<?>) full.remove("logs")).isNotEmpty();
    var summary = processes.summaries().get(0);
    assertThat(summary).isEqualTo(full).doesNotContainKey("logs").containsEntry("running", false);
    summary.put("status", "running");
    RuntimeData.map(summary.get("debug")).put("state", "edited");
    assertThat(processes.summaries().get(0)).containsEntry("status", "failed");
    assertThat(RuntimeData.map(processes.summaries().get(0).get("debug")))
        .containsEntry("state", "starting");
    assertThat((List<?>) processes.logs(String.valueOf(failed.get("id")), 0).get("logs"))
        .isNotEmpty();
  }
}
