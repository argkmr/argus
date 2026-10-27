package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import com.argus.common.error.ConflictException;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.service.TaskService;
import java.util.*;
import tools.jackson.databind.ObjectMapper;

/** User-entered replies only. Questions never grant permissions or execute an action. */
final class AgentQuestionReply {
  private AgentQuestionReply() {}

  static String fingerprint(Map<String, Object> reply, ObjectMapper mapper) {
    try {
      return HexFormat.of()
          .formatHex(
              java.security.MessageDigest.getInstance("SHA-256")
                  .digest(
                      mapper
                          .writeValueAsString(reply)
                          .getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    } catch (java.security.NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  static Map<String, Object> request(Map<String, Object> input) {
    var result = new LinkedHashMap<String, Object>();
    for (String key : List.of("requestId", "taskId", "questionId")) {
      if (!(input.get(key) instanceof String value) || value.isBlank() || value.length() > 250)
        throw new IllegalArgumentException("A valid " + key + " is required for this reply");
      result.put(key, value);
    }
    if (!text(result.get("requestId")).matches("[A-Za-z0-9_-]{1,100}"))
      throw new IllegalArgumentException("Invalid question reply request ID");
    if (!(input.get("answers") instanceof List<?> answers)
        || answers.isEmpty()
        || answers.size() > 3)
      throw new IllegalArgumentException("Answer each question before sending your reply");
    var normalized = new ArrayList<Map<String, Object>>();
    var seen = new HashSet<String>();
    for (Object item : answers) {
      var answer = obj(item);
      if (!(answer.get("id") instanceof String id)
          || id.isBlank()
          || id.length() > 100
          || !seen.add(id)
          || !(answer.get("answer") instanceof String value)
          || value.isBlank()
          || value.length() > 20_000
          || value.indexOf('\0') >= 0)
        throw new IllegalArgumentException(
            "Each question needs one non-empty answer (up to 20,000 characters)");
      normalized.add(fields("id", id, "answer", value.trim()));
    }
    result.put("answers", normalized);
    if (input.containsKey("promptNotes"))
      result.put(
          "promptNotes", com.argus.tasks.service.PromptNotes.normalize(input.get("promptNotes")));
    return result;
  }

  static Map<String, Object> runInput(AiTask task, Map<String, Object> reply, ObjectMapper mapper) {
    if (!Objects.equals(task.id, reply.get("taskId")))
      throw new ConflictException("This question belongs to a different chat");
    for (var message : task.messages) {
      var previous = obj(message.additionalProperties().get("questionReply"));
      if (Objects.equals(reply.get("requestId"), previous.get("requestId")))
        throw new ConflictException(
            "This answer is already recorded. Check the chat before sending another reply.");
    }
    var question = AgentQuestion.latest(task, mapper);
    if (question.isEmpty() || !Objects.equals(question.get("id"), reply.get("questionId")))
      throw new ConflictException(
          "This question is no longer awaiting a reply. Refresh the original chat.");
    var answers = new LinkedHashMap<String, String>();
    for (Object item : list(reply.get("answers"))) {
      var value = obj(item);
      answers.put(text(value.get("id")), text(value.get("answer")));
    }
    var questions = list(question.get("questions"));
    if (answers.size() != questions.size())
      throw new IllegalArgumentException("Answer each of the agent's questions before sending");
    var prompt = new StringBuilder("Reply to your question:\n\n");
    for (Object item : questions) {
      var value = obj(item);
      String answer = answers.remove(text(value.get("id")));
      if (answer == null)
        throw new IllegalArgumentException(
            "The question selection changed; refresh before replying");
      prompt
          .append("Question: ")
          .append(text(value.get("question")))
          .append("\nAnswer: ")
          .append(answer)
          .append("\n\n");
    }
    if (!answers.isEmpty()) throw new IllegalArgumentException("Unknown question answer");
    String message = prompt.toString().trim();
    TaskService.requirePrompt(message);
    var origin = origin(task);
    var input =
        fields(
            "requestId",
            reply.get("requestId"),
            "taskId",
            task.id,
            "prompt",
            message,
            "scope",
            task.scope,
            "repositoryId",
            task.repositoryId,
            "repositoryIds",
            origin.getOrDefault("repositoryIds", task.repositoryIds),
            "provider",
            origin.getOrDefault("provider", task.provider),
            "mode",
            origin.getOrDefault("mode", task.mode),
            "model",
            origin.getOrDefault("model", task.model),
            "effort",
            origin.getOrDefault("effort", task.effort),
            "speed",
            origin.getOrDefault("speed", task.speed),
            "contextMode",
            origin.getOrDefault(
                "contextMode", task.additionalProperties().getOrDefault("contextMode", "fresh")),
            "attachmentIds",
            List.of());
    if (!origin.isEmpty()
        && (!Objects.equals(origin.get("scope"), task.scope)
            || !Objects.equals(origin.get("repositoryId"), task.repositoryId)))
      throw new ConflictException("The question's original chat scope is unavailable");
    input.put(
        "promptNotes",
        com.argus.tasks.service.PromptNotes.resolve(
            reply, origin.getOrDefault("promptNotes", List.of())));
    return input;
  }

  private static Map<String, Object> origin(AiTask task) {
    var message = task.messages.get(task.messages.size() - 1);
    var saved = obj(message.additionalProperties().get("questionContext"));
    if (!saved.isEmpty()) return saved;
    // Legacy Nexus task.repositoryIds reflects task creation, not necessarily
    // the last run. Recover its actual scope from the recorded execution only.
    var execution = message.execution == null ? Map.<String, Object>of() : message.execution;
    List<?> repositories = List.of();
    for (Object item : list(execution.get("operationalSteps"))) {
      var step = obj(item);
      if ("skills".equals(step.get("phase"))
          && obj(step.get("detail")).get("repositories") instanceof List<?> ids) repositories = ids;
    }
    if (!"global".equals(task.scope)) repositories = List.of(task.repositoryId);
    String provider = value(execution, "provider", Objects.toString(message.provider, ""));
    String mode =
        switch (text(execution.get("access"))) {
          case "Can edit connected files and use Git" -> "edit";
          case "Read-only investigation" -> "plan";
          default -> "";
        };
    String model = text(execution.get("model"));
    if (repositories.isEmpty()
        || repositories.stream().anyMatch(id -> !(id instanceof String value) || value.isBlank())
        || provider.isBlank()
        || mode.isBlank()
        || model.isBlank()
        || model.equals("provider default"))
      throw new ConflictException(
          "This older question has no complete saved run settings. Reply using the chat composer and choose its scope and model.");
    return fields(
        "scope",
        task.scope,
        "repositoryId",
        task.repositoryId,
        "repositoryIds",
        repositories,
        "provider",
        provider,
        "mode",
        mode,
        "model",
        model,
        "effort",
        "auto",
        "speed",
        "standard",
        "contextMode",
        execution.getOrDefault("contextMode", "fresh"));
  }
}
