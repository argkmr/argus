package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.runtime.service.ProcessManager;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import javax.tools.ToolProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class DebugServiceTest {
  @TempDir Path directory;

  private DebugService service(ProcessManager processes) {
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("fixture"))
        .thenReturn(new Repository("fixture", "Fixture", directory.toString(), "now"));
    return new DebugService(
        workspace,
        processes,
        new ArgusProperties(directory, directory, "test", ""),
        new ObjectMapper());
  }

  @Test
  void realJavaBreakpointStackVariablesStepAndDetachLeaveOwnedApplicationAlive() throws Exception {
    Path source = directory.resolve("DebugFixture.java");
    Files.writeString(
        source,
        """
        public class DebugFixture {
          public static volatile boolean run = true;
          public static void main(String[] args) throws Exception {
            int counter = 0;
            while (run) {
              counter = increment(counter);
              Thread.sleep(30);
            }
          }
          static int increment(int value) {
            int updated = value + 1;
            return updated;
          }
        }
        """);
    assertThat(ToolProvider.getSystemJavaCompiler().run(null, null, null, "-g", source.toString()))
        .isZero();
    var processes = new ProcessManager();
    var debugger = service(processes);
    var config =
        object(
            "id",
            "fixture-config",
            "name",
            "Fixture",
            "cwd",
            ".",
            "executable",
            Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "args",
            List.of("-cp", directory.toString(), "DebugFixture"));
    try {
      var process =
          processes.start(
              DebugLaunch.prepare(config, null),
              new Repository("fixture", "Fixture", directory.toString(), "now"),
              Map.of());
      await(() -> "listening".equals(map(processes.list().get(0).get("debug")).get("state")));
      int port = (int) number(map(process.get("debug")).get("port"));
      assertThat(debugger.attach("fixture", object("adapterId", "java-jdi", "port", port)))
          .containsEntry("state", "attached");
      var breakpoint =
          debugger.command(
              "fixture",
              object(
                  "command",
                  "setBreakpoints",
                  "arguments",
                  object(
                      "source",
                      object("path", "DebugFixture.java"),
                      "breakpoints",
                      List.of(object("line", 6)))));
      assertThat(map(list(breakpoint.get("breakpoints")).get(0))).containsEntry("verified", true);
      await(() -> "stopped".equals(map(debugger.status("fixture").get("session")).get("state")));
      long firstCursor = number(debugger.events("fixture", 0).get("cursor"));
      Object threadId = map(debugger.status("fixture").get("session")).get("threadId");
      var stack =
          debugger.command(
              "fixture",
              object("command", "stackTrace", "arguments", object("threadId", threadId)));
      var frame = map(list(stack.get("stackFrames")).get(0));
      assertThat(frame).containsEntry("line", 6);
      assertThat(map(frame.get("source"))).containsEntry("path", "DebugFixture.java");
      var scopes =
          debugger.command(
              "fixture",
              object("command", "scopes", "arguments", object("frameId", frame.get("id"))));
      Object reference = map(list(scopes.get("scopes")).get(0)).get("variablesReference");
      var variables =
          debugger.command(
              "fixture",
              object("command", "variables", "arguments", object("variablesReference", reference)));
      boolean hasCounter =
          list(variables.get("variables")).stream()
              .map(com.argus.runtime.service.RuntimeData::map)
              .anyMatch(
                  variable ->
                      "counter".equals(variable.get("name")) && "int".equals(variable.get("type")));
      org.junit.jupiter.api.Assertions.assertTrue(hasCounter);
      debugger.command(
          "fixture", object("command", "next", "arguments", object("threadId", threadId)));
      await(
          () ->
              list(debugger.events("fixture", firstCursor).get("events")).stream()
                  .map(com.argus.runtime.service.RuntimeData::map)
                  .anyMatch(
                      event ->
                          "stopped".equals(event.get("event"))
                              && "step".equals(map(event.get("body")).get("reason"))));
      assertThat(topFrame(debugger, threadId)).containsEntry("line", 7);
      long beforeContinue = number(debugger.events("fixture", 0).get("cursor"));
      debugger.command(
          "fixture", object("command", "continue", "arguments", object("threadId", threadId)));
      awaitStop(debugger, beforeContinue, "breakpoint");
      assertThat(topFrame(debugger, threadId)).containsEntry("line", 6);
      long beforeStepIn = number(debugger.events("fixture", 0).get("cursor"));
      debugger.command(
          "fixture", object("command", "stepIn", "arguments", object("threadId", threadId)));
      awaitStop(debugger, beforeStepIn, "step");
      assertThat(topFrame(debugger, threadId)).containsEntry("line", 11);
      long beforeStepOut = number(debugger.events("fixture", 0).get("cursor"));
      debugger.command(
          "fixture", object("command", "stepOut", "arguments", object("threadId", threadId)));
      awaitStop(debugger, beforeStepOut, "step");
      assertThat(number(topFrame(debugger, threadId).get("line"))).isIn(6L, 7L);
      debugger.detach("fixture");
      assertThat(debugger.status("fixture").get("session")).isNull();
      assertThat(processes.list().get(0)).containsEntry("running", true);
    } finally {
      debugger.quiesce();
      processes.stopAll();
    }
  }

  private Map<String, Object> topFrame(DebugService debugger, Object threadId) {
    return map(
        list(debugger
                .command(
                    "fixture",
                    object(
                        "command",
                        "stackTrace",
                        "arguments",
                        object("threadId", threadId, "levels", 1)))
                .get("stackFrames"))
            .get(0));
  }

  private void awaitStop(DebugService debugger, long after, String reason)
      throws InterruptedException {
    await(
        () ->
            list(debugger.events("fixture", after).get("events")).stream()
                .map(com.argus.runtime.service.RuntimeData::map)
                .anyMatch(
                    event ->
                        "stopped".equals(event.get("event"))
                            && reason.equals(map(event.get("body")).get("reason"))));
  }

  @Test
  void prerequisitesAndAdmissionAreHonestAndDoNotAttachUnknownServices() {
    var processes = new ProcessManager();
    var debugger = service(processes);
    try {
      var nodeAdapter =
          list(debugger.status("fixture").get("adapters")).stream()
              .map(com.argus.runtime.service.RuntimeData::map)
              .filter(adapter -> "node-js-debug".equals(adapter.get("id")))
              .findFirst()
              .orElseThrow();
      var discovered =
          JavaScriptDebugTools.discover(new ArgusProperties(directory, directory, "test", ""));
      org.junit.jupiter.api.Assertions.assertEquals(
          discovered.available(), nodeAdapter.get("available"));
      org.junit.jupiter.api.Assertions.assertEquals(discovered.reason(), nodeAdapter.get("reason"));
      if (!discovered.available())
        org.junit.jupiter.api.Assertions.assertFalse(discovered.reason().isBlank());
      assertThatThrownBy(
              () -> debugger.attach("fixture", object("adapterId", "java-jdi", "port", 5005)))
          .hasMessageContaining("Start this repository's service");
      assertThatThrownBy(
              () ->
                  debugger.attach(
                      "fixture",
                      object("adapterId", "java-jdi", "port", 5005, "host", "example.com")))
          .hasMessageContaining("only adapterId");
      assertThatThrownBy(
              () ->
                  debugger.command(
                      "fixture",
                      object("command", "evaluate", "arguments", object("expression", "unsafe()"))))
          .hasMessageContaining("Unsupported debugger command");
      debugger.stopRepository("fixture");
      assertThatThrownBy(
              () -> debugger.attach("fixture", object("adapterId", "java-jdi", "port", 5005)))
          .hasMessageContaining("admission is closed");
    } finally {
      debugger.quiesce();
      processes.stopAll();
    }
  }

  @Test
  void debuggerSourcesAcceptCanonicalAliasesAndRejectOutsideFilesAndSymlinkEscapes()
      throws Exception {
    Path realRepository = Files.createDirectory(directory.resolve("real-repository"));
    Path alias = Files.createSymbolicLink(directory.resolve("repository-alias"), realRepository);
    Path source = Files.writeString(realRepository.resolve("main.js"), "let counter = 0;\n");
    Path outside = Files.writeString(directory.resolve("outside.js"), "outside\n");
    Path escape = Files.createSymbolicLink(realRepository.resolve("escape.js"), outside);
    var response =
        object(
            "stackFrames",
            List.of(
                object("id", 0, "source", object("path", source.toRealPath().toString())),
                object("id", 1, "source", object("path", alias.resolve("main.js").toString())),
                object("id", 2, "source", object("path", outside.toString())),
                object("id", 3, "source", object("path", escape.toString())),
                object("id", 4, "source", object("path", "../outside.js"))),
            "breakpoints",
            List.of(object("line", 1, "source", object("path", "main.js"))));
    var normalized = DebugService.normalizeSources(response, alias);
    var frames = list(normalized.get("stackFrames"));
    assertThat(map(map(frames.get(0)).get("source"))).containsEntry("path", "main.js");
    assertThat(map(map(frames.get(1)).get("source"))).containsEntry("path", "main.js");
    assertThat(map(frames.get(2))).doesNotContainKey("source");
    assertThat(map(frames.get(3))).doesNotContainKey("source");
    assertThat(map(frames.get(4))).doesNotContainKey("source");
    var breakpoint = map(list(normalized.get("breakpoints")).get(0));
    assertThat(map(breakpoint.get("source"))).containsEntry("path", "main.js");
    assertThat(map(map(list(response.get("stackFrames")).get(0)).get("source")))
        .containsEntry("path", source.toRealPath().toString());
    var event =
        DebugService.normalizeSources(
            object(
                "reason",
                "changed",
                "breakpoint",
                object("id", 1, "source", object("path", source.toString()))),
            alias);
    assertThat(map(map(event.get("breakpoint")).get("source"))).containsEntry("path", "main.js");
    var outsideEvent =
        DebugService.normalizeSources(
            object("breakpoint", object("id", 2, "source", object("path", outside.toString()))),
            alias);
    assertThat(map(outsideEvent.get("breakpoint"))).doesNotContainKey("source");
  }

  @Test
  void dapThreadAndFrameZeroAreValidButVariablesRequirePositiveReferences() {
    DebugService.validateArguments("pause", object("threadId", 0), directory);
    DebugService.validateArguments("stackTrace", object("threadId", 0), directory);
    DebugService.validateArguments("scopes", object("frameId", 0), directory);
    assertThatThrownBy(
            () -> DebugService.validateArguments("pause", object("threadId", -1), directory))
        .hasMessageContaining("Invalid debugger reference");
    assertThatThrownBy(
            () -> DebugService.validateArguments("pause", object("threadId", 0.5), directory))
        .hasMessageContaining("Invalid debugger reference");
    assertThatThrownBy(
            () ->
                DebugService.validateArguments(
                    "variables", object("variablesReference", 0), directory))
        .hasMessageContaining("Invalid debugger reference");
  }

  @Test
  void debugFlagsStayInApplicationArgumentsAndRejectUnsafeRuntimeOrPort() {
    var java = object("executable", "java", "args", List.of("-jar", "app.jar"));
    var prepared = DebugLaunch.prepare(java, null);
    assertThat(strings(prepared.get("args")).get(0)).contains("suspend=n,address=127.0.0.1:");
    assertThat(java).doesNotContainKey("debug");
    var maven =
        DebugLaunch.prepare(
            object("executable", "./mvnw", "args", List.of("spring-boot:run")), null);
    assertThat(strings(maven.get("args")))
        .anyMatch(arg -> arg.startsWith("-Dspring-boot.run.jvmArguments=-agentlib:jdwp="));
    var node =
        DebugLaunch.prepare(object("executable", "node", "args", List.of("server.js")), null);
    assertThat(strings(node.get("args")).get(0)).startsWith("--inspect=127.0.0.1:");
    assertThatThrownBy(() -> DebugLaunch.prepare(java, 80)).hasMessageContaining("1024");
    assertThatThrownBy(
            () -> DebugLaunch.prepare(object("executable", "npm", "args", List.of("test")), null))
        .hasMessageContaining("direct application command");
    assertThatThrownBy(
            () -> DebugLaunch.prepare(object("executable", "mvn", "args", List.of("test")), null))
        .hasMessageContaining("spring-boot:run");
  }

  private static void await(BooleanSupplier condition) throws InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
    while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(15);
    assertThat(condition.getAsBoolean()).isTrue();
  }
}
