package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.*;
import tools.jackson.core.JsonParser;
import tools.jackson.core.JsonToken;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Read-only, bounded observation of provider usage records written during one CLI invocation.
 * Prefers response usage records. Turn-bounded token_count changes are exposed separately as
 * provider counters, not verified billing totals: snapshots can be estimated, reset and replayed.
 */
public final class CodexRolloutUsage {
  private static final long MAX_COUNT = 9_007_199_254_740_991L;
  // Tool output, screenshots and compaction records can be several MB each. Stream past their
  // content instead of rejecting an otherwise valid accounting window or materializing it in RAM.
  private static final long MAX_BYTES = 256L * 1024 * 1024;
  private static final int MAX_PATHS = 20_000, MAX_RECORDS = 10_000, MAX_EVENTS = 200_000;
  private static final String UUID =
      "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  private final Path sessions;
  private final ObjectMapper mapper;
  private final boolean resumed;
  private final Set<Path> preexistingFiles = new HashSet<>();
  private final Set<Object> preexistingFileKeys = new HashSet<>();
  private final Set<String> preexistingThreadIds = new HashSet<>();
  private String threadId, failure = "", turnId;
  private Snapshot before;
  private boolean sessionVerified, turnCompleted, threadObserved;
  private Instant recoveryStart, recoveryEnd;
  private final Map<String, Map<String, Object>> responses = new LinkedHashMap<>();
  private Map<String, Object> finished;
  private Map<String, Object> counterBaseline;
  private CodexUsageCounters counters;

  private record Snapshot(Path path, Object fileKey, long size) {}

  public static Path defaultHome() {
    String configured = System.getenv("CODEX_HOME");
    try {
      return configured != null && !configured.isBlank()
          ? Path.of(configured).toAbsolutePath().normalize()
          : Path.of(System.getProperty("user.home"), ".codex");
    } catch (RuntimeException ignored) {
      return null;
    }
  }

  /** Recover one uniquely bounded invocation; never assign an entire session total to it. */
  public static Map<String, Object> recover(
      Path home, String threadId, String startedAt, String completedAt, ObjectMapper mapper) {
    if (!validThread(threadId))
      return fields(
          "reported",
          false,
          "detail",
          "The saved Codex thread identity is unavailable; historical usage cannot be recovered safely.");
    var observer = new CodexRolloutUsage(home, threadId, mapper, false);
    try {
      observer.recoveryStart = Instant.parse(startedAt);
      observer.recoveryEnd = Instant.parse(completedAt);
      if (!observer.recoveryEnd.isAfter(observer.recoveryStart))
        observer.failure = "The saved request time boundary is invalid";
      if (observer.before != null) {
        observer.before = new Snapshot(observer.before.path, observer.before.fileKey, 0);
        observer.sessionVerified = false;
        observer.counterBaseline = null;
      }
      observer.observeThread(threadId);
    } catch (RuntimeException ignored) {
      observer.failure = "The saved request time boundary is unavailable";
    }
    return observer.finish();
  }

  public CodexRolloutUsage(Path codexHome, String resumedThreadId, ObjectMapper mapper) {
    this(codexHome, resumedThreadId, mapper, true);
  }

  private CodexRolloutUsage(
      Path codexHome, String resumedThreadId, ObjectMapper mapper, boolean readBaseline) {
    this.mapper = mapper;
    this.sessions =
        codexHome == null ? null : codexHome.toAbsolutePath().normalize().resolve("sessions");
    this.resumed = resumedThreadId != null && !resumedThreadId.isBlank();
    this.threadId = resumed ? resumedThreadId : null;
    if (sessions == null) failure = "Codex's rollout location is unavailable";
    else if (resumed) {
      if (!validThread(threadId)) failure = "The resumed Codex thread identity is unavailable";
      else {
        try {
          before = locate(threadId);
          if (before == null)
            failure = "No bounded, uncompressed rollout was found before the resumed request";
          else {
            sessionVerified = true;
            if (readBaseline)
              try {
                counterBaseline = readCounterBaseline(before);
              } catch (IOException | RuntimeException ignored) {
                /* Optional baseline, never suppress verified response records. */
              }
          }
        } catch (IOException | RuntimeException ignored) {
          failure = "The resumed Codex rollout could not be observed safely";
        }
      }
    } else {
      try {
        locate(null);
      } catch (IOException | RuntimeException ignored) {
        failure = "The initial Codex rollout directory could not be bounded safely";
      }
    }
  }

