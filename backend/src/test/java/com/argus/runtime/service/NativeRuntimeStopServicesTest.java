package com.argus.runtime.service;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.argus.runtime.controller.NativeRuntimeController;
import com.argus.workspace.service.WorkspaceService;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class NativeRuntimeStopServicesTest {
  @Test
  void postReturnsTheBulkStopResultWithoutCallingShutdownOrConfigurationActions() throws Exception {
    var processes = mock(ProcessManager.class);
    var runtime = mock(RuntimeConfigurationService.class);
    var controller =
        new NativeRuntimeController(
            runtime,
            processes,
            mock(WorkspaceService.class),
            mock(JavaProjectService.class),
            mock(ProjectStructureService.class));
    when(processes.stopServices())
        .thenReturn(
            Map.of(
                "targeted",
                List.of(
                    Map.of(
                        "id",
                        "exact-process",
                        "configurationId",
                        "saved-service",
                        "name",
                        "Fixture")),
                "stopped",
                List.of("exact-process"),
                "failures",
                List.of(),
                "processes",
                List.of(Map.of("id", "exact-process", "status", "stopped"))));
    MockMvcBuilders.standaloneSetup(controller)
        .build()
        .perform(post("/api/processes/stop-services"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.targeted[0].configurationId").value("saved-service"))
        .andExpect(jsonPath("$.stopped[0]").value("exact-process"))
        .andExpect(jsonPath("$.failures").isEmpty())
        .andExpect(jsonPath("$.processes[0].status").value("stopped"));
    verify(processes).stopServices();
    verifyNoMoreInteractions(processes);
    verifyNoInteractions(runtime);
  }
}
