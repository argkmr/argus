package com.argus.common.process;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BiConsumer;

/** An explicitly owned child, bounded UTF-8 streams, and retained descendant handles. */
public final class OwnedProcess implements AutoCloseable {
  private static final ScheduledExecutorService TRACKER =
      Executors.newSingleThreadScheduledExecutor(
          task -> {
            Thread thread = new Thread(task, "argus-owned-process-tracker");
            thread.setDaemon(true);
            return thread;
          });
  private final Process process;
  private final boolean processGroup;
  private final Map<Long, ProcessHandle> descendants = new ConcurrentHashMap<>();
  private final StringBuilder stdout = new StringBuilder();
  private final StringBuilder stderr = new StringBuilder();
  private final int maxCharacters;
  private final BiConsumer<String, String> output;
  private final CompletableFuture<Void> stdoutDone = new CompletableFuture<>();
  private final CompletableFuture<Void> stderrDone = new CompletableFuture<>();
  private final CompletableFuture<Integer> completion = new CompletableFuture<>();
  private final ScheduledFuture<?> tracking;
  private volatile boolean truncated;
  private volatile boolean paused;
  private volatile boolean groupStopped;
  private volatile boolean closed;

  public OwnedProcess(ProcessBuilder builder, BiConsumer<String, String> output, int maxCharacters)
      throws IOException {
    if (maxCharacters < 1) throw new IllegalArgumentException("Output limit must be positive");
    this.maxCharacters = maxCharacters;
    this.output = output == null ? (stream, value) -> {} : output;
    String launcher =
        builder
            .environment()
            .getOrDefault(
                "ARGUS_PROCESS_LAUNCHER", System.getProperty("argus.process-launcher", ""));
    processGroup = !launcher.isBlank();
    if (processGroup) {
      java.nio.file.Path path = java.nio.file.Path.of(launcher);
      if (!path.isAbsolute()
          || !java.nio.file.Files.isRegularFile(path)
          || !java.nio.file.Files.isExecutable(path))
        throw new IOException("The Argus process-isolation helper is unavailable");
      List<String> command = new ArrayList<>();
      command.add(path.toString());
      command.addAll(builder.command());
      builder.command(command);
    } else {
      resolveExecutable(builder);
    }
    process = builder.start();
    rememberDescendants();
    tracking =
        TRACKER.scheduleWithFixedDelay(this::rememberDescendants, 10, 25, TimeUnit.MILLISECONDS);
    drain(process.getInputStream(), "stdout", stdout, stdoutDone);
    drain(process.getErrorStream(), "stderr", stderr, stderrDone);
    process
        .onExit()
        .thenRun(
            () -> {
              rememberDescendants();
              // Reap a private group immediately while its identity is still owned,
              // including children that forked and were reparented before enumeration.
              try {
                if (processGroup) terminateGroupAfterRootExit();
              } catch (RuntimeException error) {
                completion.completeExceptionally(error);
                return;
              }
              // Resolve only after the root's streams finish. Callers still impose a
              // deadline and stop retained children when inherited pipe writers linger.
              CompletableFuture.allOf(stdoutDone, stderrDone)
                  .whenComplete(
                      (ignored, error) -> {
                        tracking.cancel(false);
                        if (error == null) completion.complete(process.exitValue());
                        else completion.completeExceptionally(error);
                      });
            });
  }

  public OwnedProcess(ProcessBuilder builder, BiConsumer<String, String> output)
      throws IOException {
    this(builder, output, 16 * 1024 * 1024);
  }

  public Process process() {
    return process;
  }

  public long pid() {
    return process.pid();
  }

  public boolean isAlive() {
    return process.isAlive();
  }

  public boolean outputTruncated() {
    return truncated;
  }

  public CompletableFuture<Integer> completion() {
    return completion;
  }

  public String stdout() {
    synchronized (stdout) {
      return stdout.toString();
    }
  }

  public String stderr() {
    synchronized (stderr) {
      return stderr.toString();
    }
  }

