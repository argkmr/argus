package com.argus.terminal.service;

import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.terminal.domain.TerminalChunk;
import com.argus.terminal.dto.TerminalResponse;
import com.argus.workspace.domain.Repository;
import com.pty4j.PtyProcess;
import com.pty4j.PtyProcessBuilder;
import com.pty4j.WinSize;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Service;

@Service
public class TerminalService {
  private static final int MAX_CHUNKS = 2000;
  private static final int MAX_OUTPUT_CHARS = 2_000_000;
  private final Map<String, Session> sessions = new ConcurrentHashMap<>();
  private final Set<String> retiredRepositoryIds = new HashSet<>();
  private final String shell;
  private final ProcessStarter processStarter;
  private final Map<String, String> environment;
  private final Duration stopGrace;
  private final Duration forceGrace;
  private boolean shuttingDown;

  public TerminalService() {
    this(
        Files.isExecutable(Path.of("/bin/zsh"))
            ? "/bin/zsh"
            : System.getenv().getOrDefault("SHELL", "/bin/sh"),
        TerminalService::startPty,
        System.getenv(),
        Duration.ofMillis(300),
        Duration.ofMillis(700));
  }

  TerminalService(
      String shell, ProcessStarter processStarter, Duration stopGrace, Duration forceGrace) {
    this(shell, processStarter, System.getenv(), stopGrace, forceGrace);
  }

  TerminalService(
      String shell,
      ProcessStarter processStarter,
      Map<String, String> environment,
      Duration stopGrace,
      Duration forceGrace) {
    this.environment = Map.copyOf(environment);
    this.shell = shell;
    this.processStarter = processStarter;
    this.stopGrace = stopGrace;
    this.forceGrace = forceGrace;
  }

  static Process startPty(ProcessBuilder builder) throws IOException {
    return new PtyProcessBuilder(builder.command().toArray(String[]::new))
        .setDirectory(builder.directory().getPath())
        .setEnvironment(builder.environment())
        .setConsole(false)
        .setRedirectErrorStream(true)
        .setInitialColumns(120)
        .setInitialRows(30)
        .start();
  }

  @FunctionalInterface
  interface ProcessStarter {
    Process start(ProcessBuilder builder) throws IOException;
  }

  public synchronized TerminalResponse start(Repository repository) {
    if (shuttingDown)
      throw new ConflictException("Argus is shutting down; new terminals cannot be started");
    if (retiredRepositoryIds.contains(repository.id()))
      throw new ConflictException(
          "This repository is being removed; its terminal cannot be restarted");
    Session existing = sessions.get(repository.id());
    if (existing != null && existing.process.isAlive()) return snapshot(existing, 0);
    if (existing != null) stop(repository.id());
    ZshIntegration integration = null;
    try {
      ProcessBuilder builder =
          new ProcessBuilder(shell, "-il").directory(new java.io.File(repository.path()));
      builder.environment().clear();
      builder.environment().putAll(environment);
      builder.environment().put("PWD", repository.path());
      builder.environment().put("TERM", "xterm-256color");
      builder.environment().put("ARGUS_REPOSITORY", repository.path());
      builder.environment().put("TERM_PROGRAM", "Argus");
      builder.environment().put("COLORTERM", "truecolor");
      if (Path.of(shell).getFileName().toString().equals("zsh"))
        integration = ZshIntegration.create(builder.environment());
      Process process = processStarter.start(builder);
      Session session = new Session(repository, process, shell, integration);
      sessions.put(repository.id(), session);
      Thread stdout =
          new Thread(
              () -> drain(session, process.getInputStream(), "stdout"),
              "argus-terminal-out-" + repository.id());
      stdout.setDaemon(true);
      stdout.start();
      if (!(process instanceof PtyProcess)) {
        Thread stderr =
            new Thread(
                () -> drain(session, process.getErrorStream(), "stderr"),
                "argus-terminal-err-" + repository.id());
        stderr.setDaemon(true);
        stderr.start();
      }
      if (process instanceof PtyProcess) {
        Thread watcher =
            new Thread(() -> awaitShellExit(session), "argus-terminal-exit-" + repository.id());
        watcher.setDaemon(true);
        watcher.start();
      } else {
        process.onExit().thenRun(() -> shellExited(session, process.exitValue()));
      }
      return snapshot(session, 0);
    } catch (IOException | RuntimeException error) {
      if (integration != null) integration.close();
      throw new IllegalStateException("Could not start interactive terminal", error);
    }
  }

