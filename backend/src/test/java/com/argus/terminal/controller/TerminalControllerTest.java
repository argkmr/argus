package com.argus.terminal.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.error.ConflictException;
import com.argus.terminal.service.TerminalService;
import com.argus.workspace.service.WorkspaceService;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class TerminalControllerTest {
  @Test
  void offboardingPurgeIsRetryableWithoutARegisteredRepositoryAndPropagatesFailure()
      throws Exception {
    TerminalService terminals = Mockito.mock(TerminalService.class);
    WorkspaceService workspace = Mockito.mock(WorkspaceService.class);
    var mvc =
        MockMvcBuilders.standaloneSetup(new TerminalController(terminals, workspace))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    var success =
        mvc.perform(post("/api/repositories/repo-a/terminal/purge")).andReturn().getResponse();
    assertThat(success.getStatus()).isEqualTo(200);
    assertThat(success.getContentAsString()).contains("\"ok\":true", "\"repositoryId\":\"repo-a\"");
    Mockito.verify(terminals).purge("repo-a");
    Mockito.verifyNoInteractions(workspace);
    Mockito.doThrow(new ConflictException("Terminal still running"))
        .when(terminals)
        .purge("repo-b");
    assertThat(
            mvc.perform(post("/api/repositories/repo-b/terminal/purge"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(409);
  }

  @Test
  void nativeShutdownWaitsForAllTerminalsAndReportsAnyCleanupFailure() throws Exception {
    TerminalService terminals = Mockito.mock(TerminalService.class);
    var mvc =
        MockMvcBuilders.standaloneSetup(new TerminalLifecycleController(terminals))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    assertThat(mvc.perform(post("/api/terminals/purge-all")).andReturn().getResponse().getStatus())
        .isEqualTo(200);
    Mockito.verify(terminals).stopAll();
    Mockito.doThrow(new ConflictException("Terminal still running")).when(terminals).stopAll();
    assertThat(mvc.perform(post("/api/terminals/purge-all")).andReturn().getResponse().getStatus())
        .isEqualTo(409);
  }
}
