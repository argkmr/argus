package com.argus.context.repository;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.context.domain.ContextAttachment;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;

@Repository
public class ContextRepository {
  private final Path directory;
  private final Path indexPath;
  private final AtomicJsonStore json;
  private final ObjectMapper mapper;

  public ContextRepository(ArgusProperties properties, AtomicJsonStore json, ObjectMapper mapper) {
    this.directory = properties.dataDirectory().resolve("context-attachments");
    this.indexPath = directory.resolve("index.json");
    this.json = json;
    this.mapper = mapper;
  }

  public synchronized List<ContextAttachment> list() {
    if (Files.isSymbolicLink(directory) || Files.isSymbolicLink(indexPath))
      throw new IllegalStateException("Context storage must not be a symbolic link");
    if (!Files.exists(indexPath)) return new ArrayList<>();
    try {
      return new ArrayList<>(
          Arrays.asList(mapper.readValue(indexPath.toFile(), ContextAttachment[].class)));
    } catch (RuntimeException error) {
      throw new IllegalStateException("Could not read context index", error);
    }
  }

  public synchronized void add(ContextAttachment item) {
    List<ContextAttachment> items = list();
    items.add(item);
    if (items.size() > 100) items = items.subList(items.size() - 100, items.size());
    json.write(indexPath, items);
  }

  public synchronized void replace(List<ContextAttachment> items) {
    json.write(indexPath, items);
  }

  public ContextAttachment require(String id) {
    return list().stream()
        .filter(item -> item.id().equals(id))
        .findFirst()
        .orElseThrow(() -> new NotFoundException("Context attachment not found"));
  }

  public Path directory() {
    return directory;
  }
}
