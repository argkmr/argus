package com.argus.agents.service;

import com.argus.common.error.ConflictException;
import com.argus.tasks.domain.AiTask;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Explicit cancellation of one question occurrence; never an inferred approval or reply. */
public final class AgentQuestionCancellation {
  private AgentQuestionCancellation() {}

  public static Map<String, Object> request(Map<String, Object> input) {
    if (input == null) throw new IllegalArgumentException("A question cancellation is required");
    var result = new LinkedHashMap<String, Object>();
    for (String key : List.of("requestId", "taskId", "questionId")) {
      if (!(input.get(key) instanceof String value)
          || value.isBlank()
          || value.length() > 250
          || value.indexOf('\0') >= 0)
        throw new IllegalArgumentException(
            "A valid " + key + " is required to cancel this request");
      result.put(key, value);
    }
    if (!result.get("requestId").toString().matches("[A-Za-z0-9_-]{1,100}"))
      throw new IllegalArgumentException("Invalid question cancellation request ID");
    if (!result.get("taskId").toString().matches("[A-Za-z0-9_-]{1,200}"))
      throw new IllegalArgumentException("Invalid question cancellation task ID");
    if (!result.get("questionId").toString().matches("[A-Za-z0-9_-]{1,200}:question-[a-f0-9]{24}"))
      throw new IllegalArgumentException("Invalid question cancellation question ID");
    return result;
  }

  /** Repeated HTTP requests remain idempotent across reloads and process restarts. */
  public static Map<String, Object> receipt(AiTask task, Map<String, Object> request) {
    if (task == null || !Objects.equals(task.id, request.get("taskId")))
      throw new ConflictException("This question belongs to a different chat");
    var candidates = new java.util.ArrayList<Object>();
    candidates.add(task.additionalProperties().get("questionCancellation"));
    for (var message : task.messages)
      candidates.add(message.additionalProperties().get("questionCancellation"));
    Map<String, Object> found = Map.of();
    for (Object candidate : candidates) {
      var saved = metadata(candidate);
      if (saved.isEmpty()) continue;
      if (Objects.equals(request.get("requestId"), saved.get("requestId"))
          && !Objects.equals(request.get("questionId"), saved.get("questionId")))
        throw new ConflictException(
            "This cancellation request ID was already used for another question");
      if (Objects.equals(request.get("questionId"), saved.get("questionId"))) found = saved;
    }
    return found;
  }

  public static Map<String, Object> metadata(Object value) {
    if (!(value instanceof Map<?, ?> saved)
        || !"cancelled".equals(saved.get("status"))
        || !(saved.get("questionId") instanceof String questionId)
        || questionId.isBlank()
        || !(saved.get("requestId") instanceof String requestId)
        || requestId.isBlank()
        || !(saved.get("cancelledAt") instanceof String cancelledAt)
        || cancelledAt.isBlank()) return Map.of();
    var result = new LinkedHashMap<String, Object>();
    saved.forEach(
        (key, item) -> {
          if (key instanceof String name) result.put(name, item);
        });
    return result;
  }
}
