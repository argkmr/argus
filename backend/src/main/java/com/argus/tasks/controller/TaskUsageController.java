package com.argus.tasks.controller;

import com.argus.common.constants.ApiRoutes;
import com.argus.tasks.service.TaskUsageService;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.TASKS)
public class TaskUsageController {
  private final TaskUsageService usage;

  public TaskUsageController(TaskUsageService usage) {
    this.usage = usage;
  }

  @GetMapping("/{taskId}/messages/{messageId}/usage")
  public CompletableFuture<Map<String, Object>> usage(
      @PathVariable String taskId, @PathVariable String messageId) {
    return usage.usage(taskId, messageId);
  }
}
