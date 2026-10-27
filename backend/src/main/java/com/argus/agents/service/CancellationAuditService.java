package com.argus.agents.service;

import com.argus.agents.domain.CancellationRequest;
import com.argus.agents.domain.CancellationRequest.Cause;
import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.stereotype.Service;

/** A bounded durable cancellation history independent of the clearable activity view. */
@Service
public class CancellationAuditService {
  private static final int MAX_RECORDS = 500;
  private static final long MAX_HISTORY_BYTES = 2L * 1024 * 1024;
  private final AtomicJsonStore json;
  private final Path path;
  private final List<Map<String, Object>> records = new ArrayList<>();
  private boolean historyReadable = true;

  public CancellationAuditService(ArgusProperties properties, AtomicJsonStore json) {
    this.json = json;
    this.path = properties.dataDirectory().resolve("cancellations.json");
    if (!Files.exists(path)) return;
    try {
      if (Files.size(path) > MAX_HISTORY_BYTES)
        throw new IllegalStateException("Cancellation audit history unavailable");
      List<?> stored = json.read(path, List.class);
      for (Object entry : stored) {
        if (entry instanceof Map<?, ?> map) records.add(sanitize(map));
        if (records.size() == MAX_RECORDS) break;
      }
    } catch (IOException | RuntimeException ignored) {
      // Preserve unreadable evidence and let cancellation continue with an activity-only audit.
      records.clear();
      historyReadable = false;
    }
  }

  public synchronized void record(Map<String, Object> provenance) {
    Map<String, Object> safe = sanitize(provenance == null ? Map.of() : provenance);
    for (Map<String, Object> existing : records) {
      if (existing.get("id").equals(safe.get("id"))) {
        recordActivity(existing, true);
        return;
      }
    }
    var next = new ArrayList<Map<String, Object>>();
    next.add(safe);
    next.addAll(records.subList(0, Math.min(records.size(), MAX_RECORDS - 1)));
    boolean persisted = false;
    try {
      if (!historyReadable)
        throw new IllegalStateException("Cancellation audit history unavailable");
      json.write(path, next);
      records.clear();
      records.addAll(next);
      persisted = true;
    } catch (RuntimeException ignored) {
      throw new IllegalStateException("Cancellation audit persistence failed");
    } finally {
      safe.put("auditPersisted", persisted);
      recordActivity(safe, persisted);
    }
  }

  /** Most recent records first, copied so callers cannot mutate the audit history. */
  public synchronized List<Map<String, Object>> list(int requestedLimit) {
    int limit = Math.max(1, Math.min(requestedLimit, MAX_RECORDS));
    return records.stream()
        .limit(limit)
        .map(record -> (Map<String, Object>) new LinkedHashMap<>(record))
        .toList();
  }

  private void recordActivity(Map<String, Object> safe, boolean persisted) {}

  private static Map<String, Object> sanitize(Map<?, ?> value) {
    Cause cause;
    try {
      String suppliedCause = text(value, "cause");
      cause =
          suppliedCause.length() <= 40
              ? Cause.valueOf(suppliedCause.toUpperCase(Locale.ROOT))
              : Cause.INTERNAL_STOP;
    } catch (IllegalArgumentException ignored) {
      cause = Cause.INTERNAL_STOP;
    }
    var safe =
        new CancellationRequest(cause, text(value, "reportedControl"), text(value, "runId"))
            .provenance(text(value, "jobId"), text(value, "runId"));
    String id = text(value, "id");
    if (id.length() == 36
        && id.matches(
            "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")) {
      safe.put("id", id);
    }
    String requestedAt = text(value, "requestedAt");
    if (requestedAt.length() <= 64) {
      try {
        safe.put("requestedAt", Instant.parse(requestedAt).toString());
      } catch (DateTimeParseException ignored) {
      }
    }
    if (value.containsKey("preparationId")) {
      safe.put("preparationId", CancellationRequest.safeId(text(value, "preparationId")));
    }
    safe.put("auditPersisted", true);
    return safe;
  }

  private static String target(Map<String, Object> safe) {
    for (String key : List.of("jobId", "runId", "preparationId")) {
      String id = text(safe, key);
      if (!id.isEmpty()) return id;
    }
    return "";
  }

  private static String text(Map<?, ?> value, String key) {
    return value.get(key) instanceof String text ? text : "";
  }
}
