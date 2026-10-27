package com.argus.runtime.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProcessManagerTest {
  @TempDir Path directory;

  Repository repository() {
    return new Repository("fixture", "fixture", directory.toString(), "now", "main");
  }

  Map<String, Object> config(String script) {
    return RuntimeData.object(
        "id",
        "config",
        "name",
        "fixture",
        "executable",
        "/bin/sh",
        "args",
        List.of("-c", script),
        "cwd",
        ".",
        "stage",
        "testing",
        "task",
        "test",
        "label",
        "Fixture test");
  }

  @Test
  void syncExcludesOtherRepositoryWorkAcrossDifferentSavedConfigurations() throws Exception {
    var processes = new ProcessManager();
    try {
      var sync = config("sleep 20");
      sync.put("id", "synthetic-sync");
      sync.put("task", "sync");
      sync.put("stage", "syncing");
      var work = processes.runTask(sync, repository(), Map.of());
      var saved = config("sleep 20");
      saved.put("id", "newly-saved");
      assertThatThrownBy(() -> processes.start(saved, repository(), Map.of()))
          .hasMessageContaining("exclusive access");
      assertThatThrownBy(() -> processes.runTask(saved, repository(), Map.of()))
          .hasMessageContaining("exclusive access");
      processes.stop(String.valueOf(work.get("id")));
      processes.start(saved, repository(), Map.of());
      assertThatThrownBy(() -> processes.runTask(sync, repository(), Map.of()))
          .hasMessageContaining("exclusive access");
      var another = config("sleep 20");
      another.put("id", "second-service");
      assertThat(processes.start(another, repository(), Map.of()))
          .containsEntry("status", "running");
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void taskWaitsForOutputAndPreservesLogsAndExitCode() throws Exception {
    var processes = new ProcessManager();
    try {
      var job =
          processes.runTask(
              config("printf 'fixture output\\n'; printf 'fixture error\\n' >&2; exit 7"),
              repository(),
              Map.of());
      processes.completion(String.valueOf(job.get("id"))).get(5, TimeUnit.SECONDS);
      assertThat(processes.list().get(0))
          .containsEntry("status", "failed")
          .containsEntry("exitCode", 7);
      assertThat(String.valueOf(processes.logs(String.valueOf(job.get("id")), 0).get("logs")))
          .contains("fixture output", "fixture error");
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void logCursorAdvancesAfterRetentionAndFinalOutputIsAvailableAtCompletion() throws Exception {
    var processes = new ProcessManager();
    try {
      var job =
          processes.runTask(
              config(
                  "i=0; while [ \"$i\" -lt 2100 ]; do printf 'x\\n'; i=$((i+1)); done; "
                      + "while [ ! -f release-output ]; do sleep 0.01; done; "
                      + "printf 'after-retention\\n'; printf 'final-error' >&2"),
              repository(),
              Map.of());
      String id = String.valueOf(job.get("id"));
      Map<String, Object> first = processes.logs(id, 0);
      long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while (((Number) first.get("cursor")).longValue() < 2101 && System.nanoTime() < until) {
        Thread.sleep(10);
        first = processes.logs(id, 0);
      }
      assertThat(first)
          .containsEntry("cursor", 2101L)
          .containsEntry("oldestCursor", 101L)
          .containsEntry("dropped", 101L)
          .containsEntry("status", "testing");
      assertThat((List<?>) first.get("logs")).hasSize(2000);
      long cursor = ((Number) first.get("cursor")).longValue();
      assertThat((List<?>) processes.logs(id, cursor).get("logs")).isEmpty();

      Files.writeString(directory.resolve("release-output"), "continue");
      processes.completion(id).get(5, TimeUnit.SECONDS);
      var last = processes.logs(id, cursor);
      assertThat(last)
          .containsEntry("cursor", 2104L)
          .containsEntry("oldestCursor", 104L)
          .containsEntry("dropped", 0L)
          .containsEntry("status", "completed");
      assertThat((List<?>) last.get("logs")).hasSize(3);
      assertThat(String.valueOf(last.get("logs")))
          .contains("after-retention", "final-error", "Fixture test completed");
      assertThat((List<?>) processes.logs(id, 2104).get("logs")).isEmpty();
      assertThat(processes.logs(id, 100)).containsEntry("dropped", 4L);
      assertThat((List<?>) processes.logs(id, 100).get("logs")).hasSize(2000);

      var tail = processes.logs(id, -2);
      assertThat(tail).containsEntry("cursor", 2104L).containsEntry("dropped", 0L);
      assertThat((List<?>) tail.get("logs")).hasSize(2);
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void logOffsetsAcceptLongCursorsAndRetainNegativeTailRequests() throws Exception {
    var processes = new ProcessManager();
    try {
      var job = processes.runTask(config("printf 'output\\n'"), repository(), Map.of());
      String id = String.valueOf(job.get("id"));
      processes.completion(id).get(5, TimeUnit.SECONDS);
      var all = processes.logs(id, 0);
      List<?> logs = (List<?>) all.get("logs");
      assertThat(all).containsEntry("oldestCursor", 0L).containsEntry("dropped", 0L);
      assertThat(processes.logs(id, Long.MAX_VALUE))
          .containsEntry("cursor", all.get("cursor"))
          .containsEntry("dropped", 0L);
      assertThat((List<?>) processes.logs(id, Long.MAX_VALUE).get("logs")).isEmpty();
      assertThat(processes.logs(id, -1).get("logs"))
          .isEqualTo(logs.subList(logs.size() - 1, logs.size()));
      assertThat(processes.logs(id, Long.MIN_VALUE).get("logs")).isEqualTo(logs);
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void stopInstallNeverLaunchesTheService() throws Exception {
    var processes = new ProcessManager();
    try {
      var config = config("printf launched > launched.txt");
      config.putAll(
          RuntimeData.object(
              "runtimeType",
              "ui",
              "dependencyDirectory",
              "node_modules",
              "installExecutable",
              "/bin/sh",
              "installArgs",
              List.of("-c", "sleep 20")));
      var job = processes.start(config, repository(), Map.of());
      assertThat(job).containsEntry("status", "installing");
      assertThatThrownBy(() -> processes.start(config, repository(), Map.of()))
          .hasMessageContaining("already running");
      processes.stop(String.valueOf(job.get("id")));
      assertThat(processes.list().get(0)).containsEntry("status", "stopped");
      assertThat(Files.exists(directory.resolve("launched.txt"))).isFalse();
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void refusesCwdEscapesAndPurgesOnlySelectedOwnedJobs() throws Exception {
    var processes = new ProcessManager();
    try {
      var invalid = config("exit 0");
      invalid.put("cwd", "..");
      assertThatThrownBy(() -> processes.start(invalid, repository(), Map.of()))
          .hasMessageContaining("inside");
      var job = processes.runTask(config("exit 0"), repository(), Map.of());
      processes.completion(String.valueOf(job.get("id"))).get(5, TimeUnit.SECONDS);
      assertThat(processes.purgeRepositories(List.of("other")))
          .containsEntry("processesDeleted", 0);
      assertThat(processes.purgeRepositories(List.of("fixture")))
          .containsEntry("processesDeleted", 1);
      assertThat(processes.list()).isEmpty();
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void disconnectStopsServicesWithoutDeletingLogsAndRejectsLateStarts() throws Exception {
    var processes = new ProcessManager();
    try {
      var job = processes.runTask(config("echo retained-log; sleep 20"), repository(), Map.of());
      String id = String.valueOf(job.get("id"));
      assertThat(processes.disconnectRepositories(List.of("fixture")))
          .containsEntry("processesRetained", 1);
      assertThat(processes.list()).hasSize(1);
      assertThat(processes.logs(id, 0)).containsKey("logs");
      assertThatThrownBy(() -> processes.start(config("exit 0"), repository(), Map.of()))
          .hasMessageContaining("offboarded");
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void successfulDependencySetupPrecedesLaunchAndKeepsSelectedEnvironment() throws Exception {
    var processes = new ProcessManager();
    try {
      var config = config("test -f dependencies-ready && printf '%s' \"$ARGUS_FIXTURE_VALUE\"");
      config.putAll(
          RuntimeData.object(
              "runtimeType",
              "ui",
              "dependencyDirectory",
              "node_modules",
              "installExecutable",
              "/bin/sh",
              "installArgs",
              List.of("-c", "printf ready > dependencies-ready")));
      var job =
          processes.start(
              config, repository(), Map.of("ARGUS_FIXTURE_VALUE", "selected fixture environment"));
      String id = String.valueOf(job.get("id"));
      processes.completion(id).get(5, TimeUnit.SECONDS);
      assertThat(processes.list().get(0))
          .containsEntry("exitCode", 0)
          .containsEntry("status", "stopped");
      assertThat(String.valueOf(processes.logs(id, 0).get("logs")))
          .contains("selected fixture environment");
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void shutdownDrainsOwnedShellAndDescendantsAndRejectsLaterStarts() throws Exception {
    var processes = new ProcessManager();
    try {
      var job =
          processes.runTask(config("sleep 20 & echo $! > child.pid; wait"), repository(), Map.of());
      Path pidFile = directory.resolve("child.pid");
      long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
      while ((!Files.exists(pidFile) || Files.size(pidFile) == 0) && System.nanoTime() < until)
        Thread.sleep(10);
      assertThat(pidFile).isNotEmptyFile();
      long pid = Long.parseLong(Files.readString(pidFile).trim());
      processes.stopAll();
      processes.completion(String.valueOf(job.get("id"))).get(2, TimeUnit.SECONDS);
      until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
      while (ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)
          && System.nanoTime() < until) Thread.sleep(10);
      assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
      assertThat(processes.list().get(0)).containsEntry("status", "stopped");
      assertThatThrownBy(() -> processes.start(config("exit 0"), repository(), Map.of()))
          .hasMessageContaining("shutting down");
      assertThatThrownBy(() -> processes.runTask(config("exit 0"), repository(), Map.of()))
          .hasMessageContaining("shutting down");
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void selectedChildPathIsHonoredThroughDependencyInstallAndServiceLaunch() throws Exception {
    Path bin = Files.createDirectory(directory.resolve("selected-bin"));
    Path executable = bin.resolve("argus-runtime-fixture");
    Files.writeString(executable, "#!/bin/sh\nprintf 'selected-runtime-%s\\n' \"$1\"\n");
    assertThat(executable.toFile().setExecutable(true)).isTrue();
    var configuration = config("unused");
    configuration.putAll(
        RuntimeData.object(
            "executable",
            "argus-runtime-fixture",
            "args",
            List.of("run"),
            "runtimeType",
            "ui",
            "dependencyDirectory",
            "node_modules",
            "installExecutable",
            "argus-runtime-fixture",
            "installArgs",
            List.of("install")));
    var processes = new ProcessManager();
    try {
      var job = processes.start(configuration, repository(), Map.of("PATH", bin.toString()));
      String id = String.valueOf(job.get("id"));
      processes.completion(id).get(5, TimeUnit.SECONDS);
      assertThat(processes.list().get(0))
          .containsEntry("exitCode", 0)
          .containsEntry("status", "stopped");
      assertThat(String.valueOf(processes.logs(id, 0).get("logs")))
          .contains("selected-runtime-install", "selected-runtime-run");
    } finally {
      processes.stopAll();
    }
  }

  @Test
  void offboardingRetiresAdmissionBeforeAnyLatePreparedStart() throws Exception {
    var processes = new ProcessManager();
    try {
      assertThat(processes.purgeRepositories(List.of("fixture")))
          .containsEntry("processesDeleted", 0);
      assertThatThrownBy(
              () -> processes.start(config("printf unsafe > leaked"), repository(), Map.of()))
          .hasMessageContaining("offboarded");
      assertThatThrownBy(
              () -> processes.runTask(config("printf unsafe > leaked"), repository(), Map.of()))
          .hasMessageContaining("offboarded");
      assertThat(Files.exists(directory.resolve("leaked"))).isFalse();
      var reconnected =
          new Repository("new-connection", "fixture", directory.toString(), "now", "main");
      var job = processes.runTask(config("printf reconnected"), reconnected, Map.of());
      processes.completion(String.valueOf(job.get("id"))).get(5, TimeUnit.SECONDS);
      assertThat(processes.list().get(0)).containsEntry("exitCode", 0);
    } finally {
      processes.stopAll();
    }
  }
}
