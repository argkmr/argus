package com.argus.git.controller;

import com.argus.common.constants.ApiRoutes;
import com.argus.git.dto.GitStashEntry;
import com.argus.git.dto.GitStashPopRequest;
import com.argus.git.dto.GitStashRequest;
import com.argus.git.dto.GitStashResponse;
import com.argus.git.service.GitStashService;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.REPOSITORY_GIT)
public class GitStashController {
  private final GitStashService stashes;
  private final WorkspaceService workspace;

  public GitStashController(GitStashService stashes, WorkspaceService workspace) {
    this.stashes = stashes;
    this.workspace = workspace;
  }

  private Path root(String repositoryId) {
    return Path.of(workspace.requireRepository(repositoryId).path());
  }

  @GetMapping("/stashes")
  public List<GitStashEntry> list(@PathVariable String repositoryId) {
    return stashes.list(root(repositoryId));
  }

  @PostMapping("/stash")
  public GitStashResponse create(
      @PathVariable String repositoryId, @RequestBody(required = false) GitStashRequest request) {
    return stashes.create(root(repositoryId), request);
  }

  @PostMapping("/stash/pop")
  public GitStashResponse pop(
      @PathVariable String repositoryId, @RequestBody GitStashPopRequest request) {
    return stashes.pop(root(repositoryId), request);
  }
}
