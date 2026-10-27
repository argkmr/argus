package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.process.OwnedProcess;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;
import java.util.function.Function;
import tools.jackson.databind.ObjectMapper;

/** Bounded DAP stdio client; reverse requests never launch commands or open remote connections. */
final class DapDebugSession implements DebugSession {
  static final int MAX_MESSAGE = 1024 * 1024;
  private final ObjectMapper json;
  private final BiConsumer<String, Map<String, Object>> events;
  private final Map<Integer, CompletableFuture<Map<String, Object>>> pending =
      new ConcurrentHashMap<>();
  private final AtomicInteger ids = new AtomicInteger(1);
  private final AtomicBoolean failing = new AtomicBoolean();
  private final CompletableFuture<Void> initialized = new CompletableFuture<>();
  private final StringBuilder buffer = new StringBuilder();
  private final ThreadPoolExecutor writer =
      new ThreadPoolExecutor(
          1,
          1,
          0,
          TimeUnit.SECONDS,
          new ArrayBlockingQueue<>(32),
          task -> {
            Thread thread = new Thread(task, "argus-dap-writer");
            thread.setDaemon(true);
            return thread;
          });
  private OwnedProcess process;
  private Socket socket;
  private OutputStream outputStream;
  private Thread socketReader;
  private Function<Map<String, Object>, CompletableFuture<Map<String, Object>>> reverse;
  private volatile boolean closed;
  private volatile String failure;
  private int contentLength = -1;
  private Map<String, Object> capabilities = Map.of();

  DapDebugSession(
      List<String> command,
      Path root,
      String adapterId,
      String runtime,
      int port,
      ObjectMapper json,
      BiConsumer<String, Map<String, Object>> events) {
    this.json = json;
    this.events = events;
    try {
      process =
          new OwnedProcess(
              new ProcessBuilder(command).directory(root.toFile()), this::output, MAX_MESSAGE);
      outputStream = process.process().getOutputStream();
      process.completion().whenComplete((exit, error) -> fail("Debug adapter exited"));
      initialize(adapterId, attachArguments(root, runtime, port));
    } catch (Exception error) {
      abort();
      throw new IllegalStateException(
          "Could not initialize debug adapter: " + error.getMessage(), error);
    }
  }

