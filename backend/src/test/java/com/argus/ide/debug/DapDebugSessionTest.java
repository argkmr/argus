package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class DapDebugSessionTest {
  @TempDir Path directory;

  @Test
  void standardAttachOrderingUnicodeFramingAndDisconnectWithoutTargetTermination() {
    var events = new CopyOnWriteArrayList<Map<String, Object>>();
    var command =
        List.of(
            Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-cp",
            System.getProperty("java.class.path"),
            Fixture.class.getName());
    var debugger =
        new DapDebugSession(
            command,
            directory,
            "fixture",
            "node",
            12345,
            new ObjectMapper(),
            (event, body) -> events.add(object("event", event, "body", body)));
    try {
      var response = debugger.command("threads", Map.of());
      assertThat(map(list(response.get("threads")).get(0))).containsEntry("name", "fixture 🥚");
      assertThat(debugger.alive()).isTrue();
    } finally {
      debugger.close();
    }
    assertThat(debugger.alive()).isFalse();
    boolean safeDisconnect =
        events.stream()
            .filter(event -> "output".equals(event.get("event")))
            .anyMatch(event -> text(map(event.get("body")), "output").equals("safe-disconnect"));
    org.junit.jupiter.api.Assertions.assertTrue(safeDisconnect);
  }

  @Test
  void byteLengthFramingHandlesSupplementaryCharactersAndRejectsBrokenBoundaries() {
    assertThat(DapDebugSession.charactersForBytes("a🥚b", 5)).isEqualTo(3);
    assertThat(DapDebugSession.charactersForBytes("a\ud83e", 5)).isEqualTo(-1);
    assertThatThrownBy(() -> DapDebugSession.charactersForBytes("🥚", 3))
        .hasMessageContaining("UTF-8");
  }

  public static class Fixture {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static int sequence;
    private static Map<String, Object> attach;

    public static void main(String[] args) throws Exception {
      while (true) {
        var header = new StringBuilder();
        while (header.indexOf("\r\n\r\n") < 0) {
          int value = System.in.read();
          if (value < 0) return;
          header.append((char) value);
        }
        int length = Integer.parseInt(header.substring(15).trim());
        var message =
            map(
                JSON.readValue(
                    new String(System.in.readNBytes(length), StandardCharsets.UTF_8), Map.class));
        String command = text(message, "command");
        if (!"request".equals(message.get("type"))) continue;
        switch (command) {
          case "initialize" -> response(message, object("supportsConfigurationDoneRequest", true));
          case "attach" -> {
            attach = message;
            event("initialized", Map.of());
          }
          case "configurationDone" -> {
            response(message, Map.of());
            response(attach, Map.of());
          }
          case "threads" ->
              response(message, object("threads", List.of(object("id", 1, "name", "fixture 🥚"))));
          case "disconnect" -> {
            if (Boolean.FALSE.equals(map(message.get("arguments")).get("terminateDebuggee")))
              event("output", object("output", "safe-disconnect"));
            response(message, Map.of());
            return;
          }
          default -> response(message, Map.of());
        }
      }
    }

    private static void response(Map<String, Object> request, Map<String, Object> body)
        throws Exception {
      send(
          object(
              "seq",
              ++sequence,
              "type",
              "response",
              "request_seq",
              request.get("seq"),
              "command",
              request.get("command"),
              "success",
              true,
              "body",
              body));
    }

    private static void event(String name, Map<String, Object> body) throws Exception {
      send(object("seq", ++sequence, "type", "event", "event", name, "body", body));
    }

    private static void send(Map<String, Object> message) throws Exception {
      byte[] bytes = JSON.writeValueAsBytes(message);
      System.out.write(
          ("Content-Length: " + bytes.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      System.out.write(bytes);
      System.out.flush();
    }
  }
}