  public synchronized void write(String value) throws IOException {
    process.getOutputStream().write(value.getBytes(StandardCharsets.UTF_8));
    process.getOutputStream().flush();
  }

  public synchronized void closeInput() throws IOException {
    process.getOutputStream().close();
  }

  public CommandResult await(Duration timeout) {
    try {
      int code = completion.get(Math.max(1, timeout.toMillis()), TimeUnit.MILLISECONDS);
      if (truncated) throw new IllegalStateException("Command output exceeded its capture limit");
      return new CommandResult(stdout(), stderr(), code);
    } catch (InterruptedException error) {
      stop(Duration.ofMillis(500), Duration.ofMillis(500));
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Command interrupted", error);
    } catch (TimeoutException error) {
      stop(Duration.ofMillis(500), Duration.ofMillis(500));
      throw new IllegalStateException("Command timed out", error);
    } catch (ExecutionException error) {
      stop(Duration.ofMillis(500), Duration.ofMillis(500));
      throw new IllegalStateException("Could not read command output", error.getCause());
    }
  }

  public synchronized void pause() {
    paused = true;
    try {
      signalOwned("STOP");
    } catch (RuntimeException error) {
      try {
        resume();
      } catch (RuntimeException recovery) {
        error.addSuppressed(recovery);
      }
      throw error;
    }
  }

  public synchronized void resume() {
    signalOwned("CONT");
    paused = false;
  }

