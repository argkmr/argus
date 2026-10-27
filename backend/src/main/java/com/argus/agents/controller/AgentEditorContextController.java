package com.argus.agents.controller;

import com.argus.agents.service.AgentEditorContextService;
import com.argus.workspace.service.WorkspaceService;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AgentEditorContextController {
  private final AgentEditorContextService context;
  private final WorkspaceService workspace;

  public AgentEditorContextController(
      AgentEditorContextService context, WorkspaceService workspace) {
    this.context = context;
    this.workspace = workspace;
  }

  @GetMapping("/api/agent/editor-context")
  public Map<String, String> current() {
    var snapshot = workspace.snapshot();
    return Map.of(
        "context",
        context.build(
            snapshot.repositories(), snapshot.runConfigurations(), snapshot.activeRepositoryId()));
  }
}
