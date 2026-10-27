package com.argus.agents.service;

import com.argus.tasks.service.AgentTaskOutput;
import java.util.Map;
import java.util.function.Consumer;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;

/**
 * Bounded display projection; raw transport, diagnostic cursors and process ownership stay
 * separate.
 */
public final class AgentOutputStream {
  private static final int LIMIT = 500_000;
  private final ObjectMapper mapper;
  private final ObjectReader eventReader;
  private final boolean structured;
  private final Consumer<Map<String, Object>> eventObserver;
  private final StringBuilder pending = new StringBuilder();
  private boolean discardingLine;
  private String latest = "";

  public AgentOutputStream(ObjectMapper mapper, boolean structured) {
    this(mapper, structured, ignored -> {});
  }

  public AgentOutputStream(
      ObjectMapper mapper, boolean structured, Consumer<Map<String, Object>> eventObserver) {
    this.mapper = java.util.Objects.requireNonNull(mapper);
    // Preserve provider decimal cost metadata before accounting sees it; do not mutate the shared
    // mapper used by other application JSON endpoints.
    this.eventReader =
        mapper.readerFor(Object.class).with(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
    this.structured = structured;
    this.eventObserver = java.util.Objects.requireNonNull(eventObserver);
  }

  public synchronized void append(String chunk) {
    if (chunk == null || chunk.isEmpty()) return;
    if (!structured) {
      if (chunk.length() >= LIMIT) {
        pending.setLength(0);
        pending.append(chunk, chunk.length() - LIMIT, chunk.length());
      } else {
        int excess = pending.length() + chunk.length() - LIMIT;
        if (excess > 0) pending.delete(0, excess);
        pending.append(chunk);
      }
      return;
    }
    int start = 0;
    while (start < chunk.length()) {
      int newline = chunk.indexOf('\n', start);
      int end = newline < 0 ? chunk.length() : newline;
      if (!discardingLine) {
        if (end - start > LIMIT - pending.length()) {
          pending.setLength(0);
          discardingLine = true;
        } else pending.append(chunk, start, end);
      }
      if (newline < 0) return;
      completeLine();
      start = newline + 1;
    }
  }

  /** Called after stdout drains; a complete final JSON event need not have a newline. */
  public synchronized void finish() {
    if (structured) completeLine();
  }

  public synchronized String readable() {
    return structured ? latest : AgentTaskOutput.readable(pending.toString(), mapper, true);
  }

  public synchronized String display() {
    return AgentQuestion.display(readable(), mapper);
  }

  public synchronized Map<String, Object> question() {
    return AgentQuestion.parse(readable(), mapper);
  }

  private void completeLine() {
    if (!discardingLine && !pending.isEmpty()) {
      try {
        Object parsed = eventReader.readValue(pending.toString());
        if (parsed instanceof Map<?, ?> map) {
          @SuppressWarnings("unchecked")
          var event = (Map<String, Object>) map;
          try {
            eventObserver.accept(event);
          } catch (RuntimeException ignored) {
            // Optional accounting must never discard a valid assistant response.
          }
          String message = AgentTaskOutput.message(event);
          if (!message.isEmpty()) latest = message;
        }
      } catch (RuntimeException ignored) {
        // Malformed/partial/tool output never becomes an assistant answer.
      }
    }
    pending.setLength(0);
    discardingLine = false;
  }
}
