package com.argus.runtime.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.argus.runtime.controller.NativeRuntimeController;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class NativeRuntimeMaintenanceTest {
  private final RuntimeConfigurationService runtime = mock(RuntimeConfigurationService.class);
  private final ProcessManager processes = mock(ProcessManager.class);
  private final WorkspaceService workspace = mock(WorkspaceService.class);
  private final ProjectStructureService structures = mock(ProjectStructureService.class);
  private final Repository repository = new Repository("repo", "Fixture", "/tmp/fixture", "");
  private final NativeRuntimeController controller =
      new NativeRuntimeController(
          runtime, processes, workspace, mock(JavaProjectService.class), structures);

  private void setup() {
    when(workspace.requireRepository("repo")).thenReturn(repository);
    when(runtime.resolve(repository, null)).thenReturn(Map.of());
    when(structures.maintenance(repository, "sync"))
        .thenReturn(
            Map.of(
                "executable",
                "./gradlew",
                "args",
                List.of("--refresh-dependencies", ":argusResolveDependencies")));
    when(structures.gradleSyncScript()).thenReturn("fixed product script");
    when(runtime.projectRuntime(eq(repository), anyMap()))
        .thenAnswer(
            call ->
                Map.of(
                    "configuration",
                    call.getArgument(1),
                    "environment",
                    Map.of("JAVA_HOME", "/jdk")));
    when(processes.runGradleTask(anyMap(), eq(repository), anyMap(), anyString()))
        .thenReturn(Map.of("id", "process"));
  }

  @Test
  void noConfigurationAndExactSyntheticIdentityUseSharedOwnedTask() {
    setup();
    for (String id : List.of("", "repository:repo"))
      assertEquals(
          "process",
          controller
              .maintenance("repo", Map.of("action", "sync", "configurationId", id))
              .get("id"));
    verify(workspace, never()).runConfiguration(anyString());
    verify(runtime, never()).maintenanceEnvironment(anyString());
    verify(processes, times(2))
        .runGradleTask(
            argThat(config -> "repository:repo".equals(config.get("id"))),
            eq(repository),
            eq(Map.of("JAVA_HOME", "/jdk")),
            eq("fixed product script"));
  }

  @Test
  void configuredSyncPreservesServicesEnvironmentAndRejectsOtherRepositories() {
    setup();
    when(workspace.runConfiguration("service")).thenReturn(Map.of("repositoryId", "repo"));
    when(runtime.maintenanceEnvironment("service")).thenReturn(Map.of("BUILD_FLAG", "fixture"));
    controller.maintenance("repo", Map.of("action", "sync", "configurationId", "service"));
    verify(processes)
        .runGradleTask(
            anyMap(),
            eq(repository),
            eq(Map.of("JAVA_HOME", "/jdk", "BUILD_FLAG", "fixture")),
            anyString());
    when(workspace.runConfiguration("foreign")).thenReturn(Map.of("repositoryId", "elsewhere"));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.maintenance("repo", Map.of("action", "sync", "configurationId", "foreign")));
  }

  @Test
  void syntheticStopCannotStopAnotherService() {
    setup();
    when(processes.getByConfiguration("repository:repo")).thenReturn(Map.of("id", "sync-process"));
    controller.stopMaintenance("repo");
    verify(processes).stop("sync-process");
    verify(processes).getByConfiguration("repository:repo");
    verifyNoMoreInteractions(processes);
  }
}
