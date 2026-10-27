package com.argus.git.controller;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.git.dto.GitStashEntry;
import com.argus.git.dto.GitStashPopRequest;
import com.argus.git.dto.GitStashRequest;
import com.argus.git.dto.GitStashResponse;
import com.argus.git.service.GitStashService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class GitStashControllerTest {
  private final Path root = Path.of("/disposable-fixture");
  private final GitStashEntry entry =
      new GitStashEntry("a".repeat(40), "stash@{1}", "On main: local work", "2026-09-08T00:00:00Z");
  private GitStashService stashes;
  private WorkspaceService workspace;
  private MockMvc mvc;

  @BeforeEach
  void setup() {
    stashes = mock(GitStashService.class);
    workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Fixture", root.toString(), ""));
    mvc =
        MockMvcBuilders.standaloneSetup(new GitStashController(stashes, workspace))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
  }

  @Test
  void listExposesStableIdentityAndCurrentRefWithinConnectedRepository() throws Exception {
    when(stashes.list(root)).thenReturn(List.of(entry));
    var response = mvc.perform(get("/api/repositories/repo/git/stashes")).andReturn().getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(response.getContentAsString())
        .contains(entry.id(), "stash@{1}", "local work", "createdAt");
    verify(stashes).list(root);
    verify(workspace).requireRepository("repo");
  }

  @Test
  void createAcceptsOptInUntrackedAndKeepsMissingFlagFalse() throws Exception {
    var saved = new GitStashResponse(true, "created", entry, false, false, true, "Stashed locally");
    when(stashes.create(eq(root), any())).thenReturn(saved);
    var result =
        mvc.perform(
                post("/api/repositories/repo/git/stash")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"message\":\"save\",\"includeUntracked\":true}"))
            .andReturn()
            .getResponse();
    assertThat(result.getStatus()).isEqualTo(200);
    assertThat(result.getContentAsString())
        .contains("\"status\":\"created\"", "\"stashRetained\":true");
    verify(stashes).create(root, new GitStashRequest("save", true));
    assertThat(
            mvc.perform(
                    post("/api/repositories/repo/git/stash")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"message\":\"tracked only\"}"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(200);
    verify(stashes).create(root, new GitStashRequest("tracked only", false));
  }

  @Test
  void emptyObjectAndExplicitNullStayTrackedOnly() throws Exception {
    when(stashes.create(eq(root), any()))
        .thenReturn(
            new GitStashResponse(true, "empty", null, false, false, false, "No eligible changes."));
    for (String body : List.of("{}", "{\"includeUntracked\":null}")) {
      assertThat(
              mvc.perform(
                      post("/api/repositories/repo/git/stash")
                          .contentType(MediaType.APPLICATION_JSON)
                          .content(body))
                  .andReturn()
                  .getResponse()
                  .getStatus())
          .isEqualTo(200);
    }
    verify(stashes, times(2)).create(root, new GitStashRequest(null, false));
  }

  @Test
  void popPassesExactSelectionAndRetainedFailureRemainsStructured() throws Exception {
    var request = new GitStashPopRequest(entry.id(), entry.ref());
    when(stashes.pop(root, request))
        .thenReturn(
            new GitStashResponse(
                false, "conflicts", entry, false, false, true, "The stash was kept."));
    var result =
        mvc.perform(
                post("/api/repositories/repo/git/stash/pop")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"id\":\"" + entry.id() + "\",\"ref\":\"stash@{1}\"}"))
            .andReturn()
            .getResponse();
    assertThat(result.getStatus()).isEqualTo(200);
    assertThat(result.getContentAsString())
        .contains(
            "\"ok\":false",
            "\"status\":\"conflicts\"",
            "\"stashRetained\":true",
            "\"dropped\":false");
    verify(stashes).pop(root, request);
  }

  @Test
  void staleSelectionIsA409AndMalformedRequestsCannotExecute() throws Exception {
    when(stashes.pop(eq(root), any())).thenThrow(new ConflictException("Refresh the stash list"));
    var result =
        mvc.perform(
                post("/api/repositories/repo/git/stash/pop")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"id\":\"" + entry.id() + "\",\"ref\":\"stash@{1}\"}"))
            .andReturn()
            .getResponse();
    assertThat(result.getStatus()).isEqualTo(409);
    clearInvocations(stashes);
    for (String path : List.of("/stash", "/stash/pop")) {
      var invalid =
          mvc.perform(
                  post("/api/repositories/repo/git" + path)
                      .contentType(MediaType.APPLICATION_JSON)
                      .content("{"))
              .andReturn()
              .getResponse();
      assertThat(invalid.getStatus()).isEqualTo(400);
    }
    assertThat(
            mvc.perform(post("/api/repositories/repo/git/stash/pop"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
    verifyNoInteractions(stashes);
  }

  @Test
  void unknownRepositoryNeverReachesGitService() throws Exception {
    when(workspace.requireRepository("unknown"))
        .thenThrow(new NotFoundException("Repository not found"));
    assertThat(
            mvc.perform(get("/api/repositories/unknown/git/stashes"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
    assertThat(
            mvc.perform(
                    post("/api/repositories/unknown/git/stash")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
    assertThat(
            mvc.perform(
                    post("/api/repositories/unknown/git/stash/pop")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"id\":\"" + entry.id() + "\",\"ref\":\"stash@{1}\"}"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
    verifyNoInteractions(stashes);
  }
}
