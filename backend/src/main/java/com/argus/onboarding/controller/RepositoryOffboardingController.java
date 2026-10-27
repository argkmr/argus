package com.argus.onboarding.controller;

import com.argus.onboarding.service.RepositoryOffboardingService;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
public class RepositoryOffboardingController {
  private final RepositoryOffboardingService offboarding;

  public RepositoryOffboardingController(RepositoryOffboardingService offboarding) {
    this.offboarding = offboarding;
  }

  @PostMapping("/api/repository-offboarding/jobs")
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> start(@RequestBody Map<String, Object> input) {
    return offboarding.start(input);
  }

  @DeleteMapping("/api/repositories/{repositoryId}")
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> remove(
      @PathVariable String repositoryId, @RequestBody Map<String, Object> input) {
    var request = new LinkedHashMap<>(input);
    request.put("repositoryIds", List.of(repositoryId));
    return offboarding.start(request);
  }
}
