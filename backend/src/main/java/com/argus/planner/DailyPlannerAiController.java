package com.argus.planner;

import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/daily-planner/ai/proposals")
public class DailyPlannerAiController {
  private final DailyPlannerAiService service;

  public DailyPlannerAiController(DailyPlannerAiService service) {
    this.service = service;
  }

  @PostMapping
  public Map<String, Object> start(@RequestBody Map<String, Object> input) {
    return service.start(input);
  }

  @GetMapping("/{id}")
  public Map<String, Object> get(@PathVariable String id) {
    return service.get(id);
  }

  @DeleteMapping("/{id}")
  public Map<String, Object> cancel(@PathVariable String id) {
    return service.cancel(id);
  }
}
