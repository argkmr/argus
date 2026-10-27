package com.argus.onboarding.controller;

import com.argus.onboarding.service.RepositoryCloneJobService;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/repository-onboarding/clone/jobs")
public class RepositoryCloneController {
  private final RepositoryCloneJobService clones;

  public RepositoryCloneController(RepositoryCloneJobService clones) {
    this.clones = clones;
  }

  @PostMapping
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> start(@RequestBody Map<String, Object> input) {
    return clones.start(input);
  }

  @GetMapping
  public Map<String, Object> list() {
    return Map.of("jobs", clones.listJobs());
  }

  @GetMapping("/{id}")
  public Map<String, Object> status(@PathVariable String id) {
    return clones.status(id);
  }

  @PostMapping("/{id}/cancel")
  public Map<String, Object> cancel(@PathVariable String id) {
    return clones.cancel(id);
  }
}
