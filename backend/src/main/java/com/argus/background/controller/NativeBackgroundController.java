package com.argus.background.controller;

import com.argus.background.service.BackgroundJobService;
import com.argus.background.service.BackgroundOperationService;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/background-jobs")
public class NativeBackgroundController {
  private final BackgroundJobService jobs;
  private final BackgroundOperationService operations;

  public NativeBackgroundController(
      BackgroundJobService jobs, BackgroundOperationService operations) {
    this.jobs = jobs;
    this.operations = operations;
  }

  @GetMapping
  public List<Map<String, Object>> list() {
    return jobs.list();
  }

  @PostMapping("/{id}/pause")
  public Map<String, Object> pause(@PathVariable String id) {
    return operations.pause(id);
  }

  @PostMapping("/{id}/resume")
  public Map<String, Object> resume(@PathVariable String id) {
    return operations.resume(id);
  }

  @DeleteMapping("/{id}")
  public Map<String, Object> cancel(@PathVariable String id) {
    return operations.cancel(id);
  }
}
