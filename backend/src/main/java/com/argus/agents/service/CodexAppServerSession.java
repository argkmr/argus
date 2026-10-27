package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import com.argus.common.process.OwnedProcess;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import tools.jackson.databind.ObjectMapper;

/**
 * One owned stdio connection and one active native turn. No shell, listener, or external daemon.
 */
final class CodexAppServerSession implements AutoCloseable {
  private static final int MAX_FRAME = 2_000_000;
  private final ObjectMapper mapper;
  private final Consumer<Map<String, Object>> notifications;
  private final BiConsumer<String, String> diagnostics;
  private final ConcurrentMap<Integer, Pending> pending = new ConcurrentHashMap<>();
  private final AtomicInteger sequence = new AtomicInteger();
  private final StringBuilder frame = new StringBuilder();
  private final CompletableFuture<Integer> turnCompletion = new CompletableFuture<>();
  private final Object steerLock = new Object();
  private final ExecutorService writer =
      new ThreadPoolExecutor(
          1,
          1,
          0,
          TimeUnit.MILLISECONDS,
          new ArrayBlockingQueue<>(32),
          task -> {
            var thread = new Thread(task, "argus-codex-protocol-writer");
            thread.setDaemon(true);
            return thread;
          });
  private final OwnedProcess child;
  private final Duration timeout;
  private volatile String threadId = "", turnId = "";
  private volatile boolean active,
      initialized,
      closed,
      turnSubmitted,
      steerUnsupported,
      steerUncertain;

  static final class RpcFailure extends IllegalStateException {
    final boolean outcomeUnknown;
    final Integer code;

    RpcFailure(String message, boolean unknown, Integer code) {
      super(message);
      outcomeUnknown = unknown;
      this.code = code;
    }
  }

  private static final class Pending {
    final CompletableFuture<Map<String, Object>> result = new CompletableFuture<>();
    private boolean writing;

    synchronized boolean beginWrite() {
      if (result.isDone()) return false;
      writing = true;
      return true;
    }

    synchronized boolean fail(String message, Integer code) {
      result.completeExceptionally(new RpcFailure(message, writing, code));
      return writing;
    }

    synchronized boolean wasWritten() {
      return writing;
    }
  }

  CodexAppServerSession(
      ProcessBuilder builder,
      ObjectMapper mapper,
      Consumer<Map<String, Object>> notifications,
      BiConsumer<String, String> diagnostics,
      Duration timeout)
      throws IOException {
    this.mapper = mapper;
    this.notifications = notifications;
    this.diagnostics = diagnostics;
    this.timeout = timeout;
    child = new OwnedProcess(builder, this::receive, 32_768);
    child
        .completion()
        .whenComplete(
            (code, error) -> {
              active = false;
              pending
                  .values()
                  .forEach(
                      request ->
                          request.fail(
                              "Codex native connection closed before confirming delivery", null));
              if (!turnCompletion.isDone())
                turnCompletion.completeExceptionally(
                    new IllegalStateException(
                        "Codex native connection closed before the turn completed", error));
            });
  }

  OwnedProcess process() {
    return child;
  }

  CompletableFuture<Integer> completion() {
    return turnCompletion;
  }

  String threadId() {
    return threadId;
  }

  String turnId() {
    return turnId;
  }

  boolean turnSubmitted() {
    return turnSubmitted;
  }

  boolean available() {
    return initialized
        && active
        && !closed
        && !steerUnsupported
        && !steerUncertain
        && child.isAlive();
  }

  boolean supported() {
    return initialized && !steerUnsupported;
  }

  String unavailableReason() {
    if (steerUncertain)
      return "A previous steering delivery was not confirmed; check this chat before sending more";
    if (steerUnsupported) return "This Codex version does not support live steering";
    return "The native turn is not currently running";
  }

  void initialize() {
    request(
        "initialize",
        fields("clientInfo", fields("name", "argus", "title", "Argus", "version", "1")));
    sendNotification("initialized", Map.of());
    initialized = true;
  }

