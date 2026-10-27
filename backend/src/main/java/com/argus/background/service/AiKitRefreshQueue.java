package com.argus.background.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/** Native owner of the existing version-1 coalescing, cancellation and retry journal. */
@Service
public class AiKitRefreshQueue {
  private final AtomicJsonStore json;
  private final Path file;
  private final LongSupplier clock;
  private Map<String, Object> state;

  @Autowired
  public AiKitRefreshQueue(AtomicJsonStore json, ArgusProperties properties) {
    this(json, properties.dataDirectory(), System::currentTimeMillis);
  }

  public AiKitRefreshQueue(AtomicJsonStore json, Path directory, LongSupplier clock) {
    this.json = json;
    this.file = directory.resolve("ai-kit-refresh-queue.json");
    this.clock = clock;
  }

  public synchronized Map<String, Object> load() {
    if (state != null) return snapshot();
    try {
      if (Files.exists(file) && Files.size(file) > 2_000_000)
        throw new IllegalStateException("AI-kit refresh queue is too large");
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not inspect AI-kit refresh queue", error);
    }
    Map<String, Object> loaded =
        Files.exists(file)
            ? json.read(file, LinkedHashMap.class)
            : object(
                "version",
                1,
                "pending",
                new ArrayList<>(),
                "active",
                null,
                "cancelled",
                new ArrayList<>());
    if (number(loaded.get("version")) != 1
        || !(loaded.get("pending") instanceof List)
        || !(loaded.get("cancelled") instanceof List)
        || loaded.get("active") != null && !(loaded.get("active") instanceof Map))
      throw new IllegalStateException("Invalid saved AI-kit refresh queue");
    validate(list(loaded.get("pending")), false);
    validate(list(loaded.get("cancelled")), true);
    var active = map(loaded.get("active"));
    if (loaded.get("active") != null) {
      requireId(text(active, "jobId"));
      if (!(active.get("requests") instanceof List))
        throw new IllegalStateException("Invalid saved active AI-kit requests");
      validate(list(active.get("requests")), false);
    }
    if (!active.isEmpty()) {
      requireId(text(active, "jobId"));
      validate(list(active.get("requests")), false);
      var pending = index(loaded.get("pending"));
      var cancelled = index(loaded.get("cancelled"));
      for (Object raw : list(active.get("requests"))) {
        var item = copyMap(map(raw));
        String id = text(item, "repositoryId");
        if (!cancelled.containsKey(id) && !pending.containsKey(id)) {
          item.put("notBefore", clock.getAsLong());
          pending.put(id, item);
        }
      }
      loaded.put("pending", new ArrayList<>(pending.values()));
      loaded.put("active", null);
      json.write(file, loaded);
    }
    state = loaded;
    return snapshot();
  }

  public synchronized Map<String, Object> snapshot() {
    if (state == null)
      throw new IllegalStateException("Load the AI-kit refresh queue before using it");
    var result = copyMap(state);
    var pending = list(state.get("pending"));
    result.put(
        "pendingRepositoryIds",
        pending.stream().map(item -> text(map(item), "repositoryId")).toList());
    result.put(
        "readyRepositoryIds",
        pending.stream()
            .filter(item -> number(map(item).get("notBefore")) <= clock.getAsLong())
            .map(item -> text(map(item), "repositoryId"))
            .toList());
    result.put(
        "nextReadyAt",
        pending.isEmpty()
            ? null
            : pending.stream()
                .mapToLong(item -> number(map(item).get("notBefore")))
                .min()
                .getAsLong());
    result.put(
        "activeRepositoryIds",
        list(map(state.get("active")).get("requests")).stream()
            .map(item -> text(map(item), "repositoryId"))
            .toList());
    result.put(
        "cancelledRepositoryIds",
        list(state.get("cancelled")).stream()
            .map(item -> text(map(item), "repositoryId"))
            .toList());
    return result;
  }

  private Map<String, Object> update(Consumer<Map<String, Object>> operation) {
    if (state == null) load();
    var next = copyMap(state);
    operation.accept(next);
    if (list(next.get("pending")).size() + list(map(next.get("active")).get("requests")).size()
        > 10_000) throw new IllegalStateException("Too many pending AI-kit refresh requests");
    json.write(file, next);
    state = next;
    return snapshot();
  }

