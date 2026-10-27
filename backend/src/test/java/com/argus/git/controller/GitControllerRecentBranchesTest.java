package com.argus.git.controller;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.git.dto.GitBranch;
import com.argus.git.service.GitService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class GitControllerRecentBranchesTest {
  @Test
  void recentEndpointUsesTheExplicitConnectedRepositoryAndPreservesOrdering() throws Exception {
    var git = mock(GitService.class);
    var workspace = mock(WorkspaceService.class);
    Path root = Path.of("/disposable-fixture");
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Fixture", root.toString(), ""));
    when(git.recentBranches(root))
        .thenReturn(
            List.of(
                new GitBranch("latest", "refs/heads/latest", "local", false, "", true),
                new GitBranch("older", "refs/heads/older", "local", false, "origin/older", true)));
    var mvc = MockMvcBuilders.standaloneSetup(new GitController(git, workspace)).build();
    var response =
        mvc.perform(get("/api/repositories/repo/git/branches/recent")).andReturn().getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(response.getContentAsString())
        .contains("\"name\":\"latest\"", "\"name\":\"older\"", "\"upstream\":\"origin/older\"");
    assertThat(response.getContentAsString().indexOf("latest"))
        .isLessThan(response.getContentAsString().indexOf("older"));
    verify(workspace).requireRepository("repo");
    verify(git).recentBranches(root);
    verifyNoMoreInteractions(git);
  }
}