  DapDebugSession(
      int adapterPort,
      Map<String, Object> attachArguments,
      ObjectMapper json,
      BiConsumer<String, Map<String, Object>> events,
      Function<Map<String, Object>, CompletableFuture<Map<String, Object>>> reverse) {
    this.json = json;
    this.events = events;
    this.reverse = reverse;
    try {
      socket = new Socket();
      socket.connect(new InetSocketAddress("127.0.0.1", adapterPort), 3000);
      socket.setTcpNoDelay(true);
      outputStream = socket.getOutputStream();
      socketReader =
          new Thread(
              () -> {
                try (var input =
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8)) {
                  char[] chunk = new char[4096];
                  int length;
                  while ((length = input.read(chunk)) != -1)
                    output("stdout", new String(chunk, 0, length));
                  if (!closed) fail("Debug adapter connection closed");
                } catch (Exception error) {
                  if (!closed) fail("Debug adapter connection failed: " + error.getMessage());
                }
              },
              "argus-dap-socket-reader");
      socketReader.setDaemon(true);
      socketReader.start();
      initialize("pwa-node", attachArguments);
    } catch (Exception error) {
      abort();
      throw new IllegalStateException(
          "Could not initialize JavaScript debugger: " + error.getMessage(), error);
    }
  }

  private void initialize(String adapterId, Map<String, Object> attach) throws Exception {
    capabilities =
        command(
            "initialize",
            object(
                "clientID",
                "argus",
                "clientName",
                "Argus",
                "adapterID",
                adapterId,
                "pathFormat",
                "path",
                "linesStartAt1",
                true,
                "columnsStartAt1",
                true,
                "supportsRunInTerminalRequest",
                false,
                "supportsStartDebuggingRequest",
                reverse != null,
                "supportsVariablePaging",
                true));
    var attaching = request("attach", attach);
    // DAP permits the attach response only after configurationDone: do not await it first.
    initialized.get(8, TimeUnit.SECONDS);
    if (Boolean.TRUE.equals(capabilities.get("supportsConfigurationDoneRequest")))
      command("configurationDone", Map.of());
    await(attaching);
  }

  static Map<String, Object> attachArguments(Path root, String runtime, int port) {
    var attach =
        object(
            "hostName",
            "127.0.0.1",
            "address",
            "127.0.0.1",
            "host",
            "127.0.0.1",
            "port",
            port,
            "request",
            "attach",
            "name",
            "Argus local service",
            "cwd",
            root.toString());
    if (runtime.equals("node")) {
      attach.put("type", "pwa-node");
      attach.put("localRoot", root.toString());
      attach.put("restart", false);
      attach.put("autoAttachChildProcesses", false);
      attach.put("sourceMaps", true);
    }
    return attach;
  }

  Map<String, Object> capabilities() {
    return capabilities;
  }

  @Override
  public Map<String, Object> command(String command, Map<String, Object> arguments) {
    return await(request(command, arguments));
  }

  private CompletableFuture<Map<String, Object>> request(
      String command, Map<String, Object> arguments) {
    if (closed || failure != null)
      throw new IllegalStateException(failure == null ? "Debug adapter is closed" : failure);
    if (pending.size() >= 32) throw new IllegalStateException("Too many pending debugger requests");
    int id = ids.getAndIncrement();
    var response = new CompletableFuture<Map<String, Object>>();
    pending.put(id, response);
    response.whenComplete((value, error) -> pending.remove(id));
    try {
      send(object("seq", id, "type", "request", "command", command, "arguments", arguments));
    } catch (RuntimeException error) {
      response.completeExceptionally(error);
      throw error;
    }
    return response;
  }

  private Map<String, Object> await(CompletableFuture<Map<String, Object>> response) {
    try {
      return response.get(8, TimeUnit.SECONDS);
    } catch (InterruptedException error) {
      abort();
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Debugger request interrupted", error);
    } catch (TimeoutException error) {
      abort();
      throw new IllegalStateException("Debug adapter request timed out", error);
    } catch (ExecutionException error) {
      throw new IllegalStateException(error.getCause().getMessage(), error.getCause());
    }
  }

  private void send(Map<String, Object> message) {
    byte[] bytes = json.writeValueAsBytes(message);
    if (bytes.length > MAX_MESSAGE)
      throw new IllegalArgumentException("Debugger message exceeds 1 MB");
    try {
      writer.execute(
          () -> {
            try {
              var stream = outputStream;
              stream.write(
                  ("Content-Length: " + bytes.length + "\r\n\r\n")
                      .getBytes(StandardCharsets.US_ASCII));
              stream.write(bytes);
              stream.flush();
            } catch (Exception error) {
              fail("Could not write to debug adapter");
            }
          });
    } catch (RejectedExecutionException error) {
      fail("Debug adapter write queue is full");
    }
  }

  private synchronized void output(String stream, String value) {
    if (closed || failure != null) return;
    if (stream.equals("stderr")) {
      events.accept(
          "output",
          object(
              "category",
              "stderr",
              "output",
              value.length() > 8000 ? value.substring(0, 8000) : value));
      return;
    }
    try {
      buffer.append(value);
      if (buffer.length() > MAX_MESSAGE + 8192)
        throw new IllegalArgumentException("Debug adapter message exceeds 1 MB");
      while (true) {
        if (contentLength < 0) {
          int end = buffer.indexOf("\r\n\r\n");
          if (end < 0) {
            if (buffer.length() > 8192) throw new IllegalArgumentException("Invalid DAP header");
            return;
          }
          if (end > 8192) throw new IllegalArgumentException("Invalid DAP header");
          for (String header : buffer.substring(0, end).split("\r\n"))
            if (header.regionMatches(true, 0, "Content-Length:", 0, 15)) {
              if (contentLength >= 0)
                throw new IllegalArgumentException("Duplicate DAP Content-Length");
              contentLength = Integer.parseInt(header.substring(15).trim());
            }
          if (contentLength <= 0 || contentLength > MAX_MESSAGE)
            throw new IllegalArgumentException("Invalid DAP Content-Length");
          buffer.delete(0, end + 4);
        }
        int chars = charactersForBytes(buffer, contentLength);
        if (chars < 0) return;
        Map<String, Object> message = map(json.readValue(buffer.substring(0, chars), Map.class));
        buffer.delete(0, chars);
        contentLength = -1;
        receive(message);
      }
    } catch (RuntimeException error) {
      fail("Invalid debug adapter protocol: " + error.getMessage());
    }
  }

  static int charactersForBytes(CharSequence text, int expected) {
    int bytes = 0;
    for (int index = 0; index < text.length(); index++) {
      char character = text.charAt(index);
      if (Character.isHighSurrogate(character)) {
        if (index + 1 >= text.length()) return -1;
        if (!Character.isLowSurrogate(text.charAt(++index)))
          throw new IllegalArgumentException("Invalid UTF-8 body");
        bytes += 4;
      } else bytes += character <= 0x7f ? 1 : character <= 0x7ff ? 2 : 3;
      if (bytes == expected) return index + 1;
      if (bytes > expected)
        throw new IllegalArgumentException("DAP body ends within a UTF-8 character");
    }
    return -1;
  }

  private void receive(Map<String, Object> message) {
    switch (text(message, "type")) {
      case "response" -> {
        var response = pending.get((int) number(message.get("request_seq")));
        if (response != null) {
          if (Boolean.TRUE.equals(message.get("success")))
            response.complete(map(message.get("body")));
          else
            response.completeExceptionally(
                new IllegalStateException(
                    text(message, "message").isBlank()
                        ? "Debug adapter rejected request"
                        : text(message, "message")));
        }
      }
      case "event" -> {
        String name = text(message, "event");
        if (name.equals("initialized")) initialized.complete(null);
        events.accept(name, map(message.get("body")));
      }
      case "request" -> {
        if (reverse != null && "startDebugging".equals(message.get("command"))) {
          reverse
              .apply(map(message.get("arguments")))
              .whenComplete(
                  (body, error) ->
                      reverseResponse(
                          message,
                          error == null,
                          error == null ? body : Map.of(),
                          error == null ? "" : error.getMessage()));
        } else
          reverseResponse(
              message, false, Map.of(), "Argus does not allow debug adapters to launch processes");
      }
      default -> throw new IllegalArgumentException("Unknown DAP message type");
    }
  }

  private void reverseResponse(
      Map<String, Object> request, boolean success, Map<String, Object> body, String message) {
    send(
        object(
            "seq",
            ids.getAndIncrement(),
            "type",
            "response",
            "request_seq",
            request.get("seq"),
            "command",
            request.get("command"),
            "success",
            success,
            "message",
            message,
            "body",
            body));
  }

  private void fail(String reason) {
    if (closed || !failing.compareAndSet(false, true)) return;
    failure = reason;
    var error = new IllegalStateException(reason);
    pending.values().forEach(response -> response.completeExceptionally(error));
    initialized.completeExceptionally(error);
    events.accept("output", object("category", "stderr", "output", reason));
    events.accept("terminated", Map.of());
    // Run off the output/writer threads so cleanup can join the bounded writer.
    CompletableFuture.runAsync(this::abort);
  }

  @Override
  public boolean alive() {
    return !closed
        && failure == null
        && (process != null ? process.isAlive() : socket != null && !socket.isClosed());
  }

  @Override
  public void close() {
    try {
      if (alive()) {
        var response =
            request(
                "disconnect",
                object("restart", false, "terminateDebuggee", false, "suspendDebuggee", false));
        try {
          response.get(1500, TimeUnit.MILLISECONDS);
        } catch (InterruptedException error) {
          Thread.currentThread().interrupt();
        } catch (ExecutionException | TimeoutException ignored) {
        }
      }
    } finally {
      abort();
    }
  }

  private void abort() {
    closed = true;
    pending
        .values()
        .forEach(
            response ->
                response.completeExceptionally(new IllegalStateException("Debug adapter closed")));
    writer.shutdownNow();
    if (socket != null)
      try {
        socket.close();
      } catch (java.io.IOException ignored) {
      }
    if (process != null) process.stop(Duration.ofMillis(500), Duration.ofMillis(500));
    try {
      if (!writer.awaitTermination(1500, TimeUnit.MILLISECONDS))
        throw new IllegalStateException("Debug adapter writer did not stop");
      if (socketReader != null && socketReader != Thread.currentThread()) {
        socketReader.join(1500);
        if (socketReader.isAlive())
          throw new IllegalStateException("Debug adapter reader did not stop");
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    }
  }
}