  String openThread(Map<String, Object> params, String resume) {
    var arguments = new LinkedHashMap<>(params);
    if (!resume.isBlank()) arguments.put("threadId", resume);
    var reply = request(resume.isBlank() ? "thread/start" : "thread/resume", arguments);
    String id = text(obj(reply.get("thread")).get("id"));
    if (id.isBlank()) throw new RpcFailure("Codex did not return a native thread id", false, null);
    threadId = id;
    return id;
  }

  String startTurn(Map<String, Object> params, String prompt) {
    var arguments = new LinkedHashMap<>(params);
    arguments.put("threadId", threadId);
    arguments.put("input", textInput(prompt));
    // After this boundary, no retry/fallback may replay the model input.
    turnSubmitted = true;
    var reply = request("turn/start", arguments);
    String accepted = text(obj(reply.get("turn")).get("id"));
    if (accepted.isBlank())
      throw new RpcFailure("Codex did not confirm the native turn id", true, null);
    turnId = accepted;
    active = !turnCompletion.isDone();
    return accepted;
  }

  Map<String, Object> steer(String expectedTurnId, String prompt) {
    synchronized (steerLock) {
      if (!available())
        throw new SteerDeliveryException(
            "This native Codex turn is not available for steering", false);
      String expected =
          expectedTurnId == null || expectedTurnId.isBlank() ? turnId : expectedTurnId;
      if (!expected.equals(turnId))
        throw new SteerDeliveryException("The active turn changed; refresh before steering", false);
      if (prompt == null || prompt.isBlank())
        throw new SteerDeliveryException("Enter a steering prompt", false);
      try {
        var result =
            request(
                "turn/steer",
                fields(
                    "threadId", threadId, "expectedTurnId", expected, "input", textInput(prompt)));
        if (!expected.equals(text(result.get("turnId")))) {
          steerUncertain = true;
          throw new SteerDeliveryException(
              "Codex returned an unexpected turn id; check this chat before retrying", true);
        }
        return fields(
            "accepted", true, "turnId", expected, "threadId", threadId, "acceptedAt", now());
      } catch (RpcFailure failure) {
        if (Objects.equals(failure.code, -32601)) steerUnsupported = true;
        if (failure.outcomeUnknown) steerUncertain = true;
        throw new SteerDeliveryException(failure.getMessage(), failure.outcomeUnknown);
      }
    }
  }

  static List<Map<String, Object>> textInput(String prompt) {
    return List.of(fields("type", "text", "text", prompt, "text_elements", List.of()));
  }

  private Map<String, Object> request(String method, Map<String, ?> params) {
    if (closed) throw new RpcFailure("Codex native connection is closed", false, null);
    if (pending.size() >= 32)
      throw new RpcFailure("Too many pending Codex native requests", false, null);
    int id = sequence.incrementAndGet();
    var request = new Pending();
    pending.put(id, request);
    Future<?> write;
    try {
      String encoded = encode(fields("id", id, "method", method, "params", params));
      write =
          writer.submit(
              () -> {
                if (!request.beginWrite()) return;
                try {
                  // Do not hold OwnedProcess's lifecycle monitor during a possibly blocked pipe
                  // write.
                  child.process().getOutputStream().write(encoded.getBytes(StandardCharsets.UTF_8));
                  child.process().getOutputStream().flush();
                } catch (IOException error) {
                  request.fail(
                      "Codex could not confirm delivery; check this chat before retrying", null);
                }
              });
    } catch (RuntimeException error) {
      pending.remove(id);
      throw error instanceof RpcFailure rpc
          ? rpc
          : new RpcFailure("Codex native request could not be queued", false, null);
    }
    try {
      return request.result.get(Math.max(1, timeout.toMillis()), TimeUnit.MILLISECONDS);
    } catch (TimeoutException error) {
      boolean written =
          request.fail(
              "Codex did not confirm delivery in time; check this chat before retrying", null);
      write.cancel(false);
      throw new RpcFailure(
          "Codex did not confirm delivery in time; check this chat before retrying", written, null);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      boolean written = request.fail("Codex delivery confirmation was interrupted", null);
      write.cancel(false);
      throw new RpcFailure("Codex delivery confirmation was interrupted", written, null);
    } catch (ExecutionException error) {
      if (error.getCause() instanceof RpcFailure rpc) throw rpc;
      throw new RpcFailure("Codex delivery could not be confirmed", request.wasWritten(), null);
    } finally {
      pending.remove(id);
    }
  }

