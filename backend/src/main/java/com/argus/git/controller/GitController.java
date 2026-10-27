package com.argus.git.controller;

import com.argus.common.constants.ApiRoutes;
import com.argus.common.process.CommandResult;
import com.argus.git.dto.*;
import com.argus.git.service.GitService;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.REPOSITORY_GIT)
public class GitController {
  private final GitService git;
  private final WorkspaceService workspace;

  public GitController(GitService git, WorkspaceService workspace) {
    this.git = git;
    this.workspace = workspace;
  }

  private Path root(String id) {
    return Path.of(workspace.requireRepository(id).path());
  }

  @GetMapping("/status")
  public GitStatusResponse status(@PathVariable String repositoryId) {
    return git.status(root(repositoryId));
  }

  @GetMapping("/history")
  public List<GitHistoryItem> history(
      @PathVariable String repositoryId, @RequestParam(defaultValue = "80") int limit) {
    return git.history(root(repositoryId), limit);
  }

  @GetMapping("/branches")
  public List<GitBranch> branches(@PathVariable String repositoryId) {
    return git.branches(root(repositoryId));
  }

  @GetMapping("/branches/recent")
  public List<GitBranch> recentBranches(@PathVariable String repositoryId) {
    return git.recentBranches(root(repositoryId));
  }

  @GetMapping("/diff")
  public GitDiffResponse diff(
      @PathVariable String repositoryId,
      @RequestParam String file,
      @RequestParam(defaultValue = "false") boolean staged) {
    return git.diff(root(repositoryId), file, staged);
  }

  @PostMapping("/{action:stage|unstage|discard|commit|fetch|pull}")
  public GitActionResponse action(
      @PathVariable String repositoryId,
      @PathVariable String action,
      @RequestBody(required = false) GitActionRequest request) {
    GitActionRequest input =
        request == null ? new GitActionRequest(List.of(), "", "", "", "") : request;
    Path root = root(repositoryId);
    CommandResult result =
        switch (action) {
          case "stage" -> git.stage(root, input.files());
          case "unstage" -> git.unstage(root, input.files());
          case "discard" -> git.discard(root, input.files());
          case "commit" -> git.commit(root, input.message());
          case "fetch" -> git.fetch(root);
          case "pull" -> git.pull(root);
          default -> throw new IllegalArgumentException("Unsupported Git action");
        };
    return GitActionResponse.of(result.stdout(), result.stderr());
  }

  @PostMapping("/revert")
  public GitRevertResponse revert(
      @PathVariable String repositoryId, @RequestBody GitRevertRequest request) {
    return git.revert(root(repositoryId), repositoryId, request);
  }

  @PostMapping("/bulk-revert/preview")
  public GitBulkRevertPreview bulkRevertPreview(
      @PathVariable String repositoryId, @RequestBody GitBulkRevertRequest request) {
    return git.bulkRevertPreview(root(repositoryId), request);
  }

  @PostMapping("/bulk-revert")
  public GitBulkRevertResponse bulkRevert(
      @PathVariable String repositoryId, @RequestBody GitBulkRevertRequest request) {
    return git.bulkRevert(root(repositoryId), repositoryId, request);
  }

  @GetMapping("/file-action-preview")
  public GitFileActionPreview fileActionPreview(
      @PathVariable String repositoryId, @RequestParam String file, @RequestParam String action) {
    return git.fileActionPreview(root(repositoryId), file, action);
  }

  @PostMapping("/file-action")
  public GitFileActionResponse fileAction(
      @PathVariable String repositoryId,
      @RequestParam String action,
      @RequestBody GitFileActionRequest request) {
    return git.fileAction(root(repositoryId), repositoryId, action, request);
  }

  @PostMapping("/push")
  public GitActionResponse push(@PathVariable String repositoryId) {
    return git.push(root(repositoryId));
  }

  @PostMapping("/switch")
  public GitActionResponse switchBranch(
      @PathVariable String repositoryId, @RequestBody GitActionRequest request) {
    CommandResult result = git.switchBranch(root(repositoryId), request.branch());
    return GitActionResponse.of(result.stdout(), result.stderr());
  }

  @PostMapping("/branch")
  @ResponseStatus(HttpStatus.CREATED)
  public GitActionResponse branch(
      @PathVariable String repositoryId, @RequestBody GitActionRequest request) {
    CommandResult result =
        git.createBranch(root(repositoryId), request.name(), request.startPoint());
    return GitActionResponse.of(result.stdout(), result.stderr());
  }
}
