package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import java.util.*;
import org.junit.jupiter.api.Test;

class GradleDebugLaunchTest {
  @Test
  void supportsExactApplicationTasksAndPreservesSavedArguments() {
    for (String task : List.of("bootRun", ":bootRun", ":web-service:bootRun", ":api:server:run")) {
      var original =
          object(
              "executable",
              "./gradlew",
              "args",
              List.of(task, "--args=--spring.profiles.active=qa"),
              "cwd",
              ".");
      var prepared = DebugLaunch.prepare(original, null);
      assertThat(original).doesNotContainKey("debug").doesNotContainKey("gradleDebugTask");
      String target = task.startsWith(":") ? task : ":" + task;
      assertThat(prepared).containsEntry("gradleDebugTask", target);
      assertThat(strings(prepared.get("args")))
          .containsExactly(target, "--args=--spring.profiles.active=qa");
      var debug = map(prepared.get("debug"));
      assertThat(debug).containsEntry("runtime", "java").containsEntry("host", "127.0.0.1");
      String script = DebugLaunch.gradleScript(target, (int) number(debug.get("port")));
      assertThat(script)
          .contains(
              "app.path == '" + target + "'",
              "withType(JavaExec)",
              "host = '127.0.0.1'",
              "suspend = false")
          .doesNotContain("JAVA_TOOL_OPTIONS", "org.gradle.jvmargs", "withType(Test)");
    }
  }

  @Test
  void customWorkingDirectoryRequiresExplicitProjectPathInsteadOfGuessingFromFolders() {
    assertThatThrownBy(
            () ->
                DebugLaunch.prepare(
                    object("executable", "gradle", "args", List.of("bootRun"), "cwd", "api/server"),
                    null))
        .hasMessageContaining("fully qualified")
        .hasMessageContaining("will not guess");
    assertThat(
            DebugLaunch.prepare(
                object(
                    "executable",
                    "gradle",
                    "args",
                    List.of(":api:server:bootRun"),
                    "cwd",
                    "api/server"),
                null))
        .containsEntry("gradleDebugTask", ":api:server:bootRun");
    assertThat(
            DebugLaunch.prepare(
                object("executable", "gradle", "args", List.of(":run"), "cwd", "nested/build"),
                null))
        .containsEntry("gradleDebugTask", ":run");
  }

  @Test
  void rejectsAmbiguousOrExistingDebugFlagsAndScriptInjection() {
    for (List<String> args :
        List.of(
            List.of("test"),
            List.of("one:bootRun", "two:bootRun"),
            List.of("bootRun", "--debug-jvm"),
            List.of("bootRun", "--debug-jvm=true"),
            List.of("bootRun", "--no-debug-jvm"),
            List.of("bootRun", "-Dorg.gradle.debug=true")))
      assertThatThrownBy(
              () -> DebugLaunch.prepare(object("executable", "./gradlew", "args", args), null))
          .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> DebugLaunch.gradleScript(":bad'code:bootRun", 5005))
        .isInstanceOf(IllegalArgumentException.class);
  }
}
