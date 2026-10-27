package com.argus.apiclient.service;

import com.argus.apiclient.dto.ApiRequestHistoryEntry;
import com.argus.apiclient.dto.ApiRequestHistorySummary;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Clock;
import java.time.Instant;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

@Service
public class ApiRequestHistoryService {
  private static final String UUID_PATTERN =
      "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  private final AtomicJsonStore json;
  private final Path directory;
  private final Clock clock;
  private final Map<String, ApiRequestHistorySummary> summaries = new LinkedHashMap<>();
  private boolean loaded;

  @Autowired
  public ApiRequestHistoryService(AtomicJsonStore json, ArgusProperties properties) {
    this(json, properties, Clock.systemUTC());
  }

  public ApiRequestHistoryService(AtomicJsonStore json, ArgusProperties properties, Clock clock) {
    this.json = json;
    this.directory =
        properties.dataDirectory().toAbsolutePath().normalize().resolve("api-request-history");
    this.clock = clock;
  }

  public synchronized List<ApiRequestHistorySummary> list() {
    load();
    return summaries.values().stream()
        .sorted(
            Comparator.comparing((ApiRequestHistorySummary item) -> Instant.parse(item.updatedAt()))
                .thenComparing(item -> Instant.parse(item.createdAt()))
                .thenComparing(ApiRequestHistorySummary::id)
                .reversed())
        .toList();
  }

  public synchronized ApiRequestHistorySummary save(JsonNode payload) {
    if (payload == null || !payload.isObject())
      invalid("Request history payload must be an object");
    JsonNode suppliedId = payload.get("id");
    if (suppliedId != null && !suppliedId.isNull() && !suppliedId.isTextual())
      invalid("Request history ID must be a UUID");
    String id =
        suppliedId == null || suppliedId.isNull()
            ? UUID.randomUUID().toString()
            : validId(suppliedId.asText());
    JsonNode snapshot = payload.get("snapshot");
    validateSnapshot(snapshot);
    // Copy before storing so a direct caller cannot later mutate the submitted JsonNode.
    snapshot = snapshot.deepCopy();
    load();
    Path path = path(id);
    ApiRequestHistoryEntry previous =
        Files.exists(path, LinkOption.NOFOLLOW_LINKS) ? read(id) : null;
    String now = Instant.now(clock).toString();
    var entry =
        new ApiRequestHistoryEntry(
            id, previous == null ? now : previous.createdAt(), now, snapshot);
    ensureDirectory();
    json.write(path, entry);
    // Publish only after the durable atomic replacement succeeds; a failed save retains the old
    // entry.
    var summary = summarize(entry);
    summaries.put(id, summary);
    return summary;
  }

  public synchronized ApiRequestHistoryEntry get(String id) {
    return read(validId(id));
  }

