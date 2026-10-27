package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.runtime.service.ProcessManager;
import com.argus.workspace.domain.Repository;
import com.sun.jdi.VirtualMachine;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import javax.tools.ToolProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JavaDebugSessionTest {
  @TempDir Path directory;

  @Test
  void pauseDuringClassPreparationOwnsItsSuspensionUntilContinue() throws Exception {
    Path source = directory.resolve("PauseFixture.java");
    Files.writeString(
        source,
        """
        import java.nio.file.Files;
        import java.nio.file.Path;
        public class PauseFixture {
          public static void main(String[] args) throws Exception {
            int counter = 0;
            while (!Files.exists(Path.of("load"))) {
              Files.writeString(Path.of("progress"), String.valueOf(counter++));
              Thread.sleep(10);
            }
            Class.forName("LazyFixture");
            while (true) {
              Files.writeString(Path.of("progress"), String.valueOf(counter++));
              Thread.sleep(10);
            }
          }
        }
        class LazyFixture { static int value = 42; }
        """);
    assertThat(ToolProvider.getSystemJavaCompiler().run(null, null, null, "-g", source.toString()))
        .isZero();
    var processes = new ProcessManager();
    JavaDebugSession debugger = null;
    var events = new CopyOnWriteArrayList<Map<String, Object>>();
    try {
      var target =
          processes.start(
              DebugLaunch.prepare(
                  object(
                      "id",
                      "pause-fixture",
                      "name",
                      "Pause fixture",
                      "cwd",
                      ".",
                      "executable",
                      Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                      "args",
                      List.of("-cp", directory.toString(), "PauseFixture")),
                  null),
              new Repository("fixture", "Fixture", directory.toString(), "now"),
              Map.of());
      await(() -> Files.exists(directory.resolve("progress")));
      await(() -> "listening".equals(map(processes.list().get(0).get("debug")).get("state")));
      debugger =
          new JavaDebugSession(
              directory,
              (int) number(map(target.get("debug")).get("port")),
              (event, body) -> events.add(object("event", event, "body", body)));
      Object threadId =
          list(debugger.command("threads", Map.of()).get("threads")).stream()
              .map(com.argus.runtime.service.RuntimeData::map)
              .filter(thread -> "main".equals(thread.get("name")))
              .findFirst()
              .orElseThrow()
              .get("id");

      // Observe the real JVM's suspension count without adding test hooks to the debugger.
      var field = JavaDebugSession.class.getDeclaredField("vm");
      field.setAccessible(true);
      var vm = (VirtualMachine) field.get(debugger);
      var main =
          vm.allThreads().stream()
              .filter(thread -> thread.name().equals("main"))
              .findFirst()
              .orElseThrow();
      synchronized (debugger) {
        // Hold the event reader at its session lock so ClassPrepare's temporary suspension
        // exists exactly when Pause arrives, rather than relying on a probabilistic race.
        Files.writeString(directory.resolve("load"), "load now");
        await(main::isSuspended);
        debugger.command("pause", object("threadId", threadId));
        assertThat(main.suspendCount()).isEqualTo(2);
        debugger.command("pause", object("threadId", threadId));
        assertThat(main.suspendCount()).isEqualTo(2);
      }
      await(() -> main.suspendCount() == 1);
      String paused = Files.readString(directory.resolve("progress"));
      Thread.sleep(100);
      assertThat(Files.readString(directory.resolve("progress"))).isEqualTo(paused);
      assertThat(events)
          .anySatisfy(
              event -> {
                assertThat(event).containsEntry("event", "stopped");
                assertThat(map(event.get("body")))
                    .containsEntry("reason", "pause")
                    .containsEntry("threadId", threadId);
              });
      assertThat(
              list(debugger.command("stackTrace", object("threadId", threadId)).get("stackFrames")))
          .isNotEmpty();
      debugger.command("continue", object("threadId", threadId));
      await(
          () -> {
            try {
              return !paused.equals(Files.readString(directory.resolve("progress")));
            } catch (java.io.IOException error) {
              return false;
            }
          });
      // Continue released our pause (progress advanced above). Another class
      // preparation may briefly suspend the JVM while its event is processed.
      await(() -> !main.isSuspended());
      assertThat(events).anySatisfy(event -> assertThat(event).containsEntry("event", "continued"));
    } finally {
      if (debugger != null) debugger.close();
      processes.stopAll();
    }
  }

  private static void await(BooleanSupplier condition) throws InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
    while (System.nanoTime() < deadline) {
      if (condition.getAsBoolean()) return;
      Thread.sleep(10);
    }
    assertThat(condition.getAsBoolean()).isTrue();
  }
}
