package com.argus.diagrams.service;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.diagrams.domain.DiagramDocument;
import com.argus.diagrams.domain.DiagramSummary;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Repository-independent documents; durable replacement precedes every successful response. */
@Service
public class DiagramDocumentService {
  public static final int MAX_BYTES = 10_000_000;
  private static final int MAX_DOCUMENTS = 10_000;
  private static final String UUID_PATTERN =
      "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  private final Path directory;
  private final AtomicJsonStore json;
  private final ObjectMapper mapper;
  private final Clock clock;

  @Autowired
  public DiagramDocumentService(
      ArgusProperties properties, AtomicJsonStore json, ObjectMapper mapper) {
    this(properties, json, mapper, Clock.systemUTC());
  }

  public DiagramDocumentService(
      ArgusProperties properties, AtomicJsonStore json, ObjectMapper mapper, Clock clock) {
    directory = properties.dataDirectory().toAbsolutePath().normalize().resolve("diagrams");
    this.json = json;
    this.mapper = mapper;
    this.clock = clock;
  }

  /**
   * archived=true includes both active and archived documents so recovery never needs a file path.
   */
  public synchronized List<DiagramSummary> list(boolean archived) {
    var summaries = new ArrayList<DiagramSummary>();
    for (Path file : documentFiles()) {
      String name = file.getFileName().toString();
      DiagramDocument document = read(name.substring(0, name.length() - 5));
      if (archived || !document.archived()) summaries.add(summary(document));
    }
    return summaries.stream()
        .sorted(
            Comparator.comparing(DiagramSummary::updatedAt)
                .thenComparing(DiagramSummary::id)
                .reversed())
        .toList();
  }

  public synchronized DiagramDocument get(String id) {
    return read(validId(id));
  }

  public synchronized DiagramDocument create(JsonNode request) {
    validateRequest(request);
    String name = validName(request.get("name"));
    JsonNode snapshot = validatedSnapshot(request.get("snapshot"));
    if (documentFiles().size() >= MAX_DOCUMENTS)
      throw new IllegalArgumentException(
          "Diagram storage has reached its 10,000-document capacity");
    String id = UUID.randomUUID().toString();
    String now = clock.instant().toString();
    return persist(new DiagramDocument(id, name, 1, 1, now, now, false, snapshot));
  }

  public synchronized DiagramDocument update(String id, JsonNode request) {
    validateRequest(request);
    DiagramDocument previous = read(validId(id));
    checkRevision(previous, request.get("revision"));
    if (previous.archived())
      throw new ConflictException("Restore this archived diagram before editing it");
    return persist(
        new DiagramDocument(
            previous.id(),
            validName(request.get("name")),
            nextRevision(previous),
            1,
            previous.createdAt(),
            clock.instant().toString(),
            false,
            validatedSnapshot(request.get("snapshot"))));
  }

  public synchronized DiagramSummary archive(String id, Long revision) {
    DiagramDocument previous = read(validId(id));
    checkRevision(previous, revision);
    if (previous.archived()) return summary(previous);
    return summary(persist(withArchive(previous, true)));
  }

  public synchronized DiagramDocument restore(String id, JsonNode request) {
    validateRequest(request);
    DiagramDocument previous = read(validId(id));
    checkRevision(previous, request.get("revision"));
    return previous.archived() ? persist(withArchive(previous, false)) : previous;
  }

  /** Explicit permanent deletion; the existing DELETE route remains recoverable archiving. */
  public synchronized void deletePermanently(String id, Long revision) {
    DiagramDocument previous = read(validId(id));
    checkRevision(previous, revision);
    try {
      Files.delete(path(previous.id()));
    } catch (IOException error) {
      throw new IllegalStateException("Could not delete the local diagram", error);
    }
  }

  private DiagramDocument withArchive(DiagramDocument previous, boolean archived) {
    return new DiagramDocument(
        previous.id(),
        previous.name(),
        nextRevision(previous),
        1,
        previous.createdAt(),
        clock.instant().toString(),
        archived,
        previous.snapshot());
  }

  private long nextRevision(DiagramDocument previous) {
    if (previous.revision() == Long.MAX_VALUE)
      throw new ConflictException("This diagram's revision limit has been reached; save a copy");
    return previous.revision() + 1;
  }

