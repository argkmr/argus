package com.argus.onboarding.controller;

import com.argus.onboarding.service.AiKitGenerationService;
import com.argus.onboarding.service.RepositoryOnboardingService;
import com.argus.repositorycontext.service.RepositoryContextService;
import com.argus.workspace.service.WorkspaceService;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class NativeOnboardingController {
  private final RepositoryOnboardingService onboarding;
  private final AiKitGenerationService kits;
  private final RepositoryContextService contexts;
  private final WorkspaceService workspace;

  public NativeOnboardingController(
      RepositoryOnboardingService onboarding,
      AiKitGenerationService kits,
      RepositoryContextService contexts,
      WorkspaceService workspace) {
    this.onboarding = onboarding;
    this.kits = kits;
    this.contexts = contexts;
    this.workspace = workspace;
  }

  @PostMapping("/repository-onboarding/jobs")
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> start(@RequestBody Map<String, Object> input) {
    return onboarding.start(input);
  }

  @PostMapping("/ai-kits/refresh")
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> refreshAll() {
    var repositories = workspace.snapshot().repositories();
    if (repositories.isEmpty())
      throw new IllegalArgumentException(
          "Connect at least one repository before refreshing AI kits");
    return kits.request(repositories, "Refreshing production-branch AI kits", false, Map.of());
  }

  @PostMapping("/repositories/{id}/ai-kit/export")
  public Map<String, Object> export(@PathVariable String id) {
    return contexts.exportArtifacts(workspace.requireRepository(id));
  }

  @PostMapping("/repositories/{id}/ai-kit/refresh")
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> refresh(@PathVariable String id) {
    return kits.request(
        List.of(workspace.requireRepository(id)),
        "Refreshing production-branch AI kits",
        false,
        Map.of());
  }
}
