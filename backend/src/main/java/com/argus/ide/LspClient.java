package com.argus.ide;

import com.argus.common.process.OwnedProcess;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** LSP 3.17 Content-Length JSON-RPC, with bounded frames, queues, and owned process lifetime. */
final class LspClient implements AutoCloseable {
  private static final int MAX_FRAME = 8 * 1024 * 1024;
  private final ObjectMapper json;
  private final Map<Long, CompletableFuture<JsonNode>> requests = new ConcurrentHashMap<>();
  private final AtomicLong sequence = new AtomicLong();
  private final CompletableFuture<Void> javaServiceReady = new CompletableFuture<>();
  private final StringBuilder incoming = new StringBuilder();
  private int expectedBytes = -1;
  private int scannedCharacters;
  private int scannedBytes;
  private final CompletableFuture<OwnedProcess> process = new CompletableFuture<>();
  private final ThreadPoolExecutor writer =
      new ThreadPoolExecutor(
          1,
          1,
          0,
          TimeUnit.SECONDS,
          new ArrayBlockingQueue<>(32),
          task -> {
            var thread = new Thread(task, "argus-ide-lsp-writer");
            thread.setDaemon(true);
            return thread;
          });
  private volatile boolean closed;
  private volatile String failure = "";
  private volatile String serviceStatus = "Starting language server";
  private volatile Map<String, Object> settings = Map.of();

  LspClient(List<String> command, Path root, ObjectMapper json) {
    this.json = json;
    try {
      var builder = new ProcessBuilder(command).directory(root.toFile());
      // Do not inherit Node preload flags into the language worker.
      builder.environment().remove("NODE_OPTIONS");
      var owned = new OwnedProcess(builder, this::receive, 64 * 1024);
      process.complete(owned);
      owned
          .completion()
          .whenComplete(
              (code, error) -> {
                if (!closed) fail(exitFailure(owned, code, error));
              });
    } catch (IOException | RuntimeException error) {
      process.completeExceptionally(error);
      writer.shutdownNow();
      throw new IllegalStateException(
          "Could not start language server: " + error.getMessage(), error);
    }
  }

  void settings(Map<String, Object> value) {
    settings = value;
  }

  boolean alive() {
    var owned = process.getNow(null);
    return !closed && owned != null && owned.isAlive() && failure.isBlank();
  }

  String failure() {
    return failure;
  }

  private static String exitFailure(OwnedProcess owned, Integer code, Throwable error) {
    String detail = owned.stderr().replaceAll("\\x1B\\[[0-9;]*[A-Za-z]", "").trim();
    if (detail.length() > 1800) detail = detail.substring(detail.length() - 1800);
    return "Language server stopped"
        + (code == null ? "" : " (exit " + code + ")")
        + (detail.isBlank()
            ? error == null
                ? ". Check the language-server configuration and its local log."
                : ": " + error.getMessage()
            : ": " + detail);
  }

  String serviceStatus() {
    return serviceStatus;
  }

  void awaitJavaServiceReady(Duration timeout) {
    try {
      javaServiceReady.get(Math.max(1, timeout.toMillis()), TimeUnit.MILLISECONDS);
    } catch (TimeoutException error) {
      String reason = "Java language server startup timed out: " + serviceStatus;
      fail(reason);
      close();
      throw new IllegalStateException(reason + "; restart its session", error);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      close();
      throw new IllegalStateException("Java language server startup interrupted", error);
    } catch (ExecutionException error) {
      throw new IllegalStateException(error.getCause().getMessage(), error.getCause());
    }
  }

  JsonNode request(String method, Object params, Duration timeout) {
    if (closed) throw new IllegalStateException("Language server is stopped");
    long id = sequence.incrementAndGet();
    var result = new CompletableFuture<JsonNode>();
    if (requests.size() >= 32) throw new IllegalStateException("Language server is busy");
    requests.put(id, result);
    try {
      send(message(id, method, params));
      return result.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
    } catch (TimeoutException error) {
      fail("Language server request timed out");
      close();
      throw new IllegalStateException(
          "Language server request timed out; restart its session", error);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      close();
      throw new IllegalStateException("Language server request interrupted", error);
    } catch (ExecutionException error) {
      throw new IllegalStateException(error.getCause().getMessage(), error.getCause());
    } finally {
      requests.remove(id);
    }
  }

  void notify(String method, Object params) {
    send(message(null, method, params));
  }

  private Map<String, Object> message(Long id, String method, Object params) {
    var value = new LinkedHashMap<String, Object>();
    value.put("jsonrpc", "2.0");
    if (id != null) value.put("id", id);
    value.put("method", method);
    if (params != null) value.put("params", params);
    return value;
  }

  private void send(Object value) {
    if (closed) throw new IllegalStateException("Language server is stopped");
    if (!failure.isBlank()) throw new IllegalStateException(failure);
    byte[] body = json.writeValueAsBytes(value);
    if (body.length > MAX_FRAME)
      throw new IllegalArgumentException("Language-server message is too large");
    try {
      writer.execute(
          () -> {
            try {
              var output = process.join().process().getOutputStream();
              output.write(
                  ("Content-Length: " + body.length + "\r\n\r\n")
                      .getBytes(StandardCharsets.US_ASCII));
              output.write(body);
              output.flush();
            } catch (IOException | RuntimeException error) {
              fail("Could not write to language server");
            }
          });
    } catch (java.util.concurrent.RejectedExecutionException error) {
      fail("Language server write queue is full");
      throw new IllegalStateException("Language server is busy or stopped", error);
    }
  }

