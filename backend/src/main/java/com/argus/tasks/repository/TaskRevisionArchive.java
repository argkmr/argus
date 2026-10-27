package com.argus.tasks.repository;

import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.domain.AiTask;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Function;
import tools.jackson.databind.ObjectMapper;

/** Immutable conversation snapshots; all access is serialized by the owning TaskRepository. */
final class TaskRevisionArchive {
  private final Path directory;
  private final AtomicJsonStore json;
  private final ObjectMapper mapper;

  TaskRevisionArchive(Path directory, AtomicJsonStore json, ObjectMapper mapper) {
    this.directory = directory.resolve("revisions");
    this.json = json;
    this.mapper = mapper;
  }

  record Entry(
      String id,
      String requestId,
      String createdAt,
      int messageCount,
      String editedMessageId,
      String promptPreview,
      boolean applied) {
    Entry committed() {
      return new Entry(
          id, requestId, createdAt, messageCount, editedMessageId, promptPreview, true);
    }

    Map<String, Object> summary() {
      return Map.of(
          "id",
          id,
          "createdAt",
          createdAt,
          "messageCount",
          messageCount,
          "editedMessageId",
          editedMessageId,
          "promptPreview",
          promptPreview);
    }
  }

  record Snapshot(String fingerprint, AiTask task) {}

  TaskRepository.RevisionResult replay(AiTask current, String requestId, String fingerprint) {
    var entry =
        entries(current.id).stream()
            .filter(e -> requestId.equals(e.requestId()))
            .findFirst()
            .orElse(null);
    if (entry == null) return null;
    var snapshot = json.read(snapshot(current.id, entry.id()), Snapshot.class);
    if (!fingerprint.equals(snapshot.fingerprint()))
      throw new ConflictException("This edit request was already used for different content");
    return entry.applied() || isCurrentRevision(current, entry.id())
        ? new TaskRepository.RevisionResult(current, entry.id(), true)
        : null;
  }

  TaskRepository.RevisionResult revise(
      AiTask current,
      String requestId,
      String fingerprint,
      long expectedCount,
      String messageId,
      Function<TaskRepository.RevisionBase, AiTask> change,
      Consumer<AiTask> save) {
    var entries = entries(current.id);
    // A process may have stopped after committing the task but before the small manifest update.
    // The task's durable latest receipt proves that snapshot was applied; no history is replayed.
    for (int i = 0; i < entries.size(); i++) {
      var entry = entries.get(i);
      if (!entry.applied() && isCurrentRevision(current, entry.id())) {
        entries.set(i, entry.committed());
        json.write(index(current.id), entries);
      }
    }
    Entry existing =
        entries.stream().filter(e -> requestId.equals(e.requestId())).findFirst().orElse(null);
    if (existing != null) {
      var snapshot = json.read(snapshot(current.id, existing.id()), Snapshot.class);
      if (!fingerprint.equals(snapshot.fingerprint()))
        throw new ConflictException("This edit request was already used for different content");
      if (existing.applied())
        return new TaskRepository.RevisionResult(current, existing.id(), true);
      // Recover only an interrupted, not-yet-applied write against the exact same source state.
      if (!mapper.valueToTree(current).equals(mapper.valueToTree(snapshot.task())))
        throw new ConflictException("The task changed after this edit was prepared; reload it");
    }
    if (revisionCount(current) != expectedCount)
      throw new ConflictException("This task has already been revised; reload it before editing");
    String revisionId = existing == null ? UUID.randomUUID().toString() : existing.id();
    String createdAt = existing == null ? Instant.now().toString() : existing.createdAt();
    AiTask changed =
        change.apply(
            new TaskRepository.RevisionBase(
                mapper.convertValue(current, AiTask.class), revisionId, createdAt));
    if (existing == null) {
      String preview =
          current.messages.stream()
              .filter(m -> messageId.equals(m.id))
              .map(m -> Objects.toString(m.content, "").replaceAll("\\s+", " ").trim())
              .findFirst()
              .orElse("");
      existing =
          new Entry(
              revisionId,
              requestId,
              createdAt,
              current.archivedMessageCount + current.messages.size(),
              messageId,
              preview.substring(0, Math.min(160, preview.length())),
              false);
      // Snapshot first: a failed task/index write can never destroy the original conversation.
      // These files have no mutation endpoint and are never loaded by task list/context polling.
      json.write(snapshot(current.id, revisionId), new Snapshot(fingerprint, current));
      entries.add(existing);
      json.write(index(current.id), entries);
    }
    save.accept(changed);
    entries.set(entries.indexOf(existing), existing.committed());
    json.write(index(current.id), entries);
    return new TaskRepository.RevisionResult(changed, revisionId, false);
  }

  List<Map<String, Object>> list(AiTask current) {
    var summaries = new ArrayList<Map<String, Object>>();
    for (var entry : entries(current.id))
      if (entry.applied() || isCurrentRevision(current, entry.id())) summaries.add(entry.summary());
    Collections.reverse(summaries);
    return summaries;
  }

  Map<String, Object> get(AiTask current, String revisionId) {
    var entry =
        entries(current.id).stream()
            .filter(
                e ->
                    e.id().equals(revisionId)
                        && (e.applied() || isCurrentRevision(current, e.id())))
            .findFirst()
            .orElseThrow(() -> new NotFoundException("Task revision not found"));
    var snapshot = json.read(snapshot(current.id, entry.id()), Snapshot.class);
    return Map.of(
        "id",
        entry.id(),
        "createdAt",
        entry.createdAt(),
        "editedMessageId",
        entry.editedMessageId(),
        "task",
        snapshot.task());
  }

  void delete(String taskId) throws IOException {
    Path taskDirectory = directory.resolve(taskId);
    // Never follow a replaced directory or delete a different task's history. Orphan prepared
    // snapshots from an interrupted manifest write are also owned by this exact task directory.
    if (!Files.exists(taskDirectory, LinkOption.NOFOLLOW_LINKS)) return;
    if (Files.isSymbolicLink(directory) || Files.isSymbolicLink(taskDirectory))
      throw new IOException("Task revision directory cannot be a symbolic link");
    List<Path> files;
    try (var stream = Files.list(taskDirectory)) {
      files = stream.toList();
    }
    for (var file : files) {
      String name = file.getFileName().toString();
      if ((!name.equals("index.json") && !name.matches("[a-fA-F0-9-]{36}\\.json"))
          || Files.isDirectory(file, LinkOption.NOFOLLOW_LINKS))
        throw new IOException("Unexpected file in task revision directory");
    }
    for (var file : files) Files.deleteIfExists(file);
    Files.deleteIfExists(taskDirectory);
  }

  static long revisionCount(AiTask task) {
    Object count = task.additionalProperties().get("revisionCount");
    return count instanceof Number number ? number.longValue() : 0;
  }

  private boolean isCurrentRevision(AiTask task, String revisionId) {
    return task.additionalProperties().get("revisionOf") instanceof Map<?, ?> revision
        && revisionId.equals(revision.get("revisionId"));
  }

  private List<Entry> entries(String taskId) {
    Path path = index(taskId);
    return Files.exists(path)
        ? new ArrayList<>(Arrays.asList(json.read(path, Entry[].class)))
        : new ArrayList<>();
  }

  private Path index(String taskId) {
    return directory.resolve(taskId).resolve("index.json");
  }

  private Path snapshot(String taskId, String revisionId) {
    return directory.resolve(taskId).resolve(revisionId + ".json");
  }
}
