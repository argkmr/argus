package com.argus.agents.controller;

import com.argus.agents.service.AgentModelCatalogService;
import com.argus.agents.service.CliCapabilityService;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CliMetadataController {
  private final AgentModelCatalogService models;
  private final CliCapabilityService capabilities;
  private final WorkspaceService workspace;

  public CliMetadataController(
      AgentModelCatalogService models,
      CliCapabilityService capabilities,
      WorkspaceService workspace) {
    this.models = models;
    this.capabilities = capabilities;
    this.workspace = workspace;
  }

  @GetMapping("/api/agents/model-catalog/{providerId}")
  public Map<String, Object> models(
      @PathVariable String providerId, @RequestParam(defaultValue = "false") boolean refresh) {
    return models.discover(providerId, refresh);
  }

  @GetMapping("/api/agents/capabilities/{providerId}")
  public Map<String, Object> capabilities(
      @PathVariable String providerId,
      @RequestParam(defaultValue = "") String repositoryId,
      @RequestParam(defaultValue = "false") boolean refresh) {
    Path cwd =
        repositoryId.isBlank() ? null : Path.of(workspace.requireRepository(repositoryId).path());
    return capabilities.discover(providerId, cwd, refresh);
  }
}
