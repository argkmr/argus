package com.argus.tasks.controller;

import com.argus.common.constants.ApiRoutes;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.service.TaskCommandService;
import com.argus.tasks.service.TaskService;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.TASKS)
public class TaskMutationController {
  private final TaskService tasks;
  private final TaskCommandService commands;

  public TaskMutationController(TaskService tasks, TaskCommandService commands) {
    this.tasks = tasks;
    this.commands = commands;
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public AiTask create(@RequestBody Map<String, Object> input) {
    return tasks.create(input);
  }

  @PatchMapping("/{id}")
  public AiTask rename(@PathVariable String id, @RequestBody Map<String, Object> input) {
    return tasks.rename(id, java.util.Objects.toString(input.get("title"), ""));
  }

  @DeleteMapping("/{id}")
  public Map<String, Object> remove(@PathVariable String id) {
    return commands.remove(id);
  }

  @PostMapping("/{id}/revisions")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> revise(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    return tasks.revise(id, input);
  }

  @PatchMapping("/{id}/revision-draft")
  public Map<String, Object> draft(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    return tasks.updateRevisionDraft(id, input);
  }

  @PatchMapping("/{id}/model-settings")
  public AiTask settings(@PathVariable String id, @RequestBody Map<String, Object> input) {
    return commands.modelSettings(id, input);
  }

  @PutMapping("/{id}/prompt-notes")
  public AiTask promptNotes(@PathVariable String id, @RequestBody Map<String, Object> input) {
    return tasks.updatePromptNotes(id, input);
  }
}
