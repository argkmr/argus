package com.argus.tasks.controller;

import com.argus.agents.service.AgentRunService;
import com.argus.tasks.service.PromptQueueService;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/prompt-queue")
public class PromptQueueController {
  private final PromptQueueService queue;
  private final AgentRunService runs;

  public PromptQueueController(PromptQueueService queue, AgentRunService runs) {
    this.queue = queue;
    this.runs = runs;
  }

  @GetMapping
  public List<Map<String, Object>> list(@RequestParam(required = false) String taskId) {
    return queue.list(taskId);
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> enqueue(@RequestBody Map<String, Object> input) {
    return runs.enqueue(input);
  }

  @PatchMapping("/{id}")
  public Map<String, Object> edit(@PathVariable String id, @RequestBody Map<String, Object> input) {
    return queue.edit(id, input);
  }

  @PostMapping("/{id}/claim")
  public Map<String, Object> claim(@PathVariable String id) {
    return runs.claimQueuedPrompt(id);
  }

  @PostMapping("/{id}/steer")
  public Map<String, Object> steer(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    return runs.steerQueuedPrompt(id, input);
  }

  @PostMapping("/{id}/steer/reconcile")
  public Map<String, Object> reconcileSteer(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    return runs.reconcileSteeredPrompt(id, input);
  }

  @PostMapping("/resume")
  public List<Map<String, Object>> resume(@RequestBody Map<String, Object> input) {
    return runs.resumeQueuedPrompts(input);
  }

  @PostMapping("/{id}/interrupted")
  public Map<String, Object> interrupted(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    return queue.interrupted(id, input.get("error"), input.get("dispatchToken"));
  }

  @DeleteMapping("/{id}")
  public Map<String, Object> remove(@PathVariable String id) {
    return queue.remove(id);
  }
}
