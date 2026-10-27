package com.argus.git.controller;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.error.ConflictException;
import com.argus.git.dto.*;
import com.argus.git.service.GitService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class GitControllerFileActionTest {
  @Test
  void explicitRepositoryPreviewAndRevisionBoundActionExposeRecoveryLocations() throws Exception {
    var git = mock(GitService.class);
    var workspace = mock(WorkspaceService.class);
    Path root = Path.of("/disposable-fixture");
    String revision = "a".repeat(64);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Fixture", root.toString(), ""));
    when(git.fileActionPreview(root, "new file.txt", "delete"))
        .thenReturn(
            new GitFileActionPreview(
                "new file.txt", "delete", true, "", revision, true, true, "/private/recovery"));
    var request = new GitFileActionRequest("new file.txt", revision);
    when(git.fileAction(root, "repo", "delete", request))
        .thenReturn(
            new GitFileActionResponse(
                true,
                "new file.txt",
                "delete",
                false,
                "New file deleted",
                List.of("receipt"),
                List.of("/private/recovery/receipt")));
    var mvc =
        MockMvcBuilders.standaloneSetup(new GitController(git, workspace))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    var preview =
        mvc.perform(
                get("/api/repositories/repo/git/file-action-preview")
                    .param("file", "new file.txt")
                    .param("action", "delete"))
            .andReturn()
            .getResponse();
    assertThat(preview.getStatus()).isEqualTo(200);
    assertThat(preview.getContentAsString())
        .contains("\"allowed\":true", "\"staged\":true", revision, "/private/recovery");
    var response =
        mvc.perform(
                post("/api/repositories/repo/git/file-action")
                    .param("action", "delete")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"file\":\"new file.txt\",\"expectedRevision\":\"" + revision + "\"}"))
            .andReturn()
            .getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(response.getContentAsString())
        .contains("\"ok\":true", "\"recoveryPaths\":[\"/private/recovery/receipt\"]");
    verify(git).fileAction(root, "repo", "delete", request);
  }

  @Test
  void staleConfirmationReturnsConflictAndFullRevertPartialSuccessRemainsExplicit()
      throws Exception {
    var git = mock(GitService.class);
    var workspace = mock(WorkspaceService.class);
    Path root = Path.of("/disposable-fixture");
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Fixture", root.toString(), ""));
    var request = new GitFileActionRequest("tracked.txt", "a".repeat(64));
    when(git.fileAction(root, "repo", "revert", request))
        .thenThrow(new ConflictException("Changed; inspect again"));
    var mvc =
        MockMvcBuilders.standaloneSetup(new GitController(git, workspace))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    String body =
        "{\"file\":\"tracked.txt\",\"expectedRevision\":\"" + request.expectedRevision() + "\"}";
    var conflict =
        mvc.perform(
                post("/api/repositories/repo/git/file-action")
                    .param("action", "revert")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body))
            .andReturn()
            .getResponse();
    assertThat(conflict.getStatus()).isEqualTo(409);
    assertThat(conflict.getContentAsString()).contains("Changed; inspect again");
    doReturn(
            new GitFileActionResponse(
                true,
                "tracked.txt",
                "revert",
                true,
                "Staged part restored; newer working edits kept",
                List.of("receipt"),
                List.of("/private/recovery/receipt")))
        .when(git)
        .fileAction(root, "repo", "revert", request);
    var partial =
        mvc.perform(
                post("/api/repositories/repo/git/file-action")
                    .param("action", "revert")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body))
            .andReturn()
            .getResponse();
    assertThat(partial.getStatus()).isEqualTo(200);
    assertThat(partial.getContentAsString())
        .contains("\"refreshRequired\":true", "newer working edits kept");
  }
}
