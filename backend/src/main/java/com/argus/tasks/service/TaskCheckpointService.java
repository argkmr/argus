package com.argus.tasks.service;

import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskCheckpoint;
import com.argus.tasks.domain.TaskMessage;
import com.argus.tasks.repository.TaskRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

@Service
public class TaskCheckpointService {
  private final TaskRepository tasks;
  private final ObjectMapper mapper;

  public TaskCheckpointService(TaskRepository tasks, ObjectMapper mapper) {
    this.tasks = tasks;
    this.mapper = mapper;
  }

  public AiTask mark(String id, String messageId) {
    requireMessageId(messageId);
    return tasks.updateCheckpoints(
        id,
        task -> {
          var existing = checkpoints(task);
          if (existing.stream().anyMatch(item -> messageId.equals(item.messageId())))
            return task.checkpoints;
          var matches = task.messages.stream().filter(item -> messageId.equals(item.id)).toList();
          if (matches.isEmpty())
            throw new NotFoundException(
                "This message is no longer available to mark. Reload the chat and try again.");
          if (matches.size() != 1)
            throw new ConflictException("The message ID is ambiguous; reload the chat");
          TaskMessage message = matches.get(0);
          if (!"user".equals(message.role) && !"assistant".equals(message.role))
            throw new IllegalArgumentException(
                "Only saved user or assistant messages can be marked");
          var result = new ArrayList<>(existing);
          result.add(
              new TaskCheckpoint(
                  messageId,
                  Instant.now().toString(),
                  mapper.convertValue(message, TaskMessage.class)));
          return result;
        });
  }

  public AiTask remove(String id, String messageId) {
    requireMessageId(messageId);
    return tasks.updateCheckpoints(
        id,
        task -> {
          var result = new ArrayList<>(checkpoints(task));
          return result.removeIf(item -> messageId.equals(item.messageId()))
              ? result
              : task.checkpoints;
        });
  }

  private static List<TaskCheckpoint> checkpoints(AiTask task) {
    return task.checkpoints == null ? List.of() : task.checkpoints;
  }

  private static void requireMessageId(String messageId) {
    if (messageId == null || messageId.length() > 200 || !messageId.matches("[A-Za-z0-9_-]+"))
      throw new IllegalArgumentException("A valid stable message ID is required");
  }
}