  private String encode(Map<String, ?> message) {
    String encoded = mapper.writeValueAsString(message) + "\n";
    if (encoded.length() > MAX_FRAME)
      throw new RpcFailure("Codex native request exceeded its size limit", false, null);
    return encoded;
  }

  private void sendNotification(String method, Map<String, ?> params) {
    sendUncorrelated(fields("method", method, "params", params));
  }

  private void sendUncorrelated(Map<String, ?> message) {
    String encoded = encode(message);
    writer.execute(
        () -> {
          try {
            child.process().getOutputStream().write(encoded.getBytes(StandardCharsets.UTF_8));
            child.process().getOutputStream().flush();
          } catch (IOException error) {
            failConnection("Codex native connection could not send a protocol reply");
          }
        });
  }

  private synchronized void receive(String stream, String chunk) {
    if (!"stdout".equals(stream)) {
      diagnostics.accept("stderr", chunk);
      return;
    }
    int start = 0;
    while (start < chunk.length()) {
      int newline = chunk.indexOf('\n', start), end = newline < 0 ? chunk.length() : newline;
      if (frame.length() + end - start > MAX_FRAME) {
        failConnection("Codex native response exceeded its size limit");
        return;
      }
      frame.append(chunk, start, end);
      if (newline < 0) return;
      String line = frame.toString();
      frame.setLength(0);
      start = newline + 1;
      if (line.isBlank()) continue;
      Object parsed;
      try {
        parsed = mapper.readValue(line, Object.class);
      } catch (RuntimeException error) {
        // Non-JSON startup diagnostics are not assistant output or usage.
        continue;
      }
      try {
        if (parsed instanceof Map<?, ?>) receiveMessage(obj(parsed));
      } catch (RuntimeException error) {
        failConnection("Codex native protocol event could not be processed");
      }
    }
  }

  private void receiveMessage(Map<String, Object> message) {
    if (message.containsKey("id") && message.containsKey("method")) {
      Object id = message.get("id");
      if (!(id instanceof Number || id instanceof String) || text(id).length() > 128) {
        failConnection("Codex sent an invalid server request id");
        return;
      }
      // Argus has not authorized this integration to approve native server requests.
      // Never silently grant commands, writes, credentials, dynamic tools, or elicitation.
      sendUncorrelated(
          fields(
              "id",
              id,
              "error",
              fields(
                  "code",
                  -32601,
                  "message",
                  "Argus does not support this interactive native request; no approval was granted")));
      return;
    }
    if (message.get("id") instanceof Number number) {
      Pending request = pending.get(number.intValue());
      if (request == null) return;
      if (message.containsKey("error")) {
        var error = obj(message.get("error"));
        Integer code = error.get("code") instanceof Number value ? value.intValue() : null;
        request.result.completeExceptionally(
            new RpcFailure(text(error.get("message")), false, code));
      } else if (message.get("result") instanceof Map<?, ?>)
        request.result.complete(obj(message.get("result")));
      else request.fail("Invalid Codex native response", null);
      return;
    }
    String method = text(message.get("method"));
    var params = obj(message.get("params"));
    String eventThread = text(params.get("threadId"));
    if (!threadId.isEmpty() && !eventThread.isEmpty() && !threadId.equals(eventThread)) return;
    if (method.equals("turn/started")) {
      String id = text(obj(params.get("turn")).get("id"));
      if (!id.isBlank()) {
        turnId = id;
        active = true;
      }
    }
    notifications.accept(message);
    if (method.equals("turn/completed")) {
      var turn = obj(params.get("turn"));
      if (!turnId.isEmpty() && !turnId.equals(text(turn.get("id")))) return;
      active = false;
      String status = text(turn.get("status"));
      turnCompletion.complete(
          "completed".equals(status) ? 0 : "interrupted".equals(status) ? 130 : 1);
    }
  }

  private void failConnection(String message) {
    active = false;
    var error = new IllegalStateException(message);
    pending.values().forEach(request -> request.fail(message, null));
    turnCompletion.completeExceptionally(error);
  }

  @Override
  public void close() {
    closed = true;
    active = false;
    child.close();
    writer.shutdownNow();
  }
}
