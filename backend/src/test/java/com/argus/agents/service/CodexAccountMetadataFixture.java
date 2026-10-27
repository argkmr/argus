package com.argus.agents.service;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Map;
import tools.jackson.databind.ObjectMapper;

/** Disposable metadata fixture; this executable cannot perform inference. */
public final class CodexAccountMetadataFixture {
  public static void main(String[] args) throws Exception {
    String scenario = args[0];
    Path log = Path.of(args[1]);
    Files.writeString(
        log,
        "PID " + ProcessHandle.current().pid() + "\n",
        StandardOpenOption.CREATE,
        StandardOpenOption.APPEND);
    ObjectMapper json = new ObjectMapper();
    var input = new BufferedReader(new InputStreamReader(System.in));
    for (String line; (line = input.readLine()) != null; ) {
      Files.writeString(log, line + "\n", StandardOpenOption.APPEND);
      var request = json.readTree(line);
      String method = request.path("method").asText();
      if (method.equals("initialized")) continue;
      if (scenario.equals("hang")) {
        Thread.sleep(60_000);
        return;
      }
      if (scenario.equals("reject")) {
        System.out.println(
            json.writeValueAsString(
                Map.of(
                    "id",
                    request.get("id"),
                    "error",
                    Map.of("message", "synthetic-secret-must-not-escape"))));
      } else {
        Object result =
            switch (method) {
              case "initialize" -> Map.of();
              case "account/read" ->
                  Map.of(
                      "account",
                      Map.of("type", "chatgpt", "email", "synthetic-private@example.test"),
                      "requiresOpenaiAuth",
                      true);
              case "account/rateLimits/read" ->
                  Map.of(
                      "rateLimits",
                      Map.of("credits", Map.of("hasCredits", true, "unlimited", true)));
              default -> throw new IllegalStateException("Forbidden method: " + method);
            };
        System.out.println(
            json.writeValueAsString(Map.of("id", request.get("id"), "result", result)));
      }
      System.out.flush();
    }
  }
}