  private synchronized void receive(String stream, String text) {
    if (!"stdout".equals(stream) || closed) return;
    incoming.append(text);
    try {
      while (incoming.length() > 0) {
        if (expectedBytes < 0) {
          int boundary = incoming.indexOf("\r\n\r\n");
          if (boundary < 0) {
            if (incoming.length() > 8192) throw new IllegalStateException("Invalid LSP header");
            return;
          }
          if (boundary > 8192) throw new IllegalStateException("LSP header exceeds limit");
          for (String header : incoming.substring(0, boundary).split("\r\n")) {
            if (header.regionMatches(true, 0, "Content-Length:", 0, 15)) {
              if (expectedBytes >= 0)
                throw new IllegalStateException("Duplicate LSP length header");
              expectedBytes = Integer.parseInt(header.substring(15).trim());
            }
          }
          if (expectedBytes < 0 || expectedBytes > MAX_FRAME)
            throw new IllegalStateException("LSP frame exceeds limit");
          incoming.delete(0, boundary + 4);
        }
        while (scannedCharacters < incoming.length() && scannedBytes < expectedBytes) {
          char c = incoming.charAt(scannedCharacters);
          if (Character.isHighSurrogate(c)) {
            if (scannedCharacters + 1 >= incoming.length()) return;
            if (!Character.isLowSurrogate(incoming.charAt(scannedCharacters + 1)))
              throw new IllegalStateException("Invalid LSP UTF-8");
            scannedBytes += 4;
            scannedCharacters += 2;
          } else {
            scannedBytes += c <= 0x7f ? 1 : c <= 0x7ff ? 2 : 3;
            scannedCharacters++;
          }
        }
        if (scannedBytes < expectedBytes) return;
        if (scannedBytes != expectedBytes)
          throw new IllegalStateException("Invalid LSP content length");
        JsonNode message = json.readTree(incoming.substring(0, scannedCharacters));
        incoming.delete(0, scannedCharacters);
        expectedBytes = -1;
        scannedBytes = 0;
        scannedCharacters = 0;
        handle(message);
      }
    } catch (RuntimeException error) {
      incoming.setLength(0);
      fail("Invalid language server response: " + error.getMessage());
      // Reaping cannot run on OwnedProcess's own stream reader.
      CompletableFuture.runAsync(this::close);
    }
  }

  private void handle(JsonNode message) {
    if ("language/status".equals(message.path("method").asText()) && !message.has("id")) {
      JsonNode params = message.path("params");
      String type = params.path("type").asText();
      String detail = params.path("message").asText(type);
      serviceStatus = detail.substring(0, Math.min(512, detail.length()));
      if ("ServiceReady".equals(type)) javaServiceReady.complete(null);
      else if ("Error".equals(type))
        javaServiceReady.completeExceptionally(
            new IllegalStateException(
                "Java language server initialization failed: " + serviceStatus));
    } else if (message.has("method") && message.has("id")) {
      var response = new LinkedHashMap<String, Object>();
      response.put("jsonrpc", "2.0");
      response.put("id", message.get("id"));
      switch (message.path("method").asText()) {
        case "workspace/configuration" -> {
          var values = new ArrayList<Object>();
          for (JsonNode item : message.path("params").path("items")) {
            Object current = settings;
            for (String segment : item.path("section").asText("").split("\\.")) {
              if (segment.isEmpty()) continue;
              current = current instanceof Map<?, ?> map ? map.get(segment) : null;
            }
            values.add(current);
          }
          response.put("result", values);
        }
        case "workspace/applyEdit" ->
            response.put(
                "result",
                Map.of(
                    "applied",
                    false,
                    "failureReason",
                    "Server edits require an explicit editor action"));
        case "window/workDoneProgress/create",
                "client/registerCapability",
                "client/unregisterCapability" ->
            response.put("result", null);
        case "window/showMessageRequest" -> response.put("result", null);
        default ->
            response.put(
                "error", Map.of("code", -32601, "message", "Client method is not supported"));
      }
      send(response);
    } else if (message.has("id") && message.get("id").isNumber()) {
      var pending = requests.get(message.get("id").asLong());
      if (pending == null) return;
      if (message.has("error"))
        pending.completeExceptionally(
            new IllegalStateException(
                message.path("error").path("message").asText("Language server error")));
      else pending.complete(message.path("result"));
    }
  }

  private void fail(String reason) {
    if (failure.isBlank()) failure = reason;
    String recorded = failure;
    javaServiceReady.completeExceptionally(new IllegalStateException(recorded));
    requests
        .values()
        .forEach(request -> request.completeExceptionally(new IllegalStateException(recorded)));
  }

  void shutdown() {
    if (alive()) {
      try {
        request("shutdown", null, Duration.ofSeconds(1));
        notify("exit", null);
      } catch (RuntimeException ignored) {
      }
    }
    close();
  }

  @Override
  public synchronized void close() {
    if (closed) return;
    closed = true;
    fail("Language server is stopped");
    var owned = process.getNow(null);
    try {
      if (owned != null) owned.stop(Duration.ofMillis(300), Duration.ofMillis(700));
    } finally {
      writer.shutdownNow();
      try {
        if (!writer.awaitTermination(2, TimeUnit.SECONDS))
          throw new IllegalStateException("Language server writer did not stop");
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
      }
    }
  }
}