  private void validateRequest(JsonNode request) {
    if (request == null || !request.isObject())
      throw new IllegalArgumentException("Diagram request must be a JSON object");
    validateTree(request);
    if (mapper.writeValueAsBytes(request).length > MAX_BYTES) tooLarge();
  }

  private DiagramDocument persist(DiagramDocument document) {
    // Bound the actual pretty-printed file, including metadata, before touching disk.
    if (mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(document).length > MAX_BYTES)
      tooLarge();
    ensureDirectory();
    Path file = path(document.id());
    json.write(file, document);
    return document;
  }

  private DiagramDocument read(String id) {
    Path file = path(id);
    if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS))
      throw new NotFoundException("Diagram not found");
    try {
      if (Files.size(file) > MAX_BYTES) tooLarge();
    } catch (IOException error) {
      throw new IllegalStateException("Could not read the local diagram", error);
    }
    DiagramDocument document = json.read(file, DiagramDocument.class);
    if (document == null
        || !id.equals(document.id())
        || document.schemaVersion() != 1
        || document.revision() < 1)
      throw new IllegalStateException(
          "Unsupported diagram file; it has been preserved for recovery");
    validName(mapper.valueToTree(document.name()));
    try {
      Instant.parse(document.createdAt());
      Instant.parse(document.updatedAt());
    } catch (RuntimeException error) {
      throw new IllegalStateException(
          "Invalid diagram timestamps; the file has been preserved", error);
    }
    validatedSnapshot(document.snapshot());
    return document;
  }

  private List<Path> documentFiles() {
    checkDirectory();
    if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) return List.of();
    try (var files = Files.list(directory)) {
      List<Path> result =
          files
              .filter(file -> file.getFileName().toString().matches(UUID_PATTERN + "\\.json"))
              .limit(MAX_DOCUMENTS + 1L)
              .toList();
      if (result.size() > MAX_DOCUMENTS)
        throw new IllegalStateException("Diagram storage exceeds its document capacity");
      return result;
    } catch (IOException error) {
      throw new IllegalStateException("Could not list local diagrams", error);
    }
  }

  private Path path(String id) {
    checkDirectory();
    Path file = directory.resolve(validId(id) + ".json");
    if (Files.isSymbolicLink(file)
        || (Files.exists(file, LinkOption.NOFOLLOW_LINKS)
            && !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)))
      throw new IllegalArgumentException(
          "Diagram storage requires regular files without symbolic links");
    return file;
  }

  private void checkDirectory() {
    // The configured data root and owned directory cannot redirect storage. Higher ancestors
    // belong to the host configuration (macOS, for example, maps /var to /private/var).
    for (Path current : List.of(directory, directory.getParent())) {
      if (Files.isSymbolicLink(current)
          || (Files.exists(current, LinkOption.NOFOLLOW_LINKS)
              && !Files.isDirectory(current, LinkOption.NOFOLLOW_LINKS)))
        throw new IllegalArgumentException(
            "Diagram storage requires directories without symbolic links");
    }
  }

  private void ensureDirectory() {
    checkDirectory();
    try {
      Files.createDirectories(directory);
      checkDirectory();
      try {
        Files.setPosixFilePermissions(
            directory,
            Set.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
      } catch (UnsupportedOperationException ignored) {
      }
    } catch (IOException error) {
      throw new IllegalStateException("Could not create local diagram storage", error);
    }
  }

  private static String validId(String id) {
    if (id == null || !id.matches(UUID_PATTERN))
      throw new IllegalArgumentException("Diagram ID must be a UUID");
    return UUID.fromString(id).toString();
  }

  private static String validName(JsonNode value) {
    if (value == null || !value.isTextual())
      throw new IllegalArgumentException("Diagram name is required");
    String name = value.asText().strip();
    if (name.isBlank()
        || name.length() > 160
        || name.codePoints().anyMatch(Character::isISOControl))
      throw new IllegalArgumentException(
          "Diagram name must contain between 1 and 160 visible characters");
    return name;
  }

  private static void checkRevision(DiagramDocument document, JsonNode revision) {
    if (revision == null || !revision.isIntegralNumber() || !revision.canConvertToLong())
      throw new ConflictException(
          "A current diagram revision is required; your draft has been kept");
    checkRevision(document, revision.longValue());
  }

  private static void checkRevision(DiagramDocument document, Long revision) {
    if (revision == null || revision != document.revision())
      throw new ConflictException(
          "This diagram changed. Refresh before saving; your draft has been kept");
  }

  private static JsonNode validatedSnapshot(JsonNode snapshot) {
    requireObject(snapshot, "snapshot");
    validateTree(snapshot);
    JsonNode structured = snapshot.get("structured"), sketch = snapshot.get("sketch");
    requireObject(structured, "structured canvas");
    requireObject(sketch, "sketch canvas");
    requireObject(structured.get("viewport"), "structured viewport");
    requireArray(structured.get("nodes"), "structured nodes", 2_000);
    requireArray(structured.get("edges"), "structured edges", 5_000);
    requireArray(sketch.get("elements"), "sketch elements", 10_000);
    requireObject(sketch.get("appState"), "sketch app state");
    requireObject(sketch.get("files"), "sketch files");
    requireArray(sketch.get("libraryItems"), "sketch library", 1_000);
    if (sketch.get("files").size() > 1_000)
      throw new IllegalArgumentException("A sketch can contain at most 1,000 files");
    var nodeIds = ids(structured.get("nodes"), "structured node");
    ids(structured.get("edges"), "structured edge");
    for (JsonNode edge : structured.get("edges")) {
      if (!edge.path("source").isTextual()
          || !edge.path("target").isTextual()
          || !nodeIds.contains(edge.path("source").asText())
          || !nodeIds.contains(edge.path("target").asText()))
        throw new IllegalArgumentException("Diagram edges must refer to existing node IDs");
    }
    for (JsonNode file : sketch.get("files")) requireObject(file, "sketch file");
    for (JsonNode libraryItem : sketch.get("libraryItems")) {
      requireObject(libraryItem, "sketch library item");
      requireArray(libraryItem.get("elements"), "library elements", 10_000);
    }
    return snapshot.deepCopy();
  }

  private static Set<String> ids(JsonNode entries, String label) {
    var ids = new HashSet<String>();
    for (JsonNode entry : entries) {
      JsonNode id = entry.get("id");
      if (id == null
          || !id.isTextual()
          || id.asText().isBlank()
          || id.asText().length() > 160
          || !ids.add(id.asText()))
        throw new IllegalArgumentException(
            "Each " + label + " must have a unique ID up to 160 characters");
    }
    return ids;
  }

  private static void requireObject(JsonNode node, String label) {
    if (node == null || !node.isObject())
      throw new IllegalArgumentException("Diagram " + label + " must be an object");
  }

  private static void requireArray(JsonNode node, String label, int limit) {
    if (node == null || !node.isArray() || node.size() > limit)
      throw new IllegalArgumentException(
          "Diagram " + label + " must be an array of at most " + limit + " items");
    for (JsonNode item : node) requireObject(item, label + " item");
  }

  private static void validateTree(JsonNode root) {
    record Item(JsonNode node, int depth) {}
    var pending = new ArrayDeque<Item>();
    pending.add(new Item(root, 0));
    int count = 0;
    while (!pending.isEmpty()) {
      Item item = pending.removeLast();
      if (++count > 200_000 || item.depth() > 64)
        throw new IllegalArgumentException("Diagram JSON is too deeply nested or complex");
      JsonNode node = item.node();
      if (node.isNumber() && !Double.isFinite(node.doubleValue()))
        throw new IllegalArgumentException("Diagram numbers must be finite");
      if (node.isArray() || node.isObject()) {
        for (JsonNode child : node) pending.add(new Item(child, item.depth() + 1));
      } else if (!node.isTextual() && !node.isNumber() && !node.isBoolean() && !node.isNull()) {
        throw new IllegalArgumentException("Diagram snapshots must contain ordinary JSON values");
      }
    }
  }

  private static void tooLarge() {
    throw new ResponseStatusException(
        HttpStatus.PAYLOAD_TOO_LARGE, "Diagram exceeds the 10 MB local storage limit");
  }

  private static DiagramSummary summary(DiagramDocument document) {
    return new DiagramSummary(
        document.id(),
        document.name(),
        document.revision(),
        document.schemaVersion(),
        document.createdAt(),
        document.updatedAt(),
        document.archived());
  }
}
