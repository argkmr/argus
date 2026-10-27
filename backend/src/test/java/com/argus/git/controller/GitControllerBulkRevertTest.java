package com.argus.git.controller;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.common.error.*;
import com.argus.git.dto.*;
import com.argus.git.service.GitService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.*;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

class GitControllerBulkRevertTest {
  @Test
  void previewAndApplyExposeExactPerFileViewRevisionAndPartialRecoveryResults() throws Exception {
    var git = mock(GitService.class);
    var workspace = mock(WorkspaceService.class);
    Path root = Path.of("/disposable-fixture");
    String revision = "a".repeat(64);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Fixture", root.toString(), ""));
    var previewRequest =
        new GitBulkRevertRequest(List.of(new GitBulkRevertRequest.File("tracked.txt", false)));
    when(git.bulkRevertPreview(root, previewRequest))
        .thenReturn(
            new GitBulkRevertPreview(
                true,
                "",
                List.of(
                    new GitBulkRevertPreview.File(
                        "tracked.txt", false, true, "", revision, "index", "worktree")),
                "/private/recovery",
                25));
    var applyRequest =
        new GitBulkRevertRequest(
            List.of(new GitBulkRevertRequest.File("tracked.txt", false, revision)));
    when(git.bulkRevert(root, "repo", applyRequest))
        .thenReturn(
            new GitBulkRevertResponse(
                false,
                true,
                "Review results",
                List.of(
                    new GitBulkRevertResponse.Result(
                        "tracked.txt", false, "reverted", "", "receipt-id", "Restored")),
                List.of("/private/recovery/receipt-id"),
                true));
    var mvc =
        MockMvcBuilders.standaloneSetup(new GitController(git, workspace))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    var preview =
        mvc.perform(
                post("/api/repositories/repo/git/bulk-revert/preview")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"files\":[{\"file\":\"tracked.txt\",\"staged\":false}]}"))
            .andReturn()
            .getResponse();
    assertThat(preview.getStatus()).isEqualTo(200);
    assertThat(preview.getContentAsString())
        .contains("\"allowed\":true", "\"maxFiles\":25", revision, "\"target\":\"worktree\"");
    var applied =
        mvc.perform(
                post("/api/repositories/repo/git/bulk-revert")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"files\":[{\"file\":\"tracked.txt\",\"staged\":false,\"expectedRevision\":\""
                            + revision
                            + "\"}]}"))
            .andReturn()
            .getResponse();
    assertThat(applied.getStatus()).isEqualTo(200);
    assertThat(applied.getContentAsString())
        .contains(
            "\"ok\":false",
            "\"partial\":true",
            "\"status\":\"reverted\"",
            "\"recoveryPaths\":[\"/private/recovery/receipt-id\"]",
            "\"refreshRequired\":true");
    verify(git).bulkRevert(root, "repo", applyRequest);
    verify(git).bulkRevertPreview(root, previewRequest);
  }

  @Test
  void invalidStaleAndUnsupportedSelectionsKeepTheirHttpErrorSemantics() throws Exception {
    var git = mock(GitService.class);
    var workspace = mock(WorkspaceService.class);
    Path root = Path.of("/disposable-fixture");
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Fixture", root.toString(), ""));
    var mvc =
        MockMvcBuilders.standaloneSetup(new GitController(git, workspace))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    String body =
        "{\"files\":[{\"file\":\"tracked.txt\",\"staged\":false,\"expectedRevision\":\""
            + "a".repeat(64)
            + "\"}]}";
    when(git.bulkRevert(any(), eq("repo"), any()))
        .thenThrow(new ConflictException("Selection changed; nothing was reverted"));
    var stale =
        mvc.perform(
                post("/api/repositories/repo/git/bulk-revert")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body))
            .andReturn()
            .getResponse();
    assertThat(stale.getStatus()).isEqualTo(409);
    assertThat(stale.getContentAsString()).contains("nothing was reverted");
    when(git.bulkRevert(any(), eq("repo"), any()))
        .thenThrow(
            new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Unsupported selection"));
    assertThat(
            mvc.perform(
                    post("/api/repositories/repo/git/bulk-revert")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(422);
    when(git.bulkRevert(any(), eq("repo"), any()))
        .thenThrow(new IllegalArgumentException("Duplicate paths"));
    assertThat(
            mvc.perform(
                    post("/api/repositories/repo/git/bulk-revert")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
    clearInvocations(git);
    assertThat(
            mvc.perform(
                    post("/api/repositories/repo/git/bulk-revert")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
    verifyNoInteractions(git);
  }
}
