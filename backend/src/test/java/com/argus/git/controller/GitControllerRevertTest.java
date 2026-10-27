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
import org.junit.jupiter.api.Test;
import org.springframework.http.*;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

class GitControllerRevertTest {
  @Test
  void diffMetadataAndExactViewedRevisionAreExposedByTheRepositoryRoute() throws Exception {
    var git = mock(GitService.class);
    var workspace = mock(WorkspaceService.class);
    Path root = Path.of("/disposable-fixture");
    String revision = "a".repeat(64);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Fixture", root.toString(), ""));
    when(git.diff(root, "tracked.txt", false))
        .thenReturn(
            new GitDiffResponse(
                "diff",
                "INDEX",
                "WORKING",
                false,
                new GitRevertAvailability(true, "", revision, "index", "worktree")));
    var request = new GitRevertRequest("tracked.txt", false, revision);
    when(git.revert(root, "repo", request))
        .thenReturn(
            new GitRevertResponse(
                true, "tracked.txt", false, "index", "worktree", "b".repeat(64), "opaque-id"));
    var mvc =
        MockMvcBuilders.standaloneSetup(new GitController(git, workspace))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    var preview =
        mvc.perform(get("/api/repositories/repo/git/diff").param("file", "tracked.txt"))
            .andReturn()
            .getResponse();
    assertThat(preview.getStatus()).isEqualTo(200);
    assertThat(preview.getContentAsString())
        .contains("\"allowed\":true", "\"baseline\":\"index\"", revision);
    var response =
        mvc.perform(
                post("/api/repositories/repo/git/revert")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"file\":\"tracked.txt\",\"staged\":false,\"expectedRevision\":\""
                            + revision
                            + "\"}"))
            .andReturn()
            .getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(response.getContentAsString())
        .contains("\"recoveryId\":\"opaque-id\"", "\"target\":\"worktree\"");
    verify(git).revert(root, "repo", request);
  }

  @Test
  void inlineRangesAndOptionalChangeIdRoundTripWithoutAcceptingAClientPatch() throws Exception {
    var git = mock(GitService.class);
    var workspace = mock(WorkspaceService.class);
    Path root = Path.of("/disposable-fixture");
    String revision = "a".repeat(64), changeId = "c".repeat(64);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Fixture", root.toString(), ""));
    when(git.diff(root, "tracked.txt", true))
        .thenReturn(
            new GitDiffResponse(
                "diff",
                "HEAD",
                "INDEX",
                false,
                new GitRevertAvailability(true, "", revision, "HEAD", "index"),
                java.util.List.of(new GitDiffChange(changeId, 3, 1, 3, 0))));
    var request = new GitRevertRequest("tracked.txt", true, revision, changeId);
    when(git.revert(root, "repo", request))
        .thenReturn(
            new GitRevertResponse(
                true, "tracked.txt", true, "HEAD", "index", "b".repeat(64), "receipt"));
    var mvc =
        MockMvcBuilders.standaloneSetup(new GitController(git, workspace))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    var preview =
        mvc.perform(
                get("/api/repositories/repo/git/diff")
                    .param("file", "tracked.txt")
                    .param("staged", "true"))
            .andReturn()
            .getResponse();
    assertThat(preview.getStatus()).isEqualTo(200);
    assertThat(preview.getContentAsString())
        .contains(
            "\"changes\":[",
            changeId,
            "\"beforeStart\":3",
            "\"beforeCount\":1",
            "\"afterStart\":3",
            "\"afterCount\":0");
    var result =
        mvc.perform(
                post("/api/repositories/repo/git/revert")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"file\":\"tracked.txt\",\"staged\":true,\"expectedRevision\":\""
                            + revision
                            + "\",\"changeId\":\""
                            + changeId
                            + "\"}"))
            .andReturn()
            .getResponse();
    assertThat(result.getStatus()).isEqualTo(200);
    assertThat(result.getContentAsString())
        .contains("\"target\":\"index\"", "\"recoveryId\":\"receipt\"");
    verify(git).revert(root, "repo", request);
  }

  @Test
  void conflictsAndUnsupportedFilesRemainDistinctAndInvalidJsonCannotMutate() throws Exception {
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
        "{\"file\":\"tracked.txt\",\"staged\":true,\"expectedRevision\":\""
            + "a".repeat(64)
            + "\"}";
    when(git.revert(any(), eq("repo"), any())).thenThrow(new ConflictException("Reload this diff"));
    assertThat(
            mvc.perform(
                    post("/api/repositories/repo/git/revert")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(409);
    when(git.revert(any(), eq("repo"), any()))
        .thenThrow(
            new ResponseStatusException(
                HttpStatus.UNPROCESSABLE_ENTITY, "Untracked file will not be deleted"));
    assertThat(
            mvc.perform(
                    post("/api/repositories/repo/git/revert")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(422);
    clearInvocations(git);
    assertThat(
            mvc.perform(
                    post("/api/repositories/repo/git/revert")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
    verifyNoInteractions(git);
  }
}
