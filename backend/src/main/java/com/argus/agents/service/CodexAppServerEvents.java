package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import java.util.*;
import java.util.function.Consumer;

/** Translate observable native events into Argus's existing exec-compatible projection. */
final class CodexAppServerEvents {
  private static final int LIMIT = 400_000;
  private final Map<String, String> messages = new LinkedHashMap<>();
  private final Consumer<Map<String, Object>> output;

  CodexAppServerEvents(Consumer<Map<String, Object>> output) {
    this.output = output;
  }

  void accept(Map<String, Object> event) {
    String method = text(event.get("method"));
    var params = obj(event.get("params"));
    switch (method) {
      case "thread/started" ->
          output.accept(
              fields("type", "thread.started", "thread_id", obj(params.get("thread")).get("id")));
      case "turn/started" ->
          output.accept(
              fields("type", "turn.started", "turn_id", obj(params.get("turn")).get("id")));
      case "item/agentMessage/delta", "item/plan/delta" -> {
        String id = text(params.get("itemId"));
        if (!messages.containsKey(id) && messages.size() >= 32)
          messages.remove(messages.keySet().iterator().next());
        String message = tail(messages.getOrDefault(id, "") + text(params.get("delta")), LIMIT);
        messages.put(id, message);
        output.accept(
            fields(
                "type",
                "item.updated",
                "item",
                fields("id", id, "type", "agent_message", "text", message)));
      }
      case "item/started", "item/completed" -> {
        var source = obj(params.get("item"));
        String kind =
            switch (text(source.get("type"))) {
              case "agentMessage", "plan" -> "agent_message";
              case "commandExecution" -> "command_execution";
              case "fileChange" -> "file_change";
              case "mcpToolCall", "dynamicToolCall", "collabToolCall" -> "mcp_tool_call";
              case "webSearch" -> "web_search";
              case "contextCompaction" -> "context_compaction";
              default -> "";
            };
        // Never expose native reasoning content, credentials, or approval payloads.
        if (kind.isEmpty()) return;
        var item = new LinkedHashMap<String, Object>(source);
        item.put("type", kind);
        if (kind.equals("agent_message")) {
          String id = text(source.get("id")), message = tail(text(source.get("text")), LIMIT);
          if (!messages.containsKey(id) && messages.size() >= 32)
            messages.remove(messages.keySet().iterator().next());
          messages.put(id, message);
          item.put("text", message);
        }
        if (item.containsKey("aggregatedOutput"))
          item.put("aggregated_output", tail(text(item.remove("aggregatedOutput")), LIMIT));
        if (item.containsKey("exitCode")) item.put("exit_code", item.remove("exitCode"));
        if ("inProgress".equals(item.get("status"))) item.put("status", "in_progress");
        output.accept(
            fields(
                "type",
                method.equals("item/started") ? "item.started" : "item.completed",
                "item",
                item));
      }
      case "turn/completed" -> {
        var turn = obj(params.get("turn"));
        output.accept(
            fields(
                "type",
                "completed".equals(turn.get("status")) ? "turn.completed" : "turn.failed",
                "turn_id",
                turn.get("id"),
                "status",
                turn.get("status"),
                "error",
                turn.get("error")));
      }
      case "error" -> output.accept(fields("type", "error", "error", params.get("error")));
      default -> {
        /* Usage is captured separately by ProviderTokenUsage, never included in assistant text. */
      }
    }
  }
}
