package com.argus.onboarding.controller;

import com.argus.onboarding.service.AiKitGenerationService;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/repositories/{id}/ai-kit")
public class RepositoryAiKitController {
  private final AiKitGenerationService kits;

  public RepositoryAiKitController(AiKitGenerationService kits) {
    this.kits = kits;
  }

  @GetMapping
  public Map<String, Object> status(@PathVariable String id) {
    return kits.repositoryStatus(id);
  }

  @PostMapping("/{action}")
  public Map<String, Object> control(@PathVariable String id, @PathVariable String action) {
    return kits.control(id, action);
  }
}
