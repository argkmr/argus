package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.process.OwnedProcess;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiConsumer;
import java.util.regex.Pattern;
import tools.jackson.databind.ObjectMapper;

/** Owns one official js-debug server and its attach-only DAP connection pair. */
final class JavaScriptDebugSession implements DebugSession {
  private static final Pattern LISTENER =
      Pattern.compile("Debug server listening at 127\\.0\\.0\\.1:(\\d+)\\r?\\n");
  private final ObjectMapper json;
  private final BiConsumer<String, Map<String, Object>> events;
  private final Path root;
  private final CompletableFuture<Integer> listening = new CompletableFuture<>();
  private final CompletableFuture<DapDebugSession> attached = new CompletableFuture<>();
  private final Set<String> pendingTargetIds = ConcurrentHashMap.newKeySet();
  private final StringBuilder serverOutput = new StringBuilder();
  private final AtomicBoolean closed = new AtomicBoolean();
  private final CompletableFuture<Void> cleanup = new CompletableFuture<>();
  private final ExecutorService childSetup =
      new ThreadPoolExecutor(
          1,
          1,
          0,
          TimeUnit.SECONDS,
          new ArrayBlockingQueue<>(4),
          task -> {
            Thread thread = new Thread(task, "argus-js-debug-attach");
            thread.setDaemon(true);
            return thread;
          });
  private volatile DapDebugSession parent;
  private volatile DapDebugSession child;
  private OwnedProcess server;
  private int adapterPort;

  JavaScriptDebugSession(
      String node,
      Path entry,
      Path root,
      int targetPort,
      ObjectMapper json,
      BiConsumer<String, Map<String, Object>> events) {
    this.json = json;
    this.events = events;
    this.root = root;
    try {
      var builder =
          new ProcessBuilder(node, entry.toString(), "0", "127.0.0.1").directory(root.toFile());
      builder.environment().remove("NODE_OPTIONS");
      builder.environment().remove("VSCODE_INSPECTOR_OPTIONS");
      server = new OwnedProcess(builder, this::serverOutput, 65536);
      server
          .completion()
          .whenComplete(
              (code, error) -> {
                listening.completeExceptionally(
                    new IllegalStateException("JavaScript debug adapter exited"));
                if (!closed.get()) {
                  events.accept("terminated", Map.of());
                  CompletableFuture.runAsync(this::close);
                }
              });
      adapterPort = listening.get(10, TimeUnit.SECONDS);
      parent =
          new DapDebugSession(
              adapterPort,
              DapDebugSession.attachArguments(root, "node", targetPort),
              json,
              (event, body) -> {
                if (!event.equals("initialized")) events.accept(event, body);
              },
              this::startDebugging);
      attached.get(8, TimeUnit.SECONDS);
    } catch (Exception error) {
      close();
      String detail =
          serverOutput
              .toString()
              .lines()
              .filter(line -> line.length() < 512)
              .collect(java.util.stream.Collectors.joining(" "));
      throw new IllegalStateException(
          "Could not attach JavaScript debugger: "
              + error.getClass().getSimpleName()
              + ": "
              + error.getMessage()
              + ". "
              + detail,
          error);
    }
  }

  private synchronized void serverOutput(String stream, String output) {
    if (closed.get()) return;
    serverOutput.append(output);
    if (serverOutput.length() > 8192) serverOutput.delete(0, serverOutput.length() - 8192);
    var match = LISTENER.matcher(serverOutput);
    if (match.find()) {
      int port = Integer.parseInt(match.group(1));
      if (port > 1023 && port <= 65535) listening.complete(port);
    }
    if (stream.equals("stderr"))
      events.accept("output", object("category", "stderr", "output", output));
  }

  private CompletableFuture<Map<String, Object>> startDebugging(Map<String, Object> request) {
    var configuration = map(request.get("configuration"));
    String target = text(configuration, "__pendingTargetId");
    if (closed.get()
        || !"attach".equals(request.get("request"))
        || target.isBlank()
        || target.length() > 512
        || !Set.of("pwa-node", "node").contains(text(configuration, "type"))
        || !pendingTargetIds.isEmpty()
        || !pendingTargetIds.add(target))
      return CompletableFuture.failedFuture(
          new IllegalArgumentException(
              "Only the selected local Node target may attach; nested launches and workers are unavailable"));
    return CompletableFuture.supplyAsync(
            () -> {
              var arguments =
                  object(
                      "type",
                      configuration.get("type"),
                      "name",
                      text(configuration, "name"),
                      "__pendingTargetId",
                      target);
              arguments.put("request", "attach");
              arguments.put("cwd", root.toString());
              var connection = new DapDebugSession(adapterPort, arguments, json, events, null);
              if (closed.get()) {
                connection.close();
                throw new IllegalStateException("JavaScript debugger is closing");
              }
              child = connection;
              attached.complete(connection);
              return Map.<String, Object>of();
            },
            childSetup)
        .whenComplete(
            (value, error) -> {
              if (error != null) attached.completeExceptionally(error);
            });
  }

  Map<String, Object> capabilities() {
    return child == null ? Map.of() : child.capabilities();
  }

  @Override
  public Map<String, Object> command(String command, Map<String, Object> args) {
    if (!alive()) throw new IllegalStateException("The JavaScript debug session has ended");
    return child.command(command, args);
  }

  @Override
  public boolean alive() {
    return !closed.get() && server != null && server.isAlive() && child != null && child.alive();
  }

  @Override
  public void close() {
    if (!closed.compareAndSet(false, true)) {
      cleanup.join();
      return;
    }
    try {
      drain();
      cleanup.complete(null);
    } catch (RuntimeException error) {
      cleanup.completeExceptionally(error);
      throw error;
    }
  }

  private void drain() {
    RuntimeException failure = null;
    childSetup.shutdownNow();
    try {
      if (child != null) child.close();
    } catch (RuntimeException error) {
      failure = error;
    }
    try {
      if (parent != null) parent.close();
    } catch (RuntimeException error) {
      if (failure == null) failure = error;
      else failure.addSuppressed(error);
    }
    try {
      if (server != null) server.stop(Duration.ofMillis(500), Duration.ofMillis(500));
    } catch (RuntimeException error) {
      if (failure == null) failure = error;
      else failure.addSuppressed(error);
    }
    try {
      if (!childSetup.awaitTermination(3000, TimeUnit.MILLISECONDS))
        throw new IllegalStateException("JavaScript debug attachment worker did not stop");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    }
    // A connection may have been published between the closed check and assignment in its worker.
    try {
      if (child != null) child.close();
    } catch (RuntimeException error) {
      if (failure == null) failure = error;
      else failure.addSuppressed(error);
    }
    if (failure != null) throw failure;
  }
}
