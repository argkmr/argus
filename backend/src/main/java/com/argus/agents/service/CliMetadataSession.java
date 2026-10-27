package com.argus.agents.service;

import com.argus.common.process.ExecutableDiscovery;
import com.argus.common.process.OwnedProcess;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** A bounded, metadata-only stdio exchange. Never authorizes tool calls or starts a model turn. */
final class CliMetadataSession implements AutoCloseable {
  private static final Set<String> CODEX_METHODS =
      Set.of(
          "initialize",
          "model/list",
          "mcpServerStatus/list",
          "app/installed",
          "account/read",
          "account/rateLimits/read");
  private final ObjectMapper json;
  private final ArrayBlockingQueue<JsonNode> messages = new ArrayBlockingQueue<>(512);
  private final AtomicReference<RuntimeException> failure = new AtomicReference<>();
  private final StringBuilder line = new StringBuilder();
  private final OwnedProcess child;
  private final long deadline;
  private int received;
  private int sequence;
  private int unexpectedRequests;
  private int sentBytes;

  CliMetadataSession(
      String executable,
      List<String> arguments,
      Path cwd,
      Map<String, String> environment,
      ObjectMapper json,
      Duration timeout)
      throws IOException {
    checkCancellation();
    this.json = json;
    deadline = System.nanoTime() + timeout.toNanos();
    List<String> command = new ArrayList<>();
    command.add(executable);
    command.addAll(arguments);
    ProcessBuilder builder = new ProcessBuilder(command);
    if (cwd != null) builder.directory(cwd.toFile());
    if (environment != null) {
      builder.environment().clear();
      builder.environment().putAll(environment);
    }
    ExecutableDiscovery.prepareProvider(builder);
    // Protocol output and stderr are never sent to the activity log or returned to the UI.
    child = new OwnedProcess(builder, this::receive, 8192);
  }

  private synchronized void receive(String stream, String chunk) {
    if (!"stdout".equals(stream) || failure.get() != null) return;
    received += chunk.length();
    if (received > 8 * 1024 * 1024) {
      failure.set(new IllegalStateException("CLI metadata response exceeded its size limit"));
      return;
    }
    // The retained prefix was already searched; only newly received characters
    // can introduce a newline. Avoid rescanning a long fragmented response.
    int searchFrom = line.length();
    line.append(chunk);
    int newline;
    while ((newline = line.indexOf("\n", searchFrom)) >= 0) {
      String value = line.substring(0, newline).trim();
      line.delete(0, newline + 1);
      searchFrom = 0;
      try {
        JsonNode message = json.readTree(value);
        if (message != null && message.isObject() && !messages.offer(message)) {
          failure.set(new IllegalStateException("CLI metadata response queue exceeded its limit"));
          return;
        }
      } catch (RuntimeException ignored) {
        // CLIs may write non-protocol startup diagnostics; do not expose their contents.
      }
    }
  }

  JsonNode codex(String method, Map<String, ?> params) {
    if (!CODEX_METHODS.contains(method))
      throw new IllegalArgumentException("Not a metadata method");
    if ("account/read".equals(method)
        && (!params.keySet().equals(Set.of("refreshToken"))
            || !Boolean.FALSE.equals(params.get("refreshToken"))))
      throw new IllegalArgumentException("Account metadata must not request token refresh");
    if ("account/rateLimits/read".equals(method) && !params.isEmpty())
      throw new IllegalArgumentException("Rate-limit metadata does not accept actions");
    int id = ++sequence;
    send(Map.of("id", id, "method", method, "params", params));
    while (true) {
      JsonNode message = next();
      if (message.has("method") && message.has("id")) {
        rejectUnexpected(message.get("id"));
        send(
            Map.of(
                "id",
                message.get("id"),
                "error",
                Map.of(
                    "code",
                    -32601,
                    "message",
                    "Argus metadata discovery does not execute tools or approvals")));
      } else if (message.path("id").asInt(-1) == id) {
        if (message.has("error"))
          throw new IllegalStateException("CLI metadata method unavailable: " + method);
        if (!message.has("result"))
          throw new IllegalStateException("Invalid CLI metadata response");
        return message.get("result");
      }
    }
  }

  void initializeCodex(String clientName) {
    codex("initialize", Map.of("clientInfo", Map.of("name", clientName, "version", "1")));
    send(Map.of("method", "initialized", "params", Map.of()));
  }

  JsonNode claude(String subtype) {
    if (!Set.of("initialize", "mcp_status").contains(subtype))
      throw new IllegalArgumentException("Not a metadata request");
    String id = "argus-metadata-" + (++sequence);
    send(
        Map.of("type", "control_request", "request_id", id, "request", Map.of("subtype", subtype)));
    while (true) {
      JsonNode message = next();
      if ("control_request".equals(message.path("type").asText())) {
        rejectUnexpected(message.path("request_id"));
        send(
            Map.of(
                "type",
                "control_response",
                "response",
                Map.of(
                    "subtype",
                    "error",
                    "request_id",
                    message.path("request_id").asText(),
                    "error",
                    "Metadata discovery does not execute tools or approvals")));
      } else if ("control_response".equals(message.path("type").asText())
          && id.equals(message.path("response").path("request_id").asText())) {
        JsonNode response = message.path("response");
        if (!"success".equals(response.path("subtype").asText()))
          throw new IllegalStateException("CLI metadata request unavailable: " + subtype);
        return response.path("response");
      }
    }
  }

  private JsonNode next() {
    while (System.nanoTime() < deadline) {
      checkCancellation();
      if (failure.get() != null) throw failure.get();
      try {
        JsonNode message =
            messages.poll(
                Math.min(
                    100, Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()))),
                TimeUnit.MILLISECONDS);
        if (message != null) return message;
        if (child.completion().isDone())
          throw new IllegalStateException("CLI metadata process exited before responding");
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new java.util.concurrent.CancellationException("CLI metadata discovery interrupted");
      }
    }
    throw new IllegalStateException("CLI metadata discovery timed out");
  }

  private void send(Map<String, ?> message) {
    checkCancellation();
    String encoded = json.writeValueAsString(message) + "\n";
    int bytes = encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
    // Keep the entire exchange below the minimum pipe capacity on supported
    // macOS/Linux hosts. Even a child that stops reading stdin cannot trap the
    // caller in a blocking pipe write while holding the process-owner monitor.
    if (bytes > 4096 - sentBytes)
      throw new IllegalStateException("CLI metadata request exceeded its size limit");
    sentBytes += bytes;
    try {
      child.write(encoded);
    } catch (IOException error) {
      throw new IllegalStateException("CLI metadata connection closed", error);
    }
  }

  private void rejectUnexpected(JsonNode id) {
    if (++unexpectedRequests > 1)
      throw new IllegalStateException("CLI metadata sent repeated non-metadata requests");
    if (!(id.isString() || id.isNumber()) || id.asText().length() > 128)
      throw new IllegalStateException("CLI metadata sent an invalid request identifier");
  }

  static void checkCancellation() {
    if (Thread.currentThread().isInterrupted())
      throw new java.util.concurrent.CancellationException("CLI metadata discovery interrupted");
  }

  @Override
  public void close() {
    child.close();
  }
}