  public synchronized void stop(Duration graceful, Duration forced) {
    if (closed) return;
    boolean interrupted = Thread.interrupted();
    try {
      rememberDescendants();
      if (paused) resume();
      if (processGroup && !groupStopped) signalGroup("TERM");
      List<ProcessHandle> handles = ownedHandles();
      handles.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroy);
      waitFor(handles, graceful);
      // Include children observed between the initial snapshot and termination.
      rememberDescendants();
      handles = ownedHandles();
      if (processGroup && !groupStopped) {
        signalGroup("KILL");
        groupStopped = true;
      }
      handles.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
      waitFor(handles, forced);
      if (handles.stream().anyMatch(ProcessHandle::isAlive))
        throw new IllegalStateException("An Argus-owned child process has not stopped");
      tracking.cancel(false);
      try {
        process.getOutputStream().close();
      } catch (IOException ignored) {
      }
      try {
        process.getInputStream().close();
      } catch (IOException ignored) {
      }
      try {
        process.getErrorStream().close();
      } catch (IOException ignored) {
      }
      closed = true;
    } finally {
      if (interrupted) Thread.currentThread().interrupt();
    }
  }

  @Override
  public void close() {
    stop(Duration.ofMillis(1500), Duration.ofMillis(700));
  }

  private void rememberDescendants() {
    try {
      if (process.isAlive())
        process.descendants().forEach(handle -> descendants.put(handle.pid(), handle));
      for (ProcessHandle handle : List.copyOf(descendants.values()))
        if (handle.isAlive())
          handle.descendants().forEach(child -> descendants.put(child.pid(), child));
    } catch (RuntimeException ignored) {
      /* a child may disappear during enumeration */
    }
  }

  private List<ProcessHandle> ownedHandles() {
    var handles = new ArrayList<>(descendants.values());
    handles.add(process.toHandle());
    return handles;
  }

  private void signalOwned(String signal) {
    if (!List.of("STOP", "CONT").contains(signal))
      throw new IllegalArgumentException("Invalid process signal");
    if (System.getProperty("os.name", "").toLowerCase().contains("windows"))
      throw new IllegalStateException("Pausing processes is not supported on this platform");
    rememberDescendants();
    if (processGroup && signalGroup(signal)) return;
    for (ProcessHandle handle : ownedHandles()) {
      if (!handle.isAlive()) continue;
      try {
        Process signaller =
            new ProcessBuilder("/bin/kill", "-" + signal, String.valueOf(handle.pid()))
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start();
        if (!signaller.waitFor(2, TimeUnit.SECONDS)) {
          signaller.destroyForcibly();
          throw new IllegalStateException("Process signal timed out");
        }
        if (signaller.exitValue() != 0 && handle.isAlive())
          throw new IllegalStateException("Could not signal an Argus-owned process");
      } catch (IOException error) {
        throw new IllegalStateException("Could not signal an Argus-owned process", error);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Process signal interrupted", error);
      }
    }
  }

  private boolean signalGroup(String signal) {
    if (!List.of("TERM", "KILL", "STOP", "CONT").contains(signal))
      throw new IllegalArgumentException("Invalid group signal");
    try {
      Process signaller =
          new ProcessBuilder("/bin/kill", "-" + signal, "--", "-" + process.pid())
              .redirectOutput(ProcessBuilder.Redirect.DISCARD)
              .redirectError(ProcessBuilder.Redirect.DISCARD)
              .start();
      if (!signaller.waitFor(2, TimeUnit.SECONDS)) {
        signaller.destroyForcibly();
        throw new IllegalStateException("Process group signal timed out");
      }
      // ESRCH is expected when the group already exited or the launcher has not called setsid yet.
      return signaller.exitValue() == 0;
    } catch (IOException error) {
      throw new IllegalStateException("Could not signal an Argus-owned process group", error);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Process group signal interrupted", error);
    }
  }

  private synchronized void terminateGroupAfterRootExit() {
    if (groupStopped || closed) return;
    signalGroup("TERM");
    waitFor(ownedHandles(), Duration.ofMillis(500));
    signalGroup("KILL");
    groupStopped = true;
  }

  private static void resolveExecutable(ProcessBuilder builder) throws IOException {
    String executable = builder.command().get(0);
    if (executable.contains("/") || executable.contains("\\")) return;
    java.nio.file.Path cwd =
        builder.directory() == null
            ? java.nio.file.Path.of("").toAbsolutePath()
            : builder.directory().toPath().toAbsolutePath();
    for (String directory :
        builder
            .environment()
            .getOrDefault("PATH", "")
            .split(java.util.regex.Pattern.quote(java.io.File.pathSeparator), -1)) {
      try {
        java.nio.file.Path root = directory.isEmpty() ? cwd : java.nio.file.Path.of(directory);
        if (!root.isAbsolute()) root = cwd.resolve(root);
        java.nio.file.Path candidate = root.resolve(executable).normalize();
        if (java.nio.file.Files.isRegularFile(candidate)
            && java.nio.file.Files.isExecutable(candidate)) {
          List<String> command = new ArrayList<>(builder.command());
          command.set(0, candidate.toString());
          builder.command(command);
          return;
        }
      } catch (RuntimeException ignored) {
        /* invalid PATH entries are not executable candidates */
      }
    }
    throw new IOException(
        "Executable is not available in the selected runtime PATH: " + executable);
  }

  private void drain(
      InputStream input, String stream, StringBuilder buffer, CompletableFuture<Void> done) {
    Thread reader =
        new Thread(
            () -> {
              try (var text = new InputStreamReader(input, StandardCharsets.UTF_8)) {
                char[] chunk = new char[4096];
                int count;
                while ((count = text.read(chunk)) != -1) {
                  String value = new String(chunk, 0, count);
                  synchronized (buffer) {
                    buffer.append(value);
                    if (buffer.length() > maxCharacters) {
                      truncated = true;
                      buffer.delete(0, buffer.length() - maxCharacters);
                    }
                  }
                  output.accept(stream, value);
                }
                done.complete(null);
              } catch (Exception error) {
                done.completeExceptionally(error);
              }
            },
            "argus-process-" + process.pid() + "-" + stream);
    reader.setDaemon(true);
    reader.start();
  }

  private static void waitFor(List<ProcessHandle> handles, Duration timeout) {
    long deadline = System.nanoTime() + timeout.toNanos();
    boolean interrupted = Thread.interrupted();
    try {
      while (handles.stream().anyMatch(ProcessHandle::isAlive) && System.nanoTime() < deadline) {
        try {
          Thread.sleep(10);
        } catch (InterruptedException error) {
          interrupted = true;
        }
      }
    } finally {
      if (interrupted) Thread.currentThread().interrupt();
    }
  }
}
