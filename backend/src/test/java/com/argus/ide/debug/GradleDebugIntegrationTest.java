package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
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
import javax.tools.ToolProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Optional offline proof with an already installed Gradle: -Dargus.test.gradle=/path/to/gradle. */
class GradleDebugIntegrationTest {
  @TempDir Path directory;

  @Test
  void targetsOnlySelectedModuleAndActuallyStopsAtSourceBreakpoint() throws Exception {
    String gradle = System.getProperty("argus.test.gradle", "");
    assumeTrue(
        !gradle.isBlank() && Files.isExecutable(Path.of(gradle)),
        "No installed test Gradle selected");
    Files.writeString(
        directory.resolve("settings.gradle"),
        "rootProject.name='argus-debug-fixture'\ninclude 'service'\n");
    Files.createDirectories(directory.resolve("service/src/main/java"));
    Path source = directory.resolve("service/src/main/java/GradleFixture.java");
    Files.writeString(
        source,
        """
        import java.nio.file.*;
        public class GradleFixture {
          public static void main(String[] args) throws Exception {
            int counter = 0;
            while (true) {
              Files.writeString(Path.of(args[0]), String.valueOf(counter++));
              Thread.sleep(25);
            }
          }
        }
        """);
    Path classes = Files.createDirectories(directory.resolve("fixture-classes"));
    assertThat(
            ToolProvider.getSystemJavaCompiler()
                .run(null, null, null, "-g", "-d", classes.toString(), source.toString()))
        .isZero();
    Files.writeString(
        directory.resolve("build.gradle"),
        """
        allprojects {
          tasks.register('bootRun', JavaExec) {
            classpath = files(rootProject.file('fixture-classes'))
            mainClass = 'GradleFixture'
            args rootProject.file(project == rootProject ? 'root-progress' : 'module-progress').absolutePath
          }
        }
        """);
    var processes = new ProcessManager();
    JavaDebugSession debugger = null;
    var events = new CopyOnWriteArrayList<Map<String, Object>>();
    try {
      var job =
          processes.start(
              DebugLaunch.prepare(
                  object(
                      "id",
                      "fixture",
                      "name",
                      "Fixture",
                      "cwd",
                      ".",
                      "executable",
                      gradle,
                      "args",
                      List.of(
                          ":service:bootRun",
                          "--offline",
                          "--max-workers=1",
                          "-Dorg.gradle.vfs.watch=false")),
                  null),
              new Repository("fixture", "Fixture", directory.toString(), "now"),
              Map.of(
                  "GRADLE_USER_HOME",
                  directory.resolve("gradle-user-home").toString(),
                  "JAVA_HOME",
                  System.getProperty("java.home")));
      Path progress = directory.resolve("module-progress");
      await(() -> Files.exists(progress), processes, text(job, "id"), 55);
      assertThat(directory.resolve("root-progress")).doesNotExist();
      await(
          () -> "listening".equals(map(processes.list().get(0).get("debug")).get("state")),
          processes,
          text(job, "id"),
          5);
      debugger =
          new JavaDebugSession(
              directory,
              (int) number(map(job.get("debug")).get("port")),
              (event, body) -> events.add(object("event", event, "body", body)));
      debugger.command(
          "setBreakpoints",
          object(
              "source",
              object("path", "service/src/main/java/GradleFixture.java"),
              "breakpoints",
              List.of(object("line", 6))));
      await(
          () ->
              events.stream()
                  .anyMatch(
                      event ->
                          "stopped".equals(event.get("event"))
                              && "breakpoint".equals(map(event.get("body")).get("reason"))),
          processes,
          text(job, "id"),
          5);
      String paused = Files.readString(progress);
      Thread.sleep(100);
      assertThat(Files.readString(progress)).isEqualTo(paused);
      Object thread =
          map(events.stream()
                  .filter(event -> "stopped".equals(event.get("event")))
                  .findFirst()
                  .orElseThrow()
                  .get("body"))
              .get("threadId");
      assertThat(
              list(debugger.command("stackTrace", object("threadId", thread)).get("stackFrames")))
          .anySatisfy(frame -> assertThat(map(frame)).containsEntry("line", 6));
      debugger.command(
          "setBreakpoints",
          object(
              "source",
              object("path", "service/src/main/java/GradleFixture.java"),
              "breakpoints",
              List.of()));
      debugger.command("continue", Map.of());
      await(
          () -> {
            try {
              return !Files.readString(progress).equals(paused);
            } catch (Exception error) {
              return false;
            }
          },
          processes,
          text(job, "id"),
          5);
    } finally {
      if (debugger != null) debugger.close();
      processes.stopAll();
    }
  }

  private static void await(
      BooleanSupplier condition, ProcessManager processes, String id, int seconds)
      throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
    while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(20);
    assertThat(condition.getAsBoolean())
        .withFailMessage("Gradle fixture did not reach expected state: %s", processes.logs(id, 0))
        .isTrue();
  }
}
