package com.argus.common.process;

import static org.assertj.core.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class OwnedProcessTest {
  @TempDir Path directory;

  @Test
  void drainsBothStreamsAndPreservesUtf8BeforeCompleting() throws Exception {
    try (var child =
        new OwnedProcess(
            new ProcessBuilder("/bin/sh", "-c", "printf 'नमस्ते ☀'; printf 'notes' >&2"), null)) {
      child.closeInput();
      var result = child.await(Duration.ofSeconds(2));
      assertThat(result.stdout()).isEqualTo("नमस्ते ☀");
      assertThat(result.stderr()).isEqualTo("notes");
      assertThat(result.exitCode()).isZero();
    }
  }

  @Test
  void refusesSilentOutputTruncationAndKeepsCaptureBounded() throws Exception {
    try (var child =
        new OwnedProcess(new ProcessBuilder("/bin/sh", "-c", "printf 1234567890"), null, 4)) {
      assertThatThrownBy(() -> child.await(Duration.ofSeconds(2)))
          .hasMessageContaining("capture limit");
      assertThat(child.stdout()).isEqualTo("7890");
      assertThat(child.outputTruncated()).isTrue();
    }
  }

  @Test
  void deadlineKillsRetainedChildrenAndDoesNotWaitForeverForInheritedPipes() throws Exception {
    Path pid = directory.resolve("child.pid");
    try (var child =
        new OwnedProcess(
            new ProcessBuilder(
                "/bin/sh", "-c", "sleep 30 & echo $! > \"$1\"; wait", "fixture", pid.toString()),
            null)) {
      awaitFile(pid);
      long descendant = Long.parseLong(Files.readString(pid).trim());
      assertThatThrownBy(() -> child.await(Duration.ofMillis(120)))
          .hasMessageContaining("timed out");
      assertThat(child.isAlive()).isFalse();
      awaitStopped(descendant);
    }
  }

  @Test
  void honorsSelectedChildPathInsteadOfTheJvmPath() throws Exception {
    Path command = directory.resolve("argus-selected-runtime");
    Files.writeString(command, "#!/bin/sh\nprintf selected-runtime\n");
    assertThat(command.toFile().setExecutable(true)).isTrue();
    ProcessBuilder builder = new ProcessBuilder("argus-selected-runtime");
    builder.environment().put("PATH", directory.toString());
    try (var child = new OwnedProcess(builder, null)) {
      assertThat(child.await(Duration.ofSeconds(2)).stdout()).isEqualTo("selected-runtime");
    }
    ProcessBuilder missing = new ProcessBuilder("sh");
    missing.environment().put("PATH", directory.toString());
    assertThatThrownBy(() -> new OwnedProcess(missing, null))
        .hasMessageContaining("selected runtime PATH");
  }

  @Test
  void privateGroupReapsAnImmediatelyOrphanedChild() throws Exception {
    Path launcher = compileLauncher();
    Path pid = directory.resolve("orphan.pid");
    ProcessBuilder builder =
        new ProcessBuilder(
            "/bin/sh",
            "-c",
            "sleep 30 >/dev/null 2>&1 & echo $! > \"$1\"; exit 0",
            "fixture",
            pid.toString());
    builder.environment().put("ARGUS_PROCESS_LAUNCHER", launcher.toString());
    try (var child = new OwnedProcess(builder, null)) {
      awaitFile(pid);
      long orphan = Long.parseLong(Files.readString(pid).trim());
      assertThat(child.await(Duration.ofSeconds(3)).exitCode()).isZero();
      awaitStopped(orphan);
      child.close(); // cleanup is idempotent and never targets a later reused group.
    }
  }

  @Test
  void pauseResumeAndStopApplyToTheOwnedGroupOnly() throws Exception {
    Path launcher = compileLauncher();
    Path progress = directory.resolve("progress");
    ProcessBuilder builder =
        new ProcessBuilder(
            "/bin/sh",
            "-c",
            "while :; do echo tick >> \"$1\"; sleep 0.04; done",
            "fixture",
            progress.toString());
    builder.environment().put("ARGUS_PROCESS_LAUNCHER", launcher.toString());
    try (var child = new OwnedProcess(builder, null)) {
      awaitFile(progress);
      child.pause();
      Thread.sleep(120);
      long paused = Files.size(progress);
      Thread.sleep(150);
      assertThat(Files.size(progress)).isEqualTo(paused);
      child.resume();
      Thread.sleep(180);
      assertThat(Files.size(progress)).isGreaterThan(paused);
      child.pause();
      child.stop(Duration.ofSeconds(1), Duration.ofSeconds(1));
      assertThat(child.isAlive()).isFalse();
    }
  }

  @Test
  void interruptedCloseStillReapsItsChild() throws Exception {
    ProcessBuilder builder = new ProcessBuilder("/bin/sh", "-c", "sleep 30");
    builder.environment().put("ARGUS_PROCESS_LAUNCHER", compileLauncher().toString());
    var child = new OwnedProcess(builder, null);
    try {
      Thread.currentThread().interrupt();
      child.close();
      assertThat(Thread.currentThread().isInterrupted()).isTrue();
    } finally {
      Thread.interrupted();
      child.close();
    }
    assertThat(child.isAlive()).isFalse();
  }

  private Path compileLauncher() throws Exception {
    Path source =
        Path.of("..", "desktop", "native", "argus-process-launcher.c").toAbsolutePath().normalize();
    Path launcher = directory.resolve("argus-process-launcher");
    var compile =
        new ProcessBuilder(
                "cc",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-o",
                launcher.toString(),
                source.toString())
            .redirectErrorStream(true)
            .start();
    assertThat(compile.waitFor(10, TimeUnit.SECONDS)).isTrue();
    assertThat(compile.exitValue())
        .as(new String(compile.getInputStream().readAllBytes()))
        .isZero();
    return launcher;
  }

  private void awaitFile(Path file) throws Exception {
    long end = System.nanoTime() + Duration.ofSeconds(2).toNanos();
    while ((!Files.exists(file) || Files.size(file) == 0) && System.nanoTime() < end)
      Thread.sleep(10);
    assertThat(file).isNotEmptyFile();
  }

  private void awaitStopped(long pid) throws Exception {
    long end = System.nanoTime() + Duration.ofSeconds(2).toNanos();
    while (ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)
        && System.nanoTime() < end) Thread.sleep(10);
    assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
  }
}
