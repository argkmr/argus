package com.argus.codediscussions.service;

import com.argus.common.error.ConflictException;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskMessage;
import java.util.*;
import tools.jackson.databind.ObjectMapper;

/** Task-owned discussion data: deletion and offboarding delete the complete record atomically. */
public final class CodeDiscussionData {
  public static final String KEY = "codeDiscussions";

  private CodeDiscussionData() {}

  @SuppressWarnings("unchecked")
  public static Map<String, Object> map(Object value) {
    return value instanceof Map<?, ?> ? (Map<String, Object>) value : new LinkedHashMap<>();
  }

  @SuppressWarnings("unchecked")
  public static List<Map<String, Object>> list(Object value) {
    return value instanceof List<?> ? (List<Map<String, Object>>) value : new ArrayList<>();
  }

  public static String text(Object value) {
    return Objects.toString(value, "");
  }

  public static boolean owns(AiTask task) {
    return "repository".equals(task.scope)
        && Integer.valueOf(1).equals(map(task.additionalProperties().get(KEY)).get("version"));
  }

  public static Map<String, Object> receipt(AiTask task, String id) {
    return list(map(task.additionalProperties().get(KEY)).get("requests")).stream()
        .filter(item -> id.equals(item.get("requestId")))
        .findFirst()
        .orElseGet(LinkedHashMap::new);
  }

  public static Map<String, Object> validateRun(AiTask task, Map<String, Object> input) {
    var receipt = receipt(task, text(input.get("requestId")));
    if (!owns(task)
        || receipt.isEmpty()
        || !Objects.equals(receipt.get("discussionId"), input.get("codeDiscussionId"))
        || !Objects.equals(receipt.get("prompt"), input.get("prompt")))
      throw new ConflictException("This code discussion request is no longer available");
    return receipt;
  }

  /** Preserve complete messages outside the general task's rolling display window. */
  public static void recordMessage(
      AiTask task, Map<String, Object> input, TaskMessage message, ObjectMapper mapper) {
    var receipt = receipt(task, text(input.get("requestId")));
    if (!owns(task)
        || receipt.isEmpty()
        || !Objects.equals(receipt.get("discussionId"), input.get("codeDiscussionId"))) return;
    message.additionalProperties().put("codeDiscussionId", receipt.get("discussionId"));
    message.additionalProperties().put("requestId", receipt.get("requestId"));
    receipt.put(message.role + "Message", mapper.convertValue(message, Map.class));
    if ("assistant".equals(message.role)) {
      receipt.put("status", message.status);
      receipt.put("jobId", input.get("id"));
      receipt.put("completedAt", message.createdAt);
    }
  }
}
