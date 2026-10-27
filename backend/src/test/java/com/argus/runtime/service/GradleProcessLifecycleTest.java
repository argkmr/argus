package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.ide.debug.DebugLaunch;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class GradleProcessLifecycleTest {
  @TempDir Path directory;

  private Map<String, Object> fixture() throws Exception {
    Path wrapper = directory.resolve("gradlew");
    Files.writeString(
        wrapper,
        """
        #!/bin/sh
        while [ "$#" -gt 0 ]; do
          if [ "$1" = --init-script ]; then
            shift
            cp "$1" seen-init-content
            printf '%s' "$1" > seen-init-path
          fi
          shift
        done
        printf '%s' "$ARGUS_FIXTURE_ENV"
        if [ "$ARGUS_FIXTURE_WAIT" = yes ]; then sleep 30; fi
        exit "${ARGUS_FIXTURE_EXIT:-0}"
        """);
    assertThat(wrapper.toFile().setExecutable(true)).isTrue();
    return object(
        "id",
        "fixture",
        "name",
        "Fixture",
        "cwd",
        ".",
        "executable",
        "./gradlew",
        "args",
        List.of("bootRun"),
        "stage",
        "syncing",
        "task",
        "sync",
        "label",
        "Sync fixture");
  }

  private Repository repository() {
    return new Repository("fixture", "Fixture", directory.toString(), "now");
  }

  private Path awaitScript() throws Exception {
    Path recorded = directory.resolve("seen-init-path");
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    while ((!Files.exists(recorded) || Files.size(recorded) == 0) && System.nanoTime() < deadline)
      Thread.sleep(10);
    assertThat(recorded).isNotEmptyFile();
    return Path.of(Files.readString(recorded));
  }

  private void awaitRemoved(Path script) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
    while (Files.exists(script) && System.nanoTime() < deadline) Thread.sleep(10);
    assertThat(script).doesNotExist();
  }

  @Test
  void maintenanceScriptIsOwnedAndRemovedAfterSuccessAndFailure() throws Exception {
    var processes = new ProcessManager();
    try {
      for (String code : List.of("0", "7")) {
        Files.deleteIfExists(directory.resolve("seen-init-path"));
        var job =
            processes.runGradleTask(
                fixture(),
                repository(),
                Map.of("ARGUS_FIXTURE_EXIT", code, "ARGUS_FIXTURE_ENV", "saved environment"),
                "// product-owned fixture script");
        Path script = awaitScript();
        processes.completion(text(job, "id")).get(5, TimeUnit.SECONDS);
        awaitRemoved(script);
        assertThat(Files.readString(directory.resolve("seen-init-content")))
            .isEqualTo("// product-owned fixture script");
        assertThat(text(job, "command")).contains("--no-daemon", "--init-script");
        assertThat(script.startsWith(directory)).isFalse();
        assertThat(processes.logs(text(job, "id"), 0).toString()).contains("saved environment");
        assertThat(processes.list().get(processes.list().size() - 1))
            .containsEntry("exitCode", Integer.parseInt(code));
      }
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void debugScriptIsRemovedAfterStopAndNeverPersistedInSavedCommand() throws Exception {
    var processes = new ProcessManager();
    try {
      var saved = fixture();
      var prepared = DebugLaunch.prepare(saved, null);
      var job = processes.start(prepared, repository(), Map.of("ARGUS_FIXTURE_WAIT", "yes"));
      Path script = awaitScript();
      assertThat(script).exists();
      assertThat(Files.readString(directory.resolve("seen-init-content")))
          .contains("app.path == ':bootRun'", "host = '127.0.0.1'");
      processes.stop(text(job, "id"));
      awaitRemoved(script);
      assertThat(processes.list().get(0)).containsEntry("status", "stopped");
      assertThat(strings(saved.get("args"))).containsExactly("bootRun");
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void rejectsMaintenanceScriptForNonGradleExecutable() throws Exception {
    var config = fixture();
    config.put("executable", "/bin/sh");
    assertThatThrownBy(
            () -> new ProcessManager().runGradleTask(config, repository(), Map.of(), "script"))
        .hasMessageContaining("Gradle executable");
  }
}
