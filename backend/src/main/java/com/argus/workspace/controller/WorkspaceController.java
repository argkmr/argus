package com.argus.workspace.controller;

import com.argus.backup.service.BackupOwnerAccess;
import com.argus.common.constants.ApiRoutes;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(ApiRoutes.API)
public class WorkspaceController {
  private final WorkspaceService workspace;
  private final BackupOwnerAccess owner;

  public WorkspaceController(WorkspaceService workspace, BackupOwnerAccess owner) {
    this.workspace = workspace;
    this.owner = owner;
  }

  @GetMapping("/workspace")
  public WorkspaceResponse workspace() {
    var snapshot = workspace.snapshot();
    return new WorkspaceResponse(
        snapshot.version(),
        snapshot.activeRepositoryId(),
        owner.visiblePreferences(snapshot.preferences()),
        snapshot.repositories(),
        snapshot.runConfigurations(),
        snapshot.apiRequests(),
        snapshot.javaProjectSettings(),
        snapshot.extraFields());
  }

  // NativeWorkspaceController owns mutations through the same WorkspaceService.
}