  public synchronized Map<String, Object> request(
      List<String> ids, boolean automatic, Map<String, String> revisions) {
    var requested = ids(ids);
    return update(
        next -> {
          var pending = index(next.get("pending"));
          var cancelled = index(next.get("cancelled"));
          var active = index(map(next.get("active")).get("requests"));
          for (String id : requested) {
            String revision = revisions.getOrDefault(id, "");
            revision = revision.substring(0, Math.min(128, revision.length()));
            var suppressed = cancelled.get(id);
            if (automatic
                && suppressed != null
                && (text(suppressed, "revision").isEmpty()
                    || revision.isEmpty()
                    || revision.equals(suppressed.get("revision")))) continue;
            cancelled.remove(id);
            if (automatic
                && active.containsKey(id)
                && !revision.isEmpty()
                && revision.equals(active.get(id).get("revision"))) continue;
            var previous = pending.get(id);
            if (previous != null
                && revision.equals(previous.get("revision"))
                && (automatic || number(previous.get("notBefore")) <= clock.getAsLong())) continue;
            pending.put(
                id,
                object(
                    "repositoryId",
                    id,
                    "revision",
                    revision,
                    "requestedAt",
                    clock.getAsLong(),
                    "attempts",
                    0,
                    "notBefore",
                    clock.getAsLong()));
          }
          next.put("pending", new ArrayList<>(pending.values()));
          next.put("cancelled", new ArrayList<>(cancelled.values()));
        });
  }

  public synchronized Map<String, Object> claim(String jobId, List<String> ids) {
    requireId(jobId);
    Set<String> selected = ids(ids);
    boolean[] claimed = {false};
    var result =
        update(
            next -> {
              if (next.get("active") != null) return;
              var requests =
                  list(next.get("pending")).stream()
                      .filter(
                          item ->
                              selected.contains(text(map(item), "repositoryId"))
                                  && number(map(item).get("notBefore")) <= clock.getAsLong())
                      .toList();
              if (requests.isEmpty()) return;
              var keys = requests.stream().map(item -> text(map(item), "repositoryId")).toList();
              next.put(
                  "pending",
                  new ArrayList<>(
                      list(next.get("pending")).stream()
                          .filter(item -> !keys.contains(text(map(item), "repositoryId")))
                          .toList()));
              next.put(
                  "active",
                  object(
                      "jobId",
                      jobId,
                      "requests",
                      new ArrayList<>(requests),
                      "startedAt",
                      clock.getAsLong()));
              claimed[0] = true;
            });
    result.put("claimed", claimed[0]);
    return result;
  }

  public synchronized Map<String, Object> finish(String jobId, List<String> failedIds) {
    Set<String> failed = ids(failedIds);
    boolean[] finished = {false};
    var result =
        update(
            next -> {
              var active = map(next.get("active"));
              if (!jobId.equals(active.get("jobId"))) return;
              var pending = index(next.get("pending"));
              var cancelled = index(next.get("cancelled"));
              for (Object raw : list(active.get("requests"))) {
                var item = copyMap(map(raw));
                String id = text(item, "repositoryId");
                if (!failed.contains(id) || pending.containsKey(id) || cancelled.containsKey(id))
                  continue;
                long attempts = number(item.get("attempts")) + 1;
                item.put("attempts", attempts);
                item.put(
                    "notBefore",
                    clock.getAsLong()
                        + Math.min(900_000L, 60_000L * (1L << Math.min(attempts - 1, 10))));
                pending.put(id, item);
              }
              next.put("pending", new ArrayList<>(pending.values()));
              next.put("active", null);
              finished[0] = true;
            });
    result.put("finished", finished[0]);
    return result;
  }

