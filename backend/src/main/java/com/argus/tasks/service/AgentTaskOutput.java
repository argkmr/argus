package com.argus.tasks.service;

import static com.argus.agents.domain.AgentValues.*;

import com.argus.agents.service.AgentQuestion;
import java.util.*;
import tools.jackson.databind.ObjectMapper;

/** Observable output/audit only; never invents private model reasoning. */
public final class AgentTaskOutput {
  private AgentTaskOutput() {}

  private static final Set<String> PROTOCOL_TYPES =
      Set.of(
          "thread.started",
          "turn.started",
          "turn.completed",
          "turn.failed",
          "item.started",
          "item.updated",
          "item.completed",
          "error",
          "assistant",
          "result",
          "system",
          "user",
          "stream_event",
          "rate_limit_event",
          "tool_progress",
          "tool_use_summary");
  private static final java.util.regex.Pattern PROTOCOL_PREFIX =
      java.util.regex.Pattern.compile(
          "^\\s*\\{\\s*\"type\"\\s*:\\s*\"(?:"
              + PROTOCOL_TYPES.stream()
                  .map(java.util.regex.Pattern::quote)
                  .collect(java.util.stream.Collectors.joining("|"))
              + ")(?:\"|$)");

  public static List<Map<String, Object>> events(String output, ObjectMapper mapper) {
    var events = new ArrayList<Map<String, Object>>();
    for (String line : output.split("\n"))
      try {
        Object value = mapper.readValue(line, Object.class);
        if (value instanceof Map) events.add(obj(value));
      } catch (RuntimeException ignored) {
      }
    return events;
  }

  public static List<String> messages(String output, ObjectMapper mapper) {
    var messages = new LinkedHashSet<String>();
    for (var event : events(output, mapper)) {
      String message = message(event);
      if (!message.isEmpty()) messages.add(message);
    }
    return new ArrayList<>(messages);
  }

  /** Only explicit assistant text is displayable; tool/image/data blocks are not messages. */
  public static String message(Map<String, Object> event) {
    var item = obj(event.get("item"));
    if ("agent_message".equals(item.get("type")))
      return item.get("text") instanceof String value ? value : "";
    if ("assistant".equals(event.get("type"))) {
      var pieces = new ArrayList<String>();
      for (Object value : list(obj(event.get("message")).get("content"))) {
        var part = obj(value);
        if ("text".equals(part.get("type")) && part.get("text") instanceof String content)
          pieces.add(content);
      }
      return String.join("\n", pieces);
    }
    return "result".equals(event.get("type")) && event.get("result") instanceof String value
        ? value
        : "";
  }

  private static <T> List<T> list(Object value) {
    return com.argus.agents.domain.AgentValues.list(value);
  }

  public static String readable(String raw, ObjectMapper mapper, boolean includeControlBlocks) {
    String latest = "";
    boolean protocol = false;
    String fence = "";
    for (String line : raw.split("\n")) {
      String stripped = line.stripLeading();
      if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
        String marker = stripped.substring(0, 3);
        if (fence.isEmpty()) fence = marker;
        else if (fence.equals(marker)) fence = "";
        continue;
      }
      if (!fence.isEmpty()) continue;
      if (PROTOCOL_PREFIX.matcher(line).find()) protocol = true;
      try {
        Object parsed = mapper.readValue(line, Object.class);
        if (parsed instanceof Map<?, ?>) {
          var event = obj(parsed);
          protocol |= PROTOCOL_TYPES.contains(text(event.get("type")));
          String message = message(event);
          if (!message.isEmpty()) latest = message;
        }
      } catch (RuntimeException ignored) {
      }
    }
    String output = !latest.isEmpty() ? latest : protocol ? "" : raw.trim();
    return includeControlBlocks ? output : AgentQuestion.display(output, mapper);
  }

  public static String response(
      Map<String, Object> job, ObjectMapper mapper, boolean includeControlBlocks) {
    if (!job.containsKey("readableOutput"))
      return readable(text(job.get("output")), mapper, includeControlBlocks);
    String output = text(job.get("readableOutput"));
    return includeControlBlocks ? output : AgentQuestion.display(output, mapper);
  }

  public static String display(Map<String, Object> job, ObjectMapper mapper) {
    var failure = obj(job.get("failure"));
    String provider = value(job, "providerName", "The selected AI provider"),
        reset = text(failure.get("resetHint"));
    String failed =
        switch (text(failure.get("code"))) {
          case "quota_exhausted" ->
              provider
                  + " usage quota has been reached."
                  + (reset.isEmpty()
                      ? " Switch provider or try again after the quota resets."
                      : " It resets " + reset + ".");
          case "rate_limited" ->
              provider
                  + " is temporarily rate limited."
                  + (reset.isEmpty()
                      ? " Try again later or switch provider."
                      : " Try again " + reset + ".");
          case "authentication_required" -> "The selected AI provider needs you to sign in again.";
          case "invalid_cli_arguments" ->
              "Claude did not receive the prompt. Update Argus to the latest build and retry this request.";
          case "provider_unavailable" ->
              "The selected AI provider could not be reached. Refresh or reconfigure the connection and try again.";
          default -> "The AI task failed before producing a response.";
        };
    if (!failure.isEmpty()) return failed;
    String output = response(job, mapper, false);
    return !output.isEmpty()
        ? output
        : "cancelled".equals(job.get("status"))
            ? "Task was cancelled before a final response."
            : "failed".equals(job.get("status"))
                ? failed
                : "Task completed without a written response.";
  }

  public static String redact(String value) {
    return value
        .replaceAll("(?i)(authorization\\s*[:=]\\s*(?:bearer\\s+)?)[^\\s,;]+", "$1[REDACTED]")
        .replaceAll(
            "(?i)((?:api[_-]?token|access[_-]?token|password|secret)\\s*[:=]\\s*)[^\\s,;]+",
            "$1[REDACTED]");
  }
}
