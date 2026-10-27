package com.argus.tasks.service;

import com.argus.agents.service.AgentExecutionService;
import com.argus.common.error.ConflictException;
import com.argus.tasks.domain.AiTask;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class TaskCommandService {
  private final TaskService tasks;
  private final AgentExecutionService agents;
  private final PromptQueueService queue;

  public TaskCommandService(
      TaskService tasks, AgentExecutionService agents, PromptQueueService queue) {
    this.tasks = tasks;
    this.agents = agents;
    this.queue = queue;
  }

  public AiTask modelSettings(String id, Map<String, Object> input) {
    var task = tasks.get(id);
    String provider = Objects.toString(input.get("provider"), task.provider);
    var merged = new LinkedHashMap<String, Object>();
    merged.put("model", task.model);
    merged.put("effort", task.effort);
    merged.put("speed", task.speed);
    merged.putAll(input);
    var settings = new LinkedHashMap<>(agents.modelSettings(provider, merged));
    settings.put("provider", provider);
    return tasks.updateModelSettings(id, settings);
  }

  public Map<String, Object> remove(String id) {
    if (queue.list(id).stream().anyMatch(item -> "dispatching".equals(item.get("status"))))
      throw new ConflictException("Stop the active response before deleting this chat");
    tasks.remove(id);
    queue.purgeTasks(List.of(id));
    return Map.of("ok", true);
  }
}
