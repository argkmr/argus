package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argus.runtime.service.ProcessManager;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class JavaScriptDebugSessionTest {
  @TempDir Path directory;

  @Test
  void officialAdapterBreaksInspectsStepsAndDetachesAnIsolatedNodeProcess() throws Exception {
    Path adapter =
        Path.of(
                System.getProperty(
                    "argus.test.js-debug-server",
                    "../build/ide-tools/js-debug/src/dapDebugServer.js"))
            .toAbsolutePath()
            .normalize();
    String node =
        List.of(
                System.getenv().getOrDefault("ARGUS_IDE_NODE", "/usr/local/bin/node"),
                "/opt/homebrew/bin/node",
                "/usr/bin/node")
            .stream()
            .filter(value -> Files.isExecutable(Path.of(value)))
            .findFirst()
            .orElse("");
    assumeTrue(
        Files.isRegularFile(adapter) && !node.isBlank(),
        "Build pinned IDE tools and install Node to run the real adapter integration test");
    Files.writeString(
        directory.resolve("fixture.js"),
        """
        const fs = require('fs');
        let counter = 0;
        function increment(value) {
          const updated = value + 1;
          return updated;
        }
        setInterval(() => {
          const current = counter;
          counter = increment(counter);
          fs.writeFileSync('progress', String(current));
        }, 30);
        """);
    var processes = new ProcessManager();
    JavaScriptDebugSession debugger = null;
    var events = new CopyOnWriteArrayList<Map<String, Object>>();
    try {
      var config =
          DebugLaunch.prepare(
              object(
                  "id",
                  "node-fixture",
                  "name",
                  "Node fixture",
                  "cwd",
                  ".",
                  "executable",
                  node,
                  "args",
                  List.of("fixture.js")),
              null);
      var target =
          processes.start(
              config, new Repository("fixture", "Fixture", directory.toString(), "now"), Map.of());
      await(
          () -> "listening".equals(map(processes.list().get(0).get("debug")).get("state")), events);
      debugger =
          new JavaScriptDebugSession(
              node,
              adapter,
              directory,
              (int) number(map(target.get("debug")).get("port")),
              new ObjectMapper(),
              (event, body) -> events.add(object("event", event, "body", body)));
      var runningThreads = list(debugger.command("threads", Map.of()).get("threads"));
      assertFalse(runningThreads.isEmpty(), "A running Node target must be pausable");
      Object runningThreadId = map(runningThreads.get(0)).get("id");
      var pauseArguments = object("threadId", runningThreadId);
      DebugService.validateArguments("pause", pauseArguments, directory);
      int eventsBeforePause = events.size();
      debugger.command("pause", pauseArguments);
      await(
          () ->
              events.stream()
                  .skip(eventsBeforePause)
                  .anyMatch(
                      event ->
                          "stopped".equals(event.get("event"))
                              && number(runningThreadId)
                                  == number(map(event.get("body")).get("threadId"))),
          events);
      var pausedStack =
          debugger.command("stackTrace", object("threadId", runningThreadId, "levels", 20));
      assertFalse(list(pausedStack.get("stackFrames")).isEmpty());
      debugger.command("continue", object("threadId", runningThreadId));
      events.clear();
      var result =
          debugger.command(
              "setBreakpoints",
              object(
                  "source",
                  object("path", directory.resolve("fixture.js").toString()),
                  "breakpoints",
                  List.of(object("line", 9))));
      assertEquals(1, list(result.get("breakpoints")).size());
      await(() -> events.stream().anyMatch(event -> "stopped".equals(event.get("event"))), events);
      var stopped =
          events.stream()
              .filter(event -> "stopped".equals(event.get("event")))
              .reduce((a, b) -> b)
              .orElseThrow();
      Object threadId = map(stopped.get("body")).get("threadId");
      var stack =
          DebugService.normalizeSources(
              debugger.command("stackTrace", object("threadId", threadId, "levels", 20)),
              directory);
      var frame = map(list(stack.get("stackFrames")).get(0));
      assertEquals(9, number(frame.get("line")));
      assertEquals("fixture.js", map(frame.get("source")).get("path"));
      var scopes = debugger.command("scopes", object("frameId", frame.get("id")));
      Object locals = map(list(scopes.get("scopes")).get(0)).get("variablesReference");
      var variables = debugger.command("variables", object("variablesReference", locals));
      boolean foundCurrent =
          list(variables.get("variables")).stream()
              .map(com.argus.runtime.service.RuntimeData::map)
              .anyMatch(variable -> "current".equals(variable.get("name")));
      assertTrue(foundCurrent);
      debugger.command("next", object("threadId", threadId));
      await(
          () ->
              events.stream()
                  .anyMatch(
                      event ->
                          "stopped".equals(event.get("event"))
                              && "step".equals(map(event.get("body")).get("reason"))),
          events);
      assertEquals(10, number(topFrame(debugger, threadId).get("line")));
      int beforeContinue = events.size();
      debugger.command("continue", object("threadId", threadId));
      awaitStop(events, beforeContinue, "breakpoint");
      assertEquals(9, number(topFrame(debugger, threadId).get("line")));
      int beforeStepIn = events.size();
      debugger.command("stepIn", object("threadId", threadId));
      awaitStop(events, beforeStepIn, "step");
      assertEquals(4, number(topFrame(debugger, threadId).get("line")));
      int beforeStepOut = events.size();
      debugger.command("stepOut", object("threadId", threadId));
      awaitStop(events, beforeStepOut, "step");
      assertTrue(List.of(9L, 10L).contains(number(topFrame(debugger, threadId).get("line"))));
      String before = Files.readString(directory.resolve("progress"));
      Thread.sleep(100);
      assertEquals(
          before,
          Files.readString(directory.resolve("progress")),
          "A stopped event must leave the Node program paused");
      debugger.close();
      assertEquals(true, processes.list().get(0).get("running"));
      await(
          () -> {
            try {
              return !before.equals(Files.readString(directory.resolve("progress")));
            } catch (java.io.IOException error) {
              return false;
            }
          },
          events);
    } finally {
      if (debugger != null) debugger.close();
      processes.stopAll();
    }
  }

  private static Map<String, Object> topFrame(JavaScriptDebugSession debugger, Object threadId) {
    return map(
        list(debugger
                .command("stackTrace", object("threadId", threadId, "levels", 1))
                .get("stackFrames"))
            .get(0));
  }

  private static void awaitStop(List<Map<String, Object>> events, int after, String reason)
      throws InterruptedException {
    await(
        () ->
            events.stream()
                .skip(after)
                .anyMatch(
                    event ->
                        "stopped".equals(event.get("event"))
                            && reason.equals(map(event.get("body")).get("reason"))),
        events);
  }

  private static void await(BooleanSupplier condition, List<?> events) throws InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
    while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(20);
    String details = events.toString();
    assertTrue(
        condition.getAsBoolean(),
        "Debugger events: " + details.substring(Math.max(0, details.length() - 6000)));
  }
}