  /** Numeric-only baseline captured before submitting the request, never a whole-session charge. */
  synchronized Map<String, Object> counterBaseline() {
    return resumed ? counterBaseline : CodexUsageCounters.zero();
  }

  private Map<String, Object> readCounterBaseline(Snapshot snapshot) throws IOException {
    Map<String, Object> baseline = null;
    long start = Math.max(0, snapshot.size - 4L * 1024 * 1024);
    try (var channel =
        FileChannel.open(snapshot.path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
      channel.position(start);
      var input = new BufferedInputStream(window(channel, snapshot.size - start), 16_384);
      if (start > 0) {
        int next;
        while ((next = input.read()) != '\n') if (next < 0) return null;
      }
      try (var parser = mapper.createParser(input)) {
        int events = 0;
        while (parser.nextToken() != null && ++events <= MAX_EVENTS) {
          var event = project(parser, 0);
          var payload = obj(event.get("payload"));
          if ("event_msg".equals(event.get("type")) && "token_count".equals(payload.get("type"))) {
            var candidate =
                CodexUsageCounters.parse(
                    obj(obj(payload.get("info")).get("total_token_usage")), true);
            if (candidate != null) baseline = candidate;
          }
        }
      }
    }
    var after =
        Files.readAttributes(snapshot.path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    if (!after.isRegularFile()
        || !snapshot.fileKey.equals(after.fileKey())
        || after.size() < snapshot.size) return null;
    return baseline;
  }

  /** Only invoke with the ID from a top-level provider thread.started protocol event. */
  public synchronized void observeThread(String observedThreadId) {
    if (finished != null) return;
    if (!validThread(observedThreadId) || threadId != null && !threadId.equals(observedThreadId)) {
      failure = "The provider thread identity changed during this request";
      return;
    }
    threadId = observedThreadId;
    threadObserved = true;
  }

  public synchronized Map<String, Object> finish() {
    if (finished != null) return finished;
    if (failure.isEmpty()) {
      try {
        if (!threadObserved || !validThread(threadId))
          failure = "The provider did not identify this Codex thread";
        else {
          Snapshot current = locate(threadId);
          if (current == null) failure = "Codex did not write a supported rollout for this request";
          else {
            if (!resumed) {
              // Creation timestamps can be rounded below the launch time, including for a newly
              // created file. Use the complete bounded pre-launch identity inventory instead.
              if (preexistingFiles.contains(current.path)
                  || preexistingFileKeys.contains(current.fileKey)
                  || preexistingThreadIds.contains(threadId.toLowerCase(Locale.ROOT)))
                failure = "The discovered rollout predates this request";
              else before = new Snapshot(current.path, current.fileKey, 0);
            }
            if (failure.isEmpty()) readWindow(current);
          }
        }
      } catch (IOException | RuntimeException ignored) {
        failure = "The Codex rollout changed or could not be read safely";
      }
    }
    if (recoveryStart != null && !turnCompleted && failure.isEmpty())
      failure = "No uniquely completed Codex turn matches the saved request time boundary";
    boolean reported =
        failure.isEmpty() && sessionVerified && turnId != null && !responses.isEmpty();
    var result =
        fields(
            "provider",
            "codex",
            "status",
            reported ? "partial" : "unavailable",
            "exact",
            false,
            "reported",
            reported,
            "source",
            "codex.rollout.token_usage_record.usage",
            "scope",
            "argus-prompt-execution",
            "coverage",
            "recorded-response-subtotal",
            "recordedResponseCount",
            reported ? responses.size() : 0,
            "turnCompleted",
            turnCompleted,
            "threadId",
            validThread(threadId) ? threadId : null,
            "turnId",
            turnId,
            "measuredAt",
            reported ? Instant.now().toString() : null);
    for (String key :
        List.of(
            "inputTokens",
            "outputTokens",
            "totalTokens",
            "uncachedInputTokens",
            "cachedInputTokens",
            "cacheCreationInputTokens",
            "reasoningOutputTokens")) {
      Long value = reported ? 0L : null;
      if (reported)
        for (var response : responses.values()) {
          if (response.get(key) == null) {
            value = null;
            break;
          }
          value = sum(value, (Long) response.get(key));
          if (value == null) {
            failure = "The recorded usage exceeds safe numeric limits";
            break;
          }
        }
      result.put(key, value);
    }
    if (!failure.isEmpty()) {
      result.put("reported", false);
      result.put("status", "unavailable");
      result.put("recordedResponseCount", 0);
      for (String key :
          List.of(
              "inputTokens",
              "outputTokens",
              "totalTokens",
              "uncachedInputTokens",
              "cachedInputTokens",
              "cacheCreationInputTokens",
              "reasoningOutputTokens")) result.put(key, null);
    }
    result.put(
        "detail",
        !failure.isEmpty()
            ? failure + ". No estimate is substituted."
            : reported
                ? "Provider-reported usage from uniquely identified responses in this request's rollout window. This is a subtotal: missing response reports and subagent usage cannot be ruled out."
                : "No usable turn-scoped usage was recorded. Session totals are not substituted; historical messages without identifiable usage boundaries cannot be reconstructed.");
    if (failure.isEmpty() && sessionVerified && counters != null) {
      var fallback = counters.projection("codex.rollout.token_count", threadId, turnId);
      fallback.put("turnCompleted", turnCompleted);
      if (truth(fallback.get("reported"))) {
        // Response records and counters overlap. Retain both projections for reconciliation,
        // never add them; a response subtotal must not hide a fuller scoped counter report.
        if (responses.isEmpty()) {
          result.putAll(fallback);
          result.put("status", "partial");
        } else result.put("counterUsage", fallback);
      }
    }
    finished = Collections.unmodifiableMap(result);
    responses.clear();
    return finished;
  }

  private Snapshot locate(String id) throws IOException {
    if (Thread.currentThread().isInterrupted())
      throw new IOException("Usage discovery interrupted");
    if (!Files.isDirectory(sessions, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(sessions))
      return null;
    Snapshot match = null;
    int inspected = 0;
    try (var paths = Files.walk(sessions, 4)) {
      var iterator = paths.iterator();
      while (iterator.hasNext()) {
        if (Thread.currentThread().isInterrupted())
          throw new IOException("Usage discovery interrupted");
        Path path = iterator.next();
        if (++inspected > MAX_PATHS) throw new IOException("Bounded discovery exceeded");
        if (!path.getFileName().toString().startsWith("rollout-")
            || !path.getFileName().toString().endsWith(id == null ? ".jsonl" : "-" + id + ".jsonl"))
          continue;
        BasicFileAttributes attributes =
            Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isRegularFile()
            || attributes.isSymbolicLink()
            || attributes.fileKey() == null) continue;
        if (id == null) {
          preexistingFiles.add(path);
          preexistingFileKeys.add(attributes.fileKey());
          String name = path.getFileName().toString();
          if (name.length() >= 42) {
            String existingThread = name.substring(name.length() - 42, name.length() - 6);
            if (validThread(existingThread))
              preexistingThreadIds.add(existingThread.toLowerCase(Locale.ROOT));
          }
          continue;
        }
        if (match != null) throw new IOException("Ambiguous rollout identity");
        match = new Snapshot(path, attributes.fileKey(), attributes.size());
      }
    }
    return match;
  }

  private void readWindow(Snapshot current) throws IOException {
    if (before == null
        || !before.path.equals(current.path)
        || !before.fileKey.equals(current.fileKey)
        || current.size < before.size) throw new IOException("Rollout window unavailable");
    if (current.size - before.size > MAX_BYTES) {
      failure = "The local rollout exceeded the bounded 256 MB accounting scan limit";
      return;
    }
    try (var channel =
        FileChannel.open(current.path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
      if (before.size > 0) {
        channel.position(before.size - 1);
        var previous = ByteBuffer.allocate(1);
        if (channel.read(previous) != 1 || previous.array()[0] != '\n')
          throw new IOException("Initial rollout boundary is incomplete");
      }
      if (current.size > 0) {
        channel.position(current.size - 1);
        var last = ByteBuffer.allocate(1);
        if (channel.read(last) != 1 || last.array()[0] != '\n')
          throw new IOException("Final rollout boundary is incomplete");
      }
      channel.position(before.size);
      try (var parser = mapper.createParser(window(channel, current.size - before.size))) {
        int events = 0;
        while (parser.nextToken() != null && failure.isEmpty()) {
          if (++events > MAX_EVENTS) throw new IOException("Too many rollout events");
          consume(mapper.valueToTree(project(parser, 0)));
        }
      }
    }
    var after =
        Files.readAttributes(current.path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    // A new turn may append while inspecting a completed historical turn. The stream was bounded
    // to the captured, newline-complete prefix, so newer bytes (even a partial record) are
    // excluded.
    // Live invocation accounting still requires an unchanged final append boundary.
    if (!after.isRegularFile()
        || !current.fileKey.equals(after.fileKey())
        || after.size() < current.size
        || recoveryStart == null && after.size() != current.size)
      throw new IOException("Rollout changed while reading");
  }

  private static InputStream window(FileChannel channel, long size) {
    return new InputStream() {
      long remaining = size;

      @Override
      public int read() throws IOException {
        byte[] value = new byte[1];
        return read(value, 0, 1) < 0 ? -1 : value[0] & 255;
      }

      @Override
      public int read(byte[] bytes, int offset, int length) throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("Usage read interrupted");
        if (length == 0) return 0;
        if (remaining == 0) return -1;
        int read = channel.read(ByteBuffer.wrap(bytes, offset, (int) Math.min(length, remaining)));
        if (read <= 0) throw new IOException("Rollout truncated while reading");
        remaining -= read;
        return read;
      }
    };
  }

  // Read only identity, boundaries and numeric usage. skipChildren also skips large lazy string
  // values; no prompt, reasoning, tool payload or attachment is retained in the projection.
  private static Map<String, Object> project(JsonParser parser, int level) throws IOException {
    if (parser.currentToken() != JsonToken.START_OBJECT)
      throw new IOException("Invalid rollout record");
    Set<String> keys =
        switch (level) {
          case 0 -> Set.of("type", "timestamp", "payload");
          case 1 -> Set.of("id", "type", "thread_id", "turn_id", "response_id", "usage", "info");
          default ->
              Set.of(
                  "total_token_usage",
                  "last_token_usage",
                  "input_tokens",
                  "cached_input_tokens",
                  "cache_write_input_tokens",
                  "output_tokens",
                  "reasoning_output_tokens",
                  "total_tokens");
        };
    var projected = new LinkedHashMap<String, Object>();
    while (parser.nextToken() != JsonToken.END_OBJECT) {
      if (parser.currentToken() != JsonToken.PROPERTY_NAME)
        throw new IOException("Invalid rollout object");
      String key = parser.currentName();
      var token = parser.nextToken();
      if (!keys.contains(key)) {
        parser.skipChildren();
        continue;
      }
      if (projected.containsKey(key)) throw new IOException("Duplicate accounting field");
      if (token == JsonToken.START_OBJECT
          && ((level == 0 && key.equals("payload"))
              || (level == 1 && Set.of("usage", "info").contains(key))
              || (level == 2 && Set.of("total_token_usage", "last_token_usage").contains(key)))) {
        projected.put(key, project(parser, level + 1));
      } else if (token == JsonToken.VALUE_STRING && level < 2) {
        String value = parser.getString();
        if (value.length() > 300) throw new IOException("Oversized accounting identity");
        projected.put(key, value);
      } else if (token == JsonToken.VALUE_NUMBER_INT && level >= 2) {
        projected.put(key, parser.getNumberValue());
      } else {
        projected.put(key, null);
        parser.skipChildren();
      }
    }
    return projected;
  }

  private void consume(JsonNode event) {
    if (!event.isObject()) throw new IllegalArgumentException("Invalid rollout record");
    JsonNode payload = event.path("payload");
    Map<String, Object> counterTotal = null, counterLast = null;
    if (event.path("type").asText().equals("event_msg")
        && payload.path("type").asText().equals("token_count")) {
      var info = obj(obj(mapper.convertValue(payload, Map.class)).get("info"));
      counterTotal = CodexUsageCounters.parse(obj(info.get("total_token_usage")), true);
      counterLast = CodexUsageCounters.parse(obj(info.get("last_token_usage")), true);
      if (turnId == null && counterTotal != null) counterBaseline = counterTotal;
    }
    if (recoveryStart != null && !event.path("type").asText().equals("session_meta")) {
      String outer = event.path("type").asText(), type = payload.path("type").asText();
      boolean boundary =
          outer.equals("event_msg")
              && Set.of("task_started", "turn_started", "task_complete", "turn_complete")
                  .contains(type);
      if (boundary) {
        Instant at = Instant.parse(event.path("timestamp").asText());
        if (at.isBefore(recoveryStart) || at.isAfter(recoveryEnd)) {
          // A preceding turn means zero is no longer a proven baseline. Its subsequent
          // counter record can establish a real baseline before the requested turn starts.
          if (at.isBefore(recoveryStart) && Set.of("task_started", "turn_started").contains(type))
            counterBaseline = null;
          return;
        }
      } else if (turnId == null || turnCompleted) return;
    }
    switch (event.path("type").asText()) {
      case "session_meta" -> {
        if (!threadId.equals(payload.path("id").asText()))
          failure = "The rollout session identity does not match";
        else {
          if (recoveryStart != null && !sessionVerified)
            counterBaseline = CodexUsageCounters.zero();
          sessionVerified = true;
        }
      }
      case "event_msg" -> {
        String type = payload.path("type").asText();
        if (Set.of("task_started", "turn_started").contains(type)) {
          String id = payload.path("turn_id").asText();
          if (!validId(id) || turnId != null && (!turnId.equals(id) || turnCompleted))
            failure = "The rollout contains ambiguous or overlapping request boundaries";
          else {
            if (turnId == null) counters = new CodexUsageCounters(counterBaseline());
            turnId = id;
          }
        } else if (Set.of("task_complete", "turn_complete").contains(type)) {
          if (turnId == null || !turnId.equals(payload.path("turn_id").asText()))
            failure = "The rollout completion does not match this request boundary";
          else turnCompleted = true;
        } else if ("token_count".equals(type) && counters != null && !turnCompleted)
          counters.accept(counterTotal, counterLast);
      }
      case "token_usage_record" -> {
        if (!sessionVerified
            || turnId == null
            || !threadId.equals(payload.path("thread_id").asText())
            || !turnId.equals(payload.path("turn_id").asText())) {
          failure = "A usage record could not be attributed to this request boundary";
          return;
        }
        String id = payload.path("response_id").asText();
        var usage = usage(payload.path("usage"));
        if (!validId(id) || usage == null) {
          failure = "Codex wrote an invalid or incomplete response usage record";
          return;
        }
        var prior = responses.get(id);
        if (prior != null && !prior.equals(usage))
          failure = "Repeated response usage records disagree";
        else if (prior == null && responses.size() >= MAX_RECORDS)
          failure = "Too many response usage records to observe safely";
        else if (prior == null && turnCompleted)
          failure = "A new response record appeared after request completion";
        else responses.putIfAbsent(id, usage);
      }
      default -> {
        /* No prompt, response, file, tool output, or secret is returned or persisted. */
      }
    }
  }

  private static Map<String, Object> usage(JsonNode node) {
    Long input = count(node, "input_tokens"),
        output = count(node, "output_tokens"),
        total = count(node, "total_tokens");
    if (input == null
        || output == null
        || total == null
        || !Objects.equals(total, sum(input, output))) return null;
    Long cached = count(node, "cached_input_tokens"),
        created = count(node, "cache_write_input_tokens"),
        reasoning = count(node, "reasoning_output_tokens");
    if (node.has("cached_input_tokens") && cached == null
        || node.has("cache_write_input_tokens") && created == null
        || node.has("reasoning_output_tokens") && reasoning == null
        || cached != null && cached > input
        || created != null && created > input
        || cached != null && created != null && cached > input - created
        || reasoning != null && reasoning > output) return null;
    return fields(
        "inputTokens",
        input,
        "outputTokens",
        output,
        "totalTokens",
        total,
        "cachedInputTokens",
        cached,
        "cacheCreationInputTokens",
        created,
        "reasoningOutputTokens",
        reasoning,
        "uncachedInputTokens",
        cached != null && created != null ? input - cached - created : null);
  }

  private static Long count(JsonNode node, String key) {
    var value = node.path(key);
    if (!value.isIntegralNumber() || !value.canConvertToLong()) return null;
    long number = value.longValue();
    return number < 0 || number > MAX_COUNT ? null : number;
  }

  private static Long sum(Long a, Long b) {
    return a == null || b == null || a > MAX_COUNT - b ? null : a + b;
  }

  private static boolean validThread(String value) {
    return value != null && value.matches(UUID);
  }

  private static boolean validId(String value) {
    return value != null && !value.isBlank() && value.length() <= 300;
  }
}
