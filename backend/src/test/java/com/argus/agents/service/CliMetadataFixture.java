package com.argus.agents.service;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Executable fixture for stdio tests; never invokes a real provider. */
public final class CliMetadataFixture {
  public static void main(String[] args) throws Exception {
    ObjectMapper json = new ObjectMapper();
    String scenario = args[0];
    Path log = Path.of(args[1]);
    if (scenario.startsWith("file:"))
      scenario = Files.readString(Path.of(scenario.substring(5))).trim();
    Files.writeString(
        log,
        "START " + String.join(" ", args) + "\n",
        StandardOpenOption.CREATE,
        StandardOpenOption.APPEND);
    Files.writeString(
        log, "PID " + ProcessHandle.current().pid() + "\n", StandardOpenOption.APPEND);
    System.err.println("synthetic-secret-must-not-escape");
    if (scenario.equals("exit")) return;
    if (scenario.equals("controlled"))
      while (!Files.exists(log.resolveSibling(log.getFileName() + ".release"))) Thread.sleep(10);
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in));
    for (String line; (line = input.readLine()) != null; ) {
      Files.writeString(log, line + "\n", StandardOpenOption.APPEND);
      JsonNode request = json.readTree(line);
      String method = request.path("method").asText("");
      if (request.has("error")) continue;
      if (method.equals("initialized")) continue;
      if (scenario.equals("approval-storm") || scenario.equals("approval-oversized")) {
        // Deliberately never read stdin again: replies must not fill its pipe.
        int count = scenario.equals("approval-storm") ? 1000 : 1;
        for (int index = 0; index < count; index++) {
          String id =
              scenario.equals("approval-oversized") ? "x".repeat(32_000) : "request-" + index;
          if (request.has("id"))
            respond(
                json,
                Map.of("id", id, "method", "item/permissions/requestApproval", "params", Map.of()));
          else
            respond(
                json,
                Map.of(
                    "type",
                    "control_request",
                    "request_id",
                    id,
                    "request",
                    Map.of("subtype", "can_use_tool")));
        }
        Thread.sleep(60_000);
        return;
      }
      if (scenario.equals("hang")) {
        Thread.sleep(60_000);
        return;
      }
      if (scenario.equals("flood")) {
        System.out.print("x".repeat(9 * 1024 * 1024));
        System.out.flush();
        Thread.sleep(60_000);
        return;
      }
      if (scenario.equals("reject")) {
        if (request.has("id"))
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "error",
                  Map.of("message", "private configuration detail")));
        else
          respond(
              json,
              Map.of(
                  "type",
                  "control_response",
                  "response",
                  Map.of(
                      "request_id",
                      request.path("request_id").asText(),
                      "subtype",
                      "error",
                      "error",
                      "private configuration detail")));
        continue;
      }
      if (method.equals("initialize")) {
        respond(json, Map.of("id", request.get("id"), "result", Map.of()));
        if (scenario.equals("models"))
          respond(
              json,
              Map.of(
                  "id",
                  "unexpected-approval",
                  "method",
                  "item/commandExecution/requestApproval",
                  "params",
                  Map.of()));
      } else if (method.equals("model/list")) {
        boolean next = request.path("params").has("cursor");
        if (scenario.equals("models-empty"))
          respond(json, Map.of("id", request.get("id"), "result", Map.of("data", List.of())));
        else if (scenario.equals("models-next"))
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "result",
                  Map.of(
                      "data",
                      List.of(
                          Map.of(
                              "model",
                              "future-generation",
                              "displayName",
                              "Future generation",
                              "isDefault",
                              true,
                              "supportedReasoningEfforts",
                              List.of(Map.of("reasoningEffort", "future-effort")))))));
        else if (scenario.equals("malformed"))
          respond(json, Map.of("id", request.get("id"), "result", Map.of("data", "invalid")));
        else if (scenario.equals("repeat"))
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "result",
                  Map.of("data", List.of(), "nextCursor", "repeated")));
        else if (!next)
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "result",
                  Map.of(
                      "data",
                      List.of(
                          Map.of(
                              "model",
                              "gpt-6-astra",
                              "displayName",
                              "GPT-6 Astra",
                              "supportedReasoningEfforts",
                              List.of(
                                  Map.of("reasoningEffort", "high"),
                                  Map.of("reasoningEffort", "ultra")),
                              "defaultReasoningEffort",
                              "ultra"),
                          Map.of("model", "hidden-model", "hidden", true)),
                      "nextCursor",
                      "page2")));
        else
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "result",
                  Map.of(
                      "data",
                      List.of(
                          Map.of("model", "gpt-6-astra"),
                          Map.of("model", "future-model", "isDefault", true)))));
      } else if (method.equals("mcpServerStatus/list")) {
        if (scenario.equals("cap-loop"))
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "result",
                  Map.of("data", List.of(), "nextCursor", "same")));
        else if (scenario.equals("cap-pages"))
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "result",
                  Map.of(
                      "data",
                      List.of(
                          Map.of(
                              "name",
                              request.path("params").has("cursor") ? "second" : "first",
                              "tools",
                              Map.of("fetch", Map.of()))),
                      "nextCursor",
                      request.path("params").has("cursor") ? "" : "page2")));
        else if (scenario.equals("partial"))
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "error",
                  Map.of("code", -32601, "message", "synthetic-secret-must-not-escape")));
        else
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "result",
                  Map.of(
                      "data",
                      List.of(
                          Map.of(
                              "name",
                              "Google Drive",
                              "authStatus",
                              "oAuth",
                              "tools",
                              Map.of(
                                  "drive/read",
                                  Map.of("annotations", Map.of("readOnlyHint", true)))),
                          Map.of("name", "https://private.example/token", "tools", Map.of()),
                          Map.of(
                              "name", "Slack", "authStatus", "notLoggedIn", "tools", Map.of())))));
      } else if (method.equals("app/installed")) {
        if (scenario.equals("no-apps"))
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "error",
                  Map.of("message", "synthetic-secret-must-not-escape")));
        else
          respond(
              json,
              Map.of(
                  "id",
                  request.get("id"),
                  "result",
                  Map.of(
                      "apps",
                      List.of(
                          Map.of(
                              "id",
                              "connector",
                              "runtimeName",
                              "Connected app",
                              "enabled",
                              true,
                              "callable",
                              true),
                          Map.of("id", "disabled", "enabled", false, "callable", true)))));
      } else if (request.path("type").asText().equals("control_request")) {
        String subtype = request.path("request").path("subtype").asText();
        Object response =
            subtype.equals("initialize")
                ? Map.of(
                    "models",
                    List.of(
                        Map.of("value", "default", "resolvedModel", "provider-current"),
                        Map.of(
                            "value",
                            "opus[1m]",
                            "displayName",
                            "Opus extended",
                            "resolvedModel",
                            "provider-current",
                            "supportedEffortLevels",
                            List.of("low", "high"),
                            "supportsFastMode",
                            true),
                        Map.of("value", "sonnet", "supportedEffortLevels", List.of("medium"))))
                : Map.of(
                    "mcpServers",
                    List.of(
                        Map.of(
                            "name",
                            "Browser",
                            "status",
                            "connected",
                            "tools",
                            List.of(Map.of("name", "navigate")))));
        if (scenario.equals("malformed")) response = Map.of();
        if (scenario.equals("models-empty")) response = Map.of("models", List.of());
        if (scenario.equals("models-next"))
          response =
              Map.of(
                  "models",
                  List.of(
                      Map.of(
                          "value",
                          "future-family",
                          "displayName",
                          "Future family",
                          "resolvedModel",
                          "claude-future-generation",
                          "supportedEffortLevels",
                          List.of("future-effort"))));
        var value =
            Map.of(
                "type",
                "control_response",
                "response",
                Map.of(
                    "request_id",
                    request.path("request_id").asText(),
                    "subtype",
                    "success",
                    "response",
                    response));
        if (scenario.equals("fragmented")) {
          System.out.println("not JSON startup diagnostic");
          respond(
              json,
              Map.of(
                  "type",
                  "control_response",
                  "response",
                  Map.of("request_id", "unrelated", "subtype", "success", "response", Map.of())));
          String encoded = json.writeValueAsString(value) + "\n";
          System.out.print(encoded.substring(0, 70));
          System.out.flush();
          Thread.sleep(10);
          System.out.print(encoded.substring(70));
          System.out.flush();
        } else respond(json, value);
      } else throw new IllegalStateException("Unexpected non-metadata request");
    }
  }

  private static void respond(ObjectMapper json, Object value) {
    System.out.println(json.writeValueAsString(value));
    System.out.flush();
  }
}
