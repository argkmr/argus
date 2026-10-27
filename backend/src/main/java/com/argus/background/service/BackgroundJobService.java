package com.argus.background.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

/** Current-session cards; durable refresh work lives separately in AiKitRefreshQueue. */
@Service
public class BackgroundJobService {
  private final AtomicJsonStore json;
  private final Path file;
  private final List<Map<String, Object>> jobs = new ArrayList<>();
  private final Map<String, Integer> retained = new java.util.HashMap<>();

  public BackgroundJobService(AtomicJsonStore json, ArgusProperties properties) {
    this.json = json;
    file = properties.dataDirectory().resolve("background-jobs.json");
  }

  public synchronized List<Map<String, Object>> list() {
    return jobs.stream().map(item -> copyMap(item)).toList();
  }

  private static List<?> list(Object value) {
    return com.argus.runtime.service.RuntimeData.list(value);
  }

  public synchronized Map<String, Object> get(String id) {
    return copyMap(require(id));
  }

  private Map<String, Object> require(String id) {
    return jobs.stream()
        .filter(item -> id.equals(item.get("id")))
        .findFirst()
        .orElseThrow(() -> new NotFoundException("Background job not found"));
  }

  public synchronized Map<String, Object> create(Map<String, Object> input) {
    String now = Instant.now().toString(),
        message = text(input, "message"),
        title = text(input, "title");
    var items = new ArrayList<Map<String, Object>>();
    for (Object value : list(input.get("items"))) {
      var item = copyMap(map(value));
      item.put("status", "queued");
      item.put("error", "");
      items.add(item);
    }
    var job =
        object(
            "id",
            UUID.randomUUID().toString(),
            "type",
            input.get("type"),
            "title",
            title,
            "message",
            message,
            "status",
            "queued",
            "total",
            number(input.get("total")),
            "completed",
            0,
            "failed",
            0,
            "warnings",
            0,
            "percent",
            0,
            "currentItem",
            "",
            "items",
            items,
            "logs",
            new ArrayList<>(
                List.of(
                    object(
                        "timestamp",
                        now,
                        "level",
                        "info",
                        "message",
                        message.isEmpty() ? title + " queued." : message))),
            "createdAt",
            now,
            "startedAt",
            null,
            "completedAt",
            null,
            "error",
            "");
    jobs.add(0, job);
    // Live producers and cancellation controls resolve their card by ID. Only retire history;
    // more than thirty concurrent jobs must remain addressable until their work has finished.
    trimHistory();
    save();
    return copyMap(job);
  }

  synchronized void retain(String id) {
    require(id);
    retained.merge(id, 1, Integer::sum);
  }

  synchronized void release(String id) {
    retained.computeIfPresent(id, (key, owners) -> owners <= 1 ? null : owners - 1);
    int before = jobs.size();
    trimHistory();
    if (before != jobs.size()) save();
  }

  private void trimHistory() {
    for (int index = jobs.size() - 1; index >= 0 && jobs.size() > 30; index--) {
      var job = jobs.get(index);
      if (!active(job) && !retained.containsKey(text(job, "id"))) jobs.remove(index);
    }
  }

  public synchronized Map<String, Object> update(String id, Map<String, Object> changes) {
    var job = require(id);
    job.putAll(copyMap(changes));
    long total = number(job.get("total"));
    long percent =
        changes.containsKey("percent")
            ? number(changes.get("percent"))
            : total > 0
                ? Math.round(
                    (number(job.get("completed")) + number(job.get("failed"))) * 100d / total)
                : Set.of("completed", "completed-with-warning").contains(job.get("status"))
                    ? 100
                    : 0;
    job.put("percent", Math.max(0, Math.min(100, percent)));
    save();
    return copyMap(job);
  }

  public synchronized Map<String, Object> updateItem(
      String id, int index, Map<String, Object> changes) {
    var job = require(id);
    var items = list(job.get("items"));
    if (index < 0 || index >= items.size())
      throw new IllegalArgumentException("Background job item not found");
    map(items.get(index)).putAll(copyMap(changes));
    save();
    return copyMap(job);
  }

  public synchronized void appendLog(String id, Map<String, Object> input) {
    var job = require(id);
    var logs = new ArrayList<Object>(list(job.get("logs")));
    logs.add(
        object(
            "timestamp",
            input.getOrDefault("timestamp", Instant.now().toString()),
            "level",
            input.getOrDefault("level", "info"),
            "repository",
            text(input, "repository"),
            "stage",
            text(input, "stage"),
            "durationMillis",
            input.containsKey("durationMillis")
                ? Math.max(0, number(input.get("durationMillis")))
                : null,
            "message",
            text(input, "message")));
    job.put(
        "logs",
        logs.size() > 200 ? new ArrayList<>(logs.subList(logs.size() - 200, logs.size())) : logs);
    save();
  }

  public synchronized Map<String, Object> purgeRepositories(List<String> ids, String except) {
    int before = jobs.size();
    jobs.removeIf(
        job ->
            !text(job, "id").equals(except)
                && list(job.get("items")).stream()
                    .anyMatch(item -> ids.contains(text(map(item), "repositoryId"))));
    save();
    return object("backgroundJobsDeleted", before - jobs.size());
  }

  private void save() {
    json.write(file, jobs);
  }

  public static boolean active(Map<String, Object> job) {
    return Set.of("queued", "running", "paused").contains(job.get("status"));
  }
}