  public synchronized TerminalResponse status(Repository repository, long after) {
    Session session = sessions.get(repository.id());
    return session == null
        ? new TerminalResponse(
            null,
            repository.id(),
            repository.name(),
            repository.path(),
            shell,
            false,
            0,
            List.of(),
            true)
        : snapshot(session, after);
  }

  public TerminalResponse write(String repositoryId, String sessionId, String input) {
    if (input == null || input.length() > 64_000)
      throw new IllegalArgumentException("Terminal input must contain at most 64000 characters");
    Session session;
    synchronized (this) {
      session = requireCurrent(repositoryId, sessionId);
    }
    synchronized (session.inputLock) {
      long after;
      synchronized (this) {
        requireCurrent(repositoryId, sessionId);
        if (!session.running || !session.process.isAlive())
          throw new ConflictException("Terminal is not running");
        after = session.cursor;
      }
      // Never hold the service monitor while writing: a full PTY input buffer
      // must not block the output reader or stop/restart cleanup.
      sendInput(session, input);
      synchronized (this) {
        return snapshot(session, after);
      }
    }
  }

  private static void sendInput(Session session, String input) {
    try {
      session.process.getOutputStream().write(input.getBytes(StandardCharsets.UTF_8));
      session.process.getOutputStream().flush();
    } catch (IOException error) {
      throw new IllegalStateException("Could not write to terminal", error);
    }
  }

  public synchronized TerminalResponse resize(
      String repositoryId, String sessionId, int cols, int rows) {
    Session session = requireCurrent(repositoryId, sessionId);
    if (cols < 2 || cols > 1000 || rows < 1 || rows > 500)
      throw new IllegalArgumentException("Terminal size must be 2–1000 columns and 1–500 rows");
    if (!session.running || !session.process.isAlive())
      throw new ConflictException("Terminal is not running");
    if (session.process instanceof PtyProcess pty) pty.setWinSize(new WinSize(cols, rows));
    return snapshot(session, session.cursor);
  }

  public synchronized TerminalResponse clear(String repositoryId, String sessionId) {
    Session session = requireCurrent(repositoryId, sessionId);
    session.chunks.clear();
    session.outputChars = 0;
    // Clear scrollback, not foreground application input (including passwords).
    return snapshot(session, session.cursor);
  }

  public synchronized TerminalResponse stop(String repositoryId, String sessionId) {
    requireCurrent(repositoryId, sessionId);
    return stop(repositoryId);
  }

