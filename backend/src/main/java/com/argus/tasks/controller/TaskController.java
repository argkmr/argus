package com.argus.tasks.controller;

import com.argus.common.constants.ApiRoutes;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.dto.TaskSummary;
import com.argus.tasks.service.TaskService;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.TASKS)
public class TaskController {
  private final TaskService tasks;

  public TaskController(TaskService tasks) {
    this.tasks = tasks;
  }

  @GetMapping
  public List<TaskSummary> list(
      @RequestParam(required = false) String scope,
      @RequestParam(required = false) String repositoryId) {
    return tasks.list(scope, repositoryId);
  }

  @GetMapping("/{id}")
  public AiTask get(@PathVariable String id) {
    return tasks.get(id);
  }

  @GetMapping("/{id}/revisions")
  public List<Map<String, Object>> revisions(@PathVariable String id) {
    return tasks.revisions(id);
  }

  @GetMapping("/{id}/revisions/{revisionId}")
  public Map<String, Object> revision(@PathVariable String id, @PathVariable String revisionId) {
    return tasks.revision(id, revisionId);
  }

  // Mutations share TaskService through the native TaskMutationController.
}