  public synchronized Map<String, Object> delete(String id) {
    id = validId(id);
    load();
    Path path = path(id);
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS))
      throw new NotFoundException("API request history entry not found");
    try {
      Files.delete(path);
    } catch (IOException error) {
      throw new IllegalStateException("Could not remove the API request history entry", error);
    }
    summaries.remove(id);
    return Map.of("ok", true);
  }

  private void load() {
    checkDirectory();
    if (loaded) return;
    var found = new LinkedHashMap<String, ApiRequestHistorySummary>();
    if (Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
      try (var files = Files.list(directory)) {
        for (Path file : files.toList()) {
          String name = file.getFileName().toString();
          if (!name.matches(UUID_PATTERN + "\\.json")) continue;
          String id = validId(name.substring(0, name.length() - 5));
          found.put(id, summarize(read(id)));
        }
      } catch (IOException error) {
        throw new IllegalStateException("Could not load API request history", error);
      }
    }
    summaries.putAll(found);
    loaded = true;
  }

  private ApiRequestHistoryEntry read(String id) {
    Path path = path(id);
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS))
      throw new NotFoundException("API request history entry not found");
    var entry = json.read(path, ApiRequestHistoryEntry.class);
    if (entry == null || !id.equals(entry.id())) invalid("Unsupported API request history file");
    try {
      Instant.parse(entry.createdAt());
      Instant.parse(entry.updatedAt());
    } catch (RuntimeException error) {
      throw new IllegalStateException("Unsupported API request history timestamps", error);
    }
    validateSnapshot(entry.snapshot());
    return entry;
  }

  private Path path(String id) {
    checkDirectory();
    Path result = directory.resolve(validId(id) + ".json");
    if (Files.isSymbolicLink(result)) invalid("API request history must not use symbolic links");
    if (Files.exists(result, LinkOption.NOFOLLOW_LINKS)
        && !Files.isRegularFile(result, LinkOption.NOFOLLOW_LINKS))
      invalid("API request history entry must be a regular file");
    return result;
  }

  private void checkDirectory() {
    if (Files.isSymbolicLink(directory) || Files.isSymbolicLink(directory.getParent()))
      invalid("API request history must not use symbolic links");
    if (Files.exists(directory, LinkOption.NOFOLLOW_LINKS)
        && !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS))
      invalid("API request history storage must be a directory");
  }

  private void ensureDirectory() {
    checkDirectory();
    try {
      if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
        Files.createDirectories(directory);
        try {
          Files.setPosixFilePermissions(
              directory,
              Set.of(
                  PosixFilePermission.OWNER_READ,
                  PosixFilePermission.OWNER_WRITE,
                  PosixFilePermission.OWNER_EXECUTE));
        } catch (UnsupportedOperationException ignored) {
        }
      }
    } catch (IOException error) {
      throw new IllegalStateException("Could not create local API request history storage", error);
    }
  }

  private static String validId(String id) {
    if (id == null || !id.matches(UUID_PATTERN)) invalid("Request history ID must be a UUID");
    return UUID.fromString(id).toString();
  }

  private static void validateSnapshot(JsonNode snapshot) {
    if (snapshot == null || !snapshot.isObject())
      invalid("Request history snapshot must be an object");
    JsonNode version = snapshot.get("version");
    if (version == null
        || !version.isIntegralNumber()
        || !version.canConvertToInt()
        || version.intValue() != 1) invalid("Unsupported API request history snapshot version");
    if (!snapshot.path("kind").isTextual()
        || !Set.of("draft", "sent", "failed").contains(snapshot.path("kind").asText()))
      invalid("Request history kind must be draft, sent, or failed");
    if (!snapshot.path("request").isObject() || !snapshot.path("editor").isObject())
      invalid("Request history request and editor must be objects");
    if (!snapshot.path("environmentId").isTextual())
      invalid("Request history environment ID must be a string");
    JsonNode response = snapshot.get("response");
    if (response == null || (!response.isNull() && !response.isObject()))
      invalid("Request history response must be an object or null");
    for (String key : List.of("name", "method", "url")) {
      JsonNode value = snapshot.path("request").get(key);
      if (value != null && !value.isNull() && !value.isTextual())
        invalid("Request history " + key + " must be a string");
    }
    JsonNode status = response.get("status");
    if (status != null
        && !status.isNull()
        && (!status.isIntegralNumber() || !status.canConvertToInt()))
      invalid("Request history response status must be an integer");
  }

  private static ApiRequestHistorySummary summarize(ApiRequestHistoryEntry entry) {
    JsonNode snapshot = entry.snapshot(),
        request = snapshot.path("request"),
        status = snapshot.path("response").path("status");
    return new ApiRequestHistorySummary(
        entry.id(),
        entry.createdAt(),
        entry.updatedAt(),
        snapshot.path("kind").asText(),
        request.path("name").asText(""),
        request.path("method").asText(""),
        request.path("url").asText(""),
        status.isIntegralNumber() ? status.intValue() : null);
  }

  private static void invalid(String message) {
    throw new IllegalArgumentException(message);
  }
}
