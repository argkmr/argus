package com.argus.tasks.repository;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.function.Function;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;

/** The single durable queue writer. Mutations roll back in memory when persistence fails. */
@Repository
public class PromptQueueRepository {
  private final Path file;
  private final AtomicJsonStore store;
  private final ObjectMapper mapper;
  private List<Map<String, Object>> items;

  public PromptQueueRepository(
      ArgusProperties properties, AtomicJsonStore store, ObjectMapper mapper) {
    file = properties.dataDirectory().resolve("prompt-queue.json");
    this.store = store;
    this.mapper = mapper;
  }

  @SuppressWarnings("unchecked")
  private <T> T copy(T value) {
    return (T) mapper.convertValue(value, Object.class);
  }

  private void initialize() {
    if (items != null) return;
    if (Files.exists(file)) {
      Object value = store.read(file, Object.class);
      if (!(value instanceof List<?> list)
          || list.stream().anyMatch(item -> !(item instanceof Map)))
        throw new IllegalStateException("Invalid saved prompt queue; the file has been preserved");
      items = new ArrayList<>();
      for (Object item : list) items.add(mapper.convertValue(item, Map.class));
    } else items = new ArrayList<>();
    boolean changed = false;
    for (var item : items)
      if ("dispatching".equals(item.get("status"))) {
        item.put("status", "interrupted");
        item.put(
            "error",
            "Argus restarted during dispatch. Check the chat before resending; the prior request may have started.");
        changed = true;
      }
    if (changed) store.write(file, items);
  }

  public synchronized List<Map<String, Object>> list() {
    initialize();
    return copy(items);
  }

  public synchronized <T> T mutate(Function<List<Map<String, Object>>, T> operation) {
    initialize();
    var draft = this.<List<Map<String, Object>>>copy(items);
    T result = operation.apply(draft);
    store.write(file, draft);
    items = draft;
    return copy(result);
  }
}