  public synchronized Map<String, Object> cancel(String jobId) {
    boolean[] cancelledJob = {false};
    var result =
        update(
            next -> {
              var active = map(next.get("active"));
              if (!jobId.equals(active.get("jobId"))) return;
              var cancelled = index(next.get("cancelled"));
              var selected = index(active.get("requests"));
              for (var entry : selected.entrySet())
                cancelled.put(
                    entry.getKey(),
                    object(
                        "repositoryId",
                        entry.getKey(),
                        "revision",
                        entry.getValue().get("revision"),
                        "cancelledAt",
                        clock.getAsLong()));
              next.put("cancelled", new ArrayList<>(cancelled.values()));
              next.put(
                  "pending",
                  new ArrayList<>(
                      list(next.get("pending")).stream()
                          .filter(item -> !selected.containsKey(text(map(item), "repositoryId")))
                          .toList()));
              cancelledJob[0] = true;
            });
    result.put("cancelledJob", cancelledJob[0]);
    return result;
  }

  public synchronized void purgeRepositories(List<String> ids) {
    Set<String> selected = ids(ids);
    update(
        next -> {
          for (String field : List.of("pending", "cancelled"))
            next.put(
                field,
                new ArrayList<>(
                    list(next.get(field)).stream()
                        .filter(item -> !selected.contains(text(map(item), "repositoryId")))
                        .toList()));
          if (next.get("active") != null) {
            var active = map(next.get("active"));
            active.put(
                "requests",
                new ArrayList<>(
                    list(active.get("requests")).stream()
                        .filter(item -> !selected.contains(text(map(item), "repositoryId")))
                        .toList()));
          }
        });
  }

  /** Keep full scheduler provenance before cancellation changes an active request. */
  public synchronized void preserveRepositoryRequests(List<String> ids) {
    Set<String> selected = ids(ids);
    update(
        next -> {
          var retained = new ArrayList<Object>(list(next.get("disconnectedRequests")));
          for (String field : List.of("pending", "cancelled"))
            for (Object raw : list(next.get(field)))
              if (selected.contains(text(map(raw), "repositoryId")))
                retained.add(
                    object(
                        "source",
                        field,
                        "request",
                        copyMap(map(raw)),
                        "savedAt",
                        clock.getAsLong()));
          var active = map(next.get("active"));
          for (Object raw : list(active.get("requests")))
            if (selected.contains(text(map(raw), "repositoryId")))
              retained.add(
                  object(
                      "source",
                      "active",
                      "jobId",
                      active.get("jobId"),
                      "request",
                      copyMap(map(raw)),
                      "savedAt",
                      clock.getAsLong()));
          next.put("disconnectedRequests", retained);
        });
  }

  private static LinkedHashMap<String, Map<String, Object>> index(Object value) {
    var result = new LinkedHashMap<String, Map<String, Object>>();
    for (Object item : list(value)) result.put(text(map(item), "repositoryId"), map(item));
    return result;
  }

  private static void requireId(String id) {
    if (id == null || !id.matches("[A-Za-z0-9_-]{1,200}"))
      throw new IllegalArgumentException("AI-kit refresh requires valid repository IDs");
  }

  private static Set<String> ids(List<String> ids) {
    if (ids == null || ids.size() > 10_000)
      throw new IllegalArgumentException("Too many AI-kit repository IDs");
    ids.forEach(AiKitRefreshQueue::requireId);
    return new LinkedHashSet<>(ids);
  }

  private static void validate(List<?> records, boolean cancelled) {
    var seen = new LinkedHashSet<String>();
    if (records.size() > 10_000) throw new IllegalStateException("Too many saved AI-kit requests");
    for (Object raw : records) {
      var item = map(raw);
      String id = text(item, "repositoryId");
      requireId(id);
      if (!seen.add(id))
        throw new IllegalStateException("Duplicate IDs in saved AI-kit refresh queue");
      if (!(item.get("revision") instanceof String revision) || revision.length() > 128)
        throw new IllegalStateException("Invalid saved AI-kit revision");
      for (String field :
          cancelled ? List.of("cancelledAt") : List.of("requestedAt", "notBefore", "attempts")) {
        Object value = item.get(field);
        if (!(value instanceof Number n)
            || !Double.isFinite(n.doubleValue())
            || n.doubleValue() < 0
            || n.doubleValue() != n.longValue())
          throw new IllegalStateException("Invalid saved AI-kit scheduling metadata");
      }
    }
  }
}
