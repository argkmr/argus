package com.argus.apiclient.service;

import com.argus.common.process.CommandRunner;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/** Native user-selected import/export files; no caller-supplied disk path. */
@Service
public class ApiFileService {
  private final CommandRunner commands;
  private final AtomicJsonStore json;
  private final ObjectMapper mapper;
  private final ApiCollectionService collections;
  private final ApiEnvironmentService environments;

  public ApiFileService(
      CommandRunner commands,
      AtomicJsonStore json,
      ObjectMapper mapper,
      ApiCollectionService collections,
      ApiEnvironmentService environments) {
    this.commands = commands;
    this.json = json;
    this.mapper = mapper;
    this.collections = collections;
    this.environments = environments;
  }

  public Map<String, Object> importCollection(String repositoryId, String configurationId) {
    Repository repository = collections.repository(repositoryId);
    collections.configuration(repository, configurationId == null ? "" : configurationId);
    String selected = select("Import a Postman or Argus JSON collection, or a cURL file", null);
    if (selected == null) return Map.of("cancelled", true);
    Path path = Path.of(selected);
    String text = read(path);
    Object parsed =
        path.getFileName().toString().toLowerCase().endsWith(".curl")
            ? CurlParser.parse(text)
            : mapper.readValue(text, Object.class);
    String fallback = path.getFileName().toString().replaceFirst("\\.[^.]*$", "");
    int before = collections.collections(repository).size();
    var imported = collections.importDocument(repository, parsed, fallback, configurationId);
    return Map.of(
        "imported",
        imported,
        "count",
        imported.size(),
        "collectionCount",
        Math.max(0, collections.collections(repository).size() - before),
        "path",
        path.toString(),
        "cancelled",
        false);
  }

  public Map<String, Object> exportCollection(String repositoryId) {
    Repository repository = collections.repository(repositoryId);
    String selected =
        select(
            "Export a Postman-compatible collection",
            safe(repository.name()) + ".postman_collection.json");
    if (selected == null) return Map.of("cancelled", true);
    Path destination = Path.of(selected);
    json.write(destination, collections.exportDocument(repository));
    return Map.of(
        "path",
        destination.toString(),
        "count",
        collections.requests(repository).size(),
        "collectionCount",
        collections.collections(repository).size(),
        "cancelled",
        false);
  }

  public Map<String, Object> importEnvironment() {
    String selected = select("Import a Postman or Argus environment JSON file", null);
    if (selected == null) return Map.of("cancelled", true);
    var imported =
        environments.importDocument(mapper.readValue(read(Path.of(selected)), Object.class));
    return Map.of("cancelled", false, "environment", imported, "path", selected);
  }

  public Map<String, Object> exportEnvironment(String id) {
    var environment = environments.require(id);
    String selected =
        select(
            "Export Postman-compatible environment",
            safe(environment.name()) + ".postman_environment.json");
    if (selected == null) return Map.of("cancelled", true);
    json.write(Path.of(selected), environments.exportDocument(id));
    return Map.of("cancelled", false, "path", selected, "environment", environment);
  }

  public Map<String, Object> openCollections(String repositoryId) {
    Path directory = collections.directory(collections.repository(repositoryId));
    mac();
    try {
      Files.createDirectories(directory);
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Could not create API collection directory", e);
    }
    commands.run(
        "/usr/bin/open", java.util.List.of(directory.toString()), null, Duration.ofSeconds(10));
    return Map.of("path", directory.toString());
  }

  private String select(String prompt, String defaultName) {
    mac();
    String script =
        defaultName == null
            ? "POSIX path of (choose file with prompt \"" + prompt + "\")"
            : "POSIX path of (choose file name with prompt \""
                + prompt
                + "\" default name \""
                + safe(defaultName)
                + "\")";
    try {
      String selected =
          commands
              .run(
                  "/usr/bin/osascript",
                  java.util.List.of("-e", script),
                  null,
                  Duration.ofMinutes(5))
              .stdout()
              .trim();
      if (selected.isEmpty())
        throw new IllegalStateException("The native file picker did not return a file");
      return selected;
    } catch (RuntimeException e) {
      String text = String.valueOf(e.getMessage());
      if (text.contains("-128") || text.toLowerCase().contains("cancel")) return null;
      throw e;
    }
  }

  private static String read(Path path) {
    try {
      if (!Files.isRegularFile(path) || Files.size(path) > 5_000_000)
        throw new IllegalArgumentException(
            "API import is larger than 5 MB or is not a regular file");
      try (var input = Files.newInputStream(path)) {
        byte[] data = input.readNBytes(5_000_001);
        if (data.length > 5_000_000)
          throw new IllegalArgumentException("API import is larger than 5 MB");
        return new String(data, java.nio.charset.StandardCharsets.UTF_8);
      }
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Could not read the selected API import", e);
    }
  }

  private static void mac() {
    if (!System.getProperty("os.name", "").toLowerCase().contains("mac"))
      throw new IllegalStateException(
          "The native import/export dialog is currently available on macOS only");
  }

  private static String safe(String text) {
    return text.replaceAll("[^A-Za-z0-9._-]+", "-");
  }
}