  public synchronized TerminalResponse stop(String repositoryId) {
    Session session = sessions.get(repositoryId);
    if (session == null)
      return new TerminalResponse(null, repositoryId, "", "", shell, false, 0, List.of(), true);
    rememberDescendants(session);
    List<ProcessHandle> handles = new ArrayList<>(session.descendants.values());
    // Keep captured handles even if the shell has already exited: those children
    // can no longer be discovered by traversing a dead parent's process tree.
    if (session.handle != null) handles.add(session.handle);
    handles.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroy);
    awaitExit(handles, stopGrace);
    handles.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
    awaitExit(handles, forceGrace);
    if (handles.stream().anyMatch(ProcessHandle::isAlive))
      throw new ConflictException(
          "A terminal process is still running; retry cleanup before removing the repository");
    session.running = false;
    session.descendants.clear();
    refreshCwd(session);
    // Signal only captured ProcessHandles. PtyProcess.destroy() uses a bare PID
    // and could target a reused PID when disposing an already exited session.
    try {
      session.process.getOutputStream().close();
    } catch (IOException ignored) {
    }
    try {
      session.process.getInputStream().close();
    } catch (IOException ignored) {
    }
    try {
      session.process.getErrorStream().close();
    } catch (IOException ignored) {
    }
    if (session.integration != null) session.integration.close();
    return snapshot(session, 0);
  }

  public synchronized void purge(String repositoryId) {
    disconnectRepository(repositoryId);
    sessions.remove(repositoryId);
  }

  public synchronized void disconnectRepository(String repositoryId) {
    // Retire before draining, even if stopping fails or there was no session.
    // Offboarding can then unregister safely without a concurrent start reopening it.
    retiredRepositoryIds.add(repositoryId);
    stop(repositoryId);
  }

  public synchronized void releaseRepository(String repositoryId) {
    retiredRepositoryIds.remove(repositoryId);
  }

  @PreDestroy
  public synchronized void stopAll() {
    shuttingDown = true;
    RuntimeException failure = null;
    for (String id : List.copyOf(sessions.keySet())) {
      try {
        purge(id);
      } catch (RuntimeException error) {
        failure = error;
      }
    }
    if (failure != null) throw failure;
  }

  private static void awaitExit(List<ProcessHandle> handles, Duration grace) {
    long deadline = System.nanoTime() + grace.toNanos();
    while (handles.stream().anyMatch(ProcessHandle::isAlive) && System.nanoTime() < deadline) {
      try {
        TimeUnit.MILLISECONDS.sleep(Math.min(20, Math.max(1, grace.toMillis())));
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        return;
      }
    }
  }

  private static void rememberDescendants(Session session) {
    if (session.process.isAlive() && session.handle != null)
      session.handle.descendants().forEach(handle -> session.descendants.put(handle.pid(), handle));
    session.descendants.values().removeIf(handle -> !handle.isAlive());
  }

  private Session requireCurrent(String id, String sessionId) {
    Session session = sessions.get(id);
    if (session == null) throw new NotFoundException("Start the terminal first");
    if (sessionId == null || !session.id.equals(sessionId))
      throw new ConflictException("Terminal session changed; reconnect before sending input");
    return session;
  }

  private void drain(Session session, InputStream stream, String type) {
    try (InputStreamReader reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
      char[] buffer = new char[4096];
      String pending = "";
      int count;
      while ((count = reader.read(buffer)) != -1) {
        String data = pending + new String(buffer, 0, count);
        pending = "";
        if (!data.isEmpty() && Character.isHighSurrogate(data.charAt(data.length() - 1))) {
          pending = data.substring(data.length() - 1);
          data = data.substring(0, data.length() - 1);
        }
        synchronized (this) {
          if (!data.isEmpty()) append(session, type, data);
        }
      }
    } catch (IOException ignored) {
    } finally {
      session.drained.countDown();
    }
  }

  private void awaitShellExit(Session session) {
    try {
      int code = session.process.waitFor();
      // Publish stopped only after the PTY's last bytes. Otherwise a client
      // correctly ending its polling on running=false can miss final output.
      session.drained.await(2, TimeUnit.SECONDS);
      shellExited(session, code);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    }
  }

  private synchronized void shellExited(Session session, int code) {
    session.running = false;
    refreshCwd(session);
    if (session.integration != null) session.integration.close();
    append(session, "system", "\r\nTerminal stopped with exit code " + code + "\r\n");
  }

  private static void refreshCwd(Session session) {
    if (session.integration != null) session.cwd = session.integration.cwd(session.cwd);
  }

  private void append(Session session, String stream, String data) {
    session.chunks.add(new TerminalChunk(++session.cursor, stream, data));
    session.outputChars += data.length();
    while (session.chunks.size() > MAX_CHUNKS || session.outputChars > MAX_OUTPUT_CHARS)
      session.outputChars -= session.chunks.remove(0).data().length();
  }

  private TerminalResponse snapshot(Session session, long after) {
    rememberDescendants(session);
    refreshCwd(session);
    return new TerminalResponse(
        session.id,
        session.repositoryId,
        session.repositoryName,
        session.cwd,
        session.shell,
        session.running,
        session.cursor,
        session.chunks.stream().filter(chunk -> chunk.cursor() > after).toList(),
        true);
  }

  private static final class Session {
    final String id = UUID.randomUUID().toString();
    final String repositoryId;
    final String repositoryName;
    String cwd;
    final String shell;
    final Process process;
    final ProcessHandle handle;
    final ZshIntegration integration;
    final Object inputLock = new Object();
    final CountDownLatch drained;
    final Map<Long, ProcessHandle> descendants = new ConcurrentHashMap<>();
    boolean running = true;
    long cursor;
    int outputChars;
    final List<TerminalChunk> chunks = new ArrayList<>();

    Session(Repository repository, Process process, String shell, ZshIntegration integration) {
      this.repositoryId = repository.id();
      this.repositoryName = repository.name();
      this.cwd = repository.path();
      this.process = process;
      ProcessHandle processHandle;
      try {
        processHandle = process.toHandle();
      } catch (UnsupportedOperationException error) {
        processHandle = ProcessHandle.of(process.pid()).orElse(null);
      }
      this.handle = processHandle;
      this.integration = integration;
      this.drained = new CountDownLatch(process instanceof PtyProcess ? 1 : 2);
      this.shell = shell;
    }
  }
}
