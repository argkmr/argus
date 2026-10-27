package com.argus.tasks.controller;

import com.argus.common.constants.ApiRoutes;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.service.TaskCheckpointService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.TASKS + "/{id}/checkpoints/{messageId}")
public class TaskCheckpointController {
  private final TaskCheckpointService checkpoints;

  public TaskCheckpointController(TaskCheckpointService checkpoints) {
    this.checkpoints = checkpoints;
  }

  @PutMapping
  public AiTask mark(@PathVariable String id, @PathVariable String messageId) {
    return checkpoints.mark(id, messageId);
  }

  @DeleteMapping
  public AiTask remove(@PathVariable String id, @PathVariable String messageId) {
    return checkpoints.remove(id, messageId);
  }
}
