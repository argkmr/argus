package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import tools.jackson.databind.ObjectMapper;

/** Isolated protocol fixture. It never opens a network connection or loads provider credentials. */
public final class CodexAppServerFixture {
  private static final ObjectMapper JSON = new ObjectMapper();

  private static void send(Map<String, Object> message) {
    System.out.println(JSON.writeValueAsString(message));
    System.out.flush();
  }

  private static void event(String method, Map<String, Object> params) {
    send(fields("method", method, "params", params));
  }

  private static void done() {
    event(
        "item/agentMessage/delta",
        fields("threadId", "thread-fixture", "itemId", "answer", "delta", "Native "));
    event(
        "item/agentMessage/delta",
        fields("threadId", "thread-fixture", "itemId", "answer", "delta", "answer"));
    event(
        "item/completed",
        fields(
            "threadId",
            "thread-fixture",
            "item",
            fields(
                "id",
                "command",
                "type",
                "commandExecution",
                "command",
                "printf fixture",
                "aggregatedOutput",
                "fixture",
                "exitCode",
                0,
                "status",
                "completed")));
    event(
        "item/completed",
        fields(
            "threadId",
            "thread-fixture",
            "item",
            fields(
                "id",
                "private",
                "type",
                "reasoning",
                "content",
                "private-reasoning-must-not-escape")));
    event(
        "thread/tokenUsage/updated",
        fields(
            "threadId",
            "thread-fixture",
            "tokenUsage",
            fields("total", fields("totalTokens", 999999))));
    event(
        "item/completed",
        fields(
            "threadId",
            "thread-fixture",
            "item",
            fields("id", "answer", "type", "agentMessage", "text", "Native answer")));
    event(
        "turn/completed",
        fields(
            "threadId",
            "thread-fixture",
            "turn",
            fields("id", "turn-fixture", "status", "completed")));
  }

  public static void main(String[] args) throws Exception {
    String scenario = args[0];
    Path log = Path.of(args[1]);
    Files.writeString(
        log,
        "START " + JSON.writeValueAsString(Arrays.asList(args)) + "\n",
        StandardOpenOption.CREATE,
        StandardOpenOption.APPEND);
    if (args.length > 2 && args[2].equals("exec")) {
      send(
          fields(
              "type",
              "item.completed",
              "item",
              fields("type", "agent_message", "text", "Legacy fallback answer")));
      send(fields("type", "turn.completed"));
      return;
    }
    try (var input = new BufferedReader(new InputStreamReader(System.in))) {
      for (String line; (line = input.readLine()) != null; ) {
        Files.writeString(log, line + "\n", StandardOpenOption.APPEND);
        var request = obj(JSON.readValue(line, Object.class));
        String method = text(request.get("method"));
        Object id = request.get("id");
        if (method.isEmpty() || method.equals("initialized")) continue;
        if (method.equals("initialize")) {
          if (scenario.equals("unsupported"))
            send(
                fields(
                    "id",
                    id,
                    "error",
                    fields("code", -32601, "message", "Unsupported initialize")));
          else send(fields("id", id, "result", fields("userAgent", "fixture")));
        } else if (method.equals("thread/start") || method.equals("thread/resume")) {
          if (method.equals("thread/resume") && scenario.equals("missing-resume")) {
            send(fields("id", id, "error", fields("code", -32602, "message", "Session not found")));
            continue;
          }
          event("thread/started", fields("thread", fields("id", "thread-fixture")));
          send(fields("id", id, "result", fields("thread", fields("id", "thread-fixture"))));
        } else if (method.equals("turn/start")) {
          if (scenario.equals("turn-reject")) {
            send(
                fields(
                    "id", id, "error", fields("code", -32602, "message", "Turn request rejected")));
            continue;
          }
          event(
              "turn/started",
              fields(
                  "threadId",
                  "thread-fixture",
                  "turn",
                  fields("id", "turn-fixture", "status", "inProgress")));
          send(
              fields(
                  "id",
                  id,
                  "result",
                  fields("turn", fields("id", "turn-fixture", "status", "inProgress"))));
          if (scenario.equals("server-request"))
            send(
                fields(
                    "id",
                    "approval-fixture",
                    "method",
                    "item/commandExecution/requestApproval",
                    "params",
                    fields("command", "never execute")));
          if (scenario.equals("done-usage")) {
            var usage =
                fields(
                    "inputTokens",
                    100,
                    "cachedInputTokens",
                    50,
                    "outputTokens",
                    10,
                    "reasoningOutputTokens",
                    2,
                    "totalTokens",
                    110);
            var params =
                fields(
                    "threadId",
                    "thread-fixture",
                    "turnId",
                    "turn-fixture",
                    "tokenUsage",
                    fields("total", usage, "last", usage));
            event("thread/tokenUsage/updated", params);
            event("thread/tokenUsage/updated", params);
          }
          if (Set.of("done", "done-usage", "missing-resume").contains(scenario)) done();
        } else if (method.equals("turn/steer")) {
          if (scenario.equals("timeout")) continue;
          if (scenario.equals("reject") || scenario.equals("steer-unsupported")) {
            send(
                fields(
                    "id",
                    id,
                    "error",
                    fields(
                        "code",
                        scenario.equals("reject") ? -32602 : -32601,
                        "message",
                        "Steering rejected")));
            continue;
          }
          send(
              fields(
                  "id",
                  id,
                  "result",
                  fields(
                      "turnId", scenario.equals("wrong-id") ? "unexpected-turn" : "turn-fixture")));
          if (scenario.equals("finish-on-steer")) done();
        }
      }
    }
  }
}
